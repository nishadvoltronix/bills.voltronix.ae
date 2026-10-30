import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import type { Actor } from "@/lib/auth";
import { HttpError } from "@/lib/http";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  access: vi.fn(),
  user: vi.fn(),
  companyFind: vi.fn(),
  companyByName: vi.fn(),
  companyCreate: vi.fn(),
  destinationFind: vi.fn(),
  destinationCreate: vi.fn(),
  audit: vi.fn(),
  membership: vi.fn(),
  grantMembership: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: { $transaction: mocks.transaction } }));
vi.mock("@/lib/company", () => ({ requireCompanyAccess: mocks.access }));
import { prepareOperationalBooksCompany } from "@/lib/services/operational-company";

const actor: Actor = { id: "operator", role: "ADMIN", name: "Fictional Operator", email: "operator@example.invalid" };
const payload = { companyName: "Fictional Operating Company", organizationId: "1001", reference: "Owner assignment record 2026-10-29" };
const companyId = "company-books-us-1001";
type CompanyRecord = { id: string; name: string; active: boolean; isDemo: boolean; liveAccountingEnabled: boolean };
type Binding = { companyId: string; target: string; organizationId: string; dataCenter: string; environment: string; liveEnabled: boolean; verifiedAt?: Date | null };
let company: CompanyRecord | null;
let binding: Binding | null;
const tx = {
  user: { findUnique: mocks.user },
  company: { findUnique: mocks.companyFind, findFirst: mocks.companyByName, create: mocks.companyCreate },
  companyIntegrationDestination: { findUnique: mocks.destinationFind, create: mocks.destinationCreate },
  auditLog: { create: mocks.audit },
  userCompanyMembership: { findUnique: mocks.membership, upsert: mocks.grantMembership },
};
function existingCompany(overrides: Partial<CompanyRecord> = {}): CompanyRecord {
  return { id: companyId, name: payload.companyName, active: true, isDemo: false, liveAccountingEnabled: false, ...overrides };
}
function existingBinding(overrides: Partial<Binding> = {}): Binding {
  return { companyId, target: "ZOHO", organizationId: payload.organizationId, dataCenter: "US", environment: "production", liveEnabled: false, ...overrides };
}

