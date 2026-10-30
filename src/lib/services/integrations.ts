import "server-only";
import type { Actor } from "@/lib/auth";
import type { BillInput } from "@/lib/validation";
import { db } from "@/lib/db";
import {
  getConfig,
  getBooksOrganizations,
  booksConfigurationHash,
  IntegrationError,
  prefix,
  type Target,
} from "@/lib/integrations/config";
import {
  callbackUrl,
  connectionFingerprint,
  LEGACY_UNSCOPED_ORGANIZATION,
} from "@/lib/integrations/oauth";
import { ocrProviderStatus } from "@/lib/services/ocr-provider";
import { crmAuthorizationStatus } from "@/lib/services/crm-authorization";

export class IntegrationNotConfiguredError extends Error {
  readonly code = "NOT_CONFIGURED";
  constructor(public readonly provider: "OCR" | "ZOHO" | "CRM") {
    super(`${provider} is not configured. No external request was made.`);
  }
}

/** Provider output is untrusted evidence. It must never call createBill directly. */
export interface OcrExtraction {
  providerRequestId: string;
  fields: Partial<BillInput>;
  confidence: Record<string, number>;
  warnings: string[];
  requiresHumanReview: true;
}

export interface OcrProvider {
  extract(document: {
    bytes: Uint8Array;
    mimeType: string;
  }): Promise<OcrExtraction>;
}

export type SyncResult =
  | { status: "SYNCED"; externalId: string; confirmedAt: Date }
  | { status: "FAILED"; retryable: boolean; safeError: string }
  | { status: "UNKNOWN"; safeError: string };

export interface BillSyncProvider {
  /** Use internal bill ID + approved revision as the stable idempotency reference. */
  createApprovedBill(input: {
    internalBillId: string;
    approvedVersion: number;
    idempotencyKey: string;
  }): Promise<SyncResult>;
  /** A timeout must be reconciled before repeating a remote create. */
  reconcile(internalBillId: string): Promise<SyncResult>;
}

export const ocrProvider: OcrProvider = {
  async extract() {
    if (ocrProviderStatus().configured)
      throw new Error("Use the durable OCR review queue.");
    throw new IntegrationNotConfiguredError("OCR");
  },
};

export function syncProvider(provider: "ZOHO" | "CRM"): BillSyncProvider {
  function requireQueue(): never {
    try {
      getConfig(provider);
    } catch {
      throw new IntegrationNotConfiguredError(provider);
    }
    throw new IntegrationError(
      "DURABLE_QUEUE_REQUIRED",
      "Use the approved-bill synchronization queue. Direct external creation is disabled.",
      "BLOCKED",
    );
  }
  return {
    async createApprovedBill() {
      return requireQueue();
    },
    async reconcile() {
      return requireQueue();
    },
  };
}

export interface AuthorizationReadiness {
  callbackUrl: string | null;
  networkEnabled: boolean;
  encryptionKeyReady: boolean;
  missing: string[];
  canAuthorize: boolean;
  reason: string | null;
}

function authorizationReadiness(
  target: Target,
  organizationId?: string,
): AuthorizationReadiness {
  const key = prefix(target);
  const missing = [
    "DC",
    "ORGANIZATION_ID",
    "ENVIRONMENT",
    "CLIENT_ID",
    "CLIENT_SECRET",
  ]
    .filter(
      (name) =>
        !(
          name === "ORGANIZATION_ID" &&
          (organizationId ||
            (target === "ZOHO" &&
              process.env.ZOHO_BOOKS_ORGANIZATIONS_JSON?.trim()))
        ) && !process.env[`${key}_${name}`],
    )
    .map((name) => `${key}_${name}`);
  const networkEnabled = process.env.INTEGRATION_NETWORK_ENABLED === "true" && process.env[`${prefix(target)}_NETWORK_ENABLED`] !== "false";
  const encryptionKeyReady = /^[a-fA-F0-9]{64}$/.test(
    process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY ?? "",
  );
  if (!networkEnabled) missing.push("INTEGRATION_NETWORK_ENABLED");
  if (!encryptionKeyReady) missing.push("INTEGRATION_TOKEN_ENCRYPTION_KEY");
  let callback: string | null = null;
  let reason: string | null = null;
  try {
    callback = callbackUrl(target);
  } catch (error) {
    missing.push("APP_URL");
    reason =
      error instanceof IntegrationError
        ? error.message
        : "Application URL is not configured correctly.";
  }
  return {
    callbackUrl: callback,
    networkEnabled,
    encryptionKeyReady,
    missing,
    // Provider configuration and database availability are checked below.
    canAuthorize: false,
    reason:
      reason ??
      (missing.length
        ? "Complete the missing authorization settings before connecting this account."
        : null),
  };
}

