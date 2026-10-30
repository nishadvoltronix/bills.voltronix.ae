import "server-only";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Prisma, type IntegrationJob } from "@prisma/client";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import { readPrivateDocument } from "@/lib/services/documents";
import { approvedSnapshot, sourceInclude, type BillSource } from "./source-snapshot";
import { booksMappingFingerprint, buildBooksPayload, snapshotHash, snapshotSchema } from "./books";
import { assertNetwork, assertWrite, booksConfigurationHash, getBooksOrganizations, getConfig, IntegrationError, type ZohoConfig } from "./config";
import type { ProductionWriteRequest } from "./transport";
import { requireDestinationForCompany } from "./company-destination";
import { assertLocalLiveTestJobPermission, isLocalLiveTestSnapshot } from "./local-live-test";

type Store = Prisma.TransactionClient;
export type LiveSyncConfirmation = { challengeId: string; challengeToken: string };
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const blocked = (message: string) => new IntegrationError("LIVE_PERMISSION_REQUIRED", message, "BLOCKED");
const lifetime = 10 * 60_000;

export async function assertSynchronizationActor(store: Store, bill: BillSource, actorId: string, allowCreator = true) {
  const actor = await store.user.findFirst({ where: { id: actorId, active: true,
    OR: [{ role: { in: ["ADMIN", "ACCOUNTS"] } }, ...(allowCreator ? [{ id: bill.createdById, role: "DATA_ENTRY" as const }] : [])],
    memberships: { some: { companyId: bill.companyId, active: true, company: { active: true } } } }, select: { id: true } });
  if (!actor) throw new HttpError(403, "Current company access and ownership or accounting access are required.");
}

/** Company/provider controls remain independent of the user's final save. */
export async function assertLiveSource(store: Store, bill: BillSource, config: ZohoConfig, actorId: string, autonomous = false) {
  assertWrite(config);
  if (config.target !== "ZOHO" || config.environment !== "production") throw blocked("A live Books destination is required.");
  if (!(autonomous ? ["READY", "APPROVED"].includes(bill.status) : bill.status === "APPROVED") || bill.companyId !== bill.vendor.companyId || bill.companyId !== bill.job.companyId ||
    !bill.company.active || !bill.company.liveAccountingEnabled || bill.company.isDemo || bill.vendor.isDemo || bill.job.isDemo ||
    [bill.id, bill.companyId, bill.vendorId, bill.jobId].some(id => /^demo[-_]/i.test(id)))
    throw blocked("Only a finalized bill in an enabled real company with real vendor and job records can be sent live.");
  await assertSynchronizationActor(store, bill, actorId, autonomous);
  const destination = await store.companyIntegrationDestination.findFirst({ where: {
    companyId: bill.companyId, target: "ZOHO", organizationId: config.organizationId,
    dataCenter: config.dataCenter, environment: "production", liveEnabled: true,
    verifiedConfigurationHash: booksConfigurationHash(config), verifiedAt: { lte: new Date() },
  } });
  if (!destination?.verificationReference?.trim()) throw blocked("A trusted operator must verify and enable this exact company destination and accounting configuration.");
}

async function sourceSnapshot(store: Store, bill: BillSource, config: ZohoConfig, authorizationId: string) {
  const vendor = await store.vendorBooksMapping.findUnique({ where: { vendorId_organizationId_dataCenter_environment: {
    vendorId: bill.vendorId, organizationId: config.organizationId, dataCenter: config.dataCenter, environment: "production",
  } } });
  if (!vendor) throw blocked("Map the supplier in this exact live destination before previewing.");
  const snapshot = approvedSnapshot(bill, vendor.externalVendorId);
  snapshot.destination = { dataCenter: config.dataCenter, environment: "production", mappingHash: booksMappingFingerprint(config),
    liveAuthorizationId: authorizationId };
  buildBooksPayload(snapshot, config);
  return snapshot;
}

async function verifyPrivateFiles(bill: BillSource) {
  for (const document of bill.documents) {
    const bytes = await readPrivateDocument(document);
    if (hash(bytes) !== document.sha256) throw blocked("A saved attachment changed; review the source before synchronization.");
  }
}

