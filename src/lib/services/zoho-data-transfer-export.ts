import "server-only";
import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { Prisma } from "@prisma/client";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { crmMappingSchema, getConfig } from "@/lib/integrations/config";
import { connectionFingerprint } from "@/lib/integrations/connection-fingerprint";
import { mapCrmJob, VERIFIED_CRM_JOB_MAPPING } from "@/lib/integrations/crm";
import { booksSnapshotFields, parseBooksBillDetail } from "./books-import";
import { getBooksAttachmentSourceMetadata } from "./books-attachments";
import { parseBooksProjectAssociation } from "./books-project-history";
import { crmJobImportFields, projectCrmJobSource } from "./crm-job-import";
import { detectDocumentType, readPrivateDocument } from "./documents";
import { canonicalTransferJson, parseZohoDataTransferManifest, serializeZohoDataTransferManifest,
  transferAssetPath, transferFailure, transferSourceKey, ZohoDataTransferError, zohoDataTransferCooldownSchema,
  zohoDataTransferManifestHash, type ZohoDataTransferCooldown, type ZohoDataTransferManifest } from "./zoho-data-transfer-format";

type ExportInput = { directory: string; companyIds: string[]; additionalCooldowns?: ZohoDataTransferCooldown[] };
type SourceIdentity = { target: "ZOHO" | "CRM"; organizationId: string; dataCenter: string; environment: string };
const asJson = <T>(value: T): unknown => JSON.parse(JSON.stringify(value));
const sourceKey = (row: SourceIdentity) => `${row.target}:${transferSourceKey(row)}`;

function assertSourceEnvironment() {
  let database: URL, application: URL;
  try { database = new URL(process.env.DATABASE_URL ?? ""); application = new URL(process.env.APP_URL ?? ""); }
  catch { return transferFailure("LOCAL_SOURCE_REQUIRED"); }
  if (process.env.ALLOW_ZOHO_DATA_EXPORT !== "true" || process.env.APP_ENV !== "development" ||
    process.env.NODE_ENV === "production" || process.env.INTEGRATION_TEST_MODE !== "false" ||
    process.env.INTEGRATION_FIXTURE_URL || database.protocol !== "mysql:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(database.hostname) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(application.hostname) ||
    !/^\/[a-zA-Z0-9_]+_dev$/.test(database.pathname) ||
    ["ZOHO_BOOKS_WRITE_ENABLED", "ZOHO_BOOKS_LIVE_ENABLED", "ALLOW_PRODUCTION_ACCOUNTING_WRITES"].some((key) => process.env[key] !== "false"))
    transferFailure("LOCAL_SOURCE_REQUIRED");
}

