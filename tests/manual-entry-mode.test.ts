import { afterEach, describe, expect, it, vi } from "vitest";
import { isManualEntryOnly, isOcrWorkspaceEnabled } from "@/lib/application-mode";
import { getConfig } from "@/lib/integrations/config";
import { ocrProviderStatus } from "@/lib/services/ocr-provider";

afterEach(() => vi.unstubAllEnvs());

describe("manual entry deployment mode", () => {
  it("requires the explicit server flag", () => {
    expect(isManualEntryOnly({ NODE_ENV: "test" })).toBe(false);
    expect(isManualEntryOnly({ NODE_ENV: "test", MANUAL_ENTRY_ONLY: "false" })).toBe(false);
    expect(isManualEntryOnly({ NODE_ENV: "test", MANUAL_ENTRY_ONLY: "true" })).toBe(true);
  });

  it("keeps typed entry connected to Books while the OCR and scanner workspace is disabled", () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: "test", MANUAL_ENTRY_ONLY: "false",
      OCR_PROVIDER: "disabled", SCANNER_IMPORT_ENABLED: "false", INTEGRATION_NETWORK_ENABLED: "true",
      ZOHO_BOOKS_DC: "US", ZOHO_BOOKS_ENVIRONMENT: "production", ZOHO_BOOKS_ORGANIZATION_ID: "990011",
      ZOHO_BOOKS_CLIENT_ID: "fictional-client", ZOHO_BOOKS_CLIENT_SECRET: "fictional-secret" };
    expect(isManualEntryOnly(env)).toBe(false);
    expect(isOcrWorkspaceEnabled(env)).toBe(false);
    expect(getConfig("ZOHO", env).networkEnabled).toBe(true);
  });

  it.each([
    [{ OCR_PROVIDER: "azure_document_intelligence" }, true],
    [{ SCANNER_IMPORT_ENABLED: "true" }, true],
    [{ OCR_PROVIDER: "disabled", SCANNER_IMPORT_ENABLED: "false" }, false],
    [{ OCR_PROVIDER: "unknown" }, false],
    [{ MANUAL_ENTRY_ONLY: "true", OCR_PROVIDER: "azure_document_intelligence", SCANNER_IMPORT_ENABLED: "true" }, false],
  ])("selects the OCR/scanner workspace independently: %j", (flags, expected) => {
    expect(isOcrWorkspaceEnabled({ NODE_ENV: "test", ...flags })).toBe(expected);
  });

  it.each(["ZOHO", "CRM"] as const)("disables %s network and writes even when old integration flags remain enabled", (target) => {
    const prefix = target === "ZOHO" ? "ZOHO_BOOKS" : "ZOHO_CRM";
    const config = getConfig(target, {
      NODE_ENV: "test",
      MANUAL_ENTRY_ONLY: "true", INTEGRATION_NETWORK_ENABLED: "true", INTEGRATION_TEST_MODE: "true",
      ZOHO_BOOKS_WRITE_ENABLED: "true", ZOHO_BOOKS_LIVE_ENABLED: "true",
      [`${prefix}_NETWORK_ENABLED`]: "true", [`${prefix}_DC`]: "US", [`${prefix}_ENVIRONMENT`]: "production",
      [`${prefix}_ORGANIZATION_ID`]: "990011", [`${prefix}_CLIENT_ID`]: "fictional-client",
      [`${prefix}_CLIENT_SECRET`]: "fictional-secret",
    });
    expect(config.networkEnabled).toBe(false);
    expect(config.writeEnabled).toBe(false);
  });

  it("keeps configured OCR disabled", () => {
    vi.stubEnv("MANUAL_ENTRY_ONLY", "true");
    vi.stubEnv("OCR_PROVIDER", "azure_document_intelligence");
    vi.stubEnv("AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT", "https://fictional.cognitiveservices.azure.com/");
    vi.stubEnv("AZURE_DOCUMENT_INTELLIGENCE_KEY", "fictional-key");
    expect(ocrProviderStatus()).toMatchObject({ configured: false, status: "NOT_CONFIGURED",
      message: "OCR is disabled for this manual entry deployment." });
  });
});
