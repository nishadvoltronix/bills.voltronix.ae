import { randomUUID } from "node:crypto";
// Payment-account catalog is an isolated provider fixture; ownership and transactions remain real.
vi.mock("@/lib/services/payment-books-sync", async (original) => ({
  ...await original<typeof import("@/lib/services/payment-books-sync")>(),
  getPaymentAccounts: async (_actor: unknown, companyId: string) => ({ companyId,
    accounts: [{ id: "9000001", name: "Fictional cash", type: "cash", currency: "AED" }], warning: null }),
}));
import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import * as configuration from "@/lib/integrations/config";
import { connectionFingerprint } from "@/lib/integrations/oauth";
import { buildBooksPayload, snapshotSchema, type SupplierBillAdapter } from "@/lib/integrations/books";
import { correctionStateHash, isSupersededIntegrationJob } from "@/lib/integrations/source-supersession";
import { queueBill, processIntegrationJobs, scheduleIntegrationJob } from "@/lib/integrations/queue";
import { ZohoTransport } from "@/lib/integrations/transport";
import { prepareBillSourceCorrection, applyBillSourceCorrection, type BillSourceCorrectionInput } from "@/lib/services/bill-source-correction";
import { attachDocument } from "@/lib/services/documents";
import { actOnBill } from "@/lib/services/bills";
import { assertMySqlTestDatabase } from "./company-fixtures";

const tag = randomUUID().slice(0, 8), organizationId = `8850${Date.now()}`;
const originalGetConfig = configuration.getConfig;
// Pure configuration input only. It is never assigned to the test DB client/environment.
const settings = originalGetConfig("ZOHO", {
  NODE_ENV: "production", APP_ENV: "production", APP_URL: "https://billing.example.invalid",
  DATABASE_URL: "mysql://fixture:fictional@database.example.invalid/billing_operational",
  INTEGRATION_NETWORK_ENABLED: "true", INTEGRATION_TEST_MODE: "false", ZOHO_BOOKS_LIVE_ENABLED: "true",
  ZOHO_BOOKS_WRITE_ENABLED: "true", ALLOW_PRODUCTION_ACCOUNTING_WRITES: "false", ZOHO_BOOKS_DC: "US",
  ZOHO_BOOKS_ENVIRONMENT: "production", ZOHO_BOOKS_ORGANIZATION_ID: organizationId,
  ZOHO_BOOKS_CLIENT_ID: "fictional-client", ZOHO_BOOKS_CLIENT_SECRET: "fictional-secret",
  ZOHO_BOOKS_MAPPING_JSON: JSON.stringify({ verified: true, baseCurrency: "AED", currencies: { AED: { id: "88501" } },
    taxes: { "5.00": { id: "88502", percentage: "5" }, "0.00": { id: "88506", percentage: "0" } }, categories: { MATERIALS: { accountId: "88503" } } }),
});
let admin: Actor, accounts: Actor, staff: Actor;
let companyId: string, vendorId: string, replacementId: string, jobId: string;
beforeAll(async () => {
  assertMySqlTestDatabase();
  [admin, accounts, staff] = await Promise.all((["ADMIN", "ACCOUNTS", "DATA_ENTRY"] as const).map(role => db.user.create({ data: {
    email: `source-correction-${tag}-${role}@example.invalid`, name: `FICTIONAL correction ${role}`, role, passwordHash: "not-a-login",
  } })));
  companyId = (await db.company.create({ data: { name: `FICTIONAL correction ${tag}`, isDemo: false, liveAccountingEnabled: true,
    memberships: { create: [admin, accounts, staff].map(actor => ({ userId: actor.id })) } } })).id;
  await db.companyIntegrationDestination.create({ data: { companyId, target: "ZOHO", organizationId, dataCenter: "US", environment: "production",
    liveEnabled: true, verifiedAt: new Date(), verificationReference: "FICTIONAL-SOURCE-CORRECTION",
    verifiedConfigurationHash: configuration.booksConfigurationHash(settings) } });
  await db.integrationCredential.create({ data: { target: "ZOHO", organizationId, dataCenter: "US",
    connectionFingerprint: connectionFingerprint(settings), refreshTokenEncrypted: "fictional-unused-encrypted-value" } });
  vendorId = (await db.vendor.create({ data: { companyId, name: "FICTIONAL original supplier", currency: "AED" } })).id;
  replacementId = (await db.vendor.create({ data: { companyId, name: "FICTIONAL correct legal supplier", currency: "AED", trn: "100000000000002" } })).id;
  for (const [local, remote] of [[vendorId, "88504"], [replacementId, "88505"]])
    await db.vendorBooksMapping.create({ data: { vendorId: local, organizationId, dataCenter: "US", environment: "production", externalVendorId: remote } });
  jobId = (await db.job.create({ data: { companyId, jobNumber: `FICTIONAL-CORRECTION-${tag}`, name: "FICTIONAL source job", customer: "FICTIONAL", currency: "AED" } })).id;
});
beforeEach(() => {
  vi.stubEnv("ZOHO_BOOKS_ORGANIZATIONS_JSON", ""); vi.stubEnv("ZOHO_BOOKS_ORGANIZATION_ID", organizationId);
  vi.stubEnv("MANUAL_ENTRY_ONLY", "false");
  vi.spyOn(configuration, "getConfig").mockImplementation((target, _env, organization) => {
    if (target !== "ZOHO" || (organization && organization !== organizationId)) throw new Error("Unexpected fictional organization.");
    return settings;
  });
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Provider network is disabled in these disposable database tests.")));
});
afterEach(async () => {
  // The general worker regressions share this disposable schema. Do not leave
  // our deliberately unprocessed race result for another suite's fake provider.
  if (companyId) await db.integrationJob.updateMany({ where: { bill: { companyId }, status: { in: ["QUEUED", "RETRY"] } }, data: { status: "CANCELLED" } });
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});
afterAll(() => db.$disconnect());

