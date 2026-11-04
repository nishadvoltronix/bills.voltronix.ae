import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import { booksConfigurationHash, getConfig, IntegrationError, type ZohoConfig } from "./config";
import { connectionFingerprint } from "./connection-fingerprint";
import { LEGACY_UNSCOPED_ORGANIZATION } from "./oauth";
import type { ProductionWriteRequest } from "./transport";

const externalId = z.string().regex(/^\d{1,30}$/);
export const vendorContactPayloadSchema = z.object({
  contact_name: z.string().trim().min(2).max(200).regex(/^[^\u0000-\u001f\u007f]+$/),
  contact_type: z.literal("vendor"), currency_id: externalId,
  tax_treatment: z.enum(["vat_registered", "vat_not_registered"]),
  tax_reg_no: z.string().min(1).max(40).optional(),
  is_portal_enabled: z.literal(false), notes: z.string().max(250),
  contact_persons: z.array(z.object({ email: z.email().max(254), is_primary_contact: z.literal(true) }).strict()).max(1).optional(),
}).strict();
export const vendorSyncSnapshotSchema = z.object({
  vendor: z.object({ id: z.string(), companyId: z.string(), name: z.string(), currency: z.string(),
    email: z.string().nullable(), trn: z.string().nullable(), isDemo: z.boolean(), externalZohoId: z.string().nullable() }).strict(),
  destination: z.object({ organizationId: externalId, dataCenter: z.string(), environment: z.enum(["production", "sandbox"]),
    connectionFingerprint: z.string().length(64), configurationHash: z.string().length(64) }).strict(),
  marker: z.string().regex(/^VX-VENDOR-[a-f0-9]{40}$/), payload: vendorContactPayloadSchema,
}).strict();
export type VendorSyncSnapshot = z.infer<typeof vendorSyncSnapshotSchema>;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export const vendorSnapshotHash = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
export const vendorSourceFields = { id: true, companyId: true, name: true, currency: true, email: true, trn: true, isDemo: true, externalZohoId: true } as const;

const permits = new WeakMap<object, { jobId: string; leaseToken: string; consumed: boolean }>();
declare const vendorCapability: unique symbol;
export type VendorContactWriteCapability = { readonly [vendorCapability]: true };
const denied = (message: string) => new IntegrationError("VENDOR_WRITE_PERMISSION_REQUIRED", message, "BLOCKED");

/** Opaque, exact-operation authority. The transport independently rechecks it before POST. */
export function vendorContactCapability(jobId: string, leaseToken: string): VendorContactWriteCapability {
  const capability = Object.freeze({}) as VendorContactWriteCapability;
  permits.set(capability, { jobId, leaseToken, consumed: false });
  return capability;
}

export async function assertVendorContactWrite(capability: VendorContactWriteCapability, config: ZohoConfig, request?: ProductionWriteRequest) {
  const permit = permits.get(capability);
  if (!permit || permit.consumed || config.target !== "ZOHO" || request?.path !== "/books/v3/contacts" || request.form || !vendorContactPayloadSchema.safeParse(request.body).success)
    throw denied("Only the current saved supplier contact operation is permitted.");
  const job = await db.vendorBooksSync.findUnique({ where: { id: permit.jobId } });
  if (!job || job.status !== "PROCESSING" || job.leaseToken !== permit.leaseToken || !job.leaseUntil ||
    job.leaseUntil <= new Date() || !job.submittedAt || job.externalVendorId)
    throw denied("The saved supplier operation is no longer authorized to create a contact.");
  const snapshot = vendorSyncSnapshotSchema.parse(job.snapshot);
  const currentConfig = getConfig("ZOHO", process.env, job.organizationId);
  if (job.sourceHash !== vendorSnapshotHash(snapshot) || vendorSnapshotHash(request.body) !== vendorSnapshotHash(snapshot.payload) ||
    config.organizationId !== job.organizationId || config.dataCenter !== job.dataCenter || config.environment !== job.environment ||
    connectionFingerprint(currentConfig) !== snapshot.destination.connectionFingerprint ||
    connectionFingerprint(config) !== snapshot.destination.connectionFingerprint ||
    booksConfigurationHash(currentConfig) !== snapshot.destination.configurationHash ||
    booksConfigurationHash(config) !== snapshot.destination.configurationHash ||
    !currentConfig.networkEnabled || !currentConfig.writeEnabled)
    throw denied("The supplier source or its reviewed Books connection changed. No contact was sent.");
  if (!await db.vendorBooksSync.findFirst({ where: { id: job.id, status: "PROCESSING", leaseToken: permit.leaseToken,
    submittedAt: { not: null }, externalVendorId: null, leaseUntil: { gt: new Date() }, sourceHash: job.sourceHash }, select: { id: true } }))
    throw denied("The supplier operation lease expired before submission.");
  await assertVendorSyncSource(job, snapshot, currentConfig, true);
}

