import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/http";
import { IntegrationError } from "@/lib/integrations/config";
import { GET } from "@/app/api/jobs/search/route";
import { POST } from "@/app/api/jobs/resolve/route";

const mocks = vi.hoisted(() => ({ requireUser: vi.fn(), searchCrmJobs: vi.fn(), resolveCrmJob: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/services/crm-job-lookup", () => ({ searchCrmJobs: mocks.searchCrmJobs, resolveCrmJob: mocks.resolveCrmJob }));
const actor = { id: "writer", role: "ACCOUNTS" };
const origin = "http://127.0.0.1:3000";
const selection = { companyId: "company-a", externalCrmId: "5001", sourceId: "a".repeat(64), crmOrganizationId: "9001", dataCenter: "US", environment: "production", booksOrganizationId: "1001" };
const post = (body = JSON.stringify(selection), headers: Record<string, string> = {}) => POST(new Request(`${origin}/api/jobs/resolve`, { method: "POST", body, headers: { Origin: origin, "Content-Type": "application/json", ...headers } }));
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("APP_URL", origin);
  mocks.requireUser.mockResolvedValue(actor);
  mocks.searchCrmJobs.mockResolvedValue({ companyId: "company-a", jobs: [], warning: null, hasMore: false });
  mocks.resolveCrmJob.mockResolvedValue({ job: { id: "local-job", companyId: "company-a", externalCrmId: "5001" }, stage: "Closed Won" });
});
afterEach(() => vi.unstubAllEnvs());
describe("CRM job routes", () => {
  it("requires a bill-entry role, preserves escaped queries and marks results private", async () => {
    const response = await GET(new Request(`${origin}/api/jobs/search?${new URLSearchParams({ companyId: "company-a", q: "JOB&_(5%)" })}`));
    expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.requireUser).toHaveBeenCalledWith(["ADMIN", "ACCOUNTS", "DATA_ENTRY"]);
    expect(mocks.searchCrmJobs).toHaveBeenCalledWith(actor, { companyId: "company-a", q: "JOB&_(5%)" });
  });

  it("omits company scope only when the caller did not supply it", async () => {
    mocks.searchCrmJobs.mockResolvedValueOnce({ companyId: null, jobs: [], warning: null, hasMore: false });
    const response = await GET(new Request(`${origin}/api/jobs/search?q=JOB-5384`));
    expect(mocks.searchCrmJobs).toHaveBeenLastCalledWith(actor, { q: "JOB-5384" });
    expect(await response.json()).toEqual({ companyId: null, jobs: [], warning: null, hasMore: false });
    await GET(new Request(`${origin}/api/jobs/search?q=JOB-5384&companyId=`));
    expect(mocks.searchCrmJobs).toHaveBeenLastCalledWith(actor, { companyId: "", q: "JOB-5384" });
  });

  it.each(["companyId=a&companyId=b&q=JOB", "companyId=a&q=JOB&q=OTHER", "companyId=a&q=JOB&crmOrganizationId=9002", "companyId=a&q=JOB&booksOrganizationId=1002", "companyId=a&q=JOB&sourceId=x"])("rejects ambiguous or overriding query parameters: %s", async query => {
    expect((await GET(new Request(`${origin}/api/jobs/search?${query}`))).status).toBe(422);
    expect(mocks.searchCrmJobs).not.toHaveBeenCalled();
  });

  it("rejects expired sessions before source reads or local imports", async () => {
    mocks.requireUser.mockRejectedValue(new HttpError(401, "Please sign in."));
    expect((await GET(new Request(`${origin}/api/jobs/search?companyId=a&q=JOB`))).status).toBe(401);
    expect((await post()).status).toBe(401);
    expect(mocks.searchCrmJobs).not.toHaveBeenCalled(); expect(mocks.resolveCrmJob).not.toHaveBeenCalled();
  });

  it("resolves only an authenticated same-origin selection and returns the saved job", async () => {
    const response = await post();
    expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.requireUser).toHaveBeenCalledWith(["ADMIN", "ACCOUNTS", "DATA_ENTRY"]);
    expect(mocks.resolveCrmJob).toHaveBeenCalledWith(actor, selection);
    expect(await response.json()).toEqual({ job: { id: "local-job", companyId: "company-a", externalCrmId: "5001" }, stage: "Closed Won" });
  });

  it.each<Record<string, string>>([{ Origin: "https://foreign.invalid" }, { "Sec-Fetch-Site": "cross-site" }])("rejects cross-origin imports", async headers => {
    expect((await post(undefined, headers)).status).toBe(403); expect(mocks.resolveCrmJob).not.toHaveBeenCalled();
  });

  it("rejects malformed, non-JSON and oversized selection bodies before importing", async () => {
    expect((await post("{")).status).toBe(400);
    expect((await post(undefined, { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await post(" ".repeat(4097))).status).toBe(413);
    expect(mocks.resolveCrmJob).not.toHaveBeenCalled();
  });

  it.each([403, 409])( "preserves access/selection conflicts (%s)", async status => {
    mocks.resolveCrmJob.mockRejectedValue(new HttpError(status, "Search for the job again."));
    expect((await post()).status).toBe(status);
  });

  it("returns a fixed provider verification failure without a saved-job envelope", async () => {
    mocks.resolveCrmJob.mockRejectedValue(new IntegrationError("CRM_JOB_LOOKUP_INVALID", "CRM did not confirm the selected job.", "BLOCKED"));
    const response = await post();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "CRM did not confirm the selected job.", code: "CRM_JOB_LOOKUP_INVALID" });
  });
});
