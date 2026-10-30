import "server-only";
import { isManualEntryOnly } from "@/lib/application-mode";
import { createHash, randomUUID } from "node:crypto";
import {
  Prisma,
  type IntegrationJob,
  type IntegrationJobStatus,
} from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import type { Actor } from "@/lib/auth";
import { HttpError } from "@/lib/http";
import { readPrivateDocument } from "@/lib/services/documents";
import {
  BooksAdapter,
  buildBooksPayload,
  booksMappingFingerprint,
  snapshotHash,
  snapshotSchema,
  type BillSnapshot,
  type SupplierBillAdapter,
} from "./books";
import {
  assertWrite,
  getConfig,
  getBooksOrganizations,
  IntegrationError,
  retryAt,
  safeFailure,
  type Target,
} from "./config";
import { accessToken } from "./oauth";
import { ZohoTransport } from "./transport";
import { destinationCompanyForActor, requireDestinationForCompany } from "./company-destination";
import { assertSourceBooksLineTaxMode, sourceInclude } from "./source-snapshot";
export { approvedSnapshot } from "./source-snapshot";
export { previewLiveBillSync } from "./live-sync";
import { confirmLiveSnapshot, recordLiveConfirmation, assertLiveJobPermission, assertLiveJobWrite, assertJobReconciliationAccess, assertSynchronizationActor, savedSourceSnapshot, type LiveSyncConfirmation } from "./live-sync";
import { createLocalLiveTestWriteCapability, isLocalLiveTestSnapshot, prepareLocalLiveTestSnapshot,
  recordLocalLiveTestConfirmation } from "./local-live-test";

