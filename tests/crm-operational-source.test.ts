import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
import { HttpError } from "@/lib/http";
import { VERIFIED_CRM_JOB_MAPPING } from "@/lib/integrations/crm";

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), access: vi.fn(), user: vi.fn(), company: vi.fn(),
  legacy: vi.fn(), sharing: vi.fn(), source: vi.fn(), create: vi.fn(), jobs: vi.fn(), snapshots: vi.fn(), associations: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { $transaction: mocks.transaction } }));
vi.mock("@/lib/company", () => ({ requireCompanyAccess: mocks.access }));
import { prepareOperationalCrmSource } from "@/lib/services/crm-operational-source";

const actor: Actor = { id: "operator", role: "ADMIN", name: "Fictional Operator", email: "operator@example.invalid" };
const payload = { companyId: "fictional-company", booksOrganizationId: "1001", crmOrganizationId: "2001", reference: "Fictional reviewed source assignment" };
const identity = { organizationId: "2001", dataCenter: "US", environment: "production" };
const destination = { organizationId: "1001", dataCenter: "US", environment: "production" };
const company = { active: true, isDemo: false, name: "Fictional Operating Company", integrationDestinations: [destination] };
const tx = { user: { findUnique: mocks.user }, company: { findUnique: mocks.company },
  companyIntegrationDestination: { findFirst: mocks.legacy },
  companyCrmSource: { findMany: mocks.sharing, findUnique: mocks.source, create: mocks.create },
  job: { count: mocks.jobs }, crmJobSnapshot: { count: mocks.snapshots }, booksProjectAssociation: { count: mocks.associations },
  auditLog: { create: mocks.audit } };

