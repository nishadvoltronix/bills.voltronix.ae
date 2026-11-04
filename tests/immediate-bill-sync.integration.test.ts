import { randomUUID } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { buildBooksPayload, snapshotSchema, type SupplierBillAdapter } from "@/lib/integrations/books";
import * as configuration from "@/lib/integrations/config";
import * as oauth from "@/lib/integrations/oauth";
import * as queue from "@/lib/integrations/queue";
import { runImmediateBillSync } from "@/lib/integrations/immediate-bill-sync";
import { correctionStateHash } from "@/lib/integrations/source-supersession";
import { updateBill } from "@/lib/services/bills";
import { attachDocument } from "@/lib/services/documents";
import { assertMySqlTestDatabase } from "./company-fixtures";

const tag = randomUUID().slice(0, 8), organizationId = `8860${Date.now()}`;
const actualProcess = queue.processIntegrationJobs;
const baseConfig = configuration.getConfig("ZOHO", {
  NODE_ENV: "test", APP_ENV: "test", INTEGRATION_NETWORK_ENABLED: "true", INTEGRATION_TEST_MODE: "true",
  ZOHO_BOOKS_WRITE_ENABLED: "true", ZOHO_BOOKS_DC: "US", ZOHO_BOOKS_ENVIRONMENT: "sandbox",
  ZOHO_BOOKS_ORGANIZATION_ID: organizationId, ZOHO_BOOKS_CLIENT_ID: "fictional-immediate-client",
  ZOHO_BOOKS_CLIENT_SECRET: "fictional-immediate-secret",
  ZOHO_BOOKS_MAPPING_JSON: JSON.stringify({ verified: true, baseCurrency: "AED", currencies: { AED: { id: "88601" } },
    taxes: { "5.00": { id: "88602", percentage: "5" } }, categories: { MATERIALS: { accountId: "88603" } } }),
});
const settings = { ...baseConfig, writeEnabled: true, testAuthorization: { mode: "nonproduction" as const, organizationId, dataCenter: "US" as const,
  configurationHash: configuration.booksTestConfigurationHash(baseConfig), approvedBy: "fictional-immediate-operator",
  approvalReference: "FICTIONAL-IMMEDIATE-APPROVAL", isolationEvidenceReference: "FICTIONAL-IMMEDIATE-ISOLATION",
  verifiedAt: new Date(Date.now() - 1_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() } };
let owner: Actor, peer: Actor, companyId: string, vendorId: string, jobId: string, externalSequence = 886900;

beforeAll(async () => {
  assertMySqlTestDatabase();
  [owner, peer] = await Promise.all(["owner", "peer"].map(label => db.user.create({ data: {
    email: `immediate-${tag}-${label}@example.invalid`, name: `FICTIONAL immediate ${label}`, role: "ACCOUNTS", passwordHash: "not-a-login" } })));
  companyId = (await db.company.create({ data: { name: `FICTIONAL immediate ${tag}`, isDemo: false, liveAccountingEnabled: false,
    memberships: { create: [owner, peer].map(actor => ({ userId: actor.id })) } } })).id;
  await db.companyIntegrationDestination.create({ data: { companyId, target: "ZOHO", organizationId, dataCenter: "US", environment: "sandbox" } });
  await db.integrationCredential.create({ data: { target: "ZOHO", organizationId, dataCenter: "US",
    connectionFingerprint: oauth.connectionFingerprint(settings), refreshTokenEncrypted: "fictional-unused-encrypted-value" } });
  vendorId = (await db.vendor.create({ data: { companyId, name: `FICTIONAL immediate vendor ${tag}`, currency: "AED" } })).id;
  await db.vendorBooksMapping.create({ data: { vendorId, organizationId, dataCenter: "US", environment: "sandbox", externalVendorId: "88604" } });
  jobId = (await db.job.create({ data: { companyId, jobNumber: `FICTIONAL-IMMEDIATE-${tag}`, name: "FICTIONAL immediate job", customer: "FICTIONAL", currency: "AED" } })).id;
});
beforeEach(() => {
  vi.stubEnv("ZOHO_BOOKS_ORGANIZATIONS_JSON", ""); vi.stubEnv("ZOHO_BOOKS_ORGANIZATION_ID", organizationId); vi.stubEnv("MANUAL_ENTRY_ONLY", "false");
  vi.spyOn(configuration, "getConfig").mockImplementation((target, _environment, organization) => {
    if (target !== "ZOHO" || organization && organization !== organizationId) throw new Error("Unexpected fictional immediate destination.");
    return settings;
  });
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("No network is permitted in isolated immediate-sync tests.")));
});
afterEach(async () => {
  // Keep this file's fixtures out of unrelated ordinary-worker tests in the same disposable schema.
  if (companyId) await db.integrationJob.updateMany({ where: { bill: { companyId }, status: { in: ["QUEUED", "RETRY"] } }, data: { status: "CANCELLED" } });
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});
afterAll(() => db.$disconnect());

