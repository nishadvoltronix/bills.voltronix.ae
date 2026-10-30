import "server-only";
import { isManualEntryOnly } from "@/lib/application-mode";
import { createHash } from "node:crypto";
import { z } from "zod";

export type Target = "ZOHO" | "CRM";
export class IntegrationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly kind: "BLOCKED" | "RETRY" | "UNKNOWN" | "FAILED" = "FAILED",
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}
export const centers = {
  US: {
    accounts: "https://accounts.zoho.com",
    api: "https://www.zohoapis.com",
  },
  EU: { accounts: "https://accounts.zoho.eu", api: "https://www.zohoapis.eu" },
  IN: { accounts: "https://accounts.zoho.in", api: "https://www.zohoapis.in" },
  AU: {
    accounts: "https://accounts.zoho.com.au",
    api: "https://www.zohoapis.com.au",
  },
  JP: { accounts: "https://accounts.zoho.jp", api: "https://www.zohoapis.jp" },
  CA: {
    accounts: "https://accounts.zohocloud.ca",
    api: "https://www.zohoapis.ca",
  },
  CN: {
    accounts: "https://accounts.zoho.com.cn",
    api: "https://www.zohoapis.com.cn",
  },
  SA: { accounts: "https://accounts.zoho.sa", api: "https://www.zohoapis.sa" },
  AE: { accounts: "https://accounts.zoho.ae", api: "https://www.zohoapis.ae" },
} as const;
export type DataCenter = keyof typeof centers;
const externalId = z.string().regex(/^\d{1,30}$/);
const apiName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,99}$/);
const categoryMapping = z
  .object({ accountId: externalId, itemId: externalId.optional() })
  .strict();
export const booksMappingSchema = z
  .object({
    verified: z.literal(true),
    baseCurrency: z.string().regex(/^[A-Z]{3}$/),
    currencies: z.record(
      z.string().regex(/^[A-Z]{3}$/),
      z
        .object({
          id: externalId,
          exchangeRate: z
            .string()
            .regex(/^\d+(\.\d{1,8})?$/)
            .optional(),
        })
        .strict(),
    ),
    taxes: z.record(
      z.string().regex(/^\d{1,3}\.\d{2}$/),
      z
        .object({
          id: externalId,
          percentage: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/),
        })
        .strict(),
    ),
    categories: z.partialRecord(
      z.enum(["MATERIALS", "LABOUR", "EQUIPMENT", "TRANSPORT", "OTHER"]),
      categoryMapping,
    ),
    jobCustomFieldIndex: z.number().int().positive().optional(),
    orderCustomFieldIndex: z.number().int().positive().optional(),
    // Omitted for legacy mappings so their serialized configuration hashes stay stable.
    lineSelectionRequired: z.literal(true).optional(),
  })
  .strict()
  .superRefine((mapping, context) => {
    if (!mapping.lineSelectionRequired) return;
    if (Object.keys(mapping.categories).length || Object.keys(mapping.taxes).length)
      context.addIssue({ code: "custom", message: "Explicit line selection mode must not define category or tax defaults." });
    if (!mapping.currencies[mapping.baseCurrency])
      context.addIssue({ code: "custom", path: ["currencies"], message: "The exact base currency must be configured." });
  });
export type BooksMapping = z.infer<typeof booksMappingSchema>;
export const crmMappingSchema = z
  .object({
    verified: z.literal(true),
    jobModule: apiName,
    jobNumberField: apiName,
    jobNameField: apiName,
    jobValueField: apiName,
    customerField: apiName,
    currencyField: apiName,
    approvedVariationsField: apiName.optional(),
  })
  .strict();