/** Pure semantic checks are repeated by the receiving service before it makes any changes. */
export function validateZohoTransferSourceRows(manifest: ZohoDataTransferManifest): void {
  try {
    const runs = new Map(manifest.crmRuns.map((run) => [run.id, run]));
    const jobs = new Map(manifest.canonicalJobs.map((job) => [job.id, job]));
    const bills = new Map(manifest.booksBills.map((bill) => [bill.id, bill]));
    const assignments = manifest.companies.map((company) => ({ companyId: company.id, booksOrganizationId: company.books.organizationId }));
    const normalizedCounts = new Map<string, number>();
    for (const row of manifest.crmSnapshots) if (!row.isStale && row.companyId && row.normalizedJobNumber) {
      const key = `${row.companyId}:${row.normalizedJobNumber}`;
      normalizedCounts.set(key, (normalizedCounts.get(key) ?? 0) + 1);
    }
    for (const bill of manifest.booksBills) {
      const detail = parseBooksBillDetail({ code: 0, bill: bill.sourceDetail }, bill.externalBillId);
      booksSnapshotFields(bill.sourceSummary, false);
      const fields = booksSnapshotFields(detail, true);
      for (const [key, value] of Object.entries(fields)) {
        const saved = bill[key as keyof typeof bill];
        if ((value instanceof Date ? value.toISOString() : value) !== saved) transferFailure("BOOKS_PROJECTION_CHANGED");
      }
      for (const raw of [bill.sourceSummary, bill.sourceDetail]) if (raw.organization_id !== undefined && raw.organization_id !== bill.organizationId)
        transferFailure("BOOKS_ORGANIZATION_CHANGED");
    }
    for (const row of manifest.attachments) {
      const metadata = getBooksAttachmentSourceMetadata(bills.get(row.billId)!, row.externalDocumentId);
      if (metadata.byteSize !== row.byteSize || metadata.mimeType !== row.mimeType || metadata.sourceMetadataHash !== row.sourceMetadataHash)
        transferFailure("ATTACHMENT_SOURCE_METADATA");
    }
    for (const row of manifest.crmSnapshots) {
      const mapping = crmMappingSchema.parse(runs.get(row.importRunId)!.mappingJson);
      if (mapping.jobModule !== row.sourceModule || crmJobImportFields(mapping).some((field) => !Object.hasOwn(row.sourceRecordJson, field)))
        transferFailure("CRM_FIELDS_INCOMPLETE");
      const projected = projectCrmJobSource(row.sourceRecordJson, mapping, assignments);
      for (const [key, value] of Object.entries(projected)) if (key !== "linkStatus" && row[key as keyof typeof row] !== value)
        transferFailure("CRM_PROJECTION_CHANGED");
      if (row.linkStatus === "READY") {
        if (projected.linkStatus !== "PENDING" || (!row.isStale && normalizedCounts.get(`${row.companyId}:${row.normalizedJobNumber}`) !== 1))
          transferFailure("CRM_CANONICAL_AMBIGUOUS");
      }
      if (row.canonicalJobId) {
        const job = jobs.get(row.canonicalJobId)!, mapped = mapCrmJob(row.sourceRecordJson, mapping);
        for (const [key, value] of Object.entries(mapped)) if (job[key as keyof typeof job] !== value)
          transferFailure("CRM_CANONICAL_CHANGED");
      }
    }
    for (const row of manifest.associations) {
      const proof = parseBooksProjectAssociation({ companyId: row.companyId,
        booksSource: { organizationId: row.organizationId, dataCenter: row.dataCenter, environment: row.environment },
        crmSource: { organizationId: row.crmOrganizationId, dataCenter: row.crmDataCenter, environment: row.crmEnvironment },
        portalId: row.portalId, sourceProject: row.sourceProject, sourceDealsPages: row.sourceDealsPages,
        sourceCrmRecords: row.sourceCrmRecords, verifiedAt: row.verifiedAt });
      if (proof.sourceHash !== row.sourceHash || proof.booksProjectId !== row.booksProjectId || proof.projectName !== row.projectName ||
        proof.zprojectsProjectId !== row.zprojectsProjectId || canonicalTransferJson(proof.dealIds) !== canonicalTransferJson(row.dealIds) ||
        new Date(row.validUntil) > proof.validUntil) transferFailure("PROJECT_SOURCE_PROOF");
    }
  } catch (error) {
    if (error instanceof ZohoDataTransferError) throw error;
    transferFailure("SOURCE_ROWS_INVALID");
  }
}

