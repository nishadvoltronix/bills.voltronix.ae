import "server-only";
import { createHash } from "node:crypto";
import { Prisma, type CrmImportRun, type CrmJobSnapshot } from "@prisma/client";
import { z } from "zod";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import { getConfig, IntegrationError } from "@/lib/integrations/config";
import { connectionFingerprint } from "@/lib/integrations/connection-fingerprint";
import { mapCrmJob, VERIFIED_CRM_JOB_MAPPING } from "@/lib/integrations/crm";
import { crmJobImportFields, crmJobPageQuery, parseCrmJobPage, projectCrmJobSource } from "./crm-job-import";
import type { IncomingSource, IncomingSyncInput, IncomingSyncResult } from "./incoming-sync-types";

type Store = Prisma.TransactionClient;
type SourceRecord = Prisma.InputJsonObject;
const idSchema = z.string().regex(/^\d{1,30}$/);
const dateSchema = z.iso.datetime({ offset: true });
const fail = (code: string, message: string) => new IntegrationError(code, message, "BLOCKED");
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const transactionOptions = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 60_000 };
const metadataSchema = z.object({ kind: z.literal("INCOMING_CRM"), version: z.literal(1), fields: z.array(z.string()),
  since: dateSchema.nullable(), phase: z.enum(["records", "deleted", "missing", "link", "done"]),
  deletedPage: z.number().int().min(0).max(500), linkAfterId: z.string().nullable() });
type Context = Awaited<ReturnType<typeof incomingCrmSourceContext>>;

/** GET-only incoming authorization is independent of outbound accounting switches. */
export async function incomingCrmSourceContext(actor: Actor, source: IncomingSource, store: Store = db) {
  if (source.target !== "CRM" || source.companyId !== null || !idSchema.safeParse(source.organizationId).success)
    throw fail("CRM_INCOMING_SOURCE_INVALID", "Incoming CRM requires one exact shared source identity.");
  if (actor.role !== "ADMIN" || !await store.user.findFirst({ where: { id: actor.id, active: true, role: "ADMIN" }, select: { id: true } }))
    throw new HttpError(403, "An active administrator is required for incoming CRM synchronization.");
  const config = getConfig("CRM", process.env, source.organizationId);
  if (!config.networkEnabled || config.dataCenter !== source.dataCenter || config.environment !== source.environment)
    throw fail("CRM_INCOMING_SOURCE_CHANGED", "The incoming CRM connection differs from its configured source.");
  const mapping = config.crmMapping ?? VERIFIED_CRM_JOB_MAPPING;
  if (!mapping.verified) throw fail("CRM_MAPPING_UNVERIFIED", "The CRM field mapping must be verified.");
  const companies = await store.companyCrmSource.findMany({ where: { organizationId: source.organizationId, dataCenter: source.dataCenter,
    environment: source.environment, company: { active: true } }, include: { company: { include: {
      memberships: { where: { userId: actor.id, active: true } }, integrationDestinations: { where: { target: "ZOHO" } },
    } } }, orderBy: { companyId: "asc" } });
  if (!companies.length || companies.some((item) => !item.company.memberships.length || item.company.integrationDestinations.length !== 1))
    throw new HttpError(403, "Administrator access to every active company sharing this CRM source is required.");
  const assignments = companies.map((item) => {
    const destination = item.company.integrationDestinations[0], books = getConfig("ZOHO", process.env, destination.organizationId);
    if (books.dataCenter !== destination.dataCenter || books.environment !== destination.environment)
      throw fail("CRM_INCOMING_DESTINATION_CHANGED", "A CRM company's Books binding differs from its configured destination.");
    return { companyId: item.companyId, booksOrganizationId: destination.organizationId, isDemo: item.company.isDemo,
      sourceCreatedAt: item.createdAt.toISOString(), dataCenter: destination.dataCenter, environment: destination.environment,
      connection: connectionFingerprint(books) };
  });
  if (new Set(assignments.map((item) => item.booksOrganizationId)).size !== assignments.length)
    throw fail("CRM_INCOMING_COMPANY_AMBIGUOUS", "The shared CRM source has ambiguous company assignments.");
  return { identity: { crmOrganizationId: source.organizationId, dataCenter: source.dataCenter,
    environment: source.environment, sourceModule: mapping.jobModule }, mapping, assignments,
    scopeHash: hash({ identity: connectionFingerprint(config), mapping, assignments }) };
}

