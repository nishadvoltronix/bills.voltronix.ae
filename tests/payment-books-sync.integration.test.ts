import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import Decimal from "decimal.js";
import { ZodError } from "zod";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import * as configuration from "@/lib/integrations/config";
import * as oauth from "@/lib/integrations/oauth";
import { approvedSnapshot, sourceInclude } from "@/lib/integrations/source-snapshot";
import { booksMappingFingerprint, buildBooksPayload, snapshotHash, snapshotSchema, stableReference } from "@/lib/integrations/books";
import { paymentReference, paymentSnapshotSchema } from "@/lib/integrations/books-payments";
import { ZohoTransport } from "@/lib/integrations/transport";
import { actOnBill, updateBill } from "@/lib/services/bills";
import { enqueuePaymentBooksSync, processPaymentBooksSyncs, type PaymentTransportFactory } from "@/lib/services/payment-books-sync";
import { assertMySqlTestDatabase } from "./company-fixtures";

const tag = randomUUID().slice(0, 8), organizationId = `8840${Date.now()}`;
const VENDOR = "88404", ACCOUNT = "88403";
const rawConfig = configuration.getConfig("ZOHO", {
  NODE_ENV: "test", APP_ENV: "test", INTEGRATION_NETWORK_ENABLED: "true", INTEGRATION_TEST_MODE: "true",
  ZOHO_BOOKS_WRITE_ENABLED: "true", ZOHO_BOOKS_DC: "US", ZOHO_BOOKS_ENVIRONMENT: "sandbox",
  ZOHO_BOOKS_ORGANIZATION_ID: organizationId, ZOHO_BOOKS_CLIENT_ID: "fictional-payment-client", ZOHO_BOOKS_CLIENT_SECRET: "fictional-payment-secret",
  ZOHO_BOOKS_MAPPING_JSON: JSON.stringify({ verified: true, baseCurrency: "AED", currencies: { AED: { id: "88401" } },
    taxes: { "5.00": { id: "88402", percentage: "5" } }, categories: { MATERIALS: { accountId: "88405" } } }),
});
const settings = { ...rawConfig, writeEnabled: true, testAuthorization: {
  mode: "nonproduction" as const, organizationId, dataCenter: "US" as const,
  configurationHash: configuration.booksTestConfigurationHash(rawConfig), approvedBy: "fictional-payment-operator",
  approvalReference: "FICTIONAL-PAYMENT-APPROVAL", isolationEvidenceReference: "FICTIONAL-PAYMENT-ISOLATION",
  verifiedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(),
} };
let owner: Actor, peer: Actor, admin: Actor, companyId: string, vendorId: string, jobId: string, sequence = 884100;
type RemotePayment = { payment_id: string; vendor_id: string; reference_number: string; date: string; amount: string;
  payment_mode: string; paid_through_account_id: string; currency_code: string; balance: string;
  bills: { bill_id: string; amount_applied: string }[]; vendorpayment_refunds: unknown[] };
type FakeRemote = { id: string; invoice: string; billId: string; paid: Decimal; credits: Decimal; payments: RemotePayment[];
  posts: Record<string, unknown>[]; listOverride?: { payment_id: string; reference_number: string }[];
  loseResponse?: boolean; beforePost?: () => Promise<void>; onBillRead?: () => Promise<void>; updateDetails?: Record<string, unknown> };
const remotes = new Map<string, FakeRemote>();
let accountCurrency = "AED";

