import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { beginBooksBillImport, finishBooksBillImport, getBooksBill, importBooksBillDetail, importBooksBillSummaryPage } from "@/lib/services/books-import";
import { downloadBooksBillAttachment, importBooksBillAttachment } from "@/lib/services/books-attachments";
import * as privateDocuments from "@/lib/services/documents";
import { assertMySqlTestDatabase } from "./company-fixtures";

const tag = randomUUID().slice(0, 8);
const organizationId = "99775566";
const otherOrganizationId = "99776677";
const companyId = `connection-check-books-${organizationId}`;
const otherCompanyId = `connection-check-books-${otherOrganizationId}`;
const pdf = Buffer.from("%PDF-1.4\nFictional original bytes\n%%EOF\n");
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);
const sourceDocuments = [
  { document_id: "7001", file_name: "../Fictional original.exe", file_type: "pdf", file_size: String(pdf.length), uploaded_on: "2026-10-01", signed_url: "https://example.invalid/private" },
  { document_id: "7002", file_name: "Fictional original.png", file_type: "png", file_size: String(png.length), uploaded_on: "2026-10-01" },
];
const summary = { bill_id: "1001", vendor_id: "2001", vendor_name: "Fictional Supplier", bill_number: "FICTIONAL-1", status: "paid", currency_code: "AED", date: "2026-10-01", total: "100.00", balance: "0.00", has_attachment: true };
const detail = { code: 0, bill: { ...summary, sub_total: "100.00", tax_total: "0.00", line_items: [], documents: sourceDocuments } };
let actor: Actor;
let reader: Actor;
let billId: string;
let otherBillId: string;
let attachmentId: string;
let nativeCounts: number[];
const input = () => ({ billId, organizationId, externalDocumentId: "7001", file: new File([pdf], "untrusted-client-name.html", { type: "application/pdf" }) });
const ledgerCounts = () => Promise.all([db.bill.count(), db.document.count(), db.payment.count(), db.integrationJob.count()]);

beforeAll(async () => {
  assertMySqlTestDatabase();
  for (const [key, value] of Object.entries({ APP_URL: "http://127.0.0.1:3000", ZOHO_BOOKS_DC: "US", ZOHO_BOOKS_ENVIRONMENT: "production", ZOHO_BOOKS_CLIENT_ID: "fictional-client", ZOHO_BOOKS_CLIENT_SECRET: "fictional-secret",
    ZOHO_BOOKS_ORGANIZATIONS_JSON: JSON.stringify([{ organizationId, name: "Fictional Company" }, { organizationId: otherOrganizationId, name: "Fictional Other" }]),
    INTEGRATION_NETWORK_ENABLED: "false", ZOHO_BOOKS_NETWORK_ENABLED: "false", ZOHO_BOOKS_WRITE_ENABLED: "false", ZOHO_BOOKS_LIVE_ENABLED: "false", ALLOW_PRODUCTION_ACCOUNTING_WRITES: "false", INTEGRATION_TEST_MODE: "false" })) vi.stubEnv(key, value);
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("No provider transport permitted"); }));
  actor = await db.user.create({ data: { email: `books-files-admin-${tag}@example.invalid`, name: "Fictional admin", role: "ADMIN", passwordHash: "fixture-unusable" } });
  reader = await db.user.create({ data: { email: `books-files-reader-${tag}@example.invalid`, name: "Fictional reader", role: "ACCOUNTS", passwordHash: "fixture-unusable" } });
  for (const [company, org] of [[companyId, organizationId], [otherCompanyId, otherOrganizationId]]) {
    await db.company.create({ data: { id: company, name: `[CONNECTION CHECK] Fictional ${org}`, isDemo: true, liveAccountingEnabled: false,
      memberships: { create: [{ userId: actor.id }, ...(company === companyId ? [{ userId: reader.id }] : [])] },
      integrationDestinations: { create: { target: "ZOHO", organizationId: org, dataCenter: "US", environment: "production", liveEnabled: false } } } });
    const run = await beginBooksBillImport(actor, { companyId: company, organizationId: org, organizationName: "Fictional Company" });
    await importBooksBillSummaryPage(actor, run.id, { page: 1, response: { code: 0, bills: [summary], page_context: { page: 1, has_more_page: false } } });
    await importBooksBillDetail(actor, run.id, { externalBillId: "1001", response: detail });
    await finishBooksBillImport(actor, run.id);
    const bill = await db.booksBill.findFirstOrThrow({ where: { companyId: company } });
    if (company === companyId) billId = bill.id;
    else otherBillId = bill.id;
  }
  nativeCounts = await ledgerCounts();
});
afterAll(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); await db.$disconnect(); });