export async function savedSourceSnapshot(store: Store, bill: BillSource, config: ZohoConfig, actorId: string) {
  assertWrite(config);
  if (!["READY", "APPROVED"].includes(bill.status) || bill.companyId !== bill.vendor.companyId || bill.companyId !== bill.job.companyId)
    throw blocked("Only a finalized bill with matching company records can be synchronized.");
  await assertSynchronizationActor(store, bill, actorId);
  await requireDestinationForCompany(config, bill.companyId, store);
  if (config.environment === "production") await assertLiveSource(store, bill, config, actorId, true);
  const vendor = await store.vendorBooksMapping.findUnique({ where: { vendorId_organizationId_dataCenter_environment: {
    vendorId: bill.vendorId, organizationId: config.organizationId, dataCenter: config.dataCenter, environment: config.environment,
  } } });
  if (!vendor) throw new IntegrationError("VENDOR_MAPPING_REQUIRED", "Map this supplier in the selected Books company before synchronization.", "BLOCKED");
  const snapshot = approvedSnapshot(bill, vendor.externalVendorId);
  snapshot.initiatedById = actorId;
  snapshot.destination = { dataCenter: config.dataCenter, environment: config.environment, mappingHash: booksMappingFingerprint(config),
    configurationHash: booksConfigurationHash(config), authorizationReference: config.testAuthorization?.approvalReference };
  buildBooksPayload(snapshot, config);
  return snapshot;
}

async function assertAutonomousJobPermission(job: IntegrationJob, config: ZohoConfig, verifyFiles: boolean) {
  const snapshot = snapshotSchema.parse(job.snapshot);
  if (!job.initiatedById || snapshot.initiatedById !== job.initiatedById || snapshot.destination?.liveAuthorizationId ||
    snapshot.sourceVersion !== job.sourceVersion ||
    snapshot.destination?.environment !== config.environment || snapshot.destination?.dataCenter !== config.dataCenter ||
    snapshot.destination?.configurationHash !== booksConfigurationHash(config) || job.organizationId !== config.organizationId ||
    snapshotHash(snapshot) !== job.payloadHash) throw blocked("The saved operation no longer matches its source actor or destination configuration.");
  const canonical = await db.integrationJob.findUnique({ where: { idempotencyKey: `ZOHO:${job.billId}:CREATE_BILL` } });
  if (!canonical || canonical.target !== "ZOHO" || canonical.operation !== "CREATE_BILL" || canonical.organizationId !== job.organizationId ||
    canonical.initiatedById !== job.initiatedById || canonical.payloadHash !== job.payloadHash ||
    (job.operation === "CREATE_BILL" ? job.id !== canonical.id : canonical.status !== "SUCCEEDED" || canonical.externalId !== job.externalId))
    throw blocked("The saved operation is not linked to its original canonical Books bill.");
  const bill = await db.bill.findUnique({ where: { id: job.billId }, include: sourceInclude });
  if (!bill || bill.companyId !== snapshot.companyId) throw blocked("The saved source bill is unavailable or its company changed.");
  const current = await savedSourceSnapshot(db, bill, config, job.initiatedById);
  // Local payments increment the UI edit version but are never exported. Compare
  // every exported value and attachment against the original source version.
  current.sourceVersion = snapshot.sourceVersion;
  current.destination!.authorizationReference = snapshot.destination.authorizationReference;
  if (snapshotHash(current) !== job.payloadHash) throw blocked("The saved bill, supplier mapping or attachment list changed before synchronization.");
  if (verifyFiles) await verifyPrivateFiles(bill);
  return { snapshot, expiresAt: null };
}

