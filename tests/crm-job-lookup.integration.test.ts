import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { getConfig } from "@/lib/integrations/config";
import { connectionFingerprint } from "@/lib/integrations/connection-fingerprint";
import { VERIFIED_CRM_JOB_MAPPING } from "@/lib/integrations/crm";
import { ZohoTransport, type Fetch } from "@/lib/integrations/transport";
import { resolveCrmJob, searchCrmJobs, type CrmJobSuggestion } from "@/lib/services/crm-job-lookup";
import { assertMySqlTestDatabase, bindTestDestination, createTestCompany } from "./company-fixtures";

// Real SQL runs only in the guarded disposable harness. All provider reads use
// the explicitly supplied transport below; no Zoho mutation is ever permitted.
const tag = randomUUID().slice(0, 8).toUpperCase();
const organizationId = `973${Date.now()}`;
const booksA = `${organizationId}1`, booksB = `${organizationId}2`;
const reference = `SQLCRM-${tag}`;
let actor: Actor, restricted: Actor, companyA: string, companyB: string;
const companyIds: string[] = [];
const record = (id: string, booksOrganizationId: string, jobNumber = reference, name = "Fictional SQL CRM job") => ({
  id, JobDealNumber: jobNumber, Deal_Name: name, Amount: "2200.00", Account_Name: { id: "87001", name: "Fictional SQL customer" },
  Currency: "AED", Books_Organization_ID: booksOrganizationId, Stage: "Closed Won",
});
const selection = (job: CrmJobSuggestion) => ({ companyId: job.companyId, externalCrmId: job.externalCrmId, sourceId: job.sourceId,
  crmOrganizationId: job.crmOrganizationId, dataCenter: job.dataCenter, environment: job.environment, booksOrganizationId: job.booksOrganizationId });
function connection(records: ReturnType<typeof record>[]) {
  const fetcher = vi.fn<Fetch>(async (input, init) => {
    const url = new URL(input);
    expect(init?.method).toBe("GET");
    expect(url.origin).toBe("https://www.zohoapis.com");
    if (url.pathname === "/crm/v8/org") return Response.json({ org: [{ zgid: organizationId, type: "production" }] });
    if (url.pathname === "/crm/v8/Deals/search") return Response.json({ data: records,
      info: { page: 1, per_page: Number(url.searchParams.get("per_page")), more_records: false } });
    const found = records.find((row) => url.pathname === `/crm/v8/Deals/${row.id}`);
    if (!found) throw new Error("Unexpected fictional provider request.");
    return Response.json({ data: [found] });
  });
  return { fetcher, transport: new ZohoTransport(getConfig("CRM"), async () => "fictional-transport-token", fetcher) };
}
async function choose(companyId: string, row: ReturnType<typeof record>, records = [row]) {
  const remote = connection(records);
  const result = await searchCrmJobs(actor, { companyId, q: row.JobDealNumber }, remote.transport);
  expect(result.warning).toBeNull();
  const match = result.jobs.find((job) => job.externalCrmId === row.id);
  expect(match).toBeDefined();
  return { ...remote, input: selection(match!) };
}

beforeAll(async () => {
  assertMySqlTestDatabase();
  actor = await db.user.create({ data: { email: `crm-sql-${tag.toLowerCase()}@example.invalid`, name: "Fictional CRM SQL admin", role: "ADMIN", passwordHash: "unused-fixture" } });
  restricted = await db.user.create({ data: { email: `crm-sql-restricted-${tag.toLowerCase()}@example.invalid`, name: "Fictional restricted writer", role: "ACCOUNTS", passwordHash: "unused-fixture" } });
  companyA = (await createTestCompany(`CRM SQL Alpha ${tag}`, [actor, restricted])).id;
  companyB = (await createTestCompany(`CRM SQL Beta ${tag}`, [actor])).id;
  companyIds.push(companyA, companyB);
  await bindTestDestination(companyA, { target: "ZOHO", organizationId: booksA, environment: "production" });
  await bindTestDestination(companyB, { target: "ZOHO", organizationId: booksB, environment: "production" });
  await db.companyCrmSource.createMany({ data: companyIds.map((companyId) => ({ companyId, organizationId, dataCenter: "US", environment: "production" })) });
  for (const [key, value] of Object.entries({
    INTEGRATION_NETWORK_ENABLED: "true", ZOHO_CRM_NETWORK_ENABLED: "true", ZOHO_CRM_DC: "US", ZOHO_CRM_ENVIRONMENT: "production",
    ZOHO_CRM_ORGANIZATION_ID: organizationId, ZOHO_CRM_CLIENT_ID: "fictional-crm-sql-client", ZOHO_CRM_CLIENT_SECRET: "fictional-crm-sql-secret",
    ZOHO_CRM_MAPPING_JSON: JSON.stringify(VERIFIED_CRM_JOB_MAPPING), ZOHO_CRM_REFRESH_TOKEN: "",
    ZOHO_BOOKS_DC: "US", ZOHO_BOOKS_ENVIRONMENT: "production", ZOHO_BOOKS_CLIENT_ID: "fictional-books-sql-client", ZOHO_BOOKS_CLIENT_SECRET: "fictional-books-sql-secret",
    ZOHO_BOOKS_ORGANIZATIONS_JSON: JSON.stringify([{ organizationId: booksA, name: "Fictional SQL Alpha" }, { organizationId: booksB, name: "Fictional SQL Beta" }]),
    ZOHO_BOOKS_WRITE_ENABLED: "false", ZOHO_BOOKS_LIVE_ENABLED: "false", ALLOW_PRODUCTION_ACCOUNTING_WRITES: "false", INTEGRATION_TEST_MODE: "false",
  })) vi.stubEnv(key, value);
  await db.integrationCredential.create({ data: { target: "CRM", organizationId, dataCenter: "US",
    connectionFingerprint: connectionFingerprint(getConfig("CRM")), refreshTokenEncrypted: "never-decrypted-fictional-fixture" } });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("No live provider calls are allowed in SQL fixtures."); }));
});
afterAll(async () => {
  // Remove only this suite's shared-source foreign keys before any harness company cleanup.
  if (companyIds.length) await db.companyCrmSource.deleteMany({ where: { companyId: { in: companyIds } } });
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); await db.$disconnect();
});

