import { randomUUID } from "node:crypto";
import type { BillStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { getBillItemSuggestions } from "@/lib/services/bill-item-suggestions";
import { assertMySqlTestDatabase, createTestCompany } from "./company-fixtures";

const tag = randomUUID().slice(0, 8);
let admin: Actor, owner: Actor, entry: Actor, peer: Actor;
let companyA: string, companyB: string, jobA: string, jobB: string, otherJob: string;
const vendors = new Map<string, string>();
let sequence = 0;
const date = (value: string) => new Date(`${value}T00:00:00Z`);
const query = (q: string, companyId = companyA, jobId = jobA) => new URLSearchParams({ companyId, jobId, q });
const descriptions = (result: Awaited<ReturnType<typeof getBillItemSuggestions>>) => result.suggestions.map(item => item.description);

async function save(lines: string[], input: {
  author?: Actor; companyId?: string; jobId?: string; status?: BillStatus; updatedAt?: string; createdAt?: string; id?: string;
} = {}) {
  const companyId = input.companyId ?? companyA;
  const invoiceNumber = `SUGGEST-${tag}-${++sequence}`;
  return db.bill.create({ data: {
    ...(input.id ? { id: input.id } : {}), companyId, jobId: input.jobId ?? jobA,
    vendorId: vendors.get(companyId)!, createdById: (input.author ?? owner).id,
    invoiceNumber, normalizedInvoiceNumber: invoiceNumber,
    invoiceDate: date("2010-01-01"), category: "Materials", currency: "AED", status: input.status ?? "DRAFT",
    ...(input.status === "APPROVED" ? { approvedById: admin.id, approvedAt: date("2020-01-01") } : {}),
    subtotal: String(lines.length), total: String(lines.length), discount: "0", vatRate: "0", vatAmount: "0", paidAmount: "0",
    createdAt: date(input.createdAt ?? "2020-01-01"), updatedAt: date(input.updatedAt ?? "2020-01-01"),
    lines: { create: lines.map(description => ({ description, quantity: "1", unitPrice: "1", lineTotal: "1" })) },
  } });
}

beforeAll(async () => {
  assertMySqlTestDatabase();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("No provider calls are permitted for native item suggestions."); }));
  [admin, owner, entry, peer] = await Promise.all((["ADMIN", "ACCOUNTS", "DATA_ENTRY", "ACCOUNTS"] as const).map((role, index) =>
    db.user.create({ data: { email: `item-suggestions-${tag}-${index}@example.invalid`, name: `Fictional suggestions user ${index}`,
      passwordHash: "unusable-test-password", role } })));
  companyA = (await createTestCompany(`item suggestions Alpha ${tag}`, [admin, owner, entry, peer])).id;
  companyB = (await createTestCompany(`item suggestions Beta ${tag}`, [admin, peer])).id;
  for (const companyId of [companyA, companyB]) {
    vendors.set(companyId, (await db.vendor.create({ data: { companyId, name: `Fictional suggestions vendor ${tag}`, currency: "AED" } })).id);
    const job = await db.job.create({ data: { companyId, jobNumber: `JOB-${tag}`, name: "Fictional shared job reference", customer: "Fictional customer", currency: "AED" } });
    if (companyId === companyA) jobA = job.id; else jobB = job.id;
  }
  otherJob = (await db.job.create({ data: { companyId: companyA, jobNumber: `OTHER-${tag}`, name: "Fictional different job", customer: "Fictional customer", currency: "AED" } })).id;
});

afterAll(async () => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  await db.$disconnect();
});

