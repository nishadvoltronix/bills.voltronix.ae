import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { verifyPassword } from "@/lib/password";
import { getBooksOrganizations, getConfig, productionBooksRuntimeReady } from "@/lib/integrations/config";
import { connectionFingerprint } from "@/lib/integrations/connection-fingerprint";
import { mapCrmJob } from "@/lib/integrations/crm";
import { booksSnapshotFields, parseBooksBillDetail } from "./books-import";
import { getBooksAttachmentSourceMetadata } from "./books-attachments";
import { crmJobImportFields, projectCrmJobSource } from "./crm-job-import";
import { parseBooksProjectAssociation } from "./books-project-history";
import { incomingSources } from "./incoming-sync-access";
import { deletePrivateDocument, detectDocumentType, storePrivateDocument, type PrivateDocumentMetadata } from "./documents";
import { canonicalTransferJson, MAX_TRANSFER_MANIFEST_BYTES, parseZohoDataTransferManifest,
  transferFailure, transferSourceKey, zohoDataTransferManifestHash, type ZohoDataTransferManifest } from "./zoho-data-transfer-format";

type Store = Prisma.TransactionClient;
const inputSchema = z.object({ directory: z.string().min(1), manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  reference: z.string().trim().min(10).max(160).regex(/^[^\u0000-\u001f\u007f]+$/) }).strict();
export type ZohoDataRestoreInput = z.infer<typeof inputSchema>;
const targetCompanyId = (company: ZohoDataTransferManifest["companies"][number]) =>
  `company-books-${company.books.dataCenter.toLowerCase()}-${company.books.organizationId}`;
const same = (left: unknown, right: unknown) => canonicalTransferJson(left) === canonicalTransferJson(right);
const asJson = (value: unknown) => value as Prisma.InputJsonValue;
const date = (value: string | null) => value === null ? null : new Date(value);
const samePath = (left: string, right: string) => process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;

/** Only the public operator wrapper may run against an operational database. */
export function assertZohoDataRestoreEnvironment(env: NodeJS.ProcessEnv = process.env) {
  if (env.ALLOW_ZOHO_DATA_RESTORE !== "true" || !productionBooksRuntimeReady(env) ||
    env.DATABASE_TLS_MODE !== "verify-full" || env.NODE_TLS_REJECT_UNAUTHORIZED === "0" ||
    ["INTEGRATION_NETWORK_ENABLED", "ZOHO_BOOKS_NETWORK_ENABLED", "ZOHO_CRM_NETWORK_ENABLED",
      "ZOHO_BOOKS_WRITE_ENABLED", "ZOHO_BOOKS_LIVE_ENABLED", "ALLOW_PRODUCTION_ACCOUNTING_WRITES",
      "INCOMING_SYNC_ENABLED"].some(key => env[key] !== "false")) transferFailure("OFFLINE_RESTORE_ENVIRONMENT");
}

async function privateDirectory(directory: string) {
  if (!path.isAbsolute(directory)) transferFailure("BUNDLE_DIRECTORY");
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) transferFailure("BUNDLE_DIRECTORY");
  const resolved = await realpath(directory);
  if (!samePath(path.resolve(resolved), path.resolve(directory))) transferFailure("BUNDLE_DIRECTORY");
  return resolved;
}
async function boundedFile(directory: string, relative: string, maximum: number) {
  const file = path.resolve(directory, relative);
  if (!file.startsWith(`${directory}${path.sep}`)) transferFailure("BUNDLE_FILE_PATH");
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maximum ||
    !samePath(await realpath(file), file)) transferFailure("BUNDLE_FILE_PATH");
  const bytes = await readFile(file);
  if (bytes.length !== stat.size || bytes.length > maximum) transferFailure("BUNDLE_FILE_CHANGED");
  return bytes;
}

