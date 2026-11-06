import "server-only";
import { Prisma } from "@prisma/client";
import Decimal from "decimal.js";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import { isManualEntryOnly } from "@/lib/application-mode";
import { BooksAdapter, booksMappingFingerprint, buildBooksPayload, snapshotHash, snapshotSchema, type BillSnapshot } from "@/lib/integrations/books";
import { prepareBooksAttachment } from "@/lib/integrations/books-attachment";
import { assertBooksUpdateMapping, assertBooksUpdateMoney, booksRemoteMatchesPayload, booksUpdateTerms, reviewedBooksUpdateNotes } from "@/lib/integrations/books-update";
import { assertWrite, booksConfigurationHash, getConfig, IntegrationError } from "@/lib/integrations/config";
import { connectionFingerprint, accessToken } from "@/lib/integrations/oauth";
import { sourceInclude } from "@/lib/integrations/source-snapshot";
import { correctionStateHash, isSupersededIntegrationJob } from "@/lib/integrations/source-supersession";
import { ZohoTransport } from "@/lib/integrations/transport";
import { normalizeInvoiceNumber } from "@/lib/finance";
import { readPrivateDocument } from "./documents";

type Store = Prisma.TransactionClient;
export type BillEditEligibility = { allowed: boolean; reason: string | null; mode: "draft" | "create_revision" | "provider_update" | null };
const include = { ...sourceInclude, payments: { orderBy: { id: "asc" as const } }, syncRecords: true, liveSyncAuthorization: true } satisfies Prisma.BillInclude;
export type EditableBillSource = Prisma.BillGetPayload<{ include: typeof include }>;
const blocked = (message: string) => new IntegrationError("BILL_EDIT_BLOCKED", message, "BLOCKED");
async function editContext(store: Store, actor: Actor, billId: string) {
  const bill = await store.bill.findUnique({ where: { id: billId }, include });
  if (!bill) throw new HttpError(404, "Bill not found.");
  const current = await store.user.findFirst({ where: { id: actor.id, active: true, role: actor.role,
    memberships: { some: { companyId: bill.companyId, active: true, company: { active: true } } } }, select: { id: true, role: true } });
  if (!current || !["ADMIN", "ACCOUNTS", "DATA_ENTRY"].includes(current.role)) throw new HttpError(403, "Current bill-entry access is required to edit this bill.");
  if (current.role !== "ADMIN" && bill.createdById !== actor.id) throw new HttpError(404, "Bill not found.");
  const jobs = await store.integrationJob.findMany({ where: { billId, target: "ZOHO" },
    orderBy: [{ sourceVersion: "desc" }, { createdAt: "desc" }, { id: "desc" }], include: { history: { orderBy: [{ finishedAt: "asc" }, { id: "asc" }] } } });
  const active = jobs.filter(job => !isSupersededIntegrationJob(job));
  const mutation = active.find(job => ["CREATE_BILL", "UPDATE_BILL"].includes(job.operation)) ?? null;
  const confirmed = active.find(job => ["CREATE_BILL", "UPDATE_BILL"].includes(job.operation) && job.status === "SUCCEEDED" && job.externalId) ?? null;
  const sync = bill.syncRecords.find(record => record.target === "ZOHO") ?? null;
  const destinations = await store.companyIntegrationDestination.findMany({ where: { companyId: bill.companyId, target: "ZOHO" } });
  let config = null;
  if (destinations.length === 1) {
    try { const value = getConfig("ZOHO", process.env, destinations[0].organizationId);
      if (value.dataCenter === destinations[0].dataCenter && value.environment === destinations[0].environment) config = value;
    } catch { /* An unconfigured source remains visibly unsynchronized. */ }
  }
  const grant = config ? await store.integrationCredential.findUnique({ where: { target_organizationId: { target: "ZOHO", organizationId: config.organizationId } },
    select: { organizationId: true, dataCenter: true, revokedAt: true, connectionFingerprint: true } }) : null;
  const result = { bill, current, jobs, active, mutation, confirmed, sync, destinations, config, grant };
  return { ...result, fingerprint: correctionStateHash({ ...result, config: config ? {
    configurationHash: booksConfigurationHash(config), connectionFingerprint: connectionFingerprint(config), writeEnabled: config.writeEnabled,
    networkEnabled: config.networkEnabled, liveRuntime: config.liveRuntime,
  } : null }) };
}
type Context = Awaited<ReturnType<typeof editContext>>;
function eligibility(value: Context): BillEditEligibility {
  if (["DRAFT", "REJECTED"].includes(value.bill.status)) return { allowed: true, reason: null, mode: "draft" };
  if (!["READY", "APPROVED"].includes(value.bill.status)) return { allowed: false, reason: "This bill cannot be edited in its current state.", mode: null };
  if (value.bill.liveSyncAuthorization?.purpose === "LOCAL_ONE_BILL_TEST")
    return { allowed: false, reason: "This controlled verification bill requires its original operator workflow.", mode: null };
  if (value.active.some(job => job.status === "PROCESSING" || job.status === "UNKNOWN" || job.needsReconciliation || job.leaseToken || job.leaseUntil))
    return { allowed: false, reason: "Books synchronization is processing or uncertain. Finish reconciliation before editing this bill.", mode: null };
  if (value.active.some(job => job.operation === "ATTACH_DOCUMENT" && job.status !== "SUCCEEDED"))
    return { allowed: false, reason: "Finish synchronizing the original attachment before editing the saved bill.", mode: null };
  if (value.confirmed || value.sync?.externalId) {
    if (!value.confirmed || value.confirmed.externalId !== value.sync?.externalId || !value.config)
      return { allowed: false, reason: "Restore and verify this bill's original Books connection before editing.", mode: null };
    if (value.mutation && value.mutation.status !== "SUCCEEDED" && !["FAILED", "BLOCKED", "CANCELLED"].includes(value.mutation.status))
      return { allowed: false, reason: "The previous bill update is queued. Wait for its result before making another edit.", mode: null };
    if (value.config.booksMapping?.jobCustomFieldIndex || value.config.booksMapping?.orderCustomFieldIndex)
      return { allowed: false, reason: "The existing Books custom fields require verification before this finalized bill can be updated.", mode: null };
    return { allowed: true, reason: null, mode: "provider_update" };
  }
  if (value.active.some(job => job.externalId || job.history.some(attempt => attempt.externalId || ["UNKNOWN", "SUCCEEDED"].includes(attempt.outcome)) || job.history.length !== job.attempts))
    return { allowed: false, reason: "The original provider outcome must be established before this saved source can be changed.", mode: null };
  if (value.mutation && (!value.config || isManualEntryOnly()))
    return { allowed: false, reason: "Restore the original Books connection so its uncreated outcome can be verified before editing.", mode: null };
  return { allowed: true, reason: null, mode: "create_revision" };
}
export async function billEditEligibility(actor: Actor, billId: string): Promise<BillEditEligibility> {
  if (!["ADMIN", "ACCOUNTS", "DATA_ENTRY"].includes(actor.role)) return { allowed: false, reason: "Your role cannot edit bills.", mode: null };
  return eligibility(await editContext(db, actor, billId));
}
export async function finalizedBillForEdit(actor: Actor, billId: string) {
  return (await editContext(db, actor, billId)).bill;
}

