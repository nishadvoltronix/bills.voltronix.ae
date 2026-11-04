import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { actOnBill, createBill, getBill, listBills, updateBill } from "@/lib/services/bills";
import { attachDocument, downloadDocument, storePrivateDocument } from "@/lib/services/documents";
import { dashboard, getJob } from "@/lib/services/catalog";
import { searchDashboard } from "@/lib/services/dashboard-search";
import { getBooksBill, listBooksBills } from "@/lib/services/books-import";
import { booksAttachmentMetadataHash, downloadBooksBillAttachment } from "@/lib/services/books-attachments";
import { ownedBooksBillIds } from "@/lib/services/bill-ownership";
import { expenseReport, exportExpenseReport, operationSummary } from "@/lib/services/reports";
import { listIntegrationJobs, queueBill, scheduleIntegrationJob } from "@/lib/integrations/queue";
import { assertMySqlTestDatabase, bindTestDestination, createTestCompany } from "./company-fixtures";

const tag = randomUUID().slice(0, 8), organizationId = `96${BigInt(`0x${tag}`).toString()}`;
const pdf = Buffer.from("%PDF-1.4\nFictional private ownership original\n%%EOF\n");
let admin: Actor, writers: Actor[], manager: Actor, entry: Actor;
let companyId: string, vendorId: string, jobId: string, runId: string;
const bills: Awaited<ReturnType<typeof getBill>>[] = [];
const mirrors: string[] = [], originals: string[] = [], operations: string[] = [];
let importedOnly = "", wrongEnvironment = "", unownedOriginal = "";
const input = (index: number) => ({ companyId, vendorId, jobId, invoiceNumber: `OWNERSHIP-${tag}-${index}`,
  invoiceDate: "2026-11-03", category: "MATERIALS", currency: "AED", vatRate: "0",
  lines: [{ description: "Fictional ownership check", quantity: "1", unitPrice: `${(index + 1) * 11}.00` }] });

