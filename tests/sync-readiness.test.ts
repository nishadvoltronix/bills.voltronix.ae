import { describe, expect, it } from "vitest";
import { booksConfigurationHash, getConfig } from "@/lib/integrations/config";
import { connectionFingerprint } from "@/lib/integrations/connection-fingerprint";
import {
  syncReadiness,
  type SyncInventory,
} from "../scripts/lib/sync-readiness";

const now = new Date("2026-10-29T10:00:00Z");
function environment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    APP_ENV: "production",
    APP_URL: "https://billing.example.invalid",
    DATABASE_URL:
      "mysql://billing_runtime:private-database-password@db.example.invalid:3306/billing_operational",
    DATABASE_TLS_MODE: "verify-full",
    INTEGRATION_TEST_MODE: "false",
    INTEGRATION_NETWORK_ENABLED: "true",
    ZOHO_BOOKS_NETWORK_ENABLED: "true",
    ZOHO_BOOKS_WRITE_ENABLED: "true",
    ZOHO_BOOKS_LIVE_ENABLED: "true",
    ALLOW_PRODUCTION_ACCOUNTING_WRITES: "false",
    INTEGRATION_TOKEN_ENCRYPTION_KEY: "a".repeat(64),
    ZOHO_BOOKS_DC: "AE",
    ZOHO_BOOKS_ENVIRONMENT: "production",
    ZOHO_BOOKS_CLIENT_ID: "private-client-id",
    ZOHO_BOOKS_CLIENT_SECRET: "private-client-secret",
    ZOHO_BOOKS_REFRESH_TOKENS_JSON: JSON.stringify({
      "1001": "private-bootstrap-token",
    }),
    ZOHO_BOOKS_ORGANIZATIONS_JSON: JSON.stringify([
      {
        organizationId: "1001",
        name: "Private company label",
        mapping: {
          verified: true,
          baseCurrency: "AED",
          currencies: { AED: { id: "101" } },
          taxes: { "5.00": { id: "102", percentage: "5" } },
          categories: { MATERIALS: { accountId: "103" } },
        },
      },
    ]),
  };
}
function inventory(env = environment()): SyncInventory {
  const config = getConfig("ZOHO", env, "1001");
  return {
    credentials: [],
    companies: [
      {
        id: "operating-company",
        active: true,
        isDemo: false,
        liveAccountingEnabled: true,
        realVendors: 1,
        realJobs: 1,
        activeWriters: 1,
      },
    ],
    destinations: [
      {
        companyId: "operating-company",
        organizationId: "1001",
        dataCenter: "AE",
        environment: "production",
        liveEnabled: true,
        verifiedAt: new Date("2026-10-28T10:00:00Z"),
        verificationReference: "private-verification-reference",
        verifiedConfigurationHash: booksConfigurationHash(config),
        mappedRealVendors: 1,
      },
    ],
  };
}
const codes = (report: ReturnType<typeof syncReadiness>) =>
  report.actions.map((item) => item.code);

