import { Prisma, type IntegrationJob } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { snapshotHash, type BillSnapshot } from "@/lib/integrations/books";
import { runImmediateBillSync, scheduleBillSyncAfterResponse, type SavedBillForImmediateSync } from "@/lib/integrations/immediate-bill-sync";

const mocks = vi.hoisted(() => ({ after: vi.fn(), current: vi.fn(), process: vi.fn(), user: vi.fn(), bill: vi.fn(), children: vi.fn(), job: vi.fn() }));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/lib/db", () => ({ db: { user: { findFirst: mocks.user }, bill: { findFirst: mocks.bill },
  integrationJob: { findMany: mocks.children, findUnique: mocks.job } } }));
vi.mock("@/lib/integrations/books-mutations", () => ({ currentBooksMutation: mocks.current }));
vi.mock("@/lib/integrations/queue", () => ({ processIntegrationJobs: mocks.process }));
vi.mock("@/lib/integrations/local-live-test", () => ({ isLocalLiveTestSnapshot: (source: BillSnapshot) => source.destination?.authorizationReference?.startsWith("LOCAL_ONE_BILL_TEST:") === true }));

const actor = { id: "fictional-author", role: "ACCOUNTS" as const }, organizationId = "88701";
function fixture(id = "fictional-bill") {
  const saved: SavedBillForImmediateSync = { id, companyId: "fictional-company", version: 3, status: "READY",
    syncRecords: [{ target: "ZOHO", status: "PENDING", organizationId }] };
  const snapshot: BillSnapshot = { internalBillId: id, companyId: saved.companyId, initiatedById: actor.id, sourceVersion: 3,
    destination: { dataCenter: "US", environment: "sandbox", mappingHash: "a".repeat(64) }, invoiceNumber: "DEMO-SPEED", invoiceDate: "2026-11-04",
    dueDate: null, orderNumber: null, paymentTerms: "CUSTOM", category: "MATERIALS", currency: "AED", discount: "0.00", vatRate: "5.00", subtotal: "100.00",
    vatAmount: "5.00", total: "105.00", vendorId: "fictional-vendor", externalVendorId: "88704", jobId: "fictional-job", jobNumber: "JOB-8870", externalCrmJobId: null,
    lines: [{ description: "Fictional item", quantity: "1", unitPrice: "100.00" }], documents: [{ id: "fictional-original", sha256: "b".repeat(64), fileName: "synthetic.pdf", mimeType: "application/pdf" }] };
  const root: IntegrationJob = { id: `${id}-root`, billId: id, initiatedById: actor.id, target: "ZOHO", operation: "CREATE_BILL", status: "QUEUED",
    idempotencyKey: `ZOHO:${id}:CREATE_BILL`, organizationId, sourceVersion: 3, snapshot: snapshot as unknown as Prisma.JsonValue, payloadHash: snapshotHash(snapshot),
    documentId: null, externalId: null, attempts: 0, reconciliationAttempts: 0, needsReconciliation: false, nextAttemptAt: new Date(0), lastAttemptAt: null,
    lastError: null, errorCode: null, leaseToken: null, leaseUntil: null, completedAt: null, createdAt: new Date(), updatedAt: new Date() };
  const child: IntegrationJob = { ...root, id: `${id}-child`, operation: "ATTACH_DOCUMENT", externalId: "88799", documentId: "fictional-original",
    idempotencyKey: `ZOHO:${id}:ATTACH_DOCUMENT:fictional-original` };
  return { saved, snapshot, root, child };
}
function setup(value = fixture()) {
  mocks.user.mockResolvedValue({ id: actor.id });
  mocks.bill.mockResolvedValue({ id: value.saved.id, syncRecords: [{ status: "PENDING", organizationId }] });
  mocks.current.mockImplementation(async () => value.root);
  mocks.children.mockResolvedValue([value.child]); mocks.job.mockImplementation(async () => value.child);
  mocks.process.mockImplementation(async ({ jobId }) => {
    const job = jobId === value.root.id ? value.root : value.child;
    job.status = "SUCCEEDED"; job.externalId = "88799"; job.attempts = 1;
    return { processed: 1 };
  });
  return value;
}
beforeEach(() => { vi.resetAllMocks(); vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());

describe("bounded immediate synchronization after a committed response", () => {
  it("defers the exact root and original to after the response, using only the existing exact-job processor", async () => {
    const value = setup();
    expect(scheduleBillSyncAfterResponse(actor, value.saved)).toBe(true);
    expect(mocks.process).not.toHaveBeenCalled(); expect(mocks.user).not.toHaveBeenCalled();
    await mocks.after.mock.calls[0][0]();
    expect(mocks.process.mock.calls.map(([options]) => options)).toEqual([{ jobId: value.root.id }, { jobId: value.child.id }]);
    expect(mocks.children).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ billId: value.saved.id, initiatedById: actor.id,
      organizationId, sourceVersion: 3, payloadHash: value.root.payloadHash, status: "QUEUED", attempts: 0, needsReconciliation: false }), take: 5 }));
  });
  it.each([
    { status: "DRAFT" }, { status: "CANCELLED" }, { version: 0 }, { syncRecords: [] },
    { syncRecords: [{ target: "ZOHO", status: "UNKNOWN", organizationId }] },
    { syncRecords: [{ target: "ZOHO", status: "FAILED", organizationId }] },
    { syncRecords: [{ target: "ZOHO", status: "PENDING", organizationId: null }] },
  ])("does not schedule an ineligible response: %o", changes => {
    const value = setup(); Object.assign(value.saved, changes);
    expect(scheduleBillSyncAfterResponse(actor, value.saved)).toBe(false); expect(mocks.after).not.toHaveBeenCalled();
  });
  it("rechecks the exact role, active membership, source version, creator and persisted pending organization", async () => {
    const value = setup(); mocks.user.mockResolvedValue(null);
    expect(await runImmediateBillSync(actor, value.saved)).toEqual({ processed: 0 });
    expect(mocks.process).not.toHaveBeenCalled();
    expect(mocks.user).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: actor.id, role: "ACCOUNTS", active: true }) }));
    expect(mocks.bill).toHaveBeenCalledWith(expect.objectContaining({ where: { id: value.saved.id, companyId: value.saved.companyId, version: 3,
      status: { in: ["READY", "APPROVED"] }, createdById: actor.id } }));
  });
  it.each([
    { status: "UNKNOWN", needsReconciliation: true }, { status: "FAILED" }, { status: "RETRY" }, { status: "PROCESSING" },
    { attempts: 1 }, { reconciliationAttempts: 1 }, { nextAttemptAt: new Date(Date.now() + 60_000) }, { leaseToken: "held" },
    { initiatedById: "different-author" }, { organizationId: "88702" }, { sourceVersion: 2 }, { errorCode: "SOURCE_SUPERSEDED" },
  ])("does not replay old, uncertain, deferred or foreign operations: %o", async changes => {
    const value = setup(); Object.assign(value.root, changes);
    await expect(runImmediateBillSync(actor, value.saved)).resolves.toEqual({ processed: 0 });
    expect(mocks.process).not.toHaveBeenCalled();
  });
  it("rejects snapshot corruption and historical one-bill permission sources", async () => {
    const value = setup(); value.root.payloadHash = "f".repeat(64);
    await runImmediateBillSync(actor, value.saved); expect(mocks.process).not.toHaveBeenCalled();
    value.snapshot.destination!.authorizationReference = "LOCAL_ONE_BILL_TEST:fictional";
    value.root.snapshot = value.snapshot as unknown as Prisma.JsonValue; value.root.payloadHash = snapshotHash(value.snapshot);
    await runImmediateBillSync(actor, value.saved); expect(mocks.process).not.toHaveBeenCalled();
  });
  it("uses an exact already-confirmed root only to drain its new original when the worker wins", async () => {
    const value = setup(); value.root.status = "SUCCEEDED"; value.root.attempts = 1; value.root.externalId = "88799";
    expect(await runImmediateBillSync(actor, value.saved)).toEqual({ processed: 1 });
    expect(mocks.process).toHaveBeenCalledExactlyOnceWith({ jobId: value.child.id });
  });
  it("processes a fresh exact UPDATE without touching creation or attachment history", async () => {
    const value = setup(); value.root.operation = "UPDATE_BILL"; value.root.externalId = "88799";
    value.root.idempotencyKey = `ZOHO:${value.saved.id}:UPDATE_BILL:3`;
    expect(await runImmediateBillSync(actor, value.saved)).toEqual({ processed: 1 });
    expect(mocks.process).toHaveBeenCalledExactlyOnceWith({ jobId: value.root.id }); expect(mocks.children).not.toHaveBeenCalled();
  });
  it("never processes a child that is not in the root source or belongs to another actor", async () => {
    const value = setup(); value.child.documentId = "not-in-root"; value.child.idempotencyKey = `ZOHO:${value.saved.id}:ATTACH_DOCUMENT:not-in-root`;
    await runImmediateBillSync(actor, value.saved);
    expect(mocks.process).toHaveBeenCalledExactlyOnceWith({ jobId: value.root.id });
    value.child.documentId = "fictional-original"; value.child.idempotencyKey = `ZOHO:${value.saved.id}:ATTACH_DOCUMENT:fictional-original`;
    value.child.initiatedById = "different-author";
    mocks.process.mockClear(); await runImmediateBillSync(actor, value.saved); expect(mocks.process).not.toHaveBeenCalled();
  });
  it("deduplicates the same bill while its provider work is active", async () => {
    const value = setup(); let entered!: () => void, finish!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), release = new Promise<void>(resolve => { finish = resolve; });
    mocks.process.mockImplementation(async () => { entered(); await release; return { processed: 0 }; });
    const first = runImmediateBillSync(actor, value.saved); await started;
    expect(await runImmediateBillSync(actor, value.saved)).toEqual({ processed: 0 }); expect(mocks.process).toHaveBeenCalledTimes(1);
    finish(); await first;
  });
  it("caps active distinct bills at two and leaves overflow to the durable worker", async () => {
    const values = [fixture("bill-one"), fixture("bill-two"), fixture("bill-three")]; setup(values[0]);
    mocks.bill.mockImplementation(async ({ where }) => ({ id: where.id, syncRecords: [{ status: "PENDING", organizationId }] }));
    mocks.current.mockImplementation(async (_store, billId) => values.find(value => value.saved.id === billId)!.root);
    mocks.children.mockResolvedValue([]);
    let finish!: () => void; const release = new Promise<void>(resolve => { finish = resolve; });
    mocks.process.mockImplementation(async () => { await release; return { processed: 0 }; });
    const first = runImmediateBillSync(actor, values[0].saved), second = runImmediateBillSync(actor, values[1].saved);
    await vi.waitFor(() => expect(mocks.process).toHaveBeenCalledTimes(2));
    expect(await runImmediateBillSync(actor, values[2].saved)).toEqual({ processed: 0 });
    finish(); await Promise.all([first, second]); expect(mocks.process).toHaveBeenCalledTimes(2);
  });
  it("keeps the committed response and queue usable if dispatch fails or after registration is unavailable", async () => {
    const value = setup(); mocks.process.mockRejectedValueOnce(new Error("sensitive provider/database details"));
    expect(await runImmediateBillSync(actor, value.saved)).toEqual({ processed: 0 }); expect(value.root.status).toBe("QUEUED");
    expect(console.error).toHaveBeenCalledWith("Immediate bill synchronization stopped; the durable worker will continue.");
    mocks.after.mockImplementationOnce(() => { throw new Error("Request context unavailable"); });
    expect(scheduleBillSyncAfterResponse(actor, value.saved)).toBe(false);
  });
});
