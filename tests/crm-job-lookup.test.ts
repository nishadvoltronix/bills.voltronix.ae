import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
import { getConfig } from "@/lib/integrations/config";
import { connectionFingerprint } from "@/lib/integrations/connection-fingerprint";
import { ZohoTransport, type Fetch } from "@/lib/integrations/transport";
import { VERIFIED_CRM_JOB_MAPPING } from "@/lib/integrations/crm";
import { resolveCrmJob, searchCrmJobs, type CrmJobSuggestion } from "@/lib/services/crm-job-lookup";

const store = vi.hoisted(() => ({
  user: { findFirst: vi.fn() }, company: { findUnique: vi.fn() }, companyCrmSource: { findUnique: vi.fn(), findMany: vi.fn() },
  companyIntegrationDestination: { findMany: vi.fn() }, integrationCredential: { findUnique: vi.fn() },
  job: { findMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), upsert: vi.fn() },
  auditLog: { create: vi.fn() }, $transaction: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: store }));
vi.mock("@/lib/integrations/oauth", () => ({ accessToken: vi.fn(async () => "fictional-token"), LEGACY_UNSCOPED_ORGANIZATION: "__legacy_unscoped__" }));
const actor: Actor = { id: "writer", name: "Writer", email: "writer@example.invalid", role: "ADMIN" };
const crm = { organizationId: "9001", dataCenter: "US", environment: "production" as const };
const books = { organizationId: "1001", dataCenter: "US", environment: "production" as const };
type Job = Prisma.JobGetPayload<{ include: { bills: true } }>;
let jobs: Job[], audits: unknown[];
let authorized: boolean, currentRole: Actor["role"], activeCompany: boolean, demoCompany: boolean, liveCompany: boolean;
let authorizedCompanies: Set<string>;
let sourcePresent: boolean, grantPresent: boolean, grantRevoked: boolean, grantFingerprint: string | null;
let sources: { companyId: string; organizationId: string; dataCenter: string; environment: string; createdAt: Date }[];
let destinations: { companyId: string; organizationId: string; dataCenter: string; environment: string }[];
function record(overrides: Record<string, unknown> = {}) {
  return { id: "5001", JobDealNumber: "JOB-5384", Deal_Name: "Fictional CRM job", Amount: 2200,
    Account_Name: { id: "6001", name: "Fictional customer" }, Currency: "AED", Books_Organization_ID: "1001", Stage: "Closed Won",
    private_notes: "PRIVATE PROVIDER BODY", ...overrides };
}
function local(overrides: Partial<Job> = {}): Job {
  const job: Job = { id: `local-${jobs.length + 1}`, companyId: "company-a", jobNumber: "JOB-5384", name: "Fictional CRM job", customer: "Fictional customer",
    contractValue: new Prisma.Decimal(2200), approvedVariations: new Prisma.Decimal(0), currency: "AED", externalCrmId: "5001", isDemo: true, createdAt: new Date(), bills: [], ...overrides };
  jobs.push(job); return job;
}
function connection(options: { records?: Record<string, unknown>[]; exact?: Record<string, unknown>; uniqueness?: Record<string, unknown>[];
  intercept?: (url: URL) => unknown; onRead?: (url: URL) => void; searchMore?: boolean; uniquenessMore?: boolean } = {}) {
  const fetcher = vi.fn<Fetch>(async (input, init) => {
    const url = new URL(input);
    expect(init?.method).toBe("GET"); expect(init?.body).toBeUndefined();
    options.onRead?.(url);
    const override = options.intercept?.(url);
    if (override instanceof Response) return override;
    const isUnique = url.searchParams.get("per_page") === "200";
    const records = isUnique ? options.uniqueness ?? [record()] : options.records ?? [record()];
    const body = override ?? (url.pathname === "/crm/v8/org" ? { org: [{ zgid: "9001", id: "900100", type: "production" }] }
      : url.pathname.endsWith("/search") ? { data: records, info: { page: 1, per_page: isUnique ? 200 : 25, more_records: isUnique ? options.uniquenessMore ?? false : options.searchMore ?? false } }
      : { data: [options.exact ?? record()] });
    return new Response(JSON.stringify(body));
  });
  return { fetcher, transport: new ZohoTransport(getConfig("CRM"), async () => "fictional-token", fetcher) };
}
function selection(job: CrmJobSuggestion) {
  const { companyId, externalCrmId, sourceId, crmOrganizationId, dataCenter, environment, booksOrganizationId } = job;
  return { companyId, externalCrmId, sourceId, crmOrganizationId, dataCenter, environment, booksOrganizationId };
}
async function selected() {
  return selection((await searchCrmJobs(actor, { companyId: "company-a", q: "JOB-5384" }, connection().transport)).jobs[0]);
}
beforeEach(() => {
  vi.resetAllMocks();
  for (const [key, value] of Object.entries({ APP_ENV: "development", NODE_ENV: "development", APP_URL: "http://127.0.0.1:3000",
    INTEGRATION_NETWORK_ENABLED: "true", ZOHO_BOOKS_NETWORK_ENABLED: "true", ZOHO_BOOKS_WRITE_ENABLED: "false", ZOHO_BOOKS_LIVE_ENABLED: "false",
    ALLOW_PRODUCTION_ACCOUNTING_WRITES: "false", INTEGRATION_TEST_MODE: "false", ZOHO_BOOKS_DC: "US", ZOHO_BOOKS_ENVIRONMENT: "production",
    ZOHO_BOOKS_CLIENT_ID: "fictional-books-client", ZOHO_BOOKS_CLIENT_SECRET: "fictional-books-secret", ZOHO_BOOKS_ORGANIZATION_ID: "", ZOHO_BOOKS_REFRESH_TOKEN: "",
    ZOHO_BOOKS_ORGANIZATIONS_JSON: JSON.stringify([{ organizationId: "1001", name: "Fictional A" }, { organizationId: "1002", name: "Fictional B" }]),
    ZOHO_CRM_DC: "US", ZOHO_CRM_ENVIRONMENT: "production", ZOHO_CRM_ORGANIZATION_ID: "9001", ZOHO_CRM_NETWORK_ENABLED: "true",
    ZOHO_CRM_CLIENT_ID: "fictional-crm-client", ZOHO_CRM_CLIENT_SECRET: "fictional-crm-secret", ZOHO_CRM_REFRESH_TOKEN: "",
    ZOHO_CRM_MAPPING_JSON: JSON.stringify(VERIFIED_CRM_JOB_MAPPING),
  })) vi.stubEnv(key, value);
  jobs = []; audits = []; authorized = true; currentRole = "ADMIN"; activeCompany = true; demoCompany = true; liveCompany = false;
  authorizedCompanies = new Set(["company-a", "company-b"]);
  sourcePresent = true; grantPresent = true; grantRevoked = false; grantFingerprint = null;
  sources = ["company-a", "company-b"].map(companyId => ({ companyId, ...crm, createdAt: new Date("2026-10-29T10:00:00Z") }));
  destinations = [{ companyId: "company-a", ...books }, { companyId: "company-b", ...books, organizationId: "1002" }];
  store.user.findFirst.mockImplementation(async ({ where }: { where: { role: Actor["role"]; memberships?: { some: { companyId: string } } } }) => authorized && activeCompany && where.role === currentRole &&
    (!where.memberships || authorizedCompanies.has(where.memberships.some.companyId)) ? { id: actor.id } : null);
  store.company.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id, active: activeCompany, isDemo: demoCompany, liveAccountingEnabled: liveCompany }));
  store.companyCrmSource.findUnique.mockImplementation(async ({ where }: { where: { companyId: string } }) => sourcePresent ? sources.find(row => row.companyId === where.companyId) ?? null : null);
  store.companyCrmSource.findMany.mockImplementation(async () => sourcePresent && authorized && activeCompany ? sources.filter(row => authorizedCompanies.has(row.companyId))
    .sort((a, b) => a.companyId.localeCompare(b.companyId)).slice(0, 21).map(row => ({ ...row })) : []);
  store.companyIntegrationDestination.findMany.mockImplementation(async ({ where }: { where: { companyId: string } }) => destinations.filter(row => row.companyId === where.companyId).map(({ organizationId, dataCenter, environment }) => ({ organizationId, dataCenter, environment })));
  store.integrationCredential.findUnique.mockImplementation(async () => grantPresent ? { revokedAt: grantRevoked ? new Date() : null, connectionFingerprint: grantFingerprint ?? connectionFingerprint(getConfig("CRM")) } : null);
  store.job.findMany.mockImplementation(async ({ where }: { where: { companyId: string; externalCrmId: { in: string[] } } }) => jobs.filter(job => job.companyId === where.companyId && job.externalCrmId && where.externalCrmId.in.includes(job.externalCrmId)));
  store.job.findUnique.mockImplementation(async ({ where }: { where: { companyId_externalCrmId: { companyId: string; externalCrmId: string } } }) => jobs.find(job => job.companyId === where.companyId_externalCrmId.companyId && job.externalCrmId === where.companyId_externalCrmId.externalCrmId) ?? null);
  store.job.findFirst.mockImplementation(async ({ where }: { where: { companyId: string; jobNumber: { equals: string } } }) => jobs.find(job => job.companyId === where.companyId && job.jobNumber.toUpperCase() === where.jobNumber.equals.toUpperCase()) ?? null);
  store.job.create.mockImplementation(async ({ data }: { data: Omit<Job, "id" | "createdAt" | "bills" | "contractValue" | "approvedVariations"> & { contractValue: string | null; approvedVariations: string } }) =>
    local({ ...data, contractValue: data.contractValue === null ? null : new Prisma.Decimal(data.contractValue), approvedVariations: new Prisma.Decimal(data.approvedVariations) }));
  store.auditLog.create.mockImplementation(async ({ data }: { data: unknown }) => { audits.push(data); return {}; });
  store.$transaction.mockImplementation(async (action: (tx: typeof store) => Promise<unknown>, options: unknown) => {
    expect(options).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20_000 });
    const beforeJobs = [...jobs], beforeAudits = [...audits];
    try { return await action(store); } catch (error) { jobs = beforeJobs; audits = beforeAudits; throw error; }
  });
});
afterEach(() => {
  expect(store.job.update).not.toHaveBeenCalled(); expect(store.job.upsert).not.toHaveBeenCalled(); vi.unstubAllEnvs();
});