beforeAll(async () => {
  assertMySqlTestDatabase();
  vi.stubEnv("MANUAL_ENTRY_ONLY", "true");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Ownership tests cannot contact any provider"); }));
  const users = await Promise.all(["ADMIN", "ACCOUNTS", "ACCOUNTS", "ACCOUNTS", "ACCOUNTS", "DATA_ENTRY"].map((role, index) =>
    db.user.create({ data: { email: `ownership-${index}-${tag}@example.invalid`, name: `Fictional entrant ${index}`, role: role as Actor["role"], passwordHash: "unusable" } })));
  admin = users[0]; writers = users.slice(1, 4); entry = users[5];
  companyId = (await createTestCompany(`ownership ${tag}`, users)).id;
  await bindTestDestination(companyId, { target: "ZOHO", organizationId, environment: "sandbox" });
  vendorId = (await db.vendor.create({ data: { companyId, name: `Fictional supplier ${tag}` } })).id;
  jobId = (await db.job.create({ data: { companyId, jobNumber: `JOB-OWNERSHIP-${tag}`, name: "Fictional shared project", customer: "Fictional customer", currency: "AED" } })).id;
  runId = (await db.booksImportRun.create({ data: { companyId, organizationId, organizationName: "Fictional company", dataCenter: "US",
    environment: "sandbox", initiatedById: admin.id, status: "COMPLETE", listingComplete: true, completedAt: new Date() } })).id;
  for (const [index, author] of [...writers, users[4], entry].entries()) {
    const draft = await createBill(author, input(index));
    await attachDocument(author, draft.id, new File([pdf], `Fictional-owner-${index}.pdf`, { type: "application/pdf" }));
    const uploaded = await getBill(author, draft.id);
    await actOnBill(author, draft.id, { action: "submit", version: uploaded.version });
    bills.push(await getBill(author, draft.id));
    const externalBillId = `80${index + 1}`;
    await db.syncRecord.update({ where: { billId_target: { billId: draft.id, target: "ZOHO" } }, data: { organizationId, externalId: externalBillId, status: "SYNCED" } });
    const source = { document_id: `70${index + 1}`, file_name: `Fictional-owner-${index}.pdf`, file_type: "pdf", file_size: pdf.length };
    const mirror = await db.booksBill.create({ data: { companyId, organizationId, organizationName: "Fictional company", dataCenter: "US", environment: "sandbox",
      externalBillId, billNumber: `OWNERSHIP-${tag}-${index}`, vendorId: "6001", vendorName: "Fictional source supplier", status: "open", currencyCode: "AED",
      subtotal: bills[index].total, taxTotal: "0.00", total: bills[index].total, balance: bills[index].total,
      paymentMade: "0.00", vendorCreditsApplied: "0.00", sourceSummary: { has_attachment: true }, sourceDetail: { documents: [source] },
      lastImportRunId: runId, detailImportRunId: runId, lastSeenAt: new Date(), detailFetchedAt: new Date() } });
    mirrors.push(mirror.id);
    const stored = await storePrivateDocument(new File([pdf], source.file_name, { type: "application/pdf" }));
    originals.push((await db.booksBillAttachment.create({ data: { ...stored, billId: mirror.id, companyId, organizationId, dataCenter: "US", environment: "sandbox",
      externalDocumentId: source.document_id, sourceMetadata: source, sourceMetadataHash: booksAttachmentMetadataHash(source), downloadedAt: new Date() } })).id);
    operations.push((await db.integrationJob.create({ data: { billId: draft.id, target: "ZOHO", operation: "CREATE_BILL", organizationId,
      sourceVersion: bills[index].version, initiatedById: author.id, idempotencyKey: `OWNERSHIP:${draft.id}`, status: "FAILED",
      snapshot: { destination: { dataCenter: "US", environment: "sandbox" } }, payloadHash: "a".repeat(64) } })).id);
  }
  // A historical creator keeps ownership after becoming a read-only manager.
  manager = await db.user.update({ where: { id: users[4].id }, data: { role: "MANAGEMENT" } });
  const baseline = await db.booksBill.findUniqueOrThrow({ where: { id: mirrors[0] } });
  const { id: _id, ...fields } = baseline; void _id;
  const copy = { ...fields, sourceSummary: fields.sourceSummary ?? Prisma.JsonNull, sourceDetail: fields.sourceDetail ?? Prisma.JsonNull };
  importedOnly = (await db.booksBill.create({ data: { ...copy, externalBillId: "8999", billNumber: "IMPORTED-WITHOUT-OWNER", status: "overdue", currencyCode: "USD" } })).id;
  wrongEnvironment = (await db.booksBill.create({ data: { ...copy, environment: "production", billNumber: "WRONG-ENVIRONMENT" } })).id;
  const source = { document_id: "7999", file_name: "Fictional-unowned.pdf", file_type: "pdf", file_size: pdf.length };
  await db.booksBill.update({ where: { id: importedOnly }, data: { sourceDetail: { documents: [source] } } });
  unownedOriginal = (await db.booksBillAttachment.create({ data: { ...await storePrivateDocument(new File([pdf], source.file_name, { type: "application/pdf" })),
    billId: importedOnly, companyId, organizationId, dataCenter: "US", environment: "sandbox", externalDocumentId: source.document_id,
    sourceMetadata: source, sourceMetadataHash: booksAttachmentMetadataHash(source), downloadedAt: new Date() } })).id;
});
afterAll(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await db.$disconnect(); });

