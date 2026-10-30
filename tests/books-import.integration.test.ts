import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { beginBooksBillImport, finishBooksBillImport, getBooksBill, importBooksBillDetail,
  importBooksBillSummaryPage, listBooksBills } from "@/lib/services/books-import";
import { assertMySqlTestDatabase } from "./company-fixtures";

const tag = randomUUID().slice(0, 8);
const organizationId = "99773355";
const otherOrganizationId = "99774455";
const companyId = `connection-check-books-${organizationId}`;
const otherCompanyId = `connection-check-books-${otherOrganizationId}`;
let actor: Actor;
let reader: Actor;
let runId: string;
let billId: string;
let counts: { bills: number; jobs: number; vendors: number; payments: number; queue: number };
const summary = (id: string) => ({ bill_id: id, vendor_id: "2001", vendor_name: "Fictional Supplier",
  bill_number: `FICTIONAL-${id}`, status: "partially_paid", currency_code: "KWD", date: "2026-10-01", due_date: "2026-10-31",
  total: "9007199254740993.001", balance: "9007199254740990.001", has_attachment: true,
  reference_number: "Fictional purchase", last_modified_time: "2026-10-28T10:00:00+0400" });
const page = (ids: string[], number = 1, hasMore = false) => ({ code: 0, bills: ids.map(summary),
  page_context: { page: number, has_more_page: hasMore } });
const detail = (id: string) => ({ code: 0, bill: { ...summary(id), sub_total: "9007199254740993.001", tax_total: "0.000",
  payment_made: "2.000", vendor_credits_applied: "1.000", notes: "Fictional internal notes",
  line_items: [{ line_item_id: "3001", name: "Fictional expense", quantity: "1.000", rate: "9007199254740993.001", item_total: "9007199254740993.001" }],
  payments: [{ payment_id: "4001", date: "2026-10-20", amount: "2.000", reference_number: "Fictional paid", bank_details: "private-provider-field" }],
  vendor_credits: [{ vendor_credit_id: "5001", vendor_credit_number: "VC-F1", date: "2026-10-21", amount: "1.000" }],
  documents: [{ document_id: "6001", file_name: "Fictional bill.pdf", signed_url: "https://example.invalid/private" }],
  private_provider_field: "preserved-in-database-only" } });
async function canonicalCounts() {
  return { bills: await db.bill.count(), jobs: await db.job.count(), vendors: await db.vendor.count(),
    payments: await db.payment.count(), queue: await db.integrationJob.count() };
}

beforeAll(async () => {
  assertMySqlTestDatabase();
  for (const [key, value] of Object.entries({ APP_URL: "http://127.0.0.1:3000", ZOHO_BOOKS_DC: "US",
    ZOHO_BOOKS_ENVIRONMENT: "production", ZOHO_BOOKS_CLIENT_ID: "fictional-client", ZOHO_BOOKS_CLIENT_SECRET: "fictional-secret",
    ZOHO_BOOKS_ORGANIZATIONS_JSON: JSON.stringify([{ organizationId, name: "Fictional Company" }, { organizationId: otherOrganizationId, name: "Fictional Other" }]),
    INTEGRATION_NETWORK_ENABLED: "false", ZOHO_BOOKS_NETWORK_ENABLED: "false", ZOHO_BOOKS_WRITE_ENABLED: "false",
    ZOHO_BOOKS_LIVE_ENABLED: "false", ALLOW_PRODUCTION_ACCOUNTING_WRITES: "false", INTEGRATION_TEST_MODE: "false" })) vi.stubEnv(key, value);
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Provider access forbidden in snapshot imports"); }));
  actor = await db.user.create({ data: { email: `books-import-${tag}@example.invalid`, name: "Fictional admin", role: "ADMIN", passwordHash: "fixture-unusable" } });
  reader = await db.user.create({ data: { email: `books-reader-${tag}@example.invalid`, name: "Fictional reader", role: "MANAGEMENT", passwordHash: "fixture-unusable" } });
  for (const [id, org] of [[companyId, organizationId], [otherCompanyId, otherOrganizationId]]) await db.company.create({ data: {
    id, name: `[CONNECTION CHECK] Fictional ${org}`, isDemo: true, liveAccountingEnabled: false,
    memberships: { create: [{ userId: actor.id }, ...(id === companyId ? [{ userId: reader.id }] : [])] },
    integrationDestinations: { create: { target: "ZOHO", organizationId: org, dataCenter: "US", environment: "production", liveEnabled: false } },
  } });
  counts = await canonicalCounts();
});
afterAll(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await db.$disconnect(); });

