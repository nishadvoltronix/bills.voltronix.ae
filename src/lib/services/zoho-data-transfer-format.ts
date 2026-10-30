import { createHash } from "node:crypto";
import { z } from "zod";

/** A private, source-cache-only interchange format. It deliberately has no auth or native accounting tables. */
export const MAX_TRANSFER_MANIFEST_BYTES = 256 * 1024 * 1024;
export class ZohoDataTransferError extends Error {
  constructor(public readonly code: string) {
    super(`Zoho data transfer validation failed (${code}).`);
    this.name = "ZohoDataTransferError";
  }
}
export function transferFailure(code: string): never { throw new ZohoDataTransferError(code); }
const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const externalId = z.string().regex(/^\d{1,30}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.iso.datetime().refine((value) => new Date(value).toISOString() === value);
const text = (max: number) => z.string().max(max);
const money = text(100).regex(/^-?\d+(?:\.\d+)?$/);
const count = z.number().int().min(0).max(10_000_000);
const json = z.record(z.string(), z.json());
const source = z.object({ organizationId: externalId,
  dataCenter: z.enum(["US", "EU", "IN", "AU", "JP", "CA", "CN", "SA", "AE"]),
  environment: z.literal("production") }).strict();
const crmIdentity = { crmOrganizationId: externalId, dataCenter: source.shape.dataCenter,
  environment: source.shape.environment, sourceModule: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,99}$/) };
const company = z.object({ id, name: text(200).min(1), isDemo: z.boolean(), createdAt: time,
  books: source.extend({ createdAt: time }), crm: source.extend({ createdAt: time }) }).strict();
const booksRun = source.extend({ id, companyId: id, organizationName: text(200).min(1),
  status: z.literal("COMPLETE"), runKind: z.enum(["FULL", "INCREMENTAL", "RESTORE"]),
  lastPage: count, lastPageHash: sha256.nullable(), listingComplete: z.literal(true),
  listedCount: count, detailCount: count, startedAt: time, completedAt: time }).strict();
const crmFields = z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,99}$/)).min(1).max(100);
// Manual imports store the selected fields directly. Recurring imports retain
// completed source-run metadata here; these historical values never seed a target cursor.
const completedCrmMetadata = z.object({ kind: z.literal("INCOMING_CRM"), version: z.literal(1),
  fields: crmFields, since: z.iso.datetime({ offset: true }).nullable(), phase: z.literal("done"),
  deletedPage: z.number().int().min(0).max(500), linkAfterId: id.nullable() }).strict();
const crmRun = z.object({ id, ...crmIdentity, scopeHash: sha256, mappingJson: json,
  fieldsJson: z.union([crmFields, completedCrmMetadata]), status: z.literal("COMPLETE"),
  runKind: z.enum(["FULL", "INCREMENTAL", "RESTORE"]), lastPage: count,
  lastPageHash: sha256.nullable(), listingComplete: z.literal(true), snapshotCount: count,
  mappedCount: count, canonicalCount: count, unassignedCount: count, reviewCount: count,
  startedAt: time, completedAt: time }).strict();
const bill = source.extend({ id, companyId: id, organizationName: text(200).min(1), externalBillId: externalId,
  billNumber: text(500), vendorId: externalId, vendorName: text(500), status: text(100).min(1),
  currencyCode: z.string().regex(/^[A-Z]{3}$/), billDate: time.nullable(), dueDate: time.nullable(),
  subtotal: money.nullable(), taxTotal: money.nullable(), total: money, balance: money,
  paymentMade: money.nullable(), vendorCreditsApplied: money.nullable(), sourceModifiedAt: text(60).nullable(),
  sourceSummary: json, sourceDetail: json, lastImportRunId: id, detailImportRunId: id,
  importedAt: time, lastSeenAt: time, detailFetchedAt: time, isStale: z.boolean() }).strict();