export function incomingCrmSince(watermark: string | null) {
  if (watermark === null) return null;
  const time = new Date(dateSchema.parse(watermark));
  if (time.valueOf() > Date.now() + 300_000) throw fail("CRM_INCOMING_TIME_INVALID", "The incoming CRM watermark is in the future.");
  // Use CRM's documented whole-second, numeric-offset format for conditional reads.
  return new Date(Math.max(0, time.valueOf() - 300_000)).toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

export function parseIncomingCrmDeletedPage(value: unknown, ordinal: number) {
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 500)
    throw fail("CRM_INCOMING_DELETIONS_INVALID", "CRM returned invalid deletion pagination.");
  if (value === null) return { records: [], hasMore: false };
  const result = z.object({ data: z.array(z.object({ id: idSchema, deleted_time: dateSchema,
    type: z.enum(["recycle", "permanent", "all"]) })).max(200), info: z.object({ more_records: z.boolean(),
    page: z.number().int().positive().optional(), count: z.number().int().nonnegative().optional() }) }).safeParse(value);
  if (!result.success ||
    (result.data.info.page !== undefined && result.data.info.page !== ordinal) ||
    (result.data.info.count !== undefined && result.data.info.count !== result.data.data.length) ||
    (result.data.info.more_records && !result.data.data.length) ||
    new Set(result.data.data.map((row) => row.id)).size !== result.data.data.length)
    throw fail("CRM_INCOMING_DELETIONS_INVALID", "CRM returned invalid deletion pagination.");
  return { records: result.data.data, hasMore: result.data.info.more_records };
}

function validateRecord(record: SourceRecord, context: Context) {
  // Missing selected keys can mean a permission/field change; never overwrite good snapshots with that response.
  if (crmJobImportFields(context.mapping).some((field) => !(field in record)) || !dateSchema.safeParse(record.Modified_Time).success)
    throw fail("CRM_INCOMING_RECORD_INCOMPLETE", "CRM omitted required source fields or the modification timestamp.");
  if (new Date(String(record.Modified_Time)).valueOf() > Date.now() + 300_000)
    throw fail("CRM_INCOMING_TIME_INVALID", "A CRM record has an invalid future modification timestamp.");
}

async function mutate<T>(input: IncomingSyncInput, expected: Context, action: (tx: Store, context: Context) => Promise<T>) {
  return db.$transaction(async (tx) => {
    await input.assertLease(tx);
    const current = await incomingCrmSourceContext(input.actor, input.source, tx);
    if (current.scopeHash !== expected.scopeHash) throw fail("CRM_INCOMING_SCOPE_CHANGED", "CRM source authorization or routing changed during synchronization.");
    return action(tx, current);
  }, transactionOptions);
}

function metadata(run: CrmImportRun) { return metadataSchema.parse(run.fieldsJson); }
function continuation(run: CrmImportRun) { return { version: 1, runId: run.id, mode: run.runKind, startedAt: run.startedAt.toISOString() }; }
async function currentRun(tx: Store, context: Context, runId: string) {
  const run = await tx.crmImportRun.findUniqueOrThrow({ where: { id: runId } });
  if (Object.entries(context.identity).some(([key, value]) => run[key as keyof typeof context.identity] !== value) || run.scopeHash !== context.scopeHash)
    throw fail("CRM_INCOMING_RUN_CHANGED", "The saved CRM synchronization belongs to a different source or routing configuration.");
  metadata(run);
  return run;
}

