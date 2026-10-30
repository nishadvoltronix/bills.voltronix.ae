import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import * as configuration from "@/lib/integrations/config";
import { connectionFingerprint } from "@/lib/integrations/connection-fingerprint";
import { BooksAdapter, buildBooksPayload, snapshotSchema } from "@/lib/integrations/books";
import { ZohoTransport, type Fetch } from "@/lib/integrations/transport";
import { assertLiveJobWrite } from "@/lib/integrations/live-sync";
import { assertLocalLiveTestWriteCapability, createLocalLiveTestWriteCapability, issueLocalLiveTestAuthorization,
  prepareLocalLiveTestSupplier } from "@/lib/integrations/local-live-test";
import { processIntegrationJobs, queueBill, scheduleIntegrationJob, type AdapterFactory } from "@/lib/integrations/queue";
import { actOnBill, createBill } from "@/lib/services/bills";
import { assertMySqlTestDatabase } from "./company-fixtures";

const tag = randomUUID().slice(0, 8), organizationId = `985${Date.now()}`, crmOrganizationId = `986${Date.now()}`;
const companyId = `connection-check-books-${organizationId}`, companyName = `FICTIONAL local test ${tag}`;
const externalVendorId = "98004", externalCrmId = "98006";
const config: configuration.ZohoConfig = { target: "ZOHO", dataCenter: "US", environment: "production", organizationId,
  apiOrigin: "https://www.zohoapis.com", accountsOrigin: "https://accounts.zoho.com", clientId: "fictional-local-client",
  clientSecret: "fictional-local-secret", networkEnabled: true, writeEnabled: false, liveRuntime: false,
  booksMapping: { verified: true, baseCurrency: "AED", currencies: { AED: { id: "98001" } },
    taxes: { "0.00": { id: "98002", percentage: "0" } }, categories: { OTHER: { accountId: "98003" } } } };
const crmConfig: configuration.ZohoConfig = { ...config, target: "CRM", organizationId: crmOrganizationId, booksMapping: undefined };
let admin: Actor, jobId: string, vendorId: string, snapshotId: string;
let remote: Map<string, Record<string, unknown>>, posts: string[];
const json = (value: unknown) => Response.json(value, { headers: { "x-rate-limit-remaining": "100" } });
const fakeGet: Fetch = async (input, init) => {
  if ((init?.method ?? "GET") !== "GET") throw new Error("Metadata fixture forbids provider writes.");
  const url = new URL(input), path = url.pathname;
  if (path === `/books/v3/organizations/${organizationId}`) return json({ code: 0, organization: {
    organization_id: organizationId, name: companyName, is_org_active: true, currency_code: "AED", currency_id: "98001", price_precision: 2 } });
  if (path === "/books/v3/settings/currencies/98001") return json({ code: 0, currency: {
    currency_id: "98001", currency_code: "AED", is_base_currency: true, price_precision: 2 } });
  if (path === "/books/v3/chartofaccounts/98003") return json({ code: 0, chart_of_account: {
    account_id: "98003", is_active: true, account_type: "expense" } });
  if (path === "/books/v3/settings/taxes/98002") return json({ code: 0, tax: {
    tax_id: "98002", tax_type: "tax", tax_percentage: 0, status: "active" } });
  if (/^\/books\/v3\/contacts\/9800[45]$/.test(path)) return json({ code: 0, contact: {
    contact_id: path.split("/").at(-1), contact_name: path.endsWith("5") ? "FICTIONAL selected second supplier" : "FICTIONAL selected supplier",
    contact_type: "vendor", status: "active", currency_id: "98001", currency_code: "AED" } });
  if (path === "/crm/v8/org") return json({ org: [{ zgid: crmOrganizationId, type: "production" }] });
  if (path === `/crm/v8/Deals/${externalCrmId}`) return json({ data: [{ id: externalCrmId, JobDealNumber: "JOB-5358",
    Books_Organization_ID: organizationId, Currency: "AED" }] });
  if (path === "/books/v3/bills") {
    const found = remote.get(url.searchParams.get("reference_number") ?? "");
    return json({ code: 0, bills: found ? [found] : [], page_context: { has_more_page: false } });
  }
  const bill = [...remote.values()].find(value => path === `/books/v3/bills/${value.bill_id}`);
  if (bill) return json({ code: 0, bill });
  throw new Error("Unexpected fictional metadata path.");
};
const reads = () => ({ books: new ZohoTransport(config, async () => "fictional", fakeGet),
  crm: new ZohoTransport(crmConfig, async () => "fictional", fakeGet) });
