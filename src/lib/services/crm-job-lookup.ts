import "server-only";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import Decimal from "decimal.js";
import { z } from "zod";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import { billScope, canCreateBill, canViewFinancialSummary } from "@/lib/permissions";
import { booksConfigurationHash, centers, getConfig, IntegrationError, productionBooksRuntimeReady, type CrmMapping, type DataCenter, type ZohoConfig } from "@/lib/integrations/config";
import { connectionFingerprint } from "@/lib/integrations/connection-fingerprint";
import { mapCrmJob, VERIFIED_CRM_JOB_MAPPING } from "@/lib/integrations/crm";
import { accessToken, LEGACY_UNSCOPED_ORGANIZATION } from "@/lib/integrations/oauth";
import { ZohoTransport } from "@/lib/integrations/transport";
import { serializeJob } from "./catalog";

const externalId = z.string().regex(/^\d{1,30}$/);
const label = z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/);
const sourceShape = z.object({ organizationId: externalId, dataCenter: z.enum(Object.keys(centers) as [DataCenter, ...DataCenter[]]), environment: z.enum(["production", "sandbox"]) });
const searchInput = z.object({ companyId: z.string().trim().min(1).max(100).optional(), q: z.string().trim().min(2).max(100).regex(/^[^\u0000-\u001f\u007f]+$/) }).strict();
const selectionInput = z.object({ companyId: z.string().trim().min(1).max(100), externalCrmId: externalId,
  sourceId: z.string().regex(/^[a-f0-9]{64}$/), crmOrganizationId: externalId,
  dataCenter: sourceShape.shape.dataCenter, environment: sourceShape.shape.environment, booksOrganizationId: externalId }).strict();
const companyField = "Books_Organization_ID";
const stageField = "Stage";
const normalized = (value: string) => value.normalize("NFKC").trim().toUpperCase();
const escapeCriteria = (value: string) => value.replace(/[\\(),]/g, "\\$&");
const invalid = (message: string) => new IntegrationError("CRM_JOB_LOOKUP_INVALID", message, "BLOCKED");
type Store = Prisma.TransactionClient;
type Source = Prisma.CompanyCrmSourceGetPayload<object>;
type Context = {
  company: { id: string; active: boolean; isDemo: boolean; liveAccountingEnabled: boolean };
  source: Source | null;
  destinations: { organizationId: string; dataCenter: string; environment: string; liveEnabled: boolean;
    verifiedAt: Date | null; verificationReference: string | null; verifiedConfigurationHash: string | null }[];
  config: ZohoConfig | null;
  mapping: CrmMapping | null;
  sourceId: string | null;
  authorized: boolean;
  warning: string | null;
};
export type CrmJobSuggestion = ReturnType<typeof mapCrmJob> & {
  id: string | null; companyId: string; stage: string | null; sourceId: string;
  crmOrganizationId: string; dataCenter: DataCenter; environment: "production" | "sandbox"; booksOrganizationId: string;
};
export type CrmJobSearchResult = { companyId: string | null; jobs: CrmJobSuggestion[]; warning: string | null; hasMore: boolean };