async function startOrResume(input: IncomingSyncInput, context: Context) {
  return mutate(input, context, async (tx) => {
    if (input.continuation !== null && input.continuation !== undefined) {
      const saved = z.object({ version: z.literal(1), runId: z.string().min(1).max(100) }).parse(input.continuation);
      const prior = await currentRun(tx, context, saved.runId);
      if (prior.status !== "FAILED") return prior;
      const replacement = await tx.crmImportRun.findFirst({ where: { ...context.identity, status: "RUNNING" }, orderBy: { startedAt: "desc" } });
      if (prior.lastErrorCode === "INCOMING_CURSOR_EXPIRED" && replacement) return currentRun(tx, context, replacement.id);
      throw fail("CRM_INCOMING_RUN_CLOSED", "The saved CRM synchronization is closed and requires a new run.");
    }
    // Recover a committed run even if the process stopped before saving its external checkpoint.
    const running = await tx.crmImportRun.findFirst({ where: { ...context.identity, status: { in: ["RUNNING", "PARTIAL"] } },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }] });
    if (running) {
      if (!metadataSchema.safeParse(running.fieldsJson).success)
        throw fail("CRM_IMPORT_ACTIVE", "Finish the existing cache import before automatic CRM synchronization.");
      return currentRun(tx, context, running.id);
    }
    const since = input.mode === "reconcile" ? null : incomingCrmSince(input.watermark);
    const runKind = since === null ? "FULL" : "INCREMENTAL";
    const run = await tx.crmImportRun.create({ data: { ...context.identity, initiatedById: input.actor.id, scopeHash: context.scopeHash,
      mappingJson: context.mapping, runKind, fieldsJson: { kind: "INCOMING_CRM", version: 1, fields: crmJobImportFields(context.mapping),
        since, phase: "records", deletedPage: 0, linkAfterId: null } } });
    await tx.auditLog.create({ data: { actorId: input.actor.id, action: "CRM_INCOMING_STARTED", entityType: "CrmImportRun", entityId: run.id,
      details: { crmOrganizationId: run.crmOrganizationId, runKind, providerFinancialWrites: 0 } } });
    return run;
  });
}

async function restartExpiredCursor(input: IncomingSyncInput, context: Context, run: CrmImportRun) {
  return mutate(input, context, async (tx) => {
    const current = await currentRun(tx, context, run.id), info = metadata(current);
    if (current.status !== "RUNNING" || info.phase !== "records") throw fail("CRM_INCOMING_RUN_CHANGED", "CRM synchronization changed before its cursor restart.");
    await tx.crmImportRun.update({ where: { id: run.id }, data: { status: "FAILED", completedAt: new Date(), lastErrorCode: "INCOMING_CURSOR_EXPIRED" } });
    const next = await tx.crmImportRun.create({ data: { ...context.identity, initiatedById: input.actor.id, scopeHash: context.scopeHash,
      mappingJson: context.mapping, runKind: current.runKind, fieldsJson: { ...info, phase: "records", deletedPage: 0, linkAfterId: null } } });
    await tx.auditLog.create({ data: { actorId: input.actor.id, action: "CRM_INCOMING_CURSOR_RESTARTED", entityType: "CrmImportRun", entityId: next.id,
      details: { previousRunId: run.id, crmOrganizationId: run.crmOrganizationId, providerFinancialWrites: 0 } } });
    return next;
  });
}

async function saveRecord(tx: Store, context: Context, run: CrmImportRun, record: SourceRecord, fetchedAt: Date) {
  validateRecord(record, context);
  const identity = { ...context.identity, externalCrmId: idSchema.parse(record.id) };
  const where = { crmOrganizationId_dataCenter_environment_sourceModule_externalCrmId: identity };
  const existing = await tx.crmJobSnapshot.findUnique({ where });
  // Overlap, retries and provider replication must not replace a newer source version.
  if (existing?.sourceModifiedAt && new Date(existing.sourceModifiedAt).valueOf() > new Date(String(record.Modified_Time)).valueOf()) {
    await tx.crmJobSnapshot.update({ where, data: { importRunId: run.id, lastSeenAt: fetchedAt, isStale: false } });
    return existing.importRunId === run.id ? 0 : 1;
  }
  const projected = projectCrmJobSource(record, context.mapping, context.assignments);
  const canonicalJobId = existing?.companyId === projected.companyId ? existing?.canonicalJobId ?? null : null;
  if (existing?.linkStatus === "READY" && !existing.isStale && canonicalJobId && projected.linkStatus === "PENDING" &&
    Object.entries(projected).filter(([key]) => key !== "linkStatus" && key !== "sourceModifiedAt")
      .every(([key, value]) => existing[key as keyof typeof projected] === value)) projected.linkStatus = "READY";
  if (existing?.canonicalJobId && existing.companyId !== projected.companyId) projected.linkStatus = "LOCAL_CONFLICT";
  const data = { ...projected, canonicalJobId, importRunId: run.id, lastSeenAt: fetchedAt, isStale: false, sourceRecordJson: record };
  await tx.crmJobSnapshot.upsert({ where, create: { ...identity, ...data }, update: data });
  // A confirmed new duplicate invalidates the existing link immediately, even while the listing is incomplete.
  if (projected.companyId && projected.normalizedJobNumber) {
    const same = { ...context.identity, companyId: projected.companyId, normalizedJobNumber: projected.normalizedJobNumber, isStale: false };
    if (await tx.crmJobSnapshot.count({ where: same }) > 1)
      await tx.crmJobSnapshot.updateMany({ where: same, data: { linkStatus: "DUPLICATE_JOB_NUMBER" } });
  }
  return existing?.importRunId === run.id ? 0 : 1;
}