const attachment = source.extend({ id, billId: id, companyId: id, externalDocumentId: externalId,
  sourceMetadata: json, sourceMetadataHash: sha256, fileName: text(200).min(1).regex(/^[^\\/\u0000-\u001f\u007f]+$/),
  mimeType: z.enum(["application/pdf", "image/jpeg", "image/png"]), byteSize: z.number().int().min(8).max(10 * 1024 * 1024),
  sha256, downloadedAt: time, importedAt: time, assetPath: z.string().regex(/^originals\/[a-f0-9]{64}\.(pdf|jpg|png)$/) }).strict();
const snapshot = z.object({ id, ...crmIdentity, externalCrmId: externalId, companyId: id.nullable(),
  booksOrganizationId: externalId.nullable(), jobNumber: text(65_535).nullable(), normalizedJobNumber: text(255).nullable(),
  name: text(65_535).nullable(), customerId: text(100).nullable(), customerName: text(65_535).nullable(),
  currencyCode: text(20).nullable(), amount: money.nullable(), approvedVariations: money.nullable(), stage: text(65_535).nullable(),
  canonicalJobId: id.nullable(), linkStatus: z.enum(["READY", "UNASSIGNED_COMPANY", "INVALID_SOURCE", "DUPLICATE_JOB_NUMBER", "LOCAL_CONFLICT", "SOURCE_CHANGED"]),
  sourceModifiedAt: text(60).nullable(), sourceRecordJson: json, importRunId: id,
  importedAt: time, lastSeenAt: time, isStale: z.boolean() }).strict();
const canonicalJob = z.object({ id, companyId: id, jobNumber: text(80).min(2), name: text(200).min(1),
  customer: text(200).min(1), contractValue: money.nullable(), approvedVariations: money,
  currency: z.enum(["AED", "USD", "EUR", "GBP", "SAR"]), externalCrmId: externalId, isDemo: z.boolean(), createdAt: time }).strict();
const association = source.extend({ id, companyId: id, booksProjectId: externalId, projectName: text(500).min(1),
  zprojectsProjectId: externalId, portalId: externalId, crmOrganizationId: externalId,
  crmDataCenter: source.shape.dataCenter, crmEnvironment: source.shape.environment,
  dealIds: z.array(externalId).max(10_000), sourceProject: json,
  sourceDealsPages: z.array(json).min(1).max(50), sourceCrmRecords: z.array(json).max(10_000),
  sourceHash: sha256, status: z.enum(["VERIFIED", "UNLINKED", "STALE"]), verifiedAt: time,
  validUntil: time, nextRefreshAt: time, lastAttemptAt: time, lastErrorCode: z.string().regex(/^[A-Z0-9_]{1,100}$/).nullable(),
  failures: count, backoffUntil: time.nullable(), importedAt: time, updatedAt: time }).strict();
const credential = z.object({ target: z.enum(["ZOHO", "CRM"]), organizationId: externalId,
  dataCenter: source.shape.dataCenter, connectionFingerprint: sha256, createdAt: time, updatedAt: time }).strict();
export const zohoDataTransferCooldownSchema = source.extend({ target: z.enum(["ZOHO", "CRM"]), notBefore: time }).strict();
export type ZohoDataTransferCooldown = z.infer<typeof zohoDataTransferCooldownSchema>;
export const zohoDataTransferManifestSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal("ZOHO_SOURCE_CACHE"),
  exportedAt: time, companies: z.array(company).min(1).max(20), sourceCredentials: z.array(credential).min(2).max(40),
  booksRuns: z.array(booksRun).min(1).max(100_000), crmRuns: z.array(crmRun).min(1).max(100_000),
  booksBills: z.array(bill).max(100_000), attachments: z.array(attachment).max(200_000),
  crmSnapshots: z.array(snapshot).max(100_000), canonicalJobs: z.array(canonicalJob).max(100_000),
  associations: z.array(association).max(100_000), cooldowns: z.array(zohoDataTransferCooldownSchema).max(40) }).strict();