async function context(store: Store, actor: Actor, companyId: string): Promise<Context> {
  if (!canCreateBill(actor) || !await store.user.findFirst({
    where: { id: actor.id, active: true, role: actor.role,
      memberships: { some: { companyId, active: true, company: { active: true } } } }, select: { id: true },
  })) throw new HttpError(403, "Current bill-entry access to this company is required.");
  const company = await store.company.findUnique({ where: { id: companyId }, select: { id: true, active: true, isDemo: true, liveAccountingEnabled: true } });
  if (!company?.active) throw new HttpError(404, "Company not found.");
  const source = await store.companyCrmSource.findUnique({ where: { companyId } });
  const destinations = await store.companyIntegrationDestination.findMany({
    where: { companyId, target: "ZOHO" }, select: { organizationId: true, dataCenter: true, environment: true,
      liveEnabled: true, verifiedAt: true, verificationReference: true, verifiedConfigurationHash: true },
    orderBy: [{ organizationId: "asc" }, { dataCenter: "asc" }, { environment: "asc" }],
  });
  const result: Context = { company, source, destinations, config: null, mapping: null, sourceId: null, authorized: false, warning: null };
  const production = process.env.APP_ENV === "production";
  if (production) {
    if (!productionBooksRuntimeReady(process.env) || process.env.DATABASE_TLS_MODE !== "verify-full" ||
      process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0" || company.isDemo || !company.liveAccountingEnabled ||
      /^(demo[-_]|connection-check-)/i.test(company.id)) {
      result.warning = "Production CRM job lookup requires a verified operational runtime and real company."; return result;
    }
  } else if (!["development", "test"].includes(process.env.APP_ENV ?? "") || company.liveAccountingEnabled ||
    ["ZOHO_BOOKS_WRITE_ENABLED", "ZOHO_BOOKS_LIVE_ENABLED", "ALLOW_PRODUCTION_ACCOUNTING_WRITES"].some(key => process.env[key] === "true")) {
    result.warning = "This local CRM job lookup requires accounting writes to remain disabled."; return result;
  }
  if (!source || !sourceShape.safeParse(source).success || destinations.length !== 1 || !sourceShape.safeParse(destinations[0]).success) {
    result.warning = "This company's CRM job source and exact Books destination must be configured before searching."; return result;
  }
  try {
    const config = getConfig("CRM", process.env, source.organizationId);
    const books = getConfig("ZOHO", process.env, destinations[0].organizationId);
    if (config.dataCenter !== source.dataCenter || config.environment !== source.environment ||
      books.dataCenter !== destinations[0].dataCenter || books.environment !== destinations[0].environment)
      throw invalid("The selected company's source configuration changed.");
    if (production && (config.environment !== "production" || books.environment !== "production" ||
      !config.crmMapping?.verified || !books.booksMapping?.verified || !books.networkEnabled || !destinations[0].liveEnabled ||
      !destinations[0].verifiedAt || destinations[0].verifiedAt > new Date() || !destinations[0].verificationReference?.trim() ||
      destinations[0].verifiedConfigurationHash !== booksConfigurationHash(books)))
      throw invalid("Production CRM job lookup requires this company's verified Books destination and CRM mapping.");
    result.config = config;
    result.mapping = config.crmMapping ?? VERIFIED_CRM_JOB_MAPPING;
    result.sourceId = createHash("sha256").update(JSON.stringify([companyId, source.organizationId, source.dataCenter, source.environment,
      source.createdAt.toISOString(), destinations[0], connectionFingerprint(config), connectionFingerprint(books), result.mapping, companyField, stageField])).digest("hex");
  } catch {
    result.warning = "The CRM connection is not configured for this company's source and Books destination."; return result;
  }
  if (!result.config.networkEnabled) { result.warning = "CRM job lookup is disabled. Ask an administrator to check the connection."; return result; }
  const grant = await store.integrationCredential.findUnique({ where: { target_organizationId: { target: "CRM", organizationId: result.config.organizationId } },
    select: { revokedAt: true, connectionFingerprint: true } });
  if (grant) result.authorized = !grant.revokedAt && grant.connectionFingerprint === connectionFingerprint(result.config);
  else if (result.config.refreshToken && !await store.integrationCredential.findUnique({
    where: { target_organizationId: { target: "CRM", organizationId: LEGACY_UNSCOPED_ORGANIZATION } }, select: { organizationId: true },
  })) result.authorized = true;
  if (!result.authorized) result.warning = "CRM job lookup needs this application's CRM authorization. Ask an administrator to reconnect CRM.";
  return result;
}
function identity(value: Context) {
  return JSON.stringify([value.company, value.source, value.destinations, value.sourceId, value.config?.networkEnabled, value.authorized, value.warning]);
}
async function recheck(store: Store, actor: Actor, before: Context) {
  const current = await context(store, actor, before.company.id);
  if (identity(current) !== identity(before)) throw new HttpError(409, "The company or CRM connection changed. Search for the job again.");
  return current;
}
function ready(value: Context): asserts value is Context & { config: ZohoConfig; mapping: CrmMapping; sourceId: string } {
  if (value.warning || !value.authorized || !value.config?.networkEnabled || !value.mapping || !value.sourceId)
    throw new HttpError(409, value.warning ?? "This company's CRM connection is unavailable.");
}
function transportFor(value: Context, provided?: ZohoTransport) {
  ready(value);
  if (provided && (connectionFingerprint(provided.config) !== connectionFingerprint(value.config) || !provided.config.networkEnabled ||
    JSON.stringify(provided.config.crmMapping ?? VERIFIED_CRM_JOB_MAPPING) !== JSON.stringify(value.mapping)))
    throw invalid("The CRM lookup connection does not match the selected company.");
  return provided ?? new ZohoTransport(value.config, () => accessToken(value.config));
}
function selection(value: Context) {
  ready(value);
  return { companyId: value.company.id, sourceId: value.sourceId, crmOrganizationId: value.config.organizationId,
    dataCenter: value.config.dataCenter, environment: value.config.environment, booksOrganizationId: value.destinations[0].organizationId };
}
async function verifyOrganization(transport: ZohoTransport) {
  const parsed = z.object({ org: z.array(z.object({ zgid: externalId.optional(), id: externalId.optional(), type: z.enum(["production", "sandbox"]) })).length(1) }).safeParse(
    await transport.request("/crm/v8/org", { method: "GET" }));
  if (!parsed.success || parsed.data.org[0].type !== transport.config.environment ||
    (parsed.data.org[0].zgid ?? parsed.data.org[0].id) !== transport.config.organizationId)
    throw invalid("CRM did not confirm the configured organization and environment.");
}
function fields(mapping: CrmMapping) {
  return [...new Set(["id", mapping.jobNumberField, mapping.jobNameField, mapping.jobValueField, mapping.customerField,
    mapping.currencyField, ...(mapping.approvedVariationsField ? [mapping.approvedVariationsField] : []), companyField, stageField])].join(",");
}
function providerJob(raw: Record<string, unknown>, value: Context) {
  ready(value);
  if (raw[companyField] !== value.destinations[0].organizationId) throw invalid("The CRM job belongs to a different Books company.");
  try {
    const mapped = mapCrmJob(raw, value.mapping);
    label.max(80).parse(mapped.jobNumber); label.parse(mapped.name); label.parse(mapped.customer);
    if (mapped.contractValue !== null) z.string().regex(/^\d{1,12}\.\d{2}$/).parse(mapped.contractValue);
    z.string().regex(/^-?\d{1,12}\.\d{2}$/).parse(mapped.approvedVariations);
    const stage = label.nullable().parse(raw[stageField] ?? null);
    return { ...mapped, stage };
  } catch { throw invalid("The CRM job's identity, currency, stage or monetary values could not be verified."); }
}
function searchPage(raw: unknown, perPage: 25 | 200) {
  // Zoho documents HTTP 204 for no matches; transport preserves that as null.
  if (raw === null) return { data: [] as Record<string, unknown>[], more: false };
  const parsed = z.object({ data: z.array(z.record(z.string(), z.unknown())).max(perPage), info: z.object({
    page: z.literal(1).optional(), per_page: z.literal(perPage).optional(), more_records: z.boolean(),
  }) }).safeParse(raw);
  if (!parsed.success) throw invalid("CRM returned an invalid or incomplete job search page.");
  return { data: parsed.data.data, more: parsed.data.info.more_records };
}
async function readExact(transport: ZohoTransport, value: Context, externalCrmId: string) {
  ready(value);
  const parsed = z.object({ data: z.array(z.record(z.string(), z.unknown())).length(1) }).safeParse(
    await transport.request(`/crm/v8/${value.mapping.jobModule}/${externalCrmId}`, { method: "GET", query: { fields: fields(value.mapping) } }));
  if (!parsed.success || parsed.data.data[0].id !== externalCrmId) throw invalid("CRM did not confirm the selected job ID.");
  return parsed.data.data[0];
}
function criteria(value: Context, query: string | string[], operator: "equals" | "starts_with") {
  ready(value);
  const conditions = (Array.isArray(query) ? query : [query]).map(term =>
    `(${value.mapping.jobNumberField}:${operator}:${escapeCriteria(term)})`);
  const jobCondition = conditions.length > 1 ? `(${conditions.join("or")})` : conditions[0];
  return `((${companyField}:equals:${value.destinations[0].organizationId})and${jobCondition})`;
}

