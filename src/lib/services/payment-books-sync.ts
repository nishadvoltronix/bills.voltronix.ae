import "server-only";
import { randomBytes } from "node:crypto";
import { Prisma, type PaymentBooksSync } from "@prisma/client";
import Decimal from "decimal.js";
import { z } from "zod";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import { isManualEntryOnly } from "@/lib/application-mode";
import { requireCompanyAccess } from "@/lib/company";
import { assertWrite, booksConfigurationHash, getConfig, IntegrationError, safeFailure, type ZohoConfig } from "@/lib/integrations/config";
import { connectionFingerprint } from "@/lib/integrations/connection-fingerprint";
import { accessToken, LEGACY_UNSCOPED_ORGANIZATION } from "@/lib/integrations/oauth";
import { ZohoTransport } from "@/lib/integrations/transport";
import { currentBooksMutation } from "@/lib/integrations/books-mutations";
import { approvedSnapshot, sourceInclude } from "@/lib/integrations/source-snapshot";
import { snapshotHash, snapshotSchema } from "@/lib/integrations/books";
import { buildPaymentPayload, paymentAcknowledgementId, paymentSourceHash, paymentSnapshotSchema, reconcileBooksPayment, validatePaymentBill } from "@/lib/integrations/books-payments";
import { paymentWriteCapability, paymentWriteWasSubmitted, type PaymentWriteCapability } from "@/lib/integrations/payment-write";

type Store = Prisma.TransactionClient;
export type PaymentTransportFactory = (config: ZohoConfig, capability?: PaymentWriteCapability) => ZohoTransport;
const transportFor: PaymentTransportFactory = (config, capability) => new ZohoTransport(config, () => accessToken(config), fetch, undefined, undefined, undefined, capability);
const blocked = (code: string, message: string) => new IntegrationError(code, message, "BLOCKED");
const sourceSelection = { ...sourceInclude, payments: { orderBy: { id: "asc" as const } } } as const;

function paymentFields(payment: { id: string; billId: string; amount: Prisma.Decimal; reference: string; createdById: string; createdAt: Date;
  paymentDate: Date | null; paymentMode: string | null; paidThroughAccountId: string | null }) {
  return { id: payment.id, billId: payment.billId, amount: payment.amount.toFixed(2), reference: payment.reference, createdById: payment.createdById,
    createdAt: payment.createdAt.toISOString(), paymentDate: payment.paymentDate?.toISOString().slice(0, 10),
    paymentMode: payment.paymentMode, paidThroughAccountId: payment.paidThroughAccountId };
}
function financialSource(bill: Parameters<typeof approvedSnapshot>[0], externalVendorId: string) {
  const source = approvedSnapshot(bill, externalVendorId);
  return { ...source, sourceVersion: 1 };
}
async function actorAccess(store: Store, actor: Pick<Actor, "id" | "role">, companyId: string, ownerId?: string) {
  if (!["ADMIN", "ACCOUNTS"].includes(actor.role) || !await store.user.findFirst({ where: { id: actor.id, active: true, role: actor.role,
    memberships: { some: { companyId, active: true, company: { active: true } } } }, select: { id: true } }) ||
    ownerId && actor.role !== "ADMIN" && ownerId !== actor.id) throw new HttpError(403, "Current payment access to this bill and company is required.");
}
async function configFor(store: Store, companyId: string) {
  const destinations = await store.companyIntegrationDestination.findMany({ where: { companyId, target: "ZOHO" } });
  if (destinations.length !== 1) throw blocked("PAYMENT_DESTINATION_REQUIRED", "One verified Books destination is required for payment synchronization.");
  const destination = destinations[0], config = getConfig("ZOHO", process.env, destination.organizationId);
  if (config.dataCenter !== destination.dataCenter || config.environment !== destination.environment)
    throw blocked("PAYMENT_DESTINATION_CHANGED", "The payment destination differs from this company's Books connection.");
  return { destination, config };
}

