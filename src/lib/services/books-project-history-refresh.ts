import "server-only";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Prisma, type BooksProjectAssociation } from "@prisma/client";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { assertNetwork, IntegrationError, type ZohoConfig } from "@/lib/integrations/config";
import { accessToken } from "@/lib/integrations/oauth";
import { boundedJson } from "@/lib/integrations/response";
import type { Fetch } from "@/lib/integrations/transport";
import { quotaResetTime } from "./books-attachment-download";
import { importBooksProjectAssociation, isZohoProjectsSourceProject, type BooksProjectAssociationInput } from "./books-project-history";
import { assertIncomingSource, incomingSources } from "./incoming-sync-access";
import { incomingSyncSettings } from "./incoming-sync-config";
import { incomingConfiguredDelay } from "./incoming-sync";
import { IncomingQuotaError, incomingResponseBackoff } from "./incoming-sync-transport";
import type { IncomingSource } from "./incoming-sync-types";

const PROJECTS_ORIGIN = "https://projects.zoho.com";
const LEASE_MS = 90_000;
const MAX_PAGES = 4;
const txOptions = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 };
type Source = IncomingSource & { scopeHash: string };
type Kind = "BOOKS" | "CRM" | "PROJECTS";
type Reference = Pick<BooksProjectAssociation, "id" | "companyId" | "organizationId" | "dataCenter" | "environment" | "booksProjectId" | "zprojectsProjectId" | "portalId" | "crmOrganizationId" | "crmDataCenter" | "crmEnvironment">;
const fail = (code: string, retry = false) => new IntegrationError(code, "Project history refresh requires retry or source review.", retry ? "RETRY" : "BLOCKED");
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const numericId = (value: unknown): value is string => typeof value === "string" && /^\d{1,30}$/.test(value);