const selected = () => ({ companyId, organizationId, jobId, externalVendorId, reference: `FICTIONAL-ONE-BILL-${tag}` });
async function draft() {
  return createBill(admin, { companyId, vendorId, jobId, invoiceNumber: `TEST-FICTIONAL-${randomUUID()}`,
    invoiceDate: "2026-10-30", category: "OTHER", currency: "AED", discount: "0", vatRate: "0", submit: false,
    lines: [{ description: "FICTIONAL explicit local test", quantity: "1", unitPrice: "1" }] });
}
async function authorize(bill: Awaited<ReturnType<typeof draft>>) {
  return issueLocalLiveTestAuthorization(admin, { ...selected(), billId: bill.id, invoiceNumber: bill.invoiceNumber,
    currency: "AED", total: "1.00" }, reads());
}
async function queued() {
  const bill = await draft(), permit = await authorize(bill);
  await actOnBill(admin, bill.id, { action: "submit", version: bill.version });
  const operation = await db.integrationJob.findUniqueOrThrow({ where: { idempotencyKey: `ZOHO:${bill.id}:CREATE_BILL` } });
  return { bill, permit, operation };
}
function adapterFactory(options: { uncertain?: boolean; revokeOnOrg?: boolean } = {}): AdapterFactory {
  return (_target, _org, job) => new BooksAdapter(new ZohoTransport(config, async () => "fictional", async (input, init) => {
    const path = new URL(input).pathname;
    if (init?.method === "POST") {
      posts.push(job.id);
      const payload = JSON.parse(String(init.body));
      const bill = { bill_id: `989${Date.now()}`, vendor_id: externalVendorId, reference_number: payload.reference_number,
        bill_number: payload.bill_number, currency_code: "AED", total: "1.00", tax_total: "0.00" };
      remote.set(payload.reference_number, bill);
      if (options.uncertain) throw new Error("Fictional connection closed after the remote create.");
      return json({ code: 0, bill: { bill_id: bill.bill_id } });
    }
    if (options.revokeOnOrg && path.includes("/organizations/"))
      await db.userCompanyMembership.update({ where: { userId_companyId: { userId: admin.id, companyId } }, data: { active: false } });
    return fakeGet(input, init);
  }, request => assertLiveJobWrite(job.id, job.leaseToken ?? "", request),
  job.needsReconciliation ? undefined : createLocalLiveTestWriteCapability(job.id, job.leaseToken ?? "")));
}

