import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
import { presentProjectHistory } from "@/lib/services/books-project-history-presentation";
import type { BooksProjectHistoryRelation } from "@/lib/services/books-project-history";

const mocks = vi.hoisted(() => ({ bills: vi.fn(), scope: vi.fn(), actor: vi.fn(), history: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { booksBill: { findMany: mocks.bills } } }));
vi.mock("@/lib/company", () => ({ companyFilter: mocks.scope }));
vi.mock("@/lib/services/financial-ledger", () => ({ freshFinancialActor: mocks.actor }));
vi.mock("@/lib/services/books-project-history", () => ({ loadBooksProjectHistory: mocks.history }));
vi.mock("@/lib/services/books-attachments", () => ({ describeBooksAttachments: () => ({ documents: [{ attachmentId: "file-a", status: "AVAILABLE", fileName: "original.pdf" }], attachmentCount: 1, downloadedAttachmentCount: 1, attachmentStatus: "COMPLETE" }) }));
const actor = { id: "admin-a", role: "ADMIN" } as Actor;
const relation: BooksProjectHistoryRelation = { billId: "bill-a", companyId: "company-a", organizationId: "1001", dataCenter: "US", environment: "production",
  booksProjectId: "2001", projectName: "Project", snapshotId: "legacy-a", externalCrmId: "3001", canonicalJobId: null, jobNumber: null,
  displayReference: "VTNX-0572", name: "Legacy deal", customerName: "Customer", currencyCode: "AED", sourceCompanyId: null, verifiedAt: "2026-01-01T00:00:00.000Z" };
const bill = { id: "bill-a", companyId: "company-a", organizationId: "1001", dataCenter: "US", environment: "production", billNumber: "BILL-1", vendorName: "Supplier",
  currencyCode: "AED", total: "123.45", status: "paid", billDate: new Date("2026-01-01"), company: { name: "[CONNECTION CHECK] Company A" },
  detailImportRunId: "revision-a", lastImportRunId: "revision-a", sourceDetail: { line_items: [{ project_id: "2001" }], privateProviderPayload: "must-not-return" },
  attachments: [{ storageKey: "private-key" }] };
beforeEach(() => {
  vi.clearAllMocks(); mocks.actor.mockImplementation(async value => value); mocks.scope.mockResolvedValue({ companyId: { in: ["company-a"] } });
  mocks.bills.mockResolvedValue([bill]); mocks.history.mockResolvedValue({ relations: [relation], warnings: [] });
});

describe("current project history presentation", () => {
  it("returns source bills/original descriptors with allocation unknown and no private payload", async () => {
    const result = await presentProjectHistory(actor, [relation]);
    expect(result.booksBills).toHaveLength(1);
    expect(result.booksBills[0]).toMatchObject({ billNumber: "BILL-1", companyName: "Company A", total: "123.45", allocationKnown: false, jobId: null, attachmentStatus: "COMPLETE" });
    expect(JSON.stringify(result)).not.toContain("privateProviderPayload"); expect(JSON.stringify(result)).not.toContain("private-key");
    expect(mocks.history).toHaveBeenCalledWith(actor);
  });
  it("retains a bill if any authorized project still matches instead of choosing the last candidate", async () => {
    const absent = { ...relation, booksProjectId: "2002" };
    expect((await presentProjectHistory(actor, [relation, absent])).booksBills).toHaveLength(1);
  });
  it("rejects a removed proof even when the legacy snapshot still has another bill", async () => {
    mocks.history.mockResolvedValue({ relations: [{ ...relation, billId: "bill-b", booksProjectId: "2002" }], warnings: [] });
    await expect(presentProjectHistory(actor, [relation])).rejects.toMatchObject({ status: 409 });
  });
  it.each([
    { verifiedAt: "2026-01-02T00:00:00.000Z" }, { snapshotId: "other-snapshot" }, { organizationId: "9999" }, { canonicalJobId: "other-job" },
  ])("rejects a changed exact source/identity/proof: %j", async changed => {
    mocks.history.mockResolvedValue({ relations: [{ ...relation, ...changed }], warnings: [] });
    await expect(presentProjectHistory(actor, [relation])).rejects.toMatchObject({ status: 409 });
  });
  it("omits stale bill detail versions before describing attachments", async () => {
    mocks.bills.mockResolvedValue([{ ...bill, detailImportRunId: "older" }]);
    expect((await presentProjectHistory(actor, [relation])).booksBills).toEqual([]); expect(mocks.history).not.toHaveBeenCalled();
  });
  it("checks exact source scope again when matching a current line", async () => {
    expect((await presentProjectHistory(actor, [{ ...relation, companyId: "company-b" }])).booksBills).toEqual([]);
  });
  it("never gives imported financials to data-entry users", async () => {
    expect((await presentProjectHistory({ ...actor, role: "DATA_ENTRY" }, [relation])).booksBills).toEqual([]); expect(mocks.bills).not.toHaveBeenCalled();
  });
  it("discards the response when company membership changes during the read", async () => {
    mocks.scope.mockResolvedValueOnce({ companyId: { in: ["company-a"] } }).mockResolvedValueOnce({ companyId: { in: [] } });
    expect((await presentProjectHistory(actor, [relation])).booksBills).toEqual([]); expect(mocks.history).not.toHaveBeenCalled();
  });
});
