import Decimal from "decimal.js";
import { z } from "zod";

const text = (length: number) => z.string().max(length).nullable();
const printedNumber = text(40);
/** Evidence only: no local IDs, ledger choices, payment state, or write instructions. */
export const invoiceEvidenceSchema = z.strictObject({
  documentType: z.enum(["invoice", "receipt", "credit_note", "other"]),
  invoiceCount: z.number().int().min(0).max(100),
  vendorName: text(250),
  vendorTrn: text(40),
  invoiceNumber: text(120),
  invoiceDate: text(30),
  dueDate: text(30),
  orderNumber: text(120),
  currency: text(10),
  jobNumber: text(120),
  description: text(1000),
  subtotal: printedNumber,
  discount: printedNumber,
  vatAmount: printedNumber,
  vatRate: printedNumber,
  total: printedNumber,
  taxInclusive: z.boolean().nullable(),
  lines: z.array(z.strictObject({
    description: text(500),
    quantity: printedNumber,
    unitPrice: printedNumber,
    amount: printedNumber,
    taxAmount: printedNumber,
    taxRate: printedNumber,
  })).max(100),
  warnings: z.array(z.string().max(250)).max(12),
});

export type InvoiceEvidence = z.infer<typeof invoiceEvidenceSchema>;
export interface InvoiceAutofillExtraction {
  fields: {
    invoiceNumber?: string;
    invoiceDate?: string;
    dueDate?: string;
    orderNumber?: string;
    description?: string;
    discount?: string;
    vatRate?: string;
    lines?: { description: string; quantity: string; unitPrice: string }[];
  };
  evidence: {
    vendorName: string | null;
    vendorTrn: string | null;
    currency: string | null;
    jobNumber: string | null;
    subtotal: string | null;
    discount: string | null;
    vatAmount: string | null;
    vatRate: string | null;
    total: string | null;
  };
  warnings: string[];
  requiresHumanReview: true;
}

const clean = (value: string | null) => value?.replace(/[\u0000-\u001f\u007f]/g, " ").trim() || null;
function number(value: string | null, places = 2, digits = 12): string | null {
  const candidate = clean(value);
  return candidate && new RegExp(`^\\d{1,${digits}}(?:\\.\\d{1,${places}})?$`).test(candidate) ? candidate : null;
}
function date(value: string | null): string | undefined {
  const candidate = clean(value);
  if (!candidate || !/^\d{4}-\d{2}-\d{2}$/.test(candidate) || candidate < "1900-01-01" || candidate > "2199-12-31") return;
  const parsed = new Date(`${candidate}T00:00:00Z`);
  if (Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate) return candidate;
}
function printedRate(value: string | null): string | null {
  // A visibly printed percent sign is formatting, not an inferred tax rate.
  const rate = number(clean(value)?.replace(/\s*%$/, "") ?? null, 2, 3);
  return rate !== null && new Decimal(rate).lte(100) ? rate : null;
}
function close(a: Decimal.Value, b: Decimal.Value) {
  return new Decimal(a).minus(b).abs().lte("0.02");
}