type HeldEdit = { actorId: string; billId: string; mutationId: string | null; expectedVersion: number; desiredHash: string; sourceHash: string;
  expiresAt: number; consumed: boolean; mode: "create_revision" | "provider_update"; revision?: NonNullable<BillSnapshot["revision"]> };
export type FinalizedBillEditProof = Readonly<{ kind: "verified-finalized-bill-edit" }>;
const proofs = new WeakMap<FinalizedBillEditProof, HeldEdit>();
async function remoteAbsence(transport: ZohoTransport, before: BillSnapshot, desired: BillSnapshot) {
  const queries: Record<string, string>[] = [{ search_text: `VX-BILL-${before.internalBillId}` }, { reference_number: `VX-BILL-${before.internalBillId}` },
    ...[...new Set([before.invoiceNumber, desired.invoiceNumber])].map(search_text => ({ search_text }))];
  for (const query of queries) {
    const seen = new Set<string>(); let complete = false;
    for (let page = 1; page <= 10; page++) {
      const raw = await transport.request("/books/v3/bills", { method: "GET", query: { ...query, page: String(page), per_page: "200" } });
      if (!raw || typeof raw !== "object" || !("code" in raw) || raw.code !== 0 || !("bills" in raw) || !Array.isArray(raw.bills) ||
        !("page_context" in raw) || !raw.page_context || typeof raw.page_context !== "object" || !("has_more_page" in raw.page_context) ||
        typeof raw.page_context.has_more_page !== "boolean" || raw.bills.length > 200) throw blocked("The complete Books duplicate search could not be verified.");
      for (const row of raw.bills) {
        if (!row || typeof row !== "object" || typeof row.bill_id !== "string" || !/^\d{1,30}$/.test(row.bill_id) ||
          typeof row.bill_number !== "string" || typeof row.reference_number !== "string" || seen.has(row.bill_id))
          throw blocked("The Books duplicate search contained invalid or repeated records.");
        seen.add(row.bill_id);
        if (row.reference_number === `VX-BILL-${before.internalBillId}` || [before.invoiceNumber, desired.invoiceNumber].some(invoice =>
          normalizeInvoiceNumber(invoice) === normalizeInvoiceNumber(row.bill_number))) throw blocked("A matching Books bill already exists. Reconcile it before changing this uncreated source.");
      }
      if (!raw.page_context.has_more_page) { complete = true; break; }
      if (!raw.bills.length) throw blocked("The Books duplicate search was incomplete.");
    }
    if (!complete) throw blocked("Books duplicate search exceeded its bounded limit. No saved source was changed.");
  }
}
/** Provider reads and file hashing finish before the financial write transaction. */
export async function prepareFinalizedBillEdit(actor: Actor, billId: string, expectedVersion: number, desired: BillSnapshot, provided?: ZohoTransport) {
  if (provided && (process.env.NODE_ENV !== "test" || process.env.APP_ENV === "production")) throw blocked("Synthetic provider transports are restricted to isolated tests.");
  const value = await editContext(db, actor, billId), policy = eligibility(value);
  if (!policy.allowed || policy.mode === "draft" || !policy.mode) throw blocked(policy.reason ?? "This saved bill is not eligible for finalized editing.");
  if (policy.mode === "provider_update") booksUpdateTerms(desired);
  if (value.mutation) {
    const original = snapshotSchema.safeParse(value.mutation.snapshot);
    if (!original.success || snapshotHash(original.data) !== value.mutation.payloadHash || original.data.internalBillId !== billId ||
      original.data.companyId !== value.bill.companyId || original.data.jobId !== value.bill.jobId || original.data.currency !== value.bill.currency ||
      original.data.sourceVersion !== value.mutation.sourceVersion || value.mutation.sourceVersion > expectedVersion ||
      value.config && (value.mutation.organizationId !== value.config.organizationId || original.data.destination?.dataCenter !== value.config.dataCenter ||
        original.data.destination?.environment !== value.config.environment)) throw blocked("The original immutable bill operation failed its source or destination integrity checks.");
  }
  if (value.bill.version !== expectedVersion || desired.internalBillId !== billId || desired.companyId !== value.bill.companyId ||
    desired.jobId !== value.bill.jobId || desired.currency !== value.bill.currency || desired.sourceVersion !== expectedVersion + 1 ||
    new Decimal(desired.total).lessThan(value.bill.paidAmount.toString())) throw blocked("The bill changed or the edited total is below its recorded payments.");
  if (correctionStateHash(desired.documents) !== correctionStateHash(value.bill.documents.map(document => ({ id: document.id, sha256: document.sha256,
    fileName: document.fileName, mimeType: document.mimeType })))) throw blocked("Original attachments cannot be replaced through a saved bill edit.");
  for (const document of value.bill.documents) await readPrivateDocument(document);
  let revision: HeldEdit["revision"];
  if (value.config && !isManualEntryOnly()) {
    assertWrite(value.config);
    if (!value.grant || value.grant.revokedAt || value.grant.connectionFingerprint !== connectionFingerprint(value.config))
      throw blocked("Reconnect this bill's exact Books company before synchronizing changes.");
    if (provided && booksConfigurationHash(provided.config) !== booksConfigurationHash(value.config)) throw blocked("The inspection connection differs from the selected company.");
    const transport = provided ?? new ZohoTransport(value.config, () => accessToken(value.config!));
    if (policy.mode === "provider_update") {
      assertBooksUpdateMapping(value.config);
      const previous = value.confirmed!;
      const previousSnapshot = snapshotSchema.parse(previous.snapshot);
      if (previousSnapshot.destination?.mappingHash !== booksMappingFingerprint(value.config) || snapshotHash(previousSnapshot) !== previous.payloadHash)
        throw blocked("Restore the last confirmed Books mappings before updating this bill.");
      const adapter = new BooksAdapter(transport), remote = await adapter.readForUpdate(previous.externalId!);
      assertBooksUpdateMoney(remote, desired, value.bill.paidAmount.toString());
      const oldPayload = buildBooksPayload(previousSnapshot, value.config), newPayload = buildBooksPayload(desired, value.config);
      if (!booksRemoteMatchesPayload(remote, previousSnapshot, oldPayload) && !booksRemoteMatchesPayload(remote, desired, newPayload))
        throw blocked("This Books bill changed outside the application. Review its current version before saving changes.");
      if (value.bill.documents.length) {
        const artifact = await prepareBooksAttachment(previousSnapshot, previousSnapshot.documents[0].id);
        if (!await adapter.reconcileAttachment(previous.externalId!, artifact.sha256)) throw blocked("The original Books attachment must be confirmed before editing.");
      }
      revision = { kind: "UPDATE_BILL", previousJobId: previous.id, previousPayloadHash: previous.payloadHash, externalId: previous.externalId!,
        paymentSourceHash: correctionStateHash(value.bill.payments), documentSourceHash: correctionStateHash(value.bill.documents),
        remoteLineIds: remote.line_items.map(line => line.line_item_id), remoteDocuments: remote.documents, remoteLastModified: remote.last_modified_time,
        preservedRemoteNotes: reviewedBooksUpdateNotes(oldPayload.notes, newPayload.notes, remote.notes) };
    } else if (value.mutation) await remoteAbsence(transport, snapshotSchema.parse(value.mutation.snapshot), desired);
  } else if (policy.mode === "provider_update") throw blocked("The existing Books bill cannot be edited while its original connection is unavailable.");
  if ((await editContext(db, actor, billId)).fingerprint !== value.fingerprint) throw blocked("The bill, payments, originals or company access changed during edit preparation.");
  const proof = Object.freeze({ kind: "verified-finalized-bill-edit" as const });
  proofs.set(proof, { actorId: actor.id, billId, mutationId: value.mutation?.id ?? null, expectedVersion, desiredHash: correctionStateHash(desired), sourceHash: value.fingerprint,
    expiresAt: Date.now() + 60_000, consumed: false, mode: policy.mode, revision });
  return proof;
}
/** Same lock order as the worker; held state is consumed once in this transaction. */
export async function assertFinalizedBillEdit(tx: Store, actor: Actor, proof: FinalizedBillEditProof, desired: BillSnapshot) {
  const held = proofs.get(proof);
  if (!held || held.consumed || held.actorId !== actor.id || held.expiresAt <= Date.now() || held.desiredHash !== correctionStateHash(desired))
    throw blocked("Prepare the exact current bill edit again before saving.");
  if (held.mutationId) await tx.$queryRaw(Prisma.sql`SELECT \`id\` FROM \`IntegrationJob\` WHERE \`id\`=${held.mutationId} FOR UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT \`id\` FROM \`Bill\` WHERE \`id\`=${held.billId} FOR UPDATE`);
  if (await tx.paymentBooksSync.count({ where: { billId: held.billId, status: { in: ["PROCESSING", "UNKNOWN"] } } }))
    throw new HttpError(409, "This bill's Books payment synchronization is in progress or its outcome is uncertain. Wait for confirmation or reconcile the payment before editing the bill.", "PAYMENT_SYNC_ACTIVE");
  await tx.$queryRaw(Prisma.sql`SELECT \`id\` FROM \`IntegrationJob\` WHERE \`billId\`=${held.billId} FOR UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT \`id\` FROM \`Payment\` WHERE \`billId\`=${held.billId} FOR UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT \`id\` FROM \`Document\` WHERE \`billId\`=${held.billId} FOR UPDATE`);
  const value = await editContext(tx, actor, held.billId), policy = eligibility(value);
  if (held.expiresAt <= Date.now() || value.fingerprint !== held.sourceHash || value.bill.version !== held.expectedVersion || !policy.allowed || policy.mode !== held.mode)
    throw blocked("The saved bill or current payment/synchronization authority changed before this edit could be applied.");
  if (value.config) {
    const mapping = await tx.vendorBooksMapping.findUnique({ where: { vendorId_organizationId_dataCenter_environment: {
      vendorId: desired.vendorId, organizationId: value.config.organizationId, dataCenter: value.config.dataCenter, environment: value.config.environment,
    } } });
    if (!mapping || mapping.externalVendorId !== desired.externalVendorId) throw blocked("The edited supplier's exact Books mapping changed before saving.");
  }
  held.consumed = true;
  return { ...value, mode: held.mode, revision: held.revision };
}
