import "server-only";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { readPrivateDocument } from "@/lib/services/documents";
import type { BillSnapshot } from "./books";
import { IntegrationError } from "./config";
import { buildInvoiceAttachment } from "./invoice-bundle";

/** A multiple-original snapshot has one attachment operation, bound to its first original. */
export async function prepareBooksAttachment(snapshot: BillSnapshot, documentId: string, store: Prisma.TransactionClient = db) {
  const expected = snapshot.documents;
  if (!expected.length || (expected.length > 1 ? expected[0].id !== documentId : !expected.some(file => file.id === documentId)))
    throw new IntegrationError("DOCUMENT_NOT_IN_SNAPSHOT", "This attachment operation does not match its original invoice files.", "BLOCKED");
  const rows = await store.document.findMany({ where: { billId: snapshot.internalBillId, id: { in: expected.map(file => file.id) } } });
  if (rows.length !== expected.length)
    throw new IntegrationError("DOCUMENT_INTEGRITY_FAILED", "An original invoice file is unavailable.", "BLOCKED");
  const files = [];
  for (const file of expected) {
    const row = rows.find(row => row.id === file.id);
    if (!row || row.sha256 !== file.sha256 || row.fileName !== file.fileName || row.mimeType !== file.mimeType)
      throw new IntegrationError("DOCUMENT_INTEGRITY_FAILED", "An original invoice file no longer matches the saved source.", "BLOCKED");
    files.push({ ...file, bytes: await readPrivateDocument(row) });
  }
  return buildInvoiceAttachment(files, false);
}
