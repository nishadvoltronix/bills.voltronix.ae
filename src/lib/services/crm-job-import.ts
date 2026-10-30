import "server-only";
import { createHash } from "node:crypto";
import { Prisma, type CrmJobSnapshot } from "@prisma/client";
import Decimal from "decimal.js";
import { z } from "zod";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import { crmMappingSchema, getConfig, IntegrationError, type CrmMapping } from "@/lib/integrations/config";
import { connectionFingerprint } from "@/lib/integrations/connection-fingerprint";
import { mapCrmJob, VERIFIED_CRM_JOB_MAPPING } from "@/lib/integrations/crm";
import { canViewFinancialSummary } from "@/lib/permissions";
import { assertBooksCatalogEnvironment } from "@/lib/services/books-accounting-catalog";
import { crmJobSourceScope } from "./crm-job-access";
import { loadBooksProjectHistory } from "./books-project-history";
import { presentProjectHistory } from "./books-project-history-presentation";

const externalId = z.string().regex(/^\d{1,30}$/);
const companyField = "Books_Organization_ID";
const stageField = "Stage";
type Source = Prisma.InputJsonObject;
type Store = Prisma.TransactionClient;
const blocked = (code: string, message: string) => new IntegrationError(code, message, "BLOCKED");
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const normalize = (value: string) => value.normalize("NFKC").trim().toUpperCase();

export function crmJobImportFields(mapping: CrmMapping = VERIFIED_CRM_JOB_MAPPING) {
  return [...new Set(["id", mapping.jobNumberField, mapping.jobNameField, mapping.jobValueField, mapping.customerField,
    mapping.currencyField, companyField, stageField, "Created_Time", "Modified_Time",
    ...(mapping.approvedVariationsField ? [mapping.approvedVariationsField] : [])])];
}

/** Numeric pages 1–10, then the exact next_page_token from the preceding page. */
export function crmJobPageQuery(mapping: CrmMapping, ordinal: number, previousToken?: string | null) {
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 500)
    throw blocked("CRM_IMPORT_PAGE_INVALID", "CRM import exceeded the documented 100,000-record pagination bound.");
  if (ordinal > 10 && !previousToken)
    throw blocked("CRM_IMPORT_CURSOR_MISSING", "CRM did not supply the next pagination token. No complete import can be claimed.");
  return { fields: crmJobImportFields(mapping).join(","), per_page: "200", sort_by: "id", sort_order: "asc", converted: "both",
    ...(ordinal <= 10 ? { page: String(ordinal) } : { page_token: previousToken! }) };
}

export function parseCrmJobPage(value: unknown, ordinal: number) {
  const result = z.object({ data: z.array(z.object({ id: externalId }).loose()).max(200), info: z.object({
    more_records: z.boolean(), page: z.number().int().positive().optional(), count: z.number().int().nonnegative().optional(),
    next_page_token: z.string().min(1).max(8192).nullable().optional(),
  }) }).safeParse(value);
  if (!result.success || !z.json().safeParse(value).success ||
    (ordinal <= 10 && result.data.info.page !== undefined && result.data.info.page !== ordinal) ||
    (result.data.info.count !== undefined && result.data.info.count !== result.data.data.length) ||
    new Set(result.data.data.map((row) => row.id)).size !== result.data.data.length ||
    (result.data.info.more_records && result.data.data.length === 0) ||
    (ordinal >= 10 && result.data.info.more_records && !result.data.info.next_page_token))
    throw blocked("CRM_IMPORT_PAGE_INVALID", "CRM returned invalid, duplicate or incomplete record pagination.");
  return { records: (value as { data: Source[] }).data, hasMore: result.data.info.more_records,
    nextPageToken: result.data.info.next_page_token ?? null };
}

const string = (value: unknown, limit = 65_535) => typeof value === "string" && value.length <= limit ? value : null;
export function crmNativeAmount(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "number" && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) return null;
  if (typeof value === "string" && !/^-?\d+(?:\.\d+)?$/.test(value)) return null;
  try { const result = typeof value === "string" ? value : new Decimal(String(value)).toFixed(); return result.length <= 100 ? result : null; }
  catch { return null; }
}

