import "server-only";
import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { z } from "zod";
import type { Actor } from "@/lib/auth";
import { BOOKS_PURCHASE_ACCOUNT_TYPES, booksSelectionSchema, type BooksSelection } from "@/lib/books-selection";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import { canCreateBill } from "@/lib/permissions";
import { currencySchema } from "@/lib/validation";
import { booksConfigurationHash, getConfig, IntegrationError, type ZohoConfig } from "@/lib/integrations/config";
import { connectionFingerprint } from "@/lib/integrations/connection-fingerprint";
import { accessToken, LEGACY_UNSCOPED_ORGANIZATION } from "@/lib/integrations/oauth";
import { ZohoTransport } from "@/lib/integrations/transport";
import { parseBooksCatalogPage, type BooksCatalogEntry } from "./books-accounting-catalog";

const externalId = z.string().regex(/^\d{1,30}$/);
const label = z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/);
const inputSchema = z.object({
  companyId: z.string().trim().min(1).max(100),
  customerQuery: z.string().trim().max(100).default(""),
  customerId: externalId.optional(),
}).strict();

export type BillBooksAccountOption = { id: string; name: string; type: string; selectable: boolean };
export type BillBooksTaxOption = { id: string; name: string; rate: string; selectable: boolean };
export type BillBooksCustomerOption = { id: string; name: string; currency: string };
export type BillBooksOptions = {
  companyId: string;
  organizationId: string | null;
  dataCenter: string | null;
  environment: "production" | "sandbox" | null;
  accounts: BillBooksAccountOption[];
  taxes: BillBooksTaxOption[];
  customers: BillBooksCustomerOption[];
  warning: string | null;
  hasMoreCustomers: boolean;
};
type Catalog = Pick<BillBooksOptions, "accounts" | "taxes">;
type Context = {
  companyId: string;
  destinations: { organizationId: string; dataCenter: string; environment: string }[];
  config: ZohoConfig | null;
  authorized: boolean;
  grantRevision: string;
  warning: string | null;
};
const cache = new Map<string, { expiresAt: number; value: Catalog }>();
const cacheLifetime = 60_000;
const cacheLimit = 32;
// Bills support purchase/expense and asset allocations; setup's category-mapping
// recommendations intentionally cover only expense accounts and are narrower.
const billAccountTypes = new Set<string>(BOOKS_PURCHASE_ACCOUNT_TYPES);
const invalid = (message: string) => new IntegrationError("BOOKS_OPTIONS_INVALID", message, "BLOCKED");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

async function context(actor: Actor, companyId: string): Promise<Context> {
  if (!canCreateBill(actor) || !await db.user.findFirst({
    where: { id: actor.id, active: true, role: { in: ["ADMIN", "ACCOUNTS", "DATA_ENTRY"] },
      memberships: { some: { companyId, active: true, company: { active: true } } } },
    select: { id: true },
  })) throw new HttpError(403, "Current bill-entry access to this company is required.");
  const destinations = await db.companyIntegrationDestination.findMany({
    where: { companyId, target: "ZOHO" },
    select: { organizationId: true, dataCenter: true, environment: true },
    orderBy: [{ organizationId: "asc" }, { dataCenter: "asc" }, { environment: "asc" }],
  });
  const result: Context = { companyId, destinations, config: null, authorized: false, grantRevision: "", warning: null };
  if (destinations.length !== 1) {
    result.warning = destinations.length ? "This company has multiple Books destinations. Ask an administrator to confirm its connection." : "Books options are not configured for this company.";
    return result;
  }
  try {
    const configured = getConfig("ZOHO", process.env, destinations[0].organizationId);
    if (configured.dataCenter !== destinations[0].dataCenter || configured.environment !== destinations[0].environment)
      throw invalid("Books destination configuration changed.");
    result.config = configured;
  } catch {
    result.warning = "Books options are not configured for this company's destination.";
    return result;
  }
  if (!result.config.networkEnabled) {
    result.warning = "Books options are unavailable because this company's connection is disabled.";
    return result;
  }
  const grant = await db.integrationCredential.findUnique({
    where: { target_organizationId: { target: "ZOHO", organizationId: result.config.organizationId } },
    select: { organizationId: true, revokedAt: true, connectionFingerprint: true, updatedAt: true },
  });
  if (grant) {
    result.authorized = !grant.revokedAt && grant.connectionFingerprint === connectionFingerprint(result.config);
    result.grantRevision = `${grant.organizationId}:${grant.updatedAt.toISOString()}`;
  } else if (result.config.refreshToken && !await db.integrationCredential.findUnique({
    where: { target_organizationId: { target: "ZOHO", organizationId: LEGACY_UNSCOPED_ORGANIZATION } }, select: { organizationId: true },
  })) {
    result.authorized = true;
    result.grantRevision = hash(result.config.refreshToken);
  }
  if (!result.authorized) result.warning = "Books options are unavailable. Ask an administrator to check this company's Books authorization.";
  return result;
}