describe("read-only Books synchronization inventory", () => {
  it("keeps valid local metadata unverified and never claims a live provider or worker check", () => {
    const report = syncReadiness(environment(), inventory(), now);
    expect(report.status).toBe("CONFIGURATION_PRESENT_UNVERIFIED");
    expect(report.providerVerified).toBe(false);
    expect(report.providerRequests).toBe(0);
    expect(report.databaseWrites).toBe(0);
    expect(report.databaseTlsConfigured).toBe(true);
    expect(report.worker).toMatchObject({
      required: true,
      status: "NOT_CHECKED",
    });
    expect(report.organizations[0]).toMatchObject({
      authorization: { authorizationPresent: true, providerVerified: false },
    });
  });

  it("identifies local-ledger mode even when all Books network flags are enabled", () => {
    const env = { ...environment(), MANUAL_ENTRY_ONLY: "true" };
    const report = syncReadiness(env, inventory(env), now);
    expect(report.status).toBe("BLOCKED");
    expect(codes(report)).toContain("MANUAL_ENTRY_ONLY_ENABLED");
    expect(codes(report)).not.toContain("NETWORK_DISABLED");
    expect(report.organizations[0]).toMatchObject({
      networkEnabled: false,
      runtimeWriteGateEnabled: false,
    });
    expect(report.actions.find(({ code }) => code === "MANUAL_ENTRY_ONLY_ENABLED")?.action)
      .toContain("MANUAL_ENTRY_ONLY=false");
  });

  it("reports disabled network flags independently of local-ledger mode", () => {
    const env = { ...environment(), MANUAL_ENTRY_ONLY: "true", INTEGRATION_NETWORK_ENABLED: "false" };
    expect(codes(syncReadiness(env, inventory(env), now))).toEqual(
      expect.arrayContaining(["MANUAL_ENTRY_ONLY_ENABLED", "NETWORK_DISABLED"]),
    );
    env.MANUAL_ENTRY_ONLY = "false";
    const report = syncReadiness(env, inventory(env), now);
    expect(codes(report)).not.toContain("MANUAL_ENTRY_ONLY_ENABLED");
    expect(codes(report)).toContain("NETWORK_DISABLED");
  });

  it.each([
    ["DATABASE_TLS_MODE", "disabled"],
    ["DATABASE_TLS_MODE", "insecure"],
    ["NODE_TLS_REJECT_UNAUTHORIZED", "0"],
  ])("diagnoses the insecure %s override before declaring configuration present", (key, value) => {
    const env = { ...environment(), [key]: value };
    const report = syncReadiness(env, inventory(env), now);
    expect(report.status).toBe("BLOCKED");
    expect(report.databaseTlsConfigured).toBe(false);
    expect(codes(report)).toContain("VERIFIED_DATABASE_TLS_REQUIRED");
    expect(report.providerRequests).toBe(0);
    expect(report.databaseWrites).toBe(0);
  });

  it("recognizes the secure production TLS default without claiming a connection test", () => {
    const env = environment();
    delete env.DATABASE_TLS_MODE;
    const report = syncReadiness(env, inventory(env), now);
    expect(report.databaseTlsConfigured).toBe(true);
    expect(codes(report)).not.toContain("VERIFIED_DATABASE_TLS_REQUIRED");
    expect(report.status).toBe("CONFIGURATION_PRESENT_UNVERIFIED");
  });

  it.each(["voltronix_billing_dev", "bills_test_123_456", "bills_restore_fixture"])(
    "does not describe the default plaintext fixture %s as TLS configured",
    (database) => {
      const env: NodeJS.ProcessEnv = { ...environment(), APP_ENV: "development",
        DATABASE_URL: `mysql://billing_runtime:fictional@127.0.0.1:3308/${database}` };
      delete env.DATABASE_TLS_MODE;
      const report = syncReadiness(env, inventory(env), now);
      expect(report.databaseTlsConfigured).toBe(false);
      expect(codes(report)).toContain("VERIFIED_DATABASE_TLS_REQUIRED");
      expect(report.status).toBe("BLOCKED");
      // An explicit CA selects verify-full even on this fixture. Its file contents
      // and TLS connectivity remain outside this pure inventory's verification.
      env.DATABASE_TLS_CA_FILE = "fictional-unread-ca.pem";
      expect(syncReadiness(env, inventory(env), now).databaseTlsConfigured).toBe(true);
    },
  );

  it("reports operational, demo-company and missing supplier/job blockers together", () => {
    const env: NodeJS.ProcessEnv = {
      ...environment(),
      APP_ENV: "development",
      NODE_ENV: "development",
      APP_URL: "http://127.0.0.1:3000",
      ZOHO_BOOKS_WRITE_ENABLED: "false",
    };
    const state = inventory(env);
    Object.assign(state.companies[0], {
      isDemo: true,
      liveAccountingEnabled: false,
      realVendors: 0,
      realJobs: 0,
      activeWriters: 0,
    });
    Object.assign(state.destinations[0], {
      liveEnabled: false,
      mappedRealVendors: 0,
    });
    expect(codes(syncReadiness(env, state, now))).toEqual(
      expect.arrayContaining([
        "OPERATIONAL_RUNTIME_REQUIRED",
        "LIVE_WRITES_DISABLED",
        "REAL_COMPANY_REQUIRED",
        "COMPANY_LIVE_DISABLED",
        "DESTINATION_VERIFICATION_REQUIRED",
        "REAL_VENDOR_REQUIRED",
        "REAL_JOB_REQUIRED",
        "COMPANY_WRITER_REQUIRED",
        "VENDOR_MAPPING_REQUIRED",
      ]),
    );
  });

  it.each(["revoked", "changed", "legacy"])(
    "does not let a bootstrap token override a %s vault grant",
    (kind) => {
      const env = environment();
      const state = inventory(env);
      state.credentials.push({
        organizationId: kind === "legacy" ? "__legacy_unscoped__" : "1001",
        revokedAt: kind === "revoked" ? now : null,
        connectionFingerprint:
          kind === "changed"
            ? "b".repeat(64)
            : connectionFingerprint(getConfig("ZOHO", env, "1001")),
      });
      const report = syncReadiness(env, state, now);
      expect(codes(report)).toContain("OAUTH_REAUTHORIZATION_REQUIRED");
      expect(report.organizations[0]).toMatchObject({
        authorization: {
          bootstrapTokenPresent: true,
          authorizationPresent: false,
        },
      });
    },
  );

  it("accepts a matching vault identity only as authorization metadata", () => {
    const env = environment();
    delete env.ZOHO_BOOKS_REFRESH_TOKENS_JSON;
    const state = inventory(env);
    state.credentials.push({
      organizationId: "1001",
      revokedAt: null,
      connectionFingerprint: connectionFingerprint(
        getConfig("ZOHO", env, "1001"),
      ),
    });
    expect(syncReadiness(env, state, now).organizations[0]).toMatchObject({
      authorization: {
        vaultGrantPresent: true,
        vaultGrantCurrent: true,
        bootstrapTokenPresent: false,
        authorizationPresent: true,
        providerVerified: false,
      },
    });
  });

  it.each(["changed-mapping", "future-verification", "blank-reference"])(
    "rejects %s destination verification",
    (kind) => {
      const state = inventory();
      if (kind === "changed-mapping")
        state.destinations[0].verifiedConfigurationHash = "b".repeat(64);
      if (kind === "future-verification")
        state.destinations[0].verifiedAt = new Date(now.getTime() + 1000);
      if (kind === "blank-reference")
        state.destinations[0].verificationReference = " ";
      expect(codes(syncReadiness(environment(), state, now))).toContain(
        "DESTINATION_VERIFICATION_REQUIRED",
      );
    },
  );

  it("does not borrow another organization's grant, company destination or supplier mapping", () => {
    const env = environment();
    const profiles = JSON.parse(env.ZOHO_BOOKS_ORGANIZATIONS_JSON!);
    profiles.push({ ...profiles[0], organizationId: "1002" });
    env.ZOHO_BOOKS_ORGANIZATIONS_JSON = JSON.stringify(profiles);
    const report = syncReadiness(env, inventory(env), now);
    expect(report.organizations[1].blockers).toEqual(
      expect.arrayContaining([
        "OAUTH_AUTHORIZATION_REQUIRED",
        "COMPANY_DESTINATION_REQUIRED",
      ]),
    );
  });

  it("detects ambiguous automatic company routing", () => {
    const env = environment();
    const profiles = JSON.parse(env.ZOHO_BOOKS_ORGANIZATIONS_JSON!);
    profiles.push({ ...profiles[0], organizationId: "1002" });
    env.ZOHO_BOOKS_ORGANIZATIONS_JSON = JSON.stringify(profiles);
    const state = inventory(env);
    state.destinations.push({
      ...state.destinations[0],
      organizationId: "1002",
    });
    expect(codes(syncReadiness(env, state, now))).toContain(
      "AMBIGUOUS_COMPANY_DESTINATION",
    );
  });

  it("reports unavailable database evidence without asserting that stored grants are absent", () => {
    const report = syncReadiness(environment(), null, now);
    expect(report.databaseInspected).toBe(false);
    expect(codes(report)).toContain("DATABASE_UNAVAILABLE");
    expect(codes(report)).not.toContain("OAUTH_AUTHORIZATION_REQUIRED");
    expect(report.organizations[0]).toMatchObject({
      authorization: { inventoryAvailable: false, authorizationPresent: false },
    });
  });

  it("never serializes credentials, hashes, private labels, references or parser diagnostics", () => {
    const env = environment();
    const state = inventory(env);
    const output = JSON.stringify(syncReadiness(env, state, now));
    for (const secret of [
      env.DATABASE_URL,
      env.ZOHO_BOOKS_CLIENT_ID,
      env.ZOHO_BOOKS_CLIENT_SECRET,
      "private-bootstrap-token",
      env.INTEGRATION_TOKEN_ENCRYPTION_KEY,
      "Private company label",
      state.destinations[0].verificationReference,
      state.destinations[0].verifiedConfigurationHash,
    ]) {
      expect(output).not.toContain(secret);
    }
    const invalid = syncReadiness(
      { ...env, ZOHO_BOOKS_ORGANIZATIONS_JSON: "private-invalid-json-secret" },
      state,
      now,
    );
    expect(codes(invalid)).toContain("CONFIGURATION_INVALID");
    expect(JSON.stringify(invalid)).not.toContain(
      "private-invalid-json-secret",
    );
  });
});