async function searchCompanyCrmJobs(actor: Actor, input: { companyId: string; q: string }, provided?: ZohoTransport, prepared?: Context): Promise<CrmJobSearchResult> {
  const before = prepared ?? await context(db, actor, input.companyId);
  const result: CrmJobSearchResult = { companyId: input.companyId, jobs: [], warning: before.warning, hasMore: false };
  if (!before.warning) {
    try {
      ready(before);
      const transport = transportFor(before, provided);
      await verifyOrganization(transport);
      // Short digit strings are business job numbers, including their JOB- shorthand.
      // Longer numeric input retains the separate full CRM record-ID lookup.
      const jobQueries = /^\d{1,14}$/.test(input.q) ? [input.q, `JOB-${input.q}`] : [input.q];
      const isCrmRecordQuery = /^\d{15,30}$/.test(input.q);
      const response = searchPage(await transport.request(`/crm/v8/${before.mapping.jobModule}/search`, { method: "GET",
        query: { criteria: criteria(before, jobQueries, "starts_with"), fields: fields(before.mapping), per_page: "25", page: "1" } }), 25);
      const rows = response.data;
      if (isCrmRecordQuery) {
        try {
          const exact = await readExact(transport, before, input.q);
          if (exact[companyField] === before.destinations[0].organizationId && !rows.some(row => row.id === exact.id)) rows.unshift(exact);
        } catch (error) {
          if (!(error instanceof IntegrationError && error.code === "REMOTE_NOT_FOUND")) throw error;
        }
      }
      const seen = new Set<string>();
      const matches = rows.flatMap(raw => {
        const rowId = externalId.safeParse(raw.id);
        if (!rowId.success || seen.has(rowId.data)) throw invalid("CRM returned an invalid or repeated job identity.");
        seen.add(rowId.data);
        // Search text equals can include similar values; the company field is exact.
        if (raw[companyField] !== before.destinations[0].organizationId) return [];
        const job = providerJob(raw, before);
        return jobQueries.some(query => normalized(job.jobNumber).startsWith(normalized(query))) ||
          (isCrmRecordQuery && job.externalCrmId === input.q) ? [job] : [];
      });
      const locals = matches.length ? await db.job.findMany({ where: { companyId: input.companyId, externalCrmId: { in: matches.map(job => job.externalCrmId) } }, select: { id: true, externalCrmId: true } }) : [];
      result.jobs = matches.slice(0, 25).map(job => ({ ...job, ...selection(before),
        contractValue: canViewFinancialSummary(actor) ? job.contractValue : null,
        approvedVariations: canViewFinancialSummary(actor) ? job.approvedVariations : "0.00",
        id: locals.find(local => local.externalCrmId === job.externalCrmId)?.id ?? null }));
      result.hasMore = response.more || matches.length > 25;
    } catch {
      result.jobs = []; result.hasMore = false;
      result.warning = "CRM jobs could not be loaded for this company. Retry the search or ask an administrator to check the connection.";
    }
  }
  await recheck(db, actor, before);
  return result;
}

