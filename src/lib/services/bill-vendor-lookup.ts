import "server-only";
import { isManualEntryOnly } from "@/lib/application-mode";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import { canCreateBill } from "@/lib/permissions";
import { currencySchema } from "@/lib/validation";
import { centers, getBooksOrganizations, getConfig, IntegrationError, type DataCenter, type ZohoConfig } from "@/lib/integrations/config";
import { connectionFingerprint } from "@/lib/integrations/connection-fingerprint";
import { accessToken, LEGACY_UNSCOPED_ORGANIZATION } from "@/lib/integrations/oauth";
import { ZohoTransport } from "@/lib/integrations/transport";

const id = z.string().trim().min(1).max(100);
const externalId = z.string().regex(/^\d{1,30}$/);
const searchInput = z.object({ companyId: id, q: z.string().trim().max(100).default(""), vendorId: id.optional() }).strict();
const directoryInput = z.object({ companyId: id, q: z.string().trim().max(100).default(""), page: z.number().int().min(1).max(10_000).default(1) }).strict();
const destinationInput = z.object({ organizationId: externalId,
  dataCenter: z.enum(Object.keys(centers) as [DataCenter, ...DataCenter[]]), environment: z.enum(["production", "sandbox"]),
});
const resolveInput = destinationInput.extend({ companyId: id, externalVendorId: externalId }).strict();
const localFields = { id: true, companyId: true, name: true, currency: true, email: true, trn: true } as const;
type LocalVendor = Prisma.VendorGetPayload<{ select: typeof localFields }>;
type Store = Prisma.TransactionClient;
type Destination = { organizationId: string; dataCenter: string; environment: string };
export type VendorSuggestion = Omit<LocalVendor, "id"> & {
  id: string | null;
  booksMappingRequired?: boolean;
  externalVendorId?: string;
  organizationId?: string;
  dataCenter?: string;
  environment?: "production" | "sandbox";
};
type Context = {
  purpose: "bill" | "directory";
  company: { id: string; active: boolean; isDemo: boolean };
  destinations: Destination[];
  destination: Destination | null;
  config: ZohoConfig | null;
  localDemoFallback: boolean;
};
const blocked = (code: string, message: string) => new IntegrationError(code, message, "BLOCKED");
const fold = (value: string) => value.normalize("NFKC").toLowerCase();
const matchesName = (name: string, q: string) => fold(name).includes(fold(q));
// MySQL LIKE treats these characters specially even when supplied as parameters.
const literalContains = (value: string) => value.replace(/[\\%_]/g, "\\$&");

function hasNoBooksProfile(organizationId: string) {
  if (!process.env.ZOHO_BOOKS_ORGANIZATIONS_JSON?.trim() && !process.env.ZOHO_BOOKS_ORGANIZATION_ID?.trim()) return true;
  try { return !getBooksOrganizations().some(profile => profile.organizationId === organizationId); }
  catch { return false; } // Invalid configuration must never downgrade an actual Books connection.
}

