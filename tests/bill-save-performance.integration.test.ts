import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
import { BOOKS_NO_VAT, BOOKS_NO_VAT_NAME, type BooksSelection } from "@/lib/books-selection";
import { db } from "@/lib/db";
import { getConfig } from "@/lib/integrations/config";
import { connectionFingerprint } from "@/lib/integrations/connection-fingerprint";
import { ZohoTransport } from "@/lib/integrations/transport";
import { createBill } from "@/lib/services/bills";
import { assertMySqlTestDatabase, bindTestDestination, createTestCompany } from "./company-fixtures";

// Real verification, authorization, persistence and transactions; only provider
// transport/OAuth are mocked. This file refuses ordinary development/prod DBs.
vi.mock("@/lib/integrations/oauth", async importActual => ({
  ...await importActual<typeof import("@/lib/integrations/oauth")>(),
  accessToken: vi.fn(async () => "fictional-save-performance-token"),
}));

const tag = randomUUID().slice(0, 8), organizationId = `995${Date.now()}`;
const accountIds = ["310", "311", "312", "313"], taxId = "410", customerId = "510";
const readDelayMs = 15;
let actor: Actor, companyId: string, vendorId: string, jobId: string;
let paths: string[], methods: string[], active: number, maximumActive: number;
let inactiveAccount: boolean, changedTax: boolean;
let duringRead: ((path: string) => Promise<void>) | null;
type ReadOptions = NonNullable<Parameters<ZohoTransport["request"]>[1]>;

const profile = () => JSON.stringify([{ organizationId, name: "FICTIONAL save performance Books", mapping: {
  verified: true, baseCurrency: "AED", currencies: { AED: { id: "101" } }, taxes: {}, categories: {}, lineSelectionRequired: true,
} }]);
const selection = (accountId = accountIds[0], noVat = false): BooksSelection => ({ organizationId, dataCenter: "US", environment: "sandbox",
  accountId, accountName: "Untrusted submitted account", taxId: noVat ? BOOKS_NO_VAT : taxId,
  taxName: noVat ? BOOKS_NO_VAT_NAME : "Untrusted submitted tax", taxRate: noVat ? "0.00" : "5.00",
  customerId: noVat ? null : customerId, customerName: noVat ? null : "Untrusted submitted customer" });
const input = (lines = [{ description: "FICTIONAL selected materials", quantity: "3", unitPrice: "110.00", booksSelection: selection() }]) => ({
  companyId, vendorId, jobId, invoiceNumber: `FICTIONAL-SAVE-${tag}-${randomUUID()}`, invoiceDate: "2026-11-05", dueDate: "2026-12-05",
  category: "MATERIALS", currency: "AED", discount: "0.00", vatRate: "99.00", notes: "FICTIONAL performance fixture", lines, submit: false,
});

async function persistenceCounts() {
  const [bills, lines, audits, syncRecords, jobs] = await Promise.all([
    db.bill.count({ where: { companyId } }), db.billLine.count({ where: { bill: { companyId } } }),
    db.auditLog.count({ where: { companyId } }), db.syncRecord.count({ where: { bill: { companyId } } }),
    db.integrationJob.count({ where: { bill: { companyId } } }),
  ]);
  return { bills, lines, audits, syncRecords, jobs };
}
function assertOnlySelectedReads(expected: string[]) {
  expect(paths.slice().sort()).toEqual(expected.slice().sort());
  expect(paths).not.toContain("/books/v3/chartofaccounts");
  expect(paths).not.toContain("/books/v3/settings/taxes");
  expect(methods.every(method => method === "GET")).toBe(true);
  expect(maximumActive).toBeLessThanOrEqual(4);
  expect(active).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
}