beforeEach(() => {
  vi.resetAllMocks();
  company = null;
  binding = null;
  const environment = {
    NODE_ENV: "production",
    APP_ENV: "production",
    APP_URL: "https://billing.example.invalid",
    DATABASE_URL: "mysql://billing_runtime:fictional-password@database.example.invalid:3306/billing_operational",
    INTEGRATION_TEST_MODE: "false",
    ALLOW_OPERATIONAL_COMPANY_SETUP: "true",
    ZOHO_BOOKS_WRITE_ENABLED: "false",
    ZOHO_BOOKS_LIVE_ENABLED: "false",
    ALLOW_PRODUCTION_ACCOUNTING_WRITES: "false",
    INTEGRATION_NETWORK_ENABLED: "false",
    ZOHO_BOOKS_NETWORK_ENABLED: "false",
    ZOHO_BOOKS_DC: "US",
    ZOHO_BOOKS_ENVIRONMENT: "production",
    ZOHO_BOOKS_CLIENT_ID: "fictional-client",
    ZOHO_BOOKS_CLIENT_SECRET: "fictional-secret",
    ZOHO_BOOKS_REFRESH_TOKEN: "",
    ZOHO_BOOKS_REFRESH_TOKENS_JSON: "",
    ZOHO_BOOKS_ORGANIZATIONS_JSON: JSON.stringify([
      { organizationId: payload.organizationId, name: payload.companyName },
      { organizationId: "1002", name: "Fictional Second Company" },
    ]),
  };
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Provider calls are forbidden during company preparation."); }));
  mocks.transaction.mockImplementation((work) => work(tx));
  mocks.user.mockResolvedValue({ active: true, role: "ADMIN" });
  mocks.companyFind.mockImplementation(async () => company);
  mocks.companyByName.mockResolvedValue(null);
  mocks.destinationFind.mockImplementation(async () => binding);
  mocks.companyCreate.mockImplementation(async ({ data }) => {
    company = existingCompany(data);
    return company;
  });
  mocks.destinationCreate.mockImplementation(async ({ data }) => {
    binding = data;
    return binding;
  });
  mocks.access.mockResolvedValue({ id: companyId });
  mocks.audit.mockResolvedValue({ id: "fictional-audit-event" });
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("operational Books company preparation", () => {
  it.each([
    ["ALLOW_OPERATIONAL_COMPANY_SETUP", "false"],
    ["APP_ENV", "development"],
    ["NODE_ENV", "development"],
    ["APP_URL", "http://billing.example.invalid"],
    ["DATABASE_URL", "mysql://fixture:fictional@127.0.0.1:3308/voltronix_billing_dev"],
    ["INTEGRATION_TEST_MODE", "true"],
    ["ZOHO_BOOKS_WRITE_ENABLED", "true"],
    ["ZOHO_BOOKS_LIVE_ENABLED", "true"],
    ["ALLOW_PRODUCTION_ACCOUNTING_WRITES", "true"],
    ["ZOHO_BOOKS_WRITE_ENABLED", ""],
  ])("blocks %s=%s before any database transaction", async (key, value) => {
    vi.stubEnv(key, value);
    await expect(prepareOperationalBooksCompany(actor, payload)).rejects.toMatchObject({ status: 409 });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it.each(["ACCOUNTS", "MANAGEMENT", "DATA_ENTRY"] as const)("rejects a %s caller before database access", async (role) => {
    await expect(prepareOperationalBooksCompany({ ...actor, role }, payload)).rejects.toMatchObject({ status: 403 });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it.each([null, { active: false, role: "ADMIN" }, { active: true, role: "ACCOUNTS" }])("rechecks the operator's active administrator status inside the transaction", async (operator) => {
    mocks.user.mockResolvedValue(operator);
    await expect(prepareOperationalBooksCompany(actor, payload)).rejects.toMatchObject({ status: 403 });
    expect(mocks.companyCreate).not.toHaveBeenCalled();
    expect(mocks.destinationCreate).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it.each([
    { ...payload, companyName: "Fictional Second Company" },
    { ...payload, organizationId: "1002" },
    { ...payload, organizationId: "9999" },
  ])("requires the exact configured organization and company-name pair", async (input) => {
    await expect(prepareOperationalBooksCompany(actor, input)).rejects.toMatchObject({ status: 422 });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it.each(["[DEMO] Company", "[CONNECTION CHECK] Company"])("does not treat %s as an operating profile", async (name) => {
    vi.stubEnv("ZOHO_BOOKS_ORGANIZATIONS_JSON", JSON.stringify([{ organizationId: "1001", name }]));
    await expect(prepareOperationalBooksCompany(actor, { ...payload, companyName: name })).rejects.toMatchObject({ status: 422 });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects a sandbox profile before creating operational records", async () => {
    vi.stubEnv("ZOHO_BOOKS_ENVIRONMENT", "sandbox");
    await expect(prepareOperationalBooksCompany(actor, payload)).rejects.toMatchObject({ status: 409 });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("creates a disabled real company with operator membership and exact disabled destination, then audits the assignment", async () => {
    const result = await prepareOperationalBooksCompany(actor, payload);
    expect(result).toEqual({ companyId, organizationId: "1001", created: true, destinationCreated: true, memberAssigned: false, providerRequests: 0, financialWritesEnabled: false });
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    expect(mocks.companyCreate).toHaveBeenCalledWith({ data: {
      id: companyId, name: payload.companyName, isDemo: false, liveAccountingEnabled: false,
      memberships: { create: { userId: actor.id } },
    } });
    expect(mocks.destinationCreate).toHaveBeenCalledWith({ data: existingBinding() });
    expect(mocks.audit).toHaveBeenCalledWith({ data: expect.objectContaining({
      actorId: actor.id, companyId, action: "OPERATIONAL_COMPANY_PREPARED", entityType: "Company", entityId: companyId,
      details: expect.objectContaining({ organizationId: "1001", reference: payload.reference, providerVerified: false, financialWritesEnabled: false }),
    }) });
  });

  it("repeated setup preserves existing records and verification without granting memberships again", async () => {
    await prepareOperationalBooksCompany(actor, payload);
    company!.liveAccountingEnabled = true;
    binding!.liveEnabled = true;
    binding!.verifiedAt = new Date("2026-10-28T00:00:00Z");
    const before = structuredClone({ company, binding });
    const result = await prepareOperationalBooksCompany(actor, payload);
    expect(result).toMatchObject({ created: false, destinationCreated: false, financialWritesEnabled: false });
    expect({ company, binding }).toEqual(before);
    expect(mocks.companyCreate).toHaveBeenCalledTimes(1);
    expect(mocks.destinationCreate).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.access).toHaveBeenCalledWith(actor, companyId, tx);
  });

  it("preserves a destination already assigned to another or connection-check company", async () => {
    binding = existingBinding({ companyId: "connection-check-books-1001" });
    await expect(prepareOperationalBooksCompany(actor, payload)).rejects.toMatchObject({ status: 409 });
    expect(mocks.companyCreate).not.toHaveBeenCalled();
    expect(mocks.destinationCreate).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(binding.companyId).toBe("connection-check-books-1001");
  });

  it.each([{ isDemo: true }, { active: false }, { name: "Different company" }])("refuses to repurpose an existing company", async (overrides) => {
    company = existingCompany(overrides);
    await expect(prepareOperationalBooksCompany(actor, payload)).rejects.toMatchObject({ status: 409 });
    expect(mocks.companyCreate).not.toHaveBeenCalled();
    expect(mocks.destinationCreate).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("preserves an existing company with the same name and another identity", async () => {
    mocks.companyByName.mockResolvedValue({ id: "preexisting-company" });
    await expect(prepareOperationalBooksCompany(actor, payload)).rejects.toMatchObject({ status: 409 });
    expect(mocks.companyCreate).not.toHaveBeenCalled();
    expect(mocks.destinationCreate).not.toHaveBeenCalled();
  });

  it("requires membership before reusing a company or adding its missing destination", async () => {
    company = existingCompany();
    mocks.access.mockRejectedValue(new HttpError(403, "Company access is required."));
    await expect(prepareOperationalBooksCompany(actor, payload)).rejects.toMatchObject({ status: 403 });
    expect(mocks.access).toHaveBeenCalledWith(actor, companyId, tx);
    expect(mocks.destinationCreate).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("assigns an explicitly selected active staff member and audits the exact company without changing roles or verification", async () => {
    company = existingCompany({ liveAccountingEnabled: true });
    binding = existingBinding({ liveEnabled: true, verifiedAt: new Date("2026-10-30T00:00:00Z") });
    const before = structuredClone({ company, binding });
    mocks.user.mockImplementation(async ({ where }) => where.email
      ? { id: "staff", active: true } : { active: true, role: "ADMIN" });
    mocks.membership.mockResolvedValue({ active: false });
    const result = await prepareOperationalBooksCompany(actor, { ...payload, memberEmail: "Staff@example.invalid" });
    expect(result).toMatchObject({ companyId, created: false, destinationCreated: false, memberAssigned: true });
    expect(mocks.user).toHaveBeenCalledWith({ where: { email: "staff@example.invalid" }, select: { id: true, active: true } });
    expect(mocks.grantMembership).toHaveBeenCalledWith({
      where: { userId_companyId: { userId: "staff", companyId } },
      create: { userId: "staff", companyId }, update: { active: true },
    });
    expect(mocks.audit).toHaveBeenCalledWith({ data: expect.objectContaining({
      actorId: actor.id, companyId, action: "COMPANY_MEMBERSHIP_GRANTED", entityId: "staff",
      details: { reference: payload.reference, source: "reauthenticated_operator", previousActive: false, active: true },
    }) });
    expect({ company, binding }).toEqual(before);
    expect(mocks.companyCreate).not.toHaveBeenCalled();
    expect(mocks.destinationCreate).not.toHaveBeenCalled();
  });

  it.each([null, { id: "staff", active: false }])("refuses a missing or inactive requested staff member before creating company records", async member => {
    mocks.user.mockResolvedValueOnce({ active: true, role: "ADMIN" }).mockResolvedValueOnce(member);
    await expect(prepareOperationalBooksCompany(actor, { ...payload, memberEmail: "staff@example.invalid" })).rejects.toMatchObject({ status: 422 });
    expect(mocks.companyCreate).not.toHaveBeenCalled();
    expect(mocks.grantMembership).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("does not let an outsider administrator grant staff access to an existing company", async () => {
    company = existingCompany();
    binding = existingBinding();
    mocks.user.mockResolvedValueOnce({ active: true, role: "ADMIN" }).mockResolvedValueOnce({ id: "staff", active: true });
    mocks.access.mockRejectedValue(new HttpError(404, "Company or record not found."));
    await expect(prepareOperationalBooksCompany(actor, { ...payload, memberEmail: "staff@example.invalid" })).rejects.toMatchObject({ status: 404 });
    expect(mocks.grantMembership).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("preserves an already active staff membership without duplicate audits", async () => {
    company = existingCompany();
    binding = existingBinding();
    mocks.user.mockResolvedValueOnce({ active: true, role: "ADMIN" }).mockResolvedValueOnce({ id: "staff", active: true });
    mocks.membership.mockResolvedValue({ active: true });
    await expect(prepareOperationalBooksCompany(actor, { ...payload, memberEmail: "staff@example.invalid" })).resolves.toMatchObject({ memberAssigned: false });
    expect(mocks.grantMembership).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