function contextIdentity(value: Context) {
  return JSON.stringify([value.companyId, value.destinations, value.authorized,
    value.config ? [booksConfigurationHash(value.config), value.config.networkEnabled] : null]);
}
async function recheck(actor: Actor, before: Context) {
  const current = await context(actor, before.companyId);
  if (contextIdentity(current) !== contextIdentity(before))
    throw new HttpError(409, "The company or Books connection changed. Reload the options before selecting them.");
  return current;
}
function cacheKey(value: Context) {
  return JSON.stringify([value.companyId, booksConfigurationHash(value.config!), value.grantRevision]);
}
function readCache(key: string) {
  const found = cache.get(key);
  if (!found || found.expiresAt <= Date.now()) { cache.delete(key); return null; }
  return structuredClone(found.value);
}
function writeCache(key: string, value: Catalog) {
  for (const [storedKey, item] of cache) if (item.expiresAt <= Date.now()) cache.delete(storedKey);
  if (cache.size >= cacheLimit) cache.delete(cache.keys().next().value!);
  cache.set(key, { expiresAt: Date.now() + cacheLifetime, value: structuredClone(value) });
}
function transportFor(value: Context, provided?: ZohoTransport) {
  const config = value.config;
  if (!config?.networkEnabled || !value.authorized) throw invalid("Books options require this company's current authorized connection.");
  if (provided && (booksConfigurationHash(provided.config) !== booksConfigurationHash(config) || !provided.config.networkEnabled))
    throw invalid("The Books lookup connection does not match this company.");
  return provided ?? new ZohoTransport(config, () => accessToken(config));
}

async function readCatalog(transport: ZohoTransport): Promise<Catalog> {
  const organization = z.object({ code: z.literal(0), organization: z.object({ organization_id: externalId, is_org_active: z.literal(true) }) }).safeParse(
    await transport.request(`/books/v3/organizations/${transport.config.organizationId}`, { method: "GET" }),
  );
  if (!organization.success || organization.data.organization.organization_id !== transport.config.organizationId)
    throw invalid("Books did not confirm the requested active organization.");
  async function read(kind: "accounts" | "taxes", path: string) {
    const rows: BooksCatalogEntry[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= 10; page++) {
      const parsed = parseBooksCatalogPage(kind, await transport.request(path, { method: "GET", query: { page: String(page), per_page: "100" } }), page);
      for (const row of parsed.entries) {
        if (seen.has(row.id)) throw invalid("Books returned duplicate accounting options.");
        seen.add(row.id); rows.push(row);
      }
      if (!parsed.hasMore) return rows;
      if (!parsed.entries.length) throw invalid("Books returned invalid accounting pagination.");
    }
    throw invalid("Books accounting options exceed the supported catalog limit.");
  }
  const accounts = await read("accounts", "/books/v3/chartofaccounts");
  const taxes = await read("taxes", "/books/v3/settings/taxes");
  return {
    accounts: accounts.map(row => ({ id: row.id, name: row.label, type: row.type!, selectable: row.active === true && billAccountTypes.has(row.type!) })),
    taxes: taxes.map(row => {
      const rate = new Decimal(row.percentage!);
      return { id: row.id, name: row.label, rate: rate.toFixed(), selectable: row.supported && rate.decimalPlaces() <= 2 };
    }),
  };
}

const customerSchema = z.object({ contact_id: externalId, contact_name: label, contact_type: z.literal("customer"), status: z.literal("active"), currency_code: currencySchema });
const customerPageSchema = z.object({ code: z.literal(0), contacts: z.array(z.unknown()).max(200),
  page_context: z.object({ page: z.literal(1).optional(), per_page: z.number().int().min(1).max(200).optional(), has_more_page: z.boolean() }).optional(),
});
function parseCustomer(raw: unknown): BillBooksCustomerOption | null {
  const parsed = customerSchema.safeParse(raw);
  return parsed.success ? { id: parsed.data.contact_id, name: parsed.data.contact_name, currency: parsed.data.currency_code } : null;
}
async function readCustomers(transport: ZohoTransport, input: z.infer<typeof inputSchema>) {
  if (input.customerId) {
    const response = z.object({ code: z.literal(0), contact: z.unknown() }).safeParse(
      await transport.request(`/books/v3/contacts/${input.customerId}`, { method: "GET" }),
    );
    const customer = response.success ? parseCustomer(response.data.contact) : null;
    if (!customer || customer.id !== input.customerId) throw invalid("The selected active Books customer could not be verified.");
    return { customers: [customer], hasMoreCustomers: false };
  }
  const response = customerPageSchema.safeParse(await transport.request("/books/v3/contacts", {
    method: "GET", query: { contact_type: "customer", ...(input.customerQuery ? { contact_name_contains: input.customerQuery } : {}), page: "1", per_page: "25" },
  }));
  if (!response.success) throw invalid("Books returned an invalid customer search response.");
  const seen = new Set<string>();
  const customers: BillBooksCustomerOption[] = [];
  for (const row of response.data.contacts) {
    const identity = z.object({ contact_id: externalId }).safeParse(row);
    if (identity.success) {
      if (seen.has(identity.data.contact_id)) throw invalid("Books repeated a customer in its response.");
      seen.add(identity.data.contact_id);
    }
    const customer = parseCustomer(row);
    if (customer && customer.name.normalize("NFKC").toLowerCase().includes(input.customerQuery.normalize("NFKC").toLowerCase())) customers.push(customer);
  }
  return { customers: customers.slice(0, 25), hasMoreCustomers: Boolean(response.data.page_context?.has_more_page ?? response.data.contacts.length >= 25) || customers.length > 25 };
}

