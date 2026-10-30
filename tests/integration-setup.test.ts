import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const credentialRead = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({
  db: { integrationCredential: { findUnique: credentialRead } },
}));
import { integrationStatus } from "@/lib/services/integrations";

const vaultKey = "c".repeat(64);
const clientSecret = "FICTIONAL-SETUP-CLIENT-SECRET";
const refreshToken = "FICTIONAL-SETUP-REFRESH-TOKEN";
const callback = "http://127.0.0.1:3000/api/integrations/oauth/zoho/callback";

function configuredBooks() {
  vi.stubEnv("ZOHO_BOOKS_DC", "EU");
  vi.stubEnv("ZOHO_BOOKS_ORGANIZATION_ID", "8100123456789");
  vi.stubEnv("ZOHO_BOOKS_ENVIRONMENT", "production");
  vi.stubEnv("ZOHO_BOOKS_CLIENT_ID", "FICTIONAL-SETUP-CLIENT-ID");
  vi.stubEnv("ZOHO_BOOKS_CLIENT_SECRET", clientSecret);
  vi.stubEnv("INTEGRATION_NETWORK_ENABLED", "true");
  vi.stubEnv("INTEGRATION_TOKEN_ENCRYPTION_KEY", vaultKey);
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("No provider calls are permitted in readiness tests");
    }),
  );
  vi.stubEnv("APP_URL", "http://127.0.0.1:3000");
  vi.stubEnv("INTEGRATION_TOKEN_ENCRYPTION_KEY", "");
  vi.stubEnv("ZOHO_BOOKS_ORGANIZATIONS_JSON", "");
  vi.stubEnv("ZOHO_BOOKS_REFRESH_TOKENS_JSON", "");
  for (const flag of [
    "INTEGRATION_NETWORK_ENABLED",
    "INTEGRATION_TEST_MODE",
    "ZOHO_BOOKS_WRITE_ENABLED",
    "ALLOW_PRODUCTION_ACCOUNTING_WRITES",
  ])
    vi.stubEnv(flag, "false");
  for (const target of ["ZOHO_BOOKS", "ZOHO_CRM"])
    for (const name of [
      "DC",
      "ORGANIZATION_ID",
      "ENVIRONMENT",
      "CLIENT_ID",
      "CLIENT_SECRET",
      "REFRESH_TOKEN",
      "MAPPING_JSON",
      "TEST_AUTHORIZATION_JSON",
    ])
      vi.stubEnv(`${target}_${name}`, "");
  vi.stubEnv("OCR_PROVIDER", "disabled");
  vi.stubEnv("AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT", "");
  vi.stubEnv("AZURE_DOCUMENT_INTELLIGENCE_KEY", "");
  credentialRead.mockResolvedValue(null);
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("safe OAuth setup readiness", () => {
  it("shows independent callback, network and vault prerequisites when provider credentials are absent", async () => {
    const result = await integrationStatus();
    expect(result.zoho.authorization).toMatchObject({
      callbackUrl: callback,
      networkEnabled: false,
      encryptionKeyReady: false,
      canAuthorize: false,
      missing: expect.arrayContaining([
        "ZOHO_BOOKS_DC",
        "ZOHO_BOOKS_ORGANIZATION_ID",
        "ZOHO_BOOKS_ENVIRONMENT",
        "ZOHO_BOOKS_CLIENT_ID",
        "ZOHO_BOOKS_CLIENT_SECRET",
        "INTEGRATION_NETWORK_ENABLED",
        "INTEGRATION_TOKEN_ENCRYPTION_KEY",
      ]),
    });
    expect(result.crm.authorization.callbackUrl).toBe(
      "http://127.0.0.1:3000/api/integrations/oauth/crm/callback",
    );
    expect(result.zoho.status).toBe("NOT_CONFIGURED");
    expect(result.zoho.canAuthorize).toBe(false);
    expect(credentialRead).not.toHaveBeenCalled();
  });
  it("permits production account OAuth setup while accounting writes stay disabled without mappings and verified live readiness", async () => {
    configuredBooks();
    const { zoho } = await integrationStatus();
    expect(zoho.authorization).toEqual({
      callbackUrl: callback,
      networkEnabled: true,
      encryptionKeyReady: true,
      missing: [],
      canAuthorize: true,
      reason: null,
    });
    expect(zoho.canAuthorize).toBe(true);
    expect(zoho.writeEnabled).toBe(false);
    expect(zoho.connected).toBe(false);
    expect(zoho.status).toBe("CONFIGURED_UNVERIFIED");
    expect(zoho.postingMissing).toEqual([
      "ZOHO_BOOKS_OAUTH_AUTHORIZATION",
      "ZOHO_BOOKS_MAPPING_JSON",
      "LIVE_OPERATIONAL_ENVIRONMENT",
      "LIVE_COMPANY_VERIFICATION",
    ]);
    expect(credentialRead).toHaveBeenCalledWith({
      where: {
        target_organizationId: {
          target: "ZOHO",
          organizationId: "8100123456789",
        },
      },
      select: { revokedAt: true, connectionFingerprint: true },
    });
  });
  it.each([
    "",
    "invalid-url-with-private-fixture",
    "http://public.example.invalid",
    "https://fixture:private-fixture-password@example.invalid",
    "file:///private/fixture",
  ])(
    "disables authorization for unsafe or invalid APP_URL %s",
    async (appUrl) => {
      configuredBooks();
      vi.stubEnv("APP_URL", appUrl);
      const { zoho } = await integrationStatus();
      expect(zoho.authorization.callbackUrl).toBeNull();
      expect(zoho.authorization.missing).toContain("APP_URL");
      expect(zoho.authorization.reason).toEqual(expect.any(String));
      expect(zoho.authorization.canAuthorize).toBe(false);
      expect(zoho.canAuthorize).toBe(false);
      expect(JSON.stringify(zoho)).not.toContain("private-fixture");
    },
  );
  it.each([
    ["INTEGRATION_NETWORK_ENABLED", "false"],
    ["INTEGRATION_TOKEN_ENCRYPTION_KEY", ""],
    ["INTEGRATION_TOKEN_ENCRYPTION_KEY", "invalid-key"],
  ])("requires valid %s before enabling authorization", async (key, value) => {
    configuredBooks();
    vi.stubEnv(key, value);
    const { zoho } = await integrationStatus();
    expect(zoho.authorization.missing).toContain(key);
    expect(zoho.authorization.canAuthorize).toBe(false);
    expect(zoho.canAuthorize).toBe(false);
    expect(zoho.authorization.reason).toEqual(expect.any(String));
  });
  it("returns a safe reason for invalid provider configuration even when all required fields are present", async () => {
    configuredBooks();
    vi.stubEnv("ZOHO_BOOKS_DC", "INVALID-PRIVATE-FIXTURE");
    const { zoho } = await integrationStatus();
    expect(zoho.authorization.missing).toEqual([]);
    expect(zoho.authorization.canAuthorize).toBe(false);
    expect(zoho.authorization.reason).toBe(
      "ZOHO_BOOKS_DC must identify the verified Zoho data center.",
    );
    expect(JSON.stringify(zoho)).not.toContain("INVALID-PRIVATE-FIXTURE");
    expect(credentialRead).not.toHaveBeenCalled();
  });
  it("never serializes client IDs, secrets, refresh tokens, vault keys or credential ciphertext", async () => {
    configuredBooks();
    vi.stubEnv("ZOHO_BOOKS_REFRESH_TOKEN", refreshToken);
    credentialRead.mockResolvedValue({
      revokedAt: null,
      connectionFingerprint: "other-connection",
      refreshTokenEncrypted: "PRIVATE-CIPHERTEXT-FIXTURE",
    });
    const result = await integrationStatus();
    const serialized = JSON.stringify(result);
    for (const secret of [
      vaultKey,
      clientSecret,
      refreshToken,
      "FICTIONAL-SETUP-CLIENT-ID",
      "PRIVATE-CIPHERTEXT-FIXTURE",
    ])
      expect(serialized).not.toContain(secret);
    expect(result.zoho.connected).toBe(false);
    expect(result.zoho.writeEnabled).toBe(false);
  });
  it("does not return malformed mapping values or database exception details", async () => {
    configuredBooks();
    vi.stubEnv(
      "ZOHO_BOOKS_MAPPING_JSON",
      '{"private":"PRIVATE-MAPPING-FIXTURE"}',
    );
    const invalid = await integrationStatus();
    expect(invalid.zoho.authorization.canAuthorize).toBe(false);
    expect(invalid.zoho.authorization.reason).toBe(
      "ZOHO_BOOKS mapping is invalid or has not been verified.",
    );
    expect(JSON.stringify(invalid)).not.toContain("PRIVATE-MAPPING-FIXTURE");
    vi.stubEnv("ZOHO_BOOKS_MAPPING_JSON", "");
    credentialRead.mockRejectedValue(
      new Error("PRIVATE-DATABASE-EXCEPTION-FIXTURE"),
    );
    const unavailable = await integrationStatus();
    expect(unavailable.zoho.authorization.canAuthorize).toBe(false);
    expect(unavailable.zoho.authorization.reason).toBe(
      "Integration configuration could not be checked.",
    );
    expect(JSON.stringify(unavailable)).not.toContain(
      "PRIVATE-DATABASE-EXCEPTION-FIXTURE",
    );
  });
});