/** Read-only outcome recovery cannot authorize a POST or adopt a new destination. */
export async function assertJobReconciliationAccess(job: IntegrationJob, config: ZohoConfig) {
  if (!job.needsReconciliation) throw blocked("This operation is not scheduled for read-only reconciliation.");
  if (isLocalLiveTestSnapshot(snapshotSchema.parse(job.snapshot)))
    return assertLocalLiveTestJobPermission(job, config, { verifyFiles: false, reconcileOnly: true });
  if (!job.initiatedById) return assertLiveJobPermission(job, config, false);
  assertNetwork(config);
  const snapshot = snapshotSchema.parse(job.snapshot);
  if (job.target !== "ZOHO" || config.target !== "ZOHO" || snapshot.initiatedById !== job.initiatedById ||
    snapshot.sourceVersion !== job.sourceVersion || snapshotHash(snapshot) !== job.payloadHash ||
    snapshot.internalBillId !== job.billId || snapshot.destination?.liveAuthorizationId ||
    snapshot.destination?.environment !== config.environment || snapshot.destination?.dataCenter !== config.dataCenter ||
    job.organizationId !== config.organizationId) throw blocked("The reconciliation request differs from the original Books source and destination.");
  const canonical = await db.integrationJob.findUnique({ where: { idempotencyKey: `ZOHO:${job.billId}:CREATE_BILL` } });
  if (!canonical || canonical.target !== "ZOHO" || canonical.operation !== "CREATE_BILL" || canonical.organizationId !== job.organizationId ||
    canonical.initiatedById !== job.initiatedById || canonical.payloadHash !== job.payloadHash ||
    (job.operation === "CREATE_BILL" ? canonical.id !== job.id : canonical.status !== "SUCCEEDED" || canonical.externalId !== job.externalId))
    throw blocked("Reconciliation must use the original canonical Books operation.");
  const bill = await db.bill.findUnique({ where: { id: job.billId }, include: sourceInclude });
  if (!bill || !["READY", "APPROVED"].includes(bill.status) || bill.companyId !== snapshot.companyId ||
    bill.vendor.companyId !== bill.companyId || bill.job.companyId !== bill.companyId)
    throw blocked("The finalized source is unavailable for reconciliation.");
  await assertSynchronizationActor(db, bill, job.initiatedById);
  await requireDestinationForCompany(config, bill.companyId);
  if (config.environment === "production" && (!config.liveRuntime || bill.company.isDemo || bill.vendor.isDemo || bill.job.isDemo ||
    [bill.id, bill.companyId, bill.vendorId, bill.jobId].some(id => /^demo[-_]/i.test(id))))
    throw blocked("Live reconciliation requires the operational environment and real source company.");
  const current = approvedSnapshot(bill, snapshot.externalVendorId);
  current.sourceVersion = snapshot.sourceVersion;
  current.initiatedById = snapshot.initiatedById;
  current.destination = snapshot.destination;
  if (snapshotHash(current) !== job.payloadHash) throw blocked("The local exported source changed; review the original outcome before linking it.");
}

export async function previewLiveBillSync(actor: Actor, billId: string, organizationId: string) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(billId) || !/^\d{1,30}$/.test(organizationId)) throw new HttpError(422, "Invalid bill or destination.");
  const config = getConfig("ZOHO", process.env, organizationId);
  return db.$transaction(async tx => {
    await tx.$queryRaw(Prisma.sql`SELECT \`id\` FROM \`Bill\` WHERE \`id\`=${billId} FOR UPDATE`);
    const bill = await tx.bill.findUnique({ where: { id: billId }, include: sourceInclude });
    if (!bill) throw new HttpError(404, "Bill not found.");
    await assertLiveSource(tx, bill, config, actor.id);
    const previous = await tx.liveSyncAuthorization.findUnique({ where: { billId } });
    if (previous && (previous.purpose !== "LIVE" || previous.localProof !== null || previous.localProofHash !== null))
      throw blocked("This bill has a different permission purpose; ordinary live preview cannot replace it.");
    if (previous?.revokedAt) throw blocked("This bill's live permission was revoked; an operator must review it.");
    const id = previous?.id ?? randomUUID();
    const snapshot = await sourceSnapshot(tx, bill, config, id);
    const payloadHash = snapshotHash(snapshot);
    const canonical = await tx.integrationJob.findUnique({ where: { idempotencyKey: `ZOHO:${billId}:CREATE_BILL` } });
    if (canonical?.status === "PROCESSING") throw blocked("Wait for the active operation to finish before replacing its confirmation.");
    if (canonical && (canonical.organizationId !== organizationId || canonical.payloadHash !== payloadHash || previous?.canonicalJobId !== canonical.id))
      throw blocked("The existing operation differs from this preview. Reconcile its original destination and approved snapshot.");
    await verifyPrivateFiles(bill);
    const challengeToken = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + lifetime);
    const data = { purpose: "LIVE" as const, localProof: Prisma.DbNull, localProofHash: null,
      actorId: actor.id, companyId: bill.companyId, organizationId, dataCenter: config.dataCenter,
      sourceVersion: bill.version, challengeHash: hash(challengeToken), payloadHash,
      configurationHash: booksConfigurationHash(config), expiresAt, confirmedAt: null };
    if (previous) {
      const updated = await tx.liveSyncAuthorization.updateMany({ where: { id: previous.id, billId, purpose: "LIVE",
        localProof: { equals: Prisma.DbNull }, localProofHash: null, revokedAt: null }, data });
      if (updated.count !== 1) throw blocked("This bill's live permission changed while preparing the preview.");
    } else await tx.liveSyncAuthorization.create({ data: { id, billId, ...data } });
    await tx.auditLog.create({ data: { actorId: actor.id, companyId: bill.companyId, action: "LIVE_SYNC_PREVIEWED", entityType: "Bill", entityId: billId,
      details: { authorizationId: id, organizationId, sourceVersion: bill.version, payloadHash, expiresAt: expiresAt.toISOString() } } });
    return { mode: "production" as const, challengeId: id, challengeToken, expiresAt: expiresAt.toISOString(), payloadHash,
      bill: { id: bill.id, invoiceNumber: bill.invoiceNumber, sourceVersion: bill.version, currency: bill.currency,
        total: bill.total.toFixed(2), vendorName: bill.vendor.name, jobNumber: bill.job.jobNumber },
      destination: { companyId: bill.companyId, companyName: bill.company.name, organizationId,
        organizationName: getBooksOrganizations().find(profile => profile.organizationId === organizationId)?.name ?? organizationId,
        dataCenter: config.dataCenter, environment: "production" as const },
      documents: snapshot.documents.map(({ id, fileName, sha256 }) => ({ id, fileName, sha256 })) };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20_000 });
}

