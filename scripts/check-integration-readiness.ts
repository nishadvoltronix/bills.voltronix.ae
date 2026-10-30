import { existsSync, readdirSync } from "node:fs";
import {
  getConfig,
  getBooksOrganizations,
  booksTestConfigurationHash,
  type Target,
} from "../src/lib/integrations/config";

// Read-only local inventory. Never calls providers or prints configured values.
// Refuse unexamined Next-specific overrides rather than report the wrong config.
const overrides = readdirSync(".").filter(
  (name) => name.startsWith(".env.") && name !== ".env.example",
);
if (overrides.length)
  throw new Error(
    "Additional environment files exist. Review their precedence before using this inventory.",
  );
if (existsSync(".env")) process.loadEnvFile(".env");
const options = process.argv.slice(2);
const selections = options.filter((arg) =>
  arg.startsWith("--organization-id="),
);
if (
  selections.length > 1 ||
  options.some(
    (arg) =>
      arg !== "--test-configuration-hash" &&
      !/^--organization-id=\d{1,30}$/.test(arg),
  )
)
  throw new Error(
    "Use --test-configuration-hash and an optional --organization-id=<configured ID>.",
  );
const selectedOrganizationId = selections[0]?.slice(
  "--organization-id=".length,
);
if (process.argv.includes("--test-configuration-hash")) {
  const config = getConfig("ZOHO", process.env, selectedOrganizationId);
  if (config.environment !== "sandbox")
    throw new Error(
      "Only a declared nonproduction test configuration can be fingerprinted.",
    );
  if (!config.booksMapping)
    throw new Error("Reviewed Books mappings are required.");
  // A digest alone is not an authorization and contains no raw configuration.
  console.log(booksTestConfigurationHash(config));
} else {
  const presence = (name: string) => Boolean(process.env[name]?.trim());
  const fields = [
    "AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT",
    "AZURE_DOCUMENT_INTELLIGENCE_KEY",
    "INTEGRATION_TOKEN_ENCRYPTION_KEY",
    "ZOHO_BOOKS_TEST_AUTHORIZATION_JSON",
    "ZOHO_BOOKS_ORGANIZATIONS_JSON",
    "ZOHO_BOOKS_REFRESH_TOKENS_JSON",
    ...["ZOHO_BOOKS", "ZOHO_CRM"].flatMap((prefix) =>
      [
        "DC",
        "ORGANIZATION_ID",
        "ENVIRONMENT",
        "CLIENT_ID",
        "CLIENT_SECRET",
        "REFRESH_TOKEN",
        "MAPPING_JSON",
      ].map((field) => `${prefix}_${field}`),
    ),
  ];
  const providers = Object.fromEntries(
    (["ZOHO", "CRM"] as Target[]).map((target) => {
      try {
        const profiles = target === "ZOHO" ? getBooksOrganizations() : [];
        const configs =
          target === "ZOHO"
            ? selectedOrganizationId
              ? [getConfig(target, process.env, selectedOrganizationId)]
              : profiles.map((profile) =>
                  getConfig(target, process.env, profile.organizationId),
                )
            : [getConfig(target)];
        return [
          target,
          {
            configurationValid: true,
            networkEnabled: configs.every((config) => config.networkEnabled),
            writeEnabled: configs.some((config) => config.writeEnabled),
            organizationCount: profiles.length || 1,
            requiresOrganizationSelection: profiles.length > 1,
            organizations: configs.map((config) => ({
              configurationValid: true,
              networkEnabled: config.networkEnabled,
              writeEnabled: config.writeEnabled,
              providerVerified: false,
            })),
            providerVerified: false,
          },
        ];
      } catch {
        return [
          target,
          {
            configurationValid: false,
            networkEnabled: false,
            writeEnabled: false,
            providerVerified: false,
          },
        ];
      }
    }),
  );
  let localFixtureDatabase = false;
  try {
    const url = new URL(process.env.DATABASE_URL ?? "");
    localFixtureDatabase =
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      (url.pathname === "/voltronix_billing_dev" || /^\/bills_test_/.test(url.pathname));
  } catch {
    /* Report false without disclosing input. */
  }
  console.log(
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        localFixtureDatabase,
        developmentEnvironment: process.env.APP_ENV === "development",
        networkFlag: process.env.INTEGRATION_NETWORK_ENABLED === "true",
        accountingWriteFlag: process.env.ZOHO_BOOKS_WRITE_ENABLED === "true",
        testModeFlag: process.env.INTEGRATION_TEST_MODE === "true",
        legacyProductionWriteFlag:
          process.env.ALLOW_PRODUCTION_ACCOUNTING_WRITES === "true",
        ocrEnabled: Boolean(
          process.env.OCR_PROVIDER && process.env.OCR_PROVIDER !== "disabled",
        ),
        encryptionKeyShapeValid: /^[a-fA-F0-9]{64}$/.test(
          process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY ?? "",
        ),
        configurationPresence: Object.fromEntries(
          fields.map((name) => [name, presence(name)]),
        ),
        providers,
        boundary:
          "Environment inventory only; no stored OAuth token inspection, provider API call, or isolation verification.",
      },
      null,
      2,
    ),
  );
}