/** Recompute values from provider evidence instead of trusting exported convenience columns. */
export function validateZohoRestoreEvidence(manifest: ZohoDataTransferManifest) {
  const crm = getConfig("CRM");
  if (!crm.crmMapping?.verified) return transferFailure("CRM_MAPPING_REQUIRED");
  const mapping = crm.crmMapping;
  const configuredDelays = new Map<string, Date>();
  if (process.env.INCOMING_SYNC_NOT_BEFORE_JSON) {
    let values: Record<string, string>;
    try { values = z.record(z.string(), z.iso.datetime({ offset: true })).parse(JSON.parse(process.env.INCOMING_SYNC_NOT_BEFORE_JSON)); }
    catch { return transferFailure("TARGET_COOLDOWN_CONFIGURATION"); }
    const known = new Set(manifest.sourceCredentials.map(source => `${source.target}:${source.organizationId}`));
    for (const [key, value] of Object.entries(values)) {
      if (!known.has(key)) transferFailure("TARGET_COOLDOWN_CONFIGURATION");
      configuredDelays.set(key, new Date(value));
    }
  }
  const sourceAssignments = manifest.companies.map(company => ({ companyId: company.id, booksOrganizationId: company.books.organizationId }));
  const companyMap = new Map(manifest.companies.map(company => [company.id, targetCompanyId(company)]));
  const jobs = new Map(manifest.canonicalJobs.map(job => [job.id, job]));
  const books = new Map(manifest.booksBills.map(bill => [bill.id, bill]));
  for (const credential of manifest.sourceCredentials) {
    const config = getConfig(credential.target, process.env, credential.organizationId);
    if (config.organizationId !== credential.organizationId || config.environment !== "production" || config.dataCenter !== credential.dataCenter ||
      connectionFingerprint(config) !== credential.connectionFingerprint) transferFailure("SOURCE_CONNECTION_CHANGED");
  }
  for (const run of manifest.crmRuns) if (!same(run.mappingJson, mapping) || run.sourceModule !== mapping.jobModule)
    transferFailure("CRM_MAPPING_CHANGED");
  for (const bill of manifest.booksBills) {
    booksSnapshotFields(bill.sourceSummary, false);
    const detail = parseBooksBillDetail({ code: 0, bill: bill.sourceDetail }, bill.externalBillId);
    const projected = booksSnapshotFields(detail, true);
    for (const [key, expected] of Object.entries(projected)) {
      const actual = bill[key as keyof typeof bill];
      if (expected instanceof Date ? expected.toISOString() !== actual : expected !== actual) transferFailure("BOOKS_VALUES_CHANGED");
    }
  }
  for (const attachment of manifest.attachments) {
    const bill = books.get(attachment.billId)!;
    const expected = getBooksAttachmentSourceMetadata(bill, attachment.externalDocumentId);
    if (expected.sourceMetadataHash !== attachment.sourceMetadataHash || expected.byteSize !== attachment.byteSize ||
      expected.mimeType !== attachment.mimeType) transferFailure("ORIGINAL_METADATA_CHANGED");
  }
  const uniqueJobs = new Map<string, number>();
  for (const row of manifest.crmSnapshots) if (!row.isStale && row.companyId && row.normalizedJobNumber) {
    const key = `${row.companyId}:${row.normalizedJobNumber}`;
    uniqueJobs.set(key, (uniqueJobs.get(key) ?? 0) + 1);
  }
  const restoredJobs: Prisma.JobCreateManyInput[] = [];
  const jobMap = new Map<string, string>();
  for (const snapshot of manifest.crmSnapshots) {
    if (crmJobImportFields(mapping).some(field => !Object.hasOwn(snapshot.sourceRecordJson, field))) transferFailure("CRM_FIELDS_INCOMPLETE");
    const projected = projectCrmJobSource(snapshot.sourceRecordJson, mapping, sourceAssignments);
    for (const [key, expected] of Object.entries(projected)) if (key !== "linkStatus" && snapshot[key as keyof typeof snapshot] !== expected)
      transferFailure("CRM_PROJECTION_CHANGED");
    if (!snapshot.canonicalJobId) continue;
    const original = jobs.get(snapshot.canonicalJobId)!;
    if (snapshot.isStale || snapshot.linkStatus !== "READY" || projected.linkStatus !== "PENDING" ||
      !snapshot.companyId || uniqueJobs.get(`${snapshot.companyId}:${snapshot.normalizedJobNumber}`) !== 1)
      return transferFailure("CRM_CANONICAL_REVIEW_REQUIRED");
    const mapped = mapCrmJob(snapshot.sourceRecordJson, mapping);
    for (const [key, expected] of Object.entries(mapped)) if (original[key as keyof typeof original] !== expected)
      transferFailure("CRM_CANONICAL_VALUES_CHANGED");
    const id = randomUUID();
    jobMap.set(original.id, id);
    restoredJobs.push({ id, ...mapped, companyId: companyMap.get(snapshot.companyId)!, isDemo: false,
      createdAt: new Date(original.createdAt) });
  }
  for (const association of manifest.associations) {
    const parsed = parseBooksProjectAssociation({ companyId: association.companyId,
      booksSource: { organizationId: association.organizationId, dataCenter: association.dataCenter, environment: association.environment },
      crmSource: { organizationId: association.crmOrganizationId, dataCenter: association.crmDataCenter, environment: association.crmEnvironment },
      portalId: association.portalId, sourceProject: association.sourceProject, sourceDealsPages: association.sourceDealsPages,
      sourceCrmRecords: association.sourceCrmRecords, verifiedAt: association.verifiedAt });
    if (parsed.sourceHash !== association.sourceHash || !same(parsed.dealIds, association.dealIds) ||
      parsed.projectName !== association.projectName || new Date(association.validUntil) > parsed.validUntil)
      transferFailure("PROJECT_PROOF_CHANGED");
  }
  return { companyMap, jobMap, restoredJobs, mapping, configuredDelays };
}