/** Raw source is always retained; invalid local-job values do not drop the CRM record. */
export function projectCrmJobSource(record: Source, mapping: CrmMapping, assignments: { companyId: string; booksOrganizationId: string }[]) {
  const booksOrganizationId = externalId.safeParse(record[companyField]).success ? String(record[companyField]) : null;
  const matching = assignments.filter((entry) => entry.booksOrganizationId === booksOrganizationId);
  const companyId = matching.length === 1 ? matching[0].companyId : null;
  const customer = record[mapping.customerField];
  const customerObject = customer && typeof customer === "object" && !Array.isArray(customer) ? customer as Record<string, unknown> : {};
  const jobNumber = string(record[mapping.jobNumberField]);
  const normalized = jobNumber === null ? null : normalize(jobNumber);
  const amount = crmNativeAmount(record[mapping.jobValueField]);
  const approvedVariations = mapping.approvedVariationsField ? crmNativeAmount(record[mapping.approvedVariationsField]) : null;
  let valid = true;
  try {
    const mapped = mapCrmJob(record, mapping);
    if (mapped.contractValue !== null && new Decimal(mapped.contractValue).abs().greaterThan("9999999999999999.99")) valid = false;
    if (new Decimal(mapped.approvedVariations).abs().greaterThan("9999999999999999.99")) valid = false;
    if (record[mapping.jobValueField] !== null && record[mapping.jobValueField] !== undefined && amount === null) valid = false;
    if (mapping.approvedVariationsField && approvedVariations === null) valid = false;
  } catch { valid = false; }
  return { companyId, booksOrganizationId, jobNumber, normalizedJobNumber: normalized && normalized.length <= 255 ? normalized : null,
    name: string(record[mapping.jobNameField]), customerId: string(customerObject.id, 100), customerName: string(customerObject.name),
    currencyCode: string(record[mapping.currencyField], 20), amount, approvedVariations, stage: string(record[stageField]),
    sourceModifiedAt: string(record.Modified_Time, 60), linkStatus: !companyId ? "UNASSIGNED_COMPANY" : valid ? "PENDING" : "INVALID_SOURCE" };
}

async function importContext(store: Store, actor: Actor, organizationId: string) {
  assertBooksCatalogEnvironment();
  if (actor.role !== "ADMIN" || !await store.user.findFirst({ where: { id: actor.id, active: true, role: "ADMIN" }, select: { id: true } }))
    throw new HttpError(403, "An active administrator is required to import the complete CRM job source.");
  const config = getConfig("CRM", process.env, organizationId);
  if (config.environment !== "production" || config.writeEnabled)
    throw blocked("CRM_IMPORT_READ_ONLY_REQUIRED", "CRM inventory import requires the production read source with accounting writes disabled.");
  const mapping = config.crmMapping ?? VERIFIED_CRM_JOB_MAPPING;
  const sources = await store.companyCrmSource.findMany({ where: { organizationId, dataCenter: config.dataCenter,
    environment: config.environment, company: { active: true } }, include: { company: { include: {
      memberships: { where: { userId: actor.id, active: true } }, integrationDestinations: { where: { target: "ZOHO" } },
    } } }, orderBy: { companyId: "asc" } });
  if (!sources.length || sources.some((source) => !source.company.memberships.length || source.company.integrationDestinations.length !== 1))
    throw new HttpError(403, "The importing administrator must have access to every active company assigned to this shared CRM source.");
  const assignments = sources.map((source) => {
    const destination = source.company.integrationDestinations[0];
    const books = getConfig("ZOHO", process.env, destination.organizationId);
    if (books.dataCenter !== destination.dataCenter || books.environment !== destination.environment ||
      (process.env.APP_ENV !== "production" && (source.company.liveAccountingEnabled || destination.liveEnabled)))
      throw blocked("CRM_COMPANY_SOURCE_CHANGED", "A company source or Books destination differs from the reviewed local read setup.");
    return { companyId: source.companyId, booksOrganizationId: destination.organizationId, isDemo: source.company.isDemo,
      sourceCreatedAt: source.createdAt.toISOString(), booksDataCenter: destination.dataCenter, booksEnvironment: destination.environment };
  });
  if (new Set(assignments.map((item) => item.booksOrganizationId)).size !== assignments.length)
    throw blocked("CRM_COMPANY_SOURCE_AMBIGUOUS", "CRM company routing is ambiguous. No job was assigned.");
  return { identity: { crmOrganizationId: organizationId, dataCenter: config.dataCenter, environment: config.environment, sourceModule: mapping.jobModule },
    mapping, assignments, scopeHash: hash({ connection: connectionFingerprint(config), mapping, assignments }) };
}