function financeRole(actor: Actor) {
  if (!["ADMIN", "ACCOUNTS", "DATA_ENTRY"].includes(actor.role))
    throw new HttpError(
      403,
      "Only the bill creator or accounting staff can manage synchronization.",
    );
}
async function billCompany(tx: Prisma.TransactionClient, billId: string) {
  return (await tx.bill.findUniqueOrThrow({ where: { id: billId }, select: { companyId: true } })).companyId;
}
async function selectedBooksConfig(tx: Prisma.TransactionClient, companyId: string, organizationId?: string) {
  const destinations = await tx.companyIntegrationDestination.findMany({ where: { companyId, target: "ZOHO", company: { active: true } } });
  const profiles = getBooksOrganizations().filter(profile => (!organizationId || profile.organizationId === organizationId) &&
    destinations.some(destination => destination.organizationId === profile.organizationId));
  const matches = profiles.map(profile => getConfig("ZOHO", process.env, profile.organizationId)).filter(config =>
    destinations.some(destination => destination.organizationId === config.organizationId && destination.dataCenter === config.dataCenter && destination.environment === config.environment));
  if (matches.length !== 1) throw new IntegrationError(matches.length ? "ORGANIZATION_REQUIRED" : "COMPANY_DESTINATION_MISMATCH",
    matches.length ? "More than one Books destination is assigned to this company. Select the intended destination." : "Configure an exact Books destination for this company before synchronization.", "BLOCKED");
  return matches[0];
}
async function enqueueTx(
  tx: Prisma.TransactionClient,
  billId: string,
  target: Target,
  actorId?: string,
  organizationId?: string,
  confirmation?: LiveSyncConfirmation,
) {
  if (target === "CRM")
    throw new IntegrationError(
      "CRM_EXPENSE_MODULE_UNVERIFIED",
      "No supplier-expense module and unique bill-reference field have been verified in CRM. Job-summary access is available separately.",
      "BLOCKED",
    );
  // A canonical bill may acquire only one Books destination. Serialize routing
  // decisions without modifying invoice amounts or the user's edit version.
  await tx.$queryRaw(
    Prisma.sql`SELECT \`id\` FROM \`Bill\` WHERE \`id\`=${billId} FOR UPDATE`,
  );
  const bill = await tx.bill.findUnique({
    where: { id: billId },
    include: sourceInclude,
  });
  if (!bill) throw new HttpError(404, "Bill not found.");
  await assertSynchronizationActor(tx, bill, actorId ?? "");
  assertSourceBooksLineTaxMode(bill);
  const config = await selectedBooksConfig(tx, bill.companyId, organizationId);
  const localTest = config.environment === "production"
    ? await prepareLocalLiveTestSnapshot(tx, bill, config, actorId ?? "") : null;
  if (!localTest) assertWrite(config);
  await requireDestinationForCompany(config, bill.companyId, tx);
  if (actorId && await destinationCompanyForActor({ id: actorId }, config, tx) !== bill.companyId)
    throw new HttpError(404, "Bill not found in the selected company.");
  if (!["READY", "APPROVED"].includes(bill.status))
    throw new HttpError(
      409,
      "Only a finalized bill can be queued for external synchronization.",
    );
  if (!localTest && (bill.job.isDemo || bill.vendor.isDemo)) {
    if (config.environment !== "sandbox")
      throw new IntegrationError(
        "DEMO_PRODUCTION_FORBIDDEN",
        "Fictional demo records cannot be sent to a production organization.",
        "BLOCKED",
      );
  }
  const existing = await tx.integrationJob.findUnique({
    where: { idempotencyKey: `${target}:${bill.id}:CREATE_BILL` },
  });
  // Existing legacy permissions remain immutable history. Newly saved or
  // explicitly queued bills bind their creator directly and need no challenge.
  const live = !localTest && config.environment === "production" && confirmation
    ? await confirmLiveSnapshot(tx, bill, config, actorId ?? "", confirmation) : undefined;
  if (existing) {
    if (existing.organizationId !== config.organizationId)
      throw new HttpError(
        409,
        "This bill is already assigned to another external organization.",
      );
    const original = snapshotSchema.safeParse(existing.snapshot);
    if (
      !original.success ||
      !original.data.destination ||
      original.data.destination.dataCenter !== config.dataCenter ||
      original.data.destination.environment !== config.environment
    )
      throw new HttpError(
        409,
        "This bill's existing Books destination cannot be reassigned across data centers or environments.",
      );
    if (localTest || live) {
      const permission = localTest ?? live!;
      if (existing.payloadHash !== snapshotHash(permission.snapshot)) throw new HttpError(409, "The live confirmation differs from the original operation.");
      if (localTest) await recordLocalLiveTestConfirmation(tx, localTest.permit.id, existing, actorId!, bill.companyId);
      else await recordLiveConfirmation(tx, live!.permit.id, existing, actorId!, bill.companyId);
    }
    return existing;
  }
  const record = await tx.syncRecord.findUnique({
    where: { billId_target: { billId, target } },
  });
  if (record?.organizationId && record.organizationId !== config.organizationId)
    throw new HttpError(
      409,
      "This bill already has a different Books organization. Its destination cannot be reassigned.",
    );
  if (record?.externalId)
    throw new HttpError(
      409,
      "An external bill ID already exists. Reconcile the existing record rather than creating again.",
    );
  if (
    record &&
    (["PENDING", "UNKNOWN", "SYNCED"].includes(record.status) ||
      record.attempts > 0)
  )
    throw new HttpError(
      409,
      "This bill has legacy synchronization activity without a canonical queue operation. Reconcile its original external outcome before assigning a destination.",
    );
  const vendorMapping = await tx.vendorBooksMapping.findUnique({
    where: {
      vendorId_organizationId_dataCenter_environment: {
        vendorId: bill.vendorId,
        organizationId: config.organizationId,
        dataCenter: config.dataCenter,
        environment: config.environment,
      },
    },
  });
  if (!vendorMapping)
    throw new IntegrationError(
      "VENDOR_MAPPING_REQUIRED",
      "Map this vendor to an existing supplier in the selected Books organization and environment before synchronization.",
      "BLOCKED",
    );
  const snapshot = localTest?.snapshot ?? live?.snapshot ?? await savedSourceSnapshot(tx, bill, config, actorId!);
  buildBooksPayload(snapshot, config);
  const job = await tx.integrationJob.create({
    data: {
      billId,
      initiatedById: localTest || live ? null : actorId,
      target,
      operation: "CREATE_BILL",
      idempotencyKey: `${target}:${bill.id}:CREATE_BILL`,
      organizationId: config.organizationId,
      sourceVersion: bill.version,
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
      payloadHash: snapshotHash(snapshot),
    },
  });
  if (localTest) await recordLocalLiveTestConfirmation(tx, localTest.permit.id, job, actorId!, bill.companyId);
  else if (live) await recordLiveConfirmation(tx, live.permit.id, job, actorId!, bill.companyId);
  await tx.syncRecord.upsert({
    where: { billId_target: { billId, target } },
    create: {
      billId,
      target,
      status: "PENDING",
      organizationId: config.organizationId,
    },
    update: {
      status: "PENDING",
      organizationId: config.organizationId,
      lastError: null,
    },
  });
  await tx.auditLog.create({
    data: {
      actorId,
      companyId: bill.companyId,
      action: "SYNC_QUEUED",
      entityType: "Bill",
      entityId: billId,
      details: {
        jobId: job.id,
        target,
        operation: job.operation,
        sourceVersion: bill.version,
        organizationId: config.organizationId,
        authorizationReference:
          snapshot.destination?.authorizationReference ?? config.testAuthorization?.approvalReference ?? null,
      },
    },
  });
  return job;
}
export async function queueBill(
  actor: Actor,
  billId: string,
  target: Target,
  organizationId?: string,
  confirmation?: LiveSyncConfirmation,
) {
  financeRole(actor);
  return db.$transaction(
    (tx) => enqueueTx(tx, billId, target, actor.id, organizationId, confirmation),
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 20_000,
    },
  );
}
export async function enqueueApprovedBillTx(
  tx: Prisma.TransactionClient,
  billId: string,
  actorId: string,
) {
  let ready = false;
  try {
    if (getBooksOrganizations().length !== 1) return;
    const config = getConfig("ZOHO");
    // An approval is never consent to a production financial operation.
    if (config.environment === "production") return;
    ready =
      config.networkEnabled &&
      config.writeEnabled &&
      Boolean(config.booksMapping);
  } catch {
    return;
  }
  if (!ready) return;
  try {
    await enqueueTx(tx, billId, "ZOHO", actorId);
  } catch (error) {
    if (error instanceof IntegrationError) {
      await tx.syncRecord.updateMany({
        where: { billId, target: "ZOHO" },
        data: { status: "FAILED", lastError: error.message },
      });
      await tx.auditLog.create({
        data: {
          actorId,
          companyId: await billCompany(tx, billId),
          action: "SYNC_CONFIGURATION_BLOCKED",
          entityType: "Bill",
          entityId: billId,
          details: { code: error.code, target: "ZOHO" },
        },
      });
      return;
    }
    throw error;
  }
}
/** Final-save scheduling is best-effort setup work, never an approval step. */
export async function enqueueReadyBillTx(tx: Prisma.TransactionClient, billId: string, actorId: string, organizationId?: string) {
  const bill = await tx.bill.findUnique({ where: { id: billId }, include: sourceInclude });
  if (!bill) throw new HttpError(404, "Bill not found.");
  await assertSynchronizationActor(tx, bill, actorId);
  if (!["READY", "APPROVED"].includes(bill.status)) throw new HttpError(409, "Finalize the bill before synchronization.");
  if (isManualEntryOnly()) return null;
  try {
    return await enqueueTx(tx, billId, "ZOHO", actorId, organizationId);
  } catch (error) {
    if (!(error instanceof IntegrationError) && !(error instanceof HttpError)) throw error;
    const record = await tx.syncRecord.findUnique({ where: { billId_target: { billId, target: "ZOHO" } } });
    if (!record) await tx.syncRecord.create({ data: { billId, target: "ZOHO", status: "FAILED", lastError: error.message } });
    else if (!record.externalId && !["PENDING", "UNKNOWN", "SYNCED"].includes(record.status) && record.attempts === 0)
      await tx.syncRecord.update({ where: { billId_target: { billId, target: "ZOHO" } }, data: { status: "FAILED", lastError: error.message } });
    await tx.auditLog.create({ data: { actorId, companyId: bill.companyId, action: "SYNC_CONFIGURATION_BLOCKED", entityType: "Bill", entityId: billId,
      details: { code: error instanceof IntegrationError ? error.code : "SYNC_ACCESS_BLOCKED", target: "ZOHO" } } });
    return null;
  }
}
export async function assertBillCancellationSyncSafe(
  tx: Prisma.TransactionClient,
  billId: string,
) {
  const records = await tx.syncRecord.findMany({ where: { billId } });
  if (
    records.some(
      (r) =>
        r.externalId || ["PENDING", "UNKNOWN", "SYNCED"].includes(r.status),
    )
  )
    throw new HttpError(
      409,
      "This bill has pending, uncertain or confirmed external accounting activity. Reconcile it and use an authorized reversal before cancelling locally.",
    );
}
export async function listIntegrationJobs(
  actor: Actor,
  organizationId?: string,
) {
  if (!["ADMIN", "ACCOUNTS", "MANAGEMENT"].includes(actor.role))
    throw new HttpError(
      403,
      "Your role cannot view the integration reconciliation queue.",
    );
  if (organizationId && !/^\d{1,30}$/.test(organizationId))
    throw new HttpError(422, "Invalid Books organization selection.");
  const jobs = await db.integrationJob.findMany({
    where: {
      ...(organizationId ? { organizationId } : {}),
      bill: { company: { active: true, memberships: { some: { userId: actor.id, active: true, user: { active: true } } } } },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      bill: { select: { invoiceNumber: true } },
      history: { orderBy: { finishedAt: "desc" }, take: 10 },
    },
  });
  return {
    jobs: jobs.map((job) => ({
      id: job.id,
      billId: job.billId,
      organizationId: job.organizationId,
      target: job.target,
      operation: job.operation,
      status: job.status,
      attempts: job.attempts,
      reconciliationAttempts: job.reconciliationAttempts,
      needsReconciliation: job.needsReconciliation,
      nextAttemptAt: job.nextAttemptAt,
      lastError: job.lastError,
      errorCode: job.errorCode,
      externalId: job.externalId,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      bill: job.bill,
      history: job.history,
    })),
  };
}
export async function scheduleIntegrationJob(
  actor: Actor,
  id: string,
  payload: unknown,
) {
  financeRole(actor);
  const input = z
    .object({
      action: z.enum(["retry", "reconcile"]),
      organizationId: z
        .string()
        .regex(/^\d{1,30}$/)
        .optional(),
    })
    .strict()
    .parse(payload);
  return db.$transaction(
    async (tx) => {
      const job = await tx.integrationJob.findFirst({ where: { id, bill: { company: { active: true, memberships: { some: { userId: actor.id, active: true, user: { active: true } } } } } } });
      if (!job) throw new HttpError(404, "Synchronization job not found.");
      const source = await tx.bill.findUniqueOrThrow({ where: { id: job.billId }, include: sourceInclude });
      await assertSynchronizationActor(tx, source, actor.id);
      if (input.organizationId && input.organizationId !== job.organizationId)
        throw new HttpError(
          409,
          "This operation belongs to a different Books organization. Its destination cannot be changed.",
        );
      if (job.status === "PROCESSING" || job.status === "SUCCEEDED")
        throw new HttpError(
          409,
          "This operation is already processing or confirmed.",
        );
      if (
        input.action === "retry" &&
        (job.needsReconciliation || job.status === "UNKNOWN")
      )
        throw new HttpError(
          409,
          "The external outcome is uncertain. Choose reconciliation; creating again is not safe.",
        );
      if (input.action === "reconcile" && job.attempts === 0 && !job.externalId)
        throw new HttpError(
          409,
          "No external operation has been attempted yet.",
        );
      let config;
      try {
        config = getConfig(job.target, process.env, job.organizationId);
      } catch (error) {
        if (
          error instanceof IntegrationError &&
          error.code === "ORGANIZATION_NOT_CONFIGURED"
        )
          throw new HttpError(
            409,
            "Restore the original organization configuration before retrying this operation.",
          );
        throw error;
      }
      if (config.organizationId !== job.organizationId)
        throw new HttpError(
          409,
          "Restore the original organization configuration before retrying this operation.",
        );
      if (input.action === "retry") {
        if (isLocalLiveTestSnapshot(snapshotSchema.parse(job.snapshot))) await assertLiveJobPermission(job, config);
        else assertWrite(config);
      }
      const updated = await tx.integrationJob.update({
        where: { id },
        data: {
          status: "QUEUED",
          needsReconciliation:
            input.action === "reconcile" || job.needsReconciliation,
          nextAttemptAt: new Date(),
          lastError: null,
          leaseToken: null,
          leaseUntil: null,
        },
      });
      const uncertain = await tx.integrationJob.count({
        where: {
          billId: job.billId,
          target: job.target,
          OR: [
            { status: "UNKNOWN" },
            { needsReconciliation: true, status: { not: "SUCCEEDED" } },
          ],
        },
      });
      await tx.syncRecord.updateMany({
        where: { billId: job.billId, target: job.target },
        data: {
          status: uncertain ? "UNKNOWN" : "PENDING",
          lastError: uncertain
            ? "An external outcome is awaiting reconciliation."
            : null,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          companyId: await billCompany(tx, job.billId),
          action: "SYNC_RETRY_SCHEDULED",
          entityType: "Bill",
          entityId: job.billId,
          details: {
            jobId: id,
            organizationId: job.organizationId,
            mode: input.action,
            authorizationReference:
              config.testAuthorization?.approvalReference ?? null,
          },
        },
      });
      return {
        job: {
          id: updated.id,
          status: updated.status,
          needsReconciliation: updated.needsReconciliation,
        },
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export type AdapterFactory = (
  target: Target,
  organizationId: string,
  job: IntegrationJob,
) => SupplierBillAdapter;
function productionAdapter(target: Target, organizationId: string, job: IntegrationJob) {
  if (target !== "ZOHO")
    throw new IntegrationError(
      "CRM_EXPENSE_MODULE_UNVERIFIED",
      "CRM expense posting is not configured.",
      "BLOCKED",
    );
  const config = getConfig(target, process.env, organizationId);
  if (config.organizationId !== organizationId)
    throw new IntegrationError(
      "ORGANIZATION_CHANGED",
      "This job belongs to another organization configuration.",
      "BLOCKED",
    );
  const localTestCapability = !job.needsReconciliation && isLocalLiveTestSnapshot(snapshotSchema.parse(job.snapshot))
    ? createLocalLiveTestWriteCapability(job.id, job.leaseToken ?? "") : undefined;
  return new BooksAdapter(new ZohoTransport(config, () => accessToken(config), fetch,
    config.environment === "production" || job.initiatedById ? request => assertLiveJobWrite(job.id, job.leaseToken ?? "", request) : undefined,
    localTestCapability));
}
async function recoverExpiredLeases(jobId?: string) {
  const ids = await db.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT \`id\` FROM \`IntegrationJob\`
    WHERE \`status\`='PROCESSING' AND \`leaseUntil\` < ${new Date()}
    ${jobId ? Prisma.sql`AND \`id\`=${jobId}` : Prisma.sql`AND (\`initiatedById\` IS NOT NULL OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(\`snapshot\`, '$.destination.environment')), '') <> 'production')`}
    ORDER BY \`leaseUntil\`, \`id\` LIMIT 25`);
  if (!ids.length) return;
  const expired = await db.integrationJob.findMany({
    where: { id: { in: ids.map(item => item.id) }, status: "PROCESSING", leaseUntil: { lt: new Date() } },
    take: 25,
  });
  for (const job of expired)
    await db.$transaction(async (tx) => {
      const changed = await tx.integrationJob.updateMany({
        where: {
          id: job.id,
          status: "PROCESSING",
          leaseToken: job.leaseToken,
          leaseUntil: { lt: new Date() },
        },
        data: {
          status: "UNKNOWN",
          needsReconciliation: true,
          leaseUntil: null,
          leaseToken: null,
          errorCode: "WORKER_LEASE_EXPIRED",
          lastError:
            "The worker stopped before confirming the external outcome. Reconciliation is required.",
        },
      });
      if (changed.count) {
        await tx.syncRecord.updateMany({
          where: { billId: job.billId, target: job.target },
          data: {
            status: "UNKNOWN",
            lastError:
              "Worker interrupted; external outcome requires reconciliation.",
          },
        });
        await tx.integrationAttempt.create({
          data: {
            jobId: job.id,
            operation: "LEASE_RECOVERY",
            outcome: "UNKNOWN",
            errorCode: "WORKER_LEASE_EXPIRED",
            safeError:
              "Worker interrupted; reconcile the external outcome before further writes.",
            startedAt: job.lastAttemptAt ?? job.createdAt,
          },
        });
        await tx.auditLog.create({
          data: {
            companyId: await billCompany(tx, job.billId),
            action: "SYNC_LEASE_EXPIRED",
            entityType: "Bill",
            entityId: job.billId,
            details: {
              target: job.target,
              organizationId: job.organizationId,
              jobId: job.id,
              operation: job.operation,
              outcome: "UNKNOWN",
            },
          },
        });
      }
    });
}
async function claimJob(jobId?: string) {
  const now = new Date();
  return db.$transaction(async (tx) => {
    const selected = await tx.$queryRaw<
      {
        id: string;
        billId: string;
        target: Target;
        needsReconciliation: boolean;
      }[]
    >(
      Prisma.sql`SELECT j.\`id\`,j.\`billId\`,j.\`target\`,j.\`needsReconciliation\` FROM \`IntegrationJob\` j WHERE j.\`status\` IN ('QUEUED','RETRY') AND j.\`nextAttemptAt\` <= ${now} ${jobId ? Prisma.sql`AND j.\`id\`=${jobId}` : Prisma.sql`AND (j.\`initiatedById\` IS NOT NULL OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(j.\`snapshot\`, '$.destination.environment')), '') <> 'production')`} AND NOT EXISTS (SELECT 1 FROM \`IntegrationJob\` sibling WHERE sibling.\`billId\`=j.\`billId\` AND sibling.\`target\`=j.\`target\` AND (sibling.\`status\`='PROCESSING' OR ((sibling.\`status\`='UNKNOWN' OR (sibling.\`needsReconciliation\` AND sibling.\`status\`<>'SUCCEEDED')) AND NOT j.\`needsReconciliation\`))) ORDER BY j.\`nextAttemptAt\`, j.\`createdAt\`,j.\`id\` LIMIT 1 FOR UPDATE OF j SKIP LOCKED`,
    );
    if (!selected.length) return null;
    const candidate = selected[0];
    // Two distinct attachment jobs share one remote attachment resource. Lock
    // the owning bill while claiming, then recheck committed sibling activity.
    const locked = await tx.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT \`id\` FROM \`Bill\` WHERE \`id\`=${candidate.billId} FOR UPDATE SKIP LOCKED`,
    );
    if (!locked.length) return null;
    const active = await tx.integrationJob.count({
      where: {
        billId: candidate.billId,
        target: candidate.target,
        id: { not: candidate.id },
        OR: candidate.needsReconciliation
          ? [{ status: "PROCESSING" }]
          : [
              { status: "PROCESSING" },
              { status: "UNKNOWN" },
              { needsReconciliation: true, status: { not: "SUCCEEDED" } },
            ],
      },
    });
    if (active) return null;
    return tx.integrationJob.update({
      where: { id: selected[0].id },
      data: {
        status: "PROCESSING",
        leaseToken: randomUUID(),
        leaseUntil: new Date(now.getTime() + 180_000),
        lastAttemptAt: now,
        attempts: { increment: 1 },
      },
    });
  }, {
    // The candidate query contains a consistent-read subquery. Under MySQL's
    // default REPEATABLE READ it can freeze a view before the bill lock changes
    // hands, hiding another worker's committed PROCESSING sibling from count().
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  });
}
export function failureState(
  error: IntegrationError,
  attempts: number,
  reconciling: boolean,
): { status: IntegrationJobStatus; needsReconciliation: boolean } {
  if (reconciling || error.kind === "UNKNOWN")
    return { status: "UNKNOWN", needsReconciliation: true };
  if (error.kind === "BLOCKED")
    return { status: "BLOCKED", needsReconciliation: false };
  if (error.kind === "RETRY" && attempts < 5)
    return { status: "RETRY", needsReconciliation: false };
  return { status: "FAILED", needsReconciliation: false };
}
async function finalizeFailure(job: IntegrationJob, error: unknown) {
  const failure = safeFailure(error);
  const decision = failureState(failure, job.attempts, job.needsReconciliation);
  await db.$transaction(async (tx) => {
    const changed = await tx.integrationJob.updateMany({
      where: { id: job.id, status: "PROCESSING", leaseToken: job.leaseToken },
      data: {
        ...decision,
        lastError: failure.message,
        errorCode: failure.code,
        nextAttemptAt: retryAt(job.attempts, failure.retryAfterSeconds),
        leaseUntil: null,
        leaseToken: null,
        reconciliationAttempts: job.needsReconciliation
          ? { increment: 1 }
          : undefined,
      },
    });
    if (!changed.count) return;
    await tx.integrationAttempt.create({
      data: {
        jobId: job.id,
        operation: job.needsReconciliation ? "RECONCILE" : job.operation,
        outcome: decision.status,
        errorCode: failure.code,
        safeError: failure.message,
        startedAt: job.lastAttemptAt ?? new Date(),
      },
    });
    await tx.syncRecord.updateMany({
      where: { billId: job.billId, target: job.target },
      data: {
        status:
          decision.status === "UNKNOWN"
            ? "UNKNOWN"
            : decision.status === "RETRY"
              ? "PENDING"
              : "FAILED",
        lastError: failure.message,
        attempts: { increment: 1 },
      },
    });
    await tx.auditLog.create({
      data: {
        companyId: await billCompany(tx, job.billId),
        action: "SYNC_ATTEMPT_FAILED",
        entityType: "Bill",
        entityId: job.billId,
        details: {
          target: job.target,
          organizationId: job.organizationId,
          jobId: job.id,
          operation: job.needsReconciliation ? "RECONCILE" : job.operation,
          outcome: decision.status,
          errorCode: failure.code,
          attempt: job.attempts,
        },
      },
    });
  });
}
async function finalizeSuccess(
  job: IntegrationJob,
  externalId: string,
  snapshot: BillSnapshot,
) {
  await db.$transaction(async (tx) => {
    const destination = await tx.syncRecord.findUnique({
      where: { billId_target: { billId: job.billId, target: job.target } },
    });
    if (!destination || destination.organizationId !== job.organizationId)
      throw new IntegrationError(
        "SYNC_DESTINATION_MISMATCH",
        "The persisted bill destination no longer matches this operation. Reconcile the original organization before proceeding.",
        "UNKNOWN",
      );
    const legacyCollision = await tx.syncRecord.findFirst({
      where: {
        target: job.target,
        externalId,
        organizationId: null,
        billId: { not: job.billId },
      },
    });
    if (legacyCollision)
      throw new IntegrationError(
        "LEGACY_EXTERNAL_ID_UNSCOPED",
        "This external ID matches an unresolved legacy synchronization record. Verify its organization before confirming another bill.",
        "UNKNOWN",
      );
    const changed = await tx.integrationJob.updateMany({
      where: { id: job.id, status: "PROCESSING", leaseToken: job.leaseToken },
      data: {
        status: "SUCCEEDED",
        externalId,
        completedAt: new Date(),
        needsReconciliation: false,
        leaseUntil: null,
        leaseToken: null,
        lastError: null,
        errorCode: null,
        reconciliationAttempts: job.needsReconciliation
          ? { increment: 1 }
          : undefined,
      },
    });
    if (!changed.count) return;
    if (job.operation === "CREATE_BILL") {
      for (const document of snapshot.documents)
        await tx.integrationJob.upsert({
          where: {
            idempotencyKey: `${job.target}:${job.billId}:ATTACH_DOCUMENT:${document.id}`,
          },
          create: {
            billId: job.billId,
            initiatedById: job.initiatedById,
            target: job.target,
            operation: "ATTACH_DOCUMENT",
            idempotencyKey: `${job.target}:${job.billId}:ATTACH_DOCUMENT:${document.id}`,
            organizationId: job.organizationId,
            sourceVersion: job.sourceVersion,
            snapshot: snapshot as unknown as Prisma.InputJsonValue,
            payloadHash: job.payloadHash,
            documentId: document.id,
            externalId,
          },
          update: {},
        });
    }
    const siblings = await tx.integrationJob.findMany({
      where: {
        billId: job.billId,
        target: job.target,
        status: { not: "SUCCEEDED" },
      },
      select: { status: true, lastError: true, needsReconciliation: true },
    });
    const pending = siblings.length;
    const syncStatus = siblings.some(
      (j) => j.status === "UNKNOWN" || j.needsReconciliation,
    )
      ? "UNKNOWN"
      : siblings.some((j) => ["FAILED", "BLOCKED"].includes(j.status))
        ? "FAILED"
        : pending
          ? "PENDING"
          : "SYNCED";
    await tx.syncRecord.updateMany({
      where: { billId: job.billId, target: job.target },
      data: {
        externalId,
        status: syncStatus,
        organizationId: job.organizationId,
        lastSyncedAt: new Date(),
        lastError: siblings.find((j) => j.lastError)?.lastError ?? null,
        attempts: { increment: 1 },
      },
    });
    await tx.integrationAttempt.create({
      data: {
        jobId: job.id,
        operation: job.needsReconciliation ? "RECONCILE" : job.operation,
        outcome: "SUCCEEDED",
        externalId,
        startedAt: job.lastAttemptAt ?? new Date(),
      },
    });
    await tx.auditLog.create({
      data: {
        companyId: await billCompany(tx, job.billId),
        action: "SYNC_CONFIRMED",
        entityType: "Bill",
        entityId: job.billId,
        details: {
          target: job.target,
          organizationId: job.organizationId,
          jobId: job.id,
          operation: job.operation,
          externalId,
          attachmentsPending: pending > 0,
        },
      },
    });
  });
}
export async function processIntegrationJobs(
  options: { limit?: number; jobId?: string; adapterFactory?: AdapterFactory; signal?: AbortSignal } = {},
) {
  if (options.jobId !== undefined && !/^[A-Za-z0-9_-]{1,100}$/.test(options.jobId)) throw new HttpError(422, "Invalid exact synchronization operation.");
  if (options.signal?.aborted) return { processed: 0 };
  const limit = options.jobId ? 1 : Math.min(Math.max(options.limit ?? 5, 1), 25);
  await recoverExpiredLeases(options.jobId);
  let processed = 0;
  for (let i = 0; i < limit; i++) {
    if (options.signal?.aborted) break;
    const job = await claimJob(options.jobId);
    if (!job) break;
    processed++;
    try {
      const snapshot = snapshotSchema.parse(job.snapshot);
      if (snapshotHash(snapshot) !== job.payloadHash)
        throw new IntegrationError(
          "SNAPSHOT_INTEGRITY_FAILED",
          "The queued source snapshot failed its integrity check.",
          "BLOCKED",
        );
      const bill = await db.bill.findUnique({
        where: { id: job.billId },
        select: { status: true, companyId: true },
      });
      if (!bill || !["READY", "APPROVED"].includes(bill.status))
        throw new IntegrationError(
          "BILL_NOT_READY",
          "The bill is no longer finalized for synchronization.",
          "BLOCKED",
        );
      if (snapshot.companyId !== bill.companyId || !snapshot.destination)
        throw new IntegrationError("COMPANY_SNAPSHOT_MISMATCH", "The queued company or destination evidence is missing or has changed.", "BLOCKED");
      const assigned = await db.companyIntegrationDestination.findFirst({ where: {
        companyId: bill.companyId, target: job.target, organizationId: job.organizationId,
        dataCenter: snapshot.destination.dataCenter, environment: snapshot.destination.environment,
        company: { active: true },
      }, select: { companyId: true } });
      if (!assigned) throw new IntegrationError("COMPANY_DESTINATION_MISMATCH", "The queued destination is no longer assigned to this company.", "BLOCKED");
      if (!options.adapterFactory || job.initiatedById || snapshot.destination?.environment === "production") {
        const config = getConfig(job.target, process.env, job.organizationId);
        if (
          !snapshot.destination ||
          snapshot.destination.dataCenter !== config.dataCenter ||
          snapshot.destination.environment !== config.environment
        )
          throw new IntegrationError(
            "DESTINATION_CHANGED",
            "The queued destination is missing or differs from this connection. Restore and verify the original destination before processing.",
            "BLOCKED",
          );
        if (
          !job.needsReconciliation &&
          snapshot.destination.mappingHash !== booksMappingFingerprint(config)
        )
          throw new IntegrationError(
            "MAPPING_CHANGED",
            "The queued account, tax or currency mapping differs from this connection. Restore the reviewed mapping before writing.",
            "BLOCKED",
          );
        await requireDestinationForCompany(config, bill.companyId);
        if (job.initiatedById || snapshot.destination?.environment === "production") {
          if (!job.initiatedById && !options.jobId) throw new IntegrationError("EXACT_LIVE_JOB_REQUIRED", "Historical permission-based operations require exact-job execution.", "BLOCKED");
          if (job.needsReconciliation) await assertJobReconciliationAccess(job, config);
          else await assertLiveJobPermission(job, config);
        }
        await db.auditLog.create({
          data: {
            companyId: bill.companyId,
            action: "SYNC_ATTEMPT_STARTED",
            entityType: "Bill",
            entityId: job.billId,
            details: {
              target: job.target,
              organizationId: job.organizationId,
              jobId: job.id,
              operation: job.needsReconciliation ? "RECONCILE" : job.operation,
              authorizationReference:
                config.testAuthorization?.approvalReference ?? null,
            },
          },
        });
      }
      const adapter = options.adapterFactory ? options.adapterFactory(job.target, job.organizationId, job) : productionAdapter(job.target, job.organizationId, job);
      let confirmation;
      if (job.operation === "CREATE_BILL") {
        confirmation = job.needsReconciliation
          ? await adapter.reconcile(snapshot)
          : await adapter.create(snapshot);
      } else if (job.operation === "ATTACH_DOCUMENT") {
        if (!job.externalId || !job.documentId)
          throw new IntegrationError(
            "ATTACHMENT_MAPPING_MISSING",
            "The external bill or source document is missing.",
            "BLOCKED",
          );
        const expected = snapshot.documents.find(
          (d) => d.id === job.documentId,
        );
        if (!expected)
          throw new IntegrationError(
            "DOCUMENT_NOT_IN_SNAPSHOT",
            "This attachment was not part of the approved snapshot.",
            "BLOCKED",
          );
        if (job.needsReconciliation) {
          confirmation = await adapter.reconcileAttachment(
            job.externalId,
            expected.sha256,
          );
        } else {
          const document = await db.document.findFirst({
            where: { id: job.documentId, billId: job.billId },
          });
          if (!document || document.sha256 !== expected.sha256)
            throw new IntegrationError(
              "DOCUMENT_INTEGRITY_FAILED",
              "The source attachment no longer matches the approved snapshot.",
              "BLOCKED",
            );
          const bytes = await readPrivateDocument(document);
          if (
            createHash("sha256").update(bytes).digest("hex") !== expected.sha256
          )
            throw new IntegrationError(
              "DOCUMENT_INTEGRITY_FAILED",
              "The attachment integrity check failed.",
              "BLOCKED",
            );
          confirmation = await adapter.attach(job.externalId, {
            bytes,
            fileName: document.fileName,
            mimeType: document.mimeType,
            sha256: document.sha256,
          });
        }
      } else
        throw new IntegrationError(
          "CRM_EXPENSE_MODULE_UNVERIFIED",
          "The CRM supplier-expense mapping has not been verified.",
          "BLOCKED",
        );
      if (!confirmation)
        throw new IntegrationError(
          "RECONCILIATION_NOT_FOUND",
          "No matching external record was confirmed. The result remains uncertain; automatic creation will not be repeated.",
          "UNKNOWN",
        );
      await finalizeSuccess(job, confirmation.externalId, snapshot);
    } catch (error) {
      await finalizeFailure(job, error);
    }
  }
  return { processed };
}