async function context(store: Store, actor: Actor, companyId: string, purpose: Context["purpose"] = "bill"): Promise<Context> {
  const roles = purpose === "directory" ? ["ADMIN", "ACCOUNTS", "DATA_ENTRY", "MANAGEMENT"] as const : ["ADMIN", "ACCOUNTS", "DATA_ENTRY"] as const;
  if (purpose === "bill" && !canCreateBill(actor)) throw new HttpError(403, "Your role cannot select vendors for bill entry.");
  if (!roles.some(role => role === actor.role)) throw new HttpError(403, "Current application access is required.");
  const current = await store.user.findFirst({
    where: { id: actor.id, active: true, role: { in: [...roles] },
      memberships: { some: { companyId, active: true, company: { active: true } } } },
    select: { id: true },
  });
  if (!current) throw new HttpError(403, purpose === "directory" ? "Current access to this company is required." : "Current bill-entry access to this company is required.");
  const company = await store.company.findUnique({ where: { id: companyId }, select: { id: true, active: true, isDemo: true } });
  if (!company?.active) throw new HttpError(404, "Company not found.");
  if (isManualEntryOnly()) return { purpose, company, destinations: [], destination: null, config: null, localDemoFallback: false };
  const destinations = await store.companyIntegrationDestination.findMany({
    where: { companyId, target: "ZOHO" }, select: { organizationId: true, dataCenter: true, environment: true },
    orderBy: [{ organizationId: "asc" }, { dataCenter: "asc" }, { environment: "asc" }],
  });
  const destination = destinations.length === 1 ? destinations[0] : null;
  // Legacy demo companies can carry a sandbox placeholder without a Books profile.
  // A configured destination keeps exact mapping isolation even if its connection fails.
  const localDemoFallback = Boolean(company.isDemo && destination?.environment === "sandbox" &&
    destinationInput.safeParse(destination).success && hasNoBooksProfile(destination.organizationId));
  let config: ZohoConfig | null = null;
  if (destination) {
    try {
      const candidate = getConfig("ZOHO", process.env, destination.organizationId);
      if (candidate.dataCenter === destination.dataCenter && candidate.environment === destination.environment) config = candidate;
    } catch { /* Existing mapped vendors remain usable if private configuration is unavailable. */ }
  }
  return { purpose, company, destinations, destination, config, localDemoFallback };
}

function identity(value: Context) {
  return JSON.stringify([value.company, value.destinations, value.localDemoFallback,
    value.config ? [connectionFingerprint(value.config), value.config.networkEnabled] : null]);
}
async function recheck(store: Store, actor: Actor, before: Context) {
  const current = await context(store, actor, before.company.id, before.purpose);
  if (identity(current) !== identity(before))
    throw new HttpError(409, "The company or its Books connection changed. Search and select the vendor again.");
  return current;
}
function transportFor(value: Context, provided?: ZohoTransport) {
  const config = value.config;
  if (!config?.networkEnabled) throw blocked("BOOKS_LOOKUP_UNAVAILABLE", "The company's Books vendor connection is unavailable. Try again or contact an administrator.");
  if (provided && (connectionFingerprint(provided.config) !== connectionFingerprint(config) || !provided.config.networkEnabled))
    throw blocked("BOOKS_LOOKUP_UNAVAILABLE", "The vendor lookup connection does not match the selected company.");
  return provided ?? new ZohoTransport(config, () => accessToken(config));
}

const contactIdentity = z.object({
  contact_id: externalId, contact_name: z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/),
  contact_type: z.literal("vendor"), status: z.literal("active"), currency_code: currencySchema,
  email: z.unknown().optional(), tax_reg_no: z.unknown().optional(),
});
const emailSchema = z.email().max(254);
const trnSchema = z.string().trim().min(1).max(40).regex(/^[^\u0000-\u001f\u007f]+$/);
function contactMetadata(contact: { contact_id: string; contact_name: string; currency_code: string; email?: unknown; tax_reg_no?: unknown }) {
  const email = emailSchema.safeParse(contact.email);
  const trn = trnSchema.safeParse(contact.tax_reg_no);
  return { externalVendorId: contact.contact_id, name: contact.contact_name, currency: contact.currency_code,
    email: email.success ? email.data : null, trn: trn.success ? trn.data : null };
}
function parseContact(raw: unknown) {
  const parsed = contactIdentity.safeParse(raw);
  return parsed.success ? contactMetadata(parsed.data) : null;
}
const contactPage = z.object({ code: z.literal(0), contacts: z.array(z.unknown()).max(200),
  page_context: z.object({ page: z.literal(1).optional(), per_page: z.number().int().min(1).max(200).optional(), has_more_page: z.boolean() }).optional(),
});

