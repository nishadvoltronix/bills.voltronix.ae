import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BooksProjectAssociation, Prisma } from "@prisma/client";
import type { Actor } from "@/lib/auth";
import type { ZohoConfig } from "@/lib/integrations/config";
import { assertProjectHistoryLease, collectProjectHistoryProof, createProjectHistoryReader, processBooksProjectHistoryRefresh } from "@/lib/services/books-project-history-refresh";

const mocks = vi.hoisted(() => ({ enabled: true, sources: vi.fn(), assertSource: vi.fn(), delay: vi.fn(), imported: vi.fn(),
  rows: vi.fn(), update: vi.fn(), leasedRow: vi.fn(), state: vi.fn(), stateUpdate: vi.fn(), binding: vi.fn(), transaction: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { booksProjectAssociation: { findMany: mocks.rows, findUnique: mocks.leasedRow, updateMany: mocks.update },
  incomingSyncState: { findUnique: mocks.state, updateMany: mocks.stateUpdate }, companyCrmSource: { findUnique: mocks.binding }, $transaction: mocks.transaction } }));
vi.mock("node:timers/promises", () => ({ setTimeout: async () => undefined }));
vi.mock("@/lib/services/incoming-sync-access", () => ({ incomingSources: mocks.sources, assertIncomingSource: mocks.assertSource }));
vi.mock("@/lib/services/incoming-sync-config", () => ({ incomingSyncSettings: () => ({ enabled: mocks.enabled }) }));
vi.mock("@/lib/services/incoming-sync", () => ({ incomingConfiguredDelay: mocks.delay }));
vi.mock("@/lib/services/books-project-history", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/services/books-project-history")>(), importBooksProjectAssociation: mocks.imported }));
vi.mock("@/lib/integrations/oauth", () => ({ accessToken: vi.fn(async () => "private-test-token") }));

const ref = { id: "association-a", companyId: "company-a", organizationId: "1001", dataCenter: "US", environment: "production", booksProjectId: "2001",
  zprojectsProjectId: "3001", portalId: "4001", crmOrganizationId: "5001", crmDataCenter: "US", crmEnvironment: "production" };
const row = { ...ref, sourceHash: "a".repeat(64), verifiedAt: new Date("2026-01-01T00:00:00Z"), failures: 0, status: "VERIFIED" } as BooksProjectAssociation;
const actor = { id: "admin-a", role: "ADMIN" } as Actor;
const books = { target: "ZOHO", companyId: "company-a", organizationId: "1001", dataCenter: "US", environment: "production", scopeHash: "books-hash", organizationName: "A" } as const;
const crm = { target: "CRM", companyId: null, organizationId: "5001", dataCenter: "US", environment: "production", scopeHash: "crm-hash", organizationName: "A" } as const;
const config = { target: "ZOHO", organizationId: "1001", environment: "production", dataCenter: "US", apiOrigin: "https://www.zohoapis.com", networkEnabled: true, writeEnabled: true, testMode: false } as unknown as ZohoConfig;
const crmConfig = { ...config, target: "CRM", organizationId: "5001", crmMapping: { jobModule: "Deals" } } as ZohoConfig;
const project = { project_id: "2001", zprojects_project_id: "3001", project_name: "Legacy project", other_service_app_source: 1 };
const page = (number: number, ids: string[], more: boolean | string) => ({ deals: ids.map(id => ({ id })), info: { page: number, per_page: 200, has_next_page: more } });
function proofReader(overrides: { project?: unknown; pages?: unknown[]; crmRecords?: unknown[]; portal?: string; booksOrg?: string } = {}) {
  const pages = [...overrides.pages ?? [page(1, ["6001"], "false")]];
  const get = vi.fn(async (kind: string, path: string) => {
    if (path.startsWith("/books/v3/organizations")) return { code: 0, organization: { organization_id: overrides.booksOrg ?? "1001" } };
    if (path === "/crm/v8/org") return { org: [{ zgid: "5001", type: "production" }] };
    if (path.startsWith("/books/v3/projects")) return { code: 0, project: overrides.project ?? project };
    if (path.endsWith("/portals")) return { portals: [{ id: overrides.portal ?? "4001", environment: "production" }] };
    if (kind === "PROJECTS") return pages.shift();
    return { data: overrides.crmRecords ?? [{ id: "6001", DealNumber: "VTNX-0572", Modified_Time: "2026-01-01T00:00:00+00:00" }], info: { more_records: false } };
  });
  return { get, allowProject: vi.fn() };
}
function transport(response: Response = new Response(JSON.stringify({ code: 0, project })), override: Partial<ZohoConfig> = {}, pacing?: { lastRequest: number }) {
  let now = 100_000;
  const calls: Array<{ url: URL; init?: RequestInit; at: number }> = [];
  const guard = vi.fn(async () => undefined), cooldown = vi.fn(async () => undefined);
  const reader = createProjectHistoryReader({ reference: ref, books: { ...config, ...override }, crm: crmConfig, guard, cooldown, pacing,
    token: async () => "private-test-token", now: () => now, sleep: async ms => { now += ms; },
    fetcher: async (url, init) => { calls.push({ url: new URL(url), init, at: now }); return response.clone(); } });
  return { reader, calls, guard, cooldown };
}
beforeEach(async () => {
  vi.clearAllMocks(); mocks.enabled = true; mocks.delay.mockReturnValue(null); mocks.sources.mockResolvedValue([books, crm]);
  mocks.assertSource.mockImplementation(async (_actor, source) => source.target === "ZOHO" ? config : crmConfig);
  mocks.rows.mockResolvedValue([row]); mocks.update.mockResolvedValue({ count: 1 });
  mocks.leasedRow.mockResolvedValue({ backoffUntil: null }); mocks.stateUpdate.mockResolvedValue({ count: 1 });
  mocks.binding.mockResolvedValue({ organizationId: "5001", dataCenter: "US", environment: "production" });
  mocks.state.mockImplementation(async ({ where }) => ({ scopeHash: where.target_organizationId_dataCenter_environment.target === "ZOHO" ? "books-hash" : "crm-hash", status: "IDLE", backoffUntil: null }));
  const { db } = await import("@/lib/db"); mocks.transaction.mockImplementation(callback => callback(db));
});
afterEach(() => vi.unstubAllGlobals());

describe("project history GET transport", () => {
  it("scopes Books reads, uses official Projects Bearer auth, and paces every read", async () => {
    const run = transport();
    await run.reader.get("BOOKS", "/books/v3/projects/2001");
    await run.reader.get("PROJECTS", "/api/v3/portal/4001/projects/3001/crm/deals", { page: "1", per_page: "200" });
    expect(run.calls[0].url.searchParams.get("organization_id")).toBe("1001");
    expect(run.calls[1].url.origin).toBe("https://projects.zoho.com");
    expect(run.calls[1].init).toMatchObject({ method: "GET", redirect: "error", headers: { Authorization: "Bearer private-test-token" } });
    expect(run.calls[1].at - run.calls[0].at).toBe(1100);
    expect(run.guard).toHaveBeenCalledTimes(4);
  });
  it.each([
    ["BOOKS", "/books/v3/projects/9999", {}], ["BOOKS", "/books/v3/bills", {}],
    ["PROJECTS", "/api/v3/portal/9999/projects/3001/crm/deals", {}],
    ["PROJECTS", "/api/v3/portal/4001/projects/9999/crm/deals", {}],
    ["BOOKS", "/books/v3/projects/2001", { organization_id: "9999" }],
    ["CRM", "/crm/v8/Deals", { ids: "../Secrets" }],
  ] as const)("rejects endpoint/source overrides %s %s", async (kind, path, query) => {
    const run = transport(); await expect(run.reader.get(kind, path, query)).rejects.toMatchObject({ code: "BOOKS_HISTORY_ENDPOINT_REJECTED" }); expect(run.calls).toHaveLength(0);
  });
  it("rejects unsupported regions and disabled network without OAuth or provider calls", async () => {
    const region = transport(undefined, { dataCenter: "EU" });
    await expect(region.reader.get("BOOKS", "/books/v3/projects/2001")).rejects.toMatchObject({ code: "BOOKS_HISTORY_REGION_UNSUPPORTED" });
    const disabled = transport(undefined, { networkEnabled: false });
    await expect(disabled.reader.get("BOOKS", "/books/v3/projects/2001")).rejects.toThrow(); expect(disabled.calls).toHaveLength(0);
  });
  it("persists quota backoff before surfacing a rate limit", async () => {
    const run = transport(new Response(JSON.stringify({ code: "TOO_MANY_REQUESTS" }), { status: 429, headers: { "retry-after": "3600" } }));
    await expect(run.reader.get("PROJECTS", "/api/v3.1/portals")).rejects.toMatchObject({ code: "INCOMING_RATE_LIMIT" });
    expect(run.cooldown).toHaveBeenCalledWith("PROJECTS", new Date(3_700_000));
  });
  it("keeps CRM endpoint quota errors assigned to the CRM source", async () => {
    const run = transport(new Response("{}", { status: 429, headers: { "retry-after": "3600" } }));
    await expect(run.reader.get("CRM", "/crm/v8/org")).rejects.toMatchObject({ code: "INCOMING_RATE_LIMIT" });
    expect(run.cooldown).toHaveBeenCalledWith("CRM", new Date(3_700_000));
  });
  it.each(["100", "0", "-8"])("preserves Books quota backoff for a successful response with %s requests remaining", async (remaining) => {
    const run = transport(new Response(JSON.stringify({ code: 0, project }), { headers: { "x-rate-limit-remaining": remaining, "x-rate-limit-reset": "3600" } }));
    await run.reader.get("BOOKS", "/books/v3/projects/2001"); expect(run.cooldown).toHaveBeenCalledWith("BOOKS", new Date(3_820_000));
  });
  it("caps a pass without issuing an extra provider read", async () => {
    const run = transport(); for (let i = 0; i < 12; i++) await run.reader.get("BOOKS", "/books/v3/projects/2001");
    await expect(run.reader.get("BOOKS", "/books/v3/projects/2001")).rejects.toMatchObject({ code: "BOOKS_HISTORY_READ_BUDGET" }); expect(run.calls).toHaveLength(12);
  });
  it("keeps pacing across two different association refreshes in the same pass", async () => {
    const pacing = { lastRequest: -Infinity };
    const first = transport(undefined, {}, pacing), second = transport(undefined, {}, pacing);
    await first.reader.get("BOOKS", "/books/v3/projects/2001"); await second.reader.get("BOOKS", "/books/v3/projects/2001");
    expect(second.calls[0].at - first.calls[0].at).toBe(1100);
  });
});
describe("complete project evidence", () => {
  it("retains exact source objects and legacy references, independently of job numbers", async () => {
    const reader = proofReader(); const proof = await collectProjectHistoryProof(ref, reader, new Date("2026-01-02T00:00:00Z"));
    expect(proof.sourceProject).toEqual(project); expect(proof.sourceCrmRecords).toEqual([{ id: "6001", DealNumber: "VTNX-0572", Modified_Time: "2026-01-01T00:00:00+00:00" }]);
    expect(proof).not.toHaveProperty("canonicalJobId");
  });
  it("replaces a changed external project only after its complete new proof", async () => {
    const reader = proofReader({ project: { ...project, zprojects_project_id: "3002" } });
    await collectProjectHistoryProof(ref, reader); expect(reader.allowProject).toHaveBeenCalledWith("3002");
    expect(reader.get.mock.calls.some(([, path]) => path.includes("/projects/3002/"))).toBe(true);
  });
  it("accepts the provider's detail marker without manufacturing a list-only field", async () => {
    const { other_service_app_source: omitted, ...detail } = project;
    expect(omitted).toBe(1);
    const reader = proofReader({ project: { ...detail, is_from_zoho_projects: true } });
    const proof = await collectProjectHistoryProof(ref, reader);
    expect(proof.sourceProject).toEqual({ ...detail, is_from_zoho_projects: true });
    expect(proof.sourceProject).not.toHaveProperty("other_service_app_source");
  });
  it("accepts a complete zero-deal page without fabricating CRM records", async () => {
    const reader = proofReader({ pages: [page(1, [], false)] });
    expect((await collectProjectHistoryProof(ref, reader)).sourceCrmRecords).toEqual([]);
    expect(reader.get.mock.calls.filter(([, path]) => path === "/crm/v8/Deals")).toHaveLength(0);
  });
  it.each([
    [{ booksOrg: "9999" }, "BOOKS_HISTORY_ORGANIZATION_MISMATCH"],
    [{ portal: "9999" }, "BOOKS_HISTORY_PORTAL_MISMATCH"],
    [{ project: { ...project, zprojects_project_id: "" } }, "BOOKS_HISTORY_PROJECT_UNLINKED"],
    [{ project: { ...project, other_service_app_source: "ZohoProjects" } }, "BOOKS_HISTORY_PROJECT_UNLINKED"],
    [{ pages: [page(1, ["6001"], true), page(2, ["6001"], false)] }, "BOOKS_HISTORY_DUPLICATE_OR_INVALID_DEAL"],
    [{ pages: [page(1, ["6001"], true), page(2, ["6002"], true), page(3, ["6003"], true), page(4, ["6004"], true)] }, "BOOKS_HISTORY_PAGES_INCOMPLETE"],
    [{ crmRecords: [] }, "BOOKS_HISTORY_CRM_RECORDS_INCOMPLETE"],
  ] as const)("rejects incomplete or mismatched evidence", async (override, code) => {
    await expect(collectProjectHistoryProof(ref, proofReader(override as Parameters<typeof proofReader>[0]))).rejects.toMatchObject({ code }); expect(mocks.imported).not.toHaveBeenCalled();
  });
});
describe("durable refresh ownership", () => {
  it("does nothing when incoming sync is disabled", async () => {
    mocks.enabled = false; expect(await processBooksProjectHistoryRefresh(actor)).toMatchObject({ enabled: false, attempted: 0 }); expect(mocks.rows).not.toHaveBeenCalled();
  });
  it("uses compare-and-swap and does not fetch after losing the claim", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher); mocks.update.mockResolvedValue({ count: 0 });
    expect(await processBooksProjectHistoryRefresh(actor)).toMatchObject({ attempted: 0, providerReads: 0 });
    expect(mocks.rows.mock.calls[0][0]).toMatchObject({ take: 2 });
    expect(mocks.update.mock.calls[0][0].where).toMatchObject({ sourceHash: row.sourceHash, verifiedAt: row.verifiedAt }); expect(fetcher).not.toHaveBeenCalled();
  });
  it("honors shared quota delays while preserving the last complete evidence", async () => {
    const until = new Date(Date.now() + 3600_000), fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    mocks.delay.mockReturnValue(until);
    expect(await processBooksProjectHistoryRefresh(actor)).toMatchObject({ failed: 1, refreshed: 0, providerReads: 0 });
    const failure = mocks.update.mock.calls.map(([input]) => input).find(input => input.data.lastErrorCode);
    expect(failure.data).toMatchObject({ nextRefreshAt: until, backoffUntil: until });
    for (const key of ["sourceProject", "sourceDealsPages", "sourceCrmRecords", "sourceHash", "verifiedAt", "status"]) expect(failure.data).not.toHaveProperty(key);
    expect(fetcher).not.toHaveBeenCalled(); expect(mocks.imported).not.toHaveBeenCalled();
  });
  it("fences an expired/replaced lease before checking source grants", async () => {
    mocks.update.mockResolvedValue({ count: 0 });
    const { db } = await import("@/lib/db");
    await expect(assertProjectHistoryLease(db as Prisma.TransactionClient, actor, row, "old-token", books, crm)).rejects.toMatchObject({ code: "BOOKS_HISTORY_LEASE_LOST" });
    expect(mocks.assertSource).not.toHaveBeenCalled();
  });
  it("does not read a former CRM source after the company binding changes", async () => {
    vi.stubGlobal("fetch", vi.fn()); mocks.binding.mockResolvedValue({ organizationId: "9999", dataCenter: "US", environment: "production" });
    expect(await processBooksProjectHistoryRefresh(actor)).toMatchObject({ failed: 1, providerReads: 0 });
    const failure = mocks.update.mock.calls.map(([input]) => input).find(input => input.data.lastErrorCode);
    expect(failure.data).toMatchObject({ status: "STALE", lastErrorCode: "BOOKS_HISTORY_SOURCE_CHANGED" }); expect(mocks.imported).not.toHaveBeenCalled();
  });
  it("isolates Projects throttling to its exact portal/source and preserves other leases and longer schedules", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: URL) => {
      if (url.origin === "https://projects.zoho.com") return new Response("{}", { status: 429, headers: { "retry-after": "3600" } });
      const body = url.pathname.includes("/organizations/") ? { code: 0, organization: { organization_id: "1001" } }
        : url.pathname.endsWith("/org") ? { org: [{ zgid: "5001", type: "production" }] } : { code: 0, project };
      return new Response(JSON.stringify(body));
    }));
    expect(await processBooksProjectHistoryRefresh(actor)).toMatchObject({ failed: 1, refreshed: 0, providerReads: 4 });
    expect(mocks.stateUpdate).not.toHaveBeenCalled();
    const groupWrites = mocks.update.mock.calls.map(([input]) => input).filter(input => input.where.portalId);
    expect(groupWrites).toHaveLength(2);
    for (const update of groupWrites) {
      expect(update.where).toMatchObject({ portalId: "4001", crmOrganizationId: "5001", crmDataCenter: "US", crmEnvironment: "production" });
      expect(update.data).not.toHaveProperty("leaseToken"); expect(update.data).not.toHaveProperty("leaseExpiresAt");
    }
    expect(groupWrites[0].where.OR[1].backoffUntil.lt).toEqual(groupWrites[0].data.backoffUntil);
    expect(groupWrites[1].where.nextRefreshAt.lt).toEqual(groupWrites[1].data.nextRefreshAt);
    expect(mocks.imported).not.toHaveBeenCalled();
  });
  it("a running association observes another worker's portal cooldown before its next read", async () => {
    const until = new Date(Date.now() + 7200_000);
    mocks.leasedRow.mockResolvedValue({ backoffUntil: until });
    const { db } = await import("@/lib/db");
    await expect(assertProjectHistoryLease(db as Prisma.TransactionClient, actor, row, "current-token", books, crm)).rejects.toMatchObject({ code: "BOOKS_HISTORY_ASSOCIATION_COOLDOWN", until });
    expect(mocks.assertSource).not.toHaveBeenCalled();
  });
});