describe("read-only Books copies on disposable MySQL", () => {
  it("imports consecutive pages idempotently and records incomplete detail coverage", async () => {
    const run = await beginBooksBillImport(actor, { companyId, organizationId, organizationName: "Fictional Company" });
    runId = run.id;
    await expect(beginBooksBillImport(actor, { companyId, organizationId, organizationName: "Fictional Company" }))
      .rejects.toMatchObject({ code: "BOOKS_IMPORT_ALREADY_RUNNING" });
    await importBooksBillSummaryPage(actor, runId, { page: 1, response: page(["1001"], 1, true) });
    await importBooksBillSummaryPage(actor, runId, { page: 1, response: page(["1001"], 1, true) });
    await expect(importBooksBillSummaryPage(actor, runId, { page: 3, response: page(["1002"], 3) }))
      .rejects.toMatchObject({ code: "BOOKS_IMPORT_PAGE_ORDER" });
    await expect(importBooksBillSummaryPage(actor, runId, { page: 2, response: page(["1001"], 2) }))
      .rejects.toMatchObject({ code: "BOOKS_IMPORT_DUPLICATE_BILL" });
    await importBooksBillSummaryPage(actor, runId, { page: 2, response: page(["1002"], 2) });
    expect(await finishBooksBillImport(actor, runId)).toMatchObject({ listedCount: 2, detailCount: 0, status: "PARTIAL", listingComplete: true });
    const listed = await listBooksBills(reader, { companyId, currencyCode: "KWD", q: "Fictional" });
    expect(listed.total).toBe(2);
    expect(listed.filters).toEqual({ statuses: ["partially_paid"], currencies: ["KWD"] });
    expect(listed.bills[0]).toMatchObject({ detailAvailable: false, subtotal: null, paymentMade: null, vendorCreditsApplied: null });
    billId = listed.bills.find((bill) => bill.externalBillId === "1001")!.id;
    expect(await getBooksBill(reader, billId)).toMatchObject({ lines: [], payments: [], credits: [], hasAttachment: true, attachmentsDownloaded: false });
    expect(JSON.stringify(listed)).not.toContain("sourceSummary");
    expect(await canonicalCounts()).toEqual(counts);
  });

  it("resumes details, preserves exact values and private source, and never fabricates ledger entries", async () => {
    await expect(importBooksBillDetail(actor, runId, { response: detail("1001"), externalBillId: "9999" })).rejects.toThrow();
    await expect(importBooksBillDetail(actor, runId, { response: detail("9999"), externalBillId: "9999" }))
      .rejects.toMatchObject({ code: "BOOKS_BILL_NOT_LISTED" });
    await importBooksBillDetail(actor, runId, { response: detail("1001"), externalBillId: "1001" });
    await importBooksBillDetail(actor, runId, { response: detail("1001"), externalBillId: "1001" });
    expect((await db.booksImportRun.findUniqueOrThrow({ where: { id: runId } })).detailCount).toBe(1);
    await importBooksBillDetail(actor, runId, { response: detail("1002"), externalBillId: "1002" });
    expect(await finishBooksBillImport(actor, runId)).toMatchObject({ status: "COMPLETE", listedCount: 2, detailCount: 2 });
    const result = await getBooksBill(reader, billId);
    expect(result).toMatchObject({ total: "9007199254740993.001", balance: "9007199254740990.001",
      paymentMade: "2.000", vendorCreditsApplied: "1.000", detailAvailable: true,
      payments: [{ amount: "2.000" }], credits: [{ amount: "1.000" }], documents: [{ id: "6001", name: "Fictional bill.pdf" }] });
    expect(JSON.stringify(result)).not.toContain("private-provider-field");
    expect(JSON.stringify(result)).not.toContain("preserved-in-database-only");
    expect(JSON.stringify(result)).not.toContain("signed_url");
    expect((await db.booksBill.findUniqueOrThrow({ where: { id: billId } })).sourceDetail).toEqual(detail("1001").bill);
    expect(await canonicalCounts()).toEqual(counts);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps identical external IDs separate across organizations and enforces live membership and roles", async () => {
    const other = await beginBooksBillImport(actor, { companyId: otherCompanyId, organizationId: otherOrganizationId, organizationName: "Fictional Other" });
    await importBooksBillSummaryPage(actor, other.id, { page: 1, response: page(["1001"]) });
    await finishBooksBillImport(actor, other.id);
    const otherBill = await db.booksBill.findFirstOrThrow({ where: { companyId: otherCompanyId } });
    expect(otherBill.id).not.toBe(billId);
    await expect(getBooksBill(reader, otherBill.id)).rejects.toMatchObject({ status: 404 });
    await expect(listBooksBills(reader, { companyId: otherCompanyId })).rejects.toMatchObject({ status: 404 });
    expect((await listBooksBills(reader)).total).toBe(2);
    await expect(listBooksBills({ ...reader, role: "DATA_ENTRY" })).rejects.toMatchObject({ status: 403 });
    await expect(beginBooksBillImport(reader, { companyId, organizationId, organizationName: "Fictional Company" })).rejects.toMatchObject({ status: 403 });
    await db.userCompanyMembership.update({ where: { userId_companyId: { userId: reader.id, companyId } }, data: { active: false } });
    await expect(getBooksBill(reader, billId)).rejects.toMatchObject({ status: 404 });
    await db.userCompanyMembership.update({ where: { userId_companyId: { userId: reader.id, companyId } }, data: { active: true } });
  });

  it("does not present older detail as current, and marks absent rows stale only after a complete listing", async () => {
    const refresh = await beginBooksBillImport(actor, { companyId, organizationId, organizationName: "Fictional Company" });
    await importBooksBillSummaryPage(actor, refresh.id, { page: 1, response: page(["1001"], 1, true) });
    expect(await getBooksBill(reader, billId)).toMatchObject({ detailAvailable: false, subtotal: null, lines: [], payments: [] });
    await finishBooksBillImport(actor, refresh.id);
    expect(await db.booksBill.count({ where: { companyId, isStale: true } })).toBe(0);
    await importBooksBillSummaryPage(actor, refresh.id, { page: 2, response: page([], 2) });
    await finishBooksBillImport(actor, refresh.id);
    expect(await db.booksBill.count({ where: { companyId, isStale: true } })).toBe(1);
    expect(await db.booksBill.count({ where: { companyId } })).toBe(2);
    await importBooksBillDetail(actor, refresh.id, { externalBillId: "1001", response: detail("1001") });
    expect(await finishBooksBillImport(actor, refresh.id)).toMatchObject({ status: "COMPLETE", listedCount: 1, detailCount: 1 });
    expect(await canonicalCounts()).toEqual(counts);
    expect(fetch).not.toHaveBeenCalled();
  });
});
