import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertWrite,
  booksTestConfigurationHash,
  getConfig,
  validBooksTestAuthorization,
  type ZohoConfig,
} from "@/lib/integrations/config";

const now = new Date("2026-10-27T06:00:00Z");
function environment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    ZOHO_BOOKS_DC: "US",
    ZOHO_BOOKS_ORGANIZATION_ID: "100",
    ZOHO_BOOKS_ENVIRONMENT: "sandbox",
    ZOHO_BOOKS_CLIENT_ID: "fictional-client",
    ZOHO_BOOKS_CLIENT_SECRET: "fictional-client-secret",
    INTEGRATION_NETWORK_ENABLED: "true",
    ZOHO_BOOKS_WRITE_ENABLED: "true",
    INTEGRATION_TEST_MODE: "true",
    ALLOW_PRODUCTION_ACCOUNTING_WRITES: "false",
    ZOHO_BOOKS_MAPPING_JSON: JSON.stringify({
      verified: true,
      baseCurrency: "AED",
      currencies: { AED: { id: "101" } },
      taxes: { "5.00": { id: "102", percentage: "5" } },
      categories: { MATERIALS: { accountId: "103" } },
    }),
  };
}
function authorizedEnvironment() {
  const env = environment();
  env.ZOHO_BOOKS_TEST_AUTHORIZATION_JSON = JSON.stringify({
    mode: "nonproduction",
    organizationId: "100",
    dataCenter: "US",
    configurationHash: booksTestConfigurationHash(getConfig("ZOHO", env)),
    approvedBy: "fixture-reviewer",
    approvalReference: "TEST-APPROVAL-1",
    isolationEvidenceReference: "TEST-ISOLATION-1",
    verifiedAt: now.toISOString(),
    expiresAt: "2026-10-27T07:00:00Z",
  });
  return env;
}
afterEach(() => vi.useRealTimers());
describe("nonproduction accounting write gate", () => {
  it("keeps flags and sandbox labels alone read-only", () => {
    vi.useFakeTimers().setSystemTime(now);
    expect(getConfig("ZOHO", environment()).writeEnabled).toBe(false);
    expect(
      getConfig("ZOHO", {
        ...environment(),
        ALLOW_PRODUCTION_ACCOUNTING_WRITES: "true",
      }).writeEnabled,
    ).toBe(false);
    expect(() => assertWrite(getConfig("ZOHO", environment()))).toThrow(
      /disabled/,
    );
  });
  it("requires every flag and a current exact-target operator authorization", () => {
    vi.useFakeTimers().setSystemTime(now);
    const env = authorizedEnvironment();
    expect(() => assertWrite(getConfig("ZOHO", env))).not.toThrow();
    for (const key of [
      "INTEGRATION_TEST_MODE",
      "INTEGRATION_NETWORK_ENABLED",
      "ZOHO_BOOKS_WRITE_ENABLED",
    ]) {
      expect(getConfig("ZOHO", { ...env, [key]: "false" }).writeEnabled).toBe(
        false,
      );
    }
    expect(
      getConfig("ZOHO", { ...env, ALLOW_PRODUCTION_ACCOUNTING_WRITES: "true" })
        .writeEnabled,
    ).toBe(false);
  });
  it("rejects production, target drift, credential rotation and mapping changes", () => {
    vi.useFakeTimers().setSystemTime(now);
    const env = authorizedEnvironment();
    for (const patch of [
      { ZOHO_BOOKS_ENVIRONMENT: "production" },
      { ZOHO_BOOKS_ORGANIZATION_ID: "200" },
      { ZOHO_BOOKS_DC: "EU" },
      { ZOHO_BOOKS_CLIENT_ID: "rotated-client" },
      { ZOHO_BOOKS_CLIENT_SECRET: "rotated-fictional-secret" },
      {
        ZOHO_BOOKS_MAPPING_JSON: env.ZOHO_BOOKS_MAPPING_JSON!.replace(
          '"101"',
          '"201"',
        ),
      },
    ])
      expect(getConfig("ZOHO", { ...env, ...patch }).writeEnabled).toBe(false);
  });
  it("rechecks expiry when a cached config is used to write", () => {
    vi.useFakeTimers().setSystemTime(now);
    const config = getConfig("ZOHO", authorizedEnvironment());
    expect(config.writeEnabled).toBe(true);
    vi.setSystemTime(new Date("2026-10-27T07:00:00Z"));
    expect(() => assertWrite(config)).toThrow(/disabled/);
  });
  it("rejects future, stale, overlong and malformed authorizations", () => {
    vi.useFakeTimers().setSystemTime(now);
    const config = getConfig("ZOHO", authorizedEnvironment());
    for (const patch of [
      { verifiedAt: "2026-10-27T06:01:00Z" },
      { expiresAt: now.toISOString() },
      { expiresAt: "2026-10-29T06:00:00Z" },
      { mode: "production" },
      { approvedBy: "" },
      { isolationEvidenceReference: "" },
    ])
      expect(
        validBooksTestAuthorization({
          ...config,
          testAuthorization: { ...config.testAuthorization, ...patch },
        } as ZohoConfig),
      ).toBe(false);
    expect(() =>
      getConfig("ZOHO", {
        ...environment(),
        ZOHO_BOOKS_TEST_AUTHORIZATION_JSON: "not-json",
      }),
    ).toThrow(/malformed/);
  });
  it("refuses invalid data centers and IDs rather than inferring them", () => {
    for (const dc of ["GB", "toString", "__proto__", "https://example.invalid"])
      expect(() =>
        getConfig("ZOHO", { ...environment(), ZOHO_BOOKS_DC: dc }),
      ).toThrow(/data center/);
    for (const id of ["", "unknown", "100&organization_id=200"])
      expect(() =>
        getConfig("ZOHO", { ...environment(), ZOHO_BOOKS_ORGANIZATION_ID: id }),
      ).toThrow(/organization/);
  });
  it("never enables CRM writes", () => {
    const env: NodeJS.ProcessEnv = {
      ...Object.fromEntries(
        Object.entries(environment()).map(([key, value]) => [
          key.replace("ZOHO_BOOKS_", "ZOHO_CRM_"),
          value,
        ]),
      ),
      NODE_ENV: "test",
    };
    delete env.ZOHO_CRM_MAPPING_JSON;
    const config = getConfig("CRM", env);
    expect(config.writeEnabled).toBe(false);
    expect(() => assertWrite(config)).toThrow(/disabled/);
  });
});