async function applyRecords(input: IncomingSyncInput, context: Context, run: CrmImportRun, response: unknown, fetchedAt: Date) {
  const ordinal = run.lastPage + 1;
  const page = response === null ? { records: [] as SourceRecord[], hasMore: false, nextPageToken: null } : parseCrmJobPage(response, ordinal);
  return mutate(input, context, async (tx) => {
    const current = await currentRun(tx, context, run.id), info = metadata(current);
    if (current.lastPage !== run.lastPage || info.phase !== "records") throw fail("CRM_INCOMING_PAGE_CHANGED", "CRM pagination advanced concurrently.");
    let count = 0;
    for (const record of page.records) count += await saveRecord(tx, context, current, record, fetchedAt);
    return tx.crmImportRun.update({ where: { id: run.id }, data: { lastPage: ordinal, lastPageHash: hash(response),
      nextPageToken: page.nextPageToken, listingComplete: !page.hasMore, snapshotCount: { increment: count },
      fieldsJson: { ...info, phase: page.hasMore ? "records" : "deleted" } } });
  });
}

async function markDeleted(tx: Store, input: IncomingSyncInput, snapshot: CrmJobSnapshot, reason: string, details: Prisma.InputJsonObject) {
  if (snapshot.isStale) return;
  await tx.crmJobSnapshot.update({ where: { id: snapshot.id }, data: { isStale: true } });
  await tx.auditLog.create({ data: { actorId: input.actor.id, companyId: snapshot.companyId, action: "CRM_SOURCE_UNAVAILABLE",
    entityType: "CrmJobSnapshot", entityId: snapshot.id, details: { crmOrganizationId: snapshot.crmOrganizationId,
      externalCrmId: snapshot.externalCrmId, reason, ...details, preservedNativeJobId: snapshot.canonicalJobId, providerFinancialWrites: 0 } } });
}

async function applyDeleted(input: IncomingSyncInput, context: Context, run: CrmImportRun, response: unknown) {
  const info = metadata(run), ordinal = info.deletedPage + 1, page = parseIncomingCrmDeletedPage(response, ordinal);
  return mutate(input, context, async (tx) => {
    const current = await currentRun(tx, context, run.id), saved = metadata(current);
    if (saved.phase !== "deleted" || saved.deletedPage !== info.deletedPage) throw fail("CRM_INCOMING_PAGE_CHANGED", "CRM deletion pagination advanced concurrently.");
    for (const deleted of page.records) {
      if (new Date(deleted.deleted_time).valueOf() > Date.now() + 300_000)
        throw fail("CRM_INCOMING_TIME_INVALID", "A CRM deletion has an invalid future timestamp.");
      const snapshot = await tx.crmJobSnapshot.findUnique({ where: {
        crmOrganizationId_dataCenter_environment_sourceModule_externalCrmId: { ...context.identity, externalCrmId: deleted.id } } });
      // A later live observation proves restoration; replaying an old deletion must not hide it.
      if (snapshot && new Date(deleted.deleted_time).valueOf() > Math.max(snapshot.lastSeenAt.valueOf(),
        snapshot.sourceModifiedAt ? new Date(snapshot.sourceModifiedAt).valueOf() || 0 : 0))
        await markDeleted(tx, input, snapshot, "provider_deleted", { deletedTime: deleted.deleted_time, deletionType: deleted.type, runId: run.id });
    }
    return tx.crmImportRun.update({ where: { id: run.id }, data: { fieldsJson: { ...saved, deletedPage: ordinal,
      phase: page.hasMore ? "deleted" : current.runKind === "FULL" ? "missing" : "link" } } });
  });
}