beforeAll(async () => {
  assertMySqlTestDatabase();
  actor = await db.user.create({ data: { email: `save-performance-${tag}@example.invalid`, name: "FICTIONAL save performance operator",
    role: "ACCOUNTS", passwordHash: "not-a-login" } });
  companyId = (await createTestCompany(`save performance ${tag}`, [actor])).id;
  vendorId = (await db.vendor.create({ data: { companyId, name: `FICTIONAL save supplier ${tag}`, currency: "AED" } })).id;
  jobId = (await db.job.create({ data: { companyId, jobNumber: `FICTIONAL-SAVE-${tag}`, name: "FICTIONAL save job", customer: "FICTIONAL", currency: "AED" } })).id;
  await bindTestDestination(companyId, { target: "ZOHO", organizationId });
  for (const [key, value] of Object.entries({
    INTEGRATION_NETWORK_ENABLED: "true", ZOHO_BOOKS_NETWORK_ENABLED: "true", ZOHO_BOOKS_WRITE_ENABLED: "false",
    ZOHO_BOOKS_LIVE_ENABLED: "false", ALLOW_PRODUCTION_ACCOUNTING_WRITES: "false", MANUAL_ENTRY_ONLY: "false",
    ZOHO_BOOKS_DC: "US", ZOHO_BOOKS_ENVIRONMENT: "sandbox", ZOHO_BOOKS_CLIENT_ID: "fictional-save-client",
    ZOHO_BOOKS_CLIENT_SECRET: "fictional-save-secret", ZOHO_BOOKS_ORGANIZATIONS_JSON: profile(),
  })) vi.stubEnv(key, value);
  await db.integrationCredential.create({ data: { target: "ZOHO", organizationId, dataCenter: "US",
    connectionFingerprint: connectionFingerprint(getConfig("ZOHO", process.env, organizationId)), refreshTokenEncrypted: "never-decrypted-fixture" } });
});