async function authorizedSources(actor: Actor) {
  if (!canCreateBill(actor) || !await db.user.findFirst({ where: { id: actor.id, active: true, role: actor.role }, select: { id: true } }))
    throw new HttpError(403, "Current bill-entry access is required.");
  return db.companyCrmSource.findMany({
    where: { company: { active: true, memberships: { some: {
      userId: actor.id, active: true, user: { active: true, role: actor.role },
    } } } }, orderBy: { companyId: "asc" }, take: 21,
  });
}

/** Provider reads only. Omitted company searches only current authorized sources. */
export async function searchCrmJobs(actor: Actor, payload: unknown, provided?: ZohoTransport): Promise<CrmJobSearchResult> {
  const input = searchInput.parse(payload);
  if (input.companyId) return searchCompanyCrmJobs(actor, { companyId: input.companyId, q: input.q }, provided);

  const sources = await authorizedSources(actor);
  const fingerprint = JSON.stringify(sources);
  const result: CrmJobSearchResult = { companyId: null, jobs: [], warning: null, hasMore: false };
  const contexts: Context[] = [];
  if (!sources.length) result.warning = "CRM job lookup is not configured for any of your authorized companies. Saved jobs remain available.";
  else if (sources.length > 20) result.warning = "There are too many configured CRM job sources for this search. Ask an administrator to review the company connections.";
  else {
    // Limit concurrent provider work, keeping every request company scoped. Do not
    // merge companies by job number: the same reference can identify different jobs.
    for (let offset = 0; offset < sources.length; offset += 2) {
      const outcomes = await Promise.allSettled(sources.slice(offset, offset + 2).map(async source => {
        const before = await context(db, actor, source.companyId);
        contexts.push(before);
        return searchCompanyCrmJobs(actor, { companyId: source.companyId, q: input.q }, provided, before);
      }));
      let failure: unknown;
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") { failure ??= outcome.reason; continue; }
        result.jobs.push(...outcome.value.jobs);
        result.hasMore ||= outcome.value.hasMore;
        if (outcome.value.warning) result.warning = "Some company CRM job sources could not be searched. Results may be incomplete; retry or ask an administrator to check the connections.";
      }
      if (failure) throw failure;
    }
  }
  // An early branch can lose access or change destinations while another branch
  // is still awaiting Zoho. Recheck all of them after all provider work completes.
  for (const before of contexts) await recheck(db, actor, before);
  if (JSON.stringify(await authorizedSources(actor)) !== fingerprint)
    throw new HttpError(409, "Your authorized companies or CRM sources changed. Search for the job again.");
  return result;
}

