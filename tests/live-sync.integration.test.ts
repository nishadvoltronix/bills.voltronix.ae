import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import * as configuration from "@/lib/integrations/config";
import { BooksAdapter, buildBooksPayload, snapshotSchema } from "@/lib/integrations/books";
import { ZohoTransport } from "@/lib/integrations/transport";
import { assertLiveJobWrite, assertLiveJobPermission, confirmLiveSnapshot, recordLiveConfirmation } from "@/lib/integrations/live-sync";
import { sourceInclude } from "@/lib/integrations/source-snapshot";
import { previewLiveBillSync, queueBill, processIntegrationJobs, type AdapterFactory } from "@/lib/integrations/queue";
import { createBill, actOnBill } from "@/lib/services/bills";
import { assertMySqlTestDatabase } from "./company-fixtures";

const tag = randomUUID().slice(0, 8), organizationId = `7700${Date.now()}`;
let companyId: string, vendorId: string, jobId: string;
let admin: Actor, accounts: Actor, staff: Actor;
const originalGetConfig = configuration.getConfig;
const fixtureEnvironment = {
  NODE_ENV: "production", APP_ENV: "production", APP_URL: "https://billing.example.invalid",
  // This string is validated purely; it is NEVER assigned to process.env or used by a database client.
  DATABASE_URL: "mysql://billing_app:fictional@database.example.invalid/billing_operational",
  INTEGRATION_NETWORK_ENABLED: "true", INTEGRATION_TEST_MODE: "false", ZOHO_BOOKS_LIVE_ENABLED: "true",
  ZOHO_BOOKS_WRITE_ENABLED: "true", ALLOW_PRODUCTION_ACCOUNTING_WRITES: "false", ZOHO_BOOKS_DC: "US",
  ZOHO_BOOKS_ENVIRONMENT: "production", ZOHO_BOOKS_ORGANIZATION_ID: organizationId,
  ZOHO_BOOKS_CLIENT_ID: "fictional-client", ZOHO_BOOKS_CLIENT_SECRET: "fictional-secret",
  ZOHO_BOOKS_MAPPING_JSON: JSON.stringify({ verified: true, baseCurrency: "AED", currencies: { AED: { id: "77001" } },
    taxes: { "5.00": { id: "77002", percentage: "5" } }, categories: { MATERIALS: { accountId: "77003" } } }),
} satisfies NodeJS.ProcessEnv;
const config = originalGetConfig("ZOHO", fixtureEnvironment);
const destination = () => ({ companyId, target: "ZOHO" as const, organizationId, dataCenter: "US", environment: "production" });

beforeAll(async () => {
  assertMySqlTestDatabase();
  [admin, accounts, staff] = await Promise.all((["ADMIN", "ACCOUNTS", "DATA_ENTRY"] as const).map(role => db.user.create({ data: {
    email: `fictional-live-${tag}-${role}@example.invalid`, name: `FICTIONAL live ${role}`, role, passwordHash: "not-a-login",
  } })));
  // Simulated operator metadata exists ONLY inside the harness-owned disposable schema.
  companyId = (await db.company.create({ data: { name: `FICTIONAL live guard fixture ${tag}`, isDemo: false, liveAccountingEnabled: true,
    memberships: { create: [admin, accounts, staff].map(actor => ({ userId: actor.id })) } } })).id;
  await db.companyIntegrationDestination.create({ data: { ...destination(), liveEnabled: true, verifiedAt: new Date(),
    verificationReference: "FICTIONAL-TEST-ONLY", verifiedConfigurationHash: configuration.booksConfigurationHash(config) } });
  vendorId = (await db.vendor.create({ data: { companyId, name: "FICTIONAL simulated supplier", currency: "AED", isDemo: false } })).id;
  jobId = (await db.job.create({ data: { companyId, jobNumber: `FIXTURE-LIVE-${tag}`, name: "FICTIONAL simulated job", customer: "FICTIONAL", currency: "AED", isDemo: false } })).id;
  await db.vendorBooksMapping.create({ data: { vendorId, organizationId, dataCenter: "US", environment: "production", externalVendorId: "77004" } });
});
beforeEach(() => {
  vi.stubEnv("ZOHO_BOOKS_ORGANIZATIONS_JSON", ""); vi.stubEnv("ZOHO_BOOKS_ORGANIZATION_ID", organizationId);
  vi.spyOn(configuration, "getConfig").mockImplementation((target, _environment, requested) => {
    if (target !== "ZOHO" || (requested && requested !== organizationId)) throw new configuration.IntegrationError("FICTIONAL_DESTINATION", "Unexpected fixture destination.");
    return config;
  });
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("No provider networking is permitted in this disposable fixture.")));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
afterAll(() => db.$disconnect());