async function auditedCrmOwnership(tx: Store, context: Context, jobId: string, externalCrmId: string) {
  const audits = await tx.auditLog.findMany({ where: { entityType: "Job", entityId: jobId,
    action: { in: ["CRM_JOB_SELECTED", "CRM_JOB_BULK_IMPORTED", "CRM_JOB_INCOMING_CREATED"] } }, orderBy: { createdAt: "desc" }, take: 20 });
  for (const audit of audits) {
    if (!audit.details || typeof audit.details !== "object" || Array.isArray(audit.details)) continue;
    const proof = audit.details;
    if (proof.crmOrganizationId !== context.identity.crmOrganizationId || proof.externalCrmId !== externalCrmId) continue;
    if (proof.dataCenter === context.identity.dataCenter && proof.environment === context.identity.environment) return true;
    if (typeof proof.runId === "string" && await tx.crmImportRun.findFirst({ where: { id: proof.runId, ...context.identity }, select: { id: true } })) return true;
  }
  return false;
}

async function reconcileJob(tx: Store, input: IncomingSyncInput, context: Context, run: CrmImportRun, snapshot: CrmJobSnapshot) {
  const set = (linkStatus: string, canonicalJobId = snapshot.canonicalJobId) => tx.crmJobSnapshot.update({ where: { id: snapshot.id }, data: { linkStatus, canonicalJobId } });
  const projected = projectCrmJobSource(snapshot.sourceRecordJson as SourceRecord, context.mapping, context.assignments);
  if (projected.companyId !== snapshot.companyId) { await set("LOCAL_CONFLICT", null); return; }
  if (!snapshot.companyId || projected.linkStatus !== "PENDING") { await set(projected.linkStatus); return; }
  if (await tx.crmJobSnapshot.count({ where: { ...context.identity, isStale: false,
    companyId: snapshot.companyId, normalizedJobNumber: snapshot.normalizedJobNumber } }) !== 1) { await set("DUPLICATE_JOB_NUMBER"); return; }
  const mapped = mapCrmJob(snapshot.sourceRecordJson as Record<string, unknown>, context.mapping);
  const current = await tx.job.findUnique({ where: { companyId_externalCrmId: { companyId: snapshot.companyId, externalCrmId: snapshot.externalCrmId } } });
  const other = await tx.job.findFirst({ where: { externalCrmId: snapshot.externalCrmId, companyId: { not: snapshot.companyId },
    company: { crmSource: { organizationId: context.identity.crmOrganizationId, dataCenter: context.identity.dataCenter, environment: context.identity.environment } } }, select: { id: true } });
  const collision = await tx.job.findUnique({ where: { companyId_jobNumber: { companyId: snapshot.companyId, jobNumber: mapped.jobNumber } } });
  if (other || (collision && collision.id !== current?.id)) { await set("LOCAL_CONFLICT", current?.id ?? null); return; }
  if (current && current.currency !== mapped.currency && await tx.bill.count({ where: { jobId: current.id } })) {
    await set("SOURCE_CHANGED", current.id); return;
  }
  if (current && !context.mapping.approvedVariationsField && mapped.contractValue !== null &&
    new Prisma.Decimal(mapped.contractValue).plus(current.approvedVariations).lessThan(0)) {
    await set("SOURCE_CHANGED", current.id); return;
  }
  const data = { jobNumber: mapped.jobNumber, name: mapped.name, customer: mapped.customer, currency: mapped.currency,
    contractValue: mapped.contractValue, ...(context.mapping.approvedVariationsField ? { approvedVariations: mapped.approvedVariations } : {}) };
  const changed = current ? Object.entries(data).filter(([key, value]) => {
    const previous = current[key as keyof typeof data];
    return (previous instanceof Prisma.Decimal ? previous.toFixed(2) : previous) !== value;
  }).map(([key]) => key) : Object.keys(data);
  if (current && changed.length && snapshot.canonicalJobId !== current.id &&
    !await auditedCrmOwnership(tx, context, current.id, snapshot.externalCrmId)) {
    await set("LOCAL_CONFLICT", null); return;
  }
  let jobId = current?.id;
  if (!current) {
    jobId = (await tx.job.create({ data: { ...mapped, companyId: snapshot.companyId,
      isDemo: context.assignments.find((item) => item.companyId === snapshot.companyId)!.isDemo } })).id;
  } else if (changed.length) await tx.job.update({ where: { id: current.id }, data });
  await set("READY", jobId!);
  if (!current || changed.length) await tx.auditLog.create({ data: { actorId: input.actor.id, companyId: snapshot.companyId,
    action: current ? "CRM_JOB_INCOMING_UPDATED" : "CRM_JOB_INCOMING_CREATED", entityType: "Job", entityId: jobId!,
    details: { crmOrganizationId: run.crmOrganizationId, booksOrganizationId: snapshot.booksOrganizationId, externalCrmId: snapshot.externalCrmId,
      runId: run.id, snapshotId: snapshot.id, sourceModifiedAt: snapshot.sourceModifiedAt, changedFields: changed, providerFinancialWrites: 0 } } });
}