/** Read-only dropdown metadata. Cached catalogs never bypass current access or grant checks. */
export async function getBillBooksOptions(actor: Actor, payload: unknown, provided?: ZohoTransport): Promise<BillBooksOptions> {
  const input = inputSchema.parse(payload);
  const before = await context(actor, input.companyId);
  const result: BillBooksOptions = { companyId: input.companyId, organizationId: before.config?.organizationId ?? null,
    dataCenter: before.config?.dataCenter ?? null, environment: before.config?.environment ?? null,
    accounts: [], taxes: [], customers: [], warning: before.warning, hasMoreCustomers: false };
  if (!before.config?.networkEnabled || !before.authorized) { await recheck(actor, before); return result; }
  // Reject an injected mismatched connection even when a catalog is already cached.
  const transport = transportFor(before, provided);
  const cached = readCache(cacheKey(before));
  let catalog = cached;
  if (!catalog) {
    try { catalog = await readCatalog(transport); }
    catch { result.warning = "Books account and tax options could not be loaded. Try again."; }
  }
  if (catalog) Object.assign(result, catalog);
  try { Object.assign(result, await readCustomers(transport, input)); }
  catch { result.warning = [result.warning, "Books customers could not be loaded or verified. Search again."].filter(Boolean).join(" "); }
  const current = await recheck(actor, before);
  // A refresh/re-authorization can rotate grant metadata while reading. Never
  // put results obtained under its old revision into a new revision's cache.
  if (catalog && !cached && current.grantRevision === before.grantRevision) writeCache(cacheKey(current), catalog);
  return result;
}

/** Fresh provider verification for a save; dropdown cache and submitted labels are not evidence. */
export async function verifyBillBooksSelections(
  actor: Actor,
  companyId: string,
  selections: readonly unknown[],
  provided?: ZohoTransport,
): Promise<(BooksSelection | null)[]> {
  const input = z.object({ companyId: inputSchema.shape.companyId, selections: z.array(booksSelectionSchema.nullish()).max(100) }).parse({ companyId, selections });
  const before = await context(actor, input.companyId);
  const selected = input.selections.filter((selection): selection is BooksSelection => Boolean(selection));
  if (!selected.length) { await recheck(actor, before); return input.selections.map(() => null); }
  const config = before.config;
  if (!config || selected.some(selection => selection.organizationId !== config.organizationId || selection.dataCenter !== config.dataCenter || selection.environment !== config.environment))
    throw new HttpError(409, "Each selected account, tax and customer must belong to this company's current Books destination.");
  const customerIds = [...new Set(selected.flatMap(selection => selection.customerId ? [selection.customerId] : []))];
  if (customerIds.length > 25) throw new HttpError(422, "A bill can verify up to 25 distinct Books customers. Split this bill before continuing.");
  const transport = transportFor(before, provided);
  // Full bounded fresh catalogs detect inactive, missing or duplicated IDs and
  // retain the provider's authoritative account/tax names and percentages.
  const catalog = await readCatalog(transport);
  for (const selection of selected) {
    if (!catalog.accounts.some(account => account.id === selection.accountId && account.selectable))
      throw new HttpError(422, "A selected Books account is unavailable or unsupported. Choose a current purchase, expense or asset account.");
    const tax = catalog.taxes.find(tax => tax.id === selection.taxId && tax.selectable);
    if (!tax)
      throw new HttpError(422, "A selected Books tax is unavailable or unsupported. Choose a current simple percentage tax.");
    if (!new Decimal(tax.rate).equals(selection.taxRate))
      throw new HttpError(409, "A selected Books tax rate changed. Reload the options and review the invoice totals before saving.");
  }
  const customers = new Map<string, BillBooksCustomerOption>();
  for (let offset = 0; offset < customerIds.length; offset += 4) {
    const batch = await Promise.all(customerIds.slice(offset, offset + 4).map(async customerId => {
      const result = await readCustomers(transport, { companyId: input.companyId, customerQuery: "", customerId });
      return result.customers[0];
    }));
    for (const customer of batch) customers.set(customer.id, customer);
  }
  await recheck(actor, before);
  return input.selections.map(selection => {
    if (!selection) return null;
    const account = catalog.accounts.find(row => row.id === selection.accountId)!;
    const tax = catalog.taxes.find(row => row.id === selection.taxId)!;
    const customer = selection.customerId ? customers.get(selection.customerId)! : null;
    return { organizationId: config.organizationId, dataCenter: config.dataCenter, environment: config.environment,
      accountId: account.id, accountName: account.name, taxId: tax.id, taxName: tax.name, taxRate: new Decimal(tax.rate).toFixed(2),
      customerId: customer?.id ?? null, customerName: customer?.name ?? null };
  });
}