/** Called inside the same transaction that creates/reuses the canonical operation. */
export async function confirmLiveSnapshot(store: Store, bill: BillSource, config: ZohoConfig, actorId: string,
  confirmation: LiveSyncConfirmation | undefined) {
  if (!confirmation || !/^[A-Za-z0-9_-]{1,100}$/.test(confirmation.challengeId) || !/^[a-f0-9]{64}$/.test(confirmation.challengeToken))
    throw blocked("Preview and explicitly confirm this live bill before queueing it.");
  await assertLiveSource(store, bill, config, actorId);
  const permit = await store.liveSyncAuthorization.findUnique({ where: { id: confirmation.challengeId } });
  if (!permit || permit.purpose !== "LIVE" || permit.localProof !== null || permit.localProofHash !== null ||
    permit.billId !== bill.id || permit.actorId !== actorId || permit.companyId !== bill.companyId ||
    permit.organizationId !== config.organizationId || permit.dataCenter !== config.dataCenter || permit.sourceVersion !== bill.version ||
    permit.confirmedAt || permit.revokedAt || permit.expiresAt.getTime() <= Date.now() || permit.expiresAt.getTime() > Date.now() + lifetime ||
    !/^[a-f0-9]{64}$/.test(permit.challengeHash) ||
    permit.configurationHash !== booksConfigurationHash(config) ||
    !timingSafeEqual(Buffer.from(permit.challengeHash, "hex"), Buffer.from(hash(confirmation.challengeToken), "hex")))
    throw blocked("The live preview is expired, already used, revoked or no longer matches this actor and bill.");
  const snapshot = await sourceSnapshot(store, bill, config, permit.id);
  if (snapshotHash(snapshot) !== permit.payloadHash) throw blocked("The bill, mapping or attachment list changed after preview.");
  await verifyPrivateFiles(bill);
  return { permit, snapshot };
}

export async function recordLiveConfirmation(store: Store, authorizationId: string, job: IntegrationJob, actorId: string, companyId: string) {
  const updated = await store.liveSyncAuthorization.updateMany({ where: { id: authorizationId, actorId, companyId, billId: job.billId,
    purpose: "LIVE", localProof: { equals: Prisma.DbNull }, localProofHash: null,
    payloadHash: job.payloadHash, confirmedAt: null, revokedAt: null, expiresAt: { gt: new Date() },
    OR: [{ canonicalJobId: null }, { canonicalJobId: job.id }] }, data: { confirmedAt: new Date(), canonicalJobId: job.id } });
  if (updated.count !== 1) throw blocked("The live preview changed or expired during confirmation.");
  await store.auditLog.create({ data: { actorId, companyId, action: "LIVE_SYNC_CONFIRMED", entityType: "Bill", entityId: job.billId,
    details: { authorizationId, jobId: job.id, organizationId: job.organizationId, payloadHash: job.payloadHash } } });
}