/** New complete payments only. Legacy null metadata never becomes an automatic payment intent. */
export async function enqueuePaymentBooksSync(tx: Store, paymentId: string, initiatedById?: string): Promise<PaymentBooksSync | null> {
  const payment = await tx.payment.findUnique({ where: { id: paymentId }, include: { bill: { include: sourceSelection } } });
  if (!payment) throw new HttpError(404, "Payment not found.");
  if (!payment.paymentDate || !payment.paymentMode || !payment.paidThroughAccountId || isManualEntryOnly()) return null;
  const actorId = initiatedById ?? payment.createdById;
  const actor = await tx.user.findUnique({ where: { id: actorId }, select: { id: true, role: true } });
  if (!actor) throw new HttpError(403, "Current payment access is required.");
  const bill = payment.bill;
  await actorAccess(tx, actor, bill.companyId, bill.createdById);
  if (!bill.company.liveAccountingEnabled) return null;
  if (!await tx.companyIntegrationDestination.count({ where: { companyId: bill.companyId, target: "ZOHO" } })) return null;
  const { destination, config } = await configFor(tx, bill.companyId);
  if (bill.currency !== config.booksMapping?.baseCurrency) throw blocked("PAYMENT_EXCHANGE_RATE_REQUIRED", "Books payment synchronization currently supports the company's verified base currency only. No payment record was changed.");
  const mapping = await tx.vendorBooksMapping.findUnique({ where: { vendorId_organizationId_dataCenter_environment: {
    vendorId: bill.vendorId, organizationId: config.organizationId, dataCenter: config.dataCenter, environment: config.environment } } });
  if (!mapping || !/^\d{1,30}$/.test(mapping.externalVendorId)) throw blocked("PAYMENT_VENDOR_MAPPING_REQUIRED", "The bill supplier needs its exact Books mapping before a payment can synchronize.");
  const snapshot = paymentSnapshotSchema.parse({ payment: paymentFields(payment), bill: { id: bill.id, companyId: bill.companyId,
    createdById: bill.createdById, vendorId: bill.vendorId, jobId: bill.jobId, invoiceNumber: bill.invoiceNumber,
    invoiceDate: bill.invoiceDate.toISOString().slice(0, 10), currency: bill.currency, total: bill.total.toFixed(2), externalVendorId: mapping.externalVendorId,
    sourceHash: paymentSourceHash(financialSource(bill, mapping.externalVendorId)) }, destination: {
    organizationId: config.organizationId, dataCenter: config.dataCenter, environment: config.environment,
    connectionFingerprint: connectionFingerprint(config), configurationHash: booksConfigurationHash(config) } });
  const existing = await tx.paymentBooksSync.findUnique({ where: { paymentId } });
  if (existing) {
    if (existing.sourceHash !== paymentSourceHash(snapshot) || existing.initiatedById !== actorId)
      throw blocked("PAYMENT_INTENT_CHANGED", "The existing payment intent is immutable. Review its original outcome before changing it.");
    return existing;
  }
  let failure: IntegrationError | null = null;
  try { assertWrite(config); } catch (error) { failure = safeFailure(error); }
  const queued = await tx.paymentBooksSync.create({ data: { paymentId, billId: bill.id, companyId: bill.companyId, initiatedById: actorId,
    organizationId: config.organizationId, dataCenter: config.dataCenter, environment: config.environment,
    snapshot: snapshot as Prisma.InputJsonValue, sourceHash: paymentSourceHash(snapshot),
    ...(failure || !destination.liveEnabled && config.environment === "production" ? { status: "BLOCKED", errorCode: failure?.code ?? "PAYMENT_DESTINATION_DISABLED",
      lastError: failure?.message ?? "This company's Books payment destination is not enabled." } : {}) } });
  await tx.auditLog.create({ data: { actorId, companyId: bill.companyId, action: "PAYMENT_BOOKS_QUEUED", entityType: "Payment", entityId: paymentId,
    details: { paymentSyncId: queued.id, organizationId: config.organizationId, sourceHash: queued.sourceHash, status: queued.status } } });
  return queued;
}

