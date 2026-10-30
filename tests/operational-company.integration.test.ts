import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { assertMySqlTestDatabase } from "./company-fixtures";

// Runtime guards are exercised in operational-company.test.ts. Provisioning
// writes below are confined to the disposable MySQL database; all networking
// stays disabled and no operational or provider database is contacted.
vi.mock("@/lib/integrations/config", async original => ({
  ...(await original<typeof import("@/lib/integrations/config")>()),
  productionBooksRuntimeReady: () => true,
}));
import { prepareOperationalBooksCompany } from "@/lib/services/operational-company";

const tag = randomUUID().slice(0, 8);
const organizationId = `61${BigInt(`0x${tag}`).toString()}`;
const payload = {
  companyName: `Fictional Operating Company ${tag}`,
  organizationId,
  reference: "Fictional reviewed company and staff assignment",
};
let operator: Actor, staff: Actor, outsider: Actor;
const companyId = `company-books-ae-${organizationId}`;

beforeAll(async () => {
  assertMySqlTestDatabase();
  [operator, staff, outsider] = await Promise.all((["ADMIN", "ACCOUNTS", "ADMIN"] as const).map((role, index) =>
    db.user.create({ data: { email: `operational-${tag}-${index}@example.invalid`,
      name: `Fictional operational operator ${index}`, role, passwordHash: "disabled-test-login" } })));
});
beforeEach(() => {
  for (const [key, value] of Object.entries({
    ALLOW_OPERATIONAL_COMPANY_SETUP: "true", ZOHO_BOOKS_WRITE_ENABLED: "false", ZOHO_BOOKS_LIVE_ENABLED: "false",
    ALLOW_PRODUCTION_ACCOUNTING_WRITES: "false", INTEGRATION_NETWORK_ENABLED: "false", ZOHO_BOOKS_NETWORK_ENABLED: "false",
    ZOHO_BOOKS_DC: "AE", ZOHO_BOOKS_ENVIRONMENT: "production", ZOHO_BOOKS_CLIENT_ID: "fictional-client",
    ZOHO_BOOKS_CLIENT_SECRET: "fictional-secret", ZOHO_BOOKS_REFRESH_TOKEN: "", ZOHO_BOOKS_REFRESH_TOKENS_JSON: "",
    ZOHO_BOOKS_ORGANIZATIONS_JSON: JSON.stringify([{ organizationId, name: payload.companyName }]),
  })) vi.stubEnv(key, value);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Provider requests are forbidden during company setup."); }));
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
afterAll(async () => { await db.$disconnect(); });

describe("operational Books company and staff provisioning in MySQL", () => {
  it("creates the operating company, exact destination and audited owner/staff membership with writes disabled", async () => {
    expect(await prepareOperationalBooksCompany(operator, { ...payload, memberEmail: staff.email.toUpperCase() }))
      .toMatchObject({ companyId, created: true, destinationCreated: true, memberAssigned: true,
        providerRequests: 0, financialWritesEnabled: false });
    const company = await db.company.findUniqueOrThrow({ where: { id: companyId },
      include: { memberships: true, integrationDestinations: true } });
    expect(company).toMatchObject({ name: payload.companyName, active: true, isDemo: false, liveAccountingEnabled: false });
    expect(company.memberships.map(row => row.userId).sort()).toEqual([operator.id, staff.id].sort());
    expect(company.memberships.every(row => row.active)).toBe(true);
    expect(company.integrationDestinations).toHaveLength(1);
    expect(company.integrationDestinations[0]).toMatchObject({ target: "ZOHO", organizationId,
      dataCenter: "AE", environment: "production", liveEnabled: false, verifiedAt: null, verifiedConfigurationHash: null });
    const audits = await db.auditLog.findMany({ where: { companyId } });
    expect(audits.map(event => event.action).sort()).toEqual(["COMPANY_MEMBERSHIP_GRANTED", "OPERATIONAL_COMPANY_PREPARED"]);
    expect(audits.every(event => event.actorId === operator.id)).toBe(true);
    for (const event of audits) expect(event.details).toMatchObject({ reference: payload.reference, source: "reauthenticated_operator" });
  });

  it("repeated company/staff preparation is idempotent", async () => {
    expect(await prepareOperationalBooksCompany(operator, { ...payload, memberEmail: staff.email }))
      .toMatchObject({ companyId, created: false, destinationCreated: false, memberAssigned: false });
    expect(await db.auditLog.count({ where: { companyId } })).toBe(2);
    expect(await db.companyIntegrationDestination.count({ where: { companyId } })).toBe(1);
    expect(await db.userCompanyMembership.count({ where: { companyId } })).toBe(2);
  });

  it("denies outsiders and stale administrator claims without granting memberships", async () => {
    await expect(prepareOperationalBooksCompany(outsider, { ...payload, memberEmail: outsider.email })).rejects.toMatchObject({ status: 404 });
    await expect(prepareOperationalBooksCompany({ ...staff, role: "ADMIN" }, payload)).rejects.toMatchObject({ status: 403 });
    expect(await db.userCompanyMembership.count({ where: { companyId, userId: outsider.id } })).toBe(0);
    expect(await db.auditLog.count({ where: { companyId } })).toBe(2);
  });

  it("reactivates a revoked staff membership once and preserves the global role", async () => {
    await db.userCompanyMembership.update({ where: { userId_companyId: { userId: staff.id, companyId } }, data: { active: false } });
    expect(await prepareOperationalBooksCompany(operator, { ...payload, memberEmail: staff.email })).toMatchObject({ memberAssigned: true });
    const event = await db.auditLog.findFirstOrThrow({ where: { companyId, entityId: staff.id, action: "COMPANY_MEMBERSHIP_GRANTED" },
      orderBy: { createdAt: "desc" } });
    expect(event.details).toMatchObject({ previousActive: false, active: true });
    expect((await db.user.findUniqueOrThrow({ where: { id: staff.id } })).role).toBe("ACCOUNTS");
    expect(await prepareOperationalBooksCompany(operator, { ...payload, memberEmail: staff.email })).toMatchObject({ memberAssigned: false });
    expect(await db.auditLog.count({ where: { companyId } })).toBe(3);
  });

  it("rolls back missing and inactive member requests before creating a company or binding", async () => {
    const other = { ...payload, organizationId: `${organizationId}1`, companyName: `Fictional Uncommitted Company ${tag}` };
    vi.stubEnv("ZOHO_BOOKS_ORGANIZATIONS_JSON", JSON.stringify([{ organizationId: other.organizationId, name: other.companyName }]));
    await expect(prepareOperationalBooksCompany(operator, { ...other, memberEmail: "missing@example.invalid" })).rejects.toMatchObject({ status: 422 });
    await db.user.update({ where: { id: outsider.id }, data: { active: false } });
    await expect(prepareOperationalBooksCompany(operator, { ...other, memberEmail: outsider.email })).rejects.toMatchObject({ status: 422 });
    expect(await db.company.count({ where: { name: other.companyName } })).toBe(0);
    expect(await db.companyIntegrationDestination.count({ where: { organizationId: other.organizationId } })).toBe(0);
    expect(await db.auditLog.count({ where: { companyId: `company-books-ae-${other.organizationId}` } })).toBe(0);
  });

  it("preserves an existing different owner of the exact Books destination", async () => {
    const otherId = `${organizationId}2`, name = `Fictional Bound Company ${tag}`;
    const existing = await db.company.create({ data: { name: `Fictional Existing Owner ${tag}`, isDemo: false,
      integrationDestinations: { create: { target: "ZOHO", organizationId: otherId, dataCenter: "AE", environment: "production" } } } });
    vi.stubEnv("ZOHO_BOOKS_ORGANIZATIONS_JSON", JSON.stringify([{ organizationId: otherId, name }]));
    await expect(prepareOperationalBooksCompany(operator, { ...payload, organizationId: otherId, companyName: name, memberEmail: staff.email }))
      .rejects.toMatchObject({ status: 409 });
    expect(await db.company.count({ where: { name } })).toBe(0);
    const destination = await db.companyIntegrationDestination.findFirstOrThrow({ where: { organizationId: otherId } });
    expect(destination.companyId).toBe(existing.id);
    expect(await db.userCompanyMembership.count({ where: { companyId: existing.id } })).toBe(0);
  });
});