const options = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 60_000 };
async function checkedRun(store: Store, actor: Actor, runId: string) {
  const run = await store.crmImportRun.findUnique({ where: { id: runId } });
  if (!run) throw new HttpError(404, "CRM import not found.");
  const context = await importContext(store, actor, run.crmOrganizationId);
  if (context.scopeHash !== run.scopeHash) throw blocked("CRM_IMPORT_SCOPE_CHANGED", "The source configuration or company assignment changed during import.");
  return { run, context };
}
export async function assertCrmJobImportRunAccess(actor: Actor, runId: string) {
  return (await checkedRun(db, actor, runId)).run;
}
async function writableRun(store: Store, actor: Actor, runId: string) {
  const { run, context } = await checkedRun(store, actor, runId);
  if (!["RUNNING", "PARTIAL"].includes(run.status)) throw blocked("CRM_IMPORT_CLOSED", "Start a new run to refresh a completed CRM inventory.");
  const latest = await store.crmImportRun.findFirst({ where: context.identity, orderBy: [{ startedAt: "desc" }, { id: "desc" }] });
  if (latest?.id !== run.id) throw blocked("CRM_IMPORT_SUPERSEDED", "A newer import exists for this CRM source.");
  return { run, context };
}

export async function beginCrmJobImport(actor: Actor, input: { organizationId: string; organizationResponse: unknown }) {
  externalId.parse(input.organizationId);
  const organization = z.object({ org: z.array(z.object({ zgid: externalId.optional(), id: externalId.optional(), type: z.literal("production") })).length(1) })
    .safeParse(input.organizationResponse);
  if (!organization.success || (organization.data.org[0].zgid ?? organization.data.org[0].id) !== input.organizationId)
    throw blocked("CRM_ORGANIZATION_MISMATCH", "The downloaded organization proof does not match the selected CRM source.");
  return db.$transaction(async (tx) => {
    const context = await importContext(tx, actor, input.organizationId);
    if (await tx.crmImportRun.findFirst({ where: { ...context.identity, status: "RUNNING" } }))
      throw blocked("CRM_IMPORT_ALREADY_RUNNING", "Resume the current CRM import before starting another.");
    const run = await tx.crmImportRun.create({ data: { ...context.identity, initiatedById: actor.id, scopeHash: context.scopeHash,
      mappingJson: context.mapping, fieldsJson: crmJobImportFields(context.mapping) } });
    await tx.auditLog.create({ data: { actorId: actor.id, action: "CRM_JOB_INVENTORY_STARTED", entityType: "CrmImportRun", entityId: run.id,
      details: { crmOrganizationId: run.crmOrganizationId, allStages: true, providerFinancialWrites: 0 } } });
    return run;
  }, options);
}