beforeEach(() => {
  vi.resetAllMocks();
  for (const [key, value] of Object.entries({
    APP_ENV: "production", NODE_ENV: "production", APP_URL: "https://billing.example.invalid", INTEGRATION_TEST_MODE: "false",
    DATABASE_URL: "mysql://billing_runtime:fictional-password@database.example.invalid:3306/billing_operational",
    DATABASE_TLS_MODE: "verify-full", MANUAL_ENTRY_ONLY: "false", ALLOW_CRM_OPERATIONAL_SOURCE_SETUP: "true",
    ZOHO_BOOKS_WRITE_ENABLED: "false", ZOHO_BOOKS_LIVE_ENABLED: "false", ALLOW_PRODUCTION_ACCOUNTING_WRITES: "false",
    INTEGRATION_NETWORK_ENABLED: "false", ZOHO_BOOKS_NETWORK_ENABLED: "false", ZOHO_CRM_NETWORK_ENABLED: "false",
    ZOHO_BOOKS_DC: "US", ZOHO_BOOKS_ENVIRONMENT: "production", ZOHO_BOOKS_CLIENT_ID: "fictional-client", ZOHO_BOOKS_CLIENT_SECRET: "fictional-secret",
    ZOHO_BOOKS_ORGANIZATIONS_JSON: JSON.stringify([{ organizationId: "1001", name: company.name }]),
    ZOHO_CRM_DC: "US", ZOHO_CRM_ENVIRONMENT: "production", ZOHO_CRM_ORGANIZATION_ID: "2001",
    ZOHO_CRM_CLIENT_ID: "fictional-crm-client", ZOHO_CRM_CLIENT_SECRET: "fictional-crm-secret", ZOHO_CRM_MAPPING_JSON: JSON.stringify(VERIFIED_CRM_JOB_MAPPING),
  })) vi.stubEnv(key, value);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No provider calls are permitted during source preparation."); }));
  mocks.transaction.mockImplementation(work => work(tx));
  mocks.user.mockResolvedValue({ active: true, role: "ADMIN" });
  mocks.company.mockResolvedValue(structuredClone(company));
  mocks.legacy.mockResolvedValue(null);
  mocks.sharing.mockResolvedValue([]);
  mocks.source.mockResolvedValue(null);
  for (const count of [mocks.jobs, mocks.snapshots, mocks.associations]) count.mockResolvedValue(0);
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("operational CRM source preparation", () => {
  it.each([
    ["ALLOW_CRM_OPERATIONAL_SOURCE_SETUP", "false"], ["APP_ENV", "development"], ["NODE_ENV", "development"],
    ["APP_URL", "http://billing.example.invalid"], ["DATABASE_URL", "mysql://fixture:fictional@127.0.0.1:3308/voltronix_billing_dev"],
    ["INTEGRATION_TEST_MODE", "true"], ["DATABASE_TLS_MODE", "disabled"], ["NODE_TLS_REJECT_UNAUTHORIZED", "0"],
    ["MANUAL_ENTRY_ONLY", "true"], ["ZOHO_BOOKS_WRITE_ENABLED", "true"], ["ZOHO_BOOKS_LIVE_ENABLED", "true"],
    ["ALLOW_PRODUCTION_ACCOUNTING_WRITES", "true"], ["ZOHO_BOOKS_WRITE_ENABLED", ""],
  ])("refuses %s=%s before accessing records", async (key, value) => {
    vi.stubEnv(key, value);
    await expect(prepareOperationalCrmSource(actor, payload)).rejects.toMatchObject({ status: 409 });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it.each(["ACCOUNTS", "MANAGEMENT", "DATA_ENTRY"] as const)("rejects the %s role", async role => {
    await expect(prepareOperationalCrmSource({ ...actor, role }, payload)).rejects.toMatchObject({ status: 403 });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it.each([null, { active: false, role: "ADMIN" }, { active: true, role: "ACCOUNTS" }])("rechecks the stored Admin identity", async user => {
    mocks.user.mockResolvedValue(user);
    await expect(prepareOperationalCrmSource(actor, payload)).rejects.toMatchObject({ status: 403 });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each(["ZOHO_CRM_ENVIRONMENT", "ZOHO_BOOKS_ENVIRONMENT"])("rejects a sandbox %s", async key => {
    vi.stubEnv(key, "sandbox");
    await expect(prepareOperationalCrmSource(actor, payload)).rejects.toMatchObject({ status: 409 });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("requires the exact CRM organization and explicit verified field mapping", async () => {
    await expect(prepareOperationalCrmSource(actor, { ...payload, crmOrganizationId: "2002" })).rejects.toMatchObject({ status: 409 });
    vi.stubEnv("ZOHO_CRM_MAPPING_JSON", "");
    await expect(prepareOperationalCrmSource(actor, payload)).rejects.toMatchObject({ status: 409 });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it.each([{ active: false }, { isDemo: true }, { name: "Other Company" }, { integrationDestinations: [] },
    { integrationDestinations: [destination, { ...destination, organizationId: "1002" }] },
    ...["organizationId", "dataCenter", "environment"].map(key => ({ integrationDestinations: [{ ...destination, [key]: "wrong" }] })),
  ])("preserves an ineligible or differently assigned company", async override => {
    mocks.company.mockResolvedValue({ ...company, ...override });
    await expect(prepareOperationalCrmSource(actor, payload)).rejects.toMatchObject({ status: 409 });
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("requires current membership in the target and every active company sharing the grant", async () => {
    mocks.access.mockRejectedValueOnce(new HttpError(404, "Not found."));
    await expect(prepareOperationalCrmSource(actor, payload)).rejects.toMatchObject({ status: 404 });
    mocks.sharing.mockResolvedValue([{ companyId: "other-company" }]);
    mocks.access.mockImplementation(async (_actor, companyId) => { if (companyId === "other-company") throw new HttpError(404, "Not found."); });
    await expect(prepareOperationalCrmSource(actor, payload)).rejects.toMatchObject({ status: 404 });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("does not replace a legacy destination or a different shared source", async () => {
    mocks.legacy.mockResolvedValue({ companyId: "legacy-company" });
    await expect(prepareOperationalCrmSource(actor, payload)).rejects.toMatchObject({ status: 409 });
    mocks.legacy.mockResolvedValue(null);
    mocks.source.mockResolvedValue({ companyId: payload.companyId, ...identity, organizationId: "2002" });
    await expect(prepareOperationalCrmSource(actor, payload)).rejects.toMatchObject({ status: 409 });
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled();
  });
  it.each(["jobs", "snapshots", "associations"] as const)("does not assign a source over existing unbound %s", async count => {
    mocks[count].mockResolvedValue(1);
    await expect(prepareOperationalCrmSource(actor, payload)).rejects.toMatchObject({ status: 409 });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("creates only an audited source binding before OAuth and reuses it without duplicate audit or changing records", async () => {
    const result = await prepareOperationalCrmSource(actor, payload);
    expect(result).toEqual({ companyId: payload.companyId, booksOrganizationId: "1001", crmSource: identity,
      created: true, providerVerified: false, providerRequests: 0, financialWritesEnabled: false });
    expect(mocks.create).toHaveBeenCalledWith({ data: { companyId: payload.companyId, ...identity } });
    expect(mocks.audit).toHaveBeenCalledWith({ data: expect.objectContaining({ actorId: actor.id, companyId: payload.companyId,
      action: "CRM_OPERATIONAL_SOURCE_PREPARED", details: expect.objectContaining({ reference: payload.reference, providerVerified: false }) }) });
    mocks.source.mockResolvedValue({ companyId: payload.companyId, ...identity });
    mocks.jobs.mockResolvedValue(5);
    expect(await prepareOperationalCrmSource(actor, payload)).toMatchObject({ created: false, providerVerified: false });
    expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.audit).toHaveBeenCalledTimes(1);
  });
});