/** Only the existing Books project and its explicit Projects/CRM identity chain can be read. */
export function createProjectHistoryReader(options: {
  reference: Reference; books: ZohoConfig; crm: ZohoConfig;
  guard(): Promise<void>; token(kind: "BOOKS" | "CRM"): Promise<string>;
  cooldown(kind: Kind, until: Date): Promise<void>;
  signal?: AbortSignal; fetcher?: Fetch; now?: () => number; sleep?: (ms: number) => Promise<void>;
  pacing?: { lastRequest: number };
}) {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (async ms => { await delay(ms, undefined, { signal: options.signal }); });
  const ref = options.reference;
  const projectIds = new Set([ref.zprojectsProjectId]);
  let requests = 0;
  const pacing = options.pacing ?? { lastRequest: -Infinity };
  function allowProject(id: string) { if (!numericId(id)) throw fail("BOOKS_HISTORY_PROJECT_INVALID"); projectIds.add(id); }
  async function get(kind: Kind, path: string, query: Record<string, string> = {}): Promise<unknown> {
    const config = kind === "BOOKS" ? options.books : options.crm;
    if ([options.books, options.crm].some(item => item.dataCenter !== "US" || item.environment !== "production" || item.apiOrigin !== "https://www.zohoapis.com"))
      throw fail("BOOKS_HISTORY_REGION_UNSUPPORTED");
    assertNetwork(config);
    const projectPath = path.match(/^\/api\/v3\/portal\/(\d{1,30})\/projects\/(\d{1,30})\/crm\/deals$/);
    const allowed = kind === "BOOKS" ? path === `/books/v3/organizations/${ref.organizationId}` || path === `/books/v3/projects/${ref.booksProjectId}`
      : kind === "CRM" ? path === "/crm/v8/org" || path === "/crm/v8/Deals"
        : path === "/api/v3.1/portals" || projectPath?.[1] === ref.portalId && projectIds.has(projectPath[2]);
    const allowedKeys = kind === "BOOKS" ? [] : path.endsWith("/portals") ? ["environment", "status"] : kind === "PROJECTS" ? ["page", "per_page"] : ["ids", "fields", "page", "per_page"];
    if (!allowed || (!/^\/[A-Za-z0-9_/]+$/.test(path) && path !== "/api/v3.1/portals") || Object.keys(query).some(key => !allowedKeys.includes(key)) ||
      kind === "CRM" && path.endsWith("/Deals") && (!query.ids || query.ids.split(",").length > 200 || query.ids.split(",").some(value => !numericId(value))))
      throw fail("BOOKS_HISTORY_ENDPOINT_REJECTED");
    if (requests >= 12 || options.signal?.aborted) throw fail("BOOKS_HISTORY_READ_BUDGET", true);
    await options.guard();
    const gap = pacing.lastRequest + 1100 - now();
    if (gap > 0) await sleep(gap);
    const token = await options.token(kind === "BOOKS" ? "BOOKS" : "CRM");
    await options.guard();
    if (options.signal?.aborted) throw fail("BOOKS_HISTORY_STOPPED", true);
    const url = new URL(path, kind === "PROJECTS" ? PROJECTS_ORIGIN : config.apiOrigin);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    if (kind === "BOOKS") url.searchParams.set("organization_id", ref.organizationId);
    requests++; pacing.lastRequest = now();
    let response: Response;
    try {
      response = await (options.fetcher ?? fetch)(url, { method: "GET", headers: { Authorization: `${kind === "PROJECTS" ? "Bearer" : "Zoho-oauthtoken"} ${token}` },
        redirect: "error", cache: "no-store", signal: AbortSignal.any([AbortSignal.timeout(25_000), ...(options.signal ? [options.signal] : [])]) });
    } catch { throw fail("BOOKS_HISTORY_NETWORK_UNAVAILABLE", true); }
    let body: unknown = null;
    if (response.status !== 204 && response.status !== 304) {
      try { body = await boundedJson(response, 2 * 1024 * 1024); } catch { if (response.ok) throw fail("BOOKS_HISTORY_RESPONSE_INVALID"); }
    }
    const quota = incomingResponseBackoff(response, body, now());
    if (quota) { await options.cooldown(kind, quota.until); throw quota; }
    const remaining = response.headers.get("x-rate-limit-remaining");
    if (kind === "BOOKS" && remaining !== null && /^-?\d+$/.test(remaining) && Number(remaining) <= 100) {
      const reset = quotaResetTime(response.headers.get("x-rate-limit-reset"), now());
      await options.cooldown("BOOKS", new Date(reset ? Date.parse(reset) + 120_000 : now() + 86_400_000));
    }
    if (response.status === 401 || response.status === 403) throw fail("BOOKS_HISTORY_AUTHORIZATION_REQUIRED");
    if (kind === "BOOKS" && path === `/books/v3/projects/${ref.booksProjectId}` && (response.status === 404 || String(record(body).code) === "1002")) throw fail("BOOKS_HISTORY_PROJECT_REMOVED");
    if (response.status === 408 || response.status >= 500) throw fail("BOOKS_HISTORY_REMOTE_UNAVAILABLE", true);
    if (!response.ok || body === null || kind === "BOOKS" && String(record(body).code) !== "0") throw fail("BOOKS_HISTORY_PROVIDER_REJECTED");
    return body;
  }
  return { get, allowProject, requests: () => requests };
}