async function approvedBill() {
  const invoiceNumber = `FICTIONAL-LIVE-${randomUUID()}`;
  return db.bill.create({ data: { companyId, vendorId, jobId, invoiceNumber, normalizedInvoiceNumber: invoiceNumber,
    invoiceDate: new Date("2026-10-28"), category: "MATERIALS", currency: "AED", subtotal: "100.00", vatRate: "5.00", vatAmount: "5.00", total: "105.00",
    status: "APPROVED", approvedAt: new Date(), approvedById: accounts.id, createdById: staff.id, version: 3,
    lines: { create: { description: "FICTIONAL line", quantity: "1.000", unitPrice: "100.00", lineTotal: "100.00" } } } });
}
const confirmation = (preview: Awaited<ReturnType<typeof previewLiveBillSync>>) => ({ challengeId: preview.challengeId, challengeToken: preview.challengeToken });
async function queuedBill() {
  const bill = await approvedBill();
  const preview = await previewLiveBillSync(admin, bill.id, organizationId);
  return { bill, preview, operation: await queueBill(admin, bill.id, "ZOHO", organizationId, confirmation(preview)) };
}
function fakeProvider(posts: string[]): AdapterFactory {
  return (_target, _organization, claimed) => {
    const snapshot = snapshotSchema.parse(claimed.snapshot);
    let created = false;
    const remoteId = `88${Date.now()}`;
    const fetcher = vi.fn(async (url: string | URL, options?: RequestInit) => {
      const pathname = new URL(url).pathname;
      if (options?.method === "POST") { posts.push(claimed.id); created = true; return Response.json({ code: 0, bill: { bill_id: remoteId } }); }
      if (pathname.includes("/organizations/")) return Response.json({ code: 0, organization: { organization_id: organizationId, is_org_active: true, currency_code: "AED", currency_id: "77001" } });
      if (pathname.includes("/contacts/")) return Response.json({ code: 0, contact: { contact_id: "77004", contact_type: "vendor", currency_code: "AED", status: "active" } });
      if (pathname === "/books/v3/bills") return Response.json({ code: 0, bills: [], page_context: { has_more_page: false } });
      if (created && pathname === `/books/v3/bills/${remoteId}`) return Response.json({ code: 0, bill: { bill_id: remoteId, vendor_id: "77004",
        reference_number: `VX-BILL-${snapshot.internalBillId}`, bill_number: snapshot.invoiceNumber, currency_code: "AED", total: "105.00", tax_total: "5.00" } });
      throw new Error("Unexpected mocked provider endpoint.");
    });
    return new BooksAdapter(new ZohoTransport(config, async () => "fictional-access-token", fetcher,
      request => assertLiveJobWrite(claimed.id, claimed.leaseToken ?? "", request)));
  };
}