async function requireFreshTarget(tx: Store) {
  const counts = await Promise.all([tx.booksImportRun.count(), tx.booksBill.count(), tx.booksBillAttachment.count(),
    tx.crmImportRun.count(), tx.crmJobSnapshot.count(), tx.booksProjectAssociation.count(), tx.incomingSyncState.count(),
    tx.job.count(), tx.vendor.count(), tx.bill.count(), tx.billLine.count(), tx.document.count(), tx.payment.count(),
    tx.integrationJob.count(), tx.syncRecord.count(), tx.liveSyncAuthorization.count(), tx.ocrBatch.count(), tx.ocrDocument.count(), tx.scannerSource.count()]);
  if (counts.some(count => count !== 0)) transferFailure("TARGET_NOT_EMPTY");
}
async function checkTarget(tx: Store, actor: Actor, manifest: ZohoDataTransferManifest, passwordHash: string) {
  const operator = await tx.user.findUnique({ where: { id: actor.id } });
  if (!operator?.active || operator.role !== "ADMIN" || operator.passwordHash !== passwordHash) transferFailure("OPERATOR_CHANGED");
  const companies = await tx.company.findMany({ include: { integrationDestinations: true, crmSource: true,
    memberships: { where: { userId: actor.id, active: true } } } });
  if (companies.length !== manifest.companies.length) transferFailure("TARGET_COMPANIES_CHANGED");
  const profiles = getBooksOrganizations();
  for (const source of manifest.companies) {
    const company = companies.find(row => row.id === targetCompanyId(source));
    const profile = profiles.find(row => row.organizationId === source.books.organizationId);
    const destination = company?.integrationDestinations[0];
    if (!company?.active || company.isDemo || company.liveAccountingEnabled || !company.memberships.length ||
      !profile || company.name !== profile.name || /\[(DEMO|CONNECTION CHECK)\]/i.test(company.name) || company.integrationDestinations.length !== 1 ||
      !destination || destination.target !== "ZOHO" || destination.liveEnabled || destination.verifiedAt ||
      destination.verifiedConfigurationHash || destination.verificationReference || transferSourceKey(destination) !== transferSourceKey(source.books) ||
      !company.crmSource || transferSourceKey(company.crmSource) !== transferSourceKey(source.crm)) transferFailure("TARGET_BINDING_MISMATCH");
  }
  await requireFreshTarget(tx);
}
function latestCooldown(manifest: ZohoDataTransferManifest, target: "ZOHO" | "CRM", source: Parameters<typeof transferSourceKey>[0], now: Date, configured: Map<string, Date>) {
  const row = manifest.cooldowns.find(value => value.target === target && transferSourceKey(value) === transferSourceKey(source));
  const dates = [row ? new Date(row.notBefore) : null, configured.get(`${target}:${source.organizationId}`)]
    .filter((value): value is Date => value instanceof Date && value > now).sort((left, right) => right.valueOf() - left.valueOf());
  return dates[0] ?? null;
}
async function batches<T>(values: T[], write: (rows: T[]) => Promise<unknown>) {
  for (let index = 0; index < values.length; index += 250) await write(values.slice(index, index + 250));
}
async function loadReviewedTransfer(input: Pick<ZohoDataRestoreInput, "directory" | "manifestSha256">) {
  const directory = await privateDirectory(input.directory);
  const bytes = await boundedFile(directory, "manifest.json", MAX_TRANSFER_MANIFEST_BYTES);
  if (createHash("sha256").update(bytes).digest("hex") !== input.manifestSha256) transferFailure("MANIFEST_DIGEST");
  let decoded: unknown;
  try { decoded = JSON.parse(bytes.toString("utf8")); } catch { transferFailure("MANIFEST_JSON"); }
  const manifest = parseZohoDataTransferManifest(decoded);
  if (zohoDataTransferManifestHash(manifest) !== input.manifestSha256 ||
    new Date(manifest.exportedAt).valueOf() > Date.now() + 60_000) transferFailure("MANIFEST_DIGEST");
  if (manifest.attachments.length) await privateDirectory(path.join(directory, "originals"));
  return { directory, manifest };
}
async function checkedOriginal(directory: string, attachment: ZohoDataTransferManifest["attachments"][number]) {
  const original = await boundedFile(directory, attachment.assetPath, 10 * 1024 * 1024);
  if (original.length !== attachment.byteSize || createHash("sha256").update(original).digest("hex") !== attachment.sha256 ||
    detectDocumentType(original).mimeType !== attachment.mimeType) transferFailure("ORIGINAL_INTEGRITY");
  return original;
}
/** Offline bundle inspection: no database access, no provider access, and no staged storage writes. */
export async function checkZohoDataTransfer(rawInput: unknown) {
  const input = inputSchema.omit({ reference: true }).parse(rawInput);
  const { directory, manifest } = await loadReviewedTransfer(input);
  const evidence = validateZohoRestoreEvidence(manifest);
  for (const attachment of manifest.attachments) await checkedOriginal(directory, attachment);
  return { status: "SOURCE_CACHE_VERIFIED" as const, manifestSha256: input.manifestSha256,
    counts: { companies: manifest.companies.length, booksBills: manifest.booksBills.length, originals: manifest.attachments.length,
      crmSnapshots: manifest.crmSnapshots.length, jobs: evidence.restoredJobs.length, associations: manifest.associations.length },
    providerRequests: 0, providerFinancialWrites: 0, targetReadinessVerified: false };
}