describe("private original Books attachments on disposable MySQL", () => {
  it("rejects incorrect source IDs, organizations, byte lengths and file content before storing", async () => {
    await expect(importBooksBillAttachment(reader, input())).rejects.toMatchObject({ status: 403 });
    await expect(importBooksBillAttachment(actor, { ...input(), organizationId: otherOrganizationId })).rejects.toThrow();
    await expect(importBooksBillAttachment(actor, { ...input(), externalDocumentId: "9999" })).rejects.toMatchObject({ status: 409 });
    await expect(importBooksBillAttachment(actor, { ...input(), file: new File([pdf.subarray(1)], "short.pdf") })).rejects.toMatchObject({ status: 409 });
    await expect(importBooksBillAttachment(actor, { ...input(), file: new File([Buffer.alloc(pdf.length)], "bad.pdf") })).rejects.toMatchObject({ status: 415 });
    await expect(importBooksBillAttachment(actor, { ...input(), file: new File([pdf], "bad.pdf", { type: "text/html" }) })).rejects.toMatchObject({ status: 415 });
    expect(await db.booksBillAttachment.count({ where: { billId } })).toBe(0);
  });

  it("preserves exact original bytes, sanitizes the filename and records partial coverage without a financial write", async () => {
    const imported = await importBooksBillAttachment(actor, input());
    attachmentId = imported.id;
    expect(imported).toMatchObject({ fileName: "Fictional original.pdf", byteSize: pdf.length, sha256: createHash("sha256").update(pdf).digest("hex"), alreadyImported: false });
    const downloaded = await downloadBooksBillAttachment(reader, billId, attachmentId);
    expect(downloaded.bytes).toEqual(pdf);
    expect(downloaded.mimeType).toBe("application/pdf");
    const result = await getBooksBill(reader, billId);
    expect(result).toMatchObject({ attachmentCount: 2, downloadedAttachmentCount: 1, attachmentsDownloaded: false, attachmentStatus: "PARTIAL",
      documents: [{ id: "7001", downloaded: true, attachmentId }, { id: "7002", downloaded: false, attachmentId: null }] });
    expect(JSON.stringify(result)).not.toMatch(/signed_url|storageKey|sourceMetadata|example\.invalid/);
    expect(await ledgerCounts()).toEqual(nativeCounts);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retries completed files idempotently and completes mixed PDF/image coverage", async () => {
    const before = await db.auditLog.count({ where: { entityId: billId, action: "BOOKS_ATTACHMENT_IMPORTED" } });
    expect(await importBooksBillAttachment(actor, input())).toMatchObject({ id: attachmentId, alreadyImported: true });
    expect(await db.auditLog.count({ where: { entityId: billId, action: "BOOKS_ATTACHMENT_IMPORTED" } })).toBe(before);
    await importBooksBillAttachment(actor, { ...input(), externalDocumentId: "7002", file: new File([png], "original.png", { type: "image/png" }) });
    expect(await getBooksBill(reader, billId)).toMatchObject({ attachmentCount: 2, downloadedAttachmentCount: 2, attachmentsDownloaded: true, attachmentStatus: "COMPLETE" });
  });

  it("isolates the same source IDs in another company and prevents raw scope mismatches", async () => {
    const other = await importBooksBillAttachment(actor, { ...input(), billId: otherBillId, organizationId: otherOrganizationId });
    expect(other.id).not.toBe(attachmentId);
    await expect(downloadBooksBillAttachment(reader, otherBillId, other.id)).rejects.toMatchObject({ status: 404 });
    await expect(downloadBooksBillAttachment(actor, billId, other.id)).rejects.toMatchObject({ status: 404 });
    const stored = await db.booksBillAttachment.findUniqueOrThrow({ where: { id: attachmentId } });
    await expect(db.booksBillAttachment.create({ data: { ...stored, sourceMetadata: sourceDocuments[0], id: `invalid-${tag}`, storageKey: `invalid-${tag}.pdf`, externalDocumentId: "9999", companyId: otherCompanyId } })).rejects.toThrow();
  });

  it("rechecks current database roles and membership on every file request", async () => {
    await expect(downloadBooksBillAttachment({ ...reader, role: "DATA_ENTRY" }, billId, attachmentId)).rejects.toMatchObject({ status: 403 });
    await db.user.update({ where: { id: reader.id }, data: { role: "DATA_ENTRY" } });
    await expect(downloadBooksBillAttachment(reader, billId, attachmentId)).rejects.toMatchObject({ status: 403 });
    await db.user.update({ where: { id: reader.id }, data: { role: "ACCOUNTS" } });
    await db.userCompanyMembership.update({ where: { userId_companyId: { userId: reader.id, companyId } }, data: { active: false } });
    await expect(downloadBooksBillAttachment(reader, billId, attachmentId)).rejects.toMatchObject({ status: 404 });
    await db.userCompanyMembership.update({ where: { userId_companyId: { userId: reader.id, companyId } }, data: { active: true } });
  });

  it("does not release bytes when company access is revoked while the file is being read", async () => {
    const original = privateDocuments.readPrivateDocument;
    const spy = vi.spyOn(privateDocuments, "readPrivateDocument").mockImplementationOnce(async (metadata) => {
      const bytes = await original(metadata);
      await db.userCompanyMembership.update({ where: { userId_companyId: { userId: reader.id, companyId } }, data: { active: false } });
      return bytes;
    });
    try { await expect(downloadBooksBillAttachment(reader, billId, attachmentId)).rejects.toMatchObject({ status: 404 }); }
    finally {
      spy.mockRestore();
      await db.userCompanyMembership.update({ where: { userId_companyId: { userId: reader.id, companyId } }, data: { active: true } });
    }
  });

  it("detects corruption before serving and repairs only from a new matching original download", async () => {
    const stored = await db.booksBillAttachment.findUniqueOrThrow({ where: { id: attachmentId } });
    const filename = path.join(process.env.UPLOAD_DIR!, stored.storageKey);
    const original = await readFile(filename);
    const corrupt = Buffer.from(original);
    corrupt[15] ^= 1;
    await writeFile(filename, corrupt);
    await expect(downloadBooksBillAttachment(reader, billId, attachmentId)).rejects.toMatchObject({ status: 409 });
    expect(await importBooksBillAttachment(actor, input())).toMatchObject({ id: attachmentId, alreadyImported: false });
    const repaired = await db.booksBillAttachment.findUniqueOrThrow({ where: { id: attachmentId } });
    expect(repaired.storageKey).not.toBe(stored.storageKey);
    expect((await downloadBooksBillAttachment(reader, billId, attachmentId)).bytes).toEqual(pdf);
    expect(await readFile(filename)).toEqual(corrupt); // Committed evidence is not silently deleted.
  });

  it("hides old copies when current source metadata changes or a new listing awaits detail", async () => {
    await db.booksBill.update({ where: { id: billId }, data: { sourceDetail: { ...detail.bill, documents: [{ ...sourceDocuments[0], uploaded_on: "2026-10-02" }, sourceDocuments[1]] } } });
    await expect(downloadBooksBillAttachment(reader, billId, attachmentId)).rejects.toMatchObject({ status: 409 });
    expect(await getBooksBill(reader, billId)).toMatchObject({ downloadedAttachmentCount: 1, attachmentStatus: "PARTIAL", documents: [{ attachmentId: null }, { downloaded: true }] });
    await db.booksBill.update({ where: { id: billId }, data: { sourceDetail: detail.bill } });
    const run = await beginBooksBillImport(actor, { companyId, organizationId, organizationName: "Fictional Company" });
    await importBooksBillSummaryPage(actor, run.id, { page: 1, response: { code: 0, bills: [summary], page_context: { page: 1, has_more_page: false } } });
    await expect(downloadBooksBillAttachment(reader, billId, attachmentId)).rejects.toMatchObject({ status: 409 });
    await expect(importBooksBillAttachment(actor, input())).rejects.toMatchObject({ status: 409 });
    expect(await getBooksBill(reader, billId)).toMatchObject({ documents: [], attachmentStatus: "PENDING", attachmentsDownloaded: false });
    expect(await ledgerCounts()).toEqual(nativeCounts);
    expect(fetch).not.toHaveBeenCalled();
  });
});
