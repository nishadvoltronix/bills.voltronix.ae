import { randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { attachDocument, readPrivateDocument } from "@/lib/services/documents";
import { buildInvoiceAttachment } from "@/lib/integrations/invoice-bundle";
import { assertMySqlTestDatabase, createTestCompany } from "./company-fixtures";

const tag = randomUUID().slice(0, 8);
const directory = path.resolve(".local", `invoice-attachment-test-${tag}`);
let owner: Actor, peer: Actor, companyId: string, vendorId: string, jobId: string;
async function pdf(index = 1, padding = 0) {
  const document = await PDFDocument.create();
  document.addPage([200 + index, 300 + index]);
  const bytes = Buffer.concat([await document.save(), Buffer.alloc(padding, 32)]);
  return new File([bytes], `fictional-${index}.pdf`, { type: "application/pdf" });
}
async function draft() {
  const invoice = `FILES-${tag}-${randomUUID()}`;
  return db.bill.create({ data: { companyId, vendorId, jobId, createdById: owner.id, invoiceNumber: invoice,
    normalizedInvoiceNumber: invoice, invoiceDate: new Date("2026-11-04"), category: "MATERIALS", currency: "AED",
    status: "DRAFT", subtotal: "10", vatRate: "0", vatAmount: "0", total: "10" } });
}
beforeAll(async () => {
  assertMySqlTestDatabase();
  vi.stubEnv("UPLOAD_DIR", directory);
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("No provider requests in attachment persistence tests"); }));
  [owner, peer] = await Promise.all(["owner", "peer"].map(label => db.user.create({ data: {
    email: `files-${label}-${tag}@example.invalid`, name: `Fictional ${label}`, role: "ACCOUNTS", passwordHash: "unusable-fixture" } })));
  companyId = (await createTestCompany(`invoice-files-${tag}`, [owner, peer])).id;
  vendorId = (await db.vendor.create({ data: { companyId, name: `Fictional supplier ${tag}` } })).id;
  jobId = (await db.job.create({ data: { companyId, jobNumber: `FILES-${tag}`, name: "Fictional invoice job", customer: "Fictional customer" } })).id;
});
afterAll(async () => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
  await db.$disconnect();
  if (path.dirname(directory) !== path.resolve(".local") || path.basename(directory) !== `invoice-attachment-test-${tag}`)
    throw new Error("Unexpected private test cleanup path");
  await rm(directory, { recursive: true, force: true });
});

describe("multiple original uploads on the disposable MySQL database", () => {
  it("recovers a lost upload response once and continues with the next original", async () => {
    const bill = await draft(), firstFile = await pdf(1), secondFile = await pdf(2);
    const first = await attachDocument(owner, bill.id, firstFile, bill.version);
    const retry = await attachDocument(owner, bill.id, firstFile, bill.version);
    expect(retry.id).toBe(first.id);
    expect(retry.alreadyAttached).toBe(true);
    expect(retry.billVersion).toBe(first.billVersion);
    const second = await attachDocument(owner, bill.id, secondFile, retry.billVersion);
    expect(second.billVersion).toBe(first.billVersion + 1);
    const originals = await db.document.findMany({ where: { billId: bill.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    expect(originals).toHaveLength(2);
    const combined = await buildInvoiceAttachment(await Promise.all(originals.map(async row => ({ ...row, bytes: await readPrivateDocument(row) }))));
    expect((await PDFDocument.load(combined.bytes)).getPageCount()).toBe(2);
    expect(await db.auditLog.count({ where: { entityId: bill.id, action: "DOCUMENT_ATTACHED" } })).toBe(2);
    expect(await db.integrationJob.count({ where: { billId: bill.id } })).toBe(0);
  });

  it("rejects an unreadable second original without changing the draft or retaining its temporary file", async () => {
    const bill = await draft();
    const one = await attachDocument(owner, bill.id, await pdf(3), bill.version);
    const files = (await readdir(directory)).sort();
    await expect(attachDocument(owner, bill.id, new File(["%PDF-broken-original"], "broken.pdf", { type: "application/pdf" }), one.billVersion))
      .rejects.toMatchObject({ status: 422 });
    expect((await readdir(directory)).sort()).toEqual(files);
    expect((await db.bill.findUniqueOrThrow({ where: { id: bill.id } })).version).toBe(one.billVersion);
    expect(await db.document.count({ where: { billId: bill.id } })).toBe(1);
    await expect(attachDocument(owner, bill.id, await pdf(4), one.billVersion)).resolves.toMatchObject({ billVersion: one.billVersion + 1 });
  });

  it("enforces five originals and aggregate bytes without changing a saved source", async () => {
    const bill = await draft(); let version = bill.version;
    for (let index = 10; index < 15; index++) version = (await attachDocument(owner, bill.id, await pdf(index), version)).billVersion;
    await expect(attachDocument(owner, bill.id, await pdf(15), version)).rejects.toMatchObject({ status: 413 });
    expect(await db.document.count({ where: { billId: bill.id } })).toBe(5);
    expect((await db.bill.findUniqueOrThrow({ where: { id: bill.id } })).version).toBe(version);
    const large = await draft();
    const first = await attachDocument(owner, large.id, await pdf(20, 3_000_000), large.version);
    await expect(attachDocument(owner, large.id, await pdf(21, 2_000_000), first.billVersion)).rejects.toMatchObject({ status: 413 });
    expect(await db.document.count({ where: { billId: large.id } })).toBe(1);
  });

  it("allows only one concurrent versioned upload and prevents another user's access", async () => {
    const bill = await draft();
    const outcomes = await Promise.allSettled([attachDocument(owner, bill.id, await pdf(30), bill.version), attachDocument(owner, bill.id, await pdf(31), bill.version)]);
    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    expect(await db.document.count({ where: { billId: bill.id } })).toBe(1);
    const saved = await db.bill.findUniqueOrThrow({ where: { id: bill.id } });
    await expect(attachDocument(peer, bill.id, await pdf(32), saved.version)).rejects.toMatchObject({ status: 404 });
    await db.bill.update({ where: { id: bill.id }, data: { status: "READY" } });
    await expect(attachDocument(owner, bill.id, await pdf(33), saved.version)).rejects.toMatchObject({ status: 409 });
  });
});
