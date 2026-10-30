import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/http";
const mocks = vi.hoisted(() => ({ requireUser: vi.fn(), getBillBooksOptions: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/services/bill-books-options", () => ({ getBillBooksOptions: mocks.getBillBooksOptions }));
import { GET } from "@/app/api/bills/options/route";
const actor = { id: "fictional-entry", role: "DATA_ENTRY" };
beforeEach(() => {
  vi.resetAllMocks(); mocks.requireUser.mockResolvedValue(actor);
  mocks.getBillBooksOptions.mockResolvedValue({ companyId: "company-a", organizationId: null, dataCenter: null, environment: null, accounts: [], taxes: [], customers: [], warning: "Unavailable", hasMoreCustomers: false });
});
describe("bill Books options route", () => {
  it("enforces writer authentication and keeps successful responses private", async () => {
    const query = new URLSearchParams({ companyId: "company-a", customerQuery: "A&B %_", customerId: "501" });
    const result = await GET(new Request(`https://example.invalid/api/bills/options?${query}`));
    expect(result.status).toBe(200); expect(result.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.requireUser).toHaveBeenCalledWith(["ADMIN", "ACCOUNTS", "DATA_ENTRY"]);
    expect(mocks.getBillBooksOptions).toHaveBeenCalledWith(actor, { companyId: "company-a", customerQuery: "A&B %_", customerId: "501" });
  });
  it.each(["companyId=a&companyId=b", "companyId=a&organizationId=1002", "companyId=a&customerQuery=a&customerQuery=b", "companyId=a&customerId=1&customerId=2"])("rejects duplicate/overriding parameters: %s", async query => {
    expect((await GET(new Request(`https://example.invalid/api/bills/options?${query}`))).status).toBe(422);
    expect(mocks.getBillBooksOptions).not.toHaveBeenCalled();
  });
  it("rejects anonymous requests before reading metadata", async () => {
    mocks.requireUser.mockRejectedValueOnce(new HttpError(401, "Please sign in."));
    expect((await GET(new Request("https://example.invalid/api/bills/options?companyId=a"))).status).toBe(401);
    expect(mocks.getBillBooksOptions).not.toHaveBeenCalled();
  });
});
