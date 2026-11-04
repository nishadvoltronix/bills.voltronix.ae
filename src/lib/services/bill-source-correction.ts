import "server-only";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import Decimal from "decimal.js";
import { z } from "zod";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { BOOKS_NO_VAT, BOOKS_NO_VAT_NAME, booksSelectionSchema } from "@/lib/books-selection";
import { calculateBill, normalizeInvoiceNumber } from "@/lib/finance";
import { HttpError } from "@/lib/http";
import { booksMappingFingerprint, buildBooksPayload, snapshotHash, snapshotSchema, stableReference, verifySelectedLineMetadata } from "@/lib/integrations/books";
import { assertWrite, booksConfigurationHash, getConfig, IntegrationError } from "@/lib/integrations/config";
import { accessToken, connectionFingerprint } from "@/lib/integrations/oauth";
import { savedSourceSnapshot } from "@/lib/integrations/live-sync";
import { enqueueReadyBillTx } from "@/lib/integrations/queue";
import { approvedSnapshot, sourceInclude } from "@/lib/integrations/source-snapshot";
import { assertDefiniteSourceRejection, correctionStateHash, isSupersededIntegrationJob, SOURCE_SUPERSEDED,
  sourceSupersessionQueueProof, supersededSourceKey } from "@/lib/integrations/source-supersession";
import { ZohoTransport } from "@/lib/integrations/transport";
import { readPrivateDocument } from "./documents";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const externalId = z.string().regex(/^\d{1,30}$/);
const label = z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/);
const inputSchema = z.object({
  billId: id, expectedVersion: z.number().int().positive(), organizationId: externalId,
  reason: z.string().trim().min(15).max(1000), reference: z.string().trim().min(5).max(200),
  evidence: z.array(z.object({ documentId: id, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(100),
  change: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("vendor"), vendorId: id, externalVendorId: externalId,
      expectedVendorName: label, expectedVendorTrn: z.string().regex(/^\d{15}$/) }).strict(),
    z.object({ kind: z.literal("no_vat") }).strict(),
  ]),
}).strict();
export type BillSourceCorrectionInput = z.infer<typeof inputSchema>;
const correctionInclude = { ...sourceInclude, payments: { orderBy: { id: "asc" as const } }, syncRecords: true } satisfies Prisma.BillInclude;
type CorrectionBill = Prisma.BillGetPayload<{ include: typeof correctionInclude }>;
type Store = Prisma.TransactionClient;
const unsafe = (message: string) => new IntegrationError("SOURCE_CORRECTION_UNSAFE", message, "BLOCKED");
const proofLifetime = 60_000;
export type BillSourceCorrectionProof = Readonly<{ kind: "reviewed-bill-source-correction" }>;

