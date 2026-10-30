import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/http";
const mocks = vi.hoisted(() => ({ requireUser: vi.fn(), getIncomingSyncStatus: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/services/incoming-sync-status", () => ({ getIncomingSyncStatus: mocks.getIncomingSyncStatus }));
import { GET } from "@/app/api/integrations/incoming-status/route";
const actor = { id: "fictional-reader", role: "MANAGEMENT" };
const status = { generatedAt: "2026-10-29T12:00:00Z", enabled: true, workerAlive: false,
  lastHeartbeatAt: null, pollIntervalSeconds: 30, sources: [] };
const request = (query = "") => new Request(`https://example.invalid/api/integrations/incoming-status${query}`);
beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue(actor);
  mocks.getIncomingSyncStatus.mockResolvedValue(status);
});
describe("incoming synchronization status route", () => {
  it("uses scoped saved status and private noncacheable responses for financial readers", async () => {
    const response = await GET(request("?companyId=company-beta"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual(status);
    expect(mocks.requireUser).toHaveBeenCalledWith(["ADMIN", "ACCOUNTS", "MANAGEMENT"]);
    expect(mocks.getIncomingSyncStatus).toHaveBeenCalledWith(actor, "company-beta");
  });
  it("leaves accessible-source enumeration to the status service when no company is selected", async () => {
    expect((await GET(request())).status).toBe(200);
    expect(mocks.getIncomingSyncStatus).toHaveBeenCalledWith(actor, undefined);
  });
  it.each([401, 403])("rejects unauthorized readers before querying source metadata (%s)", async code => {
    mocks.requireUser.mockRejectedValueOnce(new HttpError(code, "Access denied."));
    expect((await GET(request())).status).toBe(code);
    expect(mocks.getIncomingSyncStatus).not.toHaveBeenCalled();
  });
  it.each(["?companyId=a&companyId=b", "?organizationId=999", "?companyId=", "?companyId=%20", `?companyId=${"a".repeat(101)}`])(
    "rejects ambiguous or unsupported source selection: %s", async query => {
      expect((await GET(request(query))).status).toBe(422);
      expect(mocks.getIncomingSyncStatus).not.toHaveBeenCalled();
    });
  it("preserves a service denial for a company outside the reader's access", async () => {
    mocks.getIncomingSyncStatus.mockRejectedValueOnce(new HttpError(403, "Company access denied."));
    const response = await GET(request("?companyId=other-company"));
    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ error: "Company access denied." });
  });
});