beforeAll(async () => {
  assertMySqlTestDatabase();
  admin = await db.user.create({ data: { name: "FICTIONAL local operator", email: `local-one-${tag}@example.invalid`, role: "ADMIN", passwordHash: "unusable" } });
  await db.company.create({ data: { id: companyId, name: `[CONNECTION CHECK] ${companyName}`, isDemo: true, liveAccountingEnabled: false,
    memberships: { create: { userId: admin.id } }, integrationDestinations: { create: { target: "ZOHO", organizationId, dataCenter: "US", environment: "production" } },
    crmSource: { create: { organizationId: crmOrganizationId, dataCenter: "US", environment: "production" } } } });
  jobId = (await db.job.create({ data: { companyId, jobNumber: "JOB-5358", externalCrmId, name: "FICTIONAL source job",
    customer: "FICTIONAL customer", currency: "AED", isDemo: true } })).id;
  vendorId = (await db.vendor.create({ data: { companyId, name: "FICTIONAL selected supplier", currency: "AED", isDemo: false,
    booksMappings: { create: { organizationId, dataCenter: "US", environment: "production", externalVendorId } } } })).id;
  const run = await db.crmImportRun.create({ data: { crmOrganizationId, dataCenter: "US", environment: "production", sourceModule: "Deals",
    initiatedById: admin.id, scopeHash: "a".repeat(64), mappingJson: {}, fieldsJson: [], status: "COMPLETE", listingComplete: true,
    completedAt: new Date(), snapshotCount: 1, canonicalCount: 1, mappedCount: 1 } });
  snapshotId = (await db.crmJobSnapshot.create({ data: { crmOrganizationId, dataCenter: "US", environment: "production", sourceModule: "Deals",
    externalCrmId, companyId, booksOrganizationId: organizationId, jobNumber: "JOB-5358", normalizedJobNumber: "JOB-5358", currencyCode: "AED",
    canonicalJobId: jobId, linkStatus: "READY", sourceRecordJson: { id: externalCrmId }, importRunId: run.id, lastSeenAt: new Date() } })).id;
  for (const source of [config, crmConfig]) await db.integrationCredential.create({ data: { target: source.target,
    organizationId: source.organizationId, dataCenter: "US", connectionFingerprint: connectionFingerprint(source), refreshTokenEncrypted: "fictional-unused-encrypted-value" } });
});
beforeEach(() => {
  for (const [key, value] of Object.entries({ APP_URL: "http://127.0.0.1:3000", MANUAL_ENTRY_ONLY: "false", ZOHO_BOOKS_WRITE_ENABLED: "false",
    ZOHO_BOOKS_LIVE_ENABLED: "false", ALLOW_PRODUCTION_ACCOUNTING_WRITES: "false", INTEGRATION_TEST_MODE: "false", ALLOW_LOCAL_BOOKS_TEST_SETUP: "true",
    ZOHO_BOOKS_ORGANIZATIONS_JSON: JSON.stringify([{ organizationId, name: companyName, mapping: config.booksMapping }]) })) vi.stubEnv(key, value);
  vi.spyOn(configuration, "getConfig").mockImplementation((target, _env, org) => {
    const result = target === "ZOHO" ? config : crmConfig;
    if (org && org !== result.organizationId) throw new Error("Unexpected fictional organization.");
    return result;
  });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Real provider networking is forbidden in this disposable fixture."); }));
  remote = new Map(); posts = [];
});
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await db.userCompanyMembership.update({ where: { userId_companyId: { userId: admin.id, companyId } }, data: { active: true } });
  await db.crmJobSnapshot.update({ where: { id: snapshotId }, data: { booksOrganizationId: organizationId } });
});
afterAll(() => db.$disconnect());

