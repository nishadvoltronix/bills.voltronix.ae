import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
import type { ZohoTransport } from "@/lib/integrations/transport";
import { IntegrationError } from "@/lib/integrations/config";
import { activateBooksPosting } from "@/lib/services/books-posting-activation";

const mock = vi.hoisted(() => ({ verify: vi.fn(), sourceGuard: vi.fn(), store: {
  user: { findFirst: vi.fn() }, companyIntegrationDestination: { findMany: vi.fn() },
  incomingSyncState: { findUnique: vi.fn(), updateMany: vi.fn() },
} }));
vi.mock("@/lib/db", () => ({ db: mock.store }));
vi.mock("@/lib/integrations/oauth", () => ({ accessToken: vi.fn(async () => "private-fixture-token") }));
vi.mock("@/lib/services/incoming-sync-access", () => ({ assertIncomingSource: mock.sourceGuard }));
vi.mock("@/lib/services/books-operational-setup", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/services/books-operational-setup")>(), verifyOperationalBooksDestination: mock.verify,
}));
const actor: Actor = { id: "operator", email: "operator@example.invalid", name: "Operator", role: "ADMIN" };
const env = { NODE_ENV: "production", APP_ENV: "production", APP_URL: "https://billing.example.invalid",
  DATABASE_URL: "mysql://billing_runtime:fixture@database.example.invalid/billing_operational", DATABASE_TLS_MODE: "verify-full",
  INTEGRATION_TEST_MODE: "false", INTEGRATION_NETWORK_ENABLED: "true", ZOHO_BOOKS_NETWORK_ENABLED: "true",
  ZOHO_BOOKS_WRITE_ENABLED: "false", ZOHO_BOOKS_LIVE_ENABLED: "false", ALLOW_PRODUCTION_ACCOUNTING_WRITES: "false",
  ALLOW_BOOKS_POSTING_ACTIVATION: "true", INCOMING_SYNC_ENABLED: "false", INCOMING_SYNC_NOT_BEFORE_JSON: "",
  ZOHO_BOOKS_DC: "US", ZOHO_BOOKS_ENVIRONMENT: "production", ZOHO_BOOKS_CLIENT_ID: "fixture-client", ZOHO_BOOKS_CLIENT_SECRET: "fixture-secret",
  ZOHO_BOOKS_ORGANIZATIONS_JSON: JSON.stringify([{ organizationId: "1001", name: "Real-shaped fixture company",
    mapping: { verified: true, lineSelectionRequired: true, baseCurrency: "AED", currencies: { AED: { id: "101" } }, categories: {}, taxes: {} } }]),
};
let row: { id: string; companyId: string; scopeHash: string; leaseToken: string | null; leaseExpiresAt: Date | null;
  status: string; backoffUntil: Date | null; nextRunAt: Date };
const fetcher = vi.fn(async () => new Response(JSON.stringify({ code: 0 }), { status: 200 }));
const run = () => activateBooksPosting(actor, "OWNER-REQUEST-20261030", { fetcher, sleep: async () => undefined });
beforeEach(() => {
  vi.resetAllMocks();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "1");
  row = { id: "source", companyId: "company", scopeHash: "scope", leaseToken: null, leaseExpiresAt: null,
    status: "PENDING", backoffUntil: null, nextRunAt: new Date() };
  mock.store.user.findFirst.mockResolvedValue({ id: actor.id });
  mock.sourceGuard.mockResolvedValue(undefined);
  mock.store.companyIntegrationDestination.findMany.mockResolvedValue([{ companyId: row.companyId }]);
  mock.store.incomingSyncState.findUnique.mockImplementation(async () => ({ ...row }));
  mock.store.incomingSyncState.updateMany.mockImplementation(async ({ data }) => { Object.assign(row, data); return { count: 1 }; });
  fetcher.mockImplementation(async () => new Response(JSON.stringify({ code: 0 }), { status: 200 }));
  mock.verify.mockImplementation(async (_actor: Actor, _input: unknown, transport: ZohoTransport) => {
    await transport.request("/books/v3/organizations/1001", { method: "GET" });
    await transport.request("/books/v3/settings/currencies/101", { method: "GET" });
    return { providerReads: 2, destinationVerified: true };
  });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected network"); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("verifies the exact operational destination through GET and releases its source lease without claiming incoming freshness", async () => {
  const report = await run();
  expect(report).toMatchObject({ status: "DESTINATIONS_VERIFIED", providerFinancialWrites: 0, financialWriteFlagsChanged: false,
    organizations: [{ organizationId: "1001", companyId: "company", status: "VERIFIED", providerReads: 2 }] });
  expect(mock.verify).toHaveBeenCalledWith(actor, { companyId: "company", organizationId: "1001",
    organizationName: "Real-shaped fixture company", reference: "OWNER-REQUEST-20261030" }, expect.anything());
  expect(fetcher).toHaveBeenCalledTimes(2);
  for (const [, init] of fetcher.mock.calls as unknown as [unknown, RequestInit][]) expect(init.method).toBe("GET");
  expect(row.leaseToken).toBeNull();
  expect(JSON.stringify(mock.store.incomingSyncState.updateMany.mock.calls)).not.toMatch(/lastSuccessAt|lastHeartbeatAt|watermark/);
  expect(JSON.stringify(report)).not.toContain("private-fixture-token");
});