export async function importCrmJobPage(actor: Actor, runId: string, input: { ordinal: number; response: unknown; fetchedAt?: Date | string }) {
  if (!Number.isInteger(input.ordinal) || input.ordinal < 1 || input.ordinal > 500)
    throw blocked("CRM_IMPORT_PAGE_INVALID", "CRM page number is outside the documented pagination bound.");
  const page = parseCrmJobPage(input.response, input.ordinal), pageHash = hash(input.response);
  const fetchedAt = input.fetchedAt === undefined ? new Date() : new Date(input.fetchedAt);
  if (Number.isNaN(fetchedAt.valueOf()) || fetchedAt.valueOf() > Date.now() + 300_000)
    throw blocked("CRM_SNAPSHOT_TIME_INVALID", "The CRM download time is invalid.");
  return db.$transaction(async (tx) => {
    const { run, context } = await writableRun(tx, actor, runId);
    if (run.lastPage === input.ordinal && run.lastPageHash === pageHash) return run;
    if (run.listingComplete || input.ordinal !== run.lastPage + 1)
      throw blocked("CRM_IMPORT_PAGE_ORDER", "Import consecutive CRM pages beginning with page one.");
    if (input.ordinal > 10 && !run.nextPageToken)
      throw blocked("CRM_IMPORT_CURSOR_MISSING", "The preceding CRM page did not provide a required cursor.");
    const records = await tx.crmJobSnapshot.findMany({ where: { ...context.identity, externalCrmId: { in: page.records.map((row) => String(row.id)) } },
      select: { externalCrmId: true, companyId: true, canonicalJobId: true, importRunId: true } });
    if (records.some((row) => row.importRunId === run.id))
      throw blocked("CRM_IMPORT_DUPLICATE_RECORD", "CRM repeated a record across pages. The inventory is incomplete.");
    for (const sourceRecordJson of page.records) {
      const identity = { ...context.identity, externalCrmId: String(sourceRecordJson.id) };
      const projected = projectCrmJobSource(sourceRecordJson, context.mapping, context.assignments);
      const existing = records.find((row) => row.externalCrmId === identity.externalCrmId);
      // Preserve an existing local job if CRM moves the source record to another company.
      if (existing?.canonicalJobId && existing.companyId !== projected.companyId) projected.linkStatus = "LOCAL_CONFLICT";
      const data = { ...projected, sourceRecordJson, canonicalJobId: null, importRunId: run.id, lastSeenAt: fetchedAt, isStale: false };
      await tx.crmJobSnapshot.upsert({ where: { crmOrganizationId_dataCenter_environment_sourceModule_externalCrmId: identity },
        create: { ...identity, ...data }, update: data });
    }
    return tx.crmImportRun.update({ where: { id: run.id }, data: { lastPage: input.ordinal, lastPageHash: pageHash,
      nextPageToken: page.nextPageToken, listingComplete: !page.hasMore, snapshotCount: { increment: page.records.length },
      status: "RUNNING", completedAt: null, lastErrorCode: null } });
  }, options);
}

async function linkBatch(actor: Actor, runId: string) {
  return db.$transaction(async (tx) => {
    const { run, context } = await writableRun(tx, actor, runId);
    if (!run.listingComplete) throw blocked("CRM_IMPORT_LIST_INCOMPLETE", "Complete the all-stage CRM listing before creating local job links.");
    const rows = await tx.crmJobSnapshot.findMany({ where: { importRunId: run.id, linkStatus: "PENDING" }, take: 100, orderBy: { id: "asc" } });
    for (const snapshot of rows) {
      const set = async (linkStatus: string, canonicalJobId: string | null = null) => tx.crmJobSnapshot.update({ where: { id: snapshot.id }, data: { linkStatus, canonicalJobId } });
      if (!snapshot.companyId || !snapshot.normalizedJobNumber) { await set("INVALID_SOURCE"); continue; }
      if (await tx.crmJobSnapshot.count({ where: { importRunId: run.id, companyId: snapshot.companyId, normalizedJobNumber: snapshot.normalizedJobNumber } }) !== 1) {
        await set("DUPLICATE_JOB_NUMBER"); continue;
      }
      let mapped: ReturnType<typeof mapCrmJob>;
      try { mapped = mapCrmJob(snapshot.sourceRecordJson as Record<string, unknown>, context.mapping); }
      catch { await set("INVALID_SOURCE"); continue; }
      const current = await tx.job.findUnique({ where: { companyId_externalCrmId: { companyId: snapshot.companyId, externalCrmId: snapshot.externalCrmId } } });
      const otherCompany = await tx.job.findFirst({ where: { externalCrmId: snapshot.externalCrmId, companyId: { not: snapshot.companyId },
        company: { crmSource: { organizationId: run.crmOrganizationId, dataCenter: run.dataCenter, environment: run.environment } } }, select: { id: true } });
      if (otherCompany) { await set("LOCAL_CONFLICT"); continue; }
      const collision = await tx.job.findUnique({ where: { companyId_jobNumber: { companyId: snapshot.companyId, jobNumber: mapped.jobNumber } } });
      if (collision && collision.id !== current?.id) { await set("LOCAL_CONFLICT"); continue; }
      if (current) {
        if (current.jobNumber !== mapped.jobNumber || current.name !== mapped.name || current.customer !== mapped.customer || current.currency !== mapped.currency ||
          (current.contractValue?.toFixed(2) ?? null) !== mapped.contractValue ||
          (context.mapping.approvedVariationsField && current.approvedVariations.toFixed(2) !== mapped.approvedVariations)) {
          await set("SOURCE_CHANGED"); continue;
        }
        await set("READY", current.id); continue;
      }
      const company = context.assignments.find((item) => item.companyId === snapshot.companyId)!;
      const job = await tx.job.create({ data: { ...mapped, companyId: snapshot.companyId, isDemo: company.isDemo } });
      await set("READY", job.id);
      await tx.auditLog.create({ data: { actorId: actor.id, companyId: snapshot.companyId, action: "CRM_JOB_BULK_IMPORTED", entityType: "Job", entityId: job.id,
        details: { crmOrganizationId: run.crmOrganizationId, booksOrganizationId: snapshot.booksOrganizationId,
          externalCrmId: snapshot.externalCrmId, jobNumber: mapped.jobNumber, runId: run.id, snapshotId: snapshot.id,
          source: "verified_complete_crm_inventory", allStages: true, providerFinancialWrites: 0 } } });
    }
    return rows.length;
  }, options);
}

