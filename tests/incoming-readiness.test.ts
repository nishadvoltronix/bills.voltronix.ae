import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/integrations/config";
import { connectionFingerprint } from "@/lib/integrations/connection-fingerprint";
import { incomingReadiness, type IncomingInventory } from "../scripts/lib/incoming-readiness";

function environment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production", APP_ENV: "production", MANUAL_ENTRY_ONLY: "false", INTEGRATION_NETWORK_ENABLED: "true",
    INCOMING_SYNC_ENABLED: "true", INCOMING_SYNC_OPERATOR_EMAIL: "worker@example.invalid",
    INCOMING_SYNC_OPERATOR_PASSWORD: "private-worker-password",
    ZOHO_BOOKS_DC: "AE", ZOHO_BOOKS_ORGANIZATION_ID: "1001", ZOHO_BOOKS_ENVIRONMENT: "production",
    ZOHO_BOOKS_CLIENT_ID: "private-books-client", ZOHO_BOOKS_CLIENT_SECRET: "private-books-secret",
    ZOHO_CRM_DC: "AE", ZOHO_CRM_ORGANIZATION_ID: "2001", ZOHO_CRM_ENVIRONMENT: "production",
    ZOHO_CRM_CLIENT_ID: "private-crm-client", ZOHO_CRM_CLIENT_SECRET: "private-crm-secret",
    ZOHO_CRM_REFRESH_TOKEN: "private-crm-token",
  };
}
function inventory(): IncomingInventory {
  return {
    operator: { activeAdministrator: true, passwordMatches: true, companyIds: ["company"] },
    credentials: [],
    bindings: [{ companyId: "company", organizationId: "2001", dataCenter: "AE", environment: "production" }],
  };
}
const companies = [{ id: "company", active: true }];
const destinations = [{ companyId: "company", organizationId: "1001", dataCenter: "AE", environment: "production" }];
function check(env = environment(), state: IncomingInventory | null = inventory()) {
  return incomingReadiness(env, state, companies, destinations);
}
const codes = (result: ReturnType<typeof check>) => result.actions.map(item => item.code);