describe("creator-only bills for every non-Admin on disposable MySQL", () => {
  it("isolates three Accounts entrants sharing a job across native and Books rows, filters, documents and guessed IDs", async () => {
    for (const [index, actor] of writers.entries()) {
      expect((await listBills(actor, new URLSearchParams({ companyId, jobId }))).bills.map(row => row.id)).toEqual([bills[index].id]);
      expect((await getJob(actor, jobId)).bills.map(row => row.id)).toEqual([bills[index].id]);
      expect((await getJob(actor, jobId)).booksBills.map(row => row.id)).toEqual([mirrors[index]]);
      const source = await listBooksBills(actor, { companyId });
      expect(source.bills.map(row => row.id)).toEqual([mirrors[index]]); expect(source.total).toBe(1);
      expect(source.filters).toEqual({ statuses: ["open"], currencies: ["AED"] }); expect(source.runs).toEqual([]);
      expect((await searchDashboard(actor, new URLSearchParams({ companyId, q: `OWNERSHIP-${tag}` }))).bills.map(row => row.id)).toEqual([mirrors[index]]);
      expect((await getBooksBill(actor, mirrors[index])).id).toBe(mirrors[index]);
      expect((await downloadDocument(actor, bills[index].documents[0].id)).bytes).toEqual(pdf);
      expect((await downloadBooksBillAttachment(actor, mirrors[index], originals[index])).bytes).toEqual(pdf);
      for (const other of [0, 1, 2].filter(value => value !== index)) {
        await expect(getBill(actor, bills[other].id)).rejects.toMatchObject({ status: 404 });
        await expect(getBooksBill(actor, mirrors[other])).rejects.toMatchObject({ status: 404 });
        await expect(downloadDocument(actor, bills[other].documents[0].id)).rejects.toMatchObject({ status: 404 });
        await expect(downloadBooksBillAttachment(actor, mirrors[other], originals[other])).rejects.toMatchObject({ status: 404 });
        await expect(actOnBill(actor, bills[other].id, { action: "payment", version: bills[other].version, amount: "1.00", reference: "FORBIDDEN" })).rejects.toMatchObject({ status: 404 });
        await expect(updateBill(actor, bills[other].id, { ...input(other), version: bills[other].version })).rejects.toMatchObject({ status: 404 });
        await expect(queueBill(actor, bills[other].id, "ZOHO", organizationId)).rejects.toMatchObject({ status: 404 });
        await expect(scheduleIntegrationJob(actor, operations[other], { action: "retry" })).rejects.toMatchObject({ status: 404 });
      }
      await expect(getBooksBill(actor, importedOnly)).rejects.toMatchObject({ status: 404 });
      await expect(getBooksBill(actor, wrongEnvironment)).rejects.toMatchObject({ status: 404 });
      await expect(downloadBooksBillAttachment(actor, importedOnly, unownedOriginal)).rejects.toMatchObject({ status: 404 });
    }
    expect(await db.payment.count({ where: { billId: { in: bills.map(bill => bill.id) } } })).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps Management and Data Entry ownership narrow while preserving their action capabilities", async () => {
    expect((await listBills(manager, new URLSearchParams({ companyId }))).bills.map(row => row.id)).toEqual([bills[3].id]);
    expect((await getJob(manager, jobId)).booksBills.map(row => row.id)).toEqual([mirrors[3]]);
    expect((await listIntegrationJobs(manager)).jobs.map(row => row.id)).toEqual([operations[3]]);
    const overview = await dashboard(manager, new URLSearchParams({ companyId, currency: "AED" }));
    expect(overview.scope).toBe("YOUR_BILLS"); expect(overview.metrics.recognizedExpenses).toBe("44.00");
    const report = await expenseReport(manager, new URLSearchParams({ companyId, currency: "AED" }));
    expect(report.rows.map(row => row.id)).toEqual([bills[3].id]); expect(report.totals.recognized).toBe("44.00");
    const exported = exportExpenseReport(report);
    expect(exported).toContain(bills[3].invoiceNumber); expect(exported).not.toContain(bills[0].invoiceNumber);
    expect((await operationSummary(manager)).syncFailures).toBe(0);
    await expect(actOnBill(manager, bills[3].id, { action: "payment", version: bills[3].version, amount: "1", reference: "READ-ONLY" })).rejects.toMatchObject({ status: 403 });
    expect((await listBills(entry, new URLSearchParams({ companyId }))).bills.map(row => row.id)).toEqual([bills[4].id]);
    expect((await getJob(entry, jobId)).bills.map(row => row.id)).toEqual([bills[4].id]);
    expect((await getJob(entry, jobId)).booksBills).toEqual([]);
    await expect(getBill(manager, bills[0].id)).rejects.toMatchObject({ status: 404 });
    await expect(getBill(entry, bills[0].id)).rejects.toMatchObject({ status: 404 });
  });
  it("retains Admin all-creator company access, exact original creator metadata and originals", async () => {
    const all = await listBills(admin, new URLSearchParams({ companyId, jobId }));
    expect(all.bills).toHaveLength(5);
    for (const [index, bill] of bills.entries()) {
      expect(all.bills.find(row => row.id === bill.id)?.createdBy.id).toBe([...writers, manager, entry][index].id);
      expect((await downloadBooksBillAttachment(admin, mirrors[index], originals[index])).bytes).toEqual(pdf);
    }
    expect((await getJob(admin, jobId)).bills).toHaveLength(5);
    expect((await listBooksBills(admin, { companyId })).total).toBe(7);
    expect((await getBooksBill(admin, importedOnly)).id).toBe(importedOnly);
    expect((await listIntegrationJobs(admin)).jobs.filter(row => operations.includes(row.id))).toHaveLength(5);
    expect(await ownedBooksBillIds(admin, companyId)).toBeNull();
  });
  it("preserves an Accounts user's own payment capability without changing ownership or another user's balance", async () => {
    const current = await getBill(writers[0], bills[0].id);
    const paid = await actOnBill(writers[0], current.id, { action: "payment", version: current.version, amount: "1.00", reference: `OWN-PAYMENT-${tag}` });
    expect(paid.createdBy.id).toBe(writers[0].id); expect(paid.paidAmount).toBe("1.00"); expect(paid.paymentStatus).toBe("PARTIALLY_PAID");
    expect((await getBill(writers[1], bills[1].id)).paidAmount).toBe("0.00");
    await expect(getBill(writers[1], current.id)).rejects.toMatchObject({ status: 404 });
  });
});