function collectCooldowns(identities: SourceIdentity[], now: Date,
  states: { target: string; organizationId: string; dataCenter: string; environment: string; backoffUntil: Date | null; nextRunAt: Date; status: string }[],
  associations: { organizationId: string; dataCenter: string; environment: string; backoffUntil: Date | null }[],
  additional: ZohoDataTransferCooldown[]) {
  const result = new Map<string, ZohoDataTransferCooldown>();
  const add = (source: SourceIdentity, time: Date | string | null) => {
    if (!time) return;
    const parsed = new Date(time);
    if (!Number.isFinite(parsed.valueOf())) transferFailure("SOURCE_COOLDOWN");
    if (parsed <= now) return;
    const identity = identities.find((row) => sourceKey(row) === sourceKey(source));
    if (!identity) transferFailure("SOURCE_COOLDOWN");
    const next = zohoDataTransferCooldownSchema.parse({ ...identity, notBefore: parsed.toISOString() });
    const previous = result.get(sourceKey(identity));
    if (!previous || previous.notBefore < next.notBefore) result.set(sourceKey(identity), next);
  };
  let configured: Record<string, unknown> = {};
  if (process.env.INCOMING_SYNC_NOT_BEFORE_JSON) {
    const value: unknown = JSON.parse(process.env.INCOMING_SYNC_NOT_BEFORE_JSON);
    if (!value || typeof value !== "object" || Array.isArray(value)) transferFailure("SOURCE_COOLDOWN");
    configured = value as Record<string, unknown>;
    for (const [key, value] of Object.entries(configured)) if (!identities.some((row) => `${row.target}:${row.organizationId}` === key) ||
      typeof value !== "string" || !Number.isFinite(new Date(value).valueOf())) transferFailure("SOURCE_COOLDOWN");
  }
  for (const identity of identities) {
    const value = configured[`${identity.target}:${identity.organizationId}`];
    if (typeof value === "string") add(identity, value);
    for (const state of states.filter((row) => sourceKey({ ...row, target: row.target as SourceIdentity["target"] }) === sourceKey(identity))) {
      add(identity, state.backoffUntil);
      if (["WAITING_QUOTA", "RETRY"].includes(state.status)) add(identity, state.nextRunAt);
    }
    if (identity.target === "ZOHO") for (const row of associations.filter((row) => transferSourceKey(row) === transferSourceKey(identity)))
      add(identity, row.backoffUntil);
  }
  for (const item of additional) {
    const parsed = zohoDataTransferCooldownSchema.parse(item);
    if (!identities.some((row) => sourceKey(row) === sourceKey(parsed))) transferFailure("SOURCE_COOLDOWN");
    add(parsed, parsed.notBefore);
  }
  return [...result.values()].sort((a, b) => sourceKey(a).localeCompare(sourceKey(b)));
}

