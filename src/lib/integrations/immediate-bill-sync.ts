import "server-only";
import { after } from "next/server";
import type { IntegrationJob } from "@prisma/client";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { currentBooksMutation } from "./books-mutations";
import { snapshotHash, snapshotSchema } from "./books";
import { isLocalLiveTestSnapshot } from "./local-live-test";
import { isSupersededIntegrationJob } from "./source-supersession";
import { processIntegrationJobs } from "./queue";

type Writer = Pick<Actor, "id" | "role">;
export type SavedBillForImmediateSync = {
  id: string; companyId: string; version: number; status: string;
  syncRecords?: readonly { target: string; status: string; organizationId?: string | null }[];
};
type Scope = { actorId: string; actorRole: Writer["role"]; billId: string; companyId: string; sourceVersion: number; organizationId: string };
const activeBills = new Set<string>();
const maximumActive = 2, maximumOperations = 6;
const identity = /^[A-Za-z0-9_-]{1,100}$/;

function scopeFor(actor: Writer, bill: SavedBillForImmediateSync): Scope | null {
  if (!actor || !bill) return null;
  const records = Array.isArray(bill.syncRecords) ? bill.syncRecords.filter(record => record?.target === "ZOHO") : undefined;
  if (!["ADMIN", "ACCOUNTS", "DATA_ENTRY"].includes(actor.role) || ![actor.id, bill.id, bill.companyId].every(value => typeof value === "string" && identity.test(value)) ||
    !Number.isSafeInteger(bill.version) || bill.version < 1 || !["READY", "APPROVED"].includes(bill.status) || records?.length !== 1 ||
    records[0].status !== "PENDING" || !records[0].organizationId || !/^\d{1,30}$/.test(records[0].organizationId)) return null;
  return Object.freeze({ actorId: actor.id, actorRole: actor.role, billId: bill.id, companyId: bill.companyId,
    sourceVersion: bill.version, organizationId: records[0].organizationId });
}
function exactSource(job: IntegrationJob, scope: Scope) {
  const parsed = snapshotSchema.safeParse(job.snapshot);
  return !isSupersededIntegrationJob(job) && job.target === "ZOHO" && job.billId === scope.billId && job.initiatedById === scope.actorId &&
    job.organizationId === scope.organizationId && job.sourceVersion === scope.sourceVersion && !job.needsReconciliation && job.errorCode === null &&
    parsed.success && parsed.data.internalBillId === scope.billId && parsed.data.companyId === scope.companyId && parsed.data.initiatedById === scope.actorId &&
    parsed.data.sourceVersion === scope.sourceVersion && !!parsed.data.destination && !parsed.data.destination.liveAuthorizationId &&
    !isLocalLiveTestSnapshot(parsed.data) && snapshotHash(parsed.data) === job.payloadHash;
}
function freshQueued(job: IntegrationJob, scope: Scope) {
  return exactSource(job, scope) && job.status === "QUEUED" && job.attempts === 0 && job.reconciliationAttempts === 0 &&
    !job.leaseToken && !job.leaseUntil && job.nextAttemptAt.getTime() <= Date.now();
}

async function run(scope: Scope): Promise<{ processed: number }> {
  const key = `${scope.companyId}:${scope.billId}`;
  // No in-memory backlog: the persistent worker owns overflow and interruptions.
  if (activeBills.has(key) || activeBills.size >= maximumActive) return { processed: 0 };
  activeBills.add(key);
  let processed = 0;
  try {
    const actor = await db.user.findFirst({ where: { id: scope.actorId, active: true, role: scope.actorRole,
      memberships: { some: { companyId: scope.companyId, active: true, company: { active: true } } } }, select: { id: true } });
    const bill = await db.bill.findFirst({ where: { id: scope.billId, companyId: scope.companyId, version: scope.sourceVersion,
      status: { in: ["READY", "APPROVED"] }, ...(scope.actorRole === "ADMIN" ? {} : { createdById: scope.actorId }) },
      select: { id: true, syncRecords: { where: { target: "ZOHO" }, select: { status: true, organizationId: true } } } });
    if (!actor || !bill || bill.syncRecords.length !== 1 || bill.syncRecords[0].status !== "PENDING" || bill.syncRecords[0].organizationId !== scope.organizationId)
      return { processed };
    const initial = await currentBooksMutation(db, scope.billId);
    if (!initial || !exactSource(initial, scope) || !["CREATE_BILL", "UPDATE_BILL"].includes(initial.operation)) return { processed };
    if (freshQueued(initial, scope)) processed += (await processIntegrationJobs({ jobId: initial.id })).processed;
    else if (initial.status !== "SUCCEEDED" || !initial.externalId || initial.leaseToken || initial.leaseUntil) return { processed };
    const root = await currentBooksMutation(db, scope.billId);
    // The ordinary worker may win the primary race. Its confirmed exact root
    // only anchors new child jobs; this path never replays the primary write.
    if (!root || root.id !== initial.id || !exactSource(root, scope) || root.status !== "SUCCEEDED" || !root.externalId || root.operation !== "CREATE_BILL")
      return { processed };
    const source = snapshotSchema.parse(root.snapshot);
    const originalIds = new Set((source.attachmentMode === "bundle" ? source.documents.slice(0, 1) : source.documents).map(document => document.id));
    const children = await db.integrationJob.findMany({ where: { billId: scope.billId, target: "ZOHO", operation: "ATTACH_DOCUMENT",
      initiatedById: scope.actorId, organizationId: scope.organizationId, sourceVersion: scope.sourceVersion, payloadHash: root.payloadHash,
      externalId: root.externalId, status: "QUEUED", attempts: 0, reconciliationAttempts: 0, needsReconciliation: false, errorCode: null,
      leaseToken: null, leaseUntil: null, nextAttemptAt: { lte: new Date() } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: maximumOperations - 1 });
    for (const child of children) {
      if (!freshQueued(child, scope) || !child.documentId || !originalIds.has(child.documentId) || child.idempotencyKey !== `ZOHO:${scope.billId}:ATTACH_DOCUMENT:${child.documentId}` ||
        child.payloadHash !== root.payloadHash || child.externalId !== root.externalId) continue;
      const current = await currentBooksMutation(db, scope.billId);
      if (!current || current.id !== root.id || current.status !== "SUCCEEDED" || current.payloadHash !== root.payloadHash) break;
      const result = await processIntegrationJobs({ jobId: child.id });
      processed += result.processed;
      const outcome = await db.integrationJob.findUnique({ where: { id: child.id }, select: { status: true, needsReconciliation: true } });
      if (!result.processed || outcome?.status !== "SUCCEEDED" || outcome.needsReconciliation) break;
    }
  } catch {
    // Preserve the committed response and every durable job. Never expose error
    // bodies, provider tokens or invoice content in a best-effort fast path.
    console.error("Immediate bill synchronization stopped; the durable worker will continue.");
  } finally { activeBills.delete(key); }
  return { processed };
}

/** Internal exact-bill dispatch. Existing queue claims, leases and provider guards do all writes. */
export async function runImmediateBillSync(actor: Writer, bill: SavedBillForImmediateSync) {
  const scope = scopeFor(actor, bill);
  return scope ? run(scope) : { processed: 0 };
}

/** Call only after a successful mutation has committed and returned its saved bill. */
export function scheduleBillSyncAfterResponse(actor: Writer, bill: SavedBillForImmediateSync) {
  const scope = scopeFor(actor, bill);
  if (!scope) return false;
  try { after(async () => { await run(scope); }); return true; }
  catch {
    console.error("Immediate bill synchronization could not be scheduled; the durable worker will continue.");
    return false;
  }
}
