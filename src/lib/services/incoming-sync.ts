import "server-only";
import { randomUUID } from "node:crypto";
import { Prisma, type IncomingSyncState } from "@prisma/client";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import { accessToken } from "@/lib/integrations/oauth";
import { IntegrationError } from "@/lib/integrations/config";
import { assertIncomingSource, incomingSources } from "./incoming-sync-access";
import { incomingSyncSettings } from "./incoming-sync-config";
import { createIncomingReader, IncomingBudgetError, IncomingQuotaError } from "./incoming-sync-transport";
import type { IncomingSource, IncomingSyncInput } from "./incoming-sync-types";
import { runIncomingBooksSync, syncIncomingBooksAttachments } from "./incoming-books-sync";
import { syncIncomingCrm } from "./incoming-crm-sync";

const txOptions = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 60_000 };
const identity = (source: IncomingSource) => ({ target: source.target, organizationId: source.organizationId, dataCenter: source.dataCenter, environment: source.environment });
function future(value: unknown) { const at = typeof value === "string" ? new Date(value) : null; return at && Number.isFinite(at.valueOf()) && at.valueOf() > Date.now() ? at : null; }
export function incomingConfiguredDelay(source: IncomingSource, env: NodeJS.ProcessEnv = process.env) {
  if (!env.INCOMING_SYNC_NOT_BEFORE_JSON) return null;
  const values: unknown = JSON.parse(env.INCOMING_SYNC_NOT_BEFORE_JSON);
  if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("Invalid incoming source cooldown configuration.");
  return future((values as Record<string, unknown>)[`${source.target}:${source.organizationId}`]);
}

async function seedState(actor: Actor, source: IncomingSource & { scopeHash: string }) {
  const existing = await db.incomingSyncState.findUnique({ where: { target_organizationId_dataCenter_environment: identity(source) } });
  if (existing) {
    if (existing.scopeHash !== source.scopeHash || existing.companyId !== source.companyId) {
      await db.incomingSyncState.updateMany({ where: { id: existing.id, OR: [{ leaseToken: null }, { leaseExpiresAt: { lt: new Date() } }] },
        data: { status: "BLOCKED", lastErrorCode: "INCOMING_SOURCE_CHANGED", lastHeartbeatAt: new Date() } });
      return null;
    }
    return existing;
  }
  // A verified completed inventory is a baseline, not evidence of a successful recurring check.
  const baseline = source.target === "ZOHO"
    ? await db.booksImportRun.findFirst({ where: { companyId: source.companyId!, organizationId: source.organizationId, dataCenter: source.dataCenter,
      environment: source.environment, status: "COMPLETE", listingComplete: true, runKind: "FULL" }, orderBy: { completedAt: "desc" } })
    : await db.crmImportRun.findFirst({ where: { crmOrganizationId: source.organizationId, dataCenter: source.dataCenter,
      environment: source.environment, status: "COMPLETE", listingComplete: true, runKind: "FULL" }, orderBy: { completedAt: "desc" } });
  const delay = incomingConfiguredDelay(source);
  return db.incomingSyncState.upsert({ where: { target_organizationId_dataCenter_environment: identity(source) }, update: {}, create: {
    ...identity(source), companyId: source.companyId, scopeHash: source.scopeHash,
    watermark: baseline?.startedAt ?? null, lastReconciledAt: baseline?.completedAt ?? null,
    nextRunAt: delay ?? new Date(), backoffUntil: delay, status: delay ? "WAITING_QUOTA" : "PENDING", lastHeartbeatAt: new Date(),
  } });
}

export async function assertIncomingLease(tx: Prisma.TransactionClient, actor: Actor, source: IncomingSource, state: Pick<IncomingSyncState, "id" | "scopeHash">, token: string) {
  const now = new Date();
  // UPDATE obtains the row lock inside the same transaction as each source mutation.
  const locked = await tx.incomingSyncState.updateMany({ where: { id: state.id, scopeHash: state.scopeHash, leaseToken: token, leaseExpiresAt: { gt: now } },
    data: { leaseExpiresAt: new Date(now.valueOf() + incomingSyncSettings().leaseSeconds * 1000), lastHeartbeatAt: now } });
  if (locked.count !== 1) throw new IntegrationError("INCOMING_LEASE_LOST", "Another worker owns this source. No further changes were applied.", "BLOCKED");
  await assertIncomingSource(actor, source, state.scopeHash, tx);
}