describe("CRM company job search", () => {
  it("reads only the selected company's jobs and returns bounded sanitized identity, current amount and stage", async () => {
    const linked = local();
    const remote = connection({ records: [record(), record({ id: "5002", Books_Organization_ID: "1002", Deal_Name: "OTHER COMPANY PRIVATE" }), record({ id: "5003", JobDealNumber: "OTHER" })] });
    const result = await searchCrmJobs(actor, { companyId: "company-a", q: "JOB-5384" }, remote.transport);
    expect(result).toMatchObject({ companyId: "company-a", warning: null, hasMore: false });
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toMatchObject({ id: linked.id, companyId: "company-a", crmOrganizationId: "9001", booksOrganizationId: "1001", externalCrmId: "5001", jobNumber: "JOB-5384", stage: "Closed Won", contractValue: "2200.00" });
    expect(result.jobs[0].sourceId).toMatch(/^[a-f0-9]{64}$/);
    expect(new URL(remote.fetcher.mock.calls[1][0]).searchParams.get("criteria")).toBe("((Books_Organization_ID:equals:1001)and(JobDealNumber:starts_with:JOB-5384))");
    expect(JSON.stringify(result)).not.toContain("PRIVATE"); expect(store.job.create).not.toHaveBeenCalled(); expect(store.$transaction).not.toHaveBeenCalled();
  });

  it("shares the CRM organization while routing company B strictly by its Books organization", async () => {
    local();
    const result = await searchCrmJobs(actor, { companyId: "company-b", q: "JOB-5383" }, connection({ records: [record(), record({ id: "5002", JobDealNumber: "JOB-5383", Books_Organization_ID: "1002" })] }).transport);
    expect(result.jobs).toMatchObject([{ companyId: "company-b", booksOrganizationId: "1002", crmOrganizationId: "9001", id: null, externalCrmId: "5002" }]);
  });

  it("supports an exact external record ID without exposing another company's record", async () => {
    const externalCrmId = "9000000000000005001";
    const remote = connection({ records: [], exact: record({ id: externalCrmId }) });
    const own = await searchCrmJobs(actor, { companyId: "company-a", q: externalCrmId }, remote.transport);
    expect(own.jobs).toMatchObject([{ externalCrmId, jobNumber: "JOB-5384" }]);
    expect(remote.fetcher.mock.calls.map(call => new URL(call[0]).pathname)).toContain(`/crm/v8/Deals/${externalCrmId}`);
    expect(new URL(remote.fetcher.mock.calls[1][0]).searchParams.get("criteria")).toBe(`((Books_Organization_ID:equals:1001)and(JobDealNumber:starts_with:${externalCrmId}))`);
    const foreign = await searchCrmJobs(actor, { companyId: "company-b", q: externalCrmId }, remote.transport);
    expect(foreign.jobs).toEqual([]); expect(foreign.warning).toBeNull();
  });

  it.each([["5383", "5383"], ["538", "5383"], ["005383", "005383"]])("finds raw and JOB-prefixed job numbers for %s without treating them as CRM record IDs", async (q, digits) => {
    const remote = connection({ records: [
      record({ id: "5101", JobDealNumber: `JOB-${digits}` }), record({ id: "5102", JobDealNumber: digits }),
      record({ id: "5103", JobDealNumber: `JOB-${digits}`, Books_Organization_ID: "1002", Deal_Name: "FOREIGN PRIVATE" }),
      record({ id: "5104", JobDealNumber: `OTHER-${digits}` }),
      record({ id: "5105", JobDealNumber: digits.startsWith("00") ? "JOB-5383" : "JOB-005383" }),
    ] });
    const result = await searchCrmJobs(actor, { companyId: "company-a", q }, remote.transport);
    expect(result.warning).toBeNull();
    expect(result.jobs.map(job => job.externalCrmId)).toEqual(["5101", "5102"]);
    expect(result.jobs.every(job => job.companyId === "company-a" && job.booksOrganizationId === "1001")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("FOREIGN");
    const requests = remote.fetcher.mock.calls.map(call => new URL(call[0]));
    expect(requests.map(url => url.pathname)).toEqual(["/crm/v8/org", "/crm/v8/Deals/search"]);
    expect(requests[1].searchParams.get("criteria")).toBe(`((Books_Organization_ID:equals:1001)and((JobDealNumber:starts_with:${q})or(JobDealNumber:starts_with:JOB-${q})))`);
    expect(store.job.create).not.toHaveBeenCalled(); expect(store.$transaction).not.toHaveBeenCalled();
  });

  it("masks all source financial fields for current DATA_ENTRY users", async () => {
    currentRole = "DATA_ENTRY";
    vi.stubEnv("ZOHO_CRM_MAPPING_JSON", JSON.stringify({ ...VERIFIED_CRM_JOB_MAPPING, approvedVariationsField: "Approved_Variations" }));
    const result = await searchCrmJobs({ ...actor, role: "DATA_ENTRY" }, { companyId: "company-a", q: "JOB" }, connection({ records: [record({ Approved_Variations: 12 })] }).transport);
    expect(result.jobs[0]).toMatchObject({ contractValue: null, approvedVariations: "0.00" });
    expect(JSON.stringify(result)).not.toContain("2200");
  });

  it.each(["missing-source", "missing-grant", "revoked-grant", "wrong-grant", "network-disabled", "source-dc", "books-env", "ambiguous-books", "missing-profile", "write-enabled", "live-company", "production-runtime"])("returns no remote data or requests when %s", async mode => {
    const remote = connection();
    if (mode === "missing-source") sourcePresent = false;
    if (mode === "missing-grant") grantPresent = false;
    if (mode === "revoked-grant") grantRevoked = true;
    if (mode === "wrong-grant") grantFingerprint = "different-product-grant";
    if (mode === "network-disabled") vi.stubEnv("ZOHO_CRM_NETWORK_ENABLED", "false");
    if (mode === "source-dc") sources[0].dataCenter = "EU";
    if (mode === "books-env") destinations[0].environment = "sandbox";
    if (mode === "ambiguous-books") destinations.push({ companyId: "company-a", ...books, organizationId: "1002" });
    if (mode === "missing-profile") vi.stubEnv("ZOHO_BOOKS_ORGANIZATIONS_JSON", JSON.stringify([{ organizationId: "1002", name: "Fictional B" }]));
    if (mode === "write-enabled") vi.stubEnv("ZOHO_BOOKS_WRITE_ENABLED", "true");
    if (mode === "live-company") liveCompany = true;
    if (mode === "production-runtime") vi.stubEnv("APP_ENV", "production");
    const result = await searchCrmJobs(actor, { companyId: "company-a", q: "JOB" }, remote.transport);
    expect(result.jobs).toEqual([]); expect(result.warning).toBeTruthy(); expect(remote.fetcher).not.toHaveBeenCalled();
  });

  it.each([{}, { companyId: "company-a", q: "x" }, { companyId: "company-a", q: "x".repeat(101) }, { companyId: "company-a", q: "JOB\u0000" },
    { companyId: "company-a", q: "JOB", booksOrganizationId: "1002" }])("validates input before any access or provider work", async input => {
    await expect(searchCrmJobs(actor, input)).rejects.toHaveProperty("name", "ZodError"); expect(store.user.findFirst).not.toHaveBeenCalled();
  });

  it.each(["membership", "company", "role", "management"])("rejects invalid current %s before provider reads", async change => {
    const remote = connection();
    if (change === "membership") authorized = false;
    if (change === "company") activeCompany = false;
    if (change === "role") currentRole = "DATA_ENTRY";
    await expect(searchCrmJobs(change === "management" ? { ...actor, role: "MANAGEMENT" } : actor, { companyId: "company-a", q: "JOB" }, remote.transport)).rejects.toMatchObject({ status: 403 });
    expect(remote.fetcher).not.toHaveBeenCalled();
  });

  it.each(["membership", "role", "source", "destination", "config", "grant"])("rejects stale results after %s changes during GET", async change => {
    const remote = connection({ onRead: url => {
      if (!url.pathname.endsWith("/search")) return;
      if (change === "membership") authorized = false;
      if (change === "role") currentRole = "DATA_ENTRY";
      if (change === "source") sources[0] = { ...sources[0], createdAt: new Date("2026-10-30T00:00:00Z") };
      if (change === "destination") destinations[0] = { ...destinations[0], organizationId: "1002" };
      if (change === "config") vi.stubEnv("ZOHO_CRM_CLIENT_ID", "replaced-client");
      if (change === "grant") grantRevoked = true;
    } });
    await expect(searchCrmJobs(actor, { companyId: "company-a", q: "JOB" }, remote.transport)).rejects.toMatchObject({ status: ["membership", "role"].includes(change) ? 403 : 409 });
    expect(store.job.create).not.toHaveBeenCalled();
  });

  it.each([{ Currency: "JPY" }, { Amount: "NaN" }, { Amount: -1 }, { Amount: "1.234" }, { Amount: "1000000000000" },
    { Deal_Name: "PRIVATE\u0000VALUE" }, { Stage: { private: "body" } }, { Account_Name: null }])("sanitizes malformed provider jobs without returning partial data", async overrides => {
    const result = await searchCrmJobs(actor, { companyId: "company-a", q: "JOB" }, connection({ records: [record(overrides)] }).transport);
    expect(result.jobs).toEqual([]); expect(result.warning).toBeTruthy(); expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });

  it.each(["wrong-org", "wrong-environment", "duplicates", "oversize", "wrong-page"])("rejects malformed source/page evidence: %s", async mode => {
    const result = await searchCrmJobs(actor, { companyId: "company-a", q: "JOB" }, connection({ intercept: url => {
      if (url.pathname.endsWith("/org") && mode.startsWith("wrong-") && mode !== "wrong-page") return { org: [{ zgid: mode === "wrong-org" ? "9002" : "9001", type: mode === "wrong-environment" ? "sandbox" : "production" }] };
      if (url.pathname.endsWith("/search")) {
        if (mode === "duplicates") return { data: [record(), record()], info: { more_records: false } };
        if (mode === "oversize") return { data: Array.from({ length: 26 }, (_, i) => record({ id: String(5000 + i) })), info: { more_records: false } };
        if (mode === "wrong-page") return { data: [record()], info: { page: 2, more_records: false } };
      }
    } }).transport);
    expect(result.jobs).toEqual([]); expect(result.warning).toBeTruthy();
  });

  it("handles documented 204 no-match responses and escapes CRM criteria syntax", async () => {
    const remote = connection({ intercept: url => url.pathname.endsWith("/search") ? new Response(null, { status: 204 }) : undefined });
    const result = await searchCrmJobs(actor, { companyId: "company-a", q: "JOB,(X)\\" }, remote.transport);
    expect(result).toMatchObject({ jobs: [], hasMore: false, warning: null });
    expect(new URL(remote.fetcher.mock.calls[1][0]).searchParams.get("criteria")).toBe("((Books_Organization_ID:equals:1001)and(JobDealNumber:starts_with:JOB\\,\\(X\\)\\\\))");
  });

  it("preserves normal grant refresh and provider hasMore without importing any rows", async () => {
    const remote = connection({ searchMore: true, onRead: () => store.integrationCredential.findUnique.mockResolvedValue({ revokedAt: null, connectionFingerprint: connectionFingerprint(getConfig("CRM")), updatedAt: new Date() }) });
    const result = await searchCrmJobs(actor, { companyId: "company-a", q: "JOB" }, remote.transport);
    expect(result.hasMore).toBe(true); expect(result.warning).toBeNull(); expect(jobs).toEqual([]);
  });
});

describe("automatic company identification from authorized CRM sources", () => {
  const bothRecords = () => [record(), record({ id: "5002", Books_Organization_ID: "1002", Deal_Name: "Fictional second company job" })];

  it.each(["JOB-5384", "5384"])("returns both company identities for ambiguous reference %s without choosing or importing either", async q => {
    const remote = connection({ records: bothRecords() });
    const result = await searchCrmJobs(actor, { q }, remote.transport);
    expect(result).toMatchObject({ companyId: null, warning: null, hasMore: false });
    expect(result.jobs).toMatchObject([
      { companyId: "company-a", booksOrganizationId: "1001", externalCrmId: "5001", jobNumber: "JOB-5384" },
      { companyId: "company-b", booksOrganizationId: "1002", externalCrmId: "5002", jobNumber: "JOB-5384" },
    ]);
    expect(new Set(result.jobs.map(job => job.sourceId)).size).toBe(2);
    const criteria = remote.fetcher.mock.calls.map(call => new URL(call[0])).filter(url => url.pathname.endsWith("/search")).map(url => url.searchParams.get("criteria"));
    const jobCondition = q === "5384" ? "((JobDealNumber:starts_with:5384)or(JobDealNumber:starts_with:JOB-5384))" : "(JobDealNumber:starts_with:JOB-5384)";
    expect(criteria).toEqual(expect.arrayContaining(["1001", "1002"].map(org => `((Books_Organization_ID:equals:${org})and${jobCondition})`)));
    expect(remote.fetcher.mock.calls.map(call => new URL(call[0]).pathname).every(path => path === "/crm/v8/org" || path === "/crm/v8/Deals/search")).toBe(true);
    expect(criteria).toHaveLength(2); expect(jobs).toEqual([]); expect(store.$transaction).not.toHaveBeenCalled();
  });

  it("identifies the correct company for each distinct job ID while keeping explicit-company calls unchanged", async () => {
    const remote = connection({ records: [record(), record({ id: "5002", Books_Organization_ID: "1002", JobDealNumber: "JOB-5383" })] });
    const a = await searchCrmJobs(actor, { q: "JOB-5384" }, remote.transport);
    const b = await searchCrmJobs(actor, { q: "JOB-5383" }, remote.transport);
    expect(a.jobs.map(job => job.companyId)).toEqual(["company-a"]);
    expect(b.jobs.map(job => job.companyId)).toEqual(["company-b"]);
    const scoped = await searchCrmJobs(actor, { companyId: "company-b", q: "JOB-5383" }, remote.transport);
    expect(scoped.companyId).toBe("company-b"); expect(scoped.jobs).toEqual(b.jobs);
  });

  it("never searches unauthorized company sources, even if the provider returns another company's record", async () => {
    authorizedCompanies.delete("company-b");
    const remote = connection({ records: [record(), record({ id: "5002", Books_Organization_ID: "1002", Deal_Name: "UNAUTHORIZED PRIVATE" })] });
    const result = await searchCrmJobs(actor, { q: "JOB" }, remote.transport);
    expect(result.jobs.map(job => job.companyId)).toEqual(["company-a"]);
    expect(JSON.stringify(result)).not.toContain("UNAUTHORIZED");
    const criteria = remote.fetcher.mock.calls.map(call => new URL(call[0]).searchParams.get("criteria")).filter(Boolean);
    expect(criteria).toHaveLength(1); expect(criteria[0]).toContain("Books_Organization_ID:equals:1001");
    expect(store.companyCrmSource.findMany.mock.calls[0][0]).toMatchObject({ where: { company: { active: true, memberships: { some: { userId: actor.id, active: true, user: { active: true, role: "ADMIN" } } } } } });
  });

  it("retains authorized successful matches with an explicit incomplete-results warning after a partial provider failure", async () => {
    const remote = connection({ records: bothRecords(), searchMore: true, intercept: url =>
      url.searchParams.get("criteria")?.includes("Books_Organization_ID:equals:1002") ? new Response(null, { status: 503 }) : undefined });
    const result = await searchCrmJobs(actor, { q: "JOB" }, remote.transport);
    expect(result.jobs.map(job => job.companyId)).toEqual(["company-a"]); expect(result.warning).toContain("incomplete"); expect(result.hasMore).toBe(true);
  });

  it.each(["membership", "source", "destination"])("rejects a completed first branch if its %s changes while the second branch is pending", async change => {
    let releaseSecond!: () => void;
    const firstFinished = new Promise<void>(resolve => { releaseSecond = resolve; });
    const userLookup = store.user.findFirst.getMockImplementation()!;
    let firstContextReads = 0;
    store.user.findFirst.mockImplementation(async args => {
      if (args.where.memberships?.some.companyId === "company-a" && ++firstContextReads === 2) {
        // Let the first branch's remaining immediate database reads finish before
        // the pending second provider response changes its authorization/source.
        setTimeout(releaseSecond, 0);
      }
      return userLookup(args);
    });
    const remote = connection({ records: bothRecords() });
    const read = remote.fetcher.getMockImplementation()!;
    remote.fetcher.mockImplementation(async (input, init) => {
      if (new URL(input).searchParams.get("criteria")?.includes("Books_Organization_ID:equals:1002")) {
        await firstFinished;
        if (change === "membership") authorizedCompanies.delete("company-a");
        if (change === "source") sources[0] = { ...sources[0], createdAt: new Date("2026-11-01T00:00:00Z") };
        if (change === "destination") destinations[0] = { ...destinations[0], organizationId: "1002" };
      }
      return read(input, init);
    });
    await expect(searchCrmJobs(actor, { q: "JOB" }, remote.transport)).rejects.toMatchObject({ status: change === "membership" ? 403 : 409 });
    expect(firstContextReads).toBeGreaterThanOrEqual(3); expect(jobs).toEqual([]);
  });

  it("rechecks the complete source set when a new authorized binding appears during lookup", async () => {
    const remote = connection({ records: bothRecords(), onRead: url => {
      if (!url.searchParams.get("criteria")?.includes("Books_Organization_ID:equals:1002")) return;
      sources.push({ companyId: "company-c", ...crm, createdAt: new Date() }); authorizedCompanies.add("company-c");
    } });
    await expect(searchCrmJobs(actor, { q: "JOB" }, remote.transport)).rejects.toMatchObject({ status: 409 });
    expect(jobs).toEqual([]);
  });

  it.each(["no-memberships", "no-source", "too-many-sources"])("does not make provider requests with %s", async mode => {
    if (mode === "no-memberships") authorizedCompanies.clear();
    if (mode === "no-source") sourcePresent = false;
    if (mode === "too-many-sources") {
      sources = Array.from({ length: 21 }, (_, i) => ({ companyId: `company-${i}`, ...crm, createdAt: new Date() }));
      authorizedCompanies = new Set(sources.map(source => source.companyId));
    }
    const remote = connection();
    const result = await searchCrmJobs(actor, { q: "JOB" }, remote.transport);
    expect(result).toMatchObject({ companyId: null, jobs: [], hasMore: false }); expect(result.warning).toBeTruthy(); expect(remote.fetcher).not.toHaveBeenCalled();
  });

  it("validates current role and rejects an explicitly empty company instead of broadening it", async () => {
    await expect(searchCrmJobs(actor, { companyId: "", q: "JOB" })).rejects.toHaveProperty("name", "ZodError");
    currentRole = "DATA_ENTRY";
    const remote = connection();
    await expect(searchCrmJobs(actor, { q: "JOB" }, remote.transport)).rejects.toMatchObject({ status: 403 });
    expect(remote.fetcher).not.toHaveBeenCalled();
  });
});

describe("explicit CRM job resolution", () => {
  it("creates exactly one selected verified job and reuses it without overwriting existing values", async () => {
    const input = await selected();
    const first = await resolveCrmJob(actor, input, connection().transport);
    const second = await resolveCrmJob(actor, input, connection().transport);
    expect(first.job).toMatchObject({ companyId: "company-a", externalCrmId: "5001", jobNumber: "JOB-5384", contractValue: "2200.00", isDemo: true, billCount: 0 });
    expect(first.stage).toBe("Closed Won"); expect(second.job.id).toBe(first.job.id);
    expect(jobs).toHaveLength(1); expect(audits).toHaveLength(1); expect(store.job.create).toHaveBeenCalledTimes(1);
  });

  it("inherits the selected company's real/demo marker and masks data-entry resolution totals", async () => {
    demoCompany = false; currentRole = "DATA_ENTRY";
    const writer = { ...actor, role: "DATA_ENTRY" as const };
    const input = selection((await searchCrmJobs(writer, { companyId: "company-a", q: "JOB" }, connection().transport)).jobs[0]);
    const result = await resolveCrmJob(writer, input, connection().transport);
    expect(result.job).toMatchObject({ isDemo: false, contractValue: null, adjustedValue: null, financialScope: "YOUR_BILLS" });
    expect(jobs[0].contractValue?.toFixed(2)).toBe("2200.00");
  });

  it.each(["companyId", "crmOrganizationId", "booksOrganizationId", "dataCenter", "environment", "sourceId"] as const)("rejects changed selection identity %s before the provider", async field => {
    const input = await selected(), remote = connection();
    const value = field === "companyId" ? "company-b" : field === "dataCenter" ? "EU" : field === "environment" ? "sandbox" : field === "sourceId" ? "a".repeat(64) : "9999";
    await expect(resolveCrmJob(actor, { ...input, [field]: value }, remote.transport)).rejects.toMatchObject({ status: 409 });
    expect(remote.fetcher).not.toHaveBeenCalled(); expect(jobs).toEqual([]);
  });

  it.each(["external-id", "foreign-company", "duplicate-number", "incomplete-search", "missing-match"])("refuses unverifiable source identity: %s", async mode => {
    const input = await selected();
    const remote = connection({ exact: record(mode === "external-id" ? { id: "5002" } : mode === "foreign-company" ? { Books_Organization_ID: "1002" } : {}),
      uniqueness: mode === "duplicate-number" ? [record(), record({ id: "5002" })] : mode === "missing-match" ? [] : undefined, uniquenessMore: mode === "incomplete-search" });
    await expect(resolveCrmJob(actor, input, remote.transport)).rejects.toThrow(); expect(jobs).toEqual([]); expect(store.$transaction).not.toHaveBeenCalled();
  });

  it("checks job-number uniqueness within the company instead of another company's same reference", async () => {
    const input = await selected();
    const result = await resolveCrmJob(actor, input, connection({ uniqueness: [record(), record({ id: "5002", Books_Organization_ID: "1002" })] }).transport);
    expect(result.job.companyId).toBe("company-a"); expect(jobs).toHaveLength(1);
  });

  it.each(["unmapped-number", "value", "currency", "name", "customer"])("preserves conflicting saved jobs: %s", async mode => {
    const input = await selected();
    const existing = local(mode === "unmapped-number" ? { externalCrmId: null } : mode === "value" ? { contractValue: new Prisma.Decimal(1000) } :
      mode === "currency" ? { currency: "USD" } : mode === "name" ? { name: "Reviewed local label" } : { customer: "Reviewed local customer" });
    await expect(resolveCrmJob(actor, input, connection().transport)).rejects.toMatchObject({ status: 409 });
    expect(jobs).toEqual([existing]); expect(audits).toEqual([]); expect(store.job.create).not.toHaveBeenCalled();
  });

  it("preserves local approved variations when CRM does not map a variations field", async () => {
    const input = await selected(); local({ approvedVariations: new Prisma.Decimal(200) });
    const result = await resolveCrmJob(actor, input, connection().transport);
    expect(result.job.approvedVariations).toBe("200.00"); expect(result.job.adjustedValue).toBe("2400.00"); expect(store.job.create).not.toHaveBeenCalled();
  });

  it("rejects authorization loss before the transaction and rolls back loss during local creation", async () => {
    const input = await selected();
    await expect(resolveCrmJob(actor, input, connection({ onRead: url => { if (url.pathname.endsWith("/search")) authorized = false; } }).transport)).rejects.toMatchObject({ status: 403 });
    expect(store.$transaction).not.toHaveBeenCalled();
    authorized = true;
    store.job.create.mockImplementationOnce(async () => { const created = local(); authorized = false; return created; });
    await expect(resolveCrmJob(actor, input, connection().transport)).rejects.toMatchObject({ status: 403 });
    expect(jobs).toEqual([]); expect(audits).toEqual([]);
  });

  it("rejects omitted destination identity and client fields before reads", async () => {
    const input = await selected(); store.user.findFirst.mockClear();
    const { sourceId: omitted, ...withoutSource } = input; void omitted;
    await expect(resolveCrmJob(actor, withoutSource)).rejects.toHaveProperty("name", "ZodError");
    await expect(resolveCrmJob(actor, { ...input, contractValue: "1.00" })).rejects.toHaveProperty("name", "ZodError");
    expect(store.user.findFirst).not.toHaveBeenCalled();
  });
});

describe("CRM empty search transport response", () => {
  it("accepts only a GET CRM search 204 response as no matches", async () => {
    const empty = vi.fn<Fetch>(async () => new Response(null, { status: 204 }));
    const crmTransport = new ZohoTransport(getConfig("CRM"), async () => "fictional", empty);
    await expect(crmTransport.request("/crm/v8/Deals/search")).resolves.toBeNull();
    await expect(crmTransport.request("/crm/v8/Deals/5001")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(crmTransport.request("/crm/v8/org")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    const booksTransport = new ZohoTransport(getConfig("ZOHO", process.env, "1001"), async () => "fictional", empty);
    await expect(booksTransport.request("/books/v3/contacts")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});
