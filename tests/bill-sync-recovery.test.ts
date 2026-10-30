import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
import { getBill } from "@/lib/services/bills";

const store = vi.hoisted(() => ({
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
  nextAttemptAt: new Date("2026-10-30T06:00:00Z"), externalId: null, lastError: "The remote outcome is uncertain.",
  snapshot: { privateFinancialPayload: true }, leaseToken: "PRIVATE-WORKER-LEASE", payloadHash: "PRIVATE-PAYLOAD-HASH",
};

beforeEach(() => {
  vi.resetAllMocks();
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
      lastError: "The remote outcome is uncertain.",
    }]);
    expect(JSON.stringify(result)).not.toMatch(/privateFinancialPayload|PRIVATE-WORKER-LEASE|PRIVATE-PAYLOAD-HASH/);
    expect(store.integrationJob.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { billId: "fictional-bill", target: "ZOHO" },
    }));
  });

  it("checks current company membership before reading operation metadata", async () => {
    store.userCompanyMembership.findMany.mockResolvedValue([]);
    await expect(getBill(actor, "fictional-bill")).rejects.toMatchObject({ status: 404 });
    expect(store.integrationJob.findMany).not.toHaveBeenCalled();
  });

  it("does not expose another creator's synchronization details to Data Entry", async () => {
    await expect(getBill({ ...actor, id: "another-creator", role: "DATA_ENTRY" }, "fictional-bill"))
      .rejects.toMatchObject({ status: 404 });
    expect(store.integrationJob.findMany).not.toHaveBeenCalled();
  });
});
