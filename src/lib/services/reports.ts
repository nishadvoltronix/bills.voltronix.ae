import "server-only";
import Decimal from "decimal.js";
import type { Prisma } from "@prisma/client";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { companyFilter } from "@/lib/company";
import { HttpError } from "@/lib/http";
import { csv, parseReportFilters } from "@/lib/reports";
import { getPaymentStatus, isRecognizedBillStatus } from "@/lib/finance";
import { countOcrDuplicateWarnings } from "@/lib/services/ocr";

export async function expenseReport(actor: Actor, params: URLSearchParams) {
  if (actor.role === "DATA_ENTRY")
    throw new HttpError(
      403,
      "Management reports are restricted to finance and management roles.",
    );
  const filters = parseReportFilters(params);
  const { from, to, ...conditions } = filters;
  const where: Prisma.BillWhereInput = {
    ...conditions,
    ...(await companyFilter(actor, params.get("companyId") || undefined)),
  };
  if (from || to)
    where.invoiceDate = {
      ...(from ? { gte: new Date(`${from}T00:00:00.000Z`) } : {}),
      ...(to ? { lte: new Date(`${to}T00:00:00.000Z`) } : {}),
    };
  const records = await db.bill.findMany({
    where,
    include: { vendor: true, job: true },
    orderBy: [{ invoiceDate: "desc" }, { id: "asc" }],
    take: 10001,
  });
  if (records.length > 10000)
    throw new HttpError(
      422,
      "This report exceeds 10,000 bills. Narrow the date range or filters.",
    );
  let invoiced = new Decimal(0),
    recognized = new Decimal(0),
    paid = new Decimal(0),
    outstanding = new Decimal(0);
  const monthly = new Map<string, Decimal>(),
    vendors = new Map<string, { name: string; amount: Decimal }>();
  for (const bill of records) {
    invoiced = invoiced.plus(bill.total.toString());
    if (!isRecognizedBillStatus(bill.status)) continue;
    const cost = new Decimal(bill.subtotal.toString()).minus(
      bill.discount.toString(),
    );
    recognized = recognized.plus(cost);
    paid = paid.plus(bill.paidAmount.toString());
    outstanding = outstanding.plus(
      new Decimal(bill.total.toString()).minus(bill.paidAmount.toString()),
    );
    const month = bill.invoiceDate.toISOString().slice(0, 7);
    monthly.set(month, (monthly.get(month) ?? new Decimal(0)).plus(cost));
    const vendor = vendors.get(bill.vendorId) ?? {
      name: bill.vendor.name,
      amount: new Decimal(0),
    };
    vendor.amount = vendor.amount.plus(cost);
    vendors.set(bill.vendorId, vendor);
  }
  const rows = records.map((b) => ({
    id: b.id,
    invoiceNumber: b.invoiceNumber,
    invoiceDate: b.invoiceDate.toISOString().slice(0, 10),
    vendor: b.vendor.name,
    jobNumber: b.job.jobNumber,
    category: b.category,
    currency: b.currency,
    status: b.status,
    paymentStatus: getPaymentStatus(
      b.total.toString(),
      b.paidAmount.toString(),
    ),
    net: new Decimal(b.subtotal.toString())
      .minus(b.discount.toString())
      .toFixed(2),
    vat: b.vatAmount.toFixed(2),
    total: b.total.toFixed(2),
    paid: isRecognizedBillStatus(b.status) ? b.paidAmount.toFixed(2) : "0.00",
    recognized:
      isRecognizedBillStatus(b.status)
        ? new Decimal(b.subtotal.toString())
            .minus(b.discount.toString())
            .toFixed(2)
        : "0.00",
    outstanding:
      isRecognizedBillStatus(b.status)
        ? new Decimal(b.total.toString())
            .minus(b.paidAmount.toString())
            .toFixed(2)
        : "0.00",
  }));
  return {
    filters,
    count: rows.length,
    totals: {
      invoiced: invoiced.toFixed(2),
      recognized: recognized.toFixed(2),
      paid: paid.toFixed(2),
      outstanding: outstanding.toFixed(2),
    },
    monthly: [...monthly]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, amount]) => ({ month, amount: amount.toFixed(2) })),
    vendors: [...vendors]
      .sort(([, a], [, b]) => b.amount.comparedTo(a.amount))
      .map(([id, v]) => ({ id, name: v.name, amount: v.amount.toFixed(2) })),
    rows,
  };
}
export function exportExpenseReport(
  report: Awaited<ReturnType<typeof expenseReport>>,
) {
  return csv([
    [
      "Invoice",
      "Date",
      "Vendor",
      "Job ID",
      "Category",
      "Currency",
      "Approval status",
      "Payment status",
      "Net excluding VAT",
      "VAT",
      "Invoice total including VAT",
      "Recognized cost excluding VAT",
      "Paid including VAT",
      "Outstanding including VAT",
    ],
    ...report.rows.map((row) => [
      row.invoiceNumber,
      row.invoiceDate,
      row.vendor,
      row.jobNumber,
      row.category,
      row.currency,
      row.status,
      row.paymentStatus,
      row.net,
      row.vat,
      row.total,
      row.recognized,
      row.paid,
      row.outstanding,
    ]),
  ]);
}

export async function operationSummary(actor: Actor) {
  const createdBy = {
    ...(await companyFilter(actor)),
    ...(actor.role === "DATA_ENTRY" ? { createdById: actor.id } : {}),
  };
  const ocrScope = { batch: createdBy };
  const [review, failed, queued, syncFailures, syncUnknown, duplicates] =
    await Promise.all([
      db.ocrDocument.count({
        where: { ...ocrScope, status: "REVIEW_REQUIRED" },
      }),
      db.ocrDocument.count({ where: { ...ocrScope, status: "FAILED" } }),
      db.ocrDocument.count({
        where: { ...ocrScope, status: { in: ["QUEUED", "PROCESSING"] } },
      }),
      db.syncRecord.count({ where: { status: "FAILED", bill: createdBy } }),
      db.syncRecord.count({ where: { status: "UNKNOWN", bill: createdBy } }),
      countOcrDuplicateWarnings(actor),
    ]);
  return {
    ocrReview: review,
    ocrFailed: failed,
    ocrQueued: queued,
    syncFailures,
    syncUnknown,
    duplicateWarnings: duplicates.count,
    duplicateScanTruncated: duplicates.truncated,
    scope: actor.role === "DATA_ENTRY" ? "YOUR_DOCUMENTS" : "ORGANIZATION",
  };
}