async function rejectedBill(zero = false, paid?: string) {
  const invoice = `FICTIONAL-AMEND-${randomUUID()}`;
  const total = zero ? "100.00" : "105.00";
  const selection = zero ? { organizationId, dataCenter: "US", environment: "production", accountId: "88503", accountName: "Materials",
    taxId: "88506", taxName: "Zero Rate", taxRate: "0.00", customerId: null, customerName: null } : undefined;
  const initial = await db.bill.create({ data: { companyId, vendorId, jobId, invoiceNumber: invoice, normalizedInvoiceNumber: invoice,
    invoiceDate: new Date("2026-11-04"), category: "MATERIALS", currency: "AED", status: "DRAFT", createdById: staff.id,
    subtotal: "100", discount: "0", vatRate: zero ? "0" : "5", vatAmount: zero ? "0" : "5", total,
    usesBooksLineTaxes: zero, lines: { create: { description: "FICTIONAL original material", quantity: "1", unitPrice: "100", lineTotal: "100",
      ...(selection ? { booksSelection: selection } : {}) } },
    syncRecords: { create: [{ target: "ZOHO", status: "NOT_CONFIGURED" }, { target: "CRM", status: "NOT_CONFIGURED" }] } } });
  await attachDocument(staff, initial.id, new File([new TextEncoder().encode(`%PDF-1.4\nFICTIONAL exact original ${invoice}\n%%EOF`)], "fictional-original.pdf", { type: "application/pdf" }));
  const bill = await db.bill.update({ where: { id: initial.id }, data: { status: "READY", paidAmount: paid ?? total,
    version: { increment: 1 }, payments: { create: { amount: paid ?? total, reference: `FICTIONAL-PAID-${invoice}`, createdById: accounts.id,
      createdAt: new Date("2026-11-04T00:00:00Z") } } }, include: { documents: true } });
  const operation = await queueBill(staff, bill.id, "ZOHO", organizationId);
  await db.integrationJob.update({ where: { id: operation.id }, data: { status: "FAILED", attempts: 1, errorCode: "REMOTE_REJECTED", lastError: "Fictional definite rejection." } });
  await db.integrationAttempt.create({ data: { jobId: operation.id, operation: "CREATE_BILL", outcome: "FAILED", errorCode: "REMOTE_REJECTED", safeError: "Fictional definite rejection.", startedAt: new Date() } });
  await db.syncRecord.update({ where: { billId_target: { billId: bill.id, target: "ZOHO" } }, data: { status: "FAILED", attempts: 1, lastError: "Fictional definite rejection." } });
  const input: BillSourceCorrectionInput = { billId: bill.id, expectedVersion: bill.version, organizationId,
    reason: zero ? "Original receipt contains no VAT; explicit zero-rate selection was entered incorrectly." : "Original invoice belongs to the separately verified legal supplier with the reviewed registration.",
    reference: `FICTIONAL-REVIEW-${invoice}`, evidence: bill.documents.map(document => ({ documentId: document.id, sha256: document.sha256 })),
    change: zero ? { kind: "no_vat" } : { kind: "vendor", vendorId: replacementId, externalVendorId: "88505",
      expectedVendorName: "FICTIONAL correct legal supplier", expectedVendorTrn: "100000000000002" } };
  return { bill, operation, input };
}
function reader(options: { duplicate?: boolean; incomplete?: boolean } = {}) {
  const requests: string[] = [];
  const fetcher = vi.fn(async (url: string | URL, init?: RequestInit) => {
    expect(init?.method).toBe("GET");
    const endpoint = new URL(url); requests.push(endpoint.pathname);
    if (endpoint.pathname.startsWith("/books/v3/contacts/")) {
      const correct = endpoint.pathname.endsWith("/88505");
      return Response.json({ code: 0, contact: { contact_id: correct ? "88505" : "88504",
        contact_name: correct ? "FICTIONAL correct legal supplier" : "FICTIONAL original supplier", contact_type: "vendor", status: "active",
        currency_code: "AED", tax_treatment: "vat_registered", tax_reg_no: correct ? "100000000000002" : "100000000000001" } });
    }
    if (endpoint.pathname === "/books/v3/chartofaccounts/88503") return Response.json({ code: 0, chart_of_account: { account_id: "88503", is_active: true, account_type: "expense" } });
    if (endpoint.pathname === "/books/v3/bills") return Response.json({ code: 0, bills: options.duplicate ? [{ bill_id: "99001",
      bill_number: endpoint.searchParams.get("search_text") ?? "", reference_number: "", vendor_id: "88505" }] : [],
      page_context: { page: Number(endpoint.searchParams.get("page")), has_more_page: options.incomplete ?? false } });
    throw new Error("Unexpected fictional GET endpoint.");
  });
  return { transport: new ZohoTransport(settings, async () => "fictional-read-token", fetcher), requests, fetcher };
}
async function financialState(billId: string) {
  const bill = await db.bill.findUniqueOrThrow({ where: { id: billId }, include: { payments: { orderBy: { id: "asc" } }, documents: { orderBy: { id: "asc" } } } });
  return correctionStateHash({ subtotal: bill.subtotal, discount: bill.discount, vatRate: bill.vatRate, vatAmount: bill.vatAmount, total: bill.total,
    paidAmount: bill.paidAmount, createdById: bill.createdById, companyId: bill.companyId, jobId: bill.jobId, payments: bill.payments, documents: bill.documents });
}