async function fakeRequest(input: string | URL, init?: RequestInit, permitPost = false) {
  const url = new URL(input), method = init?.method ?? "GET";
  expect(url.origin).toBe(settings.apiOrigin); expect(url.searchParams.get("organization_id")).toBe(organizationId);
  if (method === "GET" && url.pathname === `/books/v3/organizations/${organizationId}`) return Response.json({ code: 0,
    organization: { organization_id: organizationId, is_org_active: true, currency_code: "AED", currency_id: "88401" } });
  if (method === "GET" && url.pathname === `/books/v3/contacts/${VENDOR}`) return Response.json({ code: 0,
    contact: { contact_id: VENDOR, contact_name: `FICTIONAL payment vendor ${tag}`, contact_type: "vendor", status: "active",
      currency_code: "AED", tax_treatment: "vat_registered", tax_reg_no: "100000000000003" } });
  if (method === "GET" && url.pathname === "/books/v3/chartofaccounts") return Response.json({ code: 0,
    chartofaccounts: [{ account_id: ACCOUNT, account_name: "FICTIONAL cash account", account_type: "cash", is_active: true, currency_code: accountCurrency }],
    page_context: { page: Number(url.searchParams.get("page") ?? 1), has_more_page: false } });
  if (method === "GET" && url.pathname === `/books/v3/chartofaccounts/${ACCOUNT}`) return Response.json({ code: 0,
    chart_of_account: { account_id: ACCOUNT, account_name: "FICTIONAL cash account", account_type: "cash", is_active: true, currency_code: accountCurrency } });
  const externalId = /^\/books\/v3\/bills\/(\d+)$/.exec(url.pathname)?.[1];
  if (method === "GET" && externalId) {
    const remote = remotes.get(externalId); if (!remote) throw new Error("Unknown fictional payment bill.");
    await remote.onBillRead?.();
    return Response.json({ code: 0, bill: { bill_id: remote.id, vendor_id: VENDOR, bill_number: remote.invoice,
      reference_number: stableReference(remote.billId), currency_code: "AED", date: "2026-11-06", total: "105.00",
      status: remote.paid.eq(105) ? "paid" : "open",
      payment_made: remote.paid.toFixed(2), vendor_credits_applied: remote.credits.toFixed(2), balance: new Decimal(105).minus(remote.paid).minus(remote.credits).toFixed(2),
      ...remote.updateDetails } });
  }
  if (method === "GET" && url.pathname === "/books/v3/vendorpayments") {
    const remote = remotes.get(url.searchParams.get("bill_id") ?? ""); if (!remote) throw new Error("Only the exact fictional bill may be reconciled.");
    expect(url.searchParams.get("vendor_id")).toBe(VENDOR);
    const reference = url.searchParams.get("reference_number");
    return Response.json({ code: 0, vendorpayments: remote.listOverride ?? remote.payments.filter(row => row.reference_number === reference)
      .map(row => ({ payment_id: row.payment_id, reference_number: row.reference_number })),
    page_context: { page: Number(url.searchParams.get("page")), has_more_page: false } });
  }
  const paymentId = /^\/books\/v3\/vendorpayments\/(\d+)$/.exec(url.pathname)?.[1];
  if (method === "GET" && paymentId) {
    const payment = [...remotes.values()].flatMap(row => row.payments).find(row => row.payment_id === paymentId);
    if (!payment) throw new Error("Unknown fictional vendor payment."); return Response.json({ code: 0, vendorpayment: payment });
  }
  if (method === "POST" && url.pathname === "/books/v3/vendorpayments" && permitPost) {
    const body = JSON.parse(String(init?.body)), remote = remotes.get(body.bills?.[0]?.bill_id);
    if (!remote) throw new Error("POST must use the exact existing fictional bill.");
    expect(body.vendor_id).toBe(VENDOR); expect(body.paid_through_account_id).toBe(ACCOUNT); expect(body.bills).toHaveLength(1);
    await remote.beforePost?.(); remote.posts.push(body);
    const payment: RemotePayment = { payment_id: String(++sequence), vendor_id: body.vendor_id, reference_number: body.reference_number,
      date: body.date, amount: String(body.amount), payment_mode: body.payment_mode, paid_through_account_id: body.paid_through_account_id,
      currency_code: "AED", balance: "0.00", bills: [{ bill_id: remote.id, amount_applied: String(body.bills[0].amount_applied) }], vendorpayment_refunds: [] };
    remote.payments.push(payment); remote.paid = remote.paid.plus(body.amount);
    if (remote.loseResponse) { remote.loseResponse = false; throw new TypeError("FICTIONAL connection lost after accepted payment."); }
    return Response.json({ code: 0, payment_id: payment.payment_id });
  }
  throw new Error("Unapproved endpoint or mutation in fictional payment provider.");
}
const transportFactory: PaymentTransportFactory = (config, capability) => new ZohoTransport(config, async () => "fictional-payment-token",
  (input, init) => fakeRequest(input, init, true), undefined, undefined, undefined, capability);