/** Only a complete listing can prove job-number uniqueness. Existing jobs are never overwritten. */
export async function finishCrmJobImport(actor: Actor, runId: string, input: { lastErrorCode?: string } = {}) {
  const errorCode = input.lastErrorCode === undefined ? null : z.string().regex(/^[A-Z0-9_]{1,100}$/).parse(input.lastErrorCode);
  const initial = await writableRun(db, actor, runId);
  if (initial.run.listingComplete && !errorCode) while (await linkBatch(actor, runId)) { /* Bounded SQL batches retain resumability. */ }
  return db.$transaction(async (tx) => {
    const { run, context } = await writableRun(tx, actor, runId);
    const snapshotCount = await tx.crmJobSnapshot.count({ where: { importRunId: run.id } });
    if (snapshotCount !== run.snapshotCount) throw blocked("CRM_IMPORT_COUNT_MISMATCH", "CRM snapshot count differs from the downloaded page count.");
    const mappedCount = await tx.crmJobSnapshot.count({ where: { importRunId: run.id, companyId: { not: null } } });
    const canonicalCount = await tx.crmJobSnapshot.count({ where: { importRunId: run.id, linkStatus: "READY" } });
    const unassignedCount = await tx.crmJobSnapshot.count({ where: { importRunId: run.id, linkStatus: "UNASSIGNED_COMPANY" } });
    const pending = await tx.crmJobSnapshot.count({ where: { importRunId: run.id, linkStatus: "PENDING" } });
    const reviewCount = snapshotCount - canonicalCount - unassignedCount - pending;
    const complete = run.listingComplete && !errorCode && pending === 0;
    if (run.listingComplete) await tx.crmJobSnapshot.updateMany({ where: { ...context.identity, importRunId: { not: run.id } }, data: { isStale: true } });
    const updated = await tx.crmImportRun.update({ where: { id: run.id }, data: { mappedCount, canonicalCount, unassignedCount, reviewCount,
      status: complete ? "COMPLETE" : "PARTIAL", completedAt: new Date(), lastErrorCode: errorCode ?? (complete ? null : "LISTING_INCOMPLETE") } });
    await tx.auditLog.create({ data: { actorId: actor.id, action: "CRM_JOB_INVENTORY_FINISHED", entityType: "CrmImportRun", entityId: run.id,
      details: { crmOrganizationId: run.crmOrganizationId, snapshotCount, mappedCount, canonicalCount, unassignedCount, reviewCount,
        listingComplete: run.listingComplete, status: updated.status, providerFinancialWrites: 0 } } });
    return updated;
  }, options);
}

