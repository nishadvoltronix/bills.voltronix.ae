import "server-only";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { booksConfigurationHash, getBooksOrganizations, getConfig, IntegrationError, type ZohoConfig } from "@/lib/integrations/config";
import { accessToken } from "@/lib/integrations/oauth";
import { boundedJson } from "@/lib/integrations/response";
import { ZohoTransport, type Fetch } from "@/lib/integrations/transport";
import { assertBooksVerificationEnvironment, verifyOperationalBooksDestination } from "./books-operational-setup";
import { quotaResetTime } from "./books-attachment-download";
import { incomingConfiguredDelay } from "./incoming-sync";
import { assertIncomingSource } from "./incoming-sync-access";
import { IncomingQuotaError, incomingResponseBackoff } from "./incoming-sync-transport";

const blocked = (code: string) => new IntegrationError(code, "Production Books activation needs the indicated setup or source check.", "BLOCKED");
const referenceSchema = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/ -]{2,159}$/);
type Result = { organizationId: string; companyId?: string; status: "VERIFIED" | "WAITING_QUOTA" | "WAITING_SOURCE" | "BLOCKED";
  code?: string; retryAt?: string; providerReads?: number };

/** One-shot GET verification against restored operational sources. Never creates a bill. */
export async function activateBooksPosting(actor: Actor, reference: string, options: {
  fetcher?: Fetch; sleep?: (milliseconds: number) => Promise<void>;
} = {}) {
  assertBooksVerificationEnvironment();
  if (process.env.ALLOW_BOOKS_POSTING_ACTIVATION !== "true" || actor.role !== "ADMIN") throw blocked("ACTIVATION_NOT_ENABLED");
  if (process.env.DATABASE_TLS_MODE !== "verify-full" || process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw blocked("VERIFIED_DATABASE_TLS_REQUIRED");
  if (process.env.INCOMING_SYNC_ENABLED !== "false") throw blocked("STOP_INCOMING_DURING_ACTIVATION");
  const reviewedReference = referenceSchema.parse(reference);
  const organizations: Result[] = [];
  for (const profile of getBooksOrganizations()) {
    let companyId: string | undefined;
    try {
      const config = getConfig("ZOHO", process.env, profile.organizationId);
      if (!config.networkEnabled || config.writeEnabled || config.environment !== "production") throw blocked("READ_ONLY_BOOKS_SETUP_REQUIRED");
      const candidates = await db.companyIntegrationDestination.findMany({ where: {
        target: "ZOHO", organizationId: config.organizationId, dataCenter: config.dataCenter, environment: "production",
      }, select: { companyId: true } });
      if (candidates.length !== 1) throw blocked("EXACT_OPERATIONAL_DESTINATION_REQUIRED");
      companyId = candidates[0].companyId;
      const current = await db.user.findFirst({ where: { id: actor.id, active: true, role: "ADMIN", memberships: {
        some: { companyId, active: true, company: { active: true, isDemo: false, name: profile.name } },
      } }, select: { id: true } });
      if (!current) throw blocked("OPERATIONAL_COMPANY_ACCESS_REQUIRED");
      const result = await withSourceLease(actor, config, companyId, async transport => verifyOperationalBooksDestination(actor, {
        companyId, organizationId: config.organizationId, organizationName: profile.name, reference: reviewedReference,
      }, transport), options);
      organizations.push({ organizationId: profile.organizationId, companyId, status: "VERIFIED", providerReads: result.providerReads });
    } catch (error) {
      organizations.push({ organizationId: profile.organizationId, companyId,
        status: error instanceof IncomingQuotaError ? error.code === "BOOKS_ACTIVATION_RETRY" ? "WAITING_SOURCE" : "WAITING_QUOTA" : "BLOCKED",
        code: error instanceof IntegrationError ? error.code : "ACTIVATION_CHECK_FAILED",
        ...(error instanceof IncomingQuotaError ? { retryAt: error.until.toISOString() } : {}) });
    }
  }
  return { status: organizations.every(row => row.status === "VERIFIED") ? "DESTINATIONS_VERIFIED" : "SETUP_PENDING",
    organizations, providerFinancialWrites: 0, financialWriteFlagsChanged: false,
    nextStep: "Select the actual supplier and each line's Books account/tax in the manual form. Start the outgoing worker with the enabled runtime; confirm a genuine new bill ID and its original attachment." };
}

async function withSourceLease<T>(actor: Actor, config: ZohoConfig, companyId: string, operation: (transport: ZohoTransport) => Promise<T>,
  options: { fetcher?: Fetch; sleep?: (milliseconds: number) => Promise<void> }) {
  const identity = { target: "ZOHO" as const, organizationId: config.organizationId, dataCenter: config.dataCenter, environment: config.environment };
  const source = { ...identity, companyId, organizationName: "" };
  const state = await db.incomingSyncState.findUnique({ where: { target_organizationId_dataCenter_environment: identity } });
  if (!state || state.companyId !== companyId) throw blocked("RESTORED_INCOMING_STATE_REQUIRED");
  await assertIncomingSource(actor, source, state.scopeHash);
  function checkDelay(row: { backoffUntil: Date | null; status: string; nextRunAt: Date }) {
    const dates = [incomingConfiguredDelay(source), row.backoffUntil,
      ["WAITING_QUOTA", "RETRY"].includes(row.status) ? row.nextRunAt : null].filter((value): value is Date => Boolean(value && value.valueOf() > Date.now()));
    if (dates.length) {
      const until = new Date(Math.max(...dates.map(value => value.valueOf())));
      throw new IncomingQuotaError(until, row.status === "RETRY" && until.valueOf() === row.nextRunAt.valueOf()
        ? "BOOKS_ACTIVATION_RETRY" : "BOOKS_ACTIVATION_QUOTA");
    }
  }
  checkDelay(state);
  const token = randomUUID(), configurationHash = booksConfigurationHash(config);
  const lease = await db.incomingSyncState.updateMany({ where: { id: state.id, scopeHash: state.scopeHash,
    OR: [{ leaseToken: null }, { leaseExpiresAt: { lte: new Date() } }] },
    data: { leaseToken: token, leaseExpiresAt: new Date(Date.now() + 180_000) } });
  if (lease.count !== 1) throw blocked("INCOMING_SOURCE_BUSY");
  const owned = { id: state.id, scopeHash: state.scopeHash, leaseToken: token };
  async function guard() {
    assertBooksVerificationEnvironment();
    if (booksConfigurationHash(getConfig("ZOHO", process.env, config.organizationId)) !== configurationHash) throw blocked("CONFIGURATION_CHANGED");
    await assertIncomingSource(actor, source, owned.scopeHash);
    const latest = await db.incomingSyncState.findUnique({ where: { id: owned.id } });
    if (!latest || latest.leaseToken !== token || latest.scopeHash !== owned.scopeHash || !latest.leaseExpiresAt || latest.leaseExpiresAt.valueOf() <= Date.now())
      throw blocked("INCOMING_LEASE_LOST");
    checkDelay(latest);
    const renewed = await db.incomingSyncState.updateMany({ where: { ...owned, leaseExpiresAt: { gt: new Date() } },
      data: { leaseExpiresAt: new Date(Date.now() + 180_000) } });
    if (renewed.count !== 1) throw blocked("INCOMING_LEASE_LOST");
  }
  async function cooldown(until: Date) {
    // Extending a hold must never shorten a concurrent provider cooldown.
    await db.incomingSyncState.updateMany({ where: { ...owned, OR: [{ backoffUntil: null }, { backoffUntil: { lt: until } }] },
      data: { backoffUntil: until, nextRunAt: until, status: "WAITING_QUOTA" } });
  }
  let lastRequest = 0, pending: IntegrationError | null = null;
  const fetcher: Fetch = async (url, init) => {
    try {
      if (init?.method !== "GET" || new URL(url).origin !== config.apiOrigin ||
        new URL(url).searchParams.get("organization_id") !== config.organizationId) throw blocked("ACTIVATION_READ_ONLY");
      const gap = lastRequest + 1100 - Date.now();
      if (gap > 0) await (options.sleep ?? (async ms => { await delay(ms); }))(gap);
      await guard(); lastRequest = Date.now();
      const response = await (options.fetcher ?? fetch)(url, init);
      const body = await boundedJson(response.clone(), 2 * 1024 * 1024).catch(() => null);
      const quota = incomingResponseBackoff(response, body, Date.now());
      if (quota) { await cooldown(quota.until); throw quota; }
      const remaining = response.headers.get("x-rate-limit-remaining");
      if (remaining !== null && /^-?\d+$/.test(remaining) && Number(remaining) <= 100) {
        const reset = quotaResetTime(response.headers.get("x-rate-limit-reset"), Date.now());
        await cooldown(new Date(reset ? Date.parse(reset) + 120_000 : Date.now() + 86_400_000));
      }
      return response;
    } catch (error) {
      if (error instanceof IntegrationError) pending = error;
      throw error;
    }
  };
  try {
    await guard();
    const result = await operation(new ZohoTransport(config, () => accessToken(config), fetcher));
    return result;
  } catch (error) { throw pending ?? error; }
  finally {
    // Do not manufacture incoming success/heartbeat or clear captured cooldowns.
    await db.incomingSyncState.updateMany({ where: owned, data: { leaseToken: null, leaseExpiresAt: null } });
  }
}