describe("audited rejected finalized bill source corrections in disposable MySQL only", () => {
  it.each([false, true])("corrects vendor or explicit No VAT with preserved paid ledger and immutable original history (zero=%s)", async zero => {
    const fixture = await rejectedBill(zero), before = await financialState(fixture.bill.id);
    const original = await db.integrationJob.findUniqueOrThrow({ where: { id: fixture.operation.id }, include: { history: true } });
    const remote = reader();
    const prepared = await prepareBillSourceCorrection(admin, fixture.input, remote.transport);
    const result = await applyBillSourceCorrection(admin, prepared.proof);
    expect(result.replacementJobId).not.toBe(original.id); expect(await financialState(fixture.bill.id)).toBe(before);
    const archived = await db.integrationJob.findUniqueOrThrow({ where: { id: original.id }, include: { history: true } });
    expect(isSupersededIntegrationJob(archived)).toBe(true); expect(archived.status).toBe("CANCELLED");
    expect(archived.snapshot).toEqual(original.snapshot); expect(archived.payloadHash).toBe(original.payloadHash);
    expect(archived.sourceVersion).toBe(original.sourceVersion); expect(archived.history).toEqual(original.history);
    const replacement = await db.integrationJob.findUniqueOrThrow({ where: { id: result.replacementJobId } });
    const exported = buildBooksPayload(snapshotSchema.parse(replacement.snapshot), settings);
    if (zero) expect(exported.line_items[0]).not.toHaveProperty("tax_id"); else expect(exported.vendor_id).toBe("88505");
    expect(replacement.sourceVersion).toBe(fixture.bill.version + 1); expect(exported.reference_number).toBe(`VX-BILL-${fixture.bill.id}`);
    expect((await db.syncRecord.findUniqueOrThrow({ where: { billId_target: { billId: fixture.bill.id, target: "ZOHO" } } })).attempts).toBe(1);
    await expect(applyBillSourceCorrection(admin, prepared.proof)).rejects.toMatchObject({ code: "SOURCE_CORRECTION_UNSAFE" });
    const syncBefore = await db.syncRecord.findUniqueOrThrow({ where: { billId_target: { billId: fixture.bill.id, target: "ZOHO" } } });
    for (const action of ["retry", "reconcile"])
      await expect(scheduleIntegrationJob(admin, original.id, { action })).rejects.toMatchObject({ status: 409 });
    expect(await processIntegrationJobs({ jobId: original.id })).toEqual({ processed: 0 });
    expect(await db.syncRecord.findUnique({ where: { id: syncBefore.id } })).toEqual(syncBefore);
    const create = vi.fn(async () => ({ externalId: `99${Date.now()}`, confirmedAt: new Date() }));
    const attachment = vi.fn(async (externalId: string) => ({ externalId, confirmedAt: new Date() }));
    const adapter: SupplierBillAdapter = { create, reconcile: vi.fn(), attach: attachment, reconcileAttachment: vi.fn() };
    await processIntegrationJobs({ jobId: replacement.id, adapterFactory: () => adapter });
    const child = await db.integrationJob.findFirstOrThrow({ where: { billId: fixture.bill.id, operation: "ATTACH_DOCUMENT" } });
    await processIntegrationJobs({ jobId: child.id, adapterFactory: () => adapter });
    expect(create).toHaveBeenCalledTimes(1); expect(attachment).toHaveBeenCalledTimes(1);
    expect(await db.syncRecord.findUnique({ where: { id: syncBefore.id } })).toMatchObject({ status: "SYNCED", attempts: 3 });
    expect(await financialState(fixture.bill.id)).toBe(before);
  });
  it("requires a current Admin and rejects copied/forged or expired preparation proofs", async () => {
    const fixture = await rejectedBill();
    await expect(prepareBillSourceCorrection(accounts, fixture.input, reader().transport)).rejects.toMatchObject({ status: 403 });
    const prepared = await prepareBillSourceCorrection(admin, fixture.input, reader().transport);
    await expect(applyBillSourceCorrection(admin, { ...prepared.proof })).rejects.toMatchObject({ code: "SOURCE_CORRECTION_UNSAFE" });
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 61_000);
    await expect(applyBillSourceCorrection(admin, prepared.proof)).rejects.toMatchObject({ code: "SOURCE_CORRECTION_UNSAFE" });
    vi.useRealTimers();
  });
  it.each(["duplicate", "incomplete"] as const)("requires complete provider absence (%s)", async kind => {
    const fixture = await rejectedBill();
    await expect(prepareBillSourceCorrection(admin, fixture.input, reader({ [kind]: true }).transport)).rejects.toMatchObject({ code: "SOURCE_CORRECTION_UNSAFE" });
    expect(await db.integrationJob.findUnique({ where: { id: fixture.operation.id } })).toMatchObject({ status: "FAILED", idempotencyKey: `ZOHO:${fixture.bill.id}:CREATE_BILL` });
  });
  it("rejects uncertainty and incomplete original attempt history even if current error says rejected", async () => {
    const fixture = await rejectedBill();
    await db.integrationJob.update({ where: { id: fixture.operation.id }, data: { attempts: 2 } });
    await expect(prepareBillSourceCorrection(admin, fixture.input, reader().transport)).rejects.toMatchObject({ code: "SOURCE_CORRECTION_UNSAFE" });
    await db.integrationAttempt.create({ data: { jobId: fixture.operation.id, operation: "CREATE_BILL", outcome: "UNKNOWN", errorCode: "REQUEST_INTERRUPTED", startedAt: new Date() } });
    await expect(prepareBillSourceCorrection(admin, fixture.input, reader().transport)).rejects.toMatchObject({ code: "SOURCE_CORRECTION_UNSAFE" });
  });
  it("rolls back the archive, correction, queue and audit when final enqueue is unavailable", async () => {
    const fixture = await rejectedBill(true), before = await financialState(fixture.bill.id);
    const prepared = await prepareBillSourceCorrection(admin, fixture.input, reader().transport);
    vi.stubEnv("MANUAL_ENTRY_ONLY", "true");
    await expect(applyBillSourceCorrection(admin, prepared.proof)).rejects.toMatchObject({ code: "SOURCE_CORRECTION_UNSAFE" });
    expect(await db.integrationJob.findUnique({ where: { id: fixture.operation.id } })).toMatchObject({ status: "FAILED", idempotencyKey: `ZOHO:${fixture.bill.id}:CREATE_BILL` });
    expect(await db.integrationJob.count({ where: { billId: fixture.bill.id } })).toBe(1);
    expect(await db.auditLog.count({ where: { entityId: fixture.bill.id, action: { startsWith: "BILL_SOURCE_CORRECTION" } } })).toBe(0);
    expect(await financialState(fixture.bill.id)).toBe(before);
  });
  it("rejects stale proof after a legitimate local payment and preserves the payment", async () => {
    const fixture = await rejectedBill(false, "20.00");
    const prepared = await prepareBillSourceCorrection(admin, fixture.input, reader().transport);
    await actOnBill(admin, fixture.bill.id, { action: "payment", paymentDate: "2026-11-06", paymentMode: "Cash", paidThroughAccountId: "9000001", version: fixture.bill.version, amount: "10", reference: `FICTIONAL-LATER-${tag}` });
    await expect(applyBillSourceCorrection(admin, prepared.proof)).rejects.toMatchObject({ status: 409 });
    expect((await db.bill.findUniqueOrThrow({ where: { id: fixture.bill.id } })).paidAmount.toFixed(2)).toBe("30.00");
    expect(await db.payment.count({ where: { billId: fixture.bill.id } })).toBe(2);
  });
  it("rejects a current Admin whose company access was revoked after preparation", async () => {
    const fixture = await rejectedBill();
    const prepared = await prepareBillSourceCorrection(admin, fixture.input, reader().transport);
    await db.userCompanyMembership.update({ where: { userId_companyId: { userId: admin.id, companyId } }, data: { active: false } });
    try {
      await expect(applyBillSourceCorrection(admin, prepared.proof)).rejects.toMatchObject({ status: 403 });
      expect(await db.integrationJob.findUnique({ where: { id: fixture.operation.id } })).toMatchObject({ status: "FAILED", idempotencyKey: `ZOHO:${fixture.bill.id}:CREATE_BILL` });
    } finally { await db.userCompanyMembership.update({ where: { userId_companyId: { userId: admin.id, companyId } }, data: { active: true } }); }
  });
  it("rejects changed original document metadata even when the bill version did not change", async () => {
    const fixture = await rejectedBill();
    const prepared = await prepareBillSourceCorrection(admin, fixture.input, reader().transport);
    await db.document.update({ where: { id: fixture.bill.documents[0].id }, data: { fileName: "different-original-name.pdf" } });
    await expect(applyBillSourceCorrection(admin, prepared.proof)).rejects.toMatchObject({ code: "SOURCE_CORRECTION_UNSAFE" });
    expect(await db.integrationJob.count({ where: { billId: fixture.bill.id } })).toBe(1);
  });
  it("rejects an existing native invoice under the corrected supplier before provider inspection", async () => {
    const fixture = await rejectedBill();
    await db.bill.create({ data: { companyId, vendorId: replacementId, jobId, invoiceNumber: fixture.bill.invoiceNumber,
      normalizedInvoiceNumber: fixture.bill.normalizedInvoiceNumber, invoiceDate: fixture.bill.invoiceDate,
      category: "MATERIALS", currency: "AED", createdById: staff.id, status: "DRAFT", subtotal: "100", vatAmount: "0", total: "100",
      lines: { create: { description: "FICTIONAL existing invoice", quantity: "1", unitPrice: "100", lineTotal: "100" } } } });
    const remote = reader();
    await expect(prepareBillSourceCorrection(admin, fixture.input, remote.transport)).rejects.toMatchObject({ code: "SOURCE_CORRECTION_UNSAFE" });
    expect(remote.requests).toHaveLength(0);
  });
  it("refuses synthetic provider proof in the production application environment", async () => {
    const fixture = await rejectedBill();
    vi.stubEnv("APP_ENV", "production");
    await expect(prepareBillSourceCorrection(admin, fixture.input, reader().transport)).rejects.toMatchObject({ code: "SOURCE_CORRECTION_UNSAFE" });
  });
  it("refuses amendment while the original worker has an in-flight provider operation", async () => {
    const fixture = await rejectedBill();
    const prepared = await prepareBillSourceCorrection(admin, fixture.input, reader().transport);
    await scheduleIntegrationJob(admin, fixture.operation.id, { action: "retry" });
    let entered!: () => void, finish!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { finish = resolve; });
    const adapter: SupplierBillAdapter = { create: async () => { entered(); await held; return { externalId: `992${Date.now()}`, confirmedAt: new Date() }; },
      reconcile: vi.fn(), attach: vi.fn(), reconcileAttachment: vi.fn() };
    const worker = processIntegrationJobs({ jobId: fixture.operation.id, adapterFactory: () => adapter });
    await Promise.race([started, worker.then(() => { throw new Error("The fictional worker finished before entering the held provider operation."); })]);
    try {
      await expect(applyBillSourceCorrection(admin, prepared.proof)).rejects.toMatchObject({ code: "SOURCE_CORRECTION_UNSAFE" });
      expect(await db.integrationJob.findUnique({ where: { id: fixture.operation.id } })).toMatchObject({ status: "PROCESSING", idempotencyKey: `ZOHO:${fixture.bill.id}:CREATE_BILL` });
    } finally { finish(); await worker; }
  });
  it("serializes a competing retry and source correction so only one can succeed", async () => {
    const fixture = await rejectedBill();
    const prepared = await prepareBillSourceCorrection(admin, fixture.input, reader().transport);
    const results = await Promise.allSettled([applyBillSourceCorrection(admin, prepared.proof), scheduleIntegrationJob(admin, fixture.operation.id, { action: "retry" })]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const original = await db.integrationJob.findUniqueOrThrow({ where: { id: fixture.operation.id } });
    const jobs = await db.integrationJob.findMany({ where: { billId: fixture.bill.id } });
    if (isSupersededIntegrationJob(original)) expect(jobs.filter(job => job.idempotencyKey === `ZOHO:${fixture.bill.id}:CREATE_BILL`)).toHaveLength(1);
    else { expect(original.status).toBe("QUEUED"); expect(jobs).toHaveLength(1); }
  });
});
