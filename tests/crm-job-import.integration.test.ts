import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { VERIFIED_CRM_JOB_MAPPING } from "@/lib/integrations/crm";
import { beginCrmJobImport, finishCrmJobImport, getCrmJobSnapshot, importCrmJobPage, listCrmJobSnapshots } from "@/lib/services/crm-job-import";
import { assertMySqlTestDatabase, bindTestDestination, createTestCompany } from "./company-fixtures";

const tag = randomUUID().slice(0, 8), organizationId = "998771122", booksA = "998771123", booksB = "998771124";
let actor: Actor, reader: Actor, entry: Actor, companyA: string, companyB: string, runId: string;
let original: Awaited<ReturnType<typeof db.job.create>>;
let initialCounts: { bills: number; payments: number; queue: number };
const record = (id: string, books = booksA, jobNumber = `FICTIONAL-${id}`) => ({ id, JobDealNumber: jobNumber,
  Deal_Name: `Fictional source job ${id}`, Account_Name: { id: "880001", name: "Fictional customer" }, Amount: "123.45", Currency: "AED",
  Books_Organization_ID: books, Stage: "Closed Lost", Modified_Time: "2026-10-29T10:00:00+04:00" });
const page = (records: object[], ordinal: number, more = false) => ({ data: records, info: { page: ordinal, count: records.length, more_records: more } });
const begin = () => beginCrmJobImport(actor, { organizationId, organizationResponse: { org: [{ zgid: organizationId, type: "production" }] } });
async function financialCounts() { return { bills: await db.bill.count(), payments: await db.payment.count(), queue: await db.integrationJob.count() }; }

beforeAll(async () => {
  assertMySqlTestDatabase();
  for (const [key, value] of Object.entries({ APP_URL: "http://127.0.0.1:3000", ZOHO_CRM_DC: "US", ZOHO_CRM_ENVIRONMENT: "production",
    ZOHO_CRM_ORGANIZATION_ID: organizationId, ZOHO_CRM_CLIENT_ID: "fictional-crm-client", ZOHO_CRM_CLIENT_SECRET: "fictional-crm-secret",
    ZOHO_CRM_MAPPING_JSON: JSON.stringify(VERIFIED_CRM_JOB_MAPPING), ZOHO_BOOKS_DC: "US", ZOHO_BOOKS_ENVIRONMENT: "production",
    ZOHO_BOOKS_CLIENT_ID: "fictional-books-client", ZOHO_BOOKS_CLIENT_SECRET: "fictional-books-secret",
    ZOHO_BOOKS_ORGANIZATIONS_JSON: JSON.stringify([{ organizationId: booksA, name: "Fictional A" }, { organizationId: booksB, name: "Fictional B" }]),
    INTEGRATION_NETWORK_ENABLED: "false", ZOHO_CRM_NETWORK_ENABLED: "false", ZOHO_BOOKS_WRITE_ENABLED: "false", ZOHO_BOOKS_LIVE_ENABLED: "false",
    ALLOW_PRODUCTION_ACCOUNTING_WRITES: "false", INTEGRATION_TEST_MODE: "false" })) vi.stubEnv(key, value);
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Provider calls forbidden in cached imports"); }));
  actor = await db.user.create({ data: { name: "Fictional bulk admin", email: `crm-bulk-${tag}@example.invalid`, role: "ADMIN", passwordHash: "unusable" } });
  reader = await db.user.create({ data: { name: "Fictional limited account", email: `crm-bulk-reader-${tag}@example.invalid`, role: "ACCOUNTS", passwordHash: "unusable" } });
  entry = await db.user.create({ data: { name: "Fictional entry user", email: `crm-bulk-entry-${tag}@example.invalid`, role: "DATA_ENTRY", passwordHash: "unusable" } });
  companyA = (await createTestCompany(`CRM bulk A ${tag}`, [actor, reader, entry])).id;
  companyB = (await createTestCompany(`CRM bulk B ${tag}`, [actor])).id;
  for (const [companyId, books] of [[companyA, booksA], [companyB, booksB]]) {
    await bindTestDestination(companyId, { target: "ZOHO", organizationId: books, environment: "production" });
    await db.companyCrmSource.create({ data: { companyId, organizationId, dataCenter: "US", environment: "production" } });
  }
  original = await db.job.create({ data: { companyId: companyA, externalCrmId: "901", jobNumber: "FICTIONAL-901", name: "Fictional source job 901",
    customer: "Fictional customer", currency: "AED", contractValue: "123.45", approvedVariations: "3.00", isDemo: true } });
  initialCounts = await financialCounts();
});
afterAll(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await db.$disconnect(); });