async function savedSuggestions(value: Context, q: string) {
  const vendorFilter = { companyId: value.company.id, ...(q ? { name: { contains: literalContains(q) } } : {}) };
  if (!value.destinations.length || value.localDemoFallback) {
    const rows = await db.vendor.findMany({ where: vendorFilter, select: localFields, orderBy: { name: "asc" }, take: 26 });
    return { vendors: rows.filter(row => matchesName(row.name, q)).slice(0, 25) as VendorSuggestion[], hasMore: rows.length > 25 };
  }
  if (!value.destination) return { vendors: [] as VendorSuggestion[], hasMore: false };
  const parsedDestination = destinationInput.safeParse(value.destination);
  if (!parsedDestination.success) return { vendors: [] as VendorSuggestion[], hasMore: false };
  const rows = await db.vendorBooksMapping.findMany({
    where: { ...value.destination, vendor: vendorFilter },
    select: { externalVendorId: true, vendor: { select: localFields } },
    orderBy: { vendor: { name: "asc" } }, take: 26,
  });
  const destination = parsedDestination.data;
  return { vendors: rows.filter(row => matchesName(row.vendor.name, q)).slice(0, 25).map(row => ({ ...row.vendor, ...destination, externalVendorId: row.externalVendorId })), hasMore: rows.length > 25 };
}

async function unavailableSuggestions(value: Context, q: string, saved: { vendors: VendorSuggestion[]; hasMore: boolean }) {
  // A local draft may use an unmapped supplier. Never turn a supplier belonging to
  // another Books destination, or a legacy external ID, into an unmapped selection.
  if (!value.destination || !destinationInput.safeParse(value.destination).success) return saved;
  const rows = await db.vendor.findMany({
    where: { companyId: value.company.id, externalZohoId: null, booksMappings: { none: {} },
      ...(q ? { name: { contains: literalContains(q) } } : {}) },
    select: localFields, orderBy: { name: "asc" }, take: 26,
  });
  const local: VendorSuggestion[] = rows.filter(row => matchesName(row.name, q))
    .map(row => ({ ...row, booksMappingRequired: true }));
  const vendors = [...saved.vendors, ...local].sort((left, right) => left.name.localeCompare(right.name));
  return { vendors: vendors.slice(0, 25), hasMore: saved.hasMore || rows.length > 25 || vendors.length > 25 };
}

