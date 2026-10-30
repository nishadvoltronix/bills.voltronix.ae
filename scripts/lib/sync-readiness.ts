import {
  booksConfigurationHash,
  getBooksOrganizations,
  getConfig,
  productionBooksRuntimeReady,
} from "../../src/lib/integrations/config";
import { connectionFingerprint } from "../../src/lib/integrations/connection-fingerprint";
import { mysqlConnectionOptions } from "../../src/lib/mysql-connection";

export type SyncInventory = {
  credentials: {
    organizationId: string;
    revokedAt: Date | null;
    connectionFingerprint: string;
  }[];
  companies: {
    id: string;
    active: boolean;
    isDemo: boolean;
    liveAccountingEnabled: boolean;
    realVendors: number;
    realJobs: number;
    activeWriters: number;
  }[];
  destinations: {
    companyId: string;
    organizationId: string;
    dataCenter: string;
    environment: string;
    liveEnabled: boolean;
    verifiedAt: Date | null;
    verificationReference: string | null;
    verifiedConfigurationHash: string | null;
    mappedRealVendors: number;
  }[];
};

const actions = {
  CONFIGURATION_INVALID:
    "Review the Books data center, client credentials, organization profiles and mapping format in the private server environment.",
  DATABASE_UNAVAILABLE:
    "Check the application database connection and current migrations; no database error details are printed.",
  OPERATIONAL_RUNTIME_REQUIRED:
    "Run the production build with APP_ENV and NODE_ENV set to production, HTTPS and a dedicated operational MySQL database. Development/demo databases cannot post real bills.",
  MANUAL_ENTRY_ONLY_ENABLED:
    "Set MANUAL_ENTRY_ONLY=false to retain Save and sync. This local-ledger-only mode disables Books networking and automatic synchronization even when the Books network flags are enabled.",
  VERIFIED_DATABASE_TLS_REQUIRED:
    "Use DATABASE_TLS_MODE=verify-full (the production transport default) and keep Node certificate verification enabled. Supply a trusted CA bundle when required; a configuration check does not establish successful TLS connectivity.",
  NETWORK_DISABLED:
    "Enable the global and Books network settings in the authorized operational environment.",
  LIVE_WRITES_DISABLED:
    "Enable the Books write/live settings only after the operational company and destination have been verified; keep the legacy production deny flag false.",
  PRODUCTION_DESTINATION_REQUIRED:
    "Configure the intended production Books destination; this command checks real synchronization readiness.",
  TOKEN_STORAGE_REQUIRED:
    "Configure a dedicated valid token encryption key in the private server environment.",
  OAUTH_AUTHORIZATION_REQUIRED:
    "Authorize this exact Books organization or supply its provider-authorized bootstrap refresh token through private server configuration.",
  OAUTH_REAUTHORIZATION_REQUIRED:
    "Reauthorize the exact organization; an environment token cannot override a revoked, changed or legacy vault grant.",
  ACCOUNTING_MAPPING_REQUIRED:
    "Verify this organization's base currency, expense accounts and VAT mappings against Books and configure them on the server.",
  COMPANY_DESTINATION_REQUIRED:
    "Assign this exact organization, data center and environment to the intended real company through trusted operational setup.",
  REAL_COMPANY_REQUIRED:
    "Use an active, non-demo operating company; preserve connection-check/demo workspaces as separate records.",
  COMPANY_LIVE_DISABLED:
    "Enable live accounting for the verified operating company through trusted operational setup.",
  DESTINATION_VERIFICATION_REQUIRED:
    "Verify and enable the exact company destination against the current accounting configuration; do not manufacture verification evidence.",
  AMBIGUOUS_COMPANY_DESTINATION:
    "Resolve multiple configured Books destinations for this company before automatic Save and sync routing.",
  COMPANY_WRITER_REQUIRED:
    "Assign an active authorized bill writer to the operating company.",
  REAL_VENDOR_REQUIRED: "Create the actual supplier in the operating company.",
  VENDOR_MAPPING_REQUIRED:
    "Verify at least one real supplier against its active Books supplier in this exact destination; each invoice needs its own supplier mapping.",
  REAL_JOB_REQUIRED:
    "Create or import the actual job in the operating company.",
} as const;
type Blocker = keyof typeof actions;