describe("real MySQL automatic final-save sync and preserved historical permissions with fake providers only", () => {
  it("never adopts or replaces a local-purpose permit through ordinary LIVE permissions even with an enabled production source", async () => {
    const { bill, preview, operation } = await queuedBill();
    await expect(assertLiveJobPermission(operation, config, false)).resolves.toMatchObject({ snapshot: { internalBillId: bill.id } });
    const proofHash = "a".repeat(64);
    await db.liveSyncAuthorization.update({ where: { id: preview.challengeId }, data: {
      purpose: "LOCAL_ONE_BILL_TEST", localProof: {}, localProofHash: proofHash,
    } });
    await expect(previewLiveBillSync(admin, bill.id, organizationId)).rejects.toMatchObject({
      code: "LIVE_PERMISSION_REQUIRED", message: expect.stringContaining("different permission purpose"),
    });
    await expect(assertLiveJobPermission(operation, config, false)).rejects.toMatchObject({ code: "LIVE_PERMISSION_REQUIRED" });
    await db.liveSyncAuthorization.update({ where: { id: preview.challengeId }, data: { confirmedAt: null, canonicalJobId: null } });
    const source = await db.bill.findUniqueOrThrow({ where: { id: bill.id }, include: sourceInclude });
    await expect(confirmLiveSnapshot(db, source, config, admin.id, confirmation(preview))).rejects.toMatchObject({ code: "LIVE_PERMISSION_REQUIRED" });
    await expect(recordLiveConfirmation(db, preview.challengeId, operation, admin.id, companyId)).rejects.toMatchObject({ code: "LIVE_PERMISSION_REQUIRED" });
    expect(await db.liveSyncAuthorization.findUnique({ where: { id: preview.challengeId } })).toMatchObject({
      purpose: "LOCAL_ONE_BILL_TEST", localProof: {}, localProofHash: proofHash, confirmedAt: null, canonicalJobId: null,
    });
    expect(await db.integrationJob.findUnique({ where: { id: operation.id } })).toMatchObject({ status: "QUEUED" });
  });
  it("final save queues and the general worker posts a READY bill without any separate approval", async () => {
    const bill = await createBill(staff, { companyId, vendorId, jobId, invoiceNumber: `FICTIONAL-FINAL-SAVE-${tag}`, invoiceDate: "2026-10-28", category: "MATERIALS", currency: "AED", submit: true,
      discount: "0", vatRate: "5", lines: [{ description: "FICTIONAL final save", quantity: "1", unitPrice: "100" }] });
    expect(bill.status).toBe("READY");
    const operation = await db.integrationJob.findUniqueOrThrow({ where: { idempotencyKey: `ZOHO:${bill.id}:CREATE_BILL` } });
    expect(operation.initiatedById).toBe(staff.id);
    expect(await db.liveSyncAuthorization.count({ where: { billId: bill.id } })).toBe(0);
    await db.integrationJob.update({ where: { id: operation.id }, data: { nextAttemptAt: new Date(0) } });
    const posts: string[] = [];
    await processIntegrationJobs({ limit: 1, adapterFactory: fakeProvider(posts) });
    expect(posts).toEqual([operation.id]);
    expect(await db.bill.findUnique({ where: { id: bill.id } })).toMatchObject({ status: "READY", approvedById: null, approvedAt: null });
    expect(await db.syncRecord.findUnique({ where: { billId_target: { billId: bill.id, target: "ZOHO" } } })).toMatchObject({ status: "SYNCED", organizationId });
    expect(await db.payment.count({ where: { billId: bill.id } })).toBe(0);
  });
  it("preserves an existing historical actor-bound permission without silently enabling its general-worker path", async () => {
    const bill = await approvedBill();
    const preview = await previewLiveBillSync(admin, bill.id, organizationId);
    await expect(queueBill(accounts, bill.id, "ZOHO", organizationId, confirmation(preview))).rejects.toMatchObject({ code: "LIVE_PERMISSION_REQUIRED" });
    const operation = await queueBill(admin, bill.id, "ZOHO", organizationId, confirmation(preview));
    await expect(queueBill(admin, bill.id, "ZOHO", organizationId, confirmation(preview))).rejects.toMatchObject({ code: "LIVE_PERMISSION_REQUIRED" });
    const other = await queuedBill(); const posts: string[] = [];
    await processIntegrationJobs({ limit: 1, adapterFactory: fakeProvider(posts) });
    expect(await db.integrationJob.findUnique({ where: { id: operation.id } })).toMatchObject({ status: "QUEUED" });
    expect(await db.integrationJob.findUnique({ where: { id: other.operation.id } })).toMatchObject({ status: "QUEUED" });
    await processIntegrationJobs({ jobId: operation.id, adapterFactory: fakeProvider(posts) });
    expect(posts).toContain(operation.id); expect(posts).not.toContain(other.operation.id);
    expect(await db.integrationJob.findUnique({ where: { id: operation.id } })).toMatchObject({ status: "SUCCEEDED" });
    expect(await db.syncRecord.findUnique({ where: { billId_target: { billId: bill.id, target: "ZOHO" } } })).toMatchObject({ status: "SYNCED", organizationId });
  });
  it("explicit queueing of a historical approved bill is approval-free and payment-only version changes do not block export", async () => {
    const bill = await approvedBill();
    const operation = await queueBill(staff, bill.id, "ZOHO", organizationId);
    expect(operation.initiatedById).toBe(staff.id);
    expect(await db.liveSyncAuthorization.count({ where: { billId: bill.id } })).toBe(0);
    await actOnBill(accounts, bill.id, { action: "payment", version: bill.version, amount: "20", reference: `LOCAL-PAYMENT-${tag}` });
    await db.integrationJob.update({ where: { id: operation.id }, data: { nextAttemptAt: new Date(0) } });
    const posts: string[] = [];
    await processIntegrationJobs({ limit: 1, adapterFactory: fakeProvider(posts) });
    expect(posts).toEqual([operation.id]);
    expect((await db.bill.findUniqueOrThrow({ where: { id: bill.id } })).paidAmount.toFixed(2)).toBe("20.00");
    expect(await db.payment.count({ where: { billId: bill.id } })).toBe(1);
  });
  it("retains final saves with a visible blocked status when company setup is missing or ambiguous", async () => {
    const storedDestination = await db.companyIntegrationDestination.findUniqueOrThrow({ where: { companyId_target_organizationId_dataCenter_environment: destination() } });
    await db.companyIntegrationDestination.delete({ where: { companyId_target_organizationId_dataCenter_environment: destination() } });
    const input = { companyId, vendorId, jobId, invoiceDate: "2026-10-28", category: "MATERIALS", currency: "AED", submit: true,
      discount: "0", vatRate: "5", lines: [{ description: "FICTIONAL blocked setup", quantity: "1", unitPrice: "100" }] };
    try {
      const bill = await createBill(staff, { ...input, invoiceNumber: `FICTIONAL-MISSING-${tag}` });
      expect(bill.status).toBe("READY");
      expect(await db.integrationJob.count({ where: { billId: bill.id } })).toBe(0);
      expect(await db.syncRecord.findUnique({ where: { billId_target: { billId: bill.id, target: "ZOHO" } } })).toMatchObject({ status: "FAILED", organizationId: null });
    } finally { await db.companyIntegrationDestination.create({ data: storedDestination }); }
    const second = `${organizationId}1`;
    await db.companyIntegrationDestination.create({ data: { ...destination(), organizationId: second } });
    vi.stubEnv("ZOHO_BOOKS_ORGANIZATIONS_JSON", JSON.stringify([{ organizationId, name: "FICTIONAL first" }, { organizationId: second, name: "FICTIONAL second" }]));
    vi.mocked(configuration.getConfig).mockImplementation((_target, _environment, requested) => ({ ...config, organizationId: requested ?? organizationId }));
    try {
      const bill = await createBill(staff, { ...input, invoiceNumber: `FICTIONAL-AMBIGUOUS-${tag}` });
      expect(bill.status).toBe("READY"); expect(await db.integrationJob.count({ where: { billId: bill.id } })).toBe(0);
      const record = await db.syncRecord.findUniqueOrThrow({ where: { billId_target: { billId: bill.id, target: "ZOHO" } } });
      expect(record.status).toBe("FAILED"); expect(record.lastError).toMatch(/More than one/);
    } finally { await db.companyIntegrationDestination.delete({ where: { companyId_target_organizationId_dataCenter_environment: { ...destination(), organizationId: second } } }); }
  });
  it("enforces Data Entry ownership and rechecks the autonomous initiator before posting", async () => {
    const outsider = await db.user.create({ data: { email: `outsider-${tag}@example.invalid`, name: "FICTIONAL different creator", role: "DATA_ENTRY", passwordHash: "not-a-login",
      memberships: { create: { companyId } } } });
    const bill = await approvedBill();
    await expect(queueBill(outsider, bill.id, "ZOHO", organizationId)).rejects.toMatchObject({ status: 403 });
    const operation = await queueBill(staff, bill.id, "ZOHO", organizationId);
    await db.userCompanyMembership.update({ where: { userId_companyId: { userId: staff.id, companyId } }, data: { active: false } });
    const posts: string[] = [];
    try { await processIntegrationJobs({ jobId: operation.id, adapterFactory: fakeProvider(posts) }); expect(posts).toEqual([]); }
    finally { await db.userCompanyMembership.update({ where: { userId_companyId: { userId: staff.id, companyId } }, data: { active: true } }); }
  });
  it("rejects changed or expired previews and prevents financial actor revocation from reaching POST", async () => {
    const bill = await approvedBill(); const preview = await previewLiveBillSync(admin, bill.id, organizationId);
    await db.bill.update({ where: { id: bill.id }, data: { version: { increment: 1 } } });
    await expect(queueBill(admin, bill.id, "ZOHO", organizationId, confirmation(preview))).rejects.toMatchObject({ code: "LIVE_PERMISSION_REQUIRED" });
    const current = await previewLiveBillSync(admin, bill.id, organizationId);
    await db.liveSyncAuthorization.update({ where: { id: current.challengeId }, data: { expiresAt: new Date(Date.now() - 1), createdAt: new Date(Date.now() - 60_000) } });
    await expect(queueBill(admin, bill.id, "ZOHO", organizationId, confirmation(current))).rejects.toMatchObject({ code: "LIVE_PERMISSION_REQUIRED" });
    const queued = await queuedBill(); const posts: string[] = [];
    await db.userCompanyMembership.update({ where: { userId_companyId: { userId: admin.id, companyId } }, data: { active: false } });
    try {
      await processIntegrationJobs({ jobId: queued.operation.id, adapterFactory: fakeProvider(posts) });
      expect(posts).toEqual([]);
    } finally { await db.userCompanyMembership.update({ where: { userId_companyId: { userId: admin.id, companyId } }, data: { active: true } }); }
  });
  it("blocks demo provenance, disabled destinations and source changes at worker time", async () => {
    const bill = await approvedBill();
    await db.vendor.update({ where: { id: vendorId }, data: { isDemo: true } });
    try { await expect(previewLiveBillSync(admin, bill.id, organizationId)).rejects.toMatchObject({ code: "LIVE_PERMISSION_REQUIRED" }); }
    finally { await db.vendor.update({ where: { id: vendorId }, data: { isDemo: false } }); }
    const queued = await queuedBill(); const posts: string[] = [];
    await db.companyIntegrationDestination.update({ where: { companyId_target_organizationId_dataCenter_environment: destination() }, data: { liveEnabled: false } });
    try { await processIntegrationJobs({ jobId: queued.operation.id, adapterFactory: fakeProvider(posts) }); expect(posts).toEqual([]); }
    finally { await db.companyIntegrationDestination.update({ where: { companyId_target_organizationId_dataCenter_environment: destination() }, data: { liveEnabled: true } }); }
    const changed = await queuedBill();
    await db.bill.update({ where: { id: changed.bill.id }, data: { version: { increment: 1 } } });
    await processIntegrationJobs({ jobId: changed.operation.id, adapterFactory: fakeProvider(posts) }); expect(posts).toEqual([]);
  });
  it("keeps unrelated production leases untouched during bulk or a different exact-job run", async () => {
    const held = await queuedBill(), selected = await queuedBill();
    await db.integrationJob.update({ where: { id: held.operation.id }, data: { status: "PROCESSING", leaseToken: "fictional-expired", leaseUntil: new Date(Date.now() - 1000) } });
    await processIntegrationJobs({ limit: 1, adapterFactory: fakeProvider([]) });
    await processIntegrationJobs({ jobId: selected.operation.id, adapterFactory: fakeProvider([]) });
    expect(await db.integrationJob.findUnique({ where: { id: held.operation.id } })).toMatchObject({ status: "PROCESSING", leaseToken: "fictional-expired" });
    await processIntegrationJobs({ jobId: held.operation.id, adapterFactory: fakeProvider([]) });
    expect(await db.integrationJob.findUnique({ where: { id: held.operation.id } })).toMatchObject({ status: "UNKNOWN", needsReconciliation: true });
  });
  it("rejects an outgoing body substitution against the durable canonical permission", async () => {
    const queued = await queuedBill();
    await db.integrationJob.update({ where: { id: queued.operation.id }, data: { status: "PROCESSING", leaseToken: "fictional-held", leaseUntil: new Date(Date.now() + 60_000) } });
    const snapshot = snapshotSchema.parse(queued.operation.snapshot);
    await expect(assertLiveJobWrite(queued.operation.id, "fictional-held", { path: "/books/v3/bills", body: { ...buildBooksPayload(snapshot, config), bill_number: "UNAPPROVED" } })).rejects.toMatchObject({ code: "LIVE_PERMISSION_REQUIRED" });
    await expect(assertLiveJobWrite(queued.operation.id, "wrong-lease", { path: "/books/v3/bills", body: buildBooksPayload(snapshot, config) })).rejects.toMatchObject({ code: "LIVE_PERMISSION_REQUIRED" });
  });
});