describe("one local manual-form bill with real MySQL and fictional provider only", () => {
  it("imports only the explicitly selected existing supplier and reuses the exact mapping", async () => {
    const result = await prepareLocalLiveTestSupplier(admin, { ...selected(), externalVendorId: "98005" }, reads().books);
    expect(result).toMatchObject({ created: true, providerReads: 2, providerFinancialWrites: 0 });
    expect(await prepareLocalLiveTestSupplier(admin, { ...selected(), externalVendorId: "98005" }, reads().books)).toMatchObject({ vendorId: result.vendorId, created: false });
    expect(await db.vendor.findUnique({ where: { id: result.vendorId } })).toMatchObject({ companyId, isDemo: false });
  });
  it("requires the exact reviewed amount and supplier before authorizing", async () => {
    const bill = await draft();
    await expect(issueLocalLiveTestAuthorization(admin, { ...selected(), billId: bill.id, invoiceNumber: bill.invoiceNumber,
      currency: "AED", total: "2.00" }, reads())).rejects.toMatchObject({ code: "LOCAL_TEST_PERMISSION_REQUIRED" });
    await expect(issueLocalLiveTestAuthorization(admin, { ...selected(), externalVendorId: "99999", billId: bill.id,
      invoiceNumber: bill.invoiceNumber, currency: "AED", total: "1.00" }, reads())).rejects.toMatchObject({ code: "LOCAL_TEST_PERMISSION_REQUIRED" });
    expect(await db.liveSyncAuthorization.count({ where: { billId: bill.id } })).toBe(0);
  });
  it("rejects fresh CRM proof assigning the reviewed job to another Books organization", async () => {
    const bill = await draft();
    const crm = new ZohoTransport(crmConfig, async () => "fictional", async (input, init) => {
      if (new URL(input).pathname === `/crm/v8/Deals/${externalCrmId}`)
        return json({ data: [{ id: externalCrmId, JobDealNumber: "JOB-5358", Books_Organization_ID: "999999", Currency: "AED" }] });
      return fakeGet(input, init);
    });
    await expect(issueLocalLiveTestAuthorization(admin, { ...selected(), billId: bill.id, invoiceNumber: bill.invoiceNumber,
      currency: "AED", total: "1.00" }, { books: reads().books, crm })).rejects.toMatchObject({ code: "LOCAL_TEST_PERMISSION_REQUIRED" });
    expect(await db.liveSyncAuthorization.count({ where: { billId: bill.id } })).toBe(0);
  });
  it("final Save and sync creates one exact operation while generic posting remains disabled", async () => {
    const { bill, permit, operation } = await queued();
    expect(operation).toMatchObject({ initiatedById: null, sourceVersion: bill.version + 1 });
    expect(permit.sourceVersion).toBe(bill.version + 1);
    expect((await queueBill(admin, bill.id, "ZOHO", organizationId)).id).toBe(operation.id);
    await processIntegrationJobs({ limit: 1, adapterFactory: adapterFactory() });
    expect(posts).not.toContain(operation.id);
    expect(await db.integrationJob.findUnique({ where: { id: operation.id } })).toMatchObject({ status: "QUEUED" });
    await processIntegrationJobs({ jobId: operation.id, adapterFactory: adapterFactory() });
    expect(posts).toEqual([operation.id]);
    expect(await db.syncRecord.findUnique({ where: { billId_target: { billId: bill.id, target: "ZOHO" } } })).toMatchObject({ status: "SYNCED", organizationId });
    expect(await db.payment.count({ where: { billId: bill.id } })).toBe(0);
    expect(await db.company.findUnique({ where: { id: companyId } })).toMatchObject({ isDemo: true, liveAccountingEnabled: false });
    expect(await db.job.findUnique({ where: { id: jobId } })).toMatchObject({ isDemo: true });
    expect(config.writeEnabled).toBe(false);
    await expect(authorize(bill)).rejects.toMatchObject({ code: "LOCAL_TEST_PERMISSION_REQUIRED" });
  });
  it("preserves the normal denial for another bill without an exact grant", async () => {
    const bill = await draft();
    await actOnBill(admin, bill.id, { action: "submit", version: bill.version });
    expect(await db.integrationJob.count({ where: { billId: bill.id } })).toBe(0);
    expect(await db.syncRecord.findUnique({ where: { billId_target: { billId: bill.id, target: "ZOHO" } } })).toMatchObject({ status: "FAILED" });
  });
  it("invalidates a changed saved draft before final save can queue it", async () => {
    const bill = await draft(); await authorize(bill);
    await db.bill.update({ where: { id: bill.id }, data: { invoiceNumber: `${bill.invoiceNumber}-CHANGED`, version: { increment: 1 } } });
    await actOnBill(admin, bill.id, { action: "submit", version: bill.version + 1 });
    expect(await db.integrationJob.count({ where: { billId: bill.id } })).toBe(0);
  });
  it("rejects tampered source proof even when the stored hash is unchanged", async () => {
    const bill = await draft(); const permit = await authorize(bill);
    const row = await db.liveSyncAuthorization.findUniqueOrThrow({ where: { id: permit.authorizationId } });
    await db.liveSyncAuthorization.update({ where: { id: row.id }, data: { localProof: { ...(row.localProof as Record<string, string>), reference: "TAMPERED" } } });
    await actOnBill(admin, bill.id, { action: "submit", version: bill.version });
    expect(await db.integrationJob.count({ where: { billId: bill.id } })).toBe(0);
  });
  it("blocks revoked membership and changed source company before any POST", async () => {
    const first = await queued();
    await db.userCompanyMembership.update({ where: { userId_companyId: { userId: admin.id, companyId } }, data: { active: false } });
    await processIntegrationJobs({ jobId: first.operation.id, adapterFactory: adapterFactory() });
    expect(posts).toEqual([]);
    await db.userCompanyMembership.update({ where: { userId_companyId: { userId: admin.id, companyId } }, data: { active: true } });
    const second = await queued();
    await db.crmJobSnapshot.update({ where: { id: snapshotId }, data: { booksOrganizationId: "999999" } });
    await processIntegrationJobs({ jobId: second.operation.id, adapterFactory: adapterFactory() });
    expect(posts).toEqual([]);
  });
  it("rechecks authority after provider organization work immediately before POST", async () => {
    const { operation } = await queued();
    await processIntegrationJobs({ jobId: operation.id, adapterFactory: adapterFactory({ revokeOnOrg: true }) });
    expect(posts).toEqual([]);
  });
  it("binds its opaque capability to the exact request and lease", async () => {
    const { operation } = await queued();
    const token = "fictional-exact-lease";
    await db.integrationJob.update({ where: { id: operation.id }, data: { status: "PROCESSING", leaseToken: token, leaseUntil: new Date(Date.now() + 60_000) } });
    const capability = createLocalLiveTestWriteCapability(operation.id, token);
    const payload = buildBooksPayload(snapshotSchema.parse(operation.snapshot), config);
    await expect(assertLocalLiveTestWriteCapability(capability, config, { path: "/books/v3/bills", body: payload })).resolves.toBeUndefined();
    await expect(assertLocalLiveTestWriteCapability(capability, { ...config, apiOrigin: "https://untrusted.example.invalid" },
      { path: "/books/v3/bills", body: payload })).rejects.toMatchObject({ code: "LOCAL_TEST_PERMISSION_REQUIRED" });
    await expect(assertLocalLiveTestWriteCapability(capability, config, { path: "/books/v3/bills", body: { ...payload, vendor_id: "99999" } })).rejects.toMatchObject({ code: "LOCAL_TEST_PERMISSION_REQUIRED" });
    await expect(assertLocalLiveTestWriteCapability(capability, config, { path: "/books/v3/vendorpayments", body: payload })).rejects.toMatchObject({ code: "LOCAL_TEST_PERMISSION_REQUIRED" });
    await db.integrationJob.update({ where: { id: operation.id }, data: { leaseToken: "another-lease" } });
    await expect(assertLocalLiveTestWriteCapability(capability, config)).rejects.toMatchObject({ code: "LOCAL_TEST_PERMISSION_REQUIRED" });
  });
  it("allows only GET reconciliation after an uncertain create and expired permission", async () => {
    const { bill, operation } = await queued();
    await processIntegrationJobs({ jobId: operation.id, adapterFactory: adapterFactory({ uncertain: true }) });
    expect(posts).toEqual([operation.id]);
    expect(await db.integrationJob.findUnique({ where: { id: operation.id } })).toMatchObject({ status: "UNKNOWN", needsReconciliation: true });
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(Date.now() + 11 * 60_000));
    await expect(scheduleIntegrationJob(admin, operation.id, { action: "retry" })).rejects.toMatchObject({ status: 409 });
    await scheduleIntegrationJob(admin, operation.id, { action: "reconcile" });
    await processIntegrationJobs({ jobId: operation.id, adapterFactory: adapterFactory() });
    expect(posts).toEqual([operation.id]);
    expect(await db.integrationJob.findUnique({ where: { id: operation.id } })).toMatchObject({ status: "SUCCEEDED" });
    expect(await db.payment.count({ where: { billId: bill.id } })).toBe(0);
  });
  it("expires a never-posted permission without allowing preflight reconciliation to create a bill", async () => {
    const { operation } = await queued();
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(Date.now() + 11 * 60_000));
    await processIntegrationJobs({ jobId: operation.id, adapterFactory: adapterFactory() });
    expect(posts).toEqual([]);
    expect(await db.integrationJob.findUnique({ where: { id: operation.id } })).toMatchObject({ status: "BLOCKED" });
  });
});