describe("complete CRM source import on disposable MySQL", () => {
  it("requires exact organization proof and access to every shared-source company", async () => {
    await expect(beginCrmJobImport(actor, { organizationId, organizationResponse: { org: [{ zgid: "999", type: "production" }] } }))
      .rejects.toMatchObject({ code: "CRM_ORGANIZATION_MISMATCH" });
    await expect(beginCrmJobImport({ ...reader, role: "ADMIN" }, { organizationId, organizationResponse: { org: [{ zgid: organizationId, type: "production" }] } }))
      .rejects.toMatchObject({ status: 403 });
    const run = await begin(); runId = run.id;
    await expect(begin()).rejects.toMatchObject({ code: "CRM_IMPORT_ALREADY_RUNNING" });
  });
  it("retains every source record and resumes pages without creating jobs before uniqueness is proven", async () => {
    const first = page([record("901"), record("902"), { ...record("903", booksB), Stage: "Quotation Sent" }, record("904", "999"), { ...record("905"), Account_Name: null }], 1, true);
    await importCrmJobPage(actor, runId, { ordinal: 1, response: first });
    await importCrmJobPage(actor, runId, { ordinal: 1, response: first });
    expect(await db.job.count({ where: { companyId: { in: [companyA, companyB] } } })).toBe(1);
    expect(await finishCrmJobImport(actor, runId)).toMatchObject({ status: "PARTIAL", snapshotCount: 5, listingComplete: false });
    await expect(importCrmJobPage(actor, runId, { ordinal: 2, response: page([record("901")], 2) })).rejects.toMatchObject({ code: "CRM_IMPORT_DUPLICATE_RECORD" });
    const second = page([record("906", booksA, "DUPLICATE"), record("907", booksA, "DUPLICATE"),
      { ...record("908", booksB), Amount: null }, { ...record("909"), Currency: "KWD", Amount: "1.234" }, { ...record("910"), JobDealNumber: null }], 2);
    await importCrmJobPage(actor, runId, { ordinal: 2, response: second });
    const completed = await finishCrmJobImport(actor, runId);
    expect(completed).toMatchObject({ status: "COMPLETE", snapshotCount: 10, mappedCount: 9, canonicalCount: 4, unassignedCount: 1, reviewCount: 5 });
    expect(await db.job.count({ where: { companyId: { in: [companyA, companyB] } } })).toBe(4);
    expect(await db.job.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
    expect((await db.crmJobSnapshot.findFirstOrThrow({ where: { importRunId: runId, externalCrmId: "909" } })).amount).toBe("1.234");
    expect((await db.crmJobSnapshot.findFirstOrThrow({ where: { importRunId: runId, externalCrmId: "908" } })).amount).toBeNull();
    expect(await db.auditLog.count({ where: { action: "CRM_JOB_BULK_IMPORTED", companyId: { in: [companyA, companyB] } } })).toBe(3);
    expect(await financialCounts()).toEqual(initialCounts);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps raw and unassigned source records private and applies current company and financial-role access", async () => {
    expect((await listCrmJobSnapshots(actor)).total).toBe(9);
    expect((await listCrmJobSnapshots(reader)).total).toBe(6);
    const companyBRow = await db.crmJobSnapshot.findFirstOrThrow({ where: { importRunId: runId, companyId: companyB } });
    await expect(getCrmJobSnapshot(reader, companyBRow.id)).rejects.toMatchObject({ status: 404 });
    const unassigned = await db.crmJobSnapshot.findFirstOrThrow({ where: { importRunId: runId, companyId: null } });
    expect(await getCrmJobSnapshot(actor, unassigned.id)).toMatchObject({ companyId: null, canonicalJobId: null, linkStatus: "UNASSIGNED_COMPANY" });
    await expect(getCrmJobSnapshot(reader, unassigned.id)).rejects.toMatchObject({ status: 404 });
    expect((await listCrmJobSnapshots(actor, { companyId: companyA })).jobs.some((job) => job.companyId === null)).toBe(false);
    vi.stubEnv("ZOHO_BOOKS_WRITE_ENABLED", "true");
    expect(await getCrmJobSnapshot(actor, unassigned.id)).toMatchObject({ companyId: null });
    vi.stubEnv("ZOHO_BOOKS_WRITE_ENABLED", "false");
    await db.userCompanyMembership.update({ where: { userId_companyId: { userId: actor.id, companyId: companyB } }, data: { active: false } });
    await expect(getCrmJobSnapshot(actor, unassigned.id)).rejects.toMatchObject({ status: 404 });
    await db.userCompanyMembership.update({ where: { userId_companyId: { userId: actor.id, companyId: companyB } }, data: { active: true } });
    await db.user.update({ where: { id: actor.id }, data: { role: "ACCOUNTS" } });
    await expect(getCrmJobSnapshot(actor, unassigned.id)).rejects.toMatchObject({ status: 403 });
    await db.user.update({ where: { id: actor.id }, data: { role: "ADMIN" } });
    const own = await db.crmJobSnapshot.findFirstOrThrow({ where: { importRunId: runId, externalCrmId: "901" } });
    expect(await getCrmJobSnapshot(entry, own.id)).toMatchObject({ amount: null, approvedVariations: null, canonicalJobId: original.id });
    expect(JSON.stringify(await getCrmJobSnapshot(reader, own.id))).not.toContain("sourceRecordJson");
    await db.userCompanyMembership.update({ where: { userId_companyId: { userId: reader.id, companyId: companyA } }, data: { active: false } });
    await expect(getCrmJobSnapshot(reader, own.id)).rejects.toMatchObject({ status: 404 });
  });
  it("preserves local values and collisions during refresh and marks absent snapshots stale without deleting jobs", async () => {
    const local = await db.job.create({ data: { companyId: companyA, jobNumber: "LOCAL-CONFLICT", name: "Fictional independent job", customer: "Fictional customer", currency: "AED" } });
    const run = await begin();
    await importCrmJobPage(actor, run.id, { ordinal: 1, response: page([{ ...record("901"), Amount: "999.00" }, record("912", booksA, "LOCAL-CONFLICT")], 1) });
    expect(await finishCrmJobImport(actor, run.id)).toMatchObject({ status: "COMPLETE", snapshotCount: 2, canonicalCount: 0, reviewCount: 2 });
    expect(await db.job.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
    expect(await db.job.findUniqueOrThrow({ where: { id: local.id } })).toEqual(local);
    expect(await db.crmJobSnapshot.findFirstOrThrow({ where: { importRunId: run.id, externalCrmId: "901" } })).toMatchObject({ linkStatus: "SOURCE_CHANGED", canonicalJobId: null, amount: "999.00" });
    expect(await db.crmJobSnapshot.findFirstOrThrow({ where: { importRunId: run.id, externalCrmId: "912" } })).toMatchObject({ linkStatus: "LOCAL_CONFLICT", canonicalJobId: null });
    expect(await db.crmJobSnapshot.count({ where: { crmOrganizationId: organizationId, isStale: true } })).toBe(9);
    expect(await financialCounts()).toEqual(initialCounts);
  });
  it("does not clone an existing CRM job into another company after a source reassignment", async () => {
    const run = await begin();
    const before = await db.job.count({ where: { companyId: { in: [companyA, companyB] } } });
    await importCrmJobPage(actor, run.id, { ordinal: 1, response: page([record("901", booksB)], 1) });
    await finishCrmJobImport(actor, run.id);
    expect(await db.crmJobSnapshot.findFirstOrThrow({ where: { importRunId: run.id } })).toMatchObject({ companyId: companyB, canonicalJobId: null, linkStatus: "LOCAL_CONFLICT" });
    expect(await db.job.count({ where: { companyId: { in: [companyA, companyB] } } })).toBe(before);
    expect(await db.job.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
    expect(await financialCounts()).toEqual(initialCounts);
  });
});
