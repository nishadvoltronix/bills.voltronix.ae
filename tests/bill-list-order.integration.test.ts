import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { listBills } from "@/lib/services/bills";
import { assertMySqlTestDatabase, createTestCompany } from "./company-fixtures";

const tag = randomUUID().slice(0, 8);
let admin: Actor, accounts: Actor, entry: Actor, management: Actor, peer: Actor;
let companyA: string, companyB: string;
const references = new Map<string, { jobId: string; vendorId: string }>();
const day = (value: string) => new Date(value + "T00:00:00Z");
const params = (q: string, extra: Record<string, string> = {}) => new URLSearchParams({ q, ...extra });
const ids = (result: Awaited<ReturnType<typeof listBills>>) => result.bills.map(bill => bill.id);

async function bill(prefix: string, suffix: string, input: {
  companyId?: string; creator?: Actor; invoiceDate?: string; createdAt?: string; updatedAt?: string; total?: string; id?: string;
} = {}) {
  const companyId = input.companyId ?? companyA;
  const source = references.get(companyId)!;
  const createdAt = day(input.createdAt ?? "2020-01-01");
  return db.bill.create({ data: {
    ...(input.id ? { id: input.id } : {}), companyId, vendorId: source.vendorId, jobId: source.jobId,
    createdById: (input.creator ?? accounts).id, invoiceNumber: `${prefix}-${suffix}`, normalizedInvoiceNumber: `${prefix}-${suffix}`,
    invoiceDate: day(input.invoiceDate ?? "2026-01-01"), category: "Materials", currency: "AED", status: "DRAFT",
    subtotal: input.total ?? "10.00", discount: "0.00", vatRate: "0.00", vatAmount: "0.00", total: input.total ?? "10.00", paidAmount: "0.00",
    createdAt, updatedAt: input.updatedAt ? day(input.updatedAt) : createdAt,
    lines: { create: { description: "Fictional list-order fixture", quantity: "1", unitPrice: input.total ?? "10.00", lineTotal: input.total ?? "10.00" } },
  } });
}

beforeAll(async () => {
  assertMySqlTestDatabase();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Providers are forbidden in bill-list ordering tests."); }));
  [admin, accounts, entry, management, peer] = await Promise.all((["ADMIN", "ACCOUNTS", "DATA_ENTRY", "MANAGEMENT", "ACCOUNTS"] as const)
    .map((role, index) => db.user.create({ data: { email: `bill-order-${tag}-${index}@example.invalid`, name: `Fictional ordering actor ${index}`,
      role, passwordHash: "unusable-fixture" } })));
  companyA = (await createTestCompany(`ordering Alpha ${tag}`, [admin, accounts, entry, management, peer])).id;
  companyB = (await createTestCompany(`ordering Beta ${tag}`, [admin, peer])).id;
  for (const companyId of [companyA, companyB]) {
    const job = await db.job.create({ data: { companyId, jobNumber: `ORDER-${tag}`, name: "Fictional ordering job", customer: "Fictional customer", currency: "AED" } });
    const vendor = await db.vendor.create({ data: { companyId, name: `Fictional ordering vendor ${tag}`, currency: "AED" } });
    references.set(companyId, { jobId: job.id, vendorId: vendor.id });
  }
});
afterAll(async () => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  await db.$disconnect();
});