it.each(["backoffUntil", "nextRunAt", "configured"])("retains an existing %s hold and makes no provider request", async field => {
  const until = new Date(Date.now() + 3_600_000);
  if (field === "configured") vi.stubEnv("INCOMING_SYNC_NOT_BEFORE_JSON", JSON.stringify({ "ZOHO:1001": until.toISOString() }));
  else { row.status = "WAITING_QUOTA"; row[field as "backoffUntil" | "nextRunAt"] = until; }
  const report = await run();
  expect(report.organizations[0]).toMatchObject({ status: "WAITING_QUOTA", retryAt: until.toISOString() });
  expect(mock.verify).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  expect(mock.store.incomingSyncState.updateMany).not.toHaveBeenCalled();
});

it.each([{ destinations: [] }, { destinations: [{ companyId: "company" }, { companyId: "other" }] }])("rejects missing or ambiguous destinations", async ({ destinations }) => {
  mock.store.companyIntegrationDestination.findMany.mockResolvedValue(destinations);
  expect((await run()).organizations[0].code).toBe("EXACT_OPERATIONAL_DESTINATION_REQUIRED");
  expect(mock.verify).not.toHaveBeenCalled();
});

it("rejects absent current administrator membership before acquiring a source lease", async () => {
  mock.store.user.findFirst.mockResolvedValue(null);
  expect((await run()).organizations[0].code).toBe("OPERATIONAL_COMPANY_ACCESS_REQUIRED");
  expect(mock.store.incomingSyncState.findUnique).not.toHaveBeenCalled();
});

it("does not steal another worker's source lease", async () => {
  mock.store.incomingSyncState.updateMany.mockResolvedValue({ count: 0 });
  expect((await run()).organizations[0].code).toBe("INCOMING_SOURCE_BUSY");
  expect(mock.verify).not.toHaveBeenCalled();
});

it("rejects stale source bindings before acquiring a lease or making provider requests", async () => {
  mock.sourceGuard.mockRejectedValue(new IntegrationError("INCOMING_SOURCE_CHANGED", "Fixture source changed", "BLOCKED"));
  expect((await run()).organizations[0].code).toBe("INCOMING_SOURCE_CHANGED");
  expect(mock.store.incomingSyncState.updateMany).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
});

it("retains a source's transient retry schedule even without a quota timestamp", async () => {
  row.status = "RETRY"; row.nextRunAt = new Date(Date.now() + 90_000);
  expect((await run()).organizations[0]).toMatchObject({ status: "WAITING_SOURCE", code: "BOOKS_ACTIVATION_RETRY", retryAt: row.nextRunAt.toISOString() });
  expect(mock.verify).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
});

it("persists new provider quota and preserves its exact reason through transport error handling", async () => {
  fetcher.mockResolvedValue(new Response(JSON.stringify({ code: 45 }), { status: 400 }));
  const report = await run();
  expect(report.organizations[0]).toMatchObject({ status: "WAITING_QUOTA", code: "INCOMING_DAILY_QUOTA" });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(row.backoffUntil!.valueOf()).toBeGreaterThan(Date.now() + 86_300_000);
  expect(row.leaseToken).toBeNull(); expect(row.status).toBe("WAITING_QUOTA");
  expect(mock.store.incomingSyncState.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
    OR: [{ backoffUntil: null }, { backoffUntil: { lt: expect.any(Date) } }],
  }) }));
});

it("stops after a successful read exhausts reserved quota, without certifying partial metadata", async () => {
  fetcher.mockResolvedValue(new Response(JSON.stringify({ code: 0 }), { status: 200, headers: { "x-rate-limit-remaining": "99" } }));
  expect((await run()).organizations[0].status).toBe("WAITING_QUOTA");
  expect(fetcher).toHaveBeenCalledTimes(1); expect(row.leaseToken).toBeNull();
});

it.each([["ZOHO_BOOKS_WRITE_ENABLED", "true"], ["DATABASE_TLS_MODE", "disabled"], ["ALLOW_BOOKS_POSTING_ACTIVATION", "false"],
  ["INCOMING_SYNC_ENABLED", "true"]])("rejects unsafe %s before provider or destination work", async (key, value) => {
  vi.stubEnv(key, value); await expect(run()).rejects.toThrow();
  expect(mock.store.companyIntegrationDestination.findMany).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
});