/** Saves one explicitly selected, company-verified CRM job locally; never writes to Zoho. */
export async function resolveCrmJob(actor: Actor, payload: unknown, provided?: ZohoTransport) {
  const input = selectionInput.parse(payload);
  const before = await context(db, actor, input.companyId);
  ready(before);
  const expected = selection(before);
  if (Object.entries(expected).some(([key, value]) => input[key as keyof typeof expected] !== value))
    throw new HttpError(409, "The job selection no longer matches this company's CRM source. Search again.");
  const transport = transportFor(before, provided);
  await verifyOrganization(transport);
  const job = providerJob(await readExact(transport, before, input.externalCrmId), before);
  const response = searchPage(await transport.request(`/crm/v8/${before.mapping.jobModule}/search`, { method: "GET", query: {
    criteria: criteria(before, job.jobNumber, "equals"), fields: `id,${before.mapping.jobNumberField},${companyField}`, per_page: "200", page: "1",
  } }), 200);
  const exact = response.data.filter(raw => {
    if (!externalId.safeParse(raw.id).success || !label.max(80).safeParse(raw[before.mapping.jobNumberField]).success || !externalId.safeParse(raw[companyField]).success)
      throw invalid("CRM did not provide complete job-number uniqueness evidence.");
    return raw[companyField] === expected.booksOrganizationId && normalized(String(raw[before.mapping.jobNumberField])) === job.jobNumber;
  });
  if (response.more || exact.length !== 1 || exact[0].id !== job.externalCrmId)
    throw new HttpError(409, "This job number is absent, duplicated or could not be verified for the selected company. Ask an administrator to review CRM.");
  await recheck(db, actor, before);
  const { stage, ...mapped } = job;
  try {
    return await db.$transaction(async tx => {
      await recheck(tx, actor, before);
      const existing = await tx.job.findUnique({ where: { companyId_externalCrmId: { companyId: input.companyId, externalCrmId: input.externalCrmId } },
        include: { bills: { where: billScope(actor) } } });
      const collision = await tx.job.findFirst({ where: { companyId: input.companyId, jobNumber: { equals: mapped.jobNumber } }, select: { id: true } });
      if (collision && collision.id !== existing?.id) throw new HttpError(409, "A different saved job already uses this job number. Existing records were preserved; ask an administrator to review the link.");
      if (existing) {
        if (existing.isDemo !== before.company.isDemo || normalized(existing.jobNumber) !== mapped.jobNumber || existing.name !== mapped.name || existing.customer !== mapped.customer || existing.currency !== mapped.currency ||
          (existing.contractValue?.toFixed(2) ?? null) !== mapped.contractValue ||
          (before.mapping.approvedVariationsField && !new Decimal(existing.approvedVariations.toString()).equals(mapped.approvedVariations)))
          throw new HttpError(409, "The saved job differs from its current CRM identity, currency or value. Existing records were preserved; ask an administrator to review the job before adding bills.");
        await recheck(tx, actor, before);
        return { job: serializeJob(actor, existing), stage };
      }
      const created = await tx.job.create({ data: { ...mapped, companyId: input.companyId, isDemo: before.company.isDemo }, include: { bills: { where: billScope(actor) } } });
      await tx.auditLog.create({ data: { actorId: actor.id, companyId: input.companyId, action: "CRM_JOB_SELECTED", entityType: "Job", entityId: created.id,
        details: { ...expected, externalCrmId: mapped.externalCrmId, jobNumber: mapped.jobNumber, providerFinancialWrites: 0 } } });
      await recheck(tx, actor, before);
      return { job: serializeJob(actor, created), stage };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20_000 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2034"].includes(error.code))
      throw new HttpError(409, "The job selection changed while saving. Search for the job again.");
    throw error;
  }
}