/** Company-scoped suggestions only. Neither local vendors nor provider contacts are written. */
export async function searchBillVendors(actor: Actor, payload: unknown, provided?: ZohoTransport) {
  const input = searchInput.parse(payload);
  const before = await context(db, actor, input.companyId);
  const organizationId = before.localDemoFallback ? null : before.destination?.organizationId ?? null;
  if (input.vendorId) {
    const selectedVendor = await db.vendor.findFirst({ where: { id: input.vendorId, companyId: input.companyId }, select: localFields });
    if (!selectedVendor) throw new HttpError(404, "Vendor not found in the selected company.");
    await recheck(db, actor, before);
    return { companyId: input.companyId, organizationId, vendors: [] as VendorSuggestion[], selectedVendor, warning: null, hasMore: false };
  }
  const saved = await savedSuggestions(before, input.q);
  let vendors: VendorSuggestion[] = saved.vendors;
  let hasMore = saved.hasMore;
  let warning: string | null = null;
  if (before.localDemoFallback) {
    warning = "Books is not configured for this demo company. Saved local vendors for this company are shown.";
  } else if (before.destinations.length > 1) {
    warning = "This company has multiple Books destinations. Ask an administrator to confirm its vendor connection.";
  } else if (before.destination) {
    if (!before.config?.networkEnabled) {
      ({ vendors, hasMore } = await unavailableSuggestions(before, input.q, saved));
      warning = "Books vendor search is unavailable. Saved suppliers for this company are shown. Local suppliers need a Books mapping before sync.";
    } else {
      try {
        const response = contactPage.safeParse(await transportFor(before, provided).request("/books/v3/contacts", {
          method: "GET", query: { contact_type: "vendor", ...(input.q ? { contact_name_contains: input.q } : {}), per_page: "25", page: "1" },
        }));
        if (!response.success) throw blocked("BOOKS_VENDOR_RESPONSE_INVALID", "Books returned an invalid vendor search response.");
        const seen = new Set<string>();
        const excluded = new Set<string>();
        const remote: NonNullable<ReturnType<typeof parseContact>>[] = [];
        for (const row of response.data.contacts) {
          const parsed = parseContact(row);
          const rowId = z.object({ contact_id: externalId }).safeParse(row);
          if (rowId.success && seen.has(rowId.data.contact_id)) throw blocked("BOOKS_VENDOR_RESPONSE_INVALID", "Books repeated a vendor in its search response.");
          if (rowId.success) seen.add(rowId.data.contact_id);
          if (!parsed || !matchesName(parsed.name, input.q)) {
            if (rowId.success) excluded.add(rowId.data.contact_id);
            continue;
          }
          remote.push(parsed);
        }
        const mapped = remote.length ? await db.vendorBooksMapping.findMany({
          where: { ...before.destination, externalVendorId: { in: remote.map(row => row.externalVendorId) }, vendor: { companyId: input.companyId } },
          select: { externalVendorId: true, vendor: { select: localFields } },
        }) : [];
        const suggestions: VendorSuggestion[] = remote.map(row => {
          const local = mapped.find(item => item.externalVendorId === row.externalVendorId)?.vendor;
          return { ...row, id: local?.currency === row.currency ? local.id : null, companyId: input.companyId,
            organizationId: before.config!.organizationId, dataCenter: before.config!.dataCenter, environment: before.config!.environment };
        });
        for (const row of saved.vendors) {
          if (!excluded.has(row.externalVendorId!) && !suggestions.some(item => item.externalVendorId === row.externalVendorId)) suggestions.push(row);
        }
        hasMore = Boolean(response.data.page_context?.has_more_page ?? response.data.contacts.length >= 25) || suggestions.length > 25 || saved.hasMore;
        vendors = suggestions.slice(0, 25);
      } catch {
        ({ vendors, hasMore } = await unavailableSuggestions(before, input.q, saved));
        warning = "Books vendors could not be loaded. Saved suppliers for this company are shown. Local suppliers need a Books mapping before sync.";
      }
    }
  }
  await recheck(db, actor, before);
  return { companyId: input.companyId, organizationId, vendors, selectedVendor: null, warning, hasMore };
}

