import "server-only";
import type { Prisma } from "@prisma/client";
import type { BillSnapshot } from "./books";
import { assertBooksLineTaxMode, booksSelectionFields } from "@/lib/books-selection";
import { IntegrationError } from "./config";

export const sourceInclude = {
  company: true, vendor: true, job: true,
  lines: { orderBy: { id: "asc" as const } },
  documents: { orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }] },
} satisfies Prisma.BillInclude;
export type BillSource = Prisma.BillGetPayload<{ include: typeof sourceInclude }>;

export function assertSourceBooksLineTaxMode(bill: BillSource) {
  try {
    assertBooksLineTaxMode(bill.usesBooksLineTaxes, bill.lines);
  } catch {
    throw new IntegrationError("BILL_TAX_MODE_MISMATCH", "The saved bill's tax mode does not match its line selections. Review the bill before synchronization.", "BLOCKED");
  }
}

export function approvedSnapshot(bill: BillSource, externalVendorId: string | null = null): BillSnapshot {
  assertSourceBooksLineTaxMode(bill);
  return {
    internalBillId: bill.id, companyId: bill.companyId, sourceVersion: bill.version,
    invoiceNumber: bill.invoiceNumber, invoiceDate: bill.invoiceDate.toISOString().slice(0, 10),
    dueDate: bill.dueDate?.toISOString().slice(0, 10) ?? null, orderNumber: bill.orderNumber,
    paymentTerms: bill.paymentTerms, category: bill.category, currency: bill.currency,
    discount: bill.discount.toFixed(2), vatRate: bill.vatRate.toFixed(2), subtotal: bill.subtotal.toFixed(2),
    vatAmount: bill.vatAmount.toFixed(2), total: bill.total.toFixed(2), vendorId: bill.vendorId,
    externalVendorId, jobId: bill.jobId, jobNumber: bill.job.jobNumber, externalCrmJobId: bill.job.externalCrmId,
    lines: bill.lines.map(line => ({ description: line.description, quantity: line.quantity.toString(), unitPrice: line.unitPrice.toFixed(2),
      ...booksSelectionFields(line.booksSelection) })),
    documents: bill.documents.map(document => ({ id: document.id, sha256: document.sha256, fileName: document.fileName, mimeType: document.mimeType })),
  };
}