export type CrmMapping = z.infer<typeof crmMappingSchema>;
const evidenceReference = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:/ -]{2,159}$/);
export const booksTestAuthorizationSchema = z
  .object({
    mode: z.literal("nonproduction"),
    organizationId: externalId,
    dataCenter: z.enum(["US", "EU", "IN", "AU", "JP", "CA", "CN", "SA", "AE"]),
    configurationHash: z.string().regex(/^[a-f0-9]{64}$/),
    approvedBy: evidenceReference,
    approvalReference: evidenceReference,
    isolationEvidenceReference: evidenceReference,
    verifiedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .strict();
export type BooksTestAuthorization = z.infer<
  typeof booksTestAuthorizationSchema
>;
const booksOrganizationSchema = z
  .object({
    organizationId: externalId,
    name: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(/^[^\u0000-\u001f\u007f]+$/),
    mapping: booksMappingSchema.optional(),
    testAuthorization: booksTestAuthorizationSchema.optional(),
  })
  .strict();
const booksOrganizationsSchema = z
  .array(booksOrganizationSchema)
  .min(1)
  .max(20)
  .refine(
    (profiles) =>
      new Set(profiles.map((profile) => profile.organizationId)).size ===
      profiles.length,
  );

function booksOrganizationProfiles(env: NodeJS.ProcessEnv) {
  if (env.ZOHO_BOOKS_ORGANIZATIONS_JSON?.trim()) {
    try {
      return booksOrganizationsSchema.parse(
        JSON.parse(env.ZOHO_BOOKS_ORGANIZATIONS_JSON),
      );
    } catch {
      throw new IntegrationError(
        "INVALID_ORGANIZATIONS",
        "Books organization profiles are invalid or contain duplicate identifiers. Review the server configuration.",
        "BLOCKED",
      );
    }
  }
  const organizationId = env.ZOHO_BOOKS_ORGANIZATION_ID ?? "";
  if (!externalId.safeParse(organizationId).success)
    throw new IntegrationError(
      "NOT_CONFIGURED",
      "ZOHO_BOOKS_ORGANIZATION_ID must identify the verified organization, or configure explicit Books organization profiles.",
      "BLOCKED",
    );
  return [{ organizationId, name: "Zoho Books organization" }] as z.infer<
    typeof booksOrganizationSchema
  >[];
}

/** Safe metadata only; credentials and accounting mappings never reach the selector. */
export function getBooksOrganizations(env: NodeJS.ProcessEnv = process.env) {
  return booksOrganizationProfiles(env).map(({ organizationId, name }) => ({
    organizationId,
    name,
  }));
}

/** Final-save policy must remain enforceable even while OAuth credentials are unavailable. */
export function booksLineSelectionRequired(organizationId: string, env: NodeJS.ProcessEnv = process.env) {
  if (!env.ZOHO_BOOKS_ORGANIZATIONS_JSON?.trim() && !env.ZOHO_BOOKS_ORGANIZATION_ID?.trim() && !env.ZOHO_BOOKS_MAPPING_JSON?.trim()) return false;
  const profile = booksOrganizationProfiles(env).find(value => value.organizationId === organizationId);
  if (!profile) return false;
  if (env.ZOHO_BOOKS_ORGANIZATIONS_JSON?.trim()) return profile.mapping?.lineSelectionRequired === true;
  if (!env.ZOHO_BOOKS_MAPPING_JSON) return false;
  try { return booksMappingSchema.parse(JSON.parse(env.ZOHO_BOOKS_MAPPING_JSON)).lineSelectionRequired === true; }
  catch { throw new IntegrationError("INVALID_MAPPING", "The Books accounting policy is invalid. Review the server configuration.", "BLOCKED"); }
}

/** Server-only bootstrap credentials. Existing scoped vault grants take precedence. */
function booksRefreshToken(
  env: NodeJS.ProcessEnv,
  profiles: { organizationId: string }[],
  organizationId: string,
) {
  const raw = env.ZOHO_BOOKS_REFRESH_TOKENS_JSON;
  if (raw === undefined || raw === "")
    // A shared token never establishes authorization for several destinations.
    return profiles.length === 1 ? env.ZOHO_BOOKS_REFRESH_TOKEN || undefined : undefined;
  try {
    if (Buffer.byteLength(raw, "utf8") > 131_072 || env.ZOHO_BOOKS_REFRESH_TOKEN)
      throw new Error("Invalid token configuration");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("Invalid token map");
    const entries = Object.entries(parsed);
    const configured = new Set(profiles.map((profile) => profile.organizationId));
    if (!entries.length || entries.length > 20 || entries.some(([key, token]) =>
      !configured.has(key) || typeof token !== "string" || !token.length ||
      token.length > 4096 || /[\s\u0000-\u001f\u007f-\u009f]/u.test(token)))
      throw new Error("Invalid token entry");
    // The validated shape is a flat string-to-string object, so JSON string
    // literals alternate key/value. Inspect the original keys because JSON.parse
    // otherwise silently overwrites duplicates, including escaped equivalents.
    const literals = raw.match(/"(?:[^"\\]|\\.)*"/g) ?? [];
    const keys = literals.filter((_, index) => index % 2 === 0)
      .map((literal) => JSON.parse(literal) as string);
    if (keys.length !== entries.length || new Set(keys).size !== keys.length)
      throw new Error("Duplicate token key");
    return entries.find(([key]) => key === organizationId)?.[1] as string | undefined;
  } catch {
    // Never include raw input, token values or parser diagnostics in responses/logs.
    throw new IntegrationError(
      "INVALID_REFRESH_TOKENS",
      "Books server refresh-token configuration is invalid or ambiguous. Review the organization-scoped server settings.",
      "BLOCKED",
    );
  }
}

export type ZohoConfig = {
  target: Target;
  dataCenter: DataCenter;
  accountsOrigin: string;
  apiOrigin: string;
  organizationId: string;
  clientId: string;
  clientSecret: string;
  refreshToken?: string;
  environment: "sandbox" | "production";
  networkEnabled: boolean;
  writeEnabled: boolean;
  liveRuntime?: boolean;
  testAuthorization?: BooksTestAuthorization;
  booksMapping?: BooksMapping;
  crmMapping?: CrmMapping;
};

/** Pure validation only. Never reads a file or connects to the supplied database. */
export function productionBooksRuntimeReady(env: Record<string, string | undefined>) {
  try {
    if (env.APP_ENV !== "production" || env.NODE_ENV !== "production" || env.INTEGRATION_TEST_MODE !== "false") return false;
    const origin = new URL(env.APP_URL ?? "");
    const labels = origin.hostname.split(".");
    if (origin.protocol !== "https:" || origin.origin !== env.APP_URL || origin.username || origin.password ||
      labels.length < 2 || labels.every(label => /^\d+$/.test(label)) || origin.hostname.endsWith(".localhost") ||
      labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return false;
    const database = new URL(env.DATABASE_URL ?? "");
    const name = decodeURIComponent(database.pathname.slice(1));
    return database.protocol === "mysql:" && Boolean(database.hostname && database.username && database.password) &&
      /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) &&
      !/(dev|test|demo|restore|fixture|sandbox|local)/i.test(name) &&
      !["mysql", "sys", "information_schema", "performance_schema"].includes(name.toLowerCase()) &&
      !/(root|admin|migrat)/i.test(decodeURIComponent(database.username)) && database.search === "" && database.hash === "" &&
      !( ["localhost", "127.0.0.1", "[::1]"].includes(database.hostname) && database.port === "3308");
  } catch { return false; }
}
// A secure operator attestation is required because Books organization metadata
// does not prove sandbox isolation. Never infer this authorization from a label.
export function booksTestConfigurationHash(config: ZohoConfig) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        config.target,
        config.dataCenter,
        config.organizationId,
        config.environment,
        config.clientId,
        config.clientSecret,
        config.booksMapping,
      ]),
    )
    .digest("hex");
}
export const booksConfigurationHash = booksTestConfigurationHash;
export function validBooksTestAuthorization(
  config: ZohoConfig,
  now = Date.now(),
) {
  const result = booksTestAuthorizationSchema.safeParse(
    config.testAuthorization,
  );
  if (
    !result.success ||
    config.target !== "ZOHO" ||
    config.environment !== "sandbox" ||
    !config.booksMapping
  )
    return false;
  const a = result.data;
  const start = Date.parse(a.verifiedAt);
  const end = Date.parse(a.expiresAt);
  return (
    a.organizationId === config.organizationId &&
    a.dataCenter === config.dataCenter &&
    a.configurationHash === booksTestConfigurationHash(config) &&
    start <= now &&
    end > now &&
    end > start &&
    end - start <= 86_400_000
  );
}
export function prefix(target: Target) {
  return target === "ZOHO" ? "ZOHO_BOOKS" : "ZOHO_CRM";
}
export function getConfig(
  target: Target,
  env: NodeJS.ProcessEnv = process.env,
  organizationId?: string,
): ZohoConfig {
  const key = prefix(target);
  const dc = env[`${key}_DC`] as DataCenter | undefined;
  if (!dc || !Object.hasOwn(centers, dc))
    throw new IntegrationError(
      "NOT_CONFIGURED",
      `${key}_DC must identify the verified Zoho data center.`,
      "BLOCKED",
    );
  const profiles = target === "ZOHO" ? booksOrganizationProfiles(env) : [];
  if (target === "ZOHO" && profiles.length > 1 && !organizationId)
    throw new IntegrationError(
      "ORGANIZATION_REQUIRED",
      "Select one Books organization explicitly before continuing.",
      "BLOCKED",
    );
  const profile =
    target === "ZOHO"
      ? organizationId
        ? profiles.find((item) => item.organizationId === organizationId)
        : profiles[0]
      : undefined;
  const org =
    target === "ZOHO"
      ? (profile?.organizationId ?? "")
      : (env[`${key}_ORGANIZATION_ID`] ?? "");
  if (organizationId && org !== organizationId)
    throw new IntegrationError(
      "ORGANIZATION_NOT_CONFIGURED",
      "The selected organization is not configured for this integration.",
      "BLOCKED",
    );
  if (!externalId.safeParse(org).success)
    throw new IntegrationError(
      "NOT_CONFIGURED",
      `${key}_ORGANIZATION_ID must identify the verified organization.`,
      "BLOCKED",
    );
  const clientId = env[`${key}_CLIENT_ID`] ?? "";
  const clientSecret = env[`${key}_CLIENT_SECRET`] ?? "";
  if (!clientId || !clientSecret)
    throw new IntegrationError(
      "NOT_CONFIGURED",
      `${key} OAuth client credentials are not configured.`,
      "BLOCKED",
    );
  const environment = env[`${key}_ENVIRONMENT`];
  if (environment !== "sandbox" && environment !== "production")
    throw new IntegrationError(
      "NOT_CONFIGURED",
      `${key}_ENVIRONMENT must explicitly identify sandbox or production.`,
      "BLOCKED",
    );
  const config: ZohoConfig = {
    target,
    dataCenter: dc,
    accountsOrigin: centers[dc].accounts,
    apiOrigin:
      target === "CRM" && environment === "sandbox"
        ? centers[dc].api.replace("https://www.", "https://sandbox.")
        : centers[dc].api,
    organizationId: org,
    clientId,
    clientSecret,
    refreshToken: target === "ZOHO"
      ? booksRefreshToken(env, profiles, org)
      : env[`${key}_REFRESH_TOKEN`] || undefined,
    environment,
    networkEnabled: !isManualEntryOnly(env) && env.INTEGRATION_NETWORK_ENABLED === "true" && env[`${key}_NETWORK_ENABLED`] !== "false",
    writeEnabled: false,
  };
  const scopedBooks =
    target === "ZOHO" && Boolean(env.ZOHO_BOOKS_ORGANIZATIONS_JSON?.trim());
  if (scopedBooks) {
    config.booksMapping = profile?.mapping;
    config.testAuthorization = profile?.testAuthorization;
  }
  const mapping = scopedBooks ? undefined : env[`${key}_MAPPING_JSON`];
  if (mapping) {
    try {
      if (target === "ZOHO")
        config.booksMapping = booksMappingSchema.parse(JSON.parse(mapping));
      else config.crmMapping = crmMappingSchema.parse(JSON.parse(mapping));
    } catch {
      throw new IntegrationError(
        "INVALID_MAPPING",
        `${key} mapping is invalid or has not been verified.`,
        "BLOCKED",
      );
    }
  }
  if (
    target === "ZOHO" &&
    !scopedBooks &&
    env.ZOHO_BOOKS_TEST_AUTHORIZATION_JSON
  ) {
    try {
      config.testAuthorization = booksTestAuthorizationSchema.parse(
        JSON.parse(env.ZOHO_BOOKS_TEST_AUTHORIZATION_JSON),
      );
    } catch {
      throw new IntegrationError(
        "INVALID_TEST_AUTHORIZATION",
        "Books nonproduction test authorization is malformed. Writes remain disabled.",
        "BLOCKED",
      );
    }
  }
  config.writeEnabled =
    target === "ZOHO" &&
    config.networkEnabled &&
    env.ZOHO_BOOKS_WRITE_ENABLED === "true" &&
    env.INTEGRATION_TEST_MODE === "true" &&
    env.ALLOW_PRODUCTION_ACCOUNTING_WRITES !== "true" &&
    validBooksTestAuthorization(config);
  config.liveRuntime = productionBooksRuntimeReady(env);
  if (target === "ZOHO" && config.environment === "production") {
    config.writeEnabled = config.networkEnabled && env.ZOHO_BOOKS_WRITE_ENABLED === "true" &&
      env.ZOHO_BOOKS_LIVE_ENABLED === "true" && env.ALLOW_PRODUCTION_ACCOUNTING_WRITES !== "true" &&
      config.liveRuntime && Boolean(config.booksMapping);
  }
  return config;
}
export function assertNetwork(config: ZohoConfig) {
  if (!config.networkEnabled)
    throw new IntegrationError(
      "NETWORK_DISABLED",
      "External requests are disabled. Configure and authorize the connection first.",
      "BLOCKED",
    );
}
export function assertWrite(config: ZohoConfig) {
  assertNetwork(config);
  if (!config.writeEnabled || (config.environment === "production"
    ? config.target !== "ZOHO" || config.liveRuntime !== true || !config.booksMapping
    : !validBooksTestAuthorization(config)))
    throw new IntegrationError(
      "WRITES_DISABLED",
      "External accounting writes are disabled. Configure an authorized test target or an enabled operational live environment and verified company destination.",
      "BLOCKED",
    );
}
export function safeFailure(error: unknown): IntegrationError {
  return error instanceof IntegrationError
    ? error
    : new IntegrationError(
        "INTERNAL_ERROR",
        "Integration processing failed. The local bill is preserved.",
        "UNKNOWN",
      );
}
export function retryAt(
  attempt: number,
  retryAfterSeconds = 0,
  now = new Date(),
) {
  return new Date(
    now.getTime() +
      Math.min(
        86_400,
        Math.max(
          retryAfterSeconds,
          30 * 2 ** Math.min(Math.max(attempt - 1, 0), 10),
        ),
      ) *
        1000,
  );
}
