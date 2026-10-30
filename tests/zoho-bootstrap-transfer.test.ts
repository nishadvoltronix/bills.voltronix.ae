import { describe, expect, it } from "vitest";
import { parse } from "dotenv";
import { getConfig } from "@/lib/integrations/config";
import { connectionFingerprint } from "@/lib/integrations/connection-fingerprint";
import { deriveZohoBootstrapSettings, replacePrivateEnvironmentValues, type TransferGrant } from "../scripts/lib/zoho-bootstrap-transfer";

function fixture() {
  const target: NodeJS.ProcessEnv = {
    APP_ENV: "production", APP_URL: "https://bills.voltronix.ae", NODE_ENV: "production",
    MANUAL_ENTRY_ONLY: "false", INTEGRATION_NETWORK_ENABLED: "false", INTEGRATION_TEST_MODE: "false",
    ZOHO_BOOKS_WRITE_ENABLED: "false", ZOHO_BOOKS_LIVE_ENABLED: "false", ALLOW_PRODUCTION_ACCOUNTING_WRITES: "false",
    ZOHO_BOOKS_DC: "US", ZOHO_BOOKS_ENVIRONMENT: "production", ZOHO_BOOKS_CLIENT_ID: "books-id", ZOHO_BOOKS_CLIENT_SECRET: "books-secret",
    ZOHO_BOOKS_ORGANIZATIONS_JSON: JSON.stringify([{ organizationId: "101", name: "Alpha" }, { organizationId: "102", name: "Beta" }]),
    ZOHO_CRM_DC: "US", ZOHO_CRM_ENVIRONMENT: "production", ZOHO_CRM_ORGANIZATION_ID: "201",
    ZOHO_CRM_CLIENT_ID: "crm-id", ZOHO_CRM_CLIENT_SECRET: "crm-secret",
    INTEGRATION_TOKEN_ENCRYPTION_KEY: "a".repeat(64),
  };
  const source: NodeJS.ProcessEnv = { ...target, NODE_ENV: "development", APP_ENV: "development", APP_URL: "http://127.0.0.1:3000",
    DATABASE_URL: "mysql://fixture:private@127.0.0.1:3308/voltronix_billing_dev", INTEGRATION_TOKEN_ENCRYPTION_KEY: "b".repeat(64) };
  const grants: TransferGrant[] = [["ZOHO", "101"], ["ZOHO", "102"], ["CRM", "201"]].map(([target, organizationId]) => {
    const config = getConfig(target as "ZOHO" | "CRM", source, organizationId);
    return { target: config.target, organizationId, dataCenter: config.dataCenter,
      connectionFingerprint: connectionFingerprint(config), refreshTokenEncrypted: `${organizationId}-ciphertext`, revokedAt: null };
  });
  const decrypt = (value: string) => `1000.fixture_token_${value.split("-")[0]}`;
  return { source, target, grants, decrypt };
}

describe("private Zoho grant bootstrap transfer", () => {
  it("retains exact organization-scoped grants while preserving the fresh target encryption key", () => {
    const f = fixture();
    const settings = deriveZohoBootstrapSettings(f.source, f.target, f.grants, f.decrypt);
    const prepared = { ...f.target, ...settings };
    expect(getConfig("ZOHO", prepared, "101").refreshToken).toBe("1000.fixture_token_101");
    expect(getConfig("ZOHO", prepared, "102").refreshToken).toBe("1000.fixture_token_102");
    expect(getConfig("CRM", prepared).refreshToken).toBe("1000.fixture_token_201");
    expect(prepared.INTEGRATION_TOKEN_ENCRYPTION_KEY).toBe("a".repeat(64));
    expect(prepared.ZOHO_BOOKS_WRITE_ENABLED).toBe("false");
    expect(deriveZohoBootstrapSettings(f.source, prepared, f.grants, f.decrypt)).toEqual(settings);
  });

  it.each(["revoked", "wrong-client", "wrong-center", "missing", "duplicate", "wrong-fingerprint", "wrong-target", "writes-enabled", "different-existing-token"])("refuses %s without returning token values", change => {
    const f = fixture();
    if (change === "revoked") f.grants[0].revokedAt = new Date();
    if (change === "wrong-client") f.target.ZOHO_BOOKS_CLIENT_SECRET = "different-secret";
    if (change === "wrong-center") f.grants[0].dataCenter = "EU";
    if (change === "missing") f.grants.shift();
    if (change === "duplicate") f.grants.push({ ...f.grants[0] });
    if (change === "wrong-fingerprint") f.grants[0].connectionFingerprint = "f".repeat(64);
    if (change === "wrong-target") f.target.APP_URL = "https://another.invalid";
    if (change === "writes-enabled") f.target.ZOHO_BOOKS_WRITE_ENABLED = "true";
    if (change === "different-existing-token") f.target.ZOHO_CRM_REFRESH_TOKEN = "1000.some_other_existing_token";
    expect(() => deriveZohoBootstrapSettings(f.source, f.target, f.grants, f.decrypt)).toThrow("ZOHO_BOOTSTRAP_TRANSFER_REJECTED");
  });

  it("preserves CRLF, comments and all unrelated private values and refuses duplicate assignments", () => {
    const before = "# private\r\nUNRELATED=kept\r\nZOHO_CRM_REFRESH_TOKEN=\r\n";
    const after = replacePrivateEnvironmentValues(before, { ZOHO_CRM_REFRESH_TOKEN: "1000.fixture", EXTRA: "value" });
    expect(after).toBe("# private\r\nUNRELATED=kept\r\nZOHO_CRM_REFRESH_TOKEN='1000.fixture'\r\nEXTRA='value'\r\n");
    expect(parse(after)).toEqual({ UNRELATED: "kept", ZOHO_CRM_REFRESH_TOKEN: "1000.fixture", EXTRA: "value" });
    expect(() => replacePrivateEnvironmentValues("A=1\nA=2\n", { A: "3" })).toThrow("PRIVATE_ENVIRONMENT_UPDATE_REJECTED");
    expect(() => replacePrivateEnvironmentValues("A=1\n", { A: "bad\nline" })).toThrow("PRIVATE_ENVIRONMENT_UPDATE_REJECTED");
    expect(() => replacePrivateEnvironmentValues('A="\nold\n"\n', { A: "new" })).toThrow("PRIVATE_ENVIRONMENT_UPDATE_REJECTED");
    expect(() => replacePrivateEnvironmentValues("export A='old'\n", { A: "new" })).toThrow("PRIVATE_ENVIRONMENT_UPDATE_REJECTED");
  });
});
