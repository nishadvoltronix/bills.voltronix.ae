import "server-only";
import { destinationCompanyForActor } from "./company-destination";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import type { Actor } from "@/lib/auth";
import { HttpError } from "@/lib/http";
import {
  assertNetwork,
  getConfig,
  IntegrationError,
  prefix,
  type Target,
  type ZohoConfig,
} from "./config";
import type { Fetch } from "./transport";
import { boundedJson } from "./response";
import { connectionFingerprint } from "./connection-fingerprint";
import { crmAuthorizationContext } from "./crm-source";
import { ZohoTransport } from "./transport";
export { connectionFingerprint } from "./connection-fingerprint";

function encryptionKey() {
  const raw = process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY ?? "";
  if (!/^[a-fA-F0-9]{64}$/.test(raw))
    throw new IntegrationError(
      "TOKEN_STORAGE_UNAVAILABLE",
      "Configure a dedicated 32-byte token encryption key before authorizing OAuth.",
      "BLOCKED",
    );
  return Buffer.from(raw, "hex");
}
export function encryptToken(value: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), nonce);
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    nonce.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}
export function decryptToken(value: string) {
  try {
    const [version, iv, tag, data] = value.split(".");
    if (version !== "v1" || !iv || !tag || !data) throw new Error();
    const cipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey(),
      Buffer.from(iv, "base64url"),
    );
    cipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      cipher.update(Buffer.from(data, "base64url")),
      cipher.final(),
    ]).toString("utf8");
  } catch {
    throw new IntegrationError(
      "TOKEN_DECRYPTION_FAILED",
      "Stored OAuth credentials could not be decrypted. Restore the correct encryption key or reauthorize.",
      "BLOCKED",
    );
  }
}
export function callbackUrl(target: Target) {
  const base = process.env.APP_URL;
  if (!base)
    throw new IntegrationError(
      "APP_ORIGIN_MISSING",
      "Application URL is not configured.",
      "BLOCKED",
    );
  const url = new URL(
    `/api/integrations/oauth/${target.toLowerCase()}/callback`,
    base,
  );
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost"].includes(url.hostname)
      ))
  )
    throw new IntegrationError(
      "HTTPS_REQUIRED",
      "OAuth callbacks require HTTPS outside local development.",
      "BLOCKED",
    );
  return url.toString();
}
export function authorizationUrl(config: ZohoConfig, state: string) {
  const url = new URL("/oauth/v2/auth", config.accountsOrigin);
  const scopes =
    config.target === "ZOHO"
      ? [
          "ZohoBooks.bills.CREATE",
          "ZohoBooks.bills.READ",
          "ZohoBooks.contacts.READ",
          "ZohoBooks.settings.READ",
          "ZohoBooks.accountants.READ",
          "ZohoBooks.projects.READ",
        ]
      : [
          "ZohoCRM.modules.deals.READ",
          "ZohoSearch.securesearch.READ",
          "ZohoCRM.modules.vendors.READ",
          "ZohoCRM.settings.modules.READ",
          "ZohoCRM.settings.fields.READ",
          "ZohoCRM.org.READ",
          "ZohoProjects.portals.READ",
          "ZohoProjects.clients.READ",
        ];
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: callbackUrl(config.target),
    scope: scopes.join(","),
    access_type: "offline",
    prompt: "consent",
    state,
  }))
    url.searchParams.set(key, value);
  return url.toString();
}
const tokenSchema = z.object({
  access_token: z.string().min(10),
  refresh_token: z.string().min(10).optional(),
  expires_in: z.number().positive().max(86_400),
  api_domain: z.string().url(),
});
export async function exchangeToken(
  config: ZohoConfig,
  grant: { code: string } | { refreshToken: string },
  fetcher: Fetch = fetch,
) {
  assertNetwork(config);
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    ...("code" in grant
      ? {
          grant_type: "authorization_code",
          code: grant.code,
          redirect_uri: callbackUrl(config.target),
        }
      : { grant_type: "refresh_token", refresh_token: grant.refreshToken }),
  });
  let response: Response;
  try {
    response = await fetcher(
      new URL("/oauth/v2/token", config.accountsOrigin),
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(20_000),
        redirect: "error",
        cache: "no-store",
      },
    );
  } catch {
    throw new IntegrationError(
      "OAUTH_UNAVAILABLE",
      "The OAuth token service could not be reached.",
      "RETRY",
    );
  }
  if (response.status === 429 || response.status >= 500)
    throw new IntegrationError(
      "OAUTH_RATE_LIMITED",
      "The OAuth service is temporarily unavailable.",
      "RETRY",
      60,
    );
  const data: unknown = await boundedJson(response, 64 * 1024).catch(
    () => null,
  );
  const parsed = tokenSchema.safeParse(data);
  if (!response.ok || !parsed.success)
    throw new IntegrationError(
      "OAUTH_REAUTHORIZE",
      "OAuth authorization is invalid, revoked, or expired. Reauthorize the connection.",
      "BLOCKED",
    );
  if (new URL(parsed.data.api_domain).origin !== config.apiOrigin)
    throw new IntegrationError(
      "OAUTH_DC_MISMATCH",
      "The authorized data center does not match the configured API destination.",
      "BLOCKED",
    );
  return parsed.data;
}
const inFlight = new Map<string, Promise<string>>();
export const LEGACY_UNSCOPED_ORGANIZATION = "__legacy_unscoped__";
export async function accessToken(config: ZohoConfig): Promise<string> {
  assertNetwork(config);
  const fingerprint = connectionFingerprint(config);
  // Always read revocation/rotation before considering any cached token.
  const stored = await db.integrationCredential.findUnique({
    where: {
      target_organizationId: {
        target: config.target,
        organizationId: config.organizationId,
      },
    },
  });
  if (
    !stored &&
    (await db.integrationCredential.findUnique({
      where: {
        target_organizationId: {
          target: config.target,
          organizationId: LEGACY_UNSCOPED_ORGANIZATION,
        },
      },
      select: { organizationId: true },
    }))
  )
    throw new IntegrationError(
      "OAUTH_REAUTHORIZE",
      "Legacy OAuth authorization has no verified organization. Explicitly authorize the selected organization before continuing.",
      "BLOCKED",
    );
  if (
    stored &&
    (stored.revokedAt || stored.connectionFingerprint !== fingerprint)
  )
    throw new IntegrationError(
      "OAUTH_REAUTHORIZE",
      "Stored OAuth authorization does not match this connection.",
      "BLOCKED",
    );
  if (
    stored?.accessTokenEncrypted &&
    stored.accessExpiresAt &&
    stored.accessExpiresAt.getTime() > Date.now() + 60_000
  )
    return decryptToken(stored.accessTokenEncrypted);
  const refresh = stored
    ? decryptToken(stored.refreshTokenEncrypted)
    : config.refreshToken;
  if (!refresh)
    throw new IntegrationError(
      "NOT_CONFIGURED",
      prefix(config.target) + " has no authorized refresh token.",
      "BLOCKED",
    );
  // A bootstrap refresh may rotate the provider token. Require a durable vault
  // before sending it so the successor can never be discarded or logged.
  encryptionKey();
  const identity = createHash("sha256")
    .update(
      fingerprint +
        ":" +
        refresh +
        ":" +
        (stored?.updatedAt.toISOString() ?? "environment"),
    )
    .digest("hex");
  const pending = inFlight.get(identity);
  if (pending) return pending;
  const work = (async () => {
    const token = await exchangeToken(config, { refreshToken: refresh });
    const expires = Date.now() + token.expires_in * 1000;
    if (stored) {
      const rotated = Boolean(
        token.refresh_token && token.refresh_token !== refresh,
      );
      const update = {
        where: {
          target: config.target,
          organizationId: config.organizationId,
          connectionFingerprint: fingerprint,
          updatedAt: stored.updatedAt,
          revokedAt: null,
        },
        data: {
          accessTokenEncrypted: encryptToken(token.access_token),
          accessExpiresAt: new Date(expires),
          ...(rotated
            ? { refreshTokenEncrypted: encryptToken(token.refresh_token!) }
            : {}),
        },
      };
      const updated = rotated
        ? await db.$transaction(async (tx) => {
            const result = await tx.integrationCredential.updateMany(update);
            if (result.count === 1)
              await tx.auditLog.create({
                data: {
                  action: "INTEGRATION_TOKEN_ROTATED",
                  entityType: "Integration",
                  entityId: config.target,
                  details: {
                    target: config.target,
                    organizationId: config.organizationId,
                    dataCenter: config.dataCenter,
                  },
                },
              });
            return result;
          })
        : await db.integrationCredential.updateMany(update);
      if (updated.count !== 1)
        throw new IntegrationError(
          "OAUTH_REAUTHORIZE",
          "Authorization changed during token renewal. Retry with the current connection.",
          "BLOCKED",
        );
    } else {
      await db.$transaction(async (tx) => {
        const inserted = await tx.integrationCredential.createMany({
          data: {
            target: config.target,
            organizationId: config.organizationId,
            dataCenter: config.dataCenter,
            connectionFingerprint: fingerprint,
            refreshTokenEncrypted: encryptToken(token.refresh_token ?? refresh),
            accessTokenEncrypted: encryptToken(token.access_token),
            accessExpiresAt: new Date(expires),
          },
          skipDuplicates: true,
        });
        if (inserted.count !== 1)
          throw new IntegrationError(
            "OAUTH_REAUTHORIZE",
            "Authorization changed during token renewal. Retry with the current connection.",
            "BLOCKED",
          );
        await tx.auditLog.create({
          data: {
            action: "INTEGRATION_BOOTSTRAP_AUTHORIZED",
            entityType: "Integration",
            entityId: config.target,
            details: {
              target: config.target,
              organizationId: config.organizationId,
              dataCenter: config.dataCenter,
              refreshTokenRotated: Boolean(
                token.refresh_token && token.refresh_token !== refresh,
              ),
            },
          },
        });
      });
    }
    return token.access_token;
  })();
  inFlight.set(identity, work);
  try {
    return await work;
  } finally {
    inFlight.delete(identity);
  }
}
export async function beginOAuth(
  actor: Actor,
  target: Target,
  organizationId?: string,
) {
  if (actor.role !== "ADMIN")
    throw new HttpError(
      403,
      "Only an administrator can authorize integrations.",
    );
  encryptionKey();
  const config = getConfig(target, process.env, organizationId);
  const crmContext = target === "CRM" ? await crmAuthorizationContext(actor, config) : null;
  if (!crmContext) await destinationCompanyForActor(actor, config);
  assertNetwork(config);
  const state = randomBytes(32).toString("base64url");
  await db.integrationOAuthState.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  await db.integrationOAuthState.create({
    data: {
      tokenHash: createHash("sha256").update(state).digest("hex"),
      target,
      organizationId: config.organizationId,
      userId: actor.id,
      dataCenter: config.dataCenter,
      connectionFingerprint: oauthStateFingerprint(config, crmContext?.fingerprint),
      expiresAt: new Date(Date.now() + 10 * 60_000),
    },
  });
  return { authorizationUrl: authorizationUrl(config, state) };
}
export async function completeOAuth(
  actor: Actor,
  target: Target,
  params: URLSearchParams,
) {
  if (actor.role !== "ADMIN")
    throw new HttpError(
      403,
      "Only an administrator can authorize integrations.",
    );
  const state = params.get("state") ?? "";
  const code = params.get("code") ?? "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !code || code.length > 2048)
    throw new HttpError(400, "OAuth authorization was declined or is invalid.");
  const stateHash = createHash("sha256").update(state).digest("hex");
  const pending = await db.integrationOAuthState.findUnique({
    where: { tokenHash: stateHash },
    select: {
      target: true,
      organizationId: true,
      userId: true,
      expiresAt: true,
      consumedAt: true,
    },
  });
  if (
    !pending ||
    pending.target !== target ||
    pending.userId !== actor.id ||
    pending.consumedAt ||
    pending.expiresAt <= new Date() ||
    !/^\d{1,30}$/.test(pending.organizationId)
  )
    throw new HttpError(
      400,
      "OAuth state is invalid, expired, or already used.",
    );
  // Only the server-stored state selects the destination; callback query fields cannot switch it.
  const config = getConfig(target, process.env, pending.organizationId);
  const crmContext = target === "CRM" ? await crmAuthorizationContext(actor, config) : null;
  const companyId = crmContext ? null : await destinationCompanyForActor(actor, config);
  const claimed = await db.integrationOAuthState.updateMany({
    where: {
      tokenHash: stateHash,
      target,
      organizationId: config.organizationId,
      userId: actor.id,
      dataCenter: config.dataCenter,
      connectionFingerprint: oauthStateFingerprint(config, crmContext?.fingerprint),
      expiresAt: { gt: new Date() },
      consumedAt: null,
    },
    data: { consumedAt: new Date() },
  });
  if (claimed.count !== 1)
    throw new HttpError(
      400,
      "OAuth state is invalid, expired, or already used.",
    );
  const token = await exchangeToken(config, { code });
  if (!token.refresh_token)
    throw new IntegrationError(
      "REFRESH_TOKEN_REQUIRED",
      "Zoho did not return an offline refresh token. Reauthorize with offline consent.",
      "BLOCKED",
    );
  if (crmContext) {
    const assertCurrentSource = async (store = db as import("@prisma/client").Prisma.TransactionClient) => {
      const currentConfig = getConfig("CRM", process.env, pending.organizationId);
      const current = await crmAuthorizationContext(actor, currentConfig, store);
      if (connectionFingerprint(currentConfig) !== connectionFingerprint(config) || current.fingerprint !== crmContext.fingerprint)
        throw new HttpError(409, "The CRM source changed during authorization. Start authorization again.");
      assertNetwork(currentConfig);
    };
    await assertCurrentSource();
    const transport = new ZohoTransport(config, async () => token.access_token);
    const organization = z.object({ org: z.array(z.object({ zgid: z.string().optional(), id: z.string().optional(), type: z.string() })) }).safeParse(await transport.request("/crm/v8/org"));
    if (!organization.success || organization.data.org.length !== 1 || !organization.data.org.some((org) => (org.zgid === config.organizationId || org.id === config.organizationId) && org.type === config.environment))
      throw new IntegrationError("CRM_ORGANIZATION_MISMATCH", "The authorized CRM organization does not match this source.", "BLOCKED");
    await db.$transaction(async (tx) => {
      await assertCurrentSource(tx);
      const credential = {
        dataCenter: config.dataCenter,
        connectionFingerprint: connectionFingerprint(config),
        refreshTokenEncrypted: encryptToken(token.refresh_token!),
        accessTokenEncrypted: encryptToken(token.access_token),
        accessExpiresAt: new Date(Date.now() + token.expires_in * 1000),
      };
      await tx.integrationCredential.upsert({
        where: { target_organizationId: { target, organizationId: config.organizationId } },
        create: { target, organizationId: config.organizationId, ...credential },
        update: { ...credential, revokedAt: null },
      });
      for (const company of crmContext.companies)
        await tx.auditLog.create({ data: { actorId: actor.id, companyId: company.id, action: "INTEGRATION_OAUTH_AUTHORIZED", entityType: "Integration", entityId: target, details: { target, organizationId: config.organizationId, dataCenter: config.dataCenter, access: "READ_ONLY_CRM_SOURCE" } } });
    }, { isolationLevel: "Serializable" });
    return { success: true, organizationId: config.organizationId };
  }
  await db.$transaction([
    db.integrationCredential.upsert({
      where: {
        target_organizationId: {
          target,
          organizationId: config.organizationId,
        },
      },
      create: {
        target,
        organizationId: config.organizationId,
        dataCenter: config.dataCenter,
        connectionFingerprint: connectionFingerprint(config),
        refreshTokenEncrypted: encryptToken(token.refresh_token),
        accessTokenEncrypted: encryptToken(token.access_token),
        accessExpiresAt: new Date(Date.now() + token.expires_in * 1000),
      },
      update: {
        dataCenter: config.dataCenter,
        connectionFingerprint: connectionFingerprint(config),
        refreshTokenEncrypted: encryptToken(token.refresh_token),
        accessTokenEncrypted: encryptToken(token.access_token),
        accessExpiresAt: new Date(Date.now() + token.expires_in * 1000),
        revokedAt: null,
      },
    }),
    db.auditLog.create({
      data: {
        actorId: actor.id,
        companyId,
        action: "INTEGRATION_OAUTH_AUTHORIZED",
        entityType: "Integration",
        entityId: target,
        details: {
          target,
          organizationId: config.organizationId,
          dataCenter: config.dataCenter,
        },
      },
    }),
  ]);
  return { success: true, organizationId: config.organizationId };
}

function oauthStateFingerprint(config: ZohoConfig, sourceFingerprint?: string) {
  return sourceFingerprint
    ? createHash("sha256").update(JSON.stringify([connectionFingerprint(config), sourceFingerprint])).digest("hex")
    : connectionFingerprint(config);
}