/** Synchronous one-send boundary after all asynchronous transport checks. */
export function consumeVendorContactWrite(capability: VendorContactWriteCapability) {
  const permit = permits.get(capability);
  if (!permit || permit.consumed) throw denied("This supplier creation request has already been submitted.");
  permit.consumed = true;
}

export async function assertVendorSyncSource(job: { vendorId: string; companyId: string; organizationId: string; dataCenter: string;
  environment: string; initiatedById: string }, snapshot: VendorSyncSnapshot, config: ZohoConfig, creating = false) {
  const [actor, vendor, company, destination, mappings] = await Promise.all([
    db.user.findFirst({ where: { id: job.initiatedById, active: true, role: { in: ["ADMIN", "ACCOUNTS"] },
      memberships: { some: { companyId: job.companyId, active: true, company: { active: true } } } }, select: { id: true } }),
    db.vendor.findUnique({ where: { id: job.vendorId }, select: vendorSourceFields }),
    db.company.findUnique({ where: { id: job.companyId }, select: { active: true, isDemo: true, liveAccountingEnabled: true } }),
    db.companyIntegrationDestination.findFirst({ where: { companyId: job.companyId, target: "ZOHO", organizationId: job.organizationId,
      dataCenter: job.dataCenter, environment: job.environment } }),
    db.vendorBooksMapping.findMany({ where: { vendorId: job.vendorId }, select: { organizationId: true, dataCenter: true, environment: true } }),
  ]);
  if (!actor || !vendor || vendor.companyId !== job.companyId || !company?.active || !destination ||
    vendorSnapshotHash(vendor) !== vendorSnapshotHash(snapshot.vendor) ||
    job.organizationId !== snapshot.destination.organizationId || job.dataCenter !== snapshot.destination.dataCenter || job.environment !== snapshot.destination.environment ||
    connectionFingerprint(config) !== snapshot.destination.connectionFingerprint || booksConfigurationHash(config) !== snapshot.destination.configurationHash)
    throw denied("Current supplier-management access and the unchanged company destination are required.");
  if (mappings.some(m => m.organizationId !== job.organizationId || m.dataCenter !== job.dataCenter || m.environment !== job.environment) ||
    (creating && (mappings.length > 0 || vendor.externalZohoId)))
    throw denied("An existing supplier identity must be reviewed; automatic creation cannot replace a legacy or other-destination mapping.");
  if (config.environment === "production" && (!config.liveRuntime || !company.liveAccountingEnabled || company.isDemo || vendor.isDemo ||
    !destination.liveEnabled || !destination.verifiedAt || destination.verifiedAt > new Date() || !destination.verificationReference?.trim() ||
    destination.verifiedConfigurationHash !== booksConfigurationHash(config)))
    throw denied("A verified and enabled real company Books destination is required for supplier creation.");
  const grant = await db.integrationCredential.findUnique({ where: { target_organizationId: { target: "ZOHO", organizationId: config.organizationId } },
    select: { revokedAt: true, connectionFingerprint: true } });
  if (grant ? grant.revokedAt || grant.connectionFingerprint !== connectionFingerprint(config)
    : !config.refreshToken || await db.integrationCredential.findUnique({ where: { target_organizationId: { target: "ZOHO", organizationId: LEGACY_UNSCOPED_ORGANIZATION } }, select: { organizationId: true } }))
    throw denied("Current Books authorization is required for this supplier destination.");
  return vendor;
}