export async function assertLiveJobPermission(job: IntegrationJob, config: ZohoConfig, verifyFiles = true) {
  if (job.target !== "ZOHO") throw blocked("Live permission is limited to its Books operation.");
  if (isLocalLiveTestSnapshot(snapshotSchema.parse(job.snapshot)))
    return assertLocalLiveTestJobPermission(job, config, { verifyFiles });
  if (job.initiatedById) return assertAutonomousJobPermission(job, config, verifyFiles);
  const snapshot = snapshotSchema.parse(job.snapshot);
  const id = snapshot.destination?.liveAuthorizationId;
  if (!id || snapshot.destination?.environment !== "production" || snapshotHash(snapshot) !== job.payloadHash)
    throw blocked("The queued live operation has no intact per-bill permission.");
  const permit = await db.liveSyncAuthorization.findUnique({ where: { id } });
  if (!permit || permit.purpose !== "LIVE" || permit.localProof !== null || permit.localProofHash !== null ||
    !permit.confirmedAt || permit.confirmedAt.getTime() > Date.now() ||
    permit.expiresAt.getTime() - permit.confirmedAt.getTime() > lifetime ||
    permit.revokedAt || !permit.canonicalJobId || permit.expiresAt.getTime() <= Date.now() ||
    permit.billId !== job.billId || permit.companyId !== snapshot.companyId || permit.payloadHash !== job.payloadHash ||
    permit.organizationId !== job.organizationId || permit.organizationId !== config.organizationId || permit.dataCenter !== config.dataCenter ||
    permit.sourceVersion !== job.sourceVersion || permit.configurationHash !== booksConfigurationHash(config))
    throw blocked("This live operation's permission expired, was revoked or no longer matches its destination.");
  const canonical = await db.integrationJob.findUnique({ where: { id: permit.canonicalJobId } });
  if (!canonical || canonical.target !== "ZOHO" || canonical.operation !== "CREATE_BILL" || canonical.organizationId !== job.organizationId ||
    canonical.idempotencyKey !== `ZOHO:${job.billId}:CREATE_BILL` || canonical.payloadHash !== job.payloadHash ||
    (job.operation === "CREATE_BILL" ? job.id !== canonical.id : canonical.status !== "SUCCEEDED" || canonical.externalId !== job.externalId))
    throw blocked("The live operation is not linked to its confirmed canonical bill.");
  const bill = await db.bill.findUnique({ where: { id: job.billId }, include: sourceInclude });
  if (!bill) throw blocked("The approved source bill is unavailable.");
  await assertLiveSource(db, bill, config, permit.actorId);
  if (bill.version !== permit.sourceVersion || snapshotHash(await sourceSnapshot(db, bill, config, permit.id)) !== permit.payloadHash)
    throw blocked("The approved source bill, supplier mapping or attachments changed after live confirmation.");
  if (verifyFiles) await verifyPrivateFiles(bill);
  if (permit.expiresAt.getTime() <= Date.now()) throw blocked("This live operation's permission expired during verification.");
  return { snapshot, expiresAt: permit.expiresAt };
}

/** Production transport invokes this again after token/organization work, immediately before its POST. */
export async function assertLiveJobWrite(jobId: string, leaseToken: string, request: ProductionWriteRequest) {
  const job = await db.integrationJob.findUnique({ where: { id: jobId } });
  if (!job || !leaseToken || job.leaseToken !== leaseToken || job.status !== "PROCESSING" || !job.leaseUntil || job.leaseUntil.getTime() <= Date.now() || job.needsReconciliation)
    throw blocked("This operation is not held by an active live writer.");
  const config = getConfig("ZOHO", process.env, job.organizationId);
  const { snapshot } = await assertLiveJobPermission(job, config);
  if (job.operation === "CREATE_BILL") {
    if (request.path !== "/books/v3/bills" || request.form || JSON.stringify(request.body) !== JSON.stringify(buildBooksPayload(snapshot, config)))
      throw blocked("The outgoing bill differs from the saved Books operation.");
  } else if (job.operation === "ATTACH_DOCUMENT") {
    const document = snapshot.documents.find(document => document.id === job.documentId);
    const form = request.form;
    const value = form?.get("attachment");
    if (!document || request.body || request.path !== `/books/v3/bills/${job.externalId}/attachment` || !form ||
      [...form.keys()].length !== 1 || !(value instanceof File) || value.name !== document.fileName || value.type !== document.mimeType ||
      hash(new Uint8Array(await value.arrayBuffer())) !== document.sha256)
      throw blocked("The outgoing attachment differs from the saved source document.");
  } else throw blocked("This live operation is not supported.");
  // Files/token/provider checks can take time. Re-read current authority and the
  // original worker lease after all potentially slow byte hashing.
  const final = await assertLiveJobPermission(job, getConfig("ZOHO", process.env, job.organizationId), false);
  const held = await db.integrationJob.findUnique({ where: { id: jobId }, select: { status: true, leaseToken: true, leaseUntil: true, needsReconciliation: true } });
  if (!held || held.status !== "PROCESSING" || held.leaseToken !== leaseToken || !held.leaseUntil ||
    held.leaseUntil.getTime() <= Date.now() || held.needsReconciliation || (final.expiresAt && final.expiresAt.getTime() <= Date.now()))
    throw blocked("The live permission or original worker lease expired before submission.");
}
