import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";

const mockDb = vi.hoisted(() => ({
  companyCrmSource: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  companyIntegrationDestination: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  company: { create: vi.fn(), update: vi.fn() },
  job: { count: vi.fn() },
  integrationCredential: { findUnique: vi.fn(), upsert: vi.fn(), createMany: vi.fn(), updateMany: vi.fn() },
  integrationOAuthState: { create: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
  auditLog: { create: vi.fn() }, $transaction: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

import { assertWrite, getConfig } from "@/lib/integrations/config";
import { crmAuthorizationContext } from "@/lib/integrations/crm-source";
import { accessToken, beginOAuth, completeOAuth, connectionFingerprint, decryptToken, encryptToken } from "@/lib/integrations/oauth";
import { crmAuthorizationStatus } from "@/lib/services/crm-authorization";
import { prepareLocalCrmSources } from "@/lib/services/crm-local-connection";

const actor: Actor = { id: "fictional-crm-admin", name: "Fictional Admin", email: "crm-admin@example.invalid", role: "ADMIN" };
const organizationId = "990000001";
const profiles = [{ organizationId: "991000001", name: "Fictional Alpha" }, { organizationId: "991000002", name: "Fictional Beta" }];
type Source = { companyId: string; organizationId: string; dataCenter: string; environment: string; createdAt: Date };
type State = { tokenHash: string; target: string; organizationId: string; userId: string; dataCenter: string;
  connectionFingerprint: string; expiresAt: Date; consumedAt: Date | null };
type Grant = { target: string; organizationId: string; dataCenter: string; connectionFingerprint: string;
  refreshTokenEncrypted: string; accessTokenEncrypted?: string; accessExpiresAt?: Date; revokedAt: Date | null };
let sources: Source[];
let currentAdmin: { active: boolean; role: string };
let companies: Map<string, { name: string; active: boolean; membership: boolean; liveAccountingEnabled: boolean; isDemo: boolean }>;
const states = new Map<string, State>();
const grants = new Map<string, Grant>();
let audits: Record<string, unknown>[];
const grantKey = (target: string, id: string) => `${target}:${id}`;
const authorized = (companyId: string) => currentAdmin.active && currentAdmin.role === "ADMIN" && companies.get(companyId)?.membership;
const env = () => ({ APP_ENV: "development", NODE_ENV: "test", APP_URL: "http://127.0.0.1:3000",
  DATABASE_URL: "mysql://fictional_runtime:fictional@127.0.0.1:3308/voltronix_billing_dev", INTEGRATION_TOKEN_ENCRYPTION_KEY: "a".repeat(64),
  INTEGRATION_NETWORK_ENABLED: "true", INTEGRATION_TEST_MODE: "false", ALLOW_PRODUCTION_ACCOUNTING_WRITES: "false",
  ZOHO_BOOKS_DC: "US", ZOHO_BOOKS_ENVIRONMENT: "production", ZOHO_BOOKS_CLIENT_ID: "fictional-books-client",
  ZOHO_BOOKS_CLIENT_SECRET: "fictional-books-secret", ZOHO_BOOKS_ORGANIZATIONS_JSON: JSON.stringify(profiles),
  ZOHO_BOOKS_REFRESH_TOKEN: "fictional-books-refresh-only", ZOHO_BOOKS_REFRESH_TOKENS_JSON: "", ZOHO_BOOKS_MAPPING_JSON: "",
  ZOHO_BOOKS_WRITE_ENABLED: "false", ZOHO_BOOKS_LIVE_ENABLED: "false", ZOHO_CRM_DC: "US", ZOHO_CRM_ENVIRONMENT: "production",
  ZOHO_CRM_CLIENT_ID: "fictional-crm-client", ZOHO_CRM_CLIENT_SECRET: "fictional-crm-secret", ZOHO_CRM_ORGANIZATION_ID: organizationId,
  ZOHO_CRM_NETWORK_ENABLED: "true", ZOHO_CRM_REFRESH_TOKEN: "", ZOHO_CRM_MAPPING_JSON: "",
});

beforeEach(() => {
  vi.resetAllMocks();
  for (const [key, value] of Object.entries(env())) vi.stubEnv(key, value);
  states.clear(); grants.clear(); audits = [];
  currentAdmin = { active: true, role: "ADMIN" };
  companies = new Map(["company-a", "company-b"].map((id, index) => [id, {
    name: profiles[index].name, active: true, membership: true, liveAccountingEnabled: false, isDemo: false,
  }]));
  sources = ["company-a", "company-b"].map((companyId) => ({ companyId, organizationId, dataCenter: "US",
    environment: "production", createdAt: new Date("2026-10-29T08:00:00.000Z") }));
  mockDb.companyCrmSource.findMany.mockImplementation(async ({ where }) => sources.filter((source) =>
    source.organizationId === where.organizationId && source.dataCenter === where.dataCenter && source.environment === where.environment)
    .sort((left, right) => left.companyId.localeCompare(right.companyId)).map((source) => ({ ...source, company: {
      name: companies.get(source.companyId)!.name, active: companies.get(source.companyId)!.active,
      memberships: authorized(source.companyId) ? [{ userId: actor.id }] : [],
    } })));
  mockDb.companyCrmSource.findUnique.mockImplementation(async ({ where }) => sources.find((source) => source.companyId === where.companyId) ?? null);
  mockDb.job.count.mockResolvedValue(0);
  mockDb.companyCrmSource.create.mockImplementation(async ({ data }) => { const source = { ...data, createdAt: new Date() }; sources.push(source); return source; });
  mockDb.companyIntegrationDestination.findFirst.mockImplementation(async ({ where }) => {
    const index = profiles.findIndex((profile) => profile.organizationId === where.organizationId);
    const companyId = ["company-a", "company-b"][index];
    return where.target === "ZOHO" && companyId && authorized(companyId) && companies.get(companyId)?.active ? { companyId } : null;
  });
  mockDb.integrationCredential.findUnique.mockImplementation(async ({ where }) => grants.get(grantKey(where.target_organizationId.target, where.target_organizationId.organizationId)) ?? null);
  mockDb.integrationCredential.upsert.mockImplementation(async ({ where, create, update }) => {
    const key = grantKey(where.target_organizationId.target, where.target_organizationId.organizationId);
    const grant = grants.has(key) ? { ...grants.get(key)!, ...update } : { ...create, revokedAt: null };
    grants.set(key, grant); return grant;
  });
  mockDb.integrationOAuthState.deleteMany.mockResolvedValue({ count: 0 });
  mockDb.integrationOAuthState.create.mockImplementation(async ({ data }) => { states.set(data.tokenHash, { ...data, consumedAt: null }); return data; });
  mockDb.integrationOAuthState.findUnique.mockImplementation(async ({ where }) => states.get(where.tokenHash) ?? null);
  mockDb.integrationOAuthState.updateMany.mockImplementation(async ({ where, data }) => {
    const row = states.get(where.tokenHash);
    if (!row || row.consumedAt || row.expiresAt <= where.expiresAt.gt ||
      (["target", "organizationId", "userId", "dataCenter", "connectionFingerprint"] as const).some((key) => row[key] !== where[key])) return { count: 0 };
    row.consumedAt = data.consumedAt; return { count: 1 };
  });
  mockDb.auditLog.create.mockImplementation(async ({ data }) => { audits.push(data); return data; });
  mockDb.$transaction.mockImplementation(async (work) => {
    const previousSources = structuredClone(sources), previousGrants = structuredClone(grants), previousAudits = structuredClone(audits);
    try { return await work(mockDb); }
    catch (error) { sources = previousSources; grants.clear(); for (const [key, value] of previousGrants) grants.set(key, value); audits = previousAudits; throw error; }
  });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected provider fixture request."); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function provider({ onToken, onOrganization, organization = { org: [{ zgid: organizationId, id: "990000002", type: "production" }] } }:
  { onToken?: () => void; onOrganization?: () => void; organization?: unknown } = {}) {
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.href === "https://accounts.zoho.com/oauth/v2/token") {
      expect(init?.method).toBe("POST");
      expect(String(init?.body)).toContain("grant_type=authorization_code");
      expect(String(init?.body)).not.toContain("fictional-books");
      onToken?.();
      return Response.json({ access_token: "fictional-crm-access-token", refresh_token: "fictional-crm-refresh-token", expires_in: 3600, api_domain: "https://www.zohoapis.com" });
    }
    expect(url.href).toBe("https://www.zohoapis.com/crm/v8/org");
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Zoho-oauthtoken fictional-crm-access-token");
    onOrganization?.();
    return Response.json(organization);
  });
}
async function begin() {
  const result = await beginOAuth(actor, "CRM");
  const url = new URL(result.authorizationUrl);
  return { url, callback: new URLSearchParams({ state: url.searchParams.get("state")!, code: "fictional-one-use-code" }) };
}

describe("shared CRM source authorization", () => {
  it("requires current Admin membership in both companies and binds the ordered source set", async () => {
    const first = await crmAuthorizationContext(actor, getConfig("CRM"));
    expect(first.companies.map((company) => company.id)).toEqual(["company-a", "company-b"]);
    expect(mockDb.companyCrmSource.findMany).toHaveBeenCalledWith(expect.objectContaining({ select: expect.objectContaining({
      company: { select: expect.objectContaining({ memberships: { where: { userId: actor.id, active: true, user: { active: true, role: "ADMIN" } }, select: { userId: true } } }) },
    }) }));
    sources[1].createdAt = new Date("2026-10-29T08:01:00.000Z");
    expect((await crmAuthorizationContext(actor, getConfig("CRM"))).fingerprint).not.toBe(first.fingerprint);
  });
  it("exchanges a CRM-only grant, verifies the exact provider organization and saves encrypted tokens with two audits", async () => {
    provider();
    const started = await begin();
    expect(started.url.searchParams.get("scope")!.split(",").every((scope) => scope.endsWith(".READ") && !scope.startsWith("ZohoBooks"))).toBe(true);
    expect(started.url.searchParams.get("scope")).toContain("ZohoCRM.org.READ");
    expect(started.url.searchParams.get("scope")).toContain("ZohoSearch.securesearch.READ");
    expect(started.url.searchParams.get("access_type")).toBe("offline");
    expect(started.url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:3000/api/integrations/oauth/crm/callback");
    await expect(completeOAuth(actor, "CRM", started.callback)).resolves.toEqual({ success: true, organizationId });
    const saved = grants.get(grantKey("CRM", organizationId))!;
    expect(saved.refreshTokenEncrypted).toMatch(/^v1\./);
    expect(decryptToken(saved.refreshTokenEncrypted)).toBe("fictional-crm-refresh-token");
    expect(decryptToken(saved.accessTokenEncrypted!)).toBe("fictional-crm-access-token");
    expect(saved.connectionFingerprint).toBe(connectionFingerprint(getConfig("CRM")));
    expect(JSON.stringify(saved)).not.toContain("fictional-crm-refresh-token");
    expect(audits).toHaveLength(2);
    expect(audits.map((audit) => audit.companyId)).toEqual(["company-a", "company-b"]);
    expect(audits.every((audit) => audit.action === "INTEGRATION_OAUTH_AUTHORIZED")).toBe(true);
    expect(JSON.stringify(audits)).not.toMatch(/refresh_token|access_token|fictional-crm-secret/);
    expect(mockDb.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
    expect(getConfig("CRM").writeEnabled).toBe(false);
    expect(() => assertWrite(getConfig("CRM"))).toThrowError(expect.objectContaining({ code: "WRITES_DISABLED" }));
  });
  it.each(["membership", "company", "user", "role"])("denies current %s revocation before state creation or exchange", async (kind) => {
    if (kind === "membership") companies.get("company-b")!.membership = false;
    if (kind === "company") companies.get("company-b")!.active = false;
    if (kind === "user") currentAdmin.active = false;
    if (kind === "role") currentAdmin.role = "ACCOUNTS";
    await expect(begin()).rejects.toMatchObject({ status: 403 });
    expect(mockDb.integrationOAuthState.create).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects an explicitly non-Admin actor before even reading source assignments", async () => {
    await expect(beginOAuth({ ...actor, role: "ACCOUNTS" }, "CRM")).rejects.toMatchObject({ status: 403 });
    expect(mockDb.companyCrmSource.findMany).not.toHaveBeenCalled();
  });
  it.each(["createdAt", "assignment"])("rejects a changed source %s between begin and callback before exchanging the code", async (change) => {
    const started = await begin();
    if (change === "createdAt") sources[1].createdAt = new Date("2026-10-29T09:00:00Z");
    else sources[1].organizationId = "990000099";
    await expect(completeOAuth(actor, "CRM", started.callback)).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
    expect(grants.size).toBe(0);
  });
  it("denies revoked company access at callback before token exchange", async () => {
    const started = await begin();
    companies.get("company-b")!.membership = false;
    await expect(completeOAuth(actor, "CRM", started.callback)).rejects.toMatchObject({ status: 403 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["token", "organization"])("persists nothing when membership is revoked during the %s response", async (step) => {
    const revoke = () => { companies.get("company-b")!.membership = false; };
    provider(step === "token" ? { onToken: revoke } : { onOrganization: revoke });
    const started = await begin();
    await expect(completeOAuth(actor, "CRM", started.callback)).rejects.toMatchObject({ status: 403 });
    expect(mockDb.integrationCredential.upsert).not.toHaveBeenCalled();
    expect(grants.size).toBe(0); expect(audits).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(step === "token" ? 1 : 2);
  });
  it.each([
    { org: [{ zgid: "other", id: "other", type: "production" }] },
    { org: [{ zgid: organizationId, type: "sandbox" }] },
    { org: [{ zgid: organizationId, type: "production" }, { zgid: organizationId, type: "production" }] },
  ])("rejects wrong or ambiguous provider organization without saving a grant", async (organization) => {
    provider({ organization });
    const started = await begin();
    await expect(completeOAuth(actor, "CRM", started.callback)).rejects.toMatchObject({ code: "CRM_ORGANIZATION_MISMATCH" });
    expect(grants.size).toBe(0); expect(audits).toEqual([]);
  });
});

describe("safe CRM credential status", () => {
  it("never treats a Books credential for the same organization ID as a CRM grant", async () => {
    grants.set(grantKey("ZOHO", organizationId), { target: "ZOHO", organizationId, dataCenter: "US", revokedAt: null,
      connectionFingerprint: connectionFingerprint(getConfig("CRM")), refreshTokenEncrypted: encryptToken("fictional-books-only-secret") });
    expect(await crmAuthorizationStatus(actor)).toMatchObject({ connected: false, status: "AUTHORIZATION_REQUIRED", authorization: { canAuthorize: true } });
    await expect(accessToken(getConfig("CRM"))).rejects.toBeDefined();
    expect(mockDb.integrationCredential.findUnique.mock.calls.every(([args]) => args.where.target_organizationId.target === "CRM")).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("returns only connection metadata, reads only revocation/fingerprint, and does not claim provider health", async () => {
    grants.set(grantKey("CRM", organizationId), { target: "CRM", organizationId, dataCenter: "US", revokedAt: null,
      connectionFingerprint: connectionFingerprint(getConfig("CRM")), refreshTokenEncrypted: "secret-ciphertext", accessTokenEncrypted: "secret-access-ciphertext" });
    const result = await crmAuthorizationStatus(actor);
    expect(result).toMatchObject({ connected: true, status: "CONNECTED", companies: [{ id: "company-a" }, { id: "company-b" }],
      authorization: { canAuthorize: true, networkEnabled: true, accountsOrigin: "https://accounts.zoho.com" } });
    expect(result.message).toContain("authorization is saved");
    expect(JSON.stringify(result)).not.toMatch(/secret|refreshToken|accessToken|connectionFingerprint/);
    expect(mockDb.integrationCredential.findUnique).toHaveBeenLastCalledWith(expect.objectContaining({ select: { revokedAt: true, connectionFingerprint: true } }));
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["revoked", "rotated"])("requires new authorization when the stored grant is %s", async (change) => {
    grants.set(grantKey("CRM", organizationId), { target: "CRM", organizationId, dataCenter: "US", revokedAt: change === "revoked" ? new Date() : null,
      connectionFingerprint: change === "rotated" ? "b".repeat(64) : connectionFingerprint(getConfig("CRM")), refreshTokenEncrypted: "fixture" });
    expect(await crmAuthorizationStatus(actor)).toMatchObject({ connected: false, status: "AUTHORIZATION_REQUIRED" });
  });
  it("blocks missing encrypted storage or disabled network and denies inaccessible shared companies", async () => {
    vi.stubEnv("INTEGRATION_TOKEN_ENCRYPTION_KEY", "");
    expect(await crmAuthorizationStatus(actor)).toMatchObject({ status: "BLOCKED", authorization: { canAuthorize: false } });
    vi.stubEnv("INTEGRATION_TOKEN_ENCRYPTION_KEY", "a".repeat(64));
    vi.stubEnv("ZOHO_CRM_NETWORK_ENABLED", "false");
    expect(await crmAuthorizationStatus(actor)).toMatchObject({ status: "BLOCKED", authorization: { canAuthorize: false } });
    companies.get("company-b")!.membership = false;
    await expect(crmAuthorizationStatus(actor)).rejects.toMatchObject({ status: 403 });
  });
  it("disables authorization and conceals storage error details when status cannot be checked", async () => {
    mockDb.integrationCredential.findUnique.mockRejectedValue(new Error("fixture-private-storage-detail"));
    const result = await crmAuthorizationStatus(actor);
    expect(result.authorization.canAuthorize).toBe(false);
    expect(result.connected).toBe(false);
    expect(JSON.stringify(result)).not.toContain("fixture-private-storage-detail");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("guarded local CRM source setup", () => {
  it("creates only missing read sources and audit rows, then remains idempotent", async () => {
    sources = [];
    const unchangedCompanies = structuredClone(companies);
    const result = await prepareLocalCrmSources(actor);
    expect(result).toMatchObject({ sources: [{ companyId: "company-a" }, { companyId: "company-b" }], financialWritesEnabled: false, providerRequests: 0 });
    expect(sources).toHaveLength(2); expect(audits).toHaveLength(2);
    await prepareLocalCrmSources(actor);
    expect(mockDb.companyCrmSource.create).toHaveBeenCalledTimes(2);
    expect(mockDb.job.count).toHaveBeenCalledTimes(2);
    expect(audits).toHaveLength(2);
    expect(companies).toEqual(unchangedCompanies);
    expect(mockDb.company.create).not.toHaveBeenCalled(); expect(mockDb.company.update).not.toHaveBeenCalled();
    expect(mockDb.companyIntegrationDestination.update).not.toHaveBeenCalled();
    expect(mockDb.companyIntegrationDestination.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      company: { active: true, memberships: { some: { userId: actor.id, active: true, user: { active: true, role: "ADMIN" } } } },
    }) }));
    expect(mockDb.integrationCredential.upsert).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves a conflicting source instead of replacing it", async () => {
    sources[0].organizationId = "999000099";
    const before = structuredClone(sources);
    await expect(prepareLocalCrmSources(actor)).rejects.toMatchObject({ status: 409 });
    expect(sources).toEqual(before); expect(audits).toEqual([]);
    expect(mockDb.companyCrmSource.update).not.toHaveBeenCalled();
  });
  it("refuses a new source for companies with existing CRM-linked jobs awaiting source review", async () => {
    sources = [];
    mockDb.job.count.mockResolvedValue(1);
    await expect(prepareLocalCrmSources(actor)).rejects.toMatchObject({ status: 409 });
    expect(mockDb.job.count).toHaveBeenCalledWith({ where: { companyId: "company-a", externalCrmId: { not: null } } });
    expect(mockDb.companyCrmSource.create).not.toHaveBeenCalled();
    expect(sources).toEqual([]); expect(audits).toEqual([]);
  });
  it("denies setup when either company lacks current active Admin access", async () => {
    sources = [];
    companies.get("company-b")!.membership = false;
    await expect(prepareLocalCrmSources(actor)).rejects.toMatchObject({ status: 403 });
    expect(sources).toEqual([]); expect(audits).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    ["APP_ENV", "production"], ["DATABASE_URL", "mysql://fictional@remote.invalid:3306/production"],
    ["APP_URL", "https://bills.example.invalid"], ["ZOHO_BOOKS_WRITE_ENABLED", "true"],
    ["ZOHO_BOOKS_LIVE_ENABLED", "true"], ["ALLOW_PRODUCTION_ACCOUNTING_WRITES", "true"], ["INTEGRATION_TEST_MODE", "true"],
  ])("rejects unsafe local setup override %s before querying any assignments", async (name, value) => {
    vi.stubEnv(name, value);
    await expect(prepareLocalCrmSources(actor)).rejects.toThrow(/guarded local/);
    expect(mockDb.$transaction).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
});