/** Unassigned job references are an Admin source-inventory privilege, never a company membership bypass. */
export async function crmJobSnapshotFilter(actor: Actor, companyId?: string): Promise<Prisma.CrmJobSnapshotWhereInput> {
  const sourceScope = await crmJobSourceScope(actor, companyId);
  const actualJobs = { AND: [sourceScope, { normalizedJobNumber: { not: null } }] };
  const history = actor.role === "DATA_ENTRY" ? { relations: [] } : await loadBooksProjectHistory(actor, companyId);
  const legacyIds = [...new Set(history.relations.filter((relation) => !relation.jobNumber).map((relation) => relation.snapshotId))].sort();
  return legacyIds.length ? { OR: [actualJobs, { AND: [await crmJobSourceScope(actor), { id: { in: legacyIds } }] }] } : actualJobs;
}
function serializeSnapshot(actor: Actor, row: CrmJobSnapshot & { company: { name: string } | null }) {
  return { id: row.id, companyId: row.companyId, companyName: row.company?.name.replace(/^\[CONNECTION CHECK\]\s*/, "") ?? null,
    externalCrmId: row.externalCrmId, jobNumber: row.jobNumber, name: row.name, customerName: row.customerName,
    currencyCode: row.currencyCode, amount: canViewFinancialSummary(actor) ? row.amount : null,
    approvedVariations: canViewFinancialSummary(actor) ? row.approvedVariations : null, stage: row.stage,
    canonicalJobId: row.canonicalJobId, linkStatus: row.linkStatus, sourceModifiedAt: row.sourceModifiedAt,
    importedAt: row.importedAt.toISOString(), lastSeenAt: row.lastSeenAt.toISOString(), isStale: row.isStale };
}
const listInput = z.object({ companyId: z.string().min(1).max(100).optional(), q: z.string().trim().max(200).optional(),
  page: z.number().int().min(1).max(100_000).default(1), pageSize: z.number().int().min(1).max(100).default(50) }).strict();

export async function listCrmJobSnapshots(actor: Actor, payload: unknown = {}) {
  const input = listInput.parse(payload), scope = await crmJobSnapshotFilter(actor, input.companyId);
  const query = input.q?.replace(/[\\%_]/g, "\\$&");
  const normalizedQuery = input.q ? normalize(input.q).replace(/[\\%_]/g, "\\$&") : undefined;
  const where: Prisma.CrmJobSnapshotWhereInput = { AND: [scope, ...(query ? [{ OR: [
    { externalCrmId: input.q }, { jobNumber: { contains: query } }, { normalizedJobNumber: { contains: normalizedQuery } }, { name: { contains: query } },
  ] }] : [])] };
  const [rows, total] = await Promise.all([db.crmJobSnapshot.findMany({ where, include: { company: { select: { name: true } } },
    orderBy: [{ normalizedJobNumber: "asc" }, { id: "asc" }], skip: (input.page - 1) * input.pageSize, take: input.pageSize }), db.crmJobSnapshot.count({ where })]);
  if (JSON.stringify(scope) !== JSON.stringify(await crmJobSnapshotFilter(actor, input.companyId))) throw new HttpError(403, "Company access changed. Reload the page.");
  return { jobs: rows.map((row) => serializeSnapshot(actor, row)), total, page: input.page, pageSize: input.pageSize };
}
export async function getCrmJobSnapshot(actor: Actor, id: string) {
  const scope = await crmJobSnapshotFilter(actor);
  const row = await db.crmJobSnapshot.findFirst({ where: { id, ...scope }, include: { company: { select: { name: true } } } });
  if (!row) throw new HttpError(404, "CRM job not found.");
  const history = actor.role === "DATA_ENTRY" ? { relations: [], warnings: [] } : await loadBooksProjectHistory(actor);
  const relations = history.relations.filter((relation) => relation.snapshotId === row.id);
  const presentation = await presentProjectHistory(actor, relations);
  if (JSON.stringify(scope) !== JSON.stringify(await crmJobSnapshotFilter(actor))) throw new HttpError(403, "Company access changed. Reload the page.");
  const references = [...new Set(relations.map((relation) => relation.displayReference).filter((value): value is string => Boolean(value)))];
  return { ...serializeSnapshot(actor, row), displayReference: row.jobNumber ?? (references.length === 1 ? references[0] : null),
    referenceKind: row.jobNumber ? "JOB" as const : "CRM_DEAL" as const,
    ...presentation, historyWarnings: [...history.warnings, ...(relations.length ? ["Project relationships identify bill history; job cost allocation has not been verified."] : [])] };
}
export type CrmJobSnapshotDto = Awaited<ReturnType<typeof getCrmJobSnapshot>>;
export type CrmJobSnapshotListResult = Awaited<ReturnType<typeof listCrmJobSnapshots>>;

export function parseCrmImportMapping(value: unknown) { return crmMappingSchema.parse(value); }
