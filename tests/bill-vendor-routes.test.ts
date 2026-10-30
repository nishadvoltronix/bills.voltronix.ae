import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/http";
import { IntegrationError } from "@/lib/integrations/config";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  searchBillVendors: vi.fn(),
  resolveBillVendor: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/services/bill-vendor-lookup", () => ({
  searchBillVendors: mocks.searchBillVendors,
  resolveBillVendor: mocks.resolveBillVendor,
}));

import { GET } from "@/app/api/vendors/search/route";
import { POST } from "@/app/api/vendors/resolve/route";

const origin = "https://billing.example.invalid";
const actor = { id: "fictional-writer", role: "DATA_ENTRY" };
const vendor = {
  id: "local-vendor-a", companyId: "company-a", name: "Fictional Supplier", currency: "AED",
};
const selection = {
  companyId: "company-a", organizationId: "100", externalVendorId: "101",
  dataCenter: "US", environment: "production",
};
function post(body = JSON.stringify(selection), headers: Record<string, string> = {}) {
  return POST(new Request(`${origin}/api/vendors/resolve`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json", ...headers }, body,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("APP_URL", origin);
  mocks.requireUser.mockResolvedValue(actor);
  mocks.searchBillVendors.mockResolvedValue({
    companyId: "company-a", organizationId: "100", vendors: [], selectedVendor: null,
    warning: null, hasMore: false,
  });
  mocks.resolveBillVendor.mockResolvedValue(vendor);
});
afterEach(() => vi.unstubAllEnvs());

describe("vendor autocomplete HTTP boundaries", () => {
  it("keeps company, literal search and exact-ID hydration distinct and responses private", async () => {
    const query = new URLSearchParams({ companyId: "company-a", q: "A&B 5%_", vendorId: "local-vendor-a" });
    const response = await GET(new Request(`${origin}/api/vendors/search?${query}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.requireUser).toHaveBeenCalledWith(["ADMIN", "ACCOUNTS", "DATA_ENTRY"]);
    expect(mocks.searchBillVendors).toHaveBeenCalledWith(actor, {
      companyId: "company-a", q: "A&B 5%_", vendorId: "local-vendor-a",
    });
  });

  it.each(["companyId=company-a&companyId=company-b", "companyId=company-a&organizationId=200", "companyId=company-a&q=a&q=b"])(
    "rejects ambiguous or overriding query parameters: %s", async (query) => {
      const response = await GET(new Request(`${origin}/api/vendors/search?${query}`));
      expect(response.status).toBe(422);
      expect(mocks.searchBillVendors).not.toHaveBeenCalled();
    },
  );

  it("rejects an anonymous search before reading vendors", async () => {
    mocks.requireUser.mockRejectedValue(new HttpError(401, "Please sign in."));
    expect((await GET(new Request(`${origin}/api/vendors/search?companyId=company-a`))).status).toBe(401);
    expect(mocks.searchBillVendors).not.toHaveBeenCalled();
  });

  it("preserves company-access rejection from the server", async () => {
    mocks.searchBillVendors.mockRejectedValue(new HttpError(404, "Company or record not found."));
    expect((await GET(new Request(`${origin}/api/vendors/search?companyId=company-b`))).status).toBe(404);
  });

  it("exposes a retryable provider failure without a success envelope", async () => {
    mocks.searchBillVendors.mockRejectedValue(new IntegrationError("RATE_LIMITED", "Please retry later.", "RETRY"));
    const response = await GET(new Request(`${origin}/api/vendors/search?companyId=company-a`));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Please retry later.", code: "RATE_LIMITED" });
  });

  it("resolves only an authenticated same-origin selection and returns the local ID", async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.requireUser).toHaveBeenCalledWith(["ADMIN", "ACCOUNTS", "DATA_ENTRY"]);
    expect(mocks.resolveBillVendor).toHaveBeenCalledWith(actor, selection);
    expect(await response.json()).toEqual({ vendor });
  });

  it.each<Record<string, string>>([
    { Origin: "https://untrusted.invalid" },
    { "Sec-Fetch-Site": "cross-site" },
  ])("rejects cross-origin selection before changing vendor records", async (headers) => {
    expect((await post(undefined, headers)).status).toBe(403);
    expect(mocks.resolveBillVendor).not.toHaveBeenCalled();
  });

  it("rejects expired selection sessions", async () => {
    mocks.requireUser.mockRejectedValue(new HttpError(401, "Please sign in."));
    expect((await post()).status).toBe(401);
    expect(mocks.resolveBillVendor).not.toHaveBeenCalled();
  });

  it("rejects malformed, non-JSON and oversized selection bodies", async () => {
    expect((await post("{")).status).toBe(400);
    expect((await post(undefined, { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await post(" ".repeat(4097))).status).toBe(413);
    expect(mocks.resolveBillVendor).not.toHaveBeenCalled();
  });

  it("returns destination conflicts without presenting a selected vendor", async () => {
    mocks.resolveBillVendor.mockRejectedValue(new IntegrationError("DESTINATION_CHANGED", "Choose the supplier again.", "BLOCKED"));
    const response = await post();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Choose the supplier again.", code: "DESTINATION_CHANGED" });
  });
});