/** Injectable database boundary for a separately provisioned disposable rehearsal. The CLI uses the guarded wrapper below. */
export async function restoreZohoDataTransferWithStore(actor: Actor, rawInput: unknown, store: PrismaClient,
  options: { password?: string; runtimeGuard?: () => void } = {}) {
  const input = inputSchema.parse(rawInput);
  options.runtimeGuard?.();
  const operator = await store.user.findUnique({ where: { id: actor.id } });
  if (actor.role !== "ADMIN" || !operator?.active || operator.role !== "ADMIN" ||
    !await verifyPassword(options.password ?? process.env.ACCOUNT_OPERATOR_PASSWORD ?? "", operator.passwordHash)) return transferFailure("OPERATOR_REAUTHENTICATION");
  const { directory, manifest } = await loadReviewedTransfer(input);
  const evidence = validateZohoRestoreEvidence(manifest);
  // Fail closed before staging originals, and repeat under transaction locks before committing.
  await checkTarget(store, actor, manifest, operator.passwordHash);
  const staged = new Map<string, PrivateDocumentMetadata>();
  let committed = false, callbackCompleted = false;
  try {
    for (const attachment of manifest.attachments) {
      const original = await checkedOriginal(directory, attachment);
      const stored = await storePrivateDocument(new File([new Uint8Array(original)], attachment.fileName, { type: attachment.mimeType }));
      staged.set(attachment.id, stored);
      if (stored.sha256 !== attachment.sha256 || stored.byteSize !== attachment.byteSize) transferFailure("STAGED_ORIGINAL_INTEGRITY");
    }
    const receipt = await store.$transaction(async tx => {
      options.runtimeGuard?.();
      await tx.$queryRaw(Prisma.sql`SELECT id FROM User WHERE id=${actor.id} FOR UPDATE`);
      await tx.$queryRaw(Prisma.sql`SELECT id FROM Company ORDER BY id FOR UPDATE`);
      await checkTarget(tx, actor, manifest, operator.passwordHash);
      // Runtime configuration and all source mappings are checked again after file staging.
      const current = validateZohoRestoreEvidence(manifest);
      if (!same([...current.companyMap], [...evidence.companyMap])) transferFailure("TARGET_BINDING_MISMATCH");
      const now = new Date();
      const booksRuns = new Map<string, string>();
      for (const company of manifest.companies) {
        const companyId = evidence.companyMap.get(company.id)!;
        const count = manifest.booksBills.filter(bill => bill.companyId === company.id).length;
        const run = await tx.booksImportRun.create({ data: { companyId, organizationId: company.books.organizationId,
          dataCenter: company.books.dataCenter, environment: company.books.environment,
          organizationName: getBooksOrganizations().find(profile => profile.organizationId === company.books.organizationId)!.name,
          initiatedById: actor.id, runKind: "RESTORE", status: "COMPLETE", listingComplete: true,
          listedCount: count, detailCount: count, startedAt: now, completedAt: now } });
        booksRuns.set(company.id, run.id);
      }
      const bills: Prisma.BooksBillCreateManyInput[] = manifest.booksBills.map(row => ({ ...row,
        companyId: evidence.companyMap.get(row.companyId)!, lastImportRunId: booksRuns.get(row.companyId)!, detailImportRunId: booksRuns.get(row.companyId)!,
        billDate: date(row.billDate), dueDate: date(row.dueDate), importedAt: new Date(row.importedAt), lastSeenAt: new Date(row.lastSeenAt),
        detailFetchedAt: new Date(row.detailFetchedAt), sourceSummary: asJson(row.sourceSummary), sourceDetail: asJson(row.sourceDetail) }));
      await batches(bills, rows => tx.booksBill.createMany({ data: rows }));
      const attachments: Prisma.BooksBillAttachmentCreateManyInput[] = manifest.attachments.map(({ assetPath, ...row }) => {
        void assetPath;
        return { ...row, companyId: evidence.companyMap.get(row.companyId)!, storageKey: staged.get(row.id)!.storageKey,
          sourceMetadata: asJson(row.sourceMetadata), downloadedAt: new Date(row.downloadedAt), importedAt: new Date(row.importedAt) };
      });
      await batches(attachments, rows => tx.booksBillAttachment.createMany({ data: rows }));
      await batches(evidence.restoredJobs, rows => tx.job.createMany({ data: rows }));
      const sources = await incomingSources(actor, tx);
      if (sources.some(source => source.configurationError) || sources.length !== manifest.companies.length + 1) transferFailure("TARGET_SOURCE_SCOPE");
      const crm = sources.find(source => source.target === "CRM")!;
      const unassigned = manifest.crmSnapshots.filter(row => row.companyId === null).length;
      const crmRun = await tx.crmImportRun.create({ data: { crmOrganizationId: crm.organizationId, dataCenter: crm.dataCenter,
        environment: crm.environment, sourceModule: evidence.mapping.jobModule, initiatedById: actor.id, scopeHash: crm.scopeHash,
        mappingJson: asJson(evidence.mapping), fieldsJson: crmJobImportFields(evidence.mapping), runKind: "RESTORE", status: "COMPLETE",
        listingComplete: true, snapshotCount: manifest.crmSnapshots.length, mappedCount: manifest.crmSnapshots.length - unassigned,
        canonicalCount: evidence.restoredJobs.length, unassignedCount: unassigned,
        reviewCount: manifest.crmSnapshots.length - unassigned - evidence.restoredJobs.length, startedAt: now, completedAt: now } });
      const snapshots: Prisma.CrmJobSnapshotCreateManyInput[] = manifest.crmSnapshots.map(row => ({ ...row,
        companyId: row.companyId ? evidence.companyMap.get(row.companyId)! : null,
        canonicalJobId: row.canonicalJobId ? evidence.jobMap.get(row.canonicalJobId)! : null,
        importRunId: crmRun.id, sourceRecordJson: asJson(row.sourceRecordJson), importedAt: new Date(row.importedAt), lastSeenAt: new Date(row.lastSeenAt) }));
      await batches(snapshots, rows => tx.crmJobSnapshot.createMany({ data: rows }));
      const associations: Prisma.BooksProjectAssociationCreateManyInput[] = manifest.associations.map(row => {
        const holds = [date(row.backoffUntil), latestCooldown(manifest, "ZOHO", row, now, current.configuredDelays), latestCooldown(manifest, "CRM",
          { organizationId: row.crmOrganizationId, dataCenter: row.crmDataCenter, environment: row.crmEnvironment }, now, current.configuredDelays)]
          .filter((value): value is Date => value !== null && value > now).sort((left, right) => right.valueOf() - left.valueOf());
        return { ...row, companyId: evidence.companyMap.get(row.companyId)!, dealIds: asJson(row.dealIds),
          sourceProject: asJson(row.sourceProject), sourceDealsPages: asJson(row.sourceDealsPages), sourceCrmRecords: asJson(row.sourceCrmRecords),
          status: "STALE", verifiedAt: new Date(row.verifiedAt), validUntil: new Date(row.validUntil), nextRefreshAt: now,
          lastAttemptAt: new Date(row.lastAttemptAt), backoffUntil: holds[0] ?? null, leaseToken: null, leaseExpiresAt: null,
          importedAt: new Date(row.importedAt), updatedAt: now };
      });
      await batches(associations, rows => tx.booksProjectAssociation.createMany({ data: rows }));
      for (const source of sources) {
        const hold = latestCooldown(manifest, source.target, source, now, current.configuredDelays);
        await tx.incomingSyncState.create({ data: { target: source.target, organizationId: source.organizationId,
          dataCenter: source.dataCenter, environment: source.environment, companyId: source.companyId, scopeHash: source.scopeHash,
          status: hold ? "WAITING_QUOTA" : "PENDING", backoffUntil: hold, nextRunAt: hold ?? now,
          lastErrorCode: hold ? "INCOMING_KNOWN_COOLDOWN" : null } });
      }
      const counts = { companies: manifest.companies.length, booksBills: bills.length, originals: attachments.length,
        crmSnapshots: snapshots.length, jobs: evidence.restoredJobs.length, associations: associations.length };
      await tx.auditLog.create({ data: { actorId: actor.id, action: "ZOHO_SOURCE_CACHE_RESTORED", entityType: "ZohoDataTransfer",
        entityId: input.manifestSha256, details: { manifestSha256: input.manifestSha256, reference: input.reference, exportedAt: manifest.exportedAt,
          counts, companyAssignments: [...evidence.companyMap].map(([sourceCompanyId, companyId]) => ({ sourceCompanyId, companyId })),
          sourceBooksRunIds: manifest.booksRuns.map(run => run.id), sourceCrmRunIds: manifest.crmRuns.map(run => run.id),
          providerRequests: 0, providerFinancialWrites: 0, hostedFreshnessEstablished: false } } });
      callbackCompleted = true;
      return { status: "RESTORED_PENDING_PROVIDER_CHECK" as const, manifestSha256: input.manifestSha256, counts,
        providerRequests: 0, providerFinancialWrites: 0, financialWritesEnabled: false };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 120_000, maxWait: 30_000 });
    committed = true;
    return receipt;
  } catch (error) {
    // A dropped COMMIT acknowledgement is ambiguous. Its rows may already be durable;
    // retaining staged originals is necessary until the digest audit receipt is checked.
    if (callbackCompleted && !committed) transferFailure("COMMIT_UNCONFIRMED");
    throw error;
  } finally {
    if (!committed && !callbackCompleted) {
      const cleanup = await Promise.allSettled([...staged.values()].map(file => deletePrivateDocument(file.storageKey)));
      if (cleanup.some(result => result.status === "rejected")) transferFailure("UNCOMMITTED_ORIGINAL_CLEANUP_REQUIRED");
    }
  }
}

export async function restoreZohoDataTransfer(actor: Actor, input: unknown) {
  assertZohoDataRestoreEnvironment();
  return restoreZohoDataTransferWithStore(actor, input, db, { runtimeGuard: assertZohoDataRestoreEnvironment });
}
