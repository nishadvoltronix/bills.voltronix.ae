import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/http";
import { SESSION_REQUIRED_CODE } from "@/lib/session-recovery";

const mocks = vi.hoisted(() => ({ requireUser: vi.fn(), getPaymentAccounts: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/services/payment-books-sync", () => ({ getPaymentAccounts: mocks.getPaymentAccounts }));
import { GET } from "@/app/api/companies/[id]/payment-accounts/route";

const actor = { id: "fictional-accounts-user", role: "ACCOUNTS" };
const result = { companyId: "fictional-company", accounts: [{ id: "fictional-bank", name: "Fictional bank", type: "bank", currency: "AED" }], warning: null };
const request = () => new Request("https://example.invalid/api/companies/fictional-company/payment-accounts?companyId=foreign&organizationId=another-org");
const context = () => ({ params: Promise.resolve({ id: "fictional-company" }) });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue(actor);
  mocks.getPaymentAccounts.mockResolvedValue(result);
});

describe("payment account route", () => {
  it("passes the authenticated actor and exact route company to the service, ignoring query scope overrides", async () => {
    const response = await GET(request(), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual(result);
    expect(mocks.requireUser).toHaveBeenCalledExactlyOnceWith(["ADMIN", "ACCOUNTS"]);
    expect(mocks.getPaymentAccounts).toHaveBeenCalledExactlyOnceWith(actor, "fictional-company");
  });
  it("rejects an expired session before metadata reads and preserves its recovery marker", async () => {
    mocks.requireUser.mockRejectedValueOnce(new HttpError(401, "Please sign in to continue.", SESSION_REQUIRED_CODE));
    const response = await GET(request(), context());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Please sign in to continue.", code: SESSION_REQUIRED_CODE });
    expect(mocks.getPaymentAccounts).not.toHaveBeenCalled();
  });
  it.each([403, 404])("preserves scoped service refusal %i without returning an account directory", async status => {
    mocks.getPaymentAccounts.mockRejectedValueOnce(new HttpError(status, "Payment accounts are unavailable."));
    const response = await GET(request(), context());
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: "Payment accounts are unavailable." });
    expect(mocks.getPaymentAccounts).toHaveBeenCalledExactlyOnceWith(actor, "fictional-company");
  });
});