async function fixture(document = false) {
  const invoiceNumber = `FICTIONAL-IMMEDIATE-${randomUUID()}`;
  let bill = await db.bill.create({ data: { companyId, vendorId, jobId, invoiceNumber, normalizedInvoiceNumber: invoiceNumber,
    invoiceDate: new Date("2026-11-04"), dueDate: new Date("2026-11-20"), paymentTerms: "CUSTOM", category: "MATERIALS", currency: "AED",
    createdById: owner.id, status: "DRAFT", subtotal: "100", discount: "0", vatRate: "5", vatAmount: "5", total: "105",
    lines: { create: { description: "FICTIONAL immediate material", quantity: "1", unitPrice: "100", lineTotal: "100" } },
    syncRecords: { create: [{ target: "ZOHO", status: "NOT_CONFIGURED" }, { target: "CRM", status: "NOT_CONFIGURED" }] } } });
  if (document) {
    const pdf = await PDFDocument.create(); pdf.setTitle("FICTIONAL immediate-sync original"); pdf.addPage([120, 80]);
    await attachDocument(owner, bill.id, new File([new Uint8Array(await pdf.save())], "fictional-immediate-original.pdf", { type: "application/pdf" }));
  }
  bill = await db.bill.update({ where: { id: bill.id }, data: { status: "READY", version: { increment: 1 } } });
  const operation = await queue.queueBill(owner, bill.id, "ZOHO", organizationId);
  return { bill, operation, externalId: String(++externalSequence) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function saved(id: string) {
  return db.bill.findUniqueOrThrow({ where: { id }, select: { id: true, companyId: true, version: true, status: true,
    syncRecords: { select: { target: true, status: true, organizationId: true } } } });
}
async function preservedState(id: string) {
  const bill = await db.bill.findUniqueOrThrow({ where: { id }, include: { payments: true, documents: true } });
  return correctionStateHash({ companyId: bill.companyId, jobId: bill.jobId, createdById: bill.createdById, version: bill.version,
    currency: bill.currency, total: bill.total, vatAmount: bill.vatAmount, paidAmount: bill.paidAmount, payments: bill.payments, documents: bill.documents });
}
function adapter(value: Fixture, overrides: Partial<SupplierBillAdapter> = {}): SupplierBillAdapter {
  return { create: vi.fn(async () => ({ externalId: value.externalId, confirmedAt: new Date() })),
    attach: vi.fn(async () => ({ externalId: value.externalId, confirmedAt: new Date() })),
    update: vi.fn(async () => ({ externalId: value.externalId, confirmedAt: new Date() })),
    reconcile: vi.fn(), reconcileAttachment: vi.fn(), reconcileUpdate: vi.fn(), ...overrides };
}
function injectProvider(provider: SupplierBillAdapter) {
  // No adapter seam exists in production. Only this isolated test spy supplies one.
  return vi.spyOn(queue, "processIntegrationJobs").mockImplementation(options => actualProcess({ ...options, adapterFactory: () => provider }));
}

describe("after-response exact-bill dispatch in guarded disposable MySQL", () => {
  it("creates and attaches the selected bill once while leaving another queued bill and its financial source untouched", async () => {
    const selected = await fixture(true), unrelated = await fixture(), before = await preservedState(selected.bill.id);
    const provider = adapter(selected), dispatch = injectProvider(provider);
    expect(await runImmediateBillSync(owner, await saved(selected.bill.id))).toEqual({ processed: 2 });
    expect(dispatch.mock.calls.map(([options]) => options?.jobId)).toEqual([selected.operation.id, expect.any(String)]);
    expect(provider.create).toHaveBeenCalledTimes(1); expect(provider.attach).toHaveBeenCalledTimes(1);
    expect(provider.update).not.toHaveBeenCalled(); expect(provider.reconcile).not.toHaveBeenCalled();
    const jobs = await db.integrationJob.findMany({ where: { billId: selected.bill.id }, include: { history: true } });
    expect(jobs).toHaveLength(2);
    for (const job of jobs) { expect(job).toMatchObject({ status: "SUCCEEDED", attempts: 1, externalId: selected.externalId }); expect(job.history).toHaveLength(1); }
    expect(await db.integrationJob.findUnique({ where: { id: unrelated.operation.id } })).toMatchObject({ status: "QUEUED", attempts: 0 });
    expect(await preservedState(selected.bill.id)).toBe(before);
    expect(await db.syncRecord.findUnique({ where: { billId_target: { billId: selected.bill.id, target: "ZOHO" } } })).toMatchObject({ status: "SYNCED", externalId: selected.externalId });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shares the ordinary durable claim with a racing worker without duplicate creation or attachment", async () => {
    const value = await fixture(true);
    let release!: () => void, started!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { started = resolve; });
    const provider = adapter(value, { create: vi.fn(async () => { started(); await held; return { externalId: value.externalId, confirmedAt: new Date() }; }) });
    injectProvider(provider);
    const immediate = runImmediateBillSync(owner, await saved(value.bill.id));
    try {
      await entered;
      expect(await actualProcess({ jobId: value.operation.id, adapterFactory: () => provider })).toEqual({ processed: 0 });
    } finally { release(); }
    expect(await immediate).toEqual({ processed: 2 });
    expect(provider.create).toHaveBeenCalledTimes(1); expect(provider.attach).toHaveBeenCalledTimes(1);
    expect(await db.integrationAttempt.count({ where: { job: { billId: value.bill.id } } })).toBe(2);
  });

  it("drains a fresh attachment when the ordinary worker already confirmed the exact original creation", async () => {
    const value = await fixture(true), provider = adapter(value);
    await actualProcess({ jobId: value.operation.id, adapterFactory: () => provider });
    const dispatch = injectProvider(provider);
    expect(await runImmediateBillSync(owner, await saved(value.bill.id))).toEqual({ processed: 1 });
    expect(dispatch).toHaveBeenCalledTimes(1); expect(dispatch.mock.calls[0][0]?.jobId).not.toBe(value.operation.id);
    expect(provider.create).toHaveBeenCalledTimes(1); expect(provider.attach).toHaveBeenCalledTimes(1);
  });

  it.each(["UNKNOWN", "RETRY", "FAILED", "HISTORICAL_QUEUED", "FUTURE_QUEUED"] as const)("leaves %s operations for explicit recovery or the durable scheduler", async state => {
    const value = await fixture(), historical = state !== "FUTURE_QUEUED";
    await db.integrationJob.update({ where: { id: value.operation.id }, data: {
      status: state === "HISTORICAL_QUEUED" || state === "FUTURE_QUEUED" ? "QUEUED" : state,
      attempts: historical ? 1 : 0, needsReconciliation: state === "UNKNOWN",
      errorCode: state === "UNKNOWN" ? "RESPONSE_UNCONFIRMED" : state === "RETRY" ? "RATE_LIMITED" : state === "FAILED" ? "REMOTE_REJECTED" : null,
      nextAttemptAt: new Date(Date.now() + (state === "FUTURE_QUEUED" || state === "RETRY" ? 60_000 : -1_000)),
    } });
    if (historical) await db.integrationAttempt.create({ data: { jobId: value.operation.id, operation: "CREATE_BILL", outcome: state,
      errorCode: "FICTIONAL_PRIOR_ATTEMPT", startedAt: new Date() } });
    const before = await db.integrationJob.findUnique({ where: { id: value.operation.id }, include: { history: true } });
    const provider = adapter(value), dispatch = injectProvider(provider);
    expect(await runImmediateBillSync(owner, await saved(value.bill.id))).toEqual({ processed: 0 });
    expect(dispatch).not.toHaveBeenCalled(); expect(provider.create).not.toHaveBeenCalled(); expect(provider.reconcile).not.toHaveBeenCalled();
    expect(await db.integrationJob.findUnique({ where: { id: value.operation.id }, include: { history: true } })).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rechecks ownership and the committed version before claiming the exact job", async () => {
    const value = await fixture(), current = await saved(value.bill.id), provider = adapter(value), dispatch = injectProvider(provider);
    expect(await runImmediateBillSync(peer, current)).toEqual({ processed: 0 });
    expect(await runImmediateBillSync(owner, { ...current, version: current.version + 1 })).toEqual({ processed: 0 });
    expect(dispatch).not.toHaveBeenCalled(); expect(provider.create).not.toHaveBeenCalled();
    expect(await db.integrationJob.findUnique({ where: { id: value.operation.id } })).toMatchObject({ status: "QUEUED", attempts: 0 });
  });

  it("dispatches a fresh UPDATE against its existing identity without replaying CREATE or draining another bill", async () => {
    const value = await fixture(), unrelated = await fixture();
    await db.integrationJob.update({ where: { id: value.operation.id }, data: { status: "SUCCEEDED", attempts: 1, externalId: value.externalId, completedAt: new Date() } });
    await db.integrationAttempt.create({ data: { jobId: value.operation.id, operation: "CREATE_BILL", outcome: "SUCCEEDED", externalId: value.externalId, startedAt: new Date() } });
    await db.syncRecord.update({ where: { billId_target: { billId: value.bill.id, target: "ZOHO" } }, data: { status: "SYNCED", attempts: 1, externalId: value.externalId, lastSyncedAt: new Date() } });
    const source = snapshotSchema.parse(value.operation.snapshot), payload = buildBooksPayload(source, settings);
    vi.spyOn(oauth, "accessToken").mockResolvedValue("fictional-immediate-read-token");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") !== "GET" || new URL(input).pathname !== `/books/v3/bills/${value.externalId}`)
        throw new Error("Only the fictional existing-bill preview GET is allowed.");
      return Response.json({ code: 0, bill: { bill_id: value.externalId, vendor_id: payload.vendor_id, bill_number: payload.bill_number,
        reference_number: payload.reference_number, currency_code: "AED", total: "105.00", tax_total: "5.00", date: "2026-11-04",
        due_date: "2026-11-20", payment_terms: 16, notes: payload.notes, payment_made: "0.00", vendor_credits_applied: "0.00",
        balance: "105.00", last_modified_time: "2026-11-04T10:00:00Z", status: "open", documents: [],
        line_items: payload.line_items.map((line, index) => ({ ...line, line_item_id: String(88670 + index), is_billable: false })) } });
    }));
    const edited = await updateBill(owner, value.bill.id, { companyId, vendorId, jobId, currency: "AED", invoiceNumber: value.bill.invoiceNumber,
      invoiceDate: "2026-11-04", dueDate: "2026-11-20", paymentTerms: "CUSTOM", category: "MATERIALS", discount: "0", vatRate: "5",
      lines: [{ description: "FICTIONAL immediate correction", quantity: "1", unitPrice: "120" }], version: value.bill.version });
    const update = await db.integrationJob.findFirstOrThrow({ where: { billId: value.bill.id, operation: "UPDATE_BILL" } });
    expect(update.sourceVersion).toBe(edited.version);
    const before = await preservedState(value.bill.id), provider = adapter(value), dispatch = injectProvider(provider);
    expect(await runImmediateBillSync(owner, await saved(value.bill.id))).toEqual({ processed: 1 });
    expect(dispatch.mock.calls.map(([options]) => options?.jobId)).toEqual([update.id]);
    expect(provider.update).toHaveBeenCalledWith(value.externalId, expect.anything(), expect.anything(), "0.00");
    expect(provider.create).not.toHaveBeenCalled(); expect(provider.attach).not.toHaveBeenCalled(); expect(provider.reconcileUpdate).not.toHaveBeenCalled();
    expect(await db.integrationJob.findUnique({ where: { id: unrelated.operation.id } })).toMatchObject({ status: "QUEUED", attempts: 0 });
    expect(await preservedState(value.bill.id)).toBe(before);
  });
});