/** Validate printed evidence without deriving a tax rate or inventing missing amounts. */
export function normalizeInvoiceEvidence(raw: InvoiceEvidence): InvoiceAutofillExtraction {
  if (!["invoice", "receipt"].includes(raw.documentType) || raw.invoiceCount !== 1)
    throw new Error("Attach pages of one invoice or receipt at a time.");
  const fields: InvoiceAutofillExtraction["fields"] = {};
  const warnings = raw.warnings.map(clean).filter((value): value is string => Boolean(value));
  for (const key of ["invoiceNumber", "orderNumber", "description"] as const) {
    const value = clean(raw[key]);
    if (value) fields[key] = value;
  }
  for (const key of ["invoiceDate", "dueDate"] as const) {
    const value = date(raw[key]);
    if (value) fields[key] = value;
    else if (raw[key]) warnings.push(`Check the ${key === "invoiceDate" ? "invoice" : "due"} date against the original.`);
  }
  if (fields.invoiceDate && fields.dueDate && fields.dueDate < fields.invoiceDate) {
    delete fields.dueDate;
    warnings.push("The printed dates conflict. Select the correct due date.");
  }
  const evidence: InvoiceAutofillExtraction["evidence"] = {
    vendorName: clean(raw.vendorName), vendorTrn: clean(raw.vendorTrn),
    currency: clean(raw.currency)?.toUpperCase() ?? null, jobNumber: clean(raw.jobNumber),
    subtotal: number(raw.subtotal), discount: number(raw.discount),
    vatAmount: number(raw.vatAmount), vatRate: printedRate(raw.vatRate), total: number(raw.total),
  };
  if (evidence.vatRate && new Decimal(evidence.vatRate).gt(100)) evidence.vatRate = null;
  if (evidence.discount !== null) fields.discount = evidence.discount;
  if (evidence.vatRate !== null) fields.vatRate = evidence.vatRate;
  else warnings.push("VAT rate was not clearly printed. Choose the correct tax from the original invoice; it has not been inferred from the total.");

  let validLines = raw.lines.length > 0;
  const rates = new Set(raw.lines.map(line => printedRate(line.taxRate)).filter(value => value !== null).map(value => new Decimal(value!).toString()));
  if (rates.size > 1 || (evidence.vatRate !== null && [...rates].some(rate => !new Decimal(rate).eq(evidence.vatRate!)))) {
    validLines = false;
    delete fields.vatRate;
    warnings.push("Different tax rates are printed. Enter the lines and choose each Books tax manually.");
  }
  const lines = raw.lines.map(line => {
    const description = clean(line.description);
    const quantity = number(line.quantity, 3, 8);
    const unitPrice = number(line.unitPrice);
    const printedAmount = number(line.amount);
    if (!description || quantity === null || unitPrice === null || new Decimal(quantity).lte(0)) {
      validLines = false;
      return null;
    }
    const calculated = new Decimal(quantity).times(unitPrice).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    if (calculated.gt("999999999999.99") || (printedAmount !== null && !close(calculated, printedAmount))) validLines = false;
    const taxAmount = number(line.taxAmount), taxRate = printedRate(line.taxRate);
    if (taxAmount !== null && taxRate !== null && !close(calculated.times(taxRate).div(100), taxAmount)) validLines = false;
    return { description, quantity, unitPrice };
  }).filter((line): line is NonNullable<typeof line> => line !== null);
  const subtotal = lines.reduce((sum, line) => sum.plus(new Decimal(line.quantity).times(line.unitPrice).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)), new Decimal(0));
  if (subtotal.gt("999999999999.99") || (evidence.subtotal !== null && !close(subtotal, evidence.subtotal))) validLines = false;
  if (evidence.discount !== null && new Decimal(evidence.discount).gt(subtotal)) validLines = false;
  const extractedNet = subtotal.minus(evidence.discount ?? "0");
  if ((evidence.vatAmount !== null && evidence.vatRate !== null && !close(extractedNet.times(evidence.vatRate).div(100), evidence.vatAmount)) ||
      (evidence.total !== null && evidence.vatAmount !== null && !close(extractedNet.plus(evidence.vatAmount), evidence.total)) ||
      (evidence.total !== null && evidence.vatRate !== null && !close(extractedNet.plus(extractedNet.times(evidence.vatRate).div(100)), evidence.total))) {
    validLines = false;
    warnings.push("The extracted items do not match the printed VAT or total. Check the amounts manually.");
  }
  if (raw.taxInclusive === true) {
    validLines = false;
    warnings.push("Prices include tax. Enter the correct net amounts and Books tax manually before saving.");
  }
  if (evidence.subtotal !== null && evidence.vatAmount !== null && evidence.total !== null) {
    // Missing discount is not filled in; reconciliation can use zero only as a consistency check.
    const printedNet = new Decimal(evidence.subtotal).minus(evidence.discount ?? "0");
    if (!close(printedNet.plus(evidence.vatAmount), evidence.total) ||
        (evidence.vatRate !== null && !close(printedNet.times(evidence.vatRate).div(100), evidence.vatAmount))) {
      validLines = false;
      warnings.push("The printed subtotal, VAT or total do not reconcile. Check the amounts manually.");
    }
  }
  if (validLines) fields.lines = lines;
  else warnings.push("Some item details or totals need checking. Enter or correct the invoice lines manually.");
  if (!fields.invoiceNumber) warnings.push("Invoice number was not clearly read. Enter it from the original.");
  if (!fields.invoiceDate) warnings.push("Invoice date was not clearly read. Select it from the original.");
  return { fields, evidence, warnings: [...new Set(warnings)].slice(0, 20), requiresHumanReview: true };
}