beforeAll(async () => {
  assertMySqlTestDatabase();
  [owner, peer, admin] = await Promise.all((["ACCOUNTS", "ACCOUNTS", "ADMIN"] as const).map((role, index) => db.user.create({ data: {
    email: `payment-sync-${tag}-${index}@example.invalid`, name: `FICTIONAL payment actor ${index}`, role, passwordHash: "not-a-login" } })));
  companyId = (await db.company.create({ data: { name: `FICTIONAL payment company ${tag}`, isDemo: false, liveAccountingEnabled: true,
    memberships: { create: [owner, peer, admin].map(actor => ({ userId: actor.id })) } } })).id;
  await db.companyIntegrationDestination.create({ data: { companyId, target: "ZOHO", organizationId, dataCenter: "US", environment: "sandbox" } });
  await db.integrationCredential.create({ data: { target: "ZOHO", organizationId, dataCenter: "US",
    connectionFingerprint: oauth.connectionFingerprint(settings), refreshTokenEncrypted: "fictional-unused-encrypted-token" } });
  vendorId = (await db.vendor.create({ data: { companyId, name: `FICTIONAL payment vendor ${tag}`, currency: "AED" } })).id;
  await db.vendorBooksMapping.create({ data: { vendorId, organizationId, dataCenter: "US", environment: "sandbox", externalVendorId: VENDOR } });
  jobId = (await db.job.create({ data: { companyId, jobNumber: `PAY-${tag}`, name: "FICTIONAL payment job", customer: "FICTIONAL", currency: "AED" } })).id;
});
beforeEach(() => {
  accountCurrency = "AED";
  vi.stubEnv("MANUAL_ENTRY_ONLY", "false"); vi.stubEnv("ZOHO_BOOKS_ORGANIZATIONS_JSON", ""); vi.stubEnv("ZOHO_BOOKS_ORGANIZATION_ID", organizationId);
  vi.spyOn(configuration, "getConfig").mockImplementation((target, _env, org) => {
    if (target !== "ZOHO" || org && org !== organizationId) throw new Error("Unexpected fictional payment destination."); return settings;
  });
  vi.spyOn(oauth, "accessToken").mockResolvedValue("fictional-payment-token");
  vi.stubGlobal("fetch", vi.fn((input: string | URL, init?: RequestInit) => fakeRequest(input, init)));
});
afterEach(async () => {
  await db.paymentBooksSync.updateMany({ where: { companyId, status: { in: ["QUEUED", "PROCESSING", "UNKNOWN"] } },
    data: { status: "BLOCKED", leaseToken: null, leaseUntil: null } });
  await db.integrationCredential.update({ where: { target_organizationId: { target: "ZOHO", organizationId } }, data: { revokedAt: null } });
  await db.userCompanyMembership.updateMany({ where: { companyId, userId: owner.id }, data: { active: true } });
  await db.user.update({ where: { id: owner.id }, data: { role: "ACCOUNTS" } });
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});
afterAll(() => db.$disconnect());