async function providerStatus(target: Target, organizationId?: string, actor?: Actor) {
  const key = prefix(target);
  const authorization = authorizationReadiness(target, organizationId);
  const postingMissing: string[] = [];
  const base = {
    connected: false,
    configured: false,
    writeEnabled: false,
    canAuthorize: false,
    authorization,
    postingMissing,
    missing: [...authorization.missing],
    capabilities:
      target === "ZOHO"
        ? ["SUPPLIER_BILL_OUTBOX", "ATTACHMENT_RECONCILIATION"]
        : ["EXISTING_JOB_IMPORT", "AUTHENTICATED_EXPENSE_SUMMARY"],
    expensePostingEnabled: false,
  };
  try {
    const config = getConfig(target, process.env, organizationId);
    const stored = await db.integrationCredential.findUnique({
      where: {
        target_organizationId: {
          target,
          organizationId: config.organizationId,
        },
      },
      select: { revokedAt: true, connectionFingerprint: true },
    });
    const legacy =
      !stored &&
      (await db.integrationCredential.findUnique({
        where: {
          target_organizationId: {
            target,
            organizationId: LEGACY_UNSCOPED_ORGANIZATION,
          },
        },
        select: { organizationId: true },
      }));
    const authorized = stored
      ? !stored.revokedAt &&
        stored.connectionFingerprint === connectionFingerprint(config)
      : !legacy && Boolean(config.refreshToken);
    if (!authorized) postingMissing.push(`${key}_OAUTH_AUTHORIZATION`);
    if (target === "ZOHO" && !config.booksMapping)
      postingMissing.push("ZOHO_BOOKS_MAPPING_JSON");
    if (target === "ZOHO" && !config.writeEnabled)
      postingMissing.push(config.environment === "production" ? "LIVE_OPERATIONAL_ENVIRONMENT" : "VERIFIED_NONPRODUCTION_TEST_AUTHORIZATION");
    let liveVerified = config.environment !== "production";
    if (target === "ZOHO" && config.environment === "production") {
      liveVerified = Boolean(actor && config.writeEnabled && await db.companyIntegrationDestination.findFirst({ where: {
        target: "ZOHO", organizationId: config.organizationId, dataCenter: config.dataCenter, environment: "production",
        liveEnabled: true, verifiedAt: { lte: new Date() }, verifiedConfigurationHash: booksConfigurationHash(config),
        verificationReference: { not: null },
        company: { active: true, isDemo: false, liveAccountingEnabled: true,
          memberships: { some: { userId: actor.id, active: true, user: { active: true, role: { in: ["ADMIN", "ACCOUNTS", "DATA_ENTRY"] } } } } },
      }, select: { companyId: true } }));
      if (!liveVerified) postingMissing.push("LIVE_COMPANY_VERIFICATION");
    }
    authorization.canAuthorize = authorization.missing.length === 0;
    return {
      ...base,
      configured: true,
      environment: config.environment,
      dataCenter: config.dataCenter,
      authorized,
      canAuthorize: authorization.canAuthorize,
      missing: [...authorization.missing, ...postingMissing],
      writeEnabled:
        config.networkEnabled &&
        config.writeEnabled &&
        liveVerified &&
        authorized &&
        Boolean(config.booksMapping),
      status: authorized ? "AUTHORIZED_UNVERIFIED" : "CONFIGURED_UNVERIFIED",
      message:
        target === "ZOHO"
          ? config.environment === "production"
            ? "Final bill saves schedule Books synchronization automatically when the operational environment and company destination are configured. Current source, creator access and destination checks run before every write."
            : "Test Books writes require a time-limited authorization for the exact verified nonproduction target and a fresh organization check before each POST."
          : "Deals.JobDealNumber and Deals.Amount are owner-confirmed mappings. Existing-job import and authenticated expense summaries are available when authorized; no CRM supplier-expense module is verified.",
    };
  } catch (error) {
    const message =
      error instanceof IntegrationError
        ? error.message
        : "Integration configuration could not be checked.";
    authorization.reason = message;
    return {
      ...base,
      status: "NOT_CONFIGURED",
      message,
    };
  }
}
export async function integrationStatus(actor?: Actor) {
  let profiles: ReturnType<typeof getBooksOrganizations> = [];
  try {
    profiles = getBooksOrganizations();
  } catch {
    /* providerStatus supplies a safe configuration error. */
  }
  const [zoho, crm] = await Promise.all([
    providerStatus(
      "ZOHO",
      profiles.length === 1 ? profiles[0].organizationId : undefined,
      actor,
    ),
    providerStatus("CRM", undefined, actor),
  ]);
  const organizations = await Promise.all(
    profiles.map(async (profile) => ({
      ...profile,
      ...(profiles.length === 1
        ? zoho
        : await providerStatus("ZOHO", profile.organizationId, actor)),
    })),
  );
  const requiresOrganizationSelection = profiles.length > 1;
  const result = {
    ocr: ocrProviderStatus(),
    zoho: {
      ...zoho,
      ...(requiresOrganizationSelection
        ? {
            status: "ORGANIZATION_SELECTION_REQUIRED",
            message:
              "Choose one Books organization for authorization or a bill's synchronization destination. No organization is selected automatically.",
            authorization: {
              ...zoho.authorization,
              canAuthorize: false,
              reason:
                "Select one Books organization explicitly before authorizing.",
            },
          }
        : {}),
      aggregate: requiresOrganizationSelection,
      requiresOrganizationSelection,
      organizations,
    },
    crm,
  };
  if (actor) {
    const destinations = await db.companyIntegrationDestination.findMany({
      where: { company: { active: true, memberships: { some: { userId: actor.id, active: true, user: { active: true } } } } },
    });
    const allowed = (target: Target, organizationId?: string) => {
      try {
        const config = getConfig(target, process.env, organizationId);
        return destinations.some((item) => item.target === target && item.organizationId === config.organizationId && item.dataCenter === config.dataCenter && item.environment === config.environment);
      } catch { return false; }
    };
    result.zoho.organizations = result.zoho.organizations.filter((item) => allowed("ZOHO", item.organizationId)).map((item) => {
      const config = getConfig("ZOHO", process.env, item.organizationId);
      return { ...item, companyId: destinations.find((destination) => destination.target === "ZOHO" && destination.organizationId === config.organizationId && destination.dataCenter === config.dataCenter && destination.environment === config.environment)?.companyId };
    });
    result.zoho.requiresOrganizationSelection = result.zoho.organizations.length > 1;
    result.zoho.aggregate = result.zoho.requiresOrganizationSelection;
    if (result.zoho.organizations.length === 1) {
      const { organizations: authorizedOrganizations } = result.zoho;
      Object.assign(result.zoho, authorizedOrganizations[0], { organizations: authorizedOrganizations, requiresOrganizationSelection: false, aggregate: false });
    }
    let crmPermitted = allowed("CRM");
    if (!crmPermitted && actor.role === "ADMIN") {
      try {
        const shared = await crmAuthorizationStatus(actor);
        crmPermitted = shared.companies.length > 0;
        if (crmPermitted) {
          Object.assign(result.crm, {
            connected: shared.connected, authorized: shared.connected,
            configured: Boolean(shared.organizationId), status: shared.status,
            message: shared.message, canAuthorize: shared.authorization.canAuthorize,
            capabilities: ["COMPANY_JOB_LOOKUP", "SELECTED_JOB_IMPORT", "AUTHENTICATED_EXPENSE_SUMMARY"],
          });
          result.crm.authorization = { ...result.crm.authorization, ...shared.authorization };
        }
      } catch { /* Unassigned or unauthorized shared sources remain hidden below. */ }
    }
    for (const [target, provider, permitted] of [["ZOHO", result.zoho, result.zoho.organizations.length > 0], ["CRM", result.crm, crmPermitted]] as const) {
      if (!permitted) {
        Object.assign(provider, { connected: false, configured: false, authorized: false, writeEnabled: false, canAuthorize: false, status: "COMPANY_NOT_CONFIGURED", message: `${target} is not assigned to one of your authorized companies.`, missing: ["COMPANY_DESTINATION"], postingMissing: ["COMPANY_DESTINATION"] });
        provider.authorization = { ...provider.authorization, canAuthorize: false, reason: "A company destination must be assigned before authorization.", missing: ["COMPANY_DESTINATION"] };
      }
    }
  }
  return result;
}
