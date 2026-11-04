import "server-only";
import type { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { z } from "zod";
import type { Actor } from "@/lib/auth";
import { isManualEntryOnly } from "@/lib/application-mode";
import { BOOKS_NO_VAT, booksSelectionSchema } from "@/lib/books-selection";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import { booksConfigurationHash, getConfig } from "@/lib/integrations/config";
import { connectionFingerprint } from "@/lib/integrations/connection-fingerprint";
import { accessToken, LEGACY_UNSCOPED_ORGANIZATION } from "@/lib/integrations/oauth";
import { ZohoTransport } from "@/lib/integrations/transport";
import { BOOKS_VENDOR_VAT_REVIEW_MESSAGE, booksVendorVatMetadata, hasBooksVendorTaxConflict } from "@/lib/integrations/books-vendor-tax";

export type BillVendorVatSource = {
  vendorId: string; currency: string; vatRate: string | { toString(): string };
  lines: readonly { booksSelection?: unknown }[]; billId?: string; version?: number;
};
export type BillVendorVatVerification = Readonly<{ kind: "verified-bill-vendor-vat" }>;
type Store = Prisma.TransactionClient;
const lifetime = 60_000;
const failure = (code: string, message: string, status = 422) => Object.assign(new HttpError(status, message), { code });
const retryMessage = "The supplier's current Zoho VAT details could not be verified. Your draft is preserved. Retry final save or ask an administrator to check the supplier connection.";
const proofs = new WeakMap<BillVendorVatVerification, { actorId: string; companyId: string; request: string; context: string; expiresAt: number; consumed: boolean }>();
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const externalId = z.string().regex(/^\d{1,30}$/);

function request(source: BillVendorVatSource) {
  const vendorId = z.string().min(1).max(100).parse(source.vendorId);
  const currency = z.string().regex(/^[A-Z]{3}$/).parse(source.currency);
  const billId = z.string().min(1).max(100).optional().parse(source.billId);
  const version = z.number().int().positive().optional().parse(source.version);
  let vatRate: string;
  try { const rate = new Decimal(source.vatRate.toString()); if (!rate.isFinite() || rate.isNegative() || rate.greaterThan(100) || rate.decimalPlaces() > 2) throw new Error(); vatRate = rate.toFixed(2); }
  catch { throw failure("VENDOR_VAT_SOURCE_INVALID", "Review the invoice VAT rate before final save."); }
  if (!source.lines.length || source.lines.length > 100) throw failure("VENDOR_VAT_SOURCE_INVALID", "Review the invoice lines before final save.");
  const selections = source.lines.map(line => line.booksSelection == null ? null : booksSelectionSchema.parse(line.booksSelection));
  if (selections.some(Boolean) && selections.some(selection => !selection)) throw failure("VENDOR_VAT_SOURCE_INVALID", "Every invoice line must use the same Books tax selection mode.");
  return { vendorId, currency, vatRate, billId, version, selections };
}

function requestHash(source: ReturnType<typeof request>) {
  return hash({ vendorId: source.vendorId, currency: source.currency, billId: source.billId, version: source.version,
    vatRate: source.selections.some(Boolean) ? null : source.vatRate,
    selections: source.selections.map(selection => selection ? {
      organizationId: selection.organizationId, dataCenter: selection.dataCenter, environment: selection.environment,
      accountId: selection.accountId, taxId: selection.taxId, taxRate: new Decimal(selection.taxRate).toFixed(2), customerId: selection.customerId,
    } : null) });
}

async function context(store: Store, actor: Actor, companyId: string, source: ReturnType<typeof request>) {
  const policy = await verificationPolicy(store, actor, companyId);
  if (!policy.required) throw failure("VENDOR_VAT_CONTEXT_CHANGED", "The company's posting policy changed. Review and retry final save.", 409);
  const [vendor, destinations] = await Promise.all([
    store.vendor.findFirst({ where: { id: source.vendorId, companyId }, select: { id: true, companyId: true, currency: true } }),
    store.companyIntegrationDestination.findMany({ where: { companyId, target: "ZOHO" },
      select: { organizationId: true, dataCenter: true, environment: true }, orderBy: [{ organizationId: "asc" }, { dataCenter: "asc" }, { environment: "asc" }] }),
  ]);
  if (!vendor || vendor.currency !== source.currency) throw failure("VENDOR_VAT_SOURCE_INVALID", "Choose the supplier from this company in the invoice currency.");
  if (destinations.length !== 1) throw failure("VENDOR_VAT_LOOKUP_UNAVAILABLE", retryMessage);
  let config;
  try { config = getConfig("ZOHO", process.env, destinations[0].organizationId); }
  catch { throw failure("VENDOR_VAT_LOOKUP_UNAVAILABLE", retryMessage); }
  if (!config.networkEnabled || config.dataCenter !== destinations[0].dataCenter || config.environment !== destinations[0].environment)
    throw failure("VENDOR_VAT_LOOKUP_UNAVAILABLE", retryMessage);
  const [mapping, grant] = await Promise.all([
    store.vendorBooksMapping.findUnique({ where: { vendorId_organizationId_dataCenter_environment: {
      vendorId: vendor.id, organizationId: config.organizationId, dataCenter: config.dataCenter, environment: config.environment,
    } } }),
    store.integrationCredential.findUnique({ where: { target_organizationId: { target: "ZOHO", organizationId: config.organizationId } },
      select: { organizationId: true, dataCenter: true, revokedAt: true, connectionFingerprint: true } }),
  ]);
  let authorized = !!grant && !grant.revokedAt && grant.connectionFingerprint === connectionFingerprint(config) && grant.dataCenter === config.dataCenter;
  if (!grant && config.refreshToken && !await store.integrationCredential.findUnique({
    where: { target_organizationId: { target: "ZOHO", organizationId: LEGACY_UNSCOPED_ORGANIZATION } }, select: { organizationId: true },
  })) authorized = true;
  if (!authorized || !mapping || !externalId.safeParse(mapping.externalVendorId).success)
    throw failure("VENDOR_VAT_LOOKUP_UNAVAILABLE", retryMessage);
  if (source.selections.some(selection => selection && (selection.organizationId !== config.organizationId || selection.dataCenter !== config.dataCenter || selection.environment !== config.environment)))
    throw failure("VENDOR_VAT_SOURCE_INVALID", "The selected taxes must belong to this company's current Books destination.", 409);
  return { config, externalVendorId: mapping.externalVendorId, fingerprint: hash([companyId, policy.identity, vendor, destinations,
    mapping.id, mapping.externalVendorId, booksConfigurationHash(config), connectionFingerprint(config), authorized]) };
}

async function verificationPolicy(store: Store, actor: Actor, companyId: string) {
  if (!["ADMIN", "ACCOUNTS", "DATA_ENTRY"].includes(actor.role) || !await store.user.findFirst({ where: {
    id: actor.id, active: true, role: actor.role,
    memberships: { some: { companyId, active: true, company: { active: true } } },
  }, select: { id: true } })) throw failure("VENDOR_VAT_ACCESS_CHANGED", "Current bill-entry access to this company is required.", 403);
  const company = await store.company.findUnique({ where: { id: companyId }, select: { id: true, active: true, isDemo: true, liveAccountingEnabled: true } });
  if (!company?.active) throw failure("VENDOR_VAT_ACCESS_CHANGED", "Current bill-entry access to this company is required.", 403);
  const manual = isManualEntryOnly();
  return { required: !manual && !company.isDemo && company.liveAccountingEnabled, identity: { company, manual } };
}

/** Missing provider configuration cannot downgrade a real enabled company's policy. */
export async function requiresBillVendorVatVerification(store: Store, actor: Actor, companyId: string) {
  return (await verificationPolicy(store, actor, companyId)).required;
}

/** Fresh GET-only verification before final save; draft saves do not need this proof. */
export async function prepareBillVendorVatVerification(actor: Actor, companyId: string, source: BillVendorVatSource, provided?: ZohoTransport): Promise<BillVendorVatVerification | undefined> {
  if (provided && (process.env.NODE_ENV !== "test" || process.env.APP_ENV === "production")) throw failure("VENDOR_VAT_TEST_TRANSPORT_FORBIDDEN", "A test supplier connection cannot be used for final save in this environment.");
  if (!await requiresBillVendorVatVerification(db, actor, companyId)) return undefined;
  const input = request(source), before = await context(db, actor, companyId, input);
  if (provided && (booksConfigurationHash(provided.config) !== booksConfigurationHash(before.config) || connectionFingerprint(provided.config) !== connectionFingerprint(before.config) || !provided.config.networkEnabled))
    throw failure("VENDOR_VAT_LOOKUP_UNAVAILABLE", retryMessage);
  const transport = provided ?? new ZohoTransport(before.config, () => accessToken(before.config));
  let contact;
  try {
    const result = z.object({ code: z.literal(0), contact: z.object({ contact_id: externalId, contact_type: z.literal("vendor"),
      status: z.literal("active"), currency_code: z.string(), tax_treatment: z.unknown().optional(), tax_reg_no: z.unknown().optional() }) }).parse(
      await transport.request(`/books/v3/contacts/${before.externalVendorId}`, { method: "GET" }));
    if (result.contact.contact_id !== before.externalVendorId || result.contact.currency_code !== input.currency) throw new Error();
    contact = result.contact;
  } catch { throw failure("VENDOR_VAT_LOOKUP_UNAVAILABLE", retryMessage); }
  const taxIds = input.selections.some(Boolean) ? input.selections.flatMap(selection => selection && selection.taxId !== BOOKS_NO_VAT ? [selection.taxId] : [])
    : [before.config.booksMapping?.taxes[input.vatRate]?.id].filter((value): value is string => Boolean(value));
  if ((await context(db, actor, companyId, input)).fingerprint !== before.fingerprint)
    throw failure("VENDOR_VAT_CONTEXT_CHANGED", "The supplier or Books connection changed. Review the supplier and retry final save.", 409);
  if (hasBooksVendorTaxConflict(booksVendorVatMetadata(contact).taxTreatment, taxIds.map(tax_id => ({ tax_id }))))
    throw failure("VENDOR_VAT_TREATMENT_MISMATCH", BOOKS_VENDOR_VAT_REVIEW_MESSAGE);
  const proof = Object.freeze({ kind: "verified-bill-vendor-vat" as const });
  proofs.set(proof, { actorId: actor.id, companyId, request: requestHash(input), context: before.fingerprint, expiresAt: Date.now() + lifetime, consumed: false });
  return proof;
}

/** Recheck the exact source under the final-save transaction, and consume once. */
export async function assertBillVendorVatVerification(store: Store, actor: Actor, companyId: string, source: BillVendorVatSource, proof?: BillVendorVatVerification) {
  if (!await requiresBillVendorVatVerification(store, actor, companyId)) {
    if (proof) throw failure("VENDOR_VAT_CONTEXT_CHANGED", "The company's posting policy changed. Review and retry final save.", 409);
    return;
  }
  const input = request(source), held = proof && proofs.get(proof);
  if (!held || held.consumed || held.actorId !== actor.id || held.companyId !== companyId || held.request !== requestHash(input) || held.expiresAt <= Date.now())
    throw failure("VENDOR_VAT_VERIFICATION_REQUIRED", "Verify this supplier and its selected VAT before final save. Your draft is preserved.");
  if ((await context(store, actor, companyId, input)).fingerprint !== held.context || held.expiresAt <= Date.now())
    throw failure("VENDOR_VAT_CONTEXT_CHANGED", "The supplier or Books connection changed. Review the supplier and retry final save.", 409);
  held.consumed = true;
}
