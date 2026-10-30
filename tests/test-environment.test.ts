import { describe, expect, it } from "vitest";
import { isolatedProviderEnvironment } from "../scripts/lib/test-provider-environment.mjs";

describe("provider test isolation", () => {
  it("removes inherited provider destinations and credentials without touching fixture DB configuration", () => {
    const source = {
      DATABASE_URL: "postgresql://fixture:example@127.0.0.1/bills_test",
      ZOHO_BOOKS_ORGANIZATIONS_JSON: '[{"organizationId":"123"}]',
      ZOHO_BOOKS_CLIENT_SECRET: "synthetic-secret",
      ZOHO_BOOKS_REFRESH_TOKENS_JSON: '{"123":"synthetic-scoped-token"}',
      ZOHO_CRM_REFRESH_TOKEN: "synthetic-token",
      AZURE_DOCUMENT_INTELLIGENCE_KEY: "synthetic-key",
      INTEGRATION_TOKEN_ENCRYPTION_KEY: "synthetic-vault-key",
      INTEGRATION_NETWORK_ENABLED: "true",
      ZOHO_BOOKS_WRITE_ENABLED: "true",
      ALLOW_PRODUCTION_ACCOUNTING_WRITES: "true",
      INTEGRATION_TEST_MODE: "true",
      OCR_ENABLED: "true",
    };
    const result = isolatedProviderEnvironment(source);
    expect(result).toEqual({
      DATABASE_URL: source.DATABASE_URL,
      INTEGRATION_NETWORK_ENABLED: "false",
      ZOHO_BOOKS_WRITE_ENABLED: "false",
      ALLOW_PRODUCTION_ACCOUNTING_WRITES: "false",
      INTEGRATION_TEST_MODE: "false",
      OCR_ENABLED: "false",
    });
    expect(source.ZOHO_BOOKS_CLIENT_SECRET).toBe("synthetic-secret");
  });
});