export async function assertPaymentBooksSource(job: PaymentBooksSync, config: ZohoConfig) {
  if (isManualEntryOnly()) throw blocked("PAYMENT_MANUAL_MODE", "Books payment synchronization is disabled in manual-only mode.");
  const snapshot = paymentSnapshotSchema.parse(job.snapshot);
  const payment = await db.payment.findUnique({ where: { id: job.paymentId }, include: { bill: { include: sourceSelection } } });
  const actor = await db.user.findUnique({ where: { id: job.initiatedById }, select: { id: true, role: true } });
  if (!payment || !actor) throw blocked("PAYMENT_SOURCE_UNAVAILABLE", "The original payment or its authorized user is unavailable.");
  const bill = payment.bill;
  try { await actorAccess(db, actor, bill.companyId, bill.createdById); }
  catch (error) {
    if (error instanceof HttpError) throw blocked("PAYMENT_ACCESS_CHANGED", "Current payment access to the original bill and company was revoked. Administrator review is required.");
    throw error;
  }
  if (!bill.company.liveAccountingEnabled) throw blocked("PAYMENT_COMPANY_DISABLED", "This company has disabled automatic Books accounting.");
  const current = await configFor(db, bill.companyId);
  if (bill.currency !== config.booksMapping?.baseCurrency) throw blocked("PAYMENT_EXCHANGE_RATE_REQUIRED", "This payment needs a separately reviewed foreign-currency settlement before it can synchronize.");
  if (job.companyId !== bill.companyId || job.billId !== bill.id || snapshot.bill.id !== bill.id || snapshot.payment.id !== payment.id ||
    bill.createdById !== snapshot.bill.createdById || !["READY", "APPROVED"].includes(bill.status) || paymentSourceHash(paymentFields(payment)) !== paymentSourceHash(snapshot.payment) ||
    paymentSourceHash(financialSource(bill, snapshot.bill.externalVendorId)) !== snapshot.bill.sourceHash ||
    paymentSourceHash(snapshot) !== job.sourceHash || job.organizationId !== snapshot.destination.organizationId || job.dataCenter !== snapshot.destination.dataCenter ||
    job.environment !== snapshot.destination.environment || current.config.organizationId !== config.organizationId ||
    connectionFingerprint(config) !== snapshot.destination.connectionFingerprint || connectionFingerprint(current.config) !== snapshot.destination.connectionFingerprint ||
    booksConfigurationHash(config) !== snapshot.destination.configurationHash || booksConfigurationHash(current.config) !== snapshot.destination.configurationHash)
    throw blocked("PAYMENT_SOURCE_CHANGED", "The saved payment, bill or Books destination changed. Review the original payment intent.");
  const mapping = await db.vendorBooksMapping.findUnique({ where: { vendorId_organizationId_dataCenter_environment: {
    vendorId: bill.vendorId, organizationId: job.organizationId, dataCenter: job.dataCenter, environment: job.environment } } });
  if (!mapping || mapping.externalVendorId !== snapshot.bill.externalVendorId) throw blocked("PAYMENT_VENDOR_MAPPING_CHANGED", "The supplier's exact Books mapping changed after this payment was recorded.");
  const totalPaid = bill.payments.reduce((sum, row) => sum.plus(row.amount.toString()), new Decimal(0));
  if (!totalPaid.eq(bill.paidAmount.toString()) || totalPaid.gt(bill.total.toString())) throw blocked("PAYMENT_LEDGER_MISMATCH", "The local payment ledger does not reconcile to this bill.");
  const destination = current.destination;
  if (config.environment === "production" && (!config.liveRuntime || !bill.company.liveAccountingEnabled || bill.company.isDemo || bill.vendor.isDemo || bill.job.isDemo ||
    !destination.liveEnabled || !destination.verifiedAt || destination.verifiedAt > new Date() || !destination.verificationReference?.trim() ||
    destination.verifiedConfigurationHash !== booksConfigurationHash(config))) throw blocked("PAYMENT_LIVE_PERMISSION_REQUIRED", "An enabled verified real Books company is required for payment synchronization.");
  const grant = await db.integrationCredential.findUnique({ where: { target_organizationId: { target: "ZOHO", organizationId: config.organizationId } }, select: { revokedAt: true, connectionFingerprint: true } });
  if (grant ? grant.revokedAt || grant.connectionFingerprint !== connectionFingerprint(config) : !config.refreshToken ||
    await db.integrationCredential.findUnique({ where: { target_organizationId: { target: "ZOHO", organizationId: LEGACY_UNSCOPED_ORGANIZATION } }, select: { organizationId: true } }))
    throw blocked("PAYMENT_AUTHORIZATION_REQUIRED", "Current Books authorization for vendor payments is required.");
  const canonical = await currentBooksMutation(db, bill.id);
  if (!canonical || canonical.status !== "SUCCEEDED" || !canonical.externalId || canonical.organizationId !== job.organizationId)
    throw new IntegrationError("PAYMENT_BILL_PENDING", "Payment is waiting for the exact Books bill to finish synchronizing.", "RETRY");
  const original = snapshotSchema.parse(canonical.snapshot);
  if (snapshotHash(original) !== canonical.payloadHash || paymentSourceHash({ ...original, sourceVersion: 1, initiatedById: undefined,
    destination: undefined, revision: undefined, attachmentMode: undefined }) !== snapshot.bill.sourceHash)
    throw blocked("PAYMENT_CONFIRMED_SOURCE_CHANGED", "The latest confirmed Books bill differs from this payment source.");
  if (job.externalBillId && job.externalBillId !== canonical.externalId) throw blocked("PAYMENT_EXTERNAL_BILL_CHANGED", "The original Books bill identity changed.");
  return { snapshot, bill, externalBillId: canonical.externalId };
}

