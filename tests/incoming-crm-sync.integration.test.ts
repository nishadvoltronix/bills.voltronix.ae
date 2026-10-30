import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { IntegrationError } from "@/lib/integrations/config";
import { VERIFIED_CRM_JOB_MAPPING } from "@/lib/integrations/crm";
import { incomingCrmSourceContext, syncIncomingCrm } from "@/lib/services/incoming-crm-sync";
import type { IncomingSource, IncomingSyncInput } from "@/lib/services/incoming-sync-types";
import { assertMySqlTestDatabase, bindTestDestination, createTestCompany } from "./company-fixtures";

const tag = randomUUID().slice(0, 8), organizationId = "998881122", booksA = "998881123", booksB = "998881124";
const source: IncomingSource = { target: "CRM", companyId: null, organizationId, dataCenter: "US", environment: "production", organizationName: "Fictional incoming CRM" };
let actor: Actor, companyA: string, companyB: string, canonicalId: string;
let saved: Prisma.InputJsonValue | null = null;
let bill: Awaited<ReturnType<typeof db.bill.create>>;
const record = (id: string, books = booksA, jobNumber = `INCOMING-${id}`) => ({ id, JobDealNumber: jobNumber,
  Deal_Name: `Fictional incoming ${id}`, Account_Name: { id: "880011", name: "Fictional customer" }, Amount: "123.45", Currency: "AED",
  Books_Organization_ID: books, Stage: "Closed Lost", Created_Time: "2019-01-01T00:00:00Z", Modified_Time: "2020-01-01T00:00:00Z" });
const page = (records: object[], ordinal = 1, more = false, next?: string) => ({ data: records,
  info: { page: ordinal, count: records.length, more_records: more, ...(next ? { next_page_token: next } : {}) } });
const snapshot = (externalCrmId: string) => db.crmJobSnapshot.findFirstOrThrow({ where: { crmOrganizationId: organizationId, externalCrmId } });
type Reply = (path: string, query?: Record<string, string>, headers?: Record<string, string>) => Promise<unknown>;
function input(reply: Reply, overrides: Partial<IncomingSyncInput> = {}): IncomingSyncInput {
  return { actor, source, mode: "incremental", watermark: "2019-01-01T00:00:00Z", continuation: null, maxRequests: 40,
    get: vi.fn(async (path, query, headers) => path === "/crm/v8/org" ? { org: [{ zgid: organizationId, type: "production" }] } : reply(path, query, headers)),
    assertLease: vi.fn(async () => undefined), checkpoint: vi.fn(async (value) => { saved = value; }), stopped: () => false, ...overrides };
}
const onePage = (records: object[]): Reply => async (path) => path.endsWith("/deleted") ? null : page(records);

beforeAll(async () => {
  assertMySqlTestDatabase();
  for (const [key, value] of Object.entries({ APP_URL: "http://127.0.0.1:3000", ZOHO_CRM_DC: "US", ZOHO_CRM_ENVIRONMENT: "production",
    ZOHO_CRM_ORGANIZATION_ID: organizationId, ZOHO_CRM_CLIENT_ID: "fictional-incoming-client", ZOHO_CRM_CLIENT_SECRET: "fictional-incoming-secret",
    ZOHO_CRM_MAPPING_JSON: JSON.stringify(VERIFIED_CRM_JOB_MAPPING), ZOHO_BOOKS_DC: "US", ZOHO_BOOKS_ENVIRONMENT: "production",
    ZOHO_BOOKS_CLIENT_ID: "fictional-books-client", ZOHO_BOOKS_CLIENT_SECRET: "fictional-books-secret",
    ZOHO_BOOKS_ORGANIZATIONS_JSON: JSON.stringify([{ organizationId: booksA, name: "Fictional A" }, { organizationId: booksB, name: "Fictional B" }]),
    INTEGRATION_NETWORK_ENABLED: "true", ZOHO_CRM_NETWORK_ENABLED: "true", ZOHO_BOOKS_WRITE_ENABLED: "true", ZOHO_BOOKS_LIVE_ENABLED: "true",
    ALLOW_PRODUCTION_ACCOUNTING_WRITES: "true", INTEGRATION_TEST_MODE: "false" })) vi.stubEnv(key, value);
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("No real provider requests in incoming CRM tests"); }));
  actor = await db.user.create({ data: { name: "Fictional incoming admin", email: `crm-incoming-${tag}@example.invalid`, role: "ADMIN", passwordHash: "unusable" } });
  companyA = (await createTestCompany(`CRM incoming A ${tag}`, [actor])).id;
  companyB = (await createTestCompany(`CRM incoming B ${tag}`, [actor])).id;
  for (const [companyId, books] of [[companyA, booksA], [companyB, booksB]]) {
    await bindTestDestination(companyId, { target: "ZOHO", organizationId: books, environment: "production" });
    await db.companyCrmSource.create({ data: { companyId, organizationId, dataCenter: "US", environment: "production" } });
  }
});
afterAll(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await db.$disconnect(); });