/** Pure inventory: no token decryption, provider requests, worker execution or writes. */
export function syncReadiness(
  env: NodeJS.ProcessEnv,
  inventory: SyncInventory | null,
  now = new Date(),
) {
  const runtimeEligible = productionBooksRuntimeReady(env);
  const manualEntryOnly = env.MANUAL_ENTRY_ONLY === "true";
  // Mirror transport mode selection without reading a CA/key file or connecting.
  // Only the guarded development/test fixture defaults to plaintext without a CA.
  let databaseTlsConfigured = false;
  try {
    const connection = mysqlConnectionOptions(env.DATABASE_URL ?? "");
    const localFixture =
      ["development", "test"].includes(env.APP_ENV ?? "") &&
      connection.host === "127.0.0.1" && connection.port === 3308 &&
      (connection.database === "voltronix_billing_dev" ||
        /^bills_(test|restore)_/.test(connection.database));
    const mode = env.DATABASE_TLS_MODE?.trim() ||
      (localFixture && !env.DATABASE_TLS_CA_FILE?.trim() ? "disabled" : "verify-full");
    databaseTlsConfigured = mode === "verify-full" && env.NODE_TLS_REJECT_UNAUTHORIZED !== "0";
  } catch {
    // Invalid connection configuration cannot establish a TLS mode.
  }
  const encryptionKeyReady = /^[a-fA-F0-9]{64}$/.test(
    env.INTEGRATION_TOKEN_ENCRYPTION_KEY ?? "",
  );
  const globalBlockers: Blocker[] = [];
  if (!inventory) globalBlockers.push("DATABASE_UNAVAILABLE");
  if (!runtimeEligible) globalBlockers.push("OPERATIONAL_RUNTIME_REQUIRED");
  if (manualEntryOnly) globalBlockers.push("MANUAL_ENTRY_ONLY_ENABLED");
  if (!databaseTlsConfigured) globalBlockers.push("VERIFIED_DATABASE_TLS_REQUIRED");
  if (!encryptionKeyReady) globalBlockers.push("TOKEN_STORAGE_REQUIRED");
  let profiles: ReturnType<typeof getBooksOrganizations> = [];
  try {
    profiles = getBooksOrganizations(env);
  } catch {
    globalBlockers.push("CONFIGURATION_INVALID");
  }

  const configuredDestinations =
    inventory?.destinations.filter((destination) =>
      profiles.some((profile) => {
        try {
          const config = getConfig("ZOHO", env, profile.organizationId);
          return (
            config.organizationId === destination.organizationId &&
            config.dataCenter === destination.dataCenter &&
            config.environment === destination.environment
          );
        } catch {
          return false;
        }
      }),
    ) ?? [];

  const organizations = profiles.map((profile) => {
    const blockers: Blocker[] = [];
    try {
      const config = getConfig("ZOHO", env, profile.organizationId);
      if (config.environment !== "production")
        blockers.push("PRODUCTION_DESTINATION_REQUIRED");
      // Distinguish the local-ledger mode from disabled network configuration:
      // enabling network flags alone cannot override MANUAL_ENTRY_ONLY=true.
      if (
        env.INTEGRATION_NETWORK_ENABLED !== "true" ||
        env.ZOHO_BOOKS_NETWORK_ENABLED === "false"
      )
        blockers.push("NETWORK_DISABLED");
      if (
        env.ZOHO_BOOKS_WRITE_ENABLED !== "true" ||
        env.ZOHO_BOOKS_LIVE_ENABLED !== "true" ||
        env.ALLOW_PRODUCTION_ACCOUNTING_WRITES === "true"
      )
        blockers.push("LIVE_WRITES_DISABLED");
      const mapping = config.booksMapping;
      const accountingMappingPresent = Boolean(
        mapping &&
        mapping.currencies[mapping.baseCurrency] &&
        Object.keys(mapping.categories).length &&
        Object.keys(mapping.taxes).length,
      );
      if (!accountingMappingPresent)
        blockers.push("ACCOUNTING_MAPPING_REQUIRED");
      const grant = inventory?.credentials.find(
        (item) => item.organizationId === config.organizationId,
      );
      const legacyGrant =
        inventory?.credentials.some(
          (item) => item.organizationId === "__legacy_unscoped__",
        ) ?? false;
      const vaultGrantCurrent = Boolean(
        grant &&
        !grant.revokedAt &&
        grant.connectionFingerprint === connectionFingerprint(config),
      );
      const authorizationPresent =
        inventory !== null &&
        (grant
          ? vaultGrantCurrent
          : !legacyGrant && Boolean(config.refreshToken));
      if (inventory && !authorizationPresent)
        blockers.push(
          grant || legacyGrant
            ? "OAUTH_REAUTHORIZATION_REQUIRED"
            : "OAUTH_AUTHORIZATION_REQUIRED",
        );
      const destination = inventory?.destinations.find(
        (item) =>
          item.organizationId === config.organizationId &&
          item.dataCenter === config.dataCenter &&
          item.environment === config.environment,
      );
      const company = inventory?.companies.find(
        (item) => item.id === destination?.companyId,
      );
      const destinationVerified = Boolean(
        destination?.liveEnabled &&
        destination.verifiedAt &&
        destination.verifiedAt <= now &&
        destination.verificationReference?.trim() &&
        destination.verifiedConfigurationHash ===
          booksConfigurationHash(config),
      );
      if (inventory) {
        if (!destination || !company)
          blockers.push("COMPANY_DESTINATION_REQUIRED");
        else {
          if (
            !company.active ||
            company.isDemo ||
            /^demo[-_]/i.test(company.id)
          )
            blockers.push("REAL_COMPANY_REQUIRED");
          if (!company.liveAccountingEnabled)
            blockers.push("COMPANY_LIVE_DISABLED");
          if (!destinationVerified)
            blockers.push("DESTINATION_VERIFICATION_REQUIRED");
          if (
            configuredDestinations.filter(
              (item) => item.companyId === company.id,
            ).length > 1
          )
            blockers.push("AMBIGUOUS_COMPANY_DESTINATION");
          if (!company.activeWriters) blockers.push("COMPANY_WRITER_REQUIRED");
          if (!company.realVendors) blockers.push("REAL_VENDOR_REQUIRED");
          if (!destination.mappedRealVendors)
            blockers.push("VENDOR_MAPPING_REQUIRED");
          if (!company.realJobs) blockers.push("REAL_JOB_REQUIRED");
        }
      }
      return {
        organizationId: profile.organizationId,
        configurationValid: true,
        environment: config.environment,
        networkEnabled: config.networkEnabled,
        runtimeWriteGateEnabled: config.writeEnabled,
        accountingMappingPresent,
        authorization: {
          inventoryAvailable: inventory !== null,
          vaultGrantPresent: Boolean(grant),
          vaultGrantCurrent,
          bootstrapTokenPresent: Boolean(config.refreshToken),
          authorizationPresent,
          providerVerified: false,
        },
        company: company
          ? {
              id: company.id,
              active: company.active,
              isDemo: company.isDemo,
              liveAccountingEnabled: company.liveAccountingEnabled,
              activeWriters: company.activeWriters,
              realVendors: company.realVendors,
              realJobs: company.realJobs,
              mappedRealVendors: destination!.mappedRealVendors,
              destinationVerified,
            }
          : null,
        blockers,
      };
    } catch {
      return {
        organizationId: profile.organizationId,
        configurationValid: false,
        blockers: ["CONFIGURATION_INVALID" as Blocker],
      };
    }
  });
  const allBlockers = [
    ...new Set([
      ...globalBlockers,
      ...organizations.flatMap((item) => item.blockers),
    ]),
  ];
  return {
    recordedAt: now.toISOString(),
    status: allBlockers.length ? "BLOCKED" : "CONFIGURATION_PRESENT_UNVERIFIED",
    databaseInspected: inventory !== null,
    runtimeEligible,
    databaseTlsConfigured,
    encryptionKeyReady,
    providerVerified: false,
    providerRequests: 0,
    databaseWrites: 0,
    globalBlockers,
    organizations,
    actions: allBlockers.map((code) => ({ code, action: actions[code] })),
    worker: {
      required: true,
      status: "NOT_CHECKED",
      command: "npm run worker:sync -- --watch --limit=5",
      action:
        "Supervise the worker on the protected application host after configuration is ready. This inventory does not start or verify a worker.",
    },
    limits: [
      "Presence and matching metadata do not verify token decryption, OAuth scopes, provider acceptance or database privileges.",
      "Each invoice still requires current user/company access, its exact supplier/accounting mappings, immutable source and attachment checks. Nonzero discounts require a supported mapping and currently block synchronization.",
      "A saved or queued bill is not a synchronized bill; confirm its provider ID and required attachments. Payment remains separate.",
    ],
  };
}