beforeEach(async () => {
  paths = []; methods = []; active = 0; maximumActive = 0; inactiveAccount = false; changedTax = false; duringRead = null;
  await db.userCompanyMembership.updateMany({ where: { userId: actor.id, companyId }, data: { active: true } });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("No real provider network is permitted in this disposable database fixture."); }));
  vi.spyOn(ZohoTransport.prototype, "request").mockImplementation(async function (this: ZohoTransport, resource: string, options: ReadOptions = {}) {
    const method = options.method ?? "GET"; paths.push(resource); methods.push(method);
    expect(this.config.organizationId).toBe(organizationId); expect(this.config.environment).toBe("sandbox");
    expect(method).toBe("GET"); expect(options.body).toBeUndefined(); expect(options.form).toBeUndefined();
    active++; maximumActive = Math.max(maximumActive, active);
    try {
      if (duringRead) await duringRead(resource);
      await new Promise(resolve => setTimeout(resolve, readDelayMs));
      if (resource === `/books/v3/organizations/${organizationId}`)
        return { code: 0, organization: { organization_id: organizationId, is_org_active: true } };
      const account = /^\/books\/v3\/chartofaccounts\/(\d+)$/.exec(resource);
      if (account && accountIds.includes(account[1])) return { code: 0, chart_of_account: { account_id: account[1],
        account_name: `Authoritative material account ${account[1]}`, account_type: "expense", is_active: !inactiveAccount } };
      if (resource === `/books/v3/settings/taxes/${taxId}`) return { code: 0, tax: { tax_id: taxId, tax_name: "Authoritative VAT",
        tax_type: "tax", tax_percentage: changedTax ? 10 : 5, is_active: true } };
      if (resource === `/books/v3/contacts/${customerId}`) return { code: 0, contact: { contact_id: customerId,
        contact_name: "Authoritative customer", contact_type: "customer", status: "active", currency_code: "AED" } };
      throw new Error("A full catalog, unrelated identifier or provider write was unexpectedly requested.");
    } finally { active--; }
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(async () => { vi.unstubAllEnvs(); await db.$disconnect(); });

describe("draft Save performance without weakening durable Books validation", () => {
  it("saves the one-line No VAT case through only its selected account and organization with unchanged finance", async () => {
    const data = input([{ description: "FICTIONAL 330 ML material", quantity: "3", unitPrice: "110.00", booksSelection: selection(accountIds[0], true) }]);
    const original = structuredClone(data), before = await persistenceCounts(), started = performance.now();
    const saved = await createBill(actor, data);
    const elapsedMs = Math.round(performance.now() - started);
    expect(data).toEqual(original);
    expect(saved).toMatchObject({ companyId, vendorId, jobId, createdById: actor.id, status: "DRAFT", paidAmount: "0.00",
      subtotal: "330.00", vatRate: "0.00", vatAmount: "0.00", total: "330.00", discount: "0.00", usesBooksLineTaxes: true });
    const persisted = await db.bill.findUniqueOrThrow({ where: { id: saved.id }, include: { lines: true, payments: true, documents: true } });
    expect(persisted.lines).toHaveLength(1); expect(persisted.payments).toEqual([]); expect(persisted.documents).toEqual([]);
    expect(persisted.lines[0].quantity.toString()).toBe("3"); expect(persisted.lines[0].unitPrice.toFixed(2)).toBe("110.00");
    expect(persisted.lines[0].booksSelection).toEqual({ ...selection(accountIds[0], true), accountName: `Authoritative material account ${accountIds[0]}` });
    expect(await persistenceCounts()).toEqual({ bills: before.bills + 1, lines: before.lines + 1, audits: before.audits + 1, syncRecords: before.syncRecords + 2, jobs: before.jobs });
    assertOnlySelectedReads([`/books/v3/organizations/${organizationId}`, `/books/v3/chartofaccounts/${accountIds[0]}`]);
    expect(maximumActive).toBe(2);
    console.info(JSON.stringify({ benchmark: "one-line-draft-no-vat", elapsedMs, providerReadCount: paths.length, maximumActive, controlledReadDelayMs: readDelayMs }));
  });

  it("deduplicates repeated IDs, normalizes authoritative metadata and bounds independent reads to four before creating the draft", async () => {
    const lines = [...accountIds, accountIds[0]].map((accountId, index) => ({ description: `FICTIONAL selected item ${index + 1}`, quantity: "2", unitPrice: "10.00", booksSelection: selection(accountId) }));
    const data = input(lines), original = structuredClone(data), started = performance.now();
    const saved = await createBill(actor, data);
    const elapsedMs = Math.round(performance.now() - started);
    expect(data).toEqual(original);
    expect(saved).toMatchObject({ status: "DRAFT", subtotal: "100.00", vatRate: "5.00", vatAmount: "5.00", total: "105.00", paidAmount: "0.00" });
    for (const line of saved.lines) expect(line.booksSelection).toMatchObject({ taxId, taxName: "Authoritative VAT", taxRate: "5.00",
      customerId, customerName: "Authoritative customer" });
    expect(saved.lines.map(line => line.booksSelection?.accountName).sort()).toEqual(lines.map(line => `Authoritative material account ${line.booksSelection.accountId}`).sort());
    assertOnlySelectedReads([`/books/v3/organizations/${organizationId}`, ...accountIds.map(id => `/books/v3/chartofaccounts/${id}`),
      `/books/v3/settings/taxes/${taxId}`, `/books/v3/contacts/${customerId}`]);
    expect(maximumActive).toBe(4); expect(await db.integrationJob.count({ where: { billId: saved.id } })).toBe(0);
    console.info(JSON.stringify({ benchmark: "repeated-selected-id-draft", elapsedMs, providerReadCount: paths.length, maximumActive, controlledReadDelayMs: readDelayMs }));
  });

  it.each([{ mode: "inactive account", status: 422 }, { mode: "changed tax rate", status: 409 }])(
    "rejects $mode before any financial persistence or bill audit is created", async ({ mode, status }) => {
      inactiveAccount = mode === "inactive account"; changedTax = mode === "changed tax rate";
      const before = await persistenceCounts();
      await expect(createBill(actor, input())).rejects.toMatchObject({ status });
      expect(await persistenceCounts()).toEqual(before);
      assertOnlySelectedReads([`/books/v3/organizations/${organizationId}`, `/books/v3/chartofaccounts/${accountIds[0]}`,
        `/books/v3/settings/taxes/${taxId}`, `/books/v3/contacts/${customerId}`]);
    });

  it("settles provider reads and rechecks revoked membership before creating any bill or audit", async () => {
    const before = await persistenceCounts(); let revoked = false;
    duringRead = async resource => {
      if (!revoked && resource === `/books/v3/chartofaccounts/${accountIds[0]}`) {
        revoked = true;
        await db.userCompanyMembership.updateMany({ where: { userId: actor.id, companyId }, data: { active: false } });
      }
    };
    await expect(createBill(actor, input())).rejects.toMatchObject({ status: 403 });
    expect(revoked).toBe(true); expect(await persistenceCounts()).toEqual(before);
    assertOnlySelectedReads([`/books/v3/organizations/${organizationId}`, `/books/v3/chartofaccounts/${accountIds[0]}`,
      `/books/v3/settings/taxes/${taxId}`, `/books/v3/contacts/${customerId}`]);
  });
});