describe("bill list latest activity ordering on disposable MySQL", () => {
  it("defaults Admin to fresh saves and edits even when their invoice dates are older", async () => {
    const prefix = `ACTIVITY-${tag}`;
    const recentInvoice = await bill(prefix, "recent-invoice", { invoiceDate: "2026-01-01", createdAt: "2020-01-01" });
    const olderToEdit = await bill(prefix, "older-to-edit", { invoiceDate: "2018-01-01", createdAt: "2020-01-02", creator: peer });
    const freshSave = await bill(prefix, "fresh-save", { invoiceDate: "2019-01-01", createdAt: "2020-01-03" });
    expect(ids(await listBills(admin, params(prefix)))).toEqual([freshSave.id, olderToEdit.id, recentInvoice.id]);
    // A normal retained draft edit updates @updatedAt without changing its
    // invoice date, amount, creator, company or job.
    const edited = await db.bill.update({ where: { id: olderToEdit.id }, data: { notes: "Edited after the newer save." } });
    expect(edited.updatedAt > freshSave.updatedAt).toBe(true);
    const result = await listBills(admin, params(prefix));
    expect(ids(result)).toEqual([olderToEdit.id, freshSave.id, recentInvoice.id]);
    expect(result.bills[0]).toMatchObject({ invoiceDate: "2018-01-01", total: "10.00", paidAmount: "0.00",
      createdById: peer.id, companyId: companyA, jobId: olderToEdit.jobId });
  });

  it("uses creation time then descending IDs to keep tied Next pages deterministic", async () => {
    const prefix = `TIED-${tag}`;
    const expected: string[] = [];
    for (const [suffix, createdAt] of [["09", "2020-01-01"], ["08", "2020-01-01"], ["03", "2020-01-02"], ["02", "2020-01-02"], ["01", "2020-01-02"]]) {
      const row = await bill(prefix, suffix, { id: `${tag}-order-${suffix}`, createdAt, updatedAt: "2020-02-01" });
      if (["03", "02", "01"].includes(suffix)) expected.push(row.id);
    }
    expected.push(`${tag}-order-09`, `${tag}-order-08`);
    const pages = await Promise.all([1, 2, 3].map(page => listBills(admin, params(prefix, { sort: "updated_desc", page: String(page), pageSize: "2" }))));
    expect(pages.map(page => page.total)).toEqual([5, 5, 5]);
    expect(pages.map(page => page.page)).toEqual([1, 2, 3]);
    const all = pages.flatMap(ids);
    expect(all).toEqual(expected); expect(new Set(all).size).toBe(5);
    expect(ids(await listBills(admin, params(prefix, { sort: "updated_desc", page: "2", pageSize: "2" })))).toEqual(ids(pages[1]));
  });

  it.each(["date_desc", "date_asc", "total_desc", "total_asc"])("keeps explicit %s ordering independent of recent activity", async sort => {
    const prefix = `EXPLICIT-${sort}-${tag}`;
    const first = await bill(prefix, "first", { invoiceDate: "2020-01-01", updatedAt: "2020-03-03", total: "20.00" });
    const second = await bill(prefix, "second", { invoiceDate: "2021-01-01", updatedAt: "2020-03-02", total: "10.00" });
    const third = await bill(prefix, "third", { invoiceDate: "2022-01-01", updatedAt: "2020-03-01", total: "30.00" });
    const expected = sort === "date_desc" ? [third.id, second.id, first.id] : sort === "date_asc" ? [first.id, second.id, third.id] :
      sort === "total_desc" ? [third.id, first.id, second.id] : [second.id, first.id, third.id];
    expect(ids(await listBills(admin, params(prefix, { sort })))).toEqual(expected);
  });

  it.each(["ACCOUNTS", "DATA_ENTRY", "MANAGEMENT"])("preserves %s default invoice-date order and creator/company privacy", async role => {
    const owner = role === "ACCOUNTS" ? accounts : role === "DATA_ENTRY" ? entry : management;
    const prefix = `PRIVATE-${role}-${tag}`;
    const olderInvoice = await bill(prefix, "own-older", { creator: owner, invoiceDate: "2019-01-01", updatedAt: "2020-03-02" });
    const newerInvoice = await bill(prefix, "own-newer", { creator: owner, invoiceDate: "2026-01-01", updatedAt: "2020-03-01" });
    await bill(prefix, "peer-newest", { creator: peer, updatedAt: "2020-04-01" });
    await bill(prefix, "foreign-own-newest", { companyId: companyB, creator: owner, updatedAt: "2020-05-01" });
    expect(ids(await listBills(owner, params(prefix)))).toEqual([newerInvoice.id, olderInvoice.id]);
    expect(ids(await listBills(owner, params(prefix, { sort: "updated_desc" })))).toEqual([olderInvoice.id, newerInvoice.id]);
    expect((await listBills(owner, params(prefix, { sort: "updated_desc", pageSize: "1" }))).total).toBe(2);
    await expect(listBills(owner, params(prefix, { companyId: companyB, sort: "updated_desc" }))).rejects.toMatchObject({ status: 404 });
    expect((await listBills(admin, params(prefix, { companyId: companyA }))).total).toBe(3);
  });

  it("keeps invoice-date, company and status filters while ordering by recent edits", async () => {
    const prefix = `FILTERED-${tag}`;
    await bill(prefix, "old-invoice", { invoiceDate: "2019-01-01", updatedAt: "2020-04-01" });
    const withinDates = await bill(prefix, "newer-invoice", { invoiceDate: "2026-01-10", updatedAt: "2020-03-01" });
    await bill(prefix, "foreign-invoice", { companyId: companyB, invoiceDate: "2026-01-10", updatedAt: "2020-05-01" });
    const result = await listBills(admin, params(prefix, { companyId: companyA, sort: "updated_desc", status: "DRAFT",
      dateFrom: "2026-01-01", dateTo: "2026-01-31", vendorId: references.get(companyA)!.vendorId,
      jobId: references.get(companyA)!.jobId, paymentStatus: "UNPAID" }));
    expect(ids(result)).toEqual([withinDates.id]); expect(result.total).toBe(1);
  });
});
