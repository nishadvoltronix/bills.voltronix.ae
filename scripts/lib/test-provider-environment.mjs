// Test processes must not inherit real provider credentials or destination profiles.
export function isolatedProviderEnvironment(source) {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (/^(ZOHO_|AZURE_DOCUMENT_INTELLIGENCE_|INTEGRATION_|OCR_)/.test(key)) {
      delete env[key];
    }
  }
  return {
    ...env,
    INTEGRATION_NETWORK_ENABLED: "false",
    ZOHO_BOOKS_WRITE_ENABLED: "false",
    ALLOW_PRODUCTION_ACCOUNTING_WRITES: "false",
    INTEGRATION_TEST_MODE: "false",
    OCR_ENABLED: "false",
  };
}