/** A partial page, missing CRM record, or unverified portal never replaces the last good proof. */
export async function collectProjectHistoryProof(ref: Reference, reader: Pick<ReturnType<typeof createProjectHistoryReader>, "get" | "allowProject">, now = new Date()): Promise<BooksProjectAssociationInput> {
  if (ref.dataCenter !== "US" || ref.crmDataCenter !== "US" || ref.environment !== "production" || ref.crmEnvironment !== "production") throw fail("BOOKS_HISTORY_REGION_UNSUPPORTED");
  const booksProof = record(await reader.get("BOOKS", `/books/v3/organizations/${ref.organizationId}`));
  if (record(booksProof.organization).organization_id !== ref.organizationId) throw fail("BOOKS_HISTORY_ORGANIZATION_MISMATCH");
  const crmProof = record(await reader.get("CRM", "/crm/v8/org"));
  const organizations = crmProof.org;
  if (!Array.isArray(organizations) || organizations.length !== 1 || (record(organizations[0]).zgid ?? record(organizations[0]).id) !== ref.crmOrganizationId || record(organizations[0]).type !== ref.crmEnvironment)
    throw fail("BOOKS_HISTORY_ORGANIZATION_MISMATCH");
  const project = record(record(await reader.get("BOOKS", `/books/v3/projects/${ref.booksProjectId}`)).project);
  if (project.project_id !== ref.booksProjectId) throw fail("BOOKS_HISTORY_PROJECT_ID_MISMATCH");
  if (!numericId(project.zprojects_project_id) || !isZohoProjectsSourceProject(project)) throw fail("BOOKS_HISTORY_PROJECT_UNLINKED");
  reader.allowProject(project.zprojects_project_id);
  const portals = record(await reader.get("PROJECTS", "/api/v3.1/portals", { environment: "production", status: "active" })).portals;
  if (!Array.isArray(portals) || portals.filter(value => record(value).id === ref.portalId && record(value).environment === "production").length !== 1)
    throw fail("BOOKS_HISTORY_PORTAL_MISMATCH");
  const pages: unknown[] = [], ids: string[] = [];
  let complete = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await reader.get("PROJECTS", `/api/v3/portal/${ref.portalId}/projects/${project.zprojects_project_id}/crm/deals`, { page: String(page), per_page: "200" });
    const body = record(response), info = record(body.info);
    if (!Array.isArray(body.deals) || body.deals.length > 200 || Number(info.page) !== page || ![true, false, "true", "false"].includes(info.has_next_page as boolean | string)) throw fail("BOOKS_HISTORY_PAGE_INVALID");
    for (const value of body.deals) {
      const id = record(value).id;
      if (!numericId(id) || ids.includes(id)) throw fail("BOOKS_HISTORY_DUPLICATE_OR_INVALID_DEAL");
      ids.push(id);
    }
    pages.push(response);
    if (info.has_next_page === false || info.has_next_page === "false") { complete = true; break; }
    if (!body.deals.length) throw fail("BOOKS_HISTORY_PAGE_INVALID");
  }
  if (!complete) throw fail("BOOKS_HISTORY_PAGES_INCOMPLETE", true);
  const records: unknown[] = [];
  for (let offset = 0; offset < ids.length; offset += 200) {
    const expected = ids.slice(offset, offset + 200);
    const response = record(await reader.get("CRM", "/crm/v8/Deals", { ids: expected.join(","), fields: "id,Deal_Name,DealNumber,JobDealNumber,Books_Organization_ID,Modified_Time", page: "1", per_page: "200" }));
    if (!Array.isArray(response.data) || response.data.length !== expected.length || record(response.info).more_records === true ||
      new Set(response.data.map(value => record(value).id)).size !== expected.length || response.data.some(value => !expected.includes(String(record(value).id)))) throw fail("BOOKS_HISTORY_CRM_RECORDS_INCOMPLETE", true);
    records.push(...response.data);
  }
  return { companyId: ref.companyId, booksSource: { organizationId: ref.organizationId, dataCenter: "US", environment: "production" },
    crmSource: { organizationId: ref.crmOrganizationId, dataCenter: "US", environment: "production" }, portalId: ref.portalId,
    sourceProject: project, sourceDealsPages: pages, sourceCrmRecords: records, verifiedAt: now.toISOString() };
}

export async function assertProjectHistoryLease(tx: Prisma.TransactionClient, actor: Actor, row: BooksProjectAssociation, token: string, books: Source, crm: Source) {
  if (!incomingSyncSettings().enabled) throw fail("BOOKS_HISTORY_DISABLED");
  const now = new Date();
  const locked = await tx.booksProjectAssociation.updateMany({ where: { id: row.id, sourceHash: row.sourceHash, verifiedAt: row.verifiedAt,
    leaseToken: token, leaseExpiresAt: { gt: now } }, data: { leaseExpiresAt: new Date(now.valueOf() + LEASE_MS) } });
  if (locked.count !== 1) throw fail("BOOKS_HISTORY_LEASE_LOST");
  const current = await tx.booksProjectAssociation.findUnique({ where: { id: row.id }, select: { backoffUntil: true } });
  if (current?.backoffUntil && current.backoffUntil > now)
    throw new IncomingQuotaError(current.backoffUntil, "BOOKS_HISTORY_ASSOCIATION_COOLDOWN");
  const binding = await tx.companyCrmSource.findUnique({ where: { companyId: row.companyId } });
  if (!binding || binding.organizationId !== row.crmOrganizationId || binding.dataCenter !== row.crmDataCenter || binding.environment !== row.crmEnvironment) throw fail("BOOKS_HISTORY_SOURCE_CHANGED");
  assertNetwork(await assertIncomingSource(actor, books, books.scopeHash, tx));
  assertNetwork(await assertIncomingSource(actor, crm, crm.scopeHash, tx));
}