describe("job item suggestions on guarded disposable MySQL", () => {
  it("ranks recent saves/edits and deduplicates trimmed descriptions case-insensitively", async () => {
    const key = `Copper-${tag}`;
    await save([`${key} WIRE`]);
    await save([`  ${key.toLowerCase()} wire  `], { updatedAt: "2020-01-02", author: peer });
    const edited = await save([`${key} CLAMP`], { updatedAt: "2020-01-03" });
    const response = await getBillItemSuggestions(admin, query(key.toUpperCase()));
    expect(response).toEqual({ companyId: companyA, jobId: jobA, suggestions: [
      { description: `${key} CLAMP` }, { description: `${key.toLowerCase()} wire` },
    ] });
    await db.bill.update({ where: { id: edited.id }, data: { updatedAt: date("2020-01-01") } });
    expect(descriptions(await getBillItemSuggestions(admin, query(key)))).toEqual([`${key.toLowerCase()} wire`, `${key} CLAMP`]);
  });

  it("uses current saved bill activity without changing financial or source rows", async () => {
    const key = `Activity-${tag}`;
    const first = await save([`${key} first`], { updatedAt: "2020-01-01" });
    const second = await save([`${key} second`], { updatedAt: "2020-01-02" });
    const sourceBefore = await db.bill.findUniqueOrThrow({ where: { id: first.id }, include: { lines: true, payments: true, documents: true } });
    const beforeCounts = await Promise.all([db.bill.count(), db.billLine.count(), db.auditLog.count(), db.payment.count(), db.document.count()]);
    expect(descriptions(await getBillItemSuggestions(owner, query(key)))).toEqual([`${key} second`, `${key} first`]);
    expect(await db.bill.findUniqueOrThrow({ where: { id: first.id }, include: { lines: true, payments: true, documents: true } })).toEqual(sourceBefore);
    expect(await Promise.all([db.bill.count(), db.billLine.count(), db.auditLog.count(), db.payment.count(), db.document.count()])).toEqual(beforeCounts);
    await db.bill.update({ where: { id: first.id }, data: { notes: "A real local test edit changes @updatedAt only." } });
    expect(descriptions(await getBillItemSuggestions(owner, query(key)))).toEqual([`${key} first`, `${key} second`]);
    expect(second.invoiceDate).toEqual(first.invoiceDate);
  });

  it.each(["ACCOUNTS", "DATA_ENTRY"] as const)("returns only %s's own items within the exact selected company and job", async role => {
    const actor = role === "ACCOUNTS" ? owner : entry;
    const key = `Private-${role}-${tag}`;
    await save([`${key} own`], { author: actor });
    await save([`${key} peer private`], { author: peer, updatedAt: "2020-02-01" });
    await save([`${key} other job`], { author: actor, jobId: otherJob });
    await save([`${key} foreign company`], { author: actor, companyId: companyB, jobId: jobB });
    expect(descriptions(await getBillItemSuggestions(actor, query(key)))).toEqual([`${key} own`]);
    expect(descriptions(await getBillItemSuggestions(admin, query(key)))).toEqual([`${key} peer private`, `${key} own`]);
    await expect(getBillItemSuggestions(actor, query(key, companyB, jobB))).rejects.toMatchObject({ status: 404 });
    await expect(getBillItemSuggestions(admin, query(key, companyA, jobB))).rejects.toMatchObject({ status: 404 });
    expect(descriptions(await getBillItemSuggestions(admin, query(key, companyB, jobB)))).toEqual([`${key} foreign company`]);
  });

  it("includes saved drafts and finalized bills but excludes cancelled/rejected items", async () => {
    const key = `Status-${tag}`;
    for (const status of ["DRAFT", "READY", "APPROVED", "PENDING_APPROVAL", "REJECTED", "CANCELLED"] as const)
      await save([`${key} ${status}`], { status });
    expect(new Set(descriptions(await getBillItemSuggestions(owner, query(key))))).toEqual(new Set([
      `${key} DRAFT`, `${key} READY`, `${key} APPROVED`, `${key} PENDING_APPROVAL`,
    ]));
  });

  it("filters matches before the cap and returns ten unique items despite repeated recent lines", async () => {
    const key = `Bound-${tag}`;
    const expected: string[] = [];
    for (let index = 1; index <= 12; index++) {
      const description = `${key} matching ${String(index).padStart(2, "0")}`;
      await save([description], { updatedAt: `2020-03-${String(index).padStart(2, "0")}` });
      expected.unshift(description);
    }
    // Hundreds of newer nonmatches and repeated matches cannot starve older
    // distinct matches, because both search and dedup happen inside MySQL.
    await save(Array.from({ length: 100 }, () => `${key} matching 12`), { updatedAt: "2020-04-01" });
    await save(Array.from({ length: 100 }, (_, index) => `Unrelated-${tag}-${index}`), { updatedAt: "2020-05-01" });
    const response = await getBillItemSuggestions(owner, query(`${key} matching`));
    expect(descriptions(response)).toEqual(expected.slice(0, 10));
    expect(new Set(descriptions(response)).size).toBe(10);
    expect(response.suggestions.every(item => Object.keys(item).join() === "description")).toBe(true);
  });

  it("breaks equal-activity ties by creation time and descending bill IDs", async () => {
    const key = `Tie-${tag}`;
    await save([`${key} early`], { id: `${tag}-suggest-99`, createdAt: "2020-01-01", updatedAt: "2020-06-01" });
    await save([`${key} later lower ID`], { id: `${tag}-suggest-01`, createdAt: "2020-01-02", updatedAt: "2020-06-01" });
    await save([`${key} later higher ID`], { id: `${tag}-suggest-02`, createdAt: "2020-01-02", updatedAt: "2020-06-01" });
    const expected = [`${key} later higher ID`, `${key} later lower ID`, `${key} early`];
    expect(descriptions(await getBillItemSuggestions(owner, query(key)))).toEqual(expected);
    expect(descriptions(await getBillItemSuggestions(owner, query(key)))).toEqual(expected);
  });

  it("treats percent, underscore, backslash and SQL-looking input as literal characters", async () => {
    const literal = `Literal-${tag} 50%_\\' OR 1=1 -- cable`;
    await save([literal, `Literal-${tag} 50abc cable`, "An unrelated private item"]);
    expect(descriptions(await getBillItemSuggestions(owner, query("50%_\\' OR 1=1 --")))).toEqual([literal]);
    expect(descriptions(await getBillItemSuggestions(owner, query("does-not-exist")))).toEqual([]);
  });

  it("rejects revoked membership and changed actor role without exposing history", async () => {
    const key = `Revoked-${tag}`;
    const user = await db.user.create({ data: { email: `item-revoked-${tag}@example.invalid`, name: "Fictional revoked writer", role: "ACCOUNTS", passwordHash: "unusable" } });
    await db.userCompanyMembership.create({ data: { companyId: companyA, userId: user.id } });
    await save([key], { author: user });
    expect(descriptions(await getBillItemSuggestions(user, query(key)))).toEqual([key]);
    await db.userCompanyMembership.updateMany({ where: { companyId: companyA, userId: user.id }, data: { active: false } });
    await expect(getBillItemSuggestions(user, query(key))).rejects.toMatchObject({ status: 404 });
    await db.userCompanyMembership.updateMany({ where: { companyId: companyA, userId: user.id }, data: { active: true } });
    await db.user.update({ where: { id: user.id }, data: { role: "DATA_ENTRY" } });
    await expect(getBillItemSuggestions(user, query(key))).rejects.toMatchObject({ status: 403 });
  });
});
