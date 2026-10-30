import { describe, expect, it } from "vitest";
import { manualReadiness, type ManualInventory } from "../scripts/lib/manual-readiness";

const production = {
  APP_ENV: "production", NODE_ENV: "production", APP_URL: "https://bills.voltronix.ae",
  DATABASE_URL: "mysql://billing_runtime:fictional@db.example.invalid/billing_operational",
  DATABASE_TLS_MODE: "verify-full", MANUAL_ENTRY_ONLY: "true", INTEGRATION_TEST_MODE: "false",
  INTEGRATION_NETWORK_ENABLED: "false", ZOHO_BOOKS_NETWORK_ENABLED: "false",
  ZOHO_CRM_NETWORK_ENABLED: "false", ZOHO_BOOKS_WRITE_ENABLED: "false",
  ZOHO_BOOKS_LIVE_ENABLED: "false", ALLOW_PRODUCTION_ACCOUNTING_WRITES: "false",
  SCANNER_IMPORT_ENABLED: "false", HUB_BRIDGE_ENABLED: "false", OCR_PROVIDER: "disabled",
};
const inventory: ManualInventory = {
  companies: [{ id: "operating-company", liveAccountingEnabled: false, administrators: 1, writers: 2, jobs: 1, vendors: 1 }],
};

describe("manual release inventory", () => {
  it("accepts independent manual configuration with no provider credentials or mappings", () => {
    const report = manualReadiness(production, inventory, true);
    expect(report.status).toBe("CONFIGURATION_PRESENT_UNVERIFIED");
    expect(report.blockers).toEqual([]);
    expect(report.providerRequests).toBe(0);
    expect(report.databaseWrites).toBe(0);
    expect(report.filesystemWrites).toBe(0);
    expect(report.limits.join(" ")).toContain("does not prove write privileges");
  });

  it.each([
    { APP_ENV: "development" }, { NODE_ENV: "development" }, { APP_URL: "http://bills.voltronix.ae" },
    { DATABASE_TLS_MODE: "disabled" }, { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
    { DATABASE_URL: "mysql://billing_runtime:fictional@127.0.0.1:3308/voltronix_billing_dev" },
  ])("blocks an ineligible production runtime without exposing connection values", (override) => {
    const report = manualReadiness({ ...production, ...override }, inventory, true);
    expect(report.blockers).toContain("PRODUCTION_HTTPS_AND_VERIFIED_MYSQL_REQUIRED");
    expect(JSON.stringify(report)).not.toContain("fictional");
  });

  it.each(["INTEGRATION_NETWORK_ENABLED", "ZOHO_BOOKS_NETWORK_ENABLED", "ZOHO_CRM_NETWORK_ENABLED", "ZOHO_BOOKS_WRITE_ENABLED", "ZOHO_BOOKS_LIVE_ENABLED", "ALLOW_PRODUCTION_ACCOUNTING_WRITES", "SCANNER_IMPORT_ENABLED", "HUB_BRIDGE_ENABLED"])("blocks optional integration flag %s", (name) => {
    expect(manualReadiness({ ...production, [name]: "true" }, inventory, true).blockers)
      .toContain("OPTIONAL_INTEGRATIONS_MUST_BE_DISABLED");
  });

  it("does not report readiness for absent storage, company membership or catalogs", () => {
    const report = manualReadiness(production, { companies: [{ ...inventory.companies[0], administrators: 0, writers: 0, jobs: 0, vendors: 0 }] }, false);
    expect(report.status).toBe("BLOCKED");
    expect(report.blockers).toContain("PRIVATE_STORAGE_ACCESS_REQUIRED");
    expect(report.companies[0].blockers).toEqual(["COMPANY_ADMINISTRATOR_REQUIRED", "COMPANY_WRITER_REQUIRED", "LOCAL_JOB_REQUIRED", "LOCAL_VENDOR_REQUIRED"]);
    expect(manualReadiness(production, null, true).blockers).toContain("DATABASE_UNAVAILABLE");
    expect(manualReadiness(production, { companies: [] }, true).blockers).toContain("OPERATING_COMPANY_REQUIRED");
  });

  it("requires the manual feature and rejects accidentally enabled accounting or demo seed setup", () => {
    const report = manualReadiness({ ...production, MANUAL_ENTRY_ONLY: "false", SEED_ADMIN_PASSWORD: "never-print-me" }, { companies: [{ ...inventory.companies[0], liveAccountingEnabled: true }] }, true);
    expect(report.blockers).toEqual(["MANUAL_ENTRY_MODE_REQUIRED", "DEVELOPMENT_SEED_CONFIGURATION_PRESENT"]);
    expect(report.companies[0].blockers).toContain("LIVE_ACCOUNTING_MUST_BE_DISABLED");
    expect(JSON.stringify(report)).not.toContain("never-print-me");
  });
});
