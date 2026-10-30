import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  prepareLocalBooksConnections,
  assertLocalBooksConnectionEnvironment,
} from "@/lib/services/books-local-connection";
import type { Actor } from "@/lib/auth";
import { assertMySqlTestDatabase } from "./company-fixtures";

const suffix = randomUUID().slice(0, 8);
let actor: Actor;
beforeAll(async () => {
  assertMySqlTestDatabase();
  vi.stubEnv("APP_URL", "http://127.0.0.1:3000");
  vi.stubEnv("ZOHO_BOOKS_DC", "US");
  vi.stubEnv("ZOHO_BOOKS_ENVIRONMENT", "production");
  vi.stubEnv("ZOHO_BOOKS_CLIENT_ID", "fictional-local-connection-client");
  vi.stubEnv("ZOHO_BOOKS_CLIENT_SECRET", "fictional-local-connection-secret");
  vi.stubEnv(
    "ZOHO_BOOKS_ORGANIZATIONS_JSON",
    JSON.stringify([
      { organizationId: "990011", name: "Fictional connection A" },
      { organizationId: "990022", name: "Fictional connection B" },
    ]),
  );
  for (const name of [
    "INTEGRATION_NETWORK_ENABLED",
    "ZOHO_BOOKS_WRITE_ENABLED",
    "ZOHO_BOOKS_LIVE_ENABLED",
    "ALLOW_PRODUCTION_ACCOUNTING_WRITES",
    "INTEGRATION_TEST_MODE",
  ])
    vi.stubEnv(name, "false");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("No provider calls permitted.");
    }),
  );
  actor = await db.user.create({
    data: {
      email: `local-books-${suffix}@example.invalid`,
      name: "Fictional operator",
      role: "ADMIN",
      passwordHash: "unusable-fixture-password",
    },
  });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await db.$disconnect();
});

describe("local Books connection-only setup on disposable MySQL", () => {
  it("creates separate demo-ineligible-for-live connection workspaces without changing existing companies or creating bills", async () => {
    const beforeCompanies = await db.company.findMany({
      orderBy: { id: "asc" },
    });
    const billCount = await db.bill.count();
    const result = await prepareLocalBooksConnections(actor);
    expect(result.connections).toHaveLength(2);
    expect(result.financialWritesEnabled).toBe(false);
    expect(result.providerRequests).toBe(0);
    for (const row of result.connections) {
      expect(
        await db.company.findUnique({ where: { id: row.companyId } }),
      ).toMatchObject({ isDemo: true, liveAccountingEnabled: false });
      expect(
        await db.companyIntegrationDestination.findFirst({
          where: { companyId: row.companyId },
        }),
      ).toMatchObject({
        liveEnabled: false,
        verifiedAt: null,
        verifiedConfigurationHash: null,
      });
      expect(
        await db.userCompanyMembership.findUnique({
          where: {
            userId_companyId: { userId: actor.id, companyId: row.companyId },
          },
        }),
      ).toMatchObject({ active: true });
    }
    expect(
      await db.company.findMany({
        where: { id: { in: beforeCompanies.map((company) => company.id) } },
        orderBy: { id: "asc" },
      }),
    ).toEqual(beforeCompanies);
    expect(await db.bill.count()).toBe(billCount);
    const events = await db.auditLog.count({
      where: {
        action: "BOOKS_LOCAL_CONNECTION_CHECK_PREPARED",
        actorId: actor.id,
      },
    });
    await prepareLocalBooksConnections(actor);
    expect(
      await db.auditLog.count({
        where: {
          action: "BOOKS_LOCAL_CONNECTION_CHECK_PREPARED",
          actorId: actor.id,
        },
      }),
    ).toBe(events);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("refuses company reassignment and rolls back the entire preparation", async () => {
    const existing = await db.company.create({
      data: { name: `Fictional preserved ${suffix}` },
    });
    await db.companyIntegrationDestination.create({
      data: {
        companyId: existing.id,
        target: "ZOHO",
        organizationId: "990033",
        dataCenter: "US",
        environment: "production",
      },
    });
    vi.stubEnv(
      "ZOHO_BOOKS_ORGANIZATIONS_JSON",
      JSON.stringify([
        { organizationId: "990044", name: "Fictional rollback" },
        { organizationId: "990033", name: "Fictional existing" },
      ]),
    );
    await expect(prepareLocalBooksConnections(actor)).rejects.toMatchObject({
      status: 409,
    });
    expect(
      await db.company.findUnique({
        where: { id: "connection-check-books-990044" },
      }),
    ).toBeNull();
    expect(
      await db.companyIntegrationDestination.findFirst({
        where: { organizationId: "990033" },
      }),
    ).toMatchObject({ companyId: existing.id });
  });
  it("refuses non-admins and accounting-enabled or unguarded environments before mutation", async () => {
    await expect(
      prepareLocalBooksConnections({ ...actor, role: "ACCOUNTS" }),
    ).rejects.toMatchObject({ status: 403 });
    vi.stubEnv("ZOHO_BOOKS_LIVE_ENABLED", "true");
    expect(() => assertLocalBooksConnectionEnvironment()).toThrow(/disabled/);
    vi.stubEnv("ZOHO_BOOKS_LIVE_ENABLED", "false");
    vi.stubEnv("APP_ENV", "production");
    expect(() => assertLocalBooksConnectionEnvironment()).toThrow(/disabled/);
    vi.stubEnv("APP_ENV", "test");
    vi.stubEnv("APP_URL", "https://unverified.example.invalid");
    expect(() => assertLocalBooksConnectionEnvironment()).toThrow(/disabled/);
  });
});
