import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/http";
import { GET } from "@/app/api/vendors/directory/route";

const mocks = vi.hoisted(() => ({ requireUser: vi.fn(), listCompanyVendorDirectory: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/services/bill-vendor-lookup", () => ({ listCompanyVendorDirectory: mocks.listCompanyVendorDirectory }));
const actor = { id: "manager", role: "MANAGEMENT" };
const result = { companyId: "company-a", organizationId: "1001", dataCenter: "US", environment: "production", source: "books", vendors: [], page: 2, perPage: 100, hasMore: false, warning: null };
const request = (query: string) => new Request(`http://127.0.0.1:3000/api/vendors/directory?${query}`);
beforeEach(() => {
  vi.resetAllMocks(); mocks.requireUser.mockResolvedValue(actor); mocks.listCompanyVendorDirectory.mockResolvedValue(result);
});
describe("vendor directory GET route", () => {
  it("allows current directory roles and sends only company/search/page to the service", async () => {
    const response = await GET(request(new URLSearchParams({ companyId: "company-a", q: "A&B 5%_", page: "2" }).toString()));
    expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.requireUser).toHaveBeenCalledWith(["ADMIN", "ACCOUNTS", "DATA_ENTRY", "MANAGEMENT"]);
    expect(mocks.listCompanyVendorDirectory).toHaveBeenCalledWith(actor, { companyId: "company-a", q: "A&B 5%_", page: 2 });
    expect(await response.json()).toEqual(result);
  });

  it("defaults only the page and search phrase", async () => {
    await GET(request("companyId=company-a"));
    expect(mocks.listCompanyVendorDirectory).toHaveBeenCalledWith(actor, { companyId: "company-a", q: "", page: 1 });
  });

  it.each(["companyId=a&companyId=b", "companyId=a&q=x&q=y", "companyId=a&page=1&page=2", "companyId=a&organizationId=1002", "companyId=a&dataCenter=EU", "companyId=a&perPage=200",
    "companyId=a&page=0", "companyId=a&page=-1", "companyId=a&page=1.5", "companyId=a&page=1e2", "companyId=a&page=", "companyId=a&page=01", "companyId=a&page=100000"])("rejects overriding, repeated or ambiguous input: %s", async query => {
    const response = await GET(request(query));
    expect(response.status).toBe(422); expect(mocks.listCompanyVendorDirectory).not.toHaveBeenCalled();
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("rejects expired sessions before a directory read", async () => {
    mocks.requireUser.mockRejectedValue(new HttpError(401, "Please sign in."));
    expect((await GET(request("companyId=company-a"))).status).toBe(401);
    expect(mocks.listCompanyVendorDirectory).not.toHaveBeenCalled();
  });

  it.each([403, 409])( "preserves current access and connection conflicts (%s)", async status => {
    mocks.listCompanyVendorDirectory.mockRejectedValue(new HttpError(status, "Reload the supplier directory."));
    const response = await GET(request("companyId=company-a"));
    expect(response.status).toBe(status); expect(await response.json()).toEqual({ error: "Reload the supplier directory." });
  });
});