/** Resolves a verified provider selection into the existing local vendor identity model. */
export async function resolveBillVendor(actor: Actor, payload: unknown, provided?: ZohoTransport): Promise<LocalVendor> {
  const input = resolveInput.parse(payload);
  const before = await context(db, actor, input.companyId);
  if (!before.destination || before.destination.organizationId !== input.organizationId || before.destination.dataCenter !== input.dataCenter || before.destination.environment !== input.environment)
    throw new HttpError(409, "The vendor selection does not match this company's current Books destination. Search again.");
  const response = z.object({ code: z.literal(0), contact: z.unknown() }).safeParse(
    await transportFor(before, provided).request(`/books/v3/contacts/${input.externalVendorId}`, { method: "GET" }),
  );
  const contact = response.success ? parseContact(response.data.contact) : null;
  if (!contact || contact.externalVendorId !== input.externalVendorId)
    throw blocked("BOOKS_VENDOR_INVALID", "Select an active Books vendor with a supported currency. The selected vendor could not be verified.");
  await recheck(db, actor, before);
  try {
    return await db.$transaction(async tx => {
      await recheck(tx, actor, before);
      const destination = { organizationId: input.organizationId, dataCenter: input.dataCenter, environment: input.environment };
      const mapping = await tx.vendorBooksMapping.findUnique({
        where: { organizationId_dataCenter_environment_externalVendorId: { ...destination, externalVendorId: input.externalVendorId } },
        include: { vendor: { select: { ...localFields, externalZohoId: true } } },
      });
      if (mapping) {
        if (mapping.vendor.companyId !== input.companyId || mapping.vendor.currency !== contact.currency ||
          (mapping.vendor.externalZohoId && mapping.vendor.externalZohoId !== input.externalVendorId))
          throw new HttpError(409, "The existing vendor mapping conflicts with this company or currency. Ask an administrator to review it.");
        await recheck(tx, actor, before);
        const { id, companyId, name, currency, email, trn } = mapping.vendor;
        return { id, companyId, name, currency, email, trn };
      }
      const collision = await tx.vendor.findFirst({ where: { companyId: input.companyId, OR: [
        { name: contact.name }, { externalZohoId: input.externalVendorId }, ...(contact.trn ? [{ trn: contact.trn }] : []),
      ] }, select: { id: true } });
      if (collision) throw new HttpError(409, "A saved vendor has the same name, tax registration or external ID. Ask an administrator to verify its Books mapping; existing records were preserved.");
      const vendor = await tx.vendor.create({ data: { companyId: input.companyId, name: contact.name, currency: contact.currency,
        email: contact.email, trn: contact.trn, isDemo: before.company.isDemo }, select: localFields });
      await tx.vendorBooksMapping.create({ data: { vendorId: vendor.id, ...destination, externalVendorId: input.externalVendorId } });
      await tx.auditLog.create({ data: { actorId: actor.id, companyId: input.companyId, action: "BOOKS_VENDOR_SELECTED",
        entityType: "Vendor", entityId: vendor.id, details: { ...destination, externalVendorId: input.externalVendorId, providerFinancialWrites: 0 } } });
      await recheck(tx, actor, before);
      return vendor;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20_000 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2034"].includes(error.code))
      throw new HttpError(409, "The vendor selection changed while saving. Search and select the vendor again.");
    throw error;
  }
}

export type DirectoryVendor = VendorSuggestion & { status: "active" | "inactive" | "local" };
export type CompanyVendorDirectory = {
  companyId: string;
  organizationId: string | null;
  dataCenter: string | null;
  environment: "production" | "sandbox" | null;
  source: "books" | "local";
  vendors: DirectoryVendor[];
  page: number;
  perPage: 100;
  hasMore: boolean;
  warning: string | null;
};
const directoryContact = contactIdentity.extend({
  status: z.string().trim().toLowerCase().pipe(z.enum(["active", "inactive"])),
  currency_code: z.string().regex(/^[A-Z]{3}$/),
});
const directoryPage = z.object({ code: z.literal(0), contacts: z.array(z.unknown()).max(100),
  page_context: z.object({ page: z.number().int().min(1).max(10_000), per_page: z.literal(100), has_more_page: z.boolean() }),
});
async function directoryAuthorized(config: ZohoConfig) {
  const grant = await db.integrationCredential.findUnique({
    where: { target_organizationId: { target: "ZOHO", organizationId: config.organizationId } },
    select: { revokedAt: true, connectionFingerprint: true },
  });
  if (grant) return !grant.revokedAt && grant.connectionFingerprint === connectionFingerprint(config);
  return Boolean(config.refreshToken && !await db.integrationCredential.findUnique({
    where: { target_organizationId: { target: "ZOHO", organizationId: LEGACY_UNSCOPED_ORGANIZATION } },
    select: { organizationId: true },
  }));
}

/** Read-only paginated directory. Provider contacts are never imported by listing them. */
export async function listCompanyVendorDirectory(actor: Actor, payload: unknown, provided?: ZohoTransport): Promise<CompanyVendorDirectory> {
  const input = directoryInput.parse(payload);
  const before = await context(db, actor, input.companyId, "directory");
  const local = !before.destinations.length || before.localDemoFallback;
  const destination = !local && before.destination ? destinationInput.safeParse(before.destination) : null;
  const result: CompanyVendorDirectory = {
    companyId: input.companyId, organizationId: destination?.success ? destination.data.organizationId : null,
    dataCenter: destination?.success ? destination.data.dataCenter : null, environment: destination?.success ? destination.data.environment : null,
    source: local ? "local" : "books", vendors: [], page: input.page, perPage: 100, hasMore: false, warning: null,
  };
  if (local) {
    const rows = await db.vendor.findMany({
      where: { companyId: input.companyId, ...(input.q ? { name: { contains: literalContains(input.q) } } : {}) },
      select: localFields, orderBy: [{ name: "asc" }, { id: "asc" }], skip: (input.page - 1) * 100, take: 101,
    });
    result.vendors = rows.slice(0, 100).filter(row => matchesName(row.name, input.q)).map(row => ({ ...row, status: "local" }));
    result.hasMore = rows.length > 100;
    if (before.localDemoFallback) result.warning = "Books is not configured for this demo company. Saved local suppliers for this company are shown.";
    await recheck(db, actor, before);
    return result;
  }
  if (!before.destination) result.warning = "This company has multiple Books destinations. Ask an administrator to confirm its supplier directory connection.";
  else if (!before.config?.networkEnabled) result.warning = "This company's Books supplier directory is unavailable. Check its connection and retry.";
  else if (!await directoryAuthorized(before.config)) result.warning = "This company's Books authorization is unavailable. Ask an administrator to check the connection and retry.";
  else {
    try {
      const response = directoryPage.safeParse(await transportFor(before, provided).request("/books/v3/contacts", {
        method: "GET", query: { contact_type: "vendor", ...(input.q ? { contact_name_contains: input.q } : {}),
          page: String(input.page), per_page: "100", sort_column: "contact_name", sort_order: "A" },
      }));
      if (!response.success || response.data.page_context.page !== input.page ||
        (response.data.page_context.has_more_page && response.data.contacts.length === 0))
        throw blocked("BOOKS_VENDOR_DIRECTORY_INVALID", "Books did not confirm the requested supplier page.");
      const seen = new Set<string>();
      const contacts: { contact: NonNullable<ReturnType<typeof parseContact>>; status: "active" | "inactive" }[] = [];
      for (const row of response.data.contacts) {
        // A provider-side contact filter may still include customers; never expose
        // them as suppliers. Malformed vendor rows fail the page instead of hiding records.
        const identity = z.object({ contact_id: externalId, contact_type: z.string() }).safeParse(row);
        if (!identity.success || seen.has(identity.data.contact_id))
          throw blocked("BOOKS_VENDOR_DIRECTORY_INVALID", "Books returned an invalid or repeated contact identity.");
        seen.add(identity.data.contact_id);
        if (identity.data.contact_type === "customer") continue;
        const parsed = directoryContact.safeParse(row);
        if (!parsed.success) throw blocked("BOOKS_VENDOR_DIRECTORY_INVALID", "Books returned an invalid supplier record.");
        if (matchesName(parsed.data.contact_name, input.q)) contacts.push({ contact: contactMetadata(parsed.data), status: parsed.data.status });
      }
      const mapped = contacts.length ? await db.vendorBooksMapping.findMany({
        where: { ...before.destination, externalVendorId: { in: contacts.map(row => row.contact.externalVendorId) }, vendor: { companyId: input.companyId } },
        select: { externalVendorId: true, vendor: { select: { id: true } } },
      }) : [];
      result.vendors = contacts.map(({ contact, status }) => ({ ...contact, status, companyId: input.companyId,
        id: mapped.find(row => row.externalVendorId === contact.externalVendorId)?.vendor.id ?? null,
        organizationId: before.config!.organizationId, dataCenter: before.config!.dataCenter, environment: before.config!.environment }));
      result.hasMore = response.data.page_context.has_more_page;
    } catch {
      result.vendors = [];
      result.hasMore = false;
      result.warning = "Books suppliers could not be loaded for this page. Retry the request or check this company's connection.";
    }
    const current = await recheck(db, actor, before);
    if (!current.config || !await directoryAuthorized(current.config))
      throw new HttpError(409, "This company's Books authorization changed. Reload the supplier directory.");
    return result;
  }
  await recheck(db, actor, before);
  return result;
}