export async function processIncomingSync(actor: Actor, options: { signal?: AbortSignal; externalDelay?: (source: IncomingSource) => Promise<Date | null> } = {}) {
  const settings = incomingSyncSettings();
  if (!settings.enabled) return { enabled: false, processed: 0, sources: 0 };
  const sources = await incomingSources(actor);
  let processed = 0;
  for (const source of sources) {
    if (options.signal?.aborted) break;
    let state = await seedState(actor, source);
    if (!state) continue;
    await db.incomingSyncState.updateMany({ where: { id: state.id, scopeHash: source.scopeHash }, data: { lastHeartbeatAt: new Date() } });
    let delay = incomingConfiguredDelay(source);
    const external = await options.externalDelay?.(source);
    if (external && (!delay || external > delay)) delay = external;
    if (delay && (!state.backoffUntil || delay > state.backoffUntil)) {
      await db.incomingSyncState.updateMany({ where: { id: state.id, OR: [{ leaseToken: null }, { leaseExpiresAt: { lt: new Date() } }] },
        data: { status: "WAITING_QUOTA", nextRunAt: delay, backoffUntil: delay, lastErrorCode: "INCOMING_KNOWN_COOLDOWN" } });
      continue;
    }
    // A shorter configured interval may advance only a healthy, completed schedule.
    // Retry/quota waits, resumable work and another worker's lease retain their exact timing.
    if (state.lastSuccessAt && state.status === "IDLE") {
      const earlier = new Date(state.lastSuccessAt.valueOf() + settings.intervalSeconds * 1000);
      if (earlier < state.nextRunAt) await db.incomingSyncState.updateMany({ where: {
        id: state.id, scopeHash: source.scopeHash, status: "IDLE", lastSuccessAt: state.lastSuccessAt,
        nextRunAt: state.nextRunAt, failures: 0, lastErrorCode: null, backoffUntil: null,
        checkpoint: { equals: Prisma.DbNull }, leaseToken: null, leaseExpiresAt: null,
      }, data: { nextRunAt: earlier } });
    }
    const now = new Date(), token = randomUUID();
    const claimed = await db.incomingSyncState.updateMany({ where: { id: state.id, scopeHash: source.scopeHash, nextRunAt: { lte: now },
      OR: [{ leaseToken: null }, { leaseExpiresAt: { lte: now } }] }, data: { leaseToken: token,
      leaseExpiresAt: new Date(now.valueOf() + settings.leaseSeconds * 1000), status: "RUNNING", lastAttemptAt: now, lastHeartbeatAt: now, backoffUntil: null } });
    if (!claimed.count) continue;
    state = (await db.incomingSyncState.findUnique({ where: { id: state.id } }))!;
    const owned = { id: state.id, leaseToken: token };
    const leased = state;
    const guard = async () => {
      await db.$transaction(tx => assertIncomingLease(tx, actor, source, leased, token), txOptions);
      const current = await db.incomingSyncState.findUnique({ where: { id: leased.id }, select: { backoffUntil: true } });
      if (current?.backoffUntil && current.backoffUntil > new Date()) throw new IncomingQuotaError(current.backoffUntil);
      const external = await options.externalDelay?.(source);
      if (external && external > new Date()) throw new IncomingQuotaError(external, "INCOMING_KNOWN_COOLDOWN");
    };
    const checkpoint = async (value: Prisma.InputJsonValue | null, transaction?: Prisma.TransactionClient) => {
      const write = async (tx: Prisma.TransactionClient) => { await assertIncomingLease(tx, actor, source, leased, token);
        await tx.incomingSyncState.update({ where: { id: leased.id }, data: { checkpoint: value === null ? Prisma.DbNull : value } }); };
      if (transaction) await write(transaction);
      else await db.$transaction(write, txOptions);
    };
    try {
      const config = await assertIncomingSource(actor, source, state.scopeHash);
      const reader = createIncomingReader({ config, token: () => accessToken(config), guard, signal: options.signal,
        intervalMs: settings.requestIntervalMs, maxRequests: settings.maxRequests,
        reserve: async () => { const count = await db.incomingSyncState.updateMany({ where: owned, data: { providerReads: { increment: 1 } } }); if (!count.count) throw new IncomingBudgetError(); },
        cooldown: async until => { await db.incomingSyncState.updateMany({ where: owned, data: { backoffUntil: until, nextRunAt: until } }); },
      });
      const mode = !state.lastReconciledAt || now.valueOf() - state.lastReconciledAt.valueOf() >= settings.reconcileSeconds * 1000 ? "reconcile" : "incremental";
      const input: IncomingSyncInput = { actor, source, mode, watermark: state.watermark?.toISOString() ?? null, continuation: state.checkpoint,
        get: reader.get, getBytes: reader.getBytes, assertLease: tx => assertIncomingLease(tx, actor, source, leased, token), checkpoint,
        maxRequests: settings.maxRequests, stopped: () => options.signal?.aborted ?? false };
      const result = await (source.target === "ZOHO" ? runIncomingBooksSync(input) : syncIncomingCrm(input));
      processed += result.processed;
      await db.$transaction(async tx => {
        await assertIncomingLease(tx, actor, source, leased, token);
        const current = await tx.incomingSyncState.findUniqueOrThrow({ where: { id: leased.id } });
        const cooldown = current.backoffUntil && current.backoffUntil > new Date() ? current.backoffUntil : null;
        const successAt = new Date();
        await tx.incomingSyncState.update({ where: { id: leased.id }, data: {
          ...(result.continuation !== undefined ? { checkpoint: result.continuation === null ? Prisma.DbNull : result.continuation } : {}),
          ...(result.complete ? { checkpoint: Prisma.DbNull, watermark: result.watermark ? new Date(result.watermark) : current.watermark,
            lastSuccessAt: successAt, ...(result.reconciled ? { lastReconciledAt: successAt } : {}) } : {}),
          status: cooldown ? "WAITING_QUOTA" : result.complete ? "IDLE" : "PENDING", failures: 0, lastErrorCode: null,
          nextRunAt: cooldown ?? new Date(successAt.valueOf() + (result.complete ? settings.intervalSeconds : 5) * 1000),
          processedCount: { increment: result.processed }, lastHeartbeatAt: successAt,
        } });
      }, txOptions);
      // Metadata freshness is committed before originals; file backlog never holds back bill updates.
      if (result.complete && source.target === "ZOHO" && settings.attachmentsEnabled && reader.remaining() > 0 && !options.signal?.aborted)
        await syncIncomingBooksAttachments({ ...input, maxRequests: reader.remaining() });
    } catch (error) {
      const quota = error instanceof IncomingQuotaError;
      const yielded = error instanceof IncomingBudgetError;
      const blocked = error instanceof IntegrationError && error.kind === "BLOCKED" || error instanceof HttpError && [401, 403, 404].includes(error.status);
      const failures = Math.min(state.failures + 1, 12);
      const next = quota ? error.until : new Date(Date.now() + (yielded ? 5000 : blocked ? 3600_000 : Math.min(3600_000, 30_000 * 2 ** Math.min(failures, 7))));
      await db.incomingSyncState.updateMany({ where: owned, data: { status: quota ? "WAITING_QUOTA" : yielded ? "PENDING" : blocked ? "BLOCKED" : "RETRY",
        lastErrorCode: error instanceof IntegrationError ? error.code : error instanceof HttpError ? `INCOMING_HTTP_${error.status}` : "INCOMING_CHECK_FAILED",
        failures: yielded || quota ? state.failures : failures, nextRunAt: next, ...(quota ? { backoffUntil: next } : {}), lastHeartbeatAt: new Date() } });
    } finally {
      await db.incomingSyncState.updateMany({ where: owned, data: { leaseToken: null, leaseExpiresAt: null } });
    }
  }
  return { enabled: true, processed, sources: sources.length };
}
