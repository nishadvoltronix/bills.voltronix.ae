import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
import { assertBooksBillOwner, assertBooksOwnerScopeCurrent, ownedBooksBillIds } from "@/lib/services/bill-ownership";
import { billScope, canViewBill } from "@/lib/permissions";

const mocks = vi.hoisted(() => ({ user: vi.fn(), bill: vi.fn(), books: vi.fn(), destination: vi.fn(), history: vi.fn(), scope: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { user: { findUnique: mocks.user }, bill: { findMany: mocks.bill }, booksBill: { findMany: mocks.books },
  companyIntegrationDestination: { findMany: mocks.destination }, integrationJob: { findMany: mocks.history } } }));
vi.mock("@/lib/company", () => ({ companyFilter: mocks.scope }));
const actor = { id: "entrant-a", role: "ACCOUNTS" } as Actor;
const native = { id: "native-a", companyId: "company", jobId: "shared-job", createdById: actor.id,
  syncRecords: [{ target: "ZOHO", organizationId: "1001", externalId: "2001" }] };
const mirror = { id: "mirror-a", companyId: "company", organizationId: "1001", externalBillId: "2001", dataCenter: "US", environment: "production" };
const destination = { companyId: "company", organizationId: "1001", dataCenter: "US", environment: "production" };
beforeEach(() => {
  vi.clearAllMocks(); mocks.user.mockResolvedValue({ active: true, role: "ACCOUNTS" }); mocks.scope.mockResolvedValue({ companyId: "company" });
  mocks.bill.mockResolvedValue([native]); mocks.books.mockResolvedValue([mirror]); mocks.destination.mockResolvedValue([destination]); mocks.history.mockResolvedValue([]);
});

describe("bill ownership policy and exact imported-owner proof", () => {
  it.each(["ACCOUNTS", "DATA_ENTRY", "MANAGEMENT"] as const)("narrows every %s bill query and direct record to its original creator", role => {
    const reader = { ...actor, role };
    expect(billScope(reader)).toEqual({ createdById: actor.id });
    expect(canViewBill(reader, { createdById: actor.id })).toBe(true);
    expect(canViewBill(reader, { createdById: "another" })).toBe(false);
  });
  it("keeps Admin access to all creators within the caller's independent company scope", async () => {
    mocks.user.mockResolvedValue({ active: true, role: "ADMIN" });
    expect(billScope({ ...actor, role: "ADMIN" })).toEqual({});
    expect(canViewBill({ ...actor, role: "ADMIN" }, { createdById: "another" })).toBe(true);
    expect(await ownedBooksBillIds({ ...actor, role: "ADMIN" })).toBeNull(); expect(mocks.bill).not.toHaveBeenCalled();
  });
  it("allows an exact unique native owner without exposing importer or job ownership as proof", async () => {
    expect(await ownedBooksBillIds(actor)).toEqual([mirror.id]);
    expect(mocks.bill.mock.calls[0][0]).toMatchObject({ where: { companyId: "company", createdById: actor.id } });
    expect(mocks.bill.mock.calls[1][0].where.AND[1]).not.toHaveProperty("createdById");
    await expect(assertBooksBillOwner(actor, "unowned-import")).rejects.toMatchObject({ status: 404 });
  });
  it("never chooses an owner when two native bills share both a job and provider identity", async () => {
    mocks.bill.mockResolvedValueOnce([native]).mockResolvedValueOnce([native, { ...native, id: "native-b", createdById: "entrant-b" }]);
    expect(await ownedBooksBillIds(actor)).toEqual([]);
  });
  it.each([{ companyId: "other" }, { organizationId: "other" }, { dataCenter: "EU" }, { environment: "sandbox" }, { externalBillId: "other" }])(
    "conceals imports with a mismatched exact source context: %j", changed => {
      mocks.books.mockResolvedValue([{ ...mirror, ...changed }]);
      return expect(ownedBooksBillIds(actor)).resolves.toEqual([]);
    });
  it("withholds context-ambiguous imports even when only one mirror was requested", async () => {
    mocks.destination.mockResolvedValue([destination, { ...destination, environment: "sandbox" }]);
    expect(await ownedBooksBillIds(actor)).toEqual([]);
  });
  it("fails closed on excessive candidate counts instead of trusting a partial owner inventory", async () => {
    mocks.bill.mockResolvedValue(Array.from({ length: 10001 }, () => native));
    await expect(ownedBooksBillIds(actor)).rejects.toMatchObject({ status: 422 }); expect(mocks.books).not.toHaveBeenCalled();
  });
  it("rechecks role and memberships after resolving ownership", async () => {
    mocks.user.mockResolvedValueOnce({ active: true, role: "ACCOUNTS" }).mockResolvedValueOnce({ active: true, role: "MANAGEMENT" });
    await expect(ownedBooksBillIds(actor)).rejects.toMatchObject({ status: 403 });
    mocks.user.mockResolvedValue({ active: true, role: "ACCOUNTS" }); mocks.scope.mockResolvedValueOnce({ companyId: "company" }).mockResolvedValueOnce({ companyId: { in: [] } });
    await expect(ownedBooksBillIds(actor)).rejects.toMatchObject({ status: 403 });
  });
  it("rejects captured imported rows and metadata if a competing native mapping invalidates ownership during the read", async () => {
    const captured = await ownedBooksBillIds(actor);
    mocks.bill.mockResolvedValueOnce([native]).mockResolvedValueOnce([native, { ...native, id: "competing-native", createdById: "another" }]);
    await expect(assertBooksOwnerScopeCurrent(actor, captured)).rejects.toMatchObject({ status: 409 });
  });
});