async function context(store: Store, actor: Actor, input: BillSourceCorrectionInput) {
  if (actor.role !== "ADMIN") throw new HttpError(403, "Only a current company administrator may correct an unsynchronized finalized bill source.");
  const bill = await store.bill.findUnique({ where: { id: input.billId }, include: correctionInclude });
  if (!bill) throw new HttpError(404, "Bill not found.");
  const administrator = await store.user.findFirst({ where: { id: actor.id, role: "ADMIN", active: true,
    memberships: { some: { companyId: bill.companyId, active: true, company: { active: true } } } }, select: { id: true, role: true } });
  if (!administrator) throw new HttpError(403, "Current administrator access to this exact company is required.");
  if (bill.version !== input.expectedVersion || !["READY", "APPROVED"].includes(bill.status))
    throw new HttpError(409, "The finalized bill version changed. Prepare and review the source correction again.");
  const config = getConfig("ZOHO", process.env, input.organizationId);
  assertWrite(config);
  const [destinations, grant, jobs, oldMapping, replacement] = await Promise.all([
    store.companyIntegrationDestination.findMany({ where: { companyId: bill.companyId, target: "ZOHO" } }),
    store.integrationCredential.findUnique({ where: { target_organizationId: { target: "ZOHO", organizationId: input.organizationId } },
      select: { organizationId: true, revokedAt: true, connectionFingerprint: true } }),
    store.integrationJob.findMany({ where: { billId: bill.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      include: { history: { orderBy: [{ finishedAt: "asc" }, { id: "asc" }] } } }),
    store.vendorBooksMapping.findUnique({ where: { vendorId_organizationId_dataCenter_environment: {
      vendorId: bill.vendorId, organizationId: config.organizationId, dataCenter: config.dataCenter, environment: config.environment,
    } } }),
    input.change.kind === "vendor" ? store.vendor.findUnique({ where: { id: input.change.vendorId } }) : Promise.resolve(null),
  ]);
  const destination = destinations.length === 1 ? destinations[0] : null;
  if (!bill.company.active || bill.company.isDemo || bill.vendor.isDemo || bill.job.isDemo ||
    bill.companyId !== bill.vendor.companyId || bill.companyId !== bill.job.companyId ||
    !destination || destination.organizationId !== config.organizationId || destination.dataCenter !== config.dataCenter || destination.environment !== config.environment ||
    !grant || grant.revokedAt || grant.connectionFingerprint !== connectionFingerprint(config) || !oldMapping)
    throw unsafe("The source must retain its exact real company, supplier mapping, destination and current organization-scoped authorization.");
  if (config.environment === "production" && (!config.liveRuntime || !bill.company.liveAccountingEnabled || !destination.liveEnabled ||
    !destination.verifiedAt || destination.verifiedAt > new Date() || !destination.verificationReference?.trim() ||
    destination.verifiedConfigurationHash !== booksConfigurationHash(config)))
    throw unsafe("This real company and exact Books configuration must remain verified and enabled.");
  const original = jobs.find(job => job.idempotencyKey === `ZOHO:${bill.id}:CREATE_BILL`);
  if (!original || original.organizationId !== config.organizationId) throw unsafe("The exact original canonical Books operation is required.");
  assertDefiniteSourceRejection(original, original.history);
  if (jobs.some(job => job.id !== original.id && (!isSupersededIntegrationJob(job) || job.status !== "CANCELLED" || job.externalId ||
    job.needsReconciliation || job.leaseToken || job.leaseUntil || job.history.some(attempt => attempt.externalId || ["UNKNOWN", "SUCCEEDED"].includes(attempt.outcome)))))
    throw unsafe("Another attachment, queued, processing, confirmed or uncertain operation must be resolved before this source can be corrected.");
  const sync = bill.syncRecords.find(record => record.target === "ZOHO");
  if (!sync || sync.status !== "FAILED" || sync.organizationId !== config.organizationId || sync.externalId || sync.attempts < original.attempts ||
    bill.syncRecords.some(record => record.externalId || ["PENDING", "UNKNOWN", "SYNCED"].includes(record.status)))
    throw unsafe("The persisted synchronization outcome is not a definite unsynchronized rejection.");
  const originalSnapshot = snapshotSchema.parse(original.snapshot);
  const currentSnapshot = approvedSnapshot(bill, oldMapping.externalVendorId);
  currentSnapshot.sourceVersion = originalSnapshot.sourceVersion;
  currentSnapshot.destination = originalSnapshot.destination;
  currentSnapshot.initiatedById = originalSnapshot.initiatedById;
  if (snapshotHash(originalSnapshot) !== original.payloadHash || snapshotHash(currentSnapshot) !== original.payloadHash ||
    original.sourceVersion !== originalSnapshot.sourceVersion || originalSnapshot.destination?.dataCenter !== config.dataCenter ||
    originalSnapshot.destination.environment !== config.environment || originalSnapshot.destination.mappingHash !== booksMappingFingerprint(config))
    throw unsafe("The current exported source no longer matches the rejected original operation.");
  const paid = bill.payments.reduce((sum, payment) => sum.plus(payment.amount.toString()), new Decimal(0));
  if (!paid.equals(bill.paidAmount.toString())) throw unsafe("The saved payment rows do not reconcile to the paid amount. Resolve that separately.");
  if (new Set(input.evidence.map(item => item.documentId)).size !== input.evidence.length || input.evidence.some(item =>
    !bill.documents.some(document => document.id === item.documentId && document.sha256 === item.sha256)))
    throw unsafe("The reviewed original attachments must belong to this exact bill and retain their verified hashes.");
  let replacementMapping = null;
  if (input.change.kind === "vendor") {
    if (!replacement || replacement.id === bill.vendorId || replacement.companyId !== bill.companyId || replacement.currency !== bill.currency || replacement.isDemo ||
      (replacement.trn && replacement.trn !== input.change.expectedVendorTrn))
      throw unsafe("Choose the distinct existing supplier in this exact company and currency, matching the reviewed invoice registration.");
    replacementMapping = await store.vendorBooksMapping.findUnique({ where: { vendorId_organizationId_dataCenter_environment: {
      vendorId: replacement.id, organizationId: config.organizationId, dataCenter: config.dataCenter, environment: config.environment,
    } } });
    if (!replacementMapping || replacementMapping.externalVendorId !== input.change.externalVendorId)
      throw unsafe("The replacement supplier must have its exact reviewed Books mapping already established.");
    if (await store.bill.findFirst({ where: { id: { not: bill.id }, vendorId: replacement.id,
      normalizedInvoiceNumber: bill.normalizedInvoiceNumber }, select: { id: true } }))
      throw unsafe("Another native bill already has this invoice number under the corrected supplier. Review that duplicate before applying a correction.");
  }
  const result = { bill, config, administrator, destination, grant, jobs, original, sync, oldMapping, replacement, replacementMapping };
  return { ...result, fingerprint: correctionStateHash({ ...result, config: { configurationHash: booksConfigurationHash(config),
    connectionFingerprint: connectionFingerprint(config), writeEnabled: config.writeEnabled, liveRuntime: config.liveRuntime } }) };
}
type CorrectionContext = Awaited<ReturnType<typeof context>>;
function protectedState(bill: CorrectionBill) {
  const { vendorId: _vendorId, vendor: _vendor, version: _version, updatedAt: _updatedAt, syncRecords: _syncRecords,
    company: _company, job: _job, lines, ...fields } = bill;
  void _vendorId; void _vendor; void _version; void _updatedAt; void _syncRecords; void _company; void _job;
  return { ...fields, lines: lines.map(line => {
    const selection = line.booksSelection ? booksSelectionSchema.parse(line.booksSelection) : null;
    if (!selection) return line;
    const { taxId: _taxId, taxName: _taxName, taxRate: _taxRate, ...preserved } = selection;
    void _taxId; void _taxName; void _taxRate;
    return { ...line, booksSelection: preserved };
  }) };
}
function correctedBill(value: CorrectionContext, input: BillSourceCorrectionInput): CorrectionBill {
  const bill = value.bill;
  let candidate: CorrectionBill;
  if (input.change.kind === "vendor") {
    if (!value.replacement) throw unsafe("The reviewed replacement supplier is missing.");
    candidate = { ...bill, vendorId: value.replacement.id, vendor: value.replacement };
  } else {
    if (!bill.usesBooksLineTaxes || !new Decimal(bill.vatRate.toString()).isZero() || !new Decimal(bill.vatAmount.toString()).isZero())
      throw unsafe("No VAT correction is limited to a zero-amount VAT bill with explicit zero-rate Books selections.");
    candidate = { ...bill, lines: bill.lines.map(line => {
      const selection = booksSelectionSchema.parse(line.booksSelection);
      if (selection.taxId === BOOKS_NO_VAT || !new Decimal(selection.taxRate).isZero())
        throw unsafe("Every original line must select an explicit zero-rate tax before it can be corrected to No VAT.");
      return { ...line, booksSelection: { ...selection, taxId: BOOKS_NO_VAT, taxName: BOOKS_NO_VAT_NAME, taxRate: "0.00" } };
    }) };
  }
  const snapshot = approvedSnapshot(candidate, value.replacementMapping?.externalVendorId ?? value.oldMapping.externalVendorId);
  const totals = calculateBill(snapshot.lines, snapshot.discount, snapshot.vatRate);
  if (!new Decimal(totals.subtotal).equals(snapshot.subtotal) || !new Decimal(totals.vatAmount).equals(snapshot.vatAmount) ||
    !new Decimal(totals.total).equals(snapshot.total) || correctionStateHash(protectedState(candidate)) !== correctionStateHash(protectedState(bill)))
    throw unsafe("The correction must preserve every amount, payment, document and unrelated source field.");
  buildBooksPayload(snapshot, value.config);
  return candidate;
}

const contactSchema = z.object({ code: z.literal(0), contact: z.object({ contact_id: externalId, contact_name: label,
  contact_type: z.literal("vendor"), status: z.literal("active"), currency_code: z.string(),
  tax_treatment: z.unknown().optional(), tax_reg_no: z.unknown().optional() }) });
async function verifyContacts(transport: ZohoTransport, value: CorrectionContext, input: BillSourceCorrectionInput) {
  const ids = new Set([value.oldMapping.externalVendorId, value.replacementMapping?.externalVendorId].filter((id): id is string => Boolean(id)));
  const contacts = [];
  for (const contactId of ids) {
    const parsed = contactSchema.safeParse(await transport.request(`/books/v3/contacts/${contactId}`, { method: "GET" }));
    if (!parsed.success || parsed.data.contact.contact_id !== contactId || parsed.data.contact.currency_code !== value.bill.currency)
      throw unsafe("The exact supplier identity, active status and invoice currency could not be confirmed in Books.");
    if (input.change.kind === "vendor" && contactId === input.change.externalVendorId &&
      (parsed.data.contact.contact_name !== input.change.expectedVendorName || parsed.data.contact.tax_treatment !== "vat_registered" ||
        parsed.data.contact.tax_reg_no !== input.change.expectedVendorTrn))
      throw unsafe("The replacement Books supplier does not match the exact reviewed legal identity and VAT registration.");
    contacts.push({ contactId, name: parsed.data.contact.contact_name, taxTreatment: parsed.data.contact.tax_treatment,
      taxRegistration: typeof parsed.data.contact.tax_reg_no === "string" ? parsed.data.contact.tax_reg_no : null });
  }
  return contacts;
}
async function proveRemoteAbsence(transport: ZohoTransport, value: CorrectionContext) {
  const reference = stableReference(value.bill.id), invoice = value.bill.invoiceNumber;
  const queries: { kind: string; query: Record<string, string> }[] = [
    { kind: "invoice_text", query: { search_text: invoice } },
    { kind: "reference_text", query: { search_text: reference } },
    { kind: "reference_exact", query: { reference_number: reference } },
    ...[...new Set([value.oldMapping.externalVendorId, value.replacementMapping?.externalVendorId].filter((id): id is string => Boolean(id)))]
      .map(vendorId => ({ kind: "invoice_vendor", query: { bill_number: invoice, vendor_id: vendorId } })),
  ];
  const pageSchema = z.object({ code: z.literal(0), bills: z.array(z.object({ bill_id: externalId, bill_number: z.string(),
    vendor_id: externalId, reference_number: z.string() })).max(200),
    page_context: z.object({ page: z.number().int().positive().optional(), has_more_page: z.boolean() }) });
  const evidence = [];
  for (const query of queries) {
    const seen = new Set<string>();
    let completed = false, pages = 0;
    for (let page = 1; page <= 10; page++) {
      const parsed = pageSchema.safeParse(await transport.request("/books/v3/bills", { method: "GET", query: { ...query.query, page: String(page), per_page: "200" } }));
      if (!parsed.success || (parsed.data.page_context.page !== undefined && parsed.data.page_context.page !== page))
        throw unsafe("Books returned an unverifiable duplicate search. No source correction was applied.");
      pages++;
      for (const row of parsed.data.bills) {
        if (seen.has(row.bill_id)) throw unsafe("Books repeated duplicate-search rows; complete remote absence was not established.");
        seen.add(row.bill_id);
        if (row.reference_number === reference || normalizeInvoiceNumber(row.bill_number) === normalizeInvoiceNumber(invoice))
          throw unsafe("A possible matching Books bill already exists. Reconcile it before any source correction.");
      }
      if (!parsed.data.page_context.has_more_page) { completed = true; break; }
      if (!parsed.data.bills.length) throw unsafe("Books duplicate-search pagination was incomplete.");
    }
    if (!completed) throw unsafe("Books duplicate-search exceeded its bounded limit. Remote absence is not proven.");
    evidence.push({ kind: query.kind, query: query.query, pages, inspected: seen.size, complete: true, matches: 0 });
  }
  return evidence;
}
type PreparedCorrection = { actorId: string; input: BillSourceCorrectionInput; fingerprint: string; originalJobId: string;
  expiresAt: number; consumed: boolean; providerEvidence: unknown; configurationHash: string };
const prepared = new WeakMap<BillSourceCorrectionProof, PreparedCorrection>();

/** Read-only preparation. Original invoice evidence is reviewed by the named Admin/reference. */
export async function prepareBillSourceCorrection(actor: Actor, payload: unknown, provided?: ZohoTransport) {
  const input = inputSchema.parse(payload);
  if (provided && (process.env.NODE_ENV !== "test" || process.env.APP_ENV !== "test" ||
    !/^bills_test_\d+_\d+$/.test(process.env.MYSQL_TEST_EXPECTED_DATABASE ?? "")))
    throw unsafe("Synthetic inspection transports are restricted to the isolated disposable integration-test environment.");
  const before = await context(db, actor, input);
  const candidate = correctedBill(before, input);
  if (provided && (booksConfigurationHash(provided.config) !== booksConfigurationHash(before.config) || !provided.config.networkEnabled))
    throw unsafe("The correction inspection connection does not match this exact company configuration.");
  const transport = provided ?? new ZohoTransport(before.config, () => accessToken(before.config));
  for (const document of before.bill.documents) await readPrivateDocument(document);
  const snapshot = approvedSnapshot(candidate, before.replacementMapping?.externalVendorId ?? before.oldMapping.externalVendorId);
  await verifySelectedLineMetadata(transport, snapshot);
  const contacts = await verifyContacts(transport, before, input);
  const searches = await proveRemoteAbsence(transport, before);
  if ((await context(db, actor, input)).fingerprint !== before.fingerprint)
    throw unsafe("The bill, current administrator, payment, attachment or destination changed while preparing the correction.");
  const proof = Object.freeze({ kind: "reviewed-bill-source-correction" as const });
  const expiresAt = Date.now() + proofLifetime;
  prepared.set(proof, { actorId: actor.id, input: structuredClone(input), fingerprint: before.fingerprint, originalJobId: before.original.id,
    expiresAt, consumed: false, providerEvidence: { contacts, searches, checkedAt: new Date().toISOString(), reference: stableReference(input.billId) },
    configurationHash: booksConfigurationHash(before.config) });
  return { proof, preview: { billId: input.billId, originalJobId: before.original.id, sourceVersion: before.bill.version,
    change: input.change, reason: input.reason, reference: input.reference, evidence: input.evidence,
    expiresAt: new Date(expiresAt).toISOString(), providerFinancialWrites: 0, amountsAndPaymentsUnchanged: true } };
}

/** One atomic audited amendment. Financial provider writes remain owned by the existing queue. */
export async function applyBillSourceCorrection(actor: Actor, proof: BillSourceCorrectionProof) {
  const held = prepared.get(proof);
  if (!held || held.consumed || held.actorId !== actor.id || actor.role !== "ADMIN" || held.expiresAt <= Date.now())
    throw unsafe("Prepare a fresh exact source correction with current administrator authority before applying it.");
  held.consumed = true;
  return db.$transaction(async tx => {
    await tx.$queryRaw(Prisma.sql`SELECT \`id\` FROM \`IntegrationJob\` WHERE \`id\`=${held.originalJobId} FOR UPDATE`);
    await tx.$queryRaw(Prisma.sql`SELECT \`id\` FROM \`Bill\` WHERE \`id\`=${held.input.billId} FOR UPDATE`);
    await tx.$queryRaw(Prisma.sql`SELECT \`id\` FROM \`IntegrationJob\` WHERE \`billId\`=${held.input.billId} FOR UPDATE`);
    await tx.$queryRaw(Prisma.sql`SELECT \`id\` FROM \`SyncRecord\` WHERE \`billId\`=${held.input.billId} FOR UPDATE`);
    await tx.$queryRaw(Prisma.sql`SELECT \`id\` FROM \`Payment\` WHERE \`billId\`=${held.input.billId} FOR UPDATE`);
    await tx.$queryRaw(Prisma.sql`SELECT \`id\` FROM \`Document\` WHERE \`billId\`=${held.input.billId} FOR UPDATE`);
    await tx.$queryRaw(Prisma.sql`SELECT \`id\` FROM \`BillLine\` WHERE \`billId\`=${held.input.billId} FOR UPDATE`);
    const before = await context(tx, actor, held.input);
    if (held.expiresAt <= Date.now() || before.original.id !== held.originalJobId || before.fingerprint !== held.fingerprint ||
      booksConfigurationHash(before.config) !== held.configurationHash)
      throw unsafe("The correction proof expired or its exact source changed before the locked transaction.");
    const candidate = correctedBill(before, held.input);
    const archiveKey = supersededSourceKey("ZOHO", before.bill.id, before.original.id);
    const archived = await tx.integrationJob.updateMany({ where: { id: before.original.id, idempotencyKey: before.original.idempotencyKey,
      status: before.original.status, payloadHash: before.original.payloadHash, needsReconciliation: false, externalId: null, leaseToken: null, leaseUntil: null },
      data: { idempotencyKey: archiveKey, status: "CANCELLED", errorCode: SOURCE_SUPERSEDED,
        lastError: "Retained as history before an audited bill source correction. This operation cannot be retried.", completedAt: new Date() } });
    if (archived.count !== 1) throw unsafe("The rejected original operation changed before archival.");
    const changed = await tx.bill.updateMany({ where: { id: before.bill.id, version: held.input.expectedVersion, status: before.bill.status },
      data: { ...(held.input.change.kind === "vendor" ? { vendorId: candidate.vendorId } : {}), version: { increment: 1 } } });
    if (changed.count !== 1) throw unsafe("The bill changed before its audited source correction.");
    if (held.input.change.kind === "no_vat") for (const line of candidate.lines)
      await tx.billLine.update({ where: { id: line.id }, data: { booksSelection: line.booksSelection as Prisma.InputJsonValue } });
    const updated = await tx.bill.findUniqueOrThrow({ where: { id: before.bill.id }, include: correctionInclude });
    if (correctionStateHash(protectedState(before.bill)) !== correctionStateHash(protectedState(updated)))
      throw unsafe("The correction changed a monetary amount, payment, attachment or unrelated source field.");
    const expected = await savedSourceSnapshot(tx, updated, before.config, actor.id);
    const expectedPayloadHash = snapshotHash(expected);
    const correctionId = randomUUID();
    const audit = await tx.auditLog.create({ data: { actorId: actor.id, companyId: before.bill.companyId,
      action: "BILL_SOURCE_CORRECTION_PREPARED", entityType: "Bill", entityId: before.bill.id, details: {
        correctionId, reason: held.input.reason, reference: held.input.reference, evidence: held.input.evidence,
        change: held.input.change, originalJobId: before.original.id, originalRoutingKey: before.original.idempotencyKey,
        archivedRoutingKey: archiveKey, originalPayloadHash: before.original.payloadHash, originalSourceVersion: before.original.sourceVersion,
        originalStatus: before.original.status, originalErrorCode: before.original.errorCode, originalLastError: before.original.lastError,
        oldSourceVersion: before.bill.version, newSourceVersion: updated.version, expectedPayloadHash,
        before: { vendorId: before.bill.vendorId, externalVendorId: before.oldMapping.externalVendorId,
          lineTaxes: before.bill.lines.map(line => ({ lineId: line.id, tax: line.booksSelection ? {
            taxId: booksSelectionSchema.parse(line.booksSelection).taxId, taxRate: booksSelectionSchema.parse(line.booksSelection).taxRate,
          } : null })) },
        after: { vendorId: updated.vendorId, externalVendorId: before.replacementMapping?.externalVendorId ?? before.oldMapping.externalVendorId,
          lineTaxes: updated.lines.map(line => ({ lineId: line.id, tax: line.booksSelection ? {
            taxId: booksSelectionSchema.parse(line.booksSelection).taxId, taxRate: booksSelectionSchema.parse(line.booksSelection).taxRate,
          } : null })) },
        protectedStateHash: correctionStateHash(protectedState(updated)), originalAttempts: before.original.attempts,
        priorSyncAttempts: before.sync.attempts, paymentStateHash: correctionStateHash(updated.payments),
        documentStateHash: correctionStateHash(updated.documents), providerAbsence: held.providerEvidence,
      } as unknown as Prisma.InputJsonValue } });
    const authority = sourceSupersessionQueueProof({ tx, actorId: actor.id, companyId: before.bill.companyId, billId: before.bill.id,
      sourceVersion: updated.version, organizationId: before.config.organizationId, originalJobId: before.original.id,
      originalPayloadHash: before.original.payloadHash, originalSnapshotHash: correctionStateHash(before.original.snapshot),
      expectedPayloadHash, syncRecordHash: correctionStateHash(before.sync), auditId: audit.id });
    const queued = await enqueueReadyBillTx(tx, before.bill.id, actor.id, before.config.organizationId, authority);
    if (!queued || queued.id === before.original.id || queued.idempotencyKey !== `ZOHO:${before.bill.id}:CREATE_BILL` ||
      queued.sourceVersion !== updated.version || queued.payloadHash !== expectedPayloadHash)
      throw unsafe("The corrected canonical operation could not be queued. The entire source correction was rolled back.");
    await tx.auditLog.create({ data: { actorId: actor.id, companyId: before.bill.companyId, action: "BILL_SOURCE_CORRECTED",
      entityType: "Bill", entityId: before.bill.id, details: { correctionId, preparedAuditId: audit.id, originalJobId: before.original.id,
        replacementJobId: queued.id, originalPayloadHash: before.original.payloadHash, replacementPayloadHash: queued.payloadHash,
        sourceVersion: updated.version, reason: held.input.reason, reference: held.input.reference,
        providerFinancialWrites: 0, monetaryAmountsChanged: false, paymentsChanged: false, attachmentsChanged: false } } });
    return { billId: updated.id, sourceVersion: updated.version, originalJobId: before.original.id, replacementJobId: queued.id,
      correctionId, auditId: audit.id, providerFinancialWrites: 0, monetaryAmountsChanged: false, paymentsChanged: false, attachmentsChanged: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20_000 });
}
