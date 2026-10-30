import { getConfig } from "../../src/lib/integrations/config";
import { connectionFingerprint } from "../../src/lib/integrations/connection-fingerprint";
import { incomingSyncSettings } from "../../src/lib/services/incoming-sync-config";

export type IncomingInventory = {
  operator: { activeAdministrator: boolean; passwordMatches: boolean; companyIds: string[] } | null;
  credentials: { organizationId: string; revokedAt: Date | null; connectionFingerprint: string }[];
  bindings: { companyId: string; organizationId: string; dataCenter: string; environment: string }[];
};

const actions = {
  INCOMING_CONFIGURATION_INVALID: "Review incoming sync intervals, request limits and enabled setting in the private server environment.",
  INCOMING_OPERATOR_REQUIRED: "Configure the incoming worker's active administrator email/password on the server; development seed credentials cannot authenticate a production worker.",
  INCOMING_DATABASE_INVENTORY_REQUIRED: "Inspect incoming operator and source bindings in the target database before starting recurring synchronization.",
  INCOMING_OPERATOR_INVALID: "Correct the incoming worker credentials or restore its active administrator account; the configured password did not match an active administrator.",
  INCOMING_COMPANY_ACCESS_REQUIRED: "Grant the incoming administrator active membership in every configured Books company and every active company sharing the CRM source.",
  INCOMING_BOOKS_DESTINATION_REQUIRED: "Each incoming Books company must have exactly one Books destination matching its configured production organization, data center and environment.",
  INCOMING_CRM_CONFIGURATION_INVALID: "Configure the exact CRM production organization, data center and OAuth client settings for recurring job updates.",
  INCOMING_CRM_NETWORK_DISABLED: "Enable CRM networking for the incoming worker; manual-only mode and the provider kill switch block CRM reads.",
  INCOMING_CRM_SOURCE_REQUIRED: "Prepare the exact shared CRM source binding for every configured Books company using crm:prepare before starting incoming synchronization.",
  INCOMING_CRM_AUTHORIZATION_REQUIRED: "Authorize the exact CRM organization or configure its separate CRM refresh token; a Books grant cannot authorize CRM.",
  INCOMING_CRM_REAUTHORIZATION_REQUIRED: "Reauthorize the exact CRM organization; a bootstrap token cannot replace a revoked, changed or legacy stored CRM grant.",
} as const;
type Blocker = keyof typeof actions;

/** Pure configuration and database-metadata inspection; never runs a worker or provider request. */
export function incomingReadiness(
  env: NodeJS.ProcessEnv,
  inventory: IncomingInventory | null,
  companies: { id: string; active: boolean }[],
  destinations: { companyId: string; organizationId: string; dataCenter: string; environment: string }[],
) {
  const blockers: Blocker[] = [];
  let enabled = env.INCOMING_SYNC_ENABLED === "true";
  try { enabled = incomingSyncSettings(env).enabled; }
  catch { blockers.push("INCOMING_CONFIGURATION_INVALID"); }
  let authorizationPresent = false;
  if (enabled) {
    const email = env.INCOMING_SYNC_OPERATOR_EMAIL || env.ACCOUNT_OPERATOR_EMAIL ||
      (env.APP_ENV !== "production" ? env.SEED_ADMIN_EMAIL : undefined);
    const password = env.INCOMING_SYNC_OPERATOR_PASSWORD || env.ACCOUNT_OPERATOR_PASSWORD ||
      (env.APP_ENV !== "production" ? env.SEED_ADMIN_PASSWORD : undefined);
    if (!email?.trim() || !password) blockers.push("INCOMING_OPERATOR_REQUIRED");
    if (!inventory) blockers.push("INCOMING_DATABASE_INVENTORY_REQUIRED");
    else if (!inventory.operator?.activeAdministrator || !inventory.operator.passwordMatches)
      blockers.push("INCOMING_OPERATOR_INVALID");
    // Include all companies sharing the CRM source below, even if their Books
    // profile was accidentally omitted. The worker requires access to the group.
    const active = new Set(companies.filter(company => company.active).map(company => company.id));
    const booksCompanies = [...new Set(destinations.filter(row => active.has(row.companyId)).map(row => row.companyId))];
    if (inventory) {
      if (booksCompanies.some(id => !inventory.operator?.companyIds.includes(id))) blockers.push("INCOMING_COMPANY_ACCESS_REQUIRED");
      if (booksCompanies.some(id => {
        const rows = destinations.filter(row => row.companyId === id);
        if (rows.length !== 1) return true;
        try {
          const config = getConfig("ZOHO", env, rows[0].organizationId);
          return config.environment !== "production" || config.dataCenter !== rows[0].dataCenter || config.environment !== rows[0].environment;
        } catch { return true; }
      })) blockers.push("INCOMING_BOOKS_DESTINATION_REQUIRED");
    }
    try {
      const config = getConfig("CRM", env);
      if (config.environment !== "production") blockers.push("INCOMING_CRM_CONFIGURATION_INVALID");
      if (!config.networkEnabled) blockers.push("INCOMING_CRM_NETWORK_DISABLED");
      if (inventory) {
        const bindings = inventory.bindings.filter(row => active.has(row.companyId) && row.organizationId === config.organizationId &&
          row.dataCenter === config.dataCenter && row.environment === config.environment);
        if (!bindings.length || booksCompanies.some(id => !bindings.some(row => row.companyId === id))) blockers.push("INCOMING_CRM_SOURCE_REQUIRED");
        if (bindings.some(row => !inventory.operator?.companyIds.includes(row.companyId))) blockers.push("INCOMING_COMPANY_ACCESS_REQUIRED");
        if (bindings.some(binding => destinations.filter(row => row.companyId === binding.companyId).length !== 1))
          blockers.push("INCOMING_BOOKS_DESTINATION_REQUIRED");
        const grant = inventory.credentials.find(row => row.organizationId === config.organizationId);
        const legacy = inventory.credentials.some(row => row.organizationId === "__legacy_unscoped__");
        authorizationPresent = grant ? !grant.revokedAt && grant.connectionFingerprint === connectionFingerprint(config) : !legacy && Boolean(config.refreshToken);
        if (!authorizationPresent) blockers.push(grant || legacy ? "INCOMING_CRM_REAUTHORIZATION_REQUIRED" : "INCOMING_CRM_AUTHORIZATION_REQUIRED");
      }
    } catch { blockers.push("INCOMING_CRM_CONFIGURATION_INVALID"); }
  }
  return {
    enabled,
    databaseInspected: enabled && inventory !== null,
    operatorVerified: enabled && Boolean(inventory?.operator?.activeAdministrator && inventory.operator.passwordMatches),
    crmAuthorizationPresent: authorizationPresent,
    providerVerified: false,
    worker: { required: enabled, status: "NOT_CHECKED", command: "npm run worker:incoming -- --watch" },
    actions: [...new Set(blockers)].map(code => ({ code, action: actions[code] })),
  };
}