describe("shared CRM job resolution on disposable MySQL", () => {
  it("automatically searches authorized company sources without mixing their identities or revealing inaccessible matches", async () => {
    const query = `AUTO-${tag}`;
    const rows = [record("87901", booksA, query, "Fictional automatic Alpha"), record("87902", booksB, query, "Fictional automatic Beta")];
    const remote = connection(rows);
    const before = await db.job.count({ where: { companyId: { in: companyIds } } });
    const all = await searchCrmJobs(actor, { q: query }, remote.transport);
    expect(all.companyId).toBeNull();
    expect(all.warning).toBeNull();
    expect(all.jobs).toHaveLength(2);
    expect(new Set(all.jobs.map((job) => job.companyId))).toEqual(new Set(companyIds));
    expect(all.jobs.map((job) => [job.companyId, job.booksOrganizationId, job.externalCrmId])).toEqual(expect.arrayContaining([
      [companyA, booksA, "87901"], [companyB, booksB, "87902"],
    ]));
    expect(new Set(all.jobs.map((job) => job.sourceId)).size).toBe(2);
    remote.fetcher.mockClear();
    const limited = await searchCrmJobs(restricted, { q: query }, remote.transport);
    expect(limited.companyId).toBeNull();
    expect(limited.jobs).toMatchObject([{ companyId: companyA, booksOrganizationId: booksA, externalCrmId: "87901" }]);
    expect(limited.jobs).toHaveLength(1);
    expect(JSON.stringify(limited)).not.toContain("Fictional automatic Beta");
    expect(remote.fetcher.mock.calls.filter(([url]) => new URL(url).pathname.endsWith("/search"))
      .every(([url]) => new URL(url).searchParams.get("criteria")!.includes(`Books_Organization_ID:equals:${booksA}`))).toBe(true);
    expect(await db.job.count({ where: { companyId: { in: companyIds } } })).toBe(before);
  });

  it("keeps one shared source for two companies and resolves identical references into separate audited jobs", async () => {
    expect(await db.companyCrmSource.count({ where: { organizationId, companyId: { in: companyIds } } })).toBe(2);
    const rows = [record("87401", booksA, reference, "Fictional Alpha job"), record("87402", booksB, reference, "Fictional Beta job")];
    const before = await db.job.count({ where: { companyId: { in: companyIds } } });
    const first = await choose(companyA, rows[0], rows), second = await choose(companyB, rows[1], rows);
    expect(await db.job.count({ where: { companyId: { in: companyIds } } })).toBe(before);
    const a = await resolveCrmJob(actor, first.input, first.transport);
    const b = await resolveCrmJob(actor, second.input, second.transport);
    expect(a.job.id).not.toBe(b.job.id);
    expect(a.job).toMatchObject({ companyId: companyA, jobNumber: reference, externalCrmId: "87401", contractValue: "2200.00" });
    expect(b.job).toMatchObject({ companyId: companyB, jobNumber: reference, externalCrmId: "87402", contractValue: "2200.00" });
    expect((await resolveCrmJob(actor, first.input, first.transport)).job.id).toBe(a.job.id);
    expect((await resolveCrmJob(actor, second.input, second.transport)).job.id).toBe(b.job.id);
    expect(await db.job.count({ where: { companyId: { in: companyIds }, jobNumber: reference } })).toBe(2);
    const audit = await db.auditLog.findMany({ where: { action: "CRM_JOB_SELECTED", entityId: { in: [a.job.id, b.job.id] } } });
    expect(audit).toHaveLength(2);
    expect(new Set(audit.map((entry) => entry.companyId))).toEqual(new Set(companyIds));
    expect(audit.every((entry) => JSON.stringify(entry.details).includes('"providerFinancialWrites":0'))).toBe(true);
    const searched = await searchCrmJobs(actor, { companyId: companyA, q: reference }, first.transport);
    expect(searched.jobs.map((job) => job.id)).toEqual([a.job.id]);
  });

  it("serializes concurrent resolutions into one job and one audit, with safe reuse after any conflict", async () => {
    const remote = await choose(companyA, record("87403", booksA, `RACE-${tag}`));
    const attempts = await Promise.allSettled([
      resolveCrmJob(actor, remote.input, remote.transport), resolveCrmJob(actor, remote.input, remote.transport),
    ]);
    const fulfilled = attempts.filter((result) => result.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    for (const result of attempts) if (result.status === "rejected") expect(result.reason).toMatchObject({ status: 409 });
    const jobs = await db.job.findMany({ where: { companyId: companyA, externalCrmId: "87403" } });
    expect(jobs).toHaveLength(1);
    expect(await db.auditLog.count({ where: { action: "CRM_JOB_SELECTED", entityId: jobs[0].id } })).toBe(1);
    expect((await resolveCrmJob(actor, remote.input, remote.transport)).job.id).toBe(jobs[0].id);
    expect(fulfilled.every((result) => result.value.job.id === jobs[0].id)).toBe(true);
  });

  it("refuses wrong Books ownership and stale source assignments without inserting a job", async () => {
    const row = record("87404", booksA, `STALE-${tag}`);
    const remote = await choose(companyA, row);
    remote.fetcher.mockClear();
    await expect(resolveCrmJob(actor, { ...remote.input, booksOrganizationId: booksB }, remote.transport)).rejects.toMatchObject({ status: 409 });
    expect(remote.fetcher).not.toHaveBeenCalled();
    const original = await db.companyCrmSource.findUniqueOrThrow({ where: { companyId: companyA } });
    await db.companyCrmSource.update({ where: { companyId: companyA }, data: { createdAt: new Date(original.createdAt.getTime() + 1000) } });
    try {
      await expect(resolveCrmJob(actor, remote.input, remote.transport)).rejects.toMatchObject({ status: 409 });
      expect(remote.fetcher).not.toHaveBeenCalled();
    } finally {
      await db.companyCrmSource.update({ where: { companyId: companyA }, data: { createdAt: original.createdAt } });
    }
    await expect(resolveCrmJob(actor, remote.input, connection([{ ...row, Books_Organization_ID: booksB }]).transport))
      .rejects.toMatchObject({ code: "CRM_JOB_LOOKUP_INVALID" });
    expect(await db.job.count({ where: { companyId: companyA, externalCrmId: row.id } })).toBe(0);
  });

  it("preserves an existing job when CRM values change or an unlinked local reference collides", async () => {
    const row = record("87405", booksA, `PRESERVE-${tag}`);
    const remote = await choose(companyA, row);
    const selected = await resolveCrmJob(actor, remote.input, remote.transport);
    const original = await db.job.findUniqueOrThrow({ where: { id: selected.job.id } });
    await expect(resolveCrmJob(actor, remote.input, connection([{ ...row, Amount: "9999.00" }]).transport)).rejects.toMatchObject({ status: 409 });
    expect(await db.job.findUniqueOrThrow({ where: { id: selected.job.id } })).toEqual(original);
    const local = await db.job.create({ data: { companyId: companyA, jobNumber: `COLLISION-${tag}`, name: "Fictional preserved local job",
      customer: "Fictional original customer", currency: "AED", contractValue: "123.45" } });
    const collision = await choose(companyA, record("87406", booksA, local.jobNumber));
    await expect(resolveCrmJob(actor, collision.input, collision.transport)).rejects.toMatchObject({ status: 409 });
    expect(await db.job.findUniqueOrThrow({ where: { id: local.id } })).toEqual(local);
    expect(await db.job.count({ where: { companyId: companyA, externalCrmId: "87406" } })).toBe(0);
  });

  it("enforces current company membership and both compound job uniqueness constraints in SQL", async () => {
    const remote = connection([record("87407", booksB, `ACCESS-${tag}`)]);
    await expect(searchCrmJobs(restricted, { companyId: companyB, q: `ACCESS-${tag}` }, remote.transport)).rejects.toMatchObject({ status: 403 });
    expect(remote.fetcher).not.toHaveBeenCalled();
    const existing = await db.job.create({ data: { companyId: companyA, externalCrmId: "87409", jobNumber: `UNIQUE-${tag}`,
      name: "Fictional unique identity", customer: "Fictional unique customer", currency: "AED", contractValue: "300.00" } });
    const data = { companyId: companyA, jobNumber: existing.jobNumber, name: existing.name, customer: existing.customer,
      currency: existing.currency, contractValue: existing.contractValue, externalCrmId: existing.externalCrmId };
    await expect(db.job.create({ data: { ...data, jobNumber: `DUPLICATE-ID-${tag}` } })).rejects.toMatchObject({ code: "P2002" });
    await expect(db.job.create({ data: { ...data, externalCrmId: "87408" } })).rejects.toMatchObject({ code: "P2002" });
    expect(await db.job.findUniqueOrThrow({ where: { id: existing.id } })).toEqual(existing);
    expect(await db.bill.count({ where: { companyId: { in: companyIds } } })).toBe(0);
  });
});