async function claim(paymentId?: string) {
  return db.$transaction(async tx => {
    const rows = await tx.$queryRaw<{ id: string; billId: string }[]>(Prisma.sql`SELECT p.id,p.billId FROM PaymentBooksSync p
      WHERE p.status IN ('QUEUED','UNKNOWN') AND p.nextAttemptAt <= ${new Date()}
      ${paymentId ? Prisma.sql`AND p.paymentId=${paymentId}` : Prisma.empty}
      ORDER BY p.nextAttemptAt,p.createdAt,p.id LIMIT 1 FOR UPDATE OF p SKIP LOCKED`);
    if (!rows.length) return null;
    const row = rows[0];
    if (!(await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id FROM Bill WHERE id=${row.billId} FOR UPDATE SKIP LOCKED`)).length) return null;
    if (await tx.integrationJob.count({ where: { billId: row.billId, target: "ZOHO", OR: [
      { status: "PROCESSING" },
      { operation: { not: "ATTACH_DOCUMENT" }, OR: [{ status: "UNKNOWN" }, { needsReconciliation: true, status: { not: "SUCCEEDED" } }] },
    ] } }) ||
      await tx.paymentBooksSync.count({ where: { billId: row.billId, id: { not: row.id }, status: { in: ["PROCESSING", "UNKNOWN"] } } })) return null;
    return tx.paymentBooksSync.update({ where: { id: row.id }, data: { status: "PROCESSING", attempts: { increment: 1 },
      leaseToken: randomBytes(32).toString("hex"), leaseUntil: new Date(Date.now() + 180_000) } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

export async function processPaymentBooksSyncs(limit = 5, options: { paymentId?: string; transportFactory?: PaymentTransportFactory } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 25 || options.paymentId && !/^[A-Za-z0-9_-]{1,100}$/.test(options.paymentId)) throw new HttpError(422, "Invalid payment synchronization selection.");
  if (options.transportFactory && (process.env.NODE_ENV !== "test" || process.env.APP_ENV === "production")) throw new HttpError(403, "Synthetic payment transports are restricted to isolated tests.");
  const factory = options.transportFactory ?? transportFor;
  // A crashed submitted request is uncertain; never convert it into a fresh POST.
  await db.paymentBooksSync.updateMany({ where: { status: "PROCESSING", leaseUntil: { lte: new Date() }, ...(options.paymentId ? { paymentId: options.paymentId } : {}) }, data: { status: "UNKNOWN", leaseToken: null, leaseUntil: null,
    errorCode: "PAYMENT_LEASE_EXPIRED", lastError: "The payment worker stopped before confirmation. Only reconciliation is allowed." } });
  let processed = 0;
  for (; processed < limit; processed++) {
    const job = await claim(options.paymentId);
    if (!job) break;
    let capability: PaymentWriteCapability | undefined;
    try {
      const config = getConfig("ZOHO", process.env, job.organizationId);
      const source = await assertPaymentBooksSource(job, config);
      const reader = factory(config);
      const existing = await reconcileBooksPayment(reader, source.snapshot, source.externalBillId);
      let externalPaymentId = existing;
      if (!externalPaymentId) {
        if (job.submittedAt) throw new IntegrationError("PAYMENT_OUTCOME_UNKNOWN", "The original submitted payment has not been found. Review the Books outcome before attempting another creation.", "UNKNOWN");
        validatePaymentBill(await reader.request(`/books/v3/bills/${source.externalBillId}`, { method: "GET" }), source.snapshot, source.externalBillId);
        await assertPaymentAccount(config, source.snapshot.payment.paidThroughAccountId, source.snapshot.bill.currency, reader);
        const marked = await db.paymentBooksSync.updateMany({ where: { id: job.id, status: "PROCESSING", leaseToken: job.leaseToken, submittedAt: null },
          data: { submittedAt: new Date(), externalBillId: source.externalBillId } });
        if (marked.count !== 1) throw blocked("PAYMENT_LEASE_CHANGED", "The payment lease changed before submission.");
        capability = paymentWriteCapability(job.id, job.leaseToken!);
        const writer = factory(config, capability);
        const response = await writer.request("/books/v3/vendorpayments", { method: "POST", body: buildPaymentPayload(source.snapshot, source.externalBillId) });
        const acknowledgement = paymentAcknowledgementId(response);
        externalPaymentId = await reconcileBooksPayment(reader, source.snapshot, source.externalBillId);
        if (!externalPaymentId) throw new IntegrationError("PAYMENT_CREATE_UNCONFIRMED", "The submitted Books payment could not yet be confirmed. Only reconciliation is allowed.", "UNKNOWN");
        if (externalPaymentId !== acknowledgement) throw new IntegrationError("PAYMENT_CONFIRMATION_CONFLICT", "The created payment identity differs from its reconciled Books record. Review before retrying.", "UNKNOWN");
      }
      const confirmedBill = validatePaymentBill(await reader.request(`/books/v3/bills/${source.externalBillId}`, { method: "GET" }), source.snapshot, source.externalBillId, false);
      if (new Decimal(confirmedBill.payment_made).lt(source.snapshot.payment.amount)) throw new IntegrationError("PAYMENT_BILL_UNCONFIRMED", "Books has not confirmed this payment in the bill's paid balance. Reconcile before retrying.", "UNKNOWN");
      await assertPaymentBooksSource(job, config);
      await db.$transaction(async tx => {
        const changed = await tx.paymentBooksSync.updateMany({ where: { id: job.id, status: "PROCESSING", leaseToken: job.leaseToken },
          data: { status: "SYNCED", externalBillId: source.externalBillId, externalPaymentId, completedAt: new Date(), errorCode: null, lastError: null, leaseToken: null, leaseUntil: null } });
        if (changed.count) await tx.auditLog.create({ data: { actorId: job.initiatedById, companyId: job.companyId, action: "PAYMENT_BOOKS_CONFIRMED", entityType: "Payment", entityId: job.paymentId,
          details: { paymentSyncId: job.id, organizationId: job.organizationId, externalBillId: source.externalBillId, externalPaymentId } } });
      });
    } catch (error) {
      const failure = safeFailure(error);
      const current = await db.paymentBooksSync.findUniqueOrThrow({ where: { id: job.id } });
      const definitelyRejected = ["REMOTE_REJECTED", "REMOTE_NOT_FOUND", "AUTHORIZATION_REQUIRED", "RATE_LIMITED"].includes(failure.code);
      const sent = capability ? paymentWriteWasSubmitted(capability) : current.submittedAt !== null;
      const uncertain = failure.kind === "UNKNOWN" || sent && !definitelyRejected;
      const retry = !uncertain && failure.kind === "RETRY";
      await db.paymentBooksSync.updateMany({ where: { id: job.id, status: "PROCESSING", leaseToken: job.leaseToken }, data: {
        status: uncertain ? "UNKNOWN" : retry ? "QUEUED" : failure.kind === "BLOCKED" ? "BLOCKED" : "FAILED",
        errorCode: failure.code, lastError: failure.message, nextAttemptAt: new Date(Date.now() + (uncertain ? 300_000 : 30_000)), leaseToken: null, leaseUntil: null,
        ...(!uncertain && (!sent || definitelyRejected) ? { submittedAt: null } : {}),
      } });
    }
  }
  return { processed };
}

async function readPaymentAccount(config: ZohoConfig, accountId: string, transport: ZohoTransport) {
  const raw = await transport.request(`/books/v3/chartofaccounts/${accountId}`, { method: "GET" });
  const body = z.record(z.string(), z.unknown()).parse(raw);
  if (Object.hasOwn(body, "chart_of_account") && Object.hasOwn(body, "account_id")) throw blocked("PAYMENT_ACCOUNT_UNVERIFIED", "Books returned conflicting payment account identities.");
  const row = Object.hasOwn(body, "chart_of_account") ? body.chart_of_account : body;
  const account = z.object({ account_id: z.string(), account_name: z.string(), account_type: z.enum(["bank", "cash"]), is_active: z.literal(true),
    currency_code: z.string().optional(), currency_id: z.string().optional() }).safeParse(row);
  if (body.code !== 0 || !account.success || account.data.account_id !== accountId)
    throw blocked("PAYMENT_ACCOUNT_UNVERIFIED", "Select an active bank or cash account in this bill's currency and company.");
  let identity = account.data;
  if (!identity.currency_code && !identity.currency_id) {
    let bank: unknown;
    try { bank = await transport.request(`/books/v3/bankaccounts/${accountId}`, { method: "GET" }); }
    catch (error) {
      if (error instanceof IntegrationError && error.code === "AUTHORIZATION_REQUIRED")
        throw blocked("PAYMENT_ACCOUNT_CURRENCY_AUTHORIZATION_REQUIRED", "Ask an administrator to reconnect Zoho Books so this bank or cash account's currency can be verified. No payment was sent.");
      throw error;
    }
    const parsed = z.object({ code: z.literal(0), bankaccount: z.object({ account_id: z.string(), account_name: z.string(),
      account_type: z.enum(["bank", "cash"]), is_active: z.literal(true), currency_code: z.string().optional(), currency_id: z.string().optional() }) }).safeParse(bank);
    if (!parsed.success || parsed.data.bankaccount.account_id !== accountId || parsed.data.bankaccount.account_type !== identity.account_type)
      throw blocked("PAYMENT_ACCOUNT_UNVERIFIED", "Books could not verify the exact active bank/cash account and its currency.");
    identity = parsed.data.bankaccount;
  }
  const currency = identity.currency_code ?? Object.entries(config.booksMapping?.currencies ?? {}).find(([, value]) => value.id === identity.currency_id)?.[0];
  if (!currency || !/^[A-Z]{3}$/.test(currency) || identity.currency_id && config.booksMapping?.currencies[currency]?.id && identity.currency_id !== config.booksMapping.currencies[currency].id)
    throw blocked("PAYMENT_ACCOUNT_UNVERIFIED", "Books did not report a consistent verified currency for this bank or cash account.");
  return { id: account.data.account_id, name: account.data.account_name, type: account.data.account_type, currency };
}
export async function assertPaymentAccount(config: ZohoConfig, accountId: string, currency: string, transport = transportFor(config)) {
  const account = await readPaymentAccount(config, accountId, transport);
  if (account.currency !== currency) throw blocked("PAYMENT_ACCOUNT_UNVERIFIED", "Select an active bank or cash account in this bill's currency and company.");
  return account;
}

async function readPaymentAccounts(actor: Actor, companyId: string) {
  await actorAccess(db, actor, companyId); await requireCompanyAccess(actor, companyId);
  const { config } = await configFor(db, companyId);
  const accounts: { id: string; name: string; type: "bank" | "cash"; currency: string }[] = [];
  const reader = transportFor(config);
  const organization = z.object({ code: z.literal(0), organization: z.object({ organization_id: z.string(), is_org_active: z.literal(true), currency_code: z.string(), currency_id: z.string() }) })
    .safeParse(await reader.request(`/books/v3/organizations/${config.organizationId}`, { method: "GET" }));
  if (!organization.success || organization.data.organization.organization_id !== config.organizationId ||
    organization.data.organization.currency_code !== config.booksMapping?.baseCurrency ||
    organization.data.organization.currency_id !== config.booksMapping?.currencies[config.booksMapping.baseCurrency]?.id)
    throw blocked("PAYMENT_ORGANIZATION_UNVERIFIED", "Books did not confirm this exact company's active account currency.");
  let complete = false;
  const seen = new Set<string>();
  let unverifiedAccounts = 0, foreignAccounts = 0;
  for (let page = 1; page <= 5; page++) {
    const raw = await reader.request("/books/v3/chartofaccounts", { method: "GET", query: { page: String(page), per_page: "200" } });
    const parsed = z.object({ code: z.literal(0), chartofaccounts: z.array(z.object({ account_id: z.string().regex(/^\d{1,30}$/), account_name: z.string(), account_type: z.string(), is_active: z.boolean(),
      currency_code: z.string().optional(), currency_id: z.string().optional() })).max(200), page_context: z.object({ has_more_page: z.boolean(), page: z.number().optional() }).optional() }).parse(raw);
    if (parsed.page_context?.page !== undefined && parsed.page_context.page !== page || page > 1 && parsed.page_context?.page !== page)
      throw blocked("PAYMENT_ACCOUNTS_INCOMPLETE", "Books did not confirm the selected payment-account page.");
    for (const row of parsed.chartofaccounts) {
      if (seen.has(row.account_id)) throw blocked("PAYMENT_ACCOUNTS_INCOMPLETE", "Books repeated a payment account identity. Reload the account catalog.");
      seen.add(row.account_id);
      if (!row.is_active || !["bank", "cash"].includes(row.account_type)) continue;
      try {
        const verified = await readPaymentAccount(config, row.account_id, reader);
        if (verified.currency !== config.booksMapping?.baseCurrency) { foreignAccounts++; continue; }
        accounts.push(verified);
      } catch (error) {
        if (error instanceof IntegrationError && ["AUTHORIZATION_REQUIRED", "PAYMENT_ACCOUNT_CURRENCY_AUTHORIZATION_REQUIRED"].includes(error.code)) throw error;
        unverifiedAccounts++;
      }
    }
    if (!(parsed.page_context?.has_more_page ?? parsed.chartofaccounts.length >= 200)) { complete = true; break; }
  }
  if (!complete) throw blocked("PAYMENT_ACCOUNTS_INCOMPLETE", "The Books bank/cash account catalog exceeded its safe limit.");
  await actorAccess(db, actor, companyId); await requireCompanyAccess(actor, companyId);
  const current = await configFor(db, companyId);
  if (connectionFingerprint(current.config) !== connectionFingerprint(config)) throw new HttpError(409, "The Books company connection changed. Reload payment accounts.");
  const warnings = [
    ...(unverifiedAccounts ? ["Some bank/cash accounts could not be verified and were excluded. You can select a verified account or retry."] : []),
    ...(foreignAccounts ? ["Only company base-currency payment accounts are supported; foreign-currency accounts were excluded."] : []),
  ];
  return { companyId, accounts, warning: warnings.length ? warnings.join(" ") : null };
}

/** Shared by plain HTTP handlers and payment preflight; provider failures stay safe and actionable. */
export async function getPaymentAccounts(actor: Actor, companyId: string) {
  try { return await readPaymentAccounts(actor, companyId); }
  catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof IntegrationError) {
      const authorization = ["AUTHORIZATION_REQUIRED", "PAYMENT_ACCOUNT_CURRENCY_AUTHORIZATION_REQUIRED", "PAYMENT_AUTHORIZATION_REQUIRED"].includes(error.code);
      throw new HttpError(error.code === "PAYMENT_ACCOUNT_UNVERIFIED" ? 422 : 503,
        authorization ? "Ask an administrator to reconnect this company's Zoho Books access so bank and cash account currencies can be verified. No payment was sent."
          : error.message, error.code);
    }
    throw new HttpError(503, "Books payment accounts could not be verified. Retry or ask an administrator to check the company connection.", "PAYMENT_ACCOUNTS_UNAVAILABLE");
  }
}
