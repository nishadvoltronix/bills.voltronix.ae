import { productionBooksRuntimeReady } from "../../src/lib/integrations/config";

export type ManualInventory = {
  companies: {
    id: string;
    liveAccountingEnabled: boolean;
    administrators: number;
    writers: number;
    jobs: number;
    vendors: number;
  }[];
};

const disabledFlags = [
  "INTEGRATION_NETWORK_ENABLED",
  "ZOHO_BOOKS_NETWORK_ENABLED",
  "ZOHO_CRM_NETWORK_ENABLED",
  "ZOHO_BOOKS_WRITE_ENABLED",
  "ZOHO_BOOKS_LIVE_ENABLED",
  "ALLOW_PRODUCTION_ACCOUNTING_WRITES",
  "SCANNER_IMPORT_ENABLED",
  "HUB_BRIDGE_ENABLED",
] as const;

/** Manual-entry inventory never requires provider credentials or provider access. */
export function manualReadiness(
  env: Record<string, string | undefined>,
  inventory: ManualInventory | null,
  privateStorageAccessible: boolean,
) {
  const blockers: string[] = [];
  if (
    !productionBooksRuntimeReady(env) ||
    env.DATABASE_TLS_MODE !== "verify-full" ||
    env.NODE_TLS_REJECT_UNAUTHORIZED === "0"
  )
    blockers.push("PRODUCTION_HTTPS_AND_VERIFIED_MYSQL_REQUIRED");
  if (env.MANUAL_ENTRY_ONLY !== "true")
    blockers.push("MANUAL_ENTRY_MODE_REQUIRED");
  if (
    disabledFlags.some((name) => env[name] !== "false") ||
    env.OCR_PROVIDER !== "disabled"
  )
    blockers.push("OPTIONAL_INTEGRATIONS_MUST_BE_DISABLED");
  if (
    env.ALLOW_DEMO_SEED === "true" ||
    env.SEED_ADMIN_EMAIL || env.SEED_ADMIN_PASSWORD ||
    env.SEED_ACCOUNTS_EMAIL || env.SEED_ACCOUNTS_PASSWORD
  )
    blockers.push("DEVELOPMENT_SEED_CONFIGURATION_PRESENT");
  if (!inventory) blockers.push("DATABASE_UNAVAILABLE");
  else if (!inventory.companies.length)
    blockers.push("OPERATING_COMPANY_REQUIRED");
  if (!privateStorageAccessible) blockers.push("PRIVATE_STORAGE_ACCESS_REQUIRED");
  const companies = (inventory?.companies ?? []).map((company) => {
    const missing: string[] = [];
    if (company.liveAccountingEnabled) missing.push("LIVE_ACCOUNTING_MUST_BE_DISABLED");
    if (!company.administrators) missing.push("COMPANY_ADMINISTRATOR_REQUIRED");
    if (!company.writers) missing.push("COMPANY_WRITER_REQUIRED");
    if (!company.jobs) missing.push("LOCAL_JOB_REQUIRED");
    if (!company.vendors) missing.push("LOCAL_VENDOR_REQUIRED");
    return { ...company, blockers: missing };
  });
  return {
    status: blockers.length || companies.some((company) => company.blockers.length)
      ? "BLOCKED" : "CONFIGURATION_PRESENT_UNVERIFIED",
    scope: "Manual entry only: local jobs, suppliers, bills and attachments.",
    databaseInspected: inventory !== null,
    privateStorageAccessible,
    providerRequests: 0,
    databaseWrites: 0,
    filesystemWrites: 0,
    blockers,
    companies,
    limits: [
      "This inventory checks database reads and directory permissions; it does not prove write privileges, schema integrity, login, file contents, backups or restart persistence.",
      "Verify a complete authenticated manual save, edit, finalization and attachment download on the target host before accepting the release.",
      "Zoho, CRM lookup, OCR, scanner intake and workers are not required or verified for this release.",
    ],
  };
}
