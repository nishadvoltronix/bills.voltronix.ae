import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
import { getBill } from "@/lib/services/bills";

const store = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  bill: { findUnique: vi.fn() },
  userCompanyMembership: { findMany: vi.fn() },
  auditLog: { findMany: vi.fn() },
  integrationJob: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: store }));

const actor: Actor = { id: "fictional-author", email: "author@example.invalid", name: "Fictional Author", role: "ACCOUNTS" };
const amount = (value: string) => new Prisma.Decimal(value);
const operation = {
  id: "fictional-operation", billId: "fictional-bill", target: "ZOHO", organizationId: "1001",
  operation: "CREATE_BILL", status: "UNKNOWN", needsReconciliation: true, attempts: 1,
  idempotencyKey: "ZOHO:fictional-bill:CREATE_BILL", errorCode: null,
  nextAttemptAt: new Date("2026-10-30T06:00:00Z"), externalId: null, lastError: "The remote outcome is uncertain.",
  snapshot: { privateFinancialPayload: true }, leaseToken: "PRIVATE-WORKER-LEASE", payloadHash: "PRIVATE-PAYLOAD-HASH",
};

beforeEach(() => {
  vi.resetAllMocks();
  store.user.findUnique.mockResolvedValue({ active: true, role: actor.role });
  store.bill.findUnique.mockResolvedValue({
    id: "fictional-bill", companyId: "fictional-company", createdById: actor.id, status: "READY",
    invoiceDate: new Date("2026-10-30T00:00:00Z"), dueDate: null, usesBooksLineTaxes: false,
    subtotal: amount("100"), discount: amount("0"), vatRate: amount("5"), vatAmount: amount("5"),
    total: amount("105"), paidAmount: amount("0"), lines: [], payments: [], syncRecords: [],
  });
  store.userCompanyMembership.findMany.mockResolvedValue([{ companyId: "fictional-company" }]);
  store.auditLog.findMany.mockResolvedValue([]);
  store.integrationJob.findMany.mockImplementation(async ({ where, select }) => {
    if (where.billId !== operation.billId || where.target !== operation.target) return [];
    return [Object.fromEntries(Object.keys(select).filter((key) => select[key]).map((key) => [key, operation[key as keyof typeof operation]]))];
  });
});

describe("bill synchronization recovery visibility", () => {
  it("returns only this bill's safe operation metadata to an authorized reader", async () => {
    const result = await getBill(actor, "fictional-bill");
    expect(result.integrationJobs).toEqual([{
      id: "fictional-operation", organizationId: "1001", operation: "CREATE_BILL", status: "UNKNOWN",
      needsReconciliation: true, attempts: 1, nextAttemptAt: operation.nextAttemptAt, externalId: null,
      lastError: "The remote outcome is uncertain.", isSuperseded: false,
    }]);
    expect(JSON.stringify(result)).not.toMatch(/privateFinancialPayload|PRIVATE-WORKER-LEASE|PRIVATE-PAYLOAD-HASH/);
    expect(store.integrationJob.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { billId: "fictional-bill", target: "ZOHO" },
    }));
  });

  it.each(["key", "marker"] as const)("exposes a safe superseded flag from the internal %s without routing metadata", async (source) => {
    const historical = {
      ...operation,
      status: "CANCELLED",
      needsReconciliation: false,
      idempotencyKey: source === "key"
        ? "ZOHO:fictional-bill:CREATE_BILL:SUPERSEDED:fictional-operation"
        : operation.idempotencyKey,
      errorCode: source === "marker" ? "SOURCE_SUPERSEDED" : null,
    };
    store.integrationJob.findMany.mockImplementationOnce(async ({ select }) => [
      Object.fromEntries(Object.keys(select).filter((key) => select[key]).map((key) => [key, historical[key as keyof typeof historical]])),
    ]);
    const result = await getBill(actor, "fictional-bill");
    expect(result.integrationJobs).toEqual([{
      id: "fictional-operation", organizationId: "1001", operation: "CREATE_BILL", status: "CANCELLED",
      needsReconciliation: false, attempts: 1, nextAttemptAt: operation.nextAttemptAt, externalId: null,
      lastError: operation.lastError, isSuperseded: true,
    }]);
    for (const field of ["billId", "target", "idempotencyKey", "errorCode", "snapshot", "leaseToken", "payloadHash"])
      expect(result.integrationJobs[0]).not.toHaveProperty(field);
  });

  it("checks current company membership before reading operation metadata", async () => {
    store.userCompanyMembership.findMany.mockResolvedValue([]);
    await expect(getBill(actor, "fictional-bill")).rejects.toMatchObject({ status: 404 });
    expect(store.integrationJob.findMany).not.toHaveBeenCalled();
  });

  it.each(["ACCOUNTS", "DATA_ENTRY", "MANAGEMENT"] as const)("does not expose another creator's synchronization details to %s", async role => {
    store.user.findUnique.mockResolvedValue({ active: true, role });
    await expect(getBill({ ...actor, id: "another-creator", role }, "fictional-bill"))
      .rejects.toMatchObject({ status: 404 });
    expect(store.integrationJob.findMany).not.toHaveBeenCalled();
  });
  it("does not release bill or operation metadata after the actor role changes during the read", async () => {
    store.integrationJob.findMany.mockImplementationOnce(async () => {
      store.user.findUnique.mockResolvedValue({ active: true, role: "MANAGEMENT" });
      return [];
    });
    await expect(getBill(actor, "fictional-bill")).rejects.toMatchObject({ status: 403 });
  });
  it("does not release bill or operation metadata after membership revocation during the read", async () => {
    store.integrationJob.findMany.mockImplementationOnce(async () => {
      store.userCompanyMembership.findMany.mockResolvedValue([]);
      return [];
    });
    await expect(getBill(actor, "fictional-bill")).rejects.toMatchObject({ status: 404 });
  });
});
