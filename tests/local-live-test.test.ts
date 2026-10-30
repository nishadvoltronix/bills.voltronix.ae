import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZohoConfig } from "@/lib/integrations/config";
import { assertLocalBooksTestEnvironment, assertLocalBooksTestReadQuota, assertLocalBooksTestSetupEnvironment,
  assertLocalLiveTestWriteCapability, createLocalLiveTestWriteCapability } from "@/lib/integrations/local-live-test";

vi.mock("@/lib/db", () => ({ db: {} }));
const environment = { APP_ENV: "development", APP_URL: "http://127.0.0.1:3000",
  DATABASE_URL: "mysql://fictional:fictional@127.0.0.1:3308/voltronix_billing_dev", MANUAL_ENTRY_ONLY: "false",
  ZOHO_BOOKS_WRITE_ENABLED: "false", ZOHO_BOOKS_LIVE_ENABLED: "false", ALLOW_PRODUCTION_ACCOUNTING_WRITES: "false",
  INTEGRATION_TEST_MODE: "false", ALLOW_LOCAL_BOOKS_TEST_SETUP: "true" };
beforeEach(() => { for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value); });
afterEach(() => vi.unstubAllEnvs());

describe("one local bill permission's runtime and opaque authority", () => {
  it("accepts the guarded local runtime without enabling normal write flags", () => {
    expect(() => assertLocalBooksTestEnvironment()).not.toThrow();
    expect(() => assertLocalBooksTestSetupEnvironment()).not.toThrow();
    expect(process.env.ZOHO_BOOKS_WRITE_ENABLED).toBe("false");
  });
  it.each(["ZOHO_BOOKS_WRITE_ENABLED", "ZOHO_BOOKS_LIVE_ENABLED", "ALLOW_PRODUCTION_ACCOUNTING_WRITES", "INTEGRATION_TEST_MODE", "MANUAL_ENTRY_ONLY"])("rejects %s being enabled", key => {
    vi.stubEnv(key, "true"); expect(() => assertLocalBooksTestEnvironment()).toThrow(/local|disabled/i);
  });
  it.each(["ZOHO_BOOKS_WRITE_ENABLED", "ZOHO_BOOKS_LIVE_ENABLED", "ALLOW_PRODUCTION_ACCOUNTING_WRITES", "INTEGRATION_TEST_MODE", "MANUAL_ENTRY_ONLY"])("requires an explicit false value for %s", key => {
    vi.stubEnv(key, ""); expect(() => assertLocalBooksTestEnvironment()).toThrow();
  });
  it.each([
    ["APP_ENV", "production"], ["APP_URL", "https://bills.example.invalid"],
    ["DATABASE_URL", "mysql://fictional:fictional@127.0.0.1:3308/another_database"],
    ["DATABASE_URL", "mysql://fictional:fictional@remote.example.invalid:3308/voltronix_billing_dev"],
  ])("rejects changed runtime %s", (key, value) => { vi.stubEnv(key, value); expect(() => assertLocalBooksTestEnvironment()).toThrow(); });
  it("requires operator setup enablement only to issue a permission", () => {
    vi.stubEnv("ALLOW_LOCAL_BOOKS_TEST_SETUP", "false");
    expect(() => assertLocalBooksTestEnvironment()).not.toThrow();
    expect(() => assertLocalBooksTestSetupEnvironment()).toThrow(/operator/);
  });
  it("rejects forged or serialized capability objects before any database access", async () => {
    const config = {} as ZohoConfig;
    await expect(assertLocalLiveTestWriteCapability({ kind: "LOCAL_ONE_BILL_TEST" }, config)).rejects.toMatchObject({ code: "LOCAL_TEST_PERMISSION_REQUIRED" });
    const issued = createLocalLiveTestWriteCapability("fictional-job", "fictional-lease");
    expect(Object.isFrozen(issued)).toBe(true);
    await expect(assertLocalLiveTestWriteCapability(JSON.parse(JSON.stringify(issued)), config)).rejects.toMatchObject({ code: "LOCAL_TEST_PERMISSION_REQUIRED" });
  });
  it.each([null, "", "-8", "0", "1", "15", "unknown", "1.5", "9007199254740992"])("refuses insufficient or unverifiable quota %s", value => {
    expect(() => assertLocalBooksTestReadQuota(value)).toThrow(/quota/);
  });
  it.each(["16", "100", "5000"])("accepts explicit bounded read capacity %s", value => {
    expect(() => assertLocalBooksTestReadQuota(value)).not.toThrow();
  });
});