async function snapshotSource(actor: Actor, companyIds: string[], additional: ZohoDataTransferCooldown[]) {
  return db.$transaction(async (tx) => {
    const now = new Date();
    if (actor.role !== "ADMIN" || !await tx.user.findFirst({ where: { id: actor.id, role: "ADMIN", active: true }, select: { id: true } }))
      transferFailure("ADMIN_REQUIRED");
    const companies = await tx.company.findMany({ where: { id: { in: companyIds }, active: true },
      include: { memberships: { where: { userId: actor.id, active: true }, select: { userId: true } },
        integrationDestinations: { where: { target: "ZOHO" } }, crmSource: true }, orderBy: { id: "asc" } });
    if (companies.length !== companyIds.length || companies.some((row) => !row.memberships.length ||
      row.integrationDestinations.length !== 1 || !row.crmSource || row.liveAccountingEnabled ||
      row.integrationDestinations[0].liveEnabled || !row.isDemo || row.id !== `connection-check-books-${row.integrationDestinations[0].organizationId}`))
      transferFailure("SOURCE_COMPANY_ACCESS");
    const boundCompanies = companies.map((row) => ({ id: row.id, name: row.name, isDemo: row.isDemo, createdAt: row.createdAt,
      books: { organizationId: row.integrationDestinations[0].organizationId, dataCenter: row.integrationDestinations[0].dataCenter,
        environment: row.integrationDestinations[0].environment, createdAt: row.integrationDestinations[0].createdAt },
      crm: { organizationId: row.crmSource!.organizationId, dataCenter: row.crmSource!.dataCenter, environment: row.crmSource!.environment, createdAt: row.crmSource!.createdAt } }));
    const identities = [...new Map(boundCompanies.flatMap((company) => [
      { target: "ZOHO" as const, organizationId: company.books.organizationId, dataCenter: company.books.dataCenter, environment: company.books.environment },
      { target: "CRM" as const, organizationId: company.crm.organizationId, dataCenter: company.crm.dataCenter, environment: company.crm.environment },
    ]).map((identity) => [sourceKey(identity), identity])).values()];
    for (const identity of identities.filter((row) => row.target === "CRM")) {
      const sharing = await tx.companyCrmSource.findMany({ where: { organizationId: identity.organizationId, dataCenter: identity.dataCenter,
        environment: identity.environment, company: { active: true } }, select: { companyId: true } });
      if (sharing.some((row) => !companyIds.includes(row.companyId))) transferFailure("SHARED_SOURCE_INCOMPLETE");
    }
    const sourceCredentials: ZohoDataTransferManifest["sourceCredentials"] = [];
    for (const identity of identities) {
      const config = getConfig(identity.target, process.env, identity.organizationId);
      if (config.environment !== "production" || config.environment !== identity.environment || config.dataCenter !== identity.dataCenter || config.writeEnabled)
        transferFailure("SOURCE_CONFIGURATION_CHANGED");
      const credential = await tx.integrationCredential.findUnique({ where: { target_organizationId: { target: identity.target, organizationId: identity.organizationId } },
        select: { target: true, organizationId: true, dataCenter: true, connectionFingerprint: true, revokedAt: true,
          refreshTokenEncrypted: true, createdAt: true, updatedAt: true } });
      if (!credential || credential.revokedAt || !credential.refreshTokenEncrypted || credential.dataCenter !== identity.dataCenter ||
        credential.connectionFingerprint !== connectionFingerprint(config)) transferFailure("SOURCE_CREDENTIAL_PROVENANCE");
      sourceCredentials.push({ target: credential.target, organizationId: credential.organizationId, dataCenter: config.dataCenter,
        connectionFingerprint: credential.connectionFingerprint, createdAt: credential.createdAt.toISOString(), updatedAt: credential.updatedAt.toISOString() });
    }
    const booksWhere = identities.filter((row) => row.target === "ZOHO").map(({ organizationId, dataCenter, environment }) => ({ organizationId, dataCenter, environment }));
    const crmWhere = identities.filter((row) => row.target === "CRM").map(({ organizationId, dataCenter, environment }) => ({ crmOrganizationId: organizationId, dataCenter, environment }));
    // Every query shares one repeatable-read snapshot. No leases, success times, sessions or provider state are changed.
    const booksBills = await tx.booksBill.findMany({ where: { OR: booksWhere }, orderBy: { id: "asc" } });
    const attachments = await tx.booksBillAttachment.findMany({ where: { OR: booksWhere }, orderBy: { id: "asc" } });
    const booksRuns = await tx.booksImportRun.findMany({ where: { OR: booksWhere }, orderBy: { id: "asc" } });
    const crmRuns = await tx.crmImportRun.findMany({ where: { OR: crmWhere }, orderBy: { id: "asc" } });
    const crmSnapshots = await tx.crmJobSnapshot.findMany({ where: { OR: crmWhere }, orderBy: { id: "asc" } });
    const associations = await tx.booksProjectAssociation.findMany({ where: { OR: booksWhere }, orderBy: { id: "asc" } });
    const canonicalJobs = await tx.job.findMany({ where: { id: { in: crmSnapshots.flatMap((row) => row.canonicalJobId ? [row.canonicalJobId] : []) } }, orderBy: { id: "asc" } });
    const states = await tx.incomingSyncState.findMany({ where: { OR: identities },
      select: { target: true, organizationId: true, dataCenter: true, environment: true, backoffUntil: true, nextRunAt: true, status: true } });
    if (booksRuns.some((row) => row.status !== "COMPLETE") || crmRuns.some((row) => row.status !== "COMPLETE"))
      transferFailure("SOURCE_IMPORT_INCOMPLETE");
    for (const run of crmRuns) {
      const config = getConfig("CRM", process.env, run.crmOrganizationId);
      if (canonicalTransferJson(run.mappingJson) !== canonicalTransferJson(config.crmMapping ?? VERIFIED_CRM_JOB_MAPPING))
        transferFailure("CRM_MAPPING_CHANGED");
    }
    const manifest = parseZohoDataTransferManifest(asJson({ schemaVersion: 1, kind: "ZOHO_SOURCE_CACHE", exportedAt: now.toISOString(),
      companies: boundCompanies, sourceCredentials,
      booksRuns: booksRuns.map(({ id, companyId, organizationId, organizationName, dataCenter, environment, status, runKind,
        lastPage, lastPageHash, listingComplete, listedCount, detailCount, startedAt, completedAt }) => ({ id, companyId, organizationId,
          organizationName, dataCenter, environment, status, runKind, lastPage, lastPageHash, listingComplete, listedCount, detailCount, startedAt, completedAt })),
      crmRuns: crmRuns.map(({ id, crmOrganizationId, dataCenter, environment, sourceModule, scopeHash, mappingJson, fieldsJson, status,
        runKind, lastPage, lastPageHash, listingComplete, snapshotCount, mappedCount, canonicalCount, unassignedCount, reviewCount, startedAt, completedAt }) =>
        ({ id, crmOrganizationId, dataCenter, environment, sourceModule, scopeHash, mappingJson, fieldsJson, status, runKind, lastPage, lastPageHash,
          listingComplete, snapshotCount, mappedCount, canonicalCount, unassignedCount, reviewCount, startedAt, completedAt })),
      booksBills, crmSnapshots, canonicalJobs: canonicalJobs.map((row) => ({ ...row,
        contractValue: row.contractValue?.toFixed(2) ?? null, approvedVariations: row.approvedVariations.toFixed(2) })),
      attachments: attachments.map(({ storageKey, ...row }) => { void storageKey; return { ...row, assetPath: transferAssetPath(row.sha256, row.mimeType) }; }),
      associations: associations.map(({ leaseToken, leaseExpiresAt, ...row }) => { void leaseToken; void leaseExpiresAt; return row; }),
      cooldowns: collectCooldowns(identities, now, states, associations, additional),
    }));
    validateZohoTransferSourceRows(manifest);
    return { manifest, attachmentFiles: attachments.map(({ id, storageKey, sha256, byteSize, mimeType }) => ({ id, storageKey, sha256, byteSize, mimeType })) };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 120_000, maxWait: 10_000 });
}