describe("incoming production readiness", () => {
  it("checks configured operator and exact CRM metadata without claiming provider or worker acceptance", () => {
    expect(check()).toMatchObject({ enabled: true, databaseInspected: true, operatorVerified: true,
      crmAuthorizationPresent: true, providerVerified: false, worker: { required: true, status: "NOT_CHECKED" }, actions: [] });
  });

  it("does not require an optional disabled incoming worker", () => {
    expect(check({ NODE_ENV: "production", INCOMING_SYNC_ENABLED: "false" }, null)).toMatchObject({ enabled: false, actions: [], worker: { required: false } });
  });

  it.each([
    ["INCOMING_SYNC_ENABLED", "yes"], ["INCOMING_SYNC_INTERVAL_SECONDS", "1"],
    ["INCOMING_SYNC_MAX_REQUESTS", "1000"], ["INCOMING_SYNC_RECONCILE_SECONDS", "invalid"],
  ])("rejects invalid %s without serializing its value", (key, value) => {
    expect(codes(check({ ...environment(), [key]: value }))).toContain("INCOMING_CONFIGURATION_INVALID");
  });

  it("reports unavailable database evidence without claiming an absent CRM grant", () => {
    const result = check(environment(), null);
    expect(codes(result)).toEqual(["INCOMING_DATABASE_INVENTORY_REQUIRED"]);
    expect(result.operatorVerified).toBe(false);
    expect(result.crmAuthorizationPresent).toBe(false);
  });

  it("does not accept development seed credentials on the production worker", () => {
    const env = environment();
    delete env.INCOMING_SYNC_OPERATOR_EMAIL; delete env.INCOMING_SYNC_OPERATOR_PASSWORD;
    env.SEED_ADMIN_EMAIL = "admin@example.invalid"; env.SEED_ADMIN_PASSWORD = "private-seed-password";
    expect(codes(check(env))).toContain("INCOMING_OPERATOR_REQUIRED");
    env.ACCOUNT_OPERATOR_EMAIL = "admin@example.invalid"; env.ACCOUNT_OPERATOR_PASSWORD = "private-account-password";
    expect(codes(check(env))).not.toContain("INCOMING_OPERATOR_REQUIRED");
  });

  it.each(["missing", "inactive", "password"])("rejects a %s worker operator", kind => {
    const state = inventory();
    if (kind === "missing") state.operator = null;
    else if (kind === "inactive") state.operator!.activeAdministrator = false;
    else state.operator!.passwordMatches = false;
    expect(codes(check(environment(), state))).toContain("INCOMING_OPERATOR_INVALID");
    expect(check(environment(), state).operatorVerified).toBe(false);
  });

  it("requires membership in every active company sharing the CRM source", () => {
    const state = inventory();
    state.bindings.push({ ...state.bindings[0], companyId: "second-company" });
    const result = incomingReadiness(environment(), state, [...companies, { id: "second-company", active: true }],
      [...destinations, { ...destinations[0], companyId: "second-company" }]);
    expect(codes(result)).toContain("INCOMING_COMPANY_ACCESS_REQUIRED");
    expect(codes(incomingReadiness(environment(), state, [...companies, { id: "second-company", active: false }], destinations)))
      .not.toContain("INCOMING_COMPANY_ACCESS_REQUIRED");
  });

  it.each(["organizationId", "dataCenter", "environment"])("rejects a changed CRM %s binding", key => {
    const state = inventory();
    Object.assign(state.bindings[0], { [key]: "changed" });
    expect(codes(check(environment(), state))).toContain("INCOMING_CRM_SOURCE_REQUIRED");
  });

  it("does not hide missing or ambiguous Books bindings behind valid CRM credentials", () => {
    expect(codes(incomingReadiness(environment(), inventory(), companies, []))).toContain("INCOMING_BOOKS_DESTINATION_REQUIRED");
    expect(codes(incomingReadiness(environment(), inventory(), companies, [...destinations, { ...destinations[0], organizationId: "1002" }])))
      .toContain("INCOMING_BOOKS_DESTINATION_REQUIRED");
    expect(codes(incomingReadiness(environment(), inventory(), companies, [{ ...destinations[0], dataCenter: "US" }])))
      .toContain("INCOMING_BOOKS_DESTINATION_REQUIRED");
  });

  it("reports missing CRM configuration and disabled networking", () => {
    expect(codes(check({ ...environment(), ZOHO_CRM_CLIENT_SECRET: "" }))).toContain("INCOMING_CRM_CONFIGURATION_INVALID");
    expect(codes(check({ ...environment(), ZOHO_CRM_NETWORK_ENABLED: "false" }))).toContain("INCOMING_CRM_NETWORK_DISABLED");
    expect(codes(check({ ...environment(), MANUAL_ENTRY_ONLY: "true" }))).toContain("INCOMING_CRM_NETWORK_DISABLED");
  });

  it.each(["revoked", "changed", "legacy"])("does not allow a bootstrap token to override a %s CRM vault grant", kind => {
    const env = environment(), state = inventory();
    state.credentials.push({ organizationId: kind === "legacy" ? "__legacy_unscoped__" : "2001",
      revokedAt: kind === "revoked" ? new Date() : null,
      connectionFingerprint: kind === "changed" ? "b".repeat(64) : connectionFingerprint(getConfig("CRM", env)) });
    expect(codes(check(env, state))).toContain("INCOMING_CRM_REAUTHORIZATION_REQUIRED");
    expect(check(env, state).crmAuthorizationPresent).toBe(false);
  });

  it("requires the exact current CRM grant and does not borrow another organization", () => {
    const env = environment(), state = inventory(); delete env.ZOHO_CRM_REFRESH_TOKEN;
    state.credentials.push({ organizationId: "2002", revokedAt: null, connectionFingerprint: connectionFingerprint(getConfig("CRM", env)) });
    expect(codes(check(env, state))).toContain("INCOMING_CRM_AUTHORIZATION_REQUIRED");
    state.credentials[0].organizationId = "2001";
    expect(check(env, state).crmAuthorizationPresent).toBe(true);
  });

  it("never returns configured secrets, account identifiers, fingerprints or parser errors", () => {
    const env = environment(), state = inventory();
    const output = JSON.stringify(check(env, state));
    for (const value of [env.INCOMING_SYNC_OPERATOR_EMAIL, env.INCOMING_SYNC_OPERATOR_PASSWORD,
      env.ZOHO_CRM_CLIENT_ID, env.ZOHO_CRM_CLIENT_SECRET, env.ZOHO_CRM_REFRESH_TOKEN, "2001"])
      expect(output).not.toContain(value);
  });
});
