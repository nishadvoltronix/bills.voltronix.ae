import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";

const mocks = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { $transaction: mocks.transaction } }));
import { prepareManualCompany } from "@/lib/services/manual-company";

const actor: Actor = {
  id: "operator",
  role: "ADMIN",
  name: "Fictional Operator",
  email: "operator@example.invalid",
};
const payload = {
  companyName: "Fictional Manual Company",
  reference: "Owner assignment record 2026-10-29",
};

beforeEach(() => {
  vi.resetAllMocks();
  for (const [key, value] of Object.entries({
    NODE_ENV: "production",
    APP_ENV: "production",
    APP_URL: "https://billing.example.invalid",
    DATABASE_URL:
      "mysql://billing_runtime:fictional@database.example.invalid:3306/billing_operational",
    INTEGRATION_TEST_MODE: "false",
    ALLOW_MANUAL_COMPANY_SETUP: "true",
    ZOHO_BOOKS_WRITE_ENABLED: "false",
    ZOHO_BOOKS_LIVE_ENABLED: "false",
    ALLOW_PRODUCTION_ACCOUNTING_WRITES: "false",
  }))
    vi.stubEnv(key, value);
});
afterEach(() => vi.unstubAllEnvs());

describe("manual company provisioning guards", () => {
  it.each([
    ["ALLOW_MANUAL_COMPANY_SETUP", "false"],
    ["APP_ENV", "development"],
    ["NODE_ENV", "development"],
    ["APP_URL", "http://billing.example.invalid"],
    [
      "DATABASE_URL",
      "mysql://root:fictional@db.invalid:3306/billing_operational",
    ],
    [
      "DATABASE_URL",
      "mysql://runtime:fictional@127.0.0.1:3308/voltronix_billing_dev",
    ],
    ["INTEGRATION_TEST_MODE", "true"],
    ["ZOHO_BOOKS_WRITE_ENABLED", "true"],
    ["ZOHO_BOOKS_LIVE_ENABLED", "true"],
    ["ALLOW_PRODUCTION_ACCOUNTING_WRITES", "true"],
    ["ZOHO_BOOKS_LIVE_ENABLED", ""],
  ])("rejects %s=%s before accessing the database", async (key, value) => {
    vi.stubEnv(key, value);
    await expect(prepareManualCompany(actor, payload)).rejects.toMatchObject({
      status: 409,
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it.each(["ACCOUNTS", "DATA_ENTRY", "MANAGEMENT"] as const)(
    "rejects the %s role",
    async (role) => {
      await expect(
        prepareManualCompany({ ...actor, role }, payload),
      ).rejects.toMatchObject({ status: 403 });
      expect(mocks.transaction).not.toHaveBeenCalled();
    },
  );
  it.each(["[DEMO] Company", "[CONNECTION CHECK] Company"])(
    "rejects the fixture name %s",
    async (companyName) => {
      await expect(
        prepareManualCompany(actor, { ...payload, companyName }),
      ).rejects.toMatchObject({ status: 422 });
      expect(mocks.transaction).not.toHaveBeenCalled();
    },
  );
  it("reaches provisioning without any Books credentials or organization profile", async () => {
    for (const key of [
      "ZOHO_BOOKS_CLIENT_ID",
      "ZOHO_BOOKS_CLIENT_SECRET",
      "ZOHO_BOOKS_ORGANIZATIONS_JSON",
      "ZOHO_BOOKS_REFRESH_TOKEN",
    ])
      vi.stubEnv(key, "");
    mocks.transaction.mockResolvedValue({ created: true });
    await expect(prepareManualCompany(actor, payload)).resolves.toEqual({
      created: true,
    });
    expect(mocks.transaction).toHaveBeenCalledOnce();
  });
});