async function fixture(withAttachment = false) {
  const externalId = String(++sequence), invoice = `FICTIONAL-PAYMENT-${randomUUID()}`;
  const bill = await db.bill.create({ data: { companyId, vendorId, jobId, invoiceNumber: invoice, normalizedInvoiceNumber: invoice,
    invoiceDate: new Date("2026-11-06T00:00:00Z"), dueDate: new Date("2026-11-20T00:00:00Z"), paymentTerms: "CUSTOM", category: "MATERIALS", currency: "AED",
    status: "READY", createdById: owner.id, subtotal: "100", discount: "0", vatRate: "5", vatAmount: "5", total: "105", paidAmount: "0",
    lines: { create: { description: "FICTIONAL saved payment source", quantity: "1", unitPrice: "100", lineTotal: "100" } },
    syncRecords: { create: { target: "ZOHO", status: "SYNCED", organizationId, externalId, attempts: 1, lastSyncedAt: new Date() } } } });
  if (withAttachment) {
    const bytes = Buffer.from("%PDF-1.4 FICTIONAL payment attachment fixture");
    await db.document.create({ data: { billId: bill.id, uploadedById: owner.id, fileName: "fictional-payment-source.pdf",
      storageKey: `${randomUUID()}.pdf`, mimeType: "application/pdf", byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } });
  }
  const snapshot = approvedSnapshot(await db.bill.findUniqueOrThrow({ where: { id: bill.id }, include: sourceInclude }), VENDOR);
  const canonical = await db.integrationJob.create({ data: { billId: bill.id, target: "ZOHO", operation: "CREATE_BILL", status: "SUCCEEDED",
    idempotencyKey: `ZOHO:${bill.id}:CREATE_BILL`, organizationId, sourceVersion: bill.version, initiatedById: owner.id,
    snapshot: snapshot as unknown as Prisma.InputJsonValue, payloadHash: snapshotHash(snapshot), externalId, attempts: 1, completedAt: new Date(),
    history: { create: { operation: "CREATE_BILL", outcome: "SUCCEEDED", externalId, startedAt: new Date() } } } });
  const remote: FakeRemote = { id: externalId, invoice, billId: bill.id, paid: new Decimal(0), credits: new Decimal(0), payments: [], posts: [] };
  remotes.set(externalId, remote); return { bill, canonical, remote };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function record(value: Fixture, amount = "25", actor = owner, reference = `FICTIONAL-RECEIPT-${randomUUID()}`) {
  const current = await db.bill.findUniqueOrThrow({ where: { id: value.bill.id } });
  await actOnBill(actor, current.id, { action: "payment", version: current.version, amount, reference,
    paymentDate: "2026-11-06", paymentMode: "Cash", paidThroughAccountId: ACCOUNT });
  return db.payment.findFirstOrThrow({ where: { billId: current.id, reference: reference.toUpperCase() }, include: { booksSync: true } });
}
async function preserved(id: string) {
  return JSON.stringify(await db.bill.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { id: "asc" } },
    payments: { orderBy: { id: "asc" } }, documents: { orderBy: { id: "asc" } } } }));
}
const syncPayment = (paymentId: string) => processPaymentBooksSyncs(1, { paymentId, transportFactory });
const state = (paymentId: string) => db.paymentBooksSync.findUniqueOrThrow({ where: { paymentId } });