export type ZohoDataTransferManifest = z.infer<typeof zohoDataTransferManifestSchema>;

export function canonicalTransferJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalTransferJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonicalTransferJson(row[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export function transferJsonHash(value: unknown): string {
  return createHash("sha256").update(canonicalTransferJson(value)).digest("hex");
}
export function transferAssetPath(hash: string, mimeType: string): string {
  const extension = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png" }[mimeType];
  if (!sha256.safeParse(hash).success || !extension) return transferFailure("ASSET_IDENTITY");
  return `originals/${hash}.${extension}`;
}
export function transferSourceKey(value: { organizationId: string; dataCenter: string; environment: string }): string {
  return `${value.organizationId}:${value.dataCenter}:${value.environment}`;
}
function unique<T>(rows: T[], key: (row: T) => string) {
  const ids = rows.map(key);
  if (new Set(ids).size !== ids.length) transferFailure("DUPLICATE_IDENTITY");
}
function sameSource(left: Parameters<typeof transferSourceKey>[0], right: Parameters<typeof transferSourceKey>[0]) {
  return transferSourceKey(left) === transferSourceKey(right);
}
const crmSource = (row: { crmOrganizationId: string; dataCenter: string; environment: string }) =>
  ({ organizationId: row.crmOrganizationId, dataCenter: row.dataCenter, environment: row.environment });

/** Reject unknown tables/fields, incomplete snapshots and broken tenant/provider relationships before any I/O. */
export function parseZohoDataTransferManifest(value: unknown): ZohoDataTransferManifest {
  let data: ZohoDataTransferManifest;
  try {
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_TRANSFER_MANIFEST_BYTES) return transferFailure("MANIFEST_SIZE");
    data = zohoDataTransferManifestSchema.parse(value);
  } catch { return transferFailure("MANIFEST_SCHEMA"); }
  const byCompany = new Map(data.companies.map((row) => [row.id, row]));
  const byBill = new Map(data.booksBills.map((row) => [row.id, row]));
  const byJob = new Map(data.canonicalJobs.map((row) => [row.id, row]));
  const byBooksRun = new Map(data.booksRuns.map((row) => [row.id, row]));
  const byCrmRun = new Map(data.crmRuns.map((row) => [row.id, row]));
  const latestObservation = new Date(data.exportedAt).valueOf() + 300_000;
  const observed = (...times: (string | null)[]) => {
    if (times.some((value) => value !== null && new Date(value).valueOf() > latestObservation)) transferFailure("SOURCE_TIME_INVALID");
  };
  for (const rows of [data.companies, data.booksBills, data.attachments, data.crmSnapshots, data.canonicalJobs,
    data.associations, data.booksRuns, data.crmRuns]) unique(rows as { id: string }[], (row) => row.id);
  unique(data.companies, (row) => transferSourceKey(row.books));
  unique(data.booksBills, (row) => `${transferSourceKey(row)}:${row.externalBillId}`);
  unique(data.attachments, (row) => `${row.billId}:${row.externalDocumentId}`);
  unique(data.crmSnapshots, (row) => `${transferSourceKey(crmSource(row))}:${row.sourceModule}:${row.externalCrmId}`);
  unique(data.canonicalJobs, (row) => `${row.companyId}:${row.externalCrmId}`);
  unique(data.canonicalJobs, (row) => `${row.companyId}:${row.jobNumber.normalize("NFKC").trim().toUpperCase()}`);
  unique(data.associations, (row) => `${transferSourceKey(row)}:${row.booksProjectId}`);
  unique(data.sourceCredentials, (row) => `${row.target}:${row.organizationId}:${row.dataCenter}`);
  unique(data.cooldowns, (row) => `${row.target}:${transferSourceKey(row)}`);
  const knownSource = (target: "ZOHO" | "CRM", row: Parameters<typeof transferSourceKey>[0]) =>
    data.companies.some((entry) => sameSource(entry[target === "ZOHO" ? "books" : "crm"], row));
  for (const entry of data.companies) {
    observed(entry.createdAt, entry.books.createdAt, entry.crm.createdAt);
    for (const [target, binding] of [["ZOHO", entry.books], ["CRM", entry.crm]] as const) {
      if (!data.sourceCredentials.some((row) => row.target === target && row.organizationId === binding.organizationId && row.dataCenter === binding.dataCenter))
        transferFailure("SOURCE_CREDENTIAL_PROVENANCE");
    }
    if (!data.booksRuns.some((row) => row.companyId === entry.id && sameSource(row, entry.books) && row.runKind === "FULL") ||
      !data.crmRuns.some((row) => sameSource(crmSource(row), entry.crm) && row.runKind === "FULL")) transferFailure("FULL_SOURCE_BASELINE");
  }
  for (const row of data.sourceCredentials) {
    observed(row.createdAt, row.updatedAt);
    if (!knownSource(row.target, { ...row, environment: "production" })) transferFailure("UNBOUND_SOURCE");
  }
  for (const row of data.cooldowns) if (!knownSource(row.target, row) || row.notBefore <= data.exportedAt) transferFailure("SOURCE_COOLDOWN");
  for (const row of data.booksRuns) {
    observed(row.startedAt, row.completedAt);
    const owner = byCompany.get(row.companyId);
    if (!owner || !sameSource(owner.books, row) || row.detailCount !== row.listedCount || row.completedAt < row.startedAt)
      transferFailure("BOOKS_RUN_PROVENANCE");
  }
  for (const row of data.crmRuns) {
    observed(row.startedAt, row.completedAt);
    if (!knownSource("CRM", crmSource(row)) || row.canonicalCount + row.unassignedCount + row.reviewCount !== row.snapshotCount ||
      row.mappedCount !== row.snapshotCount - row.unassignedCount || row.completedAt < row.startedAt) transferFailure("CRM_RUN_PROVENANCE");
  }
  for (const row of data.booksBills) {
    observed(row.importedAt, row.lastSeenAt, row.detailFetchedAt);
    const owner = byCompany.get(row.companyId), run = byBooksRun.get(row.lastImportRunId);
    if (!owner || !sameSource(owner.books, row) || !run || run.companyId !== row.companyId || !sameSource(run, row) ||
      row.detailImportRunId !== row.lastImportRunId || row.sourceSummary.bill_id !== row.externalBillId ||
      row.sourceDetail.bill_id !== row.externalBillId || !Array.isArray(row.sourceDetail.line_items)) transferFailure("BOOKS_SOURCE_IDENTITY");
  }
  for (const row of data.attachments) {
    observed(row.downloadedAt, row.importedAt);
    const owner = byBill.get(row.billId);
    if (!owner || owner.companyId !== row.companyId || !sameSource(owner, row) ||
      row.assetPath !== transferAssetPath(row.sha256, row.mimeType) || row.sourceMetadata.document_id !== row.externalDocumentId ||
      transferJsonHash(row.sourceMetadata) !== row.sourceMetadataHash) transferFailure("ATTACHMENT_IDENTITY");
    const documents = Array.isArray(owner.sourceDetail.documents) ? owner.sourceDetail.documents : [];
    const matches = documents.filter((item) => item && typeof item === "object" && !Array.isArray(item) && item.document_id === row.externalDocumentId);
    if (matches.length !== 1 || transferJsonHash(matches[0]) !== row.sourceMetadataHash) transferFailure("ATTACHMENT_SOURCE_METADATA");
  }
  const attachmentsByBill = new Map<string, Set<string>>();
  for (const row of data.attachments) {
    const ids = attachmentsByBill.get(row.billId) ?? new Set<string>();
    ids.add(row.externalDocumentId); attachmentsByBill.set(row.billId, ids);
  }
  for (const row of data.booksBills) {
    const documents = row.sourceDetail.documents;
    if (documents !== undefined && !Array.isArray(documents)) transferFailure("ORIGINALS_INCOMPLETE");
    for (const document of Array.isArray(documents) ? documents : []) {
      if (!document || typeof document !== "object" || Array.isArray(document) ||
        typeof document.document_id !== "string" || !attachmentsByBill.get(row.id)?.has(document.document_id)) transferFailure("ORIGINALS_INCOMPLETE");
    }
  }
  const linkedJobs = new Set<string>();
  for (const row of data.crmSnapshots) {
    observed(row.importedAt, row.lastSeenAt);
    const run = byCrmRun.get(row.importRunId), owner = row.companyId ? byCompany.get(row.companyId) : undefined;
    if (!run || !sameSource(crmSource(run), crmSource(row)) || run.sourceModule !== row.sourceModule ||
      row.sourceRecordJson.id !== row.externalCrmId || (row.companyId && (!owner || !sameSource(owner.crm, crmSource(row)) || owner.books.organizationId !== row.booksOrganizationId)))
      transferFailure("CRM_SOURCE_IDENTITY");
    if (row.linkStatus === "UNASSIGNED_COMPANY" && (row.companyId !== null || row.canonicalJobId !== null)) transferFailure("CRM_UNASSIGNED_IDENTITY");
    if (row.linkStatus === "READY" && (!row.companyId || !row.canonicalJobId)) transferFailure("CRM_CANONICAL_IDENTITY");
    if (row.canonicalJobId) {
      const job = byJob.get(row.canonicalJobId);
      if (!job || job.companyId !== row.companyId || job.externalCrmId !== row.externalCrmId || linkedJobs.has(job.id)) transferFailure("CRM_CANONICAL_IDENTITY");
      linkedJobs.add(job.id);
    }
  }
  for (const row of data.canonicalJobs) observed(row.createdAt);
  if (linkedJobs.size !== data.canonicalJobs.length) transferFailure("UNREFERENCED_CANONICAL_JOB");
  const references = new Set(data.crmSnapshots.map((row) => `${transferSourceKey(crmSource(row))}:${row.sourceModule}:${row.externalCrmId}`));
  for (const row of data.associations) {
    observed(row.verifiedAt, row.lastAttemptAt, row.importedAt, row.updatedAt);
    const owner = byCompany.get(row.companyId);
    const crm = { organizationId: row.crmOrganizationId, dataCenter: row.crmDataCenter, environment: row.crmEnvironment };
    const proof = { booksSource: { organizationId: row.organizationId, dataCenter: row.dataCenter, environment: row.environment },
      crmSource: crm, portalId: row.portalId, sourceProject: row.sourceProject, sourceDealsPages: row.sourceDealsPages, sourceCrmRecords: row.sourceCrmRecords };
    if (!owner || !sameSource(owner.books, row) || !sameSource(owner.crm, crm) || transferJsonHash(proof) !== row.sourceHash ||
      row.sourceProject.project_id !== row.booksProjectId || row.sourceProject.zprojects_project_id !== row.zprojectsProjectId ||
      row.validUntil <= row.verifiedAt || new Date(row.validUntil).valueOf() - new Date(row.verifiedAt).valueOf() > 86_400_000 ||
      row.dealIds.some((deal) => !references.has(`${transferSourceKey(crm)}:Deals:${deal}`))) transferFailure("PROJECT_SOURCE_PROOF");
  }
  return data;
}
export function serializeZohoDataTransferManifest(value: ZohoDataTransferManifest): string {
  return `${canonicalTransferJson(value)}\n`;
}
export function zohoDataTransferManifestHash(value: ZohoDataTransferManifest): string {
  return createHash("sha256").update(serializeZohoDataTransferManifest(value)).digest("hex");
}