export async function processBooksProjectHistoryRefresh(actor: Actor, options: { signal?: AbortSignal; externalDelay?: (source: IncomingSource) => Promise<Date | null> } = {}) {
  if (!incomingSyncSettings().enabled) return { enabled: false, attempted: 0, refreshed: 0, failed: 0, providerReads: 0 };
  const sources = await incomingSources(actor);
  const now = new Date();
  const rows = await db.booksProjectAssociation.findMany({ where: { nextRefreshAt: { lte: now },
    companyId: { in: sources.filter(value => value.target === "ZOHO" && !value.configurationError && value.companyId).map(value => value.companyId!) },
    AND: [{ OR: [{ leaseToken: null }, { leaseExpiresAt: { lte: now } }] }, { OR: [{ backoffUntil: null }, { backoffUntil: { lte: now } }] }] },
    orderBy: [{ nextRefreshAt: "asc" }, { id: "asc" }], take: 2 });
  let attempted = 0, refreshed = 0, failed = 0, providerReads = 0;
  const pacing = { lastRequest: -Infinity };
  for (const row of rows) {
    if (options.signal?.aborted) break;
    const token = randomUUID();
    const claimed = await db.booksProjectAssociation.updateMany({ where: { id: row.id, sourceHash: row.sourceHash, verifiedAt: row.verifiedAt,
      nextRefreshAt: { lte: new Date() }, AND: [{ OR: [{ leaseToken: null }, { leaseExpiresAt: { lte: new Date() } }] }, { OR: [{ backoffUntil: null }, { backoffUntil: { lte: new Date() } }] }] },
      data: { leaseToken: token, leaseExpiresAt: new Date(Date.now() + LEASE_MS), lastAttemptAt: new Date() } });
    if (claimed.count !== 1) continue;
    attempted++;
    const owned = { id: row.id, leaseToken: token, sourceHash: row.sourceHash, verifiedAt: row.verifiedAt };
    let reader: ReturnType<typeof createProjectHistoryReader> | undefined;
    try {
      const books = sources.find(value => value.target === "ZOHO" && !value.configurationError && value.companyId === row.companyId && value.organizationId === row.organizationId && value.dataCenter === row.dataCenter && value.environment === row.environment);
      const crm = sources.find(value => value.target === "CRM" && !value.configurationError && value.organizationId === row.crmOrganizationId && value.dataCenter === row.crmDataCenter && value.environment === row.crmEnvironment);
      if (!books || !crm) throw fail("BOOKS_HISTORY_SOURCE_CHANGED");
      const configs = { BOOKS: await assertIncomingSource(actor, books, books.scopeHash), CRM: await assertIncomingSource(actor, crm, crm.scopeHash) };
      if (configs.CRM.crmMapping?.jobModule !== "Deals") throw fail("BOOKS_HISTORY_MODULE_UNSUPPORTED");
      const guard = async () => {
        await db.$transaction(tx => assertProjectHistoryLease(tx, actor, row, token, books, crm), txOptions);
        for (const source of [books, crm]) {
          const state = await db.incomingSyncState.findUnique({ where: { target_organizationId_dataCenter_environment: { target: source.target, organizationId: source.organizationId, dataCenter: source.dataCenter, environment: source.environment } } });
          if (!state || state.scopeHash !== source.scopeHash || state.status === "BLOCKED") throw fail("BOOKS_HISTORY_SOURCE_UNAVAILABLE");
          const times = [incomingConfiguredDelay(source), await options.externalDelay?.(source), state.backoffUntil,
            ["WAITING_QUOTA", "RETRY"].includes(state.status) ? state.nextRunAt : null].filter((value): value is Date => value instanceof Date && value > new Date());
          if (times.length) throw new IncomingQuotaError(new Date(Math.max(...times.map(value => value.valueOf()))), "BOOKS_HISTORY_SOURCE_COOLDOWN");
        }
      };
      const cooldown = async (kind: Kind, until: Date) => {
        const source = kind === "BOOKS" ? books : crm;
        await db.$transaction(async tx => {
          await assertProjectHistoryLease(tx, actor, row, token, books, crm);
          if (kind === "PROJECTS") {
            // Projects has its own API quota. Do not pause unrelated CRM metadata reads.
            // Active leases remain intact; their next guard observes this shared portal delay.
            const portalSource = { portalId: row.portalId, crmOrganizationId: row.crmOrganizationId,
              crmDataCenter: row.crmDataCenter, crmEnvironment: row.crmEnvironment };
            await tx.booksProjectAssociation.updateMany({ where: { ...portalSource, OR: [{ backoffUntil: null }, { backoffUntil: { lt: until } }] }, data: { backoffUntil: until } });
            await tx.booksProjectAssociation.updateMany({ where: { ...portalSource, nextRefreshAt: { lt: until } }, data: { nextRefreshAt: until } });
            return;
          }
          await tx.booksProjectAssociation.updateMany({ where: owned, data: { backoffUntil: until, nextRefreshAt: until } });
          // Share quota knowledge with the existing incoming worker without taking its lease or changing its checkpoint.
          const sourceWhere = { target: source.target, organizationId: source.organizationId, dataCenter: source.dataCenter, environment: source.environment, scopeHash: source.scopeHash };
          await tx.incomingSyncState.updateMany({ where: { ...sourceWhere, OR: [{ backoffUntil: null }, { backoffUntil: { lt: until } }] }, data: { backoffUntil: until } });
          await tx.incomingSyncState.updateMany({ where: { ...sourceWhere, nextRunAt: { lt: until } }, data: { nextRunAt: until } });
        }, txOptions);
      };
      reader = createProjectHistoryReader({ reference: row, books: configs.BOOKS, crm: configs.CRM, guard, cooldown, signal: options.signal, pacing,
        token: kind => accessToken(configs[kind]) });
      const proof = await collectProjectHistoryProof(row, reader);
      await guard();
      await importBooksProjectAssociation(actor, proof, { assertLease: tx => assertProjectHistoryLease(tx, actor, row, token, books, crm) });
      refreshed++;
    } catch (error) {
      failed++;
      const code = error instanceof IntegrationError && /^[A-Z][A-Z0-9_]{0,99}$/.test(error.code) ? error.code : "BOOKS_HISTORY_REFRESH_FAILED";
      const failures = Math.min(row.failures + 1, 12);
      const next = error instanceof IncomingQuotaError ? error.until : new Date(Date.now() + (error instanceof IntegrationError && error.kind === "BLOCKED" ? 3600_000 : Math.min(3600_000, 30_000 * 2 ** failures)));
      await db.booksProjectAssociation.updateMany({ where: owned, data: { lastErrorCode: code, failures, nextRefreshAt: next,
        ...(error instanceof IncomingQuotaError ? { backoffUntil: next } : {}),
        ...(["BOOKS_HISTORY_PROJECT_REMOVED", "BOOKS_HISTORY_PROJECT_UNLINKED", "BOOKS_HISTORY_SOURCE_CHANGED"].includes(code) ? { status: "STALE" } : {}) } });
    } finally {
      providerReads += reader?.requests() ?? 0;
      await db.booksProjectAssociation.updateMany({ where: { id: row.id, leaseToken: token }, data: { leaseToken: null, leaseExpiresAt: null } });
    }
  }
  return { enabled: true, attempted, refreshed, failed, providerReads };
}
