import "server-only";
import type { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { IntegrationError } from "./config";

export const SOURCE_SUPERSEDED = "SOURCE_SUPERSEDED";
const denied = (message: string) => new IntegrationError("SOURCE_CORRECTION_UNSAFE", message, "BLOCKED");
export function supersededSourceKey(target: string, billId: string, jobId: string) {
  if (![target, billId, jobId].every(value => /^[A-Za-z0-9_-]{1,100}$/.test(value)))
    throw denied("The source correction operation identity is invalid.");
  const key = `${target}:${billId}:CREATE_BILL:SUPERSEDED:${jobId}`;
  if (key.length > 255) throw denied("The archival operation key exceeds the supported database identifier length.");
  return key;
}
type OperationIdentity = { id: string; billId: string; target: string; operation: string; idempotencyKey: string; errorCode?: string | null };
export function isSupersededIntegrationJob(job: OperationIdentity) {
  return job.errorCode === SOURCE_SUPERSEDED || (job.operation === "CREATE_BILL" &&
    job.idempotencyKey === `${job.target}:${job.billId}:CREATE_BILL:SUPERSEDED:${job.id}`);
}
type RejectedOperation = OperationIdentity & {
  status: string; needsReconciliation: boolean; externalId: string | null; leaseToken: string | null;
  leaseUntil: Date | null; attempts: number;
};
type RejectedAttempt = { outcome: string; errorCode: string | null; externalId?: string | null };
const definiteCodes = new Set(["REMOTE_REJECTED", "VENDOR_VAT_TREATMENT_MISMATCH"]);
export function assertDefiniteSourceRejection(job: RejectedOperation, history: readonly RejectedAttempt[]) {
  if (job.target !== "ZOHO" || job.operation !== "CREATE_BILL" || isSupersededIntegrationJob(job) ||
    job.idempotencyKey !== `ZOHO:${job.billId}:CREATE_BILL` || !["FAILED", "BLOCKED"].includes(job.status) ||
    job.needsReconciliation || job.externalId || job.leaseToken || job.leaseUntil || job.attempts < 1 ||
    !definiteCodes.has(job.errorCode ?? "") || !history.length || history.length !== job.attempts || history.some(attempt =>
      !["FAILED", "BLOCKED"].includes(attempt.outcome) || !definiteCodes.has(attempt.errorCode ?? "") || attempt.externalId))
    throw denied("Only the original canonical bill with exclusively definite rejected attempts and no uncertain, processing or external outcome can be corrected.");
}

/** Stable hashes include dates/Decimals through their JSON representation. */
export function correctionStateHash(value: unknown): string {
  function canonical(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === "object") {
      if ("toJSON" in input && typeof input.toJSON === "function") return canonical(input.toJSON());
      return Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
    }
    return input;
  }
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export type SourceSupersessionQueueProof = Readonly<{ kind: "source-supersession" }>;
type QueueProof = {
  tx: Prisma.TransactionClient; actorId: string; companyId: string; billId: string; sourceVersion: number;
  organizationId: string; originalJobId: string; originalPayloadHash: string; originalSnapshotHash: string;
  expectedPayloadHash: string; syncRecordHash: string; auditId: string; consumed: boolean;
};
const queueProofs = new WeakMap<SourceSupersessionQueueProof, QueueProof>();
/** Internal only: the supported correction service issues this inside its locked transaction. */
export function sourceSupersessionQueueProof(proof: Omit<QueueProof, "consumed">): SourceSupersessionQueueProof {
  const capability = Object.freeze({ kind: "source-supersession" as const });
  queueProofs.set(capability, { ...proof, consumed: false });
  return capability;
}
export async function assertSourceSupersessionQueueProof(
  tx: Prisma.TransactionClient, proof: SourceSupersessionQueueProof, context: {
    actorId: string; companyId: string; billId: string; sourceVersion: number; organizationId: string;
    syncRecord: unknown;
  },
) {
  const held = queueProofs.get(proof);
  if (!held || held.consumed || held.tx !== tx || held.actorId !== context.actorId || held.companyId !== context.companyId ||
    held.billId !== context.billId || held.sourceVersion !== context.sourceVersion || held.organizationId !== context.organizationId ||
    held.syncRecordHash !== correctionStateHash(context.syncRecord)) throw denied("The correction enqueue authority does not match this exact transaction and saved source.");
  const [archived, audit] = await Promise.all([
    tx.integrationJob.findUnique({ where: { id: held.originalJobId } }),
    tx.auditLog.findUnique({ where: { id: held.auditId } }),
  ]);
  const details = audit?.details as Record<string, unknown> | null;
  if (!archived || archived.billId !== context.billId || archived.organizationId !== context.organizationId ||
    archived.target !== "ZOHO" || archived.operation !== "CREATE_BILL" ||
    archived.idempotencyKey !== supersededSourceKey(archived.target, archived.billId, archived.id) ||
    archived.status !== "CANCELLED" || archived.errorCode !== SOURCE_SUPERSEDED || archived.needsReconciliation || archived.externalId ||
    archived.leaseToken || archived.leaseUntil || !isSupersededIntegrationJob(archived) || archived.payloadHash !== held.originalPayloadHash ||
    correctionStateHash(archived.snapshot) !== held.originalSnapshotHash || !audit || audit.actorId !== context.actorId ||
    audit.companyId !== context.companyId || audit.entityId !== context.billId || audit.action !== "BILL_SOURCE_CORRECTION_PREPARED" ||
    details?.originalJobId !== archived.id || details?.newSourceVersion !== context.sourceVersion || details?.expectedPayloadHash !== held.expectedPayloadHash)
    throw denied("The original operation and audited source correction are not safely linked.");
}
export function consumeSourceSupersessionQueueProof(proof: SourceSupersessionQueueProof, payloadHash: string) {
  const held = queueProofs.get(proof);
  if (!held || held.consumed || held.expectedPayloadHash !== payloadHash) throw denied("The new canonical payload differs from the reviewed source correction.");
  held.consumed = true;
}