function within(directory: string, root: string) {
  const relative = path.relative(root, directory);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
async function newPrivateDestination(input: string) {
  if (!input || input.split(/[\\/]/).includes("..")) transferFailure("EXPORT_DIRECTORY");
  const directory = path.resolve(input);
  if (["public", ".next", "node_modules", ".git"].some((name) => within(directory, path.resolve(name)))) transferFailure("EXPORT_DIRECTORY");
  let parent = path.dirname(directory);
  for (;;) {
    const metadata = await lstat(parent);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) transferFailure("EXPORT_DIRECTORY");
    const next = path.dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  const physicalParent = await realpath(path.dirname(directory));
  if (path.relative(physicalParent, path.dirname(directory)) !== "") transferFailure("EXPORT_DIRECTORY");
  await mkdir(directory, { mode: 0o700 });
  await mkdir(path.join(directory, "originals"), { mode: 0o700 });
  return directory;
}

/** Local DB reads plus a new private directory only. Never calls Zoho or updates the source database. */
export async function exportZohoDataTransfer(actor: Actor, input: ExportInput) {
  try {
    assertSourceEnvironment();
    if (!input.companyIds.length || input.companyIds.length > 20 || new Set(input.companyIds).size !== input.companyIds.length ||
      input.companyIds.some((id) => !/^[A-Za-z0-9_-]{1,100}$/.test(id))) transferFailure("SOURCE_COMPANIES_REQUIRED");
    const { manifest, attachmentFiles } = await snapshotSource(actor, input.companyIds, input.additionalCooldowns ?? []);
    const directory = await newPrivateDestination(input.directory);
    const paths = new Set<string>();
    for (const metadata of attachmentFiles) {
      const bytes = await readPrivateDocument(metadata);
      if (detectDocumentType(bytes).mimeType !== metadata.mimeType || createHash("sha256").update(bytes).digest("hex") !== metadata.sha256)
        transferFailure("ORIGINAL_INTEGRITY");
      const assetPath = transferAssetPath(metadata.sha256, metadata.mimeType);
      if (!paths.has(assetPath)) {
        await writeFile(path.join(directory, assetPath), bytes, { flag: "wx", mode: 0o600 });
        paths.add(assetPath);
      }
    }
    // The manifest is published last. An interrupted directory is not an importable completed bundle.
    await writeFile(path.join(directory, "manifest.json"), serializeZohoDataTransferManifest(manifest), { flag: "wx", mode: 0o600 });
    return { directory, manifestSha256: zohoDataTransferManifestHash(manifest), exportedAt: manifest.exportedAt,
      counts: { companies: manifest.companies.length, booksBills: manifest.booksBills.length, attachments: manifest.attachments.length,
        originalFiles: paths.size, crmSnapshots: manifest.crmSnapshots.length, canonicalJobs: manifest.canonicalJobs.length,
        associations: manifest.associations.length }, providerCalls: 0, databaseWrites: 0 };
  } catch (error) {
    if (error instanceof ZohoDataTransferError) throw error;
    return transferFailure("EXPORT_FAILED");
  }
}
