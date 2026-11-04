import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import * as configuration from "@/lib/integrations/config";
import * as oauth from "@/lib/integrations/oauth";
import { buildBooksPayload, snapshotSchema, type BillSnapshot, type SupplierBillAdapter } from "@/lib/integrations/books";
import { correctionStateHash, isSupersededIntegrationJob } from "@/lib/integrations/source-supersession";
import { processIntegrationJobs, queueBill, scheduleIntegrationJob } from "@/lib/integrations/queue";
import { actOnBill, updateBill } from "@/lib/services/bills";
import { billEditEligibility } from "@/lib/services/bill-edit";
import { attachDocument } from "@/lib/services/documents";
import { assertMySqlTestDatabase } from "./company-fixtures";

const tag = randomUUID().slice(0, 8), organizationId = `8870${Date.now()}`;
const originalGetConfig = configuration.getConfig;
const baseConfig = originalGetConfig("ZOHO", {
  NODE_ENV: "test", APP_ENV: "test", INTEGRATION_NETWORK_ENABLED: "true", INTEGRATION_TEST_MODE: "true",
  ZOHO_BOOKS_WRITE_ENABLED: "true", ZOHO_BOOKS_DC: "US", ZOHO_BOOKS_ENVIRONMENT: "sandbox",
  ZOHO_BOOKS_ORGANIZATION_ID: organizationId, ZOHO_BOOKS_CLIENT_ID: "fictional-edit-client",
  ZOHO_BOOKS_CLIENT_SECRET: "fictional-edit-secret",
  ZOHO_BOOKS_MAPPING_JSON: JSON.stringify({ verified: true, baseCurrency: "AED", currencies: { AED: { id: "88701" } },
    taxes: { "5.00": { id: "88702", percentage: "5" } }, categories: { MATERIALS: { accountId: "88703" } } }),
});
const settings = { ...baseConfig, writeEnabled: true, testAuthorization: { mode: "nonproduction" as const, organizationId, dataCenter: "US" as const,
  configurationHash: configuration.booksTestConfigurationHash(baseConfig), approvedBy: "fictional-edit-operator",
  approvalReference: "FICTIONAL-EDIT-APPROVAL", isolationEvidenceReference: "FICTIONAL-EDIT-ISOLATION",
  verifiedAt: new Date(Date.now() - 1_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() } };
let admin: Actor, owner: Actor, peer: Actor, companyId: string, vendorId: string, otherVendorId: string, jobId: string;
let externalSequence = 887900;
beforeAll(async () => {
  assertMySqlTestDatabase();
  [admin, owner, peer] = await Promise.all((["ADMIN", "ACCOUNTS", "ACCOUNTS"] as const).map((role, index) =>
    db.user.create({ data: { email: `edit-${tag}-${index}@example.invalid`, name: `FICTIONAL edit ${index}`, role, passwordHash: "not-a-login" } })));
  companyId = (await db.company.create({ data: { name: `FICTIONAL edit ${tag}`, isDemo: false, liveAccountingEnabled: false,
    memberships: { create: [admin, owner, peer].map(actor => ({ userId: actor.id })) } } })).id;
  await db.companyIntegrationDestination.create({ data: { companyId, target: "ZOHO", organizationId, dataCenter: "US", environment: "sandbox" } });
  await db.integrationCredential.create({ data: { target: "ZOHO", organizationId, dataCenter: "US",
    connectionFingerprint: oauth.connectionFingerprint(settings), refreshTokenEncrypted: "fictional-unused-encrypted-value" } });
  [vendorId, otherVendorId] = await Promise.all(["original", "alternative"].map(async name =>
    (await db.vendor.create({ data: { companyId, name: `FICTIONAL edit ${name}`, currency: "AED" } })).id));
  for (const [local, externalVendorId] of [[vendorId, "88704"], [otherVendorId, "88705"]])
    await db.vendorBooksMapping.create({ data: { vendorId: local, organizationId, dataCenter: "US", environment: "sandbox", externalVendorId } });
  jobId = (await db.job.create({ data: { companyId, jobNumber: `FICTIONAL-EDIT-${tag}`, name: "FICTIONAL edit job", customer: "FICTIONAL", currency: "AED" } })).id;
});
beforeEach(() => {
  vi.stubEnv("ZOHO_BOOKS_ORGANIZATIONS_JSON", ""); vi.stubEnv("ZOHO_BOOKS_ORGANIZATION_ID", organizationId); vi.stubEnv("MANUAL_ENTRY_ONLY", "false");
  vi.spyOn(configuration, "getConfig").mockImplementation((target, _env, organization) => {
    if (target !== "ZOHO" || organization && organization !== organizationId) throw new Error("Unexpected fictional edit destination.");
    return settings;
  });
  vi.spyOn(oauth, "accessToken").mockResolvedValue("fictional-edit-read-token");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected provider request in isolated edit tests.")));
});
afterEach(async () => {
  // Other integration suites use this disposable schema; leave no claimable fixture operations.
  if (companyId) await db.integrationJob.updateMany({ where: { bill: { companyId }, status: { in: ["QUEUED", "RETRY"] } }, data: { status: "CANCELLED" } });
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});
afterAll(() => db.$disconnect());

async function fixture(options: { document?: boolean; paid?: string; queued?: boolean; legacyTerms?: boolean } = {}) {
  const invoiceNumber = `FICTIONAL-EDIT-${randomUUID()}`, bytes = new TextEncoder().encode(`%PDF-1.4\nFICTIONAL saved original ${invoiceNumber}\n%%EOF`);
  let bill = await db.bill.create({ data: { companyId, vendorId, jobId, invoiceNumber, normalizedInvoiceNumber: invoiceNumber,
    invoiceDate: new Date("2026-11-04"), dueDate: options.legacyTerms ? null : new Date("2026-11-20"), paymentTerms: "CUSTOM", category: "MATERIALS", currency: "AED",
    createdById: owner.id, status: "DRAFT", subtotal: "100", discount: "0", vatRate: "5", vatAmount: "5", total: "105",
    lines: { create: { description: "FICTIONAL original material", quantity: "1", unitPrice: "100", lineTotal: "100" } },
    syncRecords: { create: [{ target: "ZOHO", status: "NOT_CONFIGURED" }, { target: "CRM", status: "NOT_CONFIGURED" }] } } });
  if (options.document) await attachDocument(owner, bill.id, new File([bytes], "fictional-edit-original.pdf", { type: "application/pdf" }));
  bill = await db.bill.update({ where: { id: bill.id }, data: { status: "READY", paidAmount: options.paid ?? "20", version: { increment: 1 },
    payments: { create: { amount: options.paid ?? "20", reference: `FICTIONAL-LOCAL-${tag}`, createdById: owner.id } } } });
  const original = await queueBill(owner, bill.id, "ZOHO", organizationId), externalId = String(++externalSequence);
  if (!options.queued) {
    await db.integrationJob.update({ where: { id: original.id }, data: { status: "SUCCEEDED", externalId, attempts: 1, completedAt: new Date() } });
    await db.integrationAttempt.create({ data: { jobId: original.id, operation: "CREATE_BILL", outcome: "SUCCEEDED", externalId, startedAt: new Date() } });
    await db.syncRecord.update({ where: { billId_target: { billId: bill.id, target: "ZOHO" } }, data: { status: "SYNCED", organizationId, externalId, attempts: 1, lastSyncedAt: new Date() } });
  }
  return { bill, original: await db.integrationJob.findUniqueOrThrow({ where: { id: original.id }, include: { history: true } }),
    snapshot: snapshotSchema.parse(original.snapshot), externalId, bytes };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function editInput(value: Fixture, changes: Record<string, unknown> = {}) {
  return { companyId, vendorId, jobId, currency: "AED", invoiceNumber: value.bill.invoiceNumber, invoiceDate: "2026-11-04",
    dueDate: "2026-11-20", paymentTerms: "CUSTOM", category: "MATERIALS", discount: "0", vatRate: "5",
    lines: [{ description: "FICTIONAL corrected material", quantity: "1", unitPrice: "120" }], version: value.bill.version, ...changes };
}
function remoteBill(value: Fixture, snapshot: BillSnapshot = value.snapshot) {
  const payload = buildBooksPayload(snapshot, settings);
  return { bill_id: value.externalId, vendor_id: payload.vendor_id, bill_number: payload.bill_number, reference_number: payload.reference_number,
    currency_code: "AED", total: snapshot.total, tax_total: snapshot.vatAmount, date: snapshot.invoiceDate, due_date: "2026-11-20", payment_terms: 16,
    notes: payload.notes, payment_made: "20.00", vendor_credits_applied: "0.00", balance: "85.00", last_modified_time: "2026-11-04T10:00:00Z", status: "open",
    documents: snapshot.documents.map(() => ({ document_id: "88781", file_name: "fictional-edit-original.pdf" })),
    line_items: payload.line_items.map((line, index) => ({ ...line, line_item_id: String(88770 + index), is_billable: false })) };
}
function reader(value: Fixture, options: { beforeRead?: () => Promise<void>; remote?: Record<string, unknown>; absent?: boolean } = {}) {
  const requests: string[] = [];
  const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET") !== "GET") throw new Error("Provider writes are forbidden in finalized edit preparation tests.");
    const url = new URL(input); requests.push(url.pathname);
    if (url.pathname === `/books/v3/bills/${value.externalId}`) {
      await options.beforeRead?.();
      return Response.json({ code: 0, bill: { ...remoteBill(value), ...options.remote } });
    }
    if (url.pathname === `/books/v3/bills/${value.externalId}/attachment`) return new Response(value.bytes, { headers: { "Content-Type": "application/pdf" } });
    if (options.absent && url.pathname === "/books/v3/bills") return Response.json({ code: 0, bills: [], page_context: { has_more_page: false } });
    throw new Error(`Unexpected fictional GET endpoint: ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetcher);
  return { fetcher, requests };
}
async function invariantState(billId: string) {
  const bill = await db.bill.findUniqueOrThrow({ where: { id: billId }, include: { payments: { orderBy: { id: "asc" } }, documents: { orderBy: { id: "asc" } } } });
  return correctionStateHash({ companyId: bill.companyId, jobId: bill.jobId, createdById: bill.createdById, currency: bill.currency,
    paidAmount: bill.paidAmount, payments: bill.payments, documents: bill.documents });
}
async function updateOperation(billId: string) {
  return db.integrationJob.findFirstOrThrow({ where: { billId, operation: "UPDATE_BILL" }, orderBy: { sourceVersion: "desc" } });
}
function simulatedWorker(value: Fixture, overrides: Partial<SupplierBillAdapter> = {}): SupplierBillAdapter {
  // Worker outcomes are simulated. The real service preview above permits GET only.
  return { create: vi.fn(), reconcile: vi.fn(), attach: vi.fn(), reconcileAttachment: vi.fn(),
    update: vi.fn(async () => ({ externalId: value.externalId, confirmedAt: new Date() })),
    reconcileUpdate: vi.fn(async () => ({ externalId: value.externalId, confirmedAt: new Date() })), ...overrides };
}

describe("finalized saved bill edits in guarded disposable MySQL", () => {
  it("queues the exact existing provider identity while preserving creator, job, company, paid ledger and originals", async () => {
    const value = await fixture({ document: true }), before = await invariantState(value.bill.id), reads = reader(value);
    const result = await updateBill(owner, value.bill.id, editInput(value));
    expect(result).toMatchObject({ version: value.bill.version + 1, total: "126.00", paidAmount: "20.00", syncOperation: "UPDATE_BILL" });
    expect(await invariantState(value.bill.id)).toBe(before);
    const update = await updateOperation(value.bill.id), source = snapshotSchema.parse(update.snapshot);
    expect(update).toMatchObject({ externalId: value.externalId, sourceVersion: result.version, idempotencyKey: `ZOHO:${value.bill.id}:UPDATE_BILL:${result.version}` });
    expect(source.revision).toMatchObject({ previousJobId: value.original.id, previousPayloadHash: value.original.payloadHash, externalId: value.externalId,
      remoteLineIds: ["88770"], remoteDocuments: [{ document_id: "88781", file_name: "fictional-edit-original.pdf" }] });
    expect(await db.integrationJob.findUnique({ where: { id: value.original.id }, include: { history: true } })).toEqual(value.original);
    expect(reads.requests).toEqual([`/books/v3/bills/${value.externalId}`, `/books/v3/bills/${value.externalId}/attachment`]);
    const adapter = simulatedWorker(value);
    expect(await processIntegrationJobs({ jobId: update.id, adapterFactory: () => adapter })).toEqual({ processed: 1 });
    expect(adapter.update).toHaveBeenCalledWith(value.externalId, expect.anything(), expect.anything(), "20.00");
    expect(adapter.create).not.toHaveBeenCalled(); expect(await invariantState(value.bill.id)).toBe(before);
  });
  it("rejects totals below local paid amounts before a provider request or write", async () => {
    const value = await fixture({ paid: "100" }), before = await invariantState(value.bill.id), reads = reader(value);
    await expect(updateBill(owner, value.bill.id, editInput(value, { lines: [{ description: "Too low", quantity: "1", unitPrice: "50" }] }))).rejects.toMatchObject({ code: "BILL_EDIT_BLOCKED" });
    expect(reads.fetcher).not.toHaveBeenCalled(); expect(await invariantState(value.bill.id)).toBe(before);
    expect(await db.integrationJob.count({ where: { billId: value.bill.id } })).toBe(1);
  });
  it("runs the real adapter, transport and final write guard with exactly one mocked PUT to the existing ID, including a legacy CUSTOM/null baseline", async () => {
    const value = await fixture({ legacyTerms: true }), before = await invariantState(value.bill.id);
    reader(value, { remote: { due_date: "2026-12-04", payment_terms: 30 } });
    await updateBill(owner, value.bill.id, editInput(value)); const update = await updateOperation(value.bill.id);
    let current = { ...remoteBill(value), due_date: "2026-12-04", payment_terms: 30 };
    const methods: { method: string; path: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input), method = init?.method ?? "GET"; methods.push({ method, path: url.pathname });
      if (method === "GET" && url.pathname === `/books/v3/bills/${value.externalId}`) return Response.json({ code: 0, bill: current });
      if (method === "GET" && url.pathname === "/books/v3/contacts/88704") return Response.json({ code: 0, contact: {
        contact_id: "88704", contact_type: "vendor", status: "active", currency_code: "AED", tax_treatment: "vat_registered" } });
      if (method === "GET" && url.pathname === `/books/v3/organizations/${organizationId}`) return Response.json({ code: 0,
        organization: { organization_id: organizationId, is_org_active: true, currency_code: "AED", currency_id: "88701" } });
      if (method === "PUT" && url.pathname === `/books/v3/bills/${value.externalId}`) {
        const payload = JSON.parse(String(init?.body));
        expect(payload.reference_number).toBe(`VX-BILL-${value.bill.id}`); expect(payload.line_items[0].line_item_id).toBe("88770");
        current = { ...current, ...payload, total: "126.00", tax_total: "6.00", balance: "106.00", last_modified_time: "2026-11-04T10:01:00Z" };
        return Response.json({ code: 0, bill: { bill_id: value.externalId } });
      }
      throw new Error(`Unexpected fictional worker request: ${method} ${url.pathname}`);
    }));
    expect(await processIntegrationJobs({ jobId: update.id })).toEqual({ processed: 1 });
    expect(await db.integrationJob.findUnique({ where: { id: update.id } })).toMatchObject({ status: "SUCCEEDED", externalId: value.externalId });
    expect(methods.filter(item => item.method !== "GET")).toEqual([{ method: "PUT", path: `/books/v3/bills/${value.externalId}` }]);
    expect(methods.filter(item => item.method === "GET" && item.path === `/books/v3/bills/${value.externalId}`).length).toBeGreaterThanOrEqual(3);
    expect(await db.integrationJob.count({ where: { billId: value.bill.id, operation: "CREATE_BILL" } })).toBe(1);
    expect(await invariantState(value.bill.id)).toBe(before);
  });
  it("refuses supplier changes when fresh Books state has applied payments", async () => {
    const value = await fixture(), before = await invariantState(value.bill.id); reader(value);
    await expect(updateBill(owner, value.bill.id, editInput(value, { vendorId: otherVendorId }))).rejects.toMatchObject({ code: "UPDATE_PAID_VENDOR_CHANGE" });
    expect(await db.bill.findUnique({ where: { id: value.bill.id } })).toMatchObject({ vendorId, version: value.bill.version });
    expect(await invariantState(value.bill.id)).toBe(before);
  });
  it("keeps peer bills hidden and rejects a stale edit version before provider reads", async () => {
    const value = await fixture(), reads = reader(value);
    await expect(updateBill(peer, value.bill.id, editInput(value))).rejects.toMatchObject({ status: 404 });
    await expect(billEditEligibility(peer, value.bill.id)).rejects.toMatchObject({ status: 404 });
    await expect(updateBill(owner, value.bill.id, editInput(value, { version: value.bill.version - 1 }))).rejects.toMatchObject({ status: 409 });
    expect(reads.fetcher).not.toHaveBeenCalled(); expect(await db.integrationJob.count({ where: { billId: value.bill.id } })).toBe(1);
  });
  it("invalidates edit preparation if a real local payment changes the source during the provider GET", async () => {
    const value = await fixture(); let paid = false;
    reader(value, { beforeRead: async () => { if (!paid) { paid = true; await actOnBill(owner, value.bill.id,
      { action: "payment", amount: "10", reference: `FICTIONAL-RACE-${tag}`, version: value.bill.version }); } } });
    await expect(updateBill(owner, value.bill.id, editInput(value))).rejects.toMatchObject({ code: "BILL_EDIT_BLOCKED" });
    expect(await db.bill.findUnique({ where: { id: value.bill.id } })).toMatchObject({ version: value.bill.version + 1, paidAmount: expect.anything() });
    expect((await db.bill.findUniqueOrThrow({ where: { id: value.bill.id } })).paidAmount.toFixed(2)).toBe("30.00");
    expect(await db.payment.count({ where: { billId: value.bill.id } })).toBe(2);
    expect(await db.integrationJob.count({ where: { billId: value.bill.id } })).toBe(1);
  });
  it("allows only one optimistic concurrent edit against the same saved version", async () => {
    const value = await fixture(); let arrived = 0, release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    reader(value, { beforeRead: async () => { arrived++; if (arrived === 2) release(); await barrier; } });
    const results = await Promise.allSettled([updateBill(owner, value.bill.id, editInput(value)),
      updateBill(admin, value.bill.id, editInput(value, { lines: [{ description: "Other reviewed edit", quantity: "1", unitPrice: "130" }] }))]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(await db.bill.findUnique({ where: { id: value.bill.id } })).toMatchObject({ version: value.bill.version + 1 });
    expect(await db.integrationJob.count({ where: { billId: value.bill.id, operation: "UPDATE_BILL" } })).toBe(1);
  });
  it("reconciles an uncertain UPDATE against its existing ID without invoking CREATE or repeating UPDATE", async () => {
    const value = await fixture(), before = await invariantState(value.bill.id); reader(value);
    await updateBill(owner, value.bill.id, editInput(value)); const update = await updateOperation(value.bill.id);
    const adapter = simulatedWorker(value, { update: vi.fn().mockRejectedValue(new configuration.IntegrationError("UPDATE_UNCONFIRMED", "Fictional interrupted update.", "UNKNOWN")) });
    await processIntegrationJobs({ jobId: update.id, adapterFactory: () => adapter });
    expect(await db.integrationJob.findUnique({ where: { id: update.id } })).toMatchObject({ status: "UNKNOWN", needsReconciliation: true, externalId: value.externalId });
    expect(await billEditEligibility(owner, value.bill.id)).toMatchObject({ allowed: false });
    await scheduleIntegrationJob(owner, update.id, { action: "reconcile" });
    await processIntegrationJobs({ jobId: update.id, adapterFactory: () => adapter });
    expect(adapter.update).toHaveBeenCalledTimes(1); expect(adapter.reconcileUpdate).toHaveBeenCalledWith(value.externalId, expect.anything());
    expect(adapter.create).not.toHaveBeenCalled(); expect(adapter.reconcile).not.toHaveBeenCalled();
    expect(await db.integrationJob.findUnique({ where: { id: update.id } })).toMatchObject({ status: "SUCCEEDED", externalId: value.externalId });
    expect(await invariantState(value.bill.id)).toBe(before);
  });
  it("archives a definitely rejected prior UPDATE with its full history and makes it permanently inert", async () => {
    const value = await fixture(); reader(value); const first = await updateBill(owner, value.bill.id, editInput(value));
    const failed = await updateOperation(value.bill.id);
    await db.integrationJob.update({ where: { id: failed.id }, data: { status: "FAILED", attempts: 1, errorCode: "REMOTE_REJECTED" } });
    await db.integrationAttempt.create({ data: { jobId: failed.id, operation: "UPDATE_BILL", outcome: "FAILED", errorCode: "REMOTE_REJECTED", startedAt: new Date() } });
    const original = await db.integrationJob.findUniqueOrThrow({ where: { id: failed.id }, include: { history: true } });
    await updateBill(owner, value.bill.id, editInput(value, { version: first.version, lines: [{ description: "Second correction", quantity: "1", unitPrice: "125" }] }));
    const archived = await db.integrationJob.findUniqueOrThrow({ where: { id: failed.id }, include: { history: true } });
    expect(isSupersededIntegrationJob(archived)).toBe(true); expect(archived).toMatchObject({ status: "CANCELLED", errorCode: "SOURCE_SUPERSEDED" });
    expect(archived.snapshot).toEqual(original.snapshot); expect(archived.payloadHash).toBe(original.payloadHash); expect(archived.history).toEqual(original.history);
    for (const action of ["retry", "reconcile"]) await expect(scheduleIntegrationJob(admin, archived.id, { action })).rejects.toMatchObject({ status: 409 });
    const adapter = simulatedWorker(value); expect(await processIntegrationJobs({ jobId: archived.id, adapterFactory: () => adapter })).toEqual({ processed: 0 });
    expect(adapter.update).not.toHaveBeenCalled(); expect(adapter.create).not.toHaveBeenCalled();
    expect(snapshotSchema.parse((await updateOperation(value.bill.id)).snapshot).revision?.previousJobId).toBe(value.original.id);
  });
  it("replaces an untouched queued CREATE only after complete provider absence and preserves its immutable source", async () => {
    const value = await fixture({ queued: true }), before = await invariantState(value.bill.id), reads = reader(value, { absent: true });
    const result = await updateBill(owner, value.bill.id, editInput(value));
    const archived = await db.integrationJob.findUniqueOrThrow({ where: { id: value.original.id } });
    expect(isSupersededIntegrationJob(archived)).toBe(true); expect(archived.snapshot).toEqual(value.original.snapshot); expect(archived.attempts).toBe(0);
    const replacement = await db.integrationJob.findUniqueOrThrow({ where: { idempotencyKey: `ZOHO:${value.bill.id}:CREATE_BILL` } });
    expect(replacement.id).not.toBe(archived.id); expect(replacement).toMatchObject({ operation: "CREATE_BILL", sourceVersion: result.version, externalId: null });
    expect(reads.requests.length).toBeGreaterThanOrEqual(3); expect(reads.requests.every(path => path === "/books/v3/bills")).toBe(true);
    expect(await invariantState(value.bill.id)).toBe(before);
  });
});