describe("saved payment outbox with real disposable MySQL and a fake Books provider", () => {
  it("atomically queues complete metadata, posts once to the exact existing bill, confirms it and preserves all local financial rows", async () => {
    const value = await fixture(), other = await fixture(), payment = await record(value), unrelated = await record(other);
    expect(payment.booksSync).toMatchObject({ status: "QUEUED", initiatedById: owner.id, companyId, billId: value.bill.id, attempts: 0 });
    const snapshot = paymentSnapshotSchema.parse(payment.booksSync!.snapshot);
    expect(snapshot.payment).toMatchObject({ id: payment.id, amount: "25.00", paymentDate: "2026-11-06", paymentMode: "Cash", paidThroughAccountId: ACCOUNT });
    const repeated = await db.$transaction(tx => enqueuePaymentBooksSync(tx, payment.id));
    expect(repeated?.id).toBe(payment.booksSync!.id); expect(await db.paymentBooksSync.count({ where: { paymentId: payment.id } })).toBe(1);
    const before = await preserved(value.bill.id);
    expect(await syncPayment(payment.id)).toEqual({ processed: 1 });
    expect(await state(payment.id)).toMatchObject({ status: "SYNCED", externalBillId: value.remote.id, externalPaymentId: expect.any(String), attempts: 1, leaseToken: null, leaseUntil: null });
    expect(value.remote.posts).toHaveLength(1);
    expect(value.remote.posts[0]).toMatchObject({ vendor_id: VENDOR, amount: 25, payment_mode: "Cash", date: "2026-11-06", paid_through_account_id: ACCOUNT,
      reference_number: paymentReference(payment.id), bills: [{ bill_id: value.remote.id, amount_applied: 25 }] });
    expect(await preserved(value.bill.id)).toBe(before); expect(await state(unrelated.id)).toMatchObject({ status: "QUEUED", attempts: 0 });
    expect(await syncPayment(payment.id)).toEqual({ processed: 0 }); expect(value.remote.posts).toHaveLength(1);
    expect(await db.auditLog.count({ where: { entityType: "Payment", entityId: payment.id, action: "PAYMENT_BOOKS_CONFIRMED" } })).toBe(1);
  });

  it("never converts a legacy null-metadata payment into a provider intent", async () => {
    const value = await fixture();
    const payment = await db.payment.create({ data: { billId: value.bill.id, createdById: owner.id, amount: "20", reference: `FICTIONAL-LEGACY-${tag}` } });
    await db.bill.update({ where: { id: value.bill.id }, data: { paidAmount: "20", version: { increment: 1 } } });
    const before = await preserved(value.bill.id);
    expect(await db.$transaction(tx => enqueuePaymentBooksSync(tx, payment.id))).toBeNull();
    expect(await db.paymentBooksSync.count({ where: { paymentId: payment.id } })).toBe(0);
    expect(await syncPayment(payment.id)).toEqual({ processed: 0 }); expect(await preserved(value.bill.id)).toBe(before);
    expect(value.remote.posts).toHaveLength(0); expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects peer ownership, incomplete metadata and stale versions without creating payment/outbox rows", async () => {
    const value = await fixture();
    await expect(record(value, "25", peer)).rejects.toMatchObject({ status: 404 });
    await expect(actOnBill(owner, value.bill.id, { action: "payment", version: value.bill.version, amount: "25", reference: "FICTIONAL-MISSING-METADATA" })).rejects.toBeInstanceOf(ZodError);
    await expect(actOnBill(owner, value.bill.id, { action: "payment", version: value.bill.version + 1, amount: "25", reference: "FICTIONAL-STALE",
      paymentDate: "2026-11-06", paymentMode: "Cash", paidThroughAccountId: ACCOUNT })).rejects.toMatchObject({ status: 409 });
    expect(await db.payment.count({ where: { billId: value.bill.id } })).toBe(0);
    expect(await db.paymentBooksSync.count({ where: { billId: value.bill.id } })).toBe(0);
  });

  it("does not create local payment records for an excessive amount or wrong-currency account", async () => {
    const value = await fixture();
    await expect(record(value, "105.01")).rejects.toMatchObject({ status: 422 });
    accountCurrency = "EUR"; await expect(record(value)).rejects.toMatchObject({ status: 422 });
    expect(await db.payment.count({ where: { billId: value.bill.id } })).toBe(0);
    expect(await db.paymentBooksSync.count({ where: { billId: value.bill.id } })).toBe(0);
  });

  it("shares one durable claim between racing workers without a duplicate provider POST", async () => {
    const value = await fixture(), payment = await record(value);
    let release!: () => void, entered!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    value.remote.beforePost = async () => { entered(); await hold; };
    const first = syncPayment(payment.id);
    try {
      await Promise.race([started, first.then(() => { throw new Error("The payment ended before the fake POST barrier."); })]);
      expect(await syncPayment(payment.id)).toEqual({ processed: 0 });
    } finally { release(); }
    expect(await first).toEqual({ processed: 1 }); expect(value.remote.posts).toHaveLength(1);
    expect(await state(payment.id)).toMatchObject({ status: "SYNCED", attempts: 1 });
  });

  it("reconciles a lost successful POST response by GET only and never replays its creation", async () => {
    const value = await fixture(), payment = await record(value); value.remote.loseResponse = true;
    expect(await syncPayment(payment.id)).toEqual({ processed: 1 });
    expect(await state(payment.id)).toMatchObject({ status: "UNKNOWN", submittedAt: expect.any(Date), attempts: 1 });
    expect(value.remote.posts).toHaveLength(1); const before = await preserved(value.bill.id);
    await db.paymentBooksSync.update({ where: { paymentId: payment.id }, data: { nextAttemptAt: new Date(0) } });
    expect(await syncPayment(payment.id)).toEqual({ processed: 1 });
    expect(await state(payment.id)).toMatchObject({ status: "SYNCED", attempts: 2, externalPaymentId: value.remote.payments[0].payment_id });
    expect(value.remote.posts).toHaveLength(1); expect(await preserved(value.bill.id)).toBe(before);
  });

  it("keeps a submitted but absent outcome UNKNOWN and refuses a new payment POST", async () => {
    const value = await fixture(), payment = await record(value);
    await db.paymentBooksSync.update({ where: { paymentId: payment.id }, data: { status: "UNKNOWN", submittedAt: new Date(), externalBillId: value.remote.id, nextAttemptAt: new Date(0) } });
    expect(await syncPayment(payment.id)).toEqual({ processed: 1 });
    expect(await state(payment.id)).toMatchObject({ status: "UNKNOWN", errorCode: "PAYMENT_OUTCOME_UNKNOWN" });
    expect(value.remote.posts).toHaveLength(0);
  });

  it("refuses ambiguous provider references without submitting anything", async () => {
    const value = await fixture(), payment = await record(value);
    value.remote.listOverride = ["8849001", "8849002"].map(payment_id => ({ payment_id, reference_number: paymentReference(payment.id) }));
    expect(await syncPayment(payment.id)).toEqual({ processed: 1 });
    expect(await state(payment.id)).toMatchObject({ status: "UNKNOWN", errorCode: "PAYMENT_REFERENCE_DUPLICATE", submittedAt: null });
    expect(value.remote.posts).toHaveLength(0);
  });

  it("defers while a current bill mutation is active or not yet confirmed", async () => {
    const value = await fixture(), payment = await record(value);
    const pending = await db.integrationJob.create({ data: { billId: value.bill.id, target: "ZOHO", operation: "UPDATE_BILL", status: "PROCESSING",
      idempotencyKey: `ZOHO:${value.bill.id}:UPDATE_BILL:999`, organizationId, sourceVersion: 999, initiatedById: owner.id,
      snapshot: value.canonical.snapshot as Prisma.InputJsonValue, payloadHash: value.canonical.payloadHash, leaseToken: "f".repeat(64), leaseUntil: new Date(Date.now() + 60000) } });
    expect(await syncPayment(payment.id)).toEqual({ processed: 0 }); expect(await state(payment.id)).toMatchObject({ status: "QUEUED", attempts: 0 });
    await db.integrationJob.update({ where: { id: pending.id }, data: { status: "QUEUED", leaseToken: null, leaseUntil: null } });
    expect(await syncPayment(payment.id)).toEqual({ processed: 1 });
    expect(await state(payment.id)).toMatchObject({ status: "QUEUED", errorCode: "PAYMENT_BILL_PENDING", submittedAt: null });
    expect(value.remote.posts).toHaveLength(0);
  });

  it("confirms the exact payment despite an uncertain attachment while preserving its recovery state and originals", async () => {
    const value = await fixture(true), payment = await record(value);
    const source = snapshotSchema.parse(value.canonical.snapshot), document = source.documents[0];
    const attachment = await db.integrationJob.create({ data: { billId: value.bill.id, target: "ZOHO", operation: "ATTACH_DOCUMENT", status: "UNKNOWN",
      idempotencyKey: `ZOHO:${value.bill.id}:ATTACH_DOCUMENT:${document.id}`, documentId: document.id, organizationId,
      sourceVersion: value.canonical.sourceVersion, initiatedById: owner.id, snapshot: value.canonical.snapshot as Prisma.InputJsonValue,
      payloadHash: value.canonical.payloadHash, externalId: value.remote.id, attempts: 1, needsReconciliation: true, errorCode: "ATTACHMENT_UNCONFIRMED" } });
    const before = await preserved(value.bill.id);
    expect(await syncPayment(payment.id)).toEqual({ processed: 1 });
    expect(await state(payment.id)).toMatchObject({ status: "SYNCED", externalBillId: value.remote.id, attempts: 1, externalPaymentId: expect.any(String) });
    expect(value.remote.posts).toHaveLength(1);
    expect(await db.integrationJob.findUniqueOrThrow({ where: { id: attachment.id } })).toEqual(attachment);
    expect(await preserved(value.bill.id)).toBe(before);
    expect(await syncPayment(payment.id)).toEqual({ processed: 0 });
    expect(value.remote.posts).toHaveLength(1);
  });

  it("still defers an in-flight attachment to avoid concurrent provider writes", async () => {
    const value = await fixture(true), payment = await record(value), document = snapshotSchema.parse(value.canonical.snapshot).documents[0];
    const attachment = await db.integrationJob.create({ data: { billId: value.bill.id, target: "ZOHO", operation: "ATTACH_DOCUMENT", status: "PROCESSING",
      idempotencyKey: `ZOHO:${value.bill.id}:ATTACH_DOCUMENT:${document.id}`, documentId: document.id, organizationId,
      sourceVersion: value.canonical.sourceVersion, initiatedById: owner.id, snapshot: value.canonical.snapshot as Prisma.InputJsonValue,
      payloadHash: value.canonical.payloadHash, attempts: 1, leaseToken: "a".repeat(64), leaseUntil: new Date(Date.now() + 60000) } });
    expect(await syncPayment(payment.id)).toEqual({ processed: 0 });
    expect(await state(payment.id)).toMatchObject({ status: "QUEUED", attempts: 0, submittedAt: null });
    expect(value.remote.posts).toHaveLength(0);
    expect(await db.integrationJob.findUniqueOrThrow({ where: { id: attachment.id } })).toEqual(attachment);
  });

  it.each(["CREATE_BILL", "UPDATE_BILL", "CREATE_EXPENSE"] as const)("still blocks uncertain financial operation %s", async operation => {
    const value = await fixture(), payment = await record(value);
    const uncertain = await db.integrationJob.create({ data: { billId: value.bill.id, target: "ZOHO", operation, status: "UNKNOWN",
      idempotencyKey: `FICTIONAL:${value.bill.id}:${operation}:UNKNOWN`, organizationId, sourceVersion: value.canonical.sourceVersion,
      initiatedById: owner.id, snapshot: value.canonical.snapshot as Prisma.InputJsonValue, payloadHash: value.canonical.payloadHash,
      attempts: 1, needsReconciliation: true } });
    expect(await syncPayment(payment.id)).toEqual({ processed: 0 });
    expect(await state(payment.id)).toMatchObject({ status: "QUEUED", attempts: 0, submittedAt: null });
    expect(value.remote.posts).toHaveLength(0);
    expect(await db.integrationJob.findUniqueOrThrow({ where: { id: uncertain.id } })).toEqual(uncertain);
  });

  it.each(["payment", "bill", "membership", "grant"] as const)("blocks changed %s authority/source before any provider POST", async change => {
    const value = await fixture(), payment = await record(value);
    if (change === "payment") await db.payment.update({ where: { id: payment.id }, data: { reference: "FICTIONAL-CHANGED-REFERENCE" } });
    if (change === "bill") await db.bill.update({ where: { id: value.bill.id }, data: {
      invoiceNumber: value.bill.invoiceNumber + "-CHANGED", normalizedInvoiceNumber: value.bill.invoiceNumber + "-CHANGED" } });
    if (change === "membership") await db.userCompanyMembership.update({ where: { userId_companyId: { userId: owner.id, companyId } }, data: { active: false } });
    if (change === "grant") await db.integrationCredential.update({ where: { target_organizationId: { target: "ZOHO", organizationId } }, data: { revokedAt: new Date() } });
    expect(await syncPayment(payment.id)).toEqual({ processed: 1 });
    expect(await state(payment.id)).toMatchObject({ status: expect.stringMatching(/^(BLOCKED|FAILED)$/), submittedAt: null });
    expect(value.remote.posts).toHaveLength(0);
  });

  it("a selected run does not recover or mutate another payment's expired lease", async () => {
    const selected = await fixture(), other = await fixture(), payment = await record(selected), unrelated = await record(other);
    await db.paymentBooksSync.update({ where: { paymentId: unrelated.id }, data: { status: "PROCESSING", submittedAt: new Date(), leaseToken: "e".repeat(64), leaseUntil: new Date(0) } });
    const before = await state(unrelated.id);
    expect(await syncPayment(payment.id)).toEqual({ processed: 1 });
    expect(await state(unrelated.id)).toEqual(before); expect(other.remote.posts).toHaveLength(0);
  });

  it("a lease replaced during the final provider-read guard cannot submit or overwrite the new holder", async () => {
    const value = await fixture(), payment = await record(value); let replaced = false;
    value.remote.onBillRead = async () => {
      const current = await state(payment.id);
      if (current.submittedAt && !replaced) {
        replaced = true;
        await db.paymentBooksSync.update({ where: { paymentId: payment.id }, data: { leaseToken: "d".repeat(64), leaseUntil: new Date(Date.now() + 60000) } });
      }
    };
    expect(await syncPayment(payment.id)).toEqual({ processed: 1 }); expect(replaced).toBe(true);
    expect(value.remote.posts).toHaveLength(0);
    expect(await state(payment.id)).toMatchObject({ status: "PROCESSING", leaseToken: "d".repeat(64), externalPaymentId: null });
  });

  it.each(["PROCESSING", "UNKNOWN"] as const)("preserves the saved bill and payment while a Books payment is %s", async status => {
    const value = await fixture();
    const canonical = { ...snapshotSchema.parse(value.canonical.snapshot), initiatedById: owner.id,
      destination: { dataCenter: "US", environment: "sandbox" as const, mappingHash: booksMappingFingerprint(settings) } };
    await db.integrationJob.update({ where: { id: value.canonical.id }, data: {
      snapshot: canonical as unknown as Prisma.InputJsonValue, payloadHash: snapshotHash(canonical) } });
    const payload = buildBooksPayload(canonical, settings);
    value.remote.updateDetails = { due_date: "2026-11-20", payment_terms: 14, notes: payload.notes, tax_total: "5.00",
      last_modified_time: "2026-11-06T10:00:00Z", documents: [], is_locked: false,
      line_items: payload.line_items.map((line, index) => ({ ...line, line_item_id: String(884700 + index), is_billable: false })) };
    const payment = await record(value); value.remote.paid = new Decimal(25);
    await db.paymentBooksSync.update({ where: { paymentId: payment.id }, data: { status, submittedAt: new Date(),
      ...(status === "PROCESSING" ? { leaseToken: "a".repeat(64), leaseUntil: new Date(Date.now() + 60000) } : {}) } });
    const before = await preserved(value.bill.id), current = await db.bill.findUniqueOrThrow({ where: { id: value.bill.id } });
    await expect(updateBill(owner, current.id, { companyId, vendorId, jobId, invoiceNumber: current.invoiceNumber,
      invoiceDate: "2026-11-06", dueDate: "2026-11-20", paymentTerms: "CUSTOM", category: "MATERIALS", currency: "AED",
      discount: "0", vatRate: "5", lines: [{ description: "FICTIONAL edit while payment is unconfirmed", quantity: "1", unitPrice: "100" }],
      version: current.version })).rejects.toMatchObject({ status: 409, code: "PAYMENT_SYNC_ACTIVE" });
    expect(await preserved(value.bill.id)).toBe(before); expect(value.remote.posts).toHaveLength(0);
    expect(await state(payment.id)).toMatchObject({ status });
  });
});