/** GET-only orchestration; each mutation is fenced by the worker's current source lease. */
export async function syncIncomingCrm(input: IncomingSyncInput): Promise<IncomingSyncResult> {
  const context = await incomingCrmSourceContext(input.actor, input.source);
  const maximum = z.number().int().min(2).max(500).parse(input.maxRequests);
  let requests = 0, processed = 0;
  if (input.stopped()) return { complete: false, continuation: input.continuation as Prisma.InputJsonValue ?? null, processed };
  const organization = z.object({ org: z.array(z.object({ zgid: idSchema.optional(), id: idSchema.optional(),
    type: z.enum(["production", "sandbox"]) })).length(1) }).safeParse(await input.get("/crm/v8/org")); requests++;
  if (!organization.success || (organization.data.org[0].zgid ?? organization.data.org[0].id) !== input.source.organizationId ||
    organization.data.org[0].type !== input.source.environment)
    throw fail("CRM_ORGANIZATION_MISMATCH", "CRM did not confirm the configured incoming source.");
  let run = await startOrResume(input, context);
  await input.checkpoint(continuation(run));
  let batches = 0;
  while (!input.stopped()) {
    const info = metadata(run);
    if (run.status === "COMPLETE" || info.phase === "done")
      return { complete: true, continuation: null, watermark: run.startedAt.toISOString(), reconciled: run.runKind === "FULL", processed };
    if (["records", "deleted", "missing"].includes(info.phase) && requests >= maximum) break;
    const headers = info.since ? { "If-Modified-Since": info.since } : undefined;
    if (info.phase === "records") {
      let response: unknown;
      requests++;
      try { response = await input.get(`/crm/v8/${context.mapping.jobModule}`, crmJobPageQuery(context.mapping, run.lastPage + 1, run.nextPageToken), headers); }
      catch (error) {
        if (!(error instanceof IntegrationError) || error.code !== "INCOMING_CURSOR_EXPIRED" || run.lastPage < 10) throw error;
        run = await restartExpiredCursor(input, context, run);
        await input.checkpoint(continuation(run));
        continue;
      }
      const before = run.snapshotCount;
      run = await applyRecords(input, context, run, response, new Date()); processed += run.snapshotCount - before;
    } else if (info.phase === "deleted") {
      if (info.deletedPage >= 500) throw fail("CRM_INCOMING_DELETIONS_LIMIT", "CRM deletion pagination exceeded its bounded reconciliation limit.");
      const response = await input.get(`/crm/v8/${context.mapping.jobModule}/deleted`, { type: "all", page: String(info.deletedPage + 1), per_page: "200" }, headers); requests++;
      run = await applyDeleted(input, context, run, response);
    } else if (info.phase === "missing") {
      const missing = await db.crmJobSnapshot.findFirst({ where: { ...context.identity, importRunId: { not: run.id }, isStale: false }, orderBy: { id: "asc" } });
      if (!missing) {
        run = await mutate(input, context, async (tx) => tx.crmImportRun.update({ where: { id: run.id }, data: { fieldsJson: { ...info, phase: "link" } } }));
      } else {
        let response: unknown;
        try { response = await input.get(`/crm/v8/${context.mapping.jobModule}/${missing.externalCrmId}`, { fields: crmJobImportFields(context.mapping).join(",") }); }
        catch (error) { if (!(error instanceof IntegrationError) || error.code !== "INCOMING_REMOTE_NOT_FOUND") throw error; response = null; }
        requests++;
        const fetchedAt = new Date();
        run = await mutate(input, context, async (tx) => {
          const current = await currentRun(tx, context, run.id);
          if (response === null) {
            const fresh = await tx.crmJobSnapshot.findUniqueOrThrow({ where: { id: missing.id } });
            if (fresh.importRunId !== run.id) await markDeleted(tx, input, fresh, "exact_record_unavailable", { runId: run.id });
            return current;
          }
          const exact = z.object({ data: z.array(z.object({ id: z.literal(missing.externalCrmId) }).loose()).length(1) }).safeParse(response);
          if (!exact.success || !z.json().safeParse(response).success) throw fail("CRM_INCOMING_RECORD_INVALID", "CRM did not return the exact missing record.");
          const count = await saveRecord(tx, context, current, (response as { data: SourceRecord[] }).data[0], fetchedAt);
          processed += count;
          return tx.crmImportRun.update({ where: { id: run.id }, data: { snapshotCount: { increment: count } } });
        });
      }
    } else {
      if (batches++ >= 4) break;
      run = await mutate(input, context, async (tx) => {
        const current = await currentRun(tx, context, run.id), saved = metadata(current);
        const snapshots = await tx.crmJobSnapshot.findMany({ where: { ...context.identity, isStale: false,
          companyId: { not: null }, normalizedJobNumber: { not: null }, ...(saved.linkAfterId ? { id: { gt: saved.linkAfterId } } : {}) },
          orderBy: { id: "asc" }, take: 50 });
        for (const snapshot of snapshots) await reconcileJob(tx, input, context, current, snapshot);
        if (snapshots.length === 50) return tx.crmImportRun.update({ where: { id: run.id }, data: { fieldsJson: { ...saved, linkAfterId: snapshots.at(-1)!.id } } });
        const scoped = { importRunId: run.id };
        const [snapshotCount, mappedCount, canonicalCount, unassignedCount] = await Promise.all([
          tx.crmJobSnapshot.count({ where: scoped }), tx.crmJobSnapshot.count({ where: { ...scoped, companyId: { not: null } } }),
          tx.crmJobSnapshot.count({ where: { ...scoped, linkStatus: "READY", isStale: false } }),
          tx.crmJobSnapshot.count({ where: { ...scoped, linkStatus: "UNASSIGNED_COMPANY" } }),
        ]);
        if (snapshotCount !== current.snapshotCount) throw fail("CRM_INCOMING_COUNT_MISMATCH", "CRM synchronization source counts do not reconcile.");
        const completed = await tx.crmImportRun.update({ where: { id: run.id }, data: { status: "COMPLETE", completedAt: new Date(),
          mappedCount, canonicalCount, unassignedCount, reviewCount: snapshotCount - canonicalCount - unassignedCount,
          fieldsJson: { ...saved, phase: "done" } } });
        await tx.auditLog.create({ data: { actorId: input.actor.id, action: "CRM_INCOMING_COMPLETED", entityType: "CrmImportRun", entityId: run.id,
          details: { crmOrganizationId: run.crmOrganizationId, runKind: run.runKind, snapshotCount, canonicalCount, providerFinancialWrites: 0 } } });
        return completed;
      });
    }
    await input.checkpoint(continuation(run));
  }
  return { complete: false, continuation: continuation(run), processed };
}
