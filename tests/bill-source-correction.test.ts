import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SOURCE_SUPERSEDED,
  assertDefiniteSourceRejection,
  assertSourceSupersessionQueueProof,
  consumeSourceSupersessionQueueProof,
  correctionStateHash,
  isSupersededIntegrationJob,
  sourceSupersessionQueueProof,
  supersededSourceKey,
  type SourceSupersessionQueueProof,
} from "@/lib/integrations/source-supersession";

const unsafe = { code: "SOURCE_CORRECTION_UNSAFE", kind: "BLOCKED" };
const original = () => ({
  id: "original-operation", billId: "saved-bill", target: "ZOHO", operation: "CREATE_BILL",
  idempotencyKey: "ZOHO:saved-bill:CREATE_BILL", status: "FAILED", errorCode: "REMOTE_REJECTED",
  needsReconciliation: false, externalId: null as string | null, leaseToken: null as string | null,
  leaseUntil: null as Date | null, attempts: 2,
});
const rejectedHistory = () => [
  { outcome: "FAILED", errorCode: "REMOTE_REJECTED", externalId: null as string | null },
  { outcome: "BLOCKED", errorCode: "VENDOR_VAT_TREATMENT_MISMATCH", externalId: null as string | null },
];

beforeEach(() => vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No provider requests are permitted in pure correction guards."); })));
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("immutable superseded operation identity", () => {
  it("reserves a deterministic key while keeping the original operation identity available", () => {
    expect(supersededSourceKey("ZOHO", "saved-bill", "original-operation"))
      .toBe("ZOHO:saved-bill:CREATE_BILL:SUPERSEDED:original-operation");
    expect(isSupersededIntegrationJob(original())).toBe(false);
    expect(isSupersededIntegrationJob({ ...original(), idempotencyKey: supersededSourceKey("ZOHO", "saved-bill", "original-operation") })).toBe(true);
    expect(isSupersededIntegrationJob({ ...original(), errorCode: SOURCE_SUPERSEDED })).toBe(true);
    expect(isSupersededIntegrationJob({ ...original(), idempotencyKey: "ZOHO:another-bill:CREATE_BILL:SUPERSEDED:original-operation" })).toBe(false);
  });
  it.each(["", "invalid:key", "../operation", "bad operation", "a".repeat(101)])("refuses invalid identity component %s", value => {
    expect(() => supersededSourceKey("ZOHO", "saved-bill", value)).toThrow(expect.objectContaining(unsafe));
  });
  it("refuses a combined reserved key longer than the database limit", () => {
    expect(supersededSourceKey("ZOHO", "b".repeat(100), "j".repeat(100)).length).toBeLessThanOrEqual(255);
    expect(() => supersededSourceKey("t".repeat(100), "b".repeat(100), "j".repeat(100))).toThrow(expect.objectContaining(unsafe));
  });
  it("keeps the display/denial predicate nonthrowing for legacy and long ordinary identities", () => {
    expect(() => isSupersededIntegrationJob({ ...original(), id: "legacy:operation", billId: "b".repeat(200) })).not.toThrow();
    expect(isSupersededIntegrationJob({ ...original(), id: "legacy:operation", billId: "b".repeat(200) })).toBe(false);
    expect(isSupersededIntegrationJob({ ...original(), id: "legacy:operation", billId: "b".repeat(200), errorCode: SOURCE_SUPERSEDED })).toBe(true);
  });
});

describe("complete definite-rejection history before source amendment", () => {
  it.each(["FAILED", "BLOCKED"])("accepts only a canonical %s with complete definite attempts", status => {
    expect(() => assertDefiniteSourceRejection({ ...original(), status }, rejectedHistory())).not.toThrow();
  });
  it.each([
    ["non-Zoho", { target: "CRM" }], ["attachment", { operation: "ATTACH_DOCUMENT" }],
    ["other canonical key", { idempotencyKey: "ZOHO:other-bill:CREATE_BILL" }],
    ["superseded marker", { errorCode: SOURCE_SUPERSEDED }],
    ["superseded key", { idempotencyKey: "ZOHO:saved-bill:CREATE_BILL:SUPERSEDED:original-operation" }],
    ["queued", { status: "QUEUED" }], ["processing", { status: "PROCESSING" }],
    ["retrying", { status: "RETRY" }], ["unknown", { status: "UNKNOWN" }],
    ["confirmed", { status: "SUCCEEDED" }], ["cancelled", { status: "CANCELLED" }],
    ["uncertain", { needsReconciliation: true }], ["external bill", { externalId: "12345" }],
    ["lease token", { leaseToken: "held-lease" }], ["expired lease still present", { leaseUntil: new Date(0) }],
    ["unattempted", { attempts: 0 }], ["missing code", { errorCode: "" }],
    ["interrupted request", { errorCode: "REQUEST_INTERRUPTED" }],
  ] as const)("refuses %s", (_label, changed) => {
    expect(() => assertDefiniteSourceRejection({ ...original(), ...changed }, rejectedHistory())).toThrow(expect.objectContaining(unsafe));
  });
  it.each([
    ["missing attempt", [{ outcome: "FAILED", errorCode: "REMOTE_REJECTED" }]],
    ["empty history", []],
    ["unknown outcome", [{ outcome: "UNKNOWN", errorCode: "REQUEST_INTERRUPTED" }, rejectedHistory()[1]]],
    ["confirmed outcome", [{ outcome: "SUCCEEDED", errorCode: "REMOTE_REJECTED" }, rejectedHistory()[1]]],
    ["missing failure code", [{ outcome: "FAILED", errorCode: null }, rejectedHistory()[1]]],
    ["unproven failure code", [{ outcome: "FAILED", errorCode: "AUTH_FAILED" }, rejectedHistory()[1]]],
    ["external identity", [{ outcome: "FAILED", errorCode: "REMOTE_REJECTED", externalId: "123" }, rejectedHistory()[1]]],
    ["extra history", [...rejectedHistory(), rejectedHistory()[0]]],
  ])("refuses %s in original history", (_label, history) => {
    expect(() => assertDefiniteSourceRejection(original(), history)).toThrow(expect.objectContaining(unsafe));
  });
});

describe("canonical source/payment state fingerprints", () => {
  it("normalizes Date, Decimal and JSON object key order while retaining financial values", () => {
    const left = { total: new Prisma.Decimal("354.38"), paid: new Prisma.Decimal("354.38"), at: new Date("2026-11-04T00:00:00Z"), nested: { vendorId: "v", selection: { taxId: "NO_VAT", taxRate: "0.00" } } };
    const right = { nested: { selection: { taxRate: "0.00", taxId: "NO_VAT" }, vendorId: "v" }, at: "2026-11-04T00:00:00.000Z", paid: "354.38", total: "354.38" };
    expect(correctionStateHash(left)).toBe(correctionStateHash(right));
    expect(correctionStateHash(left)).not.toBe(correctionStateHash({ ...right, paid: "0.00" }));
    expect(correctionStateHash(left)).not.toBe(correctionStateHash({ ...right, nested: { ...right.nested, vendorId: "different" } }));
  });
  it("preserves ordered line/document/payment arrays and distinguishes zero-rate from No VAT", () => {
    expect(correctionStateHash(["a", "b"])).not.toBe(correctionStateHash(["b", "a"]));
    expect(correctionStateHash({ taxId: "ZERO_RATE_ID", taxRate: "0.00" }))
      .not.toBe(correctionStateHash({ taxId: "NO_VAT", taxRate: "0.00" }));
  });
});

function proofFixture() {
  const originalSnapshot = { internalBillId: "saved-bill", sourceVersion: 3, total: "354.38", externalVendorId: "104" };
  const expectedPayloadHash = correctionStateHash({ revised: true });
  const archived = { ...original(), status: "CANCELLED", errorCode: SOURCE_SUPERSEDED, organizationId: "1001",
    idempotencyKey: supersededSourceKey("ZOHO", "saved-bill", "original-operation"),
    snapshot: originalSnapshot, payloadHash: correctionStateHash(originalSnapshot), sourceVersion: 3 };
  const audit = { id: "correction-audit", actorId: "current-admin", companyId: "saved-company", entityId: "saved-bill",
    action: "BILL_SOURCE_CORRECTION_PREPARED", details: { originalJobId: archived.id, newSourceVersion: 5, expectedPayloadHash } };
  const store = { integrationJob: { findUnique: vi.fn(async () => archived) }, auditLog: { findUnique: vi.fn(async () => audit) } };
  const tx = store as unknown as Prisma.TransactionClient;
  const context = { actorId: "current-admin", companyId: "saved-company", billId: "saved-bill", sourceVersion: 5, organizationId: "1001",
    syncRecord: { id: "preserved-sync-record", organizationId: "1001", status: "FAILED", attempts: 5, externalId: null } };
  const proof = sourceSupersessionQueueProof({ tx, actorId: context.actorId, companyId: context.companyId, billId: context.billId,
    sourceVersion: context.sourceVersion, organizationId: context.organizationId, originalJobId: archived.id,
    originalPayloadHash: archived.payloadHash, originalSnapshotHash: correctionStateHash(originalSnapshot),
    expectedPayloadHash, syncRecordHash: correctionStateHash(context.syncRecord), auditId: audit.id });
  return { tx, store, context, proof, archived, audit, expectedPayloadHash };
}

describe("one-use exact-transaction source supersession enqueue authority", () => {
  it("binds the archived immutable payload, preserved sync attempts and audit before consuming once", async () => {
    const f = proofFixture();
    await expect(assertSourceSupersessionQueueProof(f.tx, f.proof, f.context)).resolves.toBeUndefined();
    expect(f.store.integrationJob.findUnique).toHaveBeenCalledWith({ where: { id: f.archived.id } });
    expect(f.store.auditLog.findUnique).toHaveBeenCalledWith({ where: { id: f.audit.id } });
    expect(f.context.syncRecord.attempts).toBe(5);
    expect(() => consumeSourceSupersessionQueueProof(f.proof, f.expectedPayloadHash)).not.toThrow();
    expect(() => consumeSourceSupersessionQueueProof(f.proof, f.expectedPayloadHash)).toThrow(expect.objectContaining(unsafe));
    await expect(assertSourceSupersessionQueueProof(f.tx, f.proof, f.context)).rejects.toMatchObject(unsafe);
  });
  it("refuses fabricated or copied capabilities before database reads", async () => {
    const f = proofFixture();
    for (const forged of [{ kind: "source-supersession" }, { ...f.proof }] as SourceSupersessionQueueProof[])
      await expect(assertSourceSupersessionQueueProof(f.tx, forged, f.context)).rejects.toMatchObject(unsafe);
    expect(f.store.integrationJob.findUnique).not.toHaveBeenCalled();
  });
  it("refuses an otherwise identical different transaction", async () => {
    const f = proofFixture();
    await expect(assertSourceSupersessionQueueProof({ ...f.tx }, f.proof, f.context)).rejects.toMatchObject(unsafe);
    expect(f.store.integrationJob.findUnique).not.toHaveBeenCalled();
  });
  it.each(["actorId", "companyId", "billId", "organizationId"] as const)("refuses changed %s", async key => {
    const f = proofFixture();
    await expect(assertSourceSupersessionQueueProof(f.tx, f.proof, { ...f.context, [key]: "different" })).rejects.toMatchObject(unsafe);
    expect(f.store.integrationJob.findUnique).not.toHaveBeenCalled();
  });
  it("refuses changed version or source payment/sync state", async () => {
    const f = proofFixture();
    await expect(assertSourceSupersessionQueueProof(f.tx, f.proof, { ...f.context, sourceVersion: 6 })).rejects.toMatchObject(unsafe);
    await expect(assertSourceSupersessionQueueProof(f.tx, f.proof, { ...f.context, syncRecord: { ...f.context.syncRecord, attempts: 0 } })).rejects.toMatchObject(unsafe);
  });
  it.each([
    ["target", { target: "CRM" }], ["operation", { operation: "ATTACH_DOCUMENT" }],
    ["canonical key with marker", { idempotencyKey: "ZOHO:saved-bill:CREATE_BILL" }],
    ["another archived key", { idempotencyKey: "ZOHO:saved-bill:CREATE_BILL:SUPERSEDED:another-operation" }],
    ["status", { status: "FAILED" }], ["marker", { errorCode: "REMOTE_REJECTED" }],
    ["bill", { billId: "another-bill" }], ["organization", { organizationId: "1002" }],
    ["uncertain", { needsReconciliation: true }], ["provider identity", { externalId: "999" }],
    ["lease", { leaseToken: "held" }], ["lease expiration", { leaseUntil: new Date(0) }],
    ["payload hash", { payloadHash: "changed" }], ["saved snapshot", { snapshot: { total: "1.00" } }],
  ])("refuses altered archived %s", async (_label, changed) => {
    const f = proofFixture(); Object.assign(f.archived, changed);
    await expect(assertSourceSupersessionQueueProof(f.tx, f.proof, f.context)).rejects.toMatchObject(unsafe);
  });
  it.each([
    ["actor", { actorId: "other" }], ["company", { companyId: "other" }], ["bill", { entityId: "other" }],
    ["action", { action: "UNRELATED_ACTION" }], ["original operation", { details: { originalJobId: "other" } }],
    ["new version", { details: { originalJobId: "original-operation", newSourceVersion: 6 } }],
    ["new payload", { details: { originalJobId: "original-operation", newSourceVersion: 5, expectedPayloadHash: "changed" } }],
  ])("refuses altered audited %s", async (_label, changed) => {
    const f = proofFixture(); Object.assign(f.audit, changed);
    await expect(assertSourceSupersessionQueueProof(f.tx, f.proof, f.context)).rejects.toMatchObject(unsafe);
  });
  it("does not consume a proof for a different canonical payload", async () => {
    const f = proofFixture();
    await expect(assertSourceSupersessionQueueProof(f.tx, f.proof, f.context)).resolves.toBeUndefined();
    expect(() => consumeSourceSupersessionQueueProof(f.proof, "wrong-payload")).toThrow(expect.objectContaining(unsafe));
    expect(() => consumeSourceSupersessionQueueProof(f.proof, f.expectedPayloadHash)).not.toThrow();
  });
});