describe("incoming CRM synchronization on disposable MySQL", () => {
  it("uses exact source authorization while outbound writes remain enabled, and fences every mutation", async () => {
    expect((await incomingCrmSourceContext(actor, source)).assignments).toHaveLength(2);
    await expect(incomingCrmSourceContext({ ...actor, role: "MANAGEMENT" }, source)).rejects.toMatchObject({ status: 403 });
    await expect(incomingCrmSourceContext(actor, { ...source, companyId: companyA })).rejects.toMatchObject({ code: "CRM_INCOMING_SOURCE_INVALID" });
    const denied = input(onePage([]), { assertLease: async () => { throw new Error("fictional expired lease"); } });
    await expect(syncIncomingCrm(denied)).rejects.toThrow("fictional expired lease");
    expect(await db.crmImportRun.count({ where: { crmOrganizationId: organizationId } })).toBe(0);
    const wrong = input(onePage([]), { get: async () => ({ org: [{ zgid: "999", type: "production" }] }) });
    await expect(syncIncomingCrm(wrong)).rejects.toMatchObject({ code: "CRM_ORGANIZATION_MISMATCH" });
  });

  it("resumes committed pages after a lost checkpoint and creates jobs only after complete uniqueness evidence", async () => {
    let checkpoints = 0;
    const first = input(async (_path, query) => {
      expect(query).toMatchObject({ page: "1", converted: "both", sort_by: "id", sort_order: "asc" });
      return page([record("6201"), { ...record("6203"), JobDealNumber: null }], 1, true);
    }, { mode: "reconcile", watermark: null, maxRequests: 2, checkpoint: async (value) => {
      if (++checkpoints === 2) throw new Error("fictional checkpoint outage"); saved = value;
    } });
    await expect(syncIncomingCrm(first)).rejects.toThrow("fictional checkpoint outage");
    expect(await db.job.count({ where: { companyId: { in: [companyA, companyB] } } })).toBe(0);
    const second = input(async (path, query) => {
      if (path.endsWith("/deleted")) return null;
      expect(query?.page).toBe("2");
      return page([record("6202", "999"), record("6204", booksA, "DUPLICATE-INCOMING"), record("6205", booksA, "DUPLICATE-INCOMING")], 2);
    }, { continuation: saved });
    expect(await syncIncomingCrm(second)).toMatchObject({ complete: true, reconciled: true, processed: 3 });
    expect(second.assertLease).toHaveBeenCalled();
    const ready = await snapshot("6201"); canonicalId = ready.canonicalJobId!;
    expect(ready).toMatchObject({ linkStatus: "READY", stage: "Closed Lost", approvedVariations: null });
    expect(await snapshot("6202")).toMatchObject({ companyId: null, linkStatus: "UNASSIGNED_COMPANY" });
    expect(await snapshot("6203")).toMatchObject({ normalizedJobNumber: null, canonicalJobId: null });
    expect(await snapshot("6204")).toMatchObject({ linkStatus: "DUPLICATE_JOB_NUMBER", canonicalJobId: null });
    expect(await db.crmImportRun.findFirstOrThrow({ where: { crmOrganizationId: organizationId } })).toMatchObject({ runKind: "FULL", status: "COMPLETE", snapshotCount: 5, canonicalCount: 1 });
    const vendor = await db.vendor.create({ data: { companyId: companyA, name: "Fictional incoming vendor" } });
    bill = await db.bill.create({ data: { companyId: companyA, jobId: canonicalId, vendorId: vendor.id, createdById: actor.id,
      invoiceNumber: `INCOMING-BILL-${tag}`, normalizedInvoiceNumber: `INCOMING-BILL-${tag}`, invoiceDate: new Date("2020-01-01"),
      paymentTerms: "CUSTOM", category: "MATERIALS", currency: "AED", subtotal: "100.00", vatRate: "5.00", vatAmount: "5.00", total: "105.00" } });
  });

  it("updates source-owned fields while preserving native financial rows and unconfigured variations", async () => {
    await db.job.update({ where: { id: canonicalId }, data: { approvedVariations: "7.00" } });
    const update = { ...record("6201"), JobDealNumber: "RENAMED-6201", Deal_Name: "Fictional renamed job", Amount: "222.22",
      Account_Name: { id: "880012", name: "Fictional new customer" }, Stage: "Closed Won", Modified_Time: "2021-01-01T00:00:00Z" };
    const request = input(async (path, query, headers) => {
      expect(headers).toEqual({ "If-Modified-Since": "2018-12-31T23:55:00+00:00" });
      return path.endsWith("/deleted") ? null : page([update]);
    });
    expect(await syncIncomingCrm(request)).toMatchObject({ complete: true, reconciled: false });
    expect(await db.job.findUniqueOrThrow({ where: { id: canonicalId } })).toMatchObject({ companyId: companyA, externalCrmId: "6201",
      jobNumber: "RENAMED-6201", name: "Fictional renamed job", customer: "Fictional new customer" });
    const job = await db.job.findUniqueOrThrow({ where: { id: canonicalId } });
    expect(job.contractValue?.toFixed(2)).toBe("222.22"); expect(job.approvedVariations.toFixed(2)).toBe("7.00");
    expect(await db.bill.findUniqueOrThrow({ where: { id: bill.id } })).toEqual(bill);
    expect(await db.auditLog.count({ where: { entityId: canonicalId, action: "CRM_JOB_INCOMING_UPDATED" } })).toBe(1);
    await syncIncomingCrm(input(onePage([update])));
    expect(await db.auditLog.count({ where: { entityId: canonicalId, action: "CRM_JOB_INCOMING_UPDATED" } })).toBe(1);
    expect((await snapshot("6204")).isStale).toBe(false);
    const unchanged = await syncIncomingCrm(input(async () => page([update], 1, true), { maxRequests: 2 }));
    expect(unchanged.complete).toBe(false);
    expect(await snapshot("6201")).toMatchObject({ linkStatus: "READY", canonicalJobId: canonicalId });
    await syncIncomingCrm(input(async (path) => path.endsWith("/deleted") ? null : page([], 2), { continuation: unchanged.continuation }));
  });

  it("never regresses a newer source version, reinterprets billed currency or moves a native job to another company", async () => {
    await syncIncomingCrm(input(onePage([record("6201")])));
    expect((await snapshot("6201")).amount).toBe("222.22");
    const current = await db.job.findUniqueOrThrow({ where: { id: canonicalId } });
    await syncIncomingCrm(input(onePage([{ ...record("6201"), Currency: "USD", Modified_Time: "2022-01-01T00:00:00Z" }])));
    expect(await snapshot("6201")).toMatchObject({ linkStatus: "SOURCE_CHANGED", canonicalJobId: canonicalId, currencyCode: "USD" });
    expect(await db.job.findUniqueOrThrow({ where: { id: canonicalId } })).toEqual(current);
    await syncIncomingCrm(input(onePage([{ ...record("6201", booksB), Modified_Time: "2023-01-01T00:00:00Z" }])));
    expect(await snapshot("6201")).toMatchObject({ companyId: companyB, canonicalJobId: null, linkStatus: "LOCAL_CONFLICT" });
    expect(await db.job.count({ where: { externalCrmId: "6201" } })).toBe(1);
    expect(await db.job.findUniqueOrThrow({ where: { id: canonicalId } })).toEqual(current);
    expect(await db.bill.findUniqueOrThrow({ where: { id: bill.id } })).toEqual(bill);
    await syncIncomingCrm(input(onePage([record("6210")])));
    const adjustment = await snapshot("6210");
    await db.job.update({ where: { id: adjustment.canonicalJobId! }, data: { approvedVariations: "-10.00" } });
    await syncIncomingCrm(input(onePage([{ ...record("6210"), Amount: "0", Modified_Time: "2021-01-01T00:00:00Z" }])));
    expect(await snapshot("6210")).toMatchObject({ linkStatus: "SOURCE_CHANGED" });
    expect((await db.job.findUniqueOrThrow({ where: { id: adjustment.canonicalJobId! } })).contractValue?.toFixed(2)).toBe("123.45");
  });

  it("rejects an incomplete source response and fresh membership revocation without partial writes", async () => {
    const before = await snapshot("6201"), malformed = { ...record("6201") } as Record<string, unknown>;
    delete malformed.Account_Name;
    await expect(syncIncomingCrm(input(onePage([malformed])))).rejects.toMatchObject({ code: "CRM_INCOMING_RECORD_INCOMPLETE" });
    expect(await snapshot("6201")).toEqual(before);
    const recover = input(async (path) => path.endsWith("/deleted") ? null : page([]));
    await syncIncomingCrm(recover);
    const revoke = input(async () => {
      await db.userCompanyMembership.update({ where: { userId_companyId: { userId: actor.id, companyId: companyB } }, data: { active: false } });
      return page([record("6299")]);
    });
    await expect(syncIncomingCrm(revoke)).rejects.toMatchObject({ status: 403 });
    expect(await db.crmJobSnapshot.count({ where: { crmOrganizationId: organizationId, externalCrmId: "6299" } })).toBe(0);
    await db.userCompanyMembership.update({ where: { userId_companyId: { userId: actor.id, companyId: companyB } }, data: { active: true } });
    await syncIncomingCrm(input(onePage([])));
  });

  it("does not overwrite an unrelated local job based only on a matching external ID", async () => {
    const local = await db.job.create({ data: { companyId: companyA, externalCrmId: "6211", jobNumber: "LOCAL-6211",
      name: "Fictional local job", customer: "Fictional local customer", currency: "AED", contractValue: "77.00" } });
    await syncIncomingCrm(input(onePage([record("6211")])));
    expect(await snapshot("6211")).toMatchObject({ linkStatus: "LOCAL_CONFLICT", canonicalJobId: null });
    expect(await db.job.findUniqueOrThrow({ where: { id: local.id } })).toEqual(local);
  });

  it("requires exact-record absence to stale a missing full-list record and preserves live omitted records", async () => {
    const request = input(async (path) => {
      if (path.endsWith("/deleted")) return null;
      if (path.endsWith("/Deals")) return page([]);
      const id = path.split("/").at(-1)!;
      if (id === "6202") throw new IntegrationError("INCOMING_REMOTE_NOT_FOUND", "Fictional absent source", "BLOCKED");
      const row = await snapshot(id);
      return { data: [row.sourceRecordJson] };
    }, { mode: "reconcile", watermark: null, maxRequests: 4 });
    const first = await syncIncomingCrm(request);
    expect(first.complete).toBe(false);
    const resumed = await syncIncomingCrm({ ...request, continuation: first.continuation, maxRequests: 40 });
    expect(resumed).toMatchObject({ complete: true, reconciled: true });
    expect((await snapshot("6202")).isStale).toBe(true);
    expect((await snapshot("6201")).isStale).toBe(false);
    expect(await db.bill.findUniqueOrThrow({ where: { id: bill.id } })).toEqual(bill);
  });

  it("applies all-stage deletion tombstones idempotently and does not hide a later restoration", async () => {
    const duplicate = await snapshot("6204");
    await db.crmJobSnapshot.update({ where: { id: duplicate.id }, data: { lastSeenAt: new Date("2020-01-01") } });
    const tombstone = { id: "6204", type: "recycle", deleted_time: "2021-01-01T00:00:00Z" };
    const request = input(async (path) => path.endsWith("/deleted") ? page([tombstone]) : null);
    await syncIncomingCrm(request);
    expect((await snapshot("6204")).isStale).toBe(true);
    expect(await snapshot("6205")).toMatchObject({ linkStatus: "READY" });
    await syncIncomingCrm(request);
    expect(await db.auditLog.count({ where: { entityId: duplicate.id, action: "CRM_SOURCE_UNAVAILABLE" } })).toBe(1);
    await syncIncomingCrm(input(async (path) => path.endsWith("/deleted") ? page([tombstone]) : page([{ ...record("6204", booksA, "RESTORED-6204"), Modified_Time: "2022-01-01T00:00:00Z" }])));
    expect(await snapshot("6204")).toMatchObject({ isStale: false, linkStatus: "READY" });
    expect(fetch).not.toHaveBeenCalled();
    expect(await db.payment.count({ where: { bill: { companyId: { in: [companyA, companyB] } } } })).toBe(0);
    expect(await db.integrationJob.count({ where: { bill: { companyId: { in: [companyA, companyB] } } } })).toBe(0);
  });

  it("restarts an expired token with a new durable run instead of looping on the broken cursor", async () => {
    const first = input(async (_path, query) => page([{ ...record(`63${query?.page}`), JobDealNumber: null }], Number(query?.page), true, "fictional-expired-token"),
      { mode: "reconcile", watermark: null, maxRequests: 11 });
    const partial = await syncIncomingCrm(first);
    expect(partial.complete).toBe(false);
    const previous = await db.crmImportRun.findFirstOrThrow({ where: { crmOrganizationId: organizationId, status: "RUNNING" } });
    expect(previous.lastPage).toBe(10);
    const expire = input(async (_path, query) => {
      expect(query?.page_token).toBe("fictional-expired-token");
      throw new IntegrationError("INCOMING_CURSOR_EXPIRED", "Fictional expired cursor", "BLOCKED");
    }, { continuation: partial.continuation, maxRequests: 2 });
    const restarted = await syncIncomingCrm(expire);
    expect(restarted.complete).toBe(false);
    expect(await db.crmImportRun.findUniqueOrThrow({ where: { id: previous.id } })).toMatchObject({ status: "FAILED", lastErrorCode: "INCOMING_CURSOR_EXPIRED" });
    const replacement = await db.crmImportRun.findFirstOrThrow({ where: { crmOrganizationId: organizationId, status: "RUNNING" } });
    expect(replacement.lastPage).toBe(0); expect(replacement.id).not.toBe(previous.id);
    const lostCheckpoint = input(async (path) => path.endsWith("/deleted") ? null : path.endsWith("/Deals") ? page([]) : null,
      { continuation: partial.continuation });
    expect(await syncIncomingCrm(lostCheckpoint)).toMatchObject({ complete: true, reconciled: true });
  });
});
