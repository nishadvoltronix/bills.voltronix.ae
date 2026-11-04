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
  requiresHumanReview: false;
}

const clean = (value: string | null) => value?.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, " ").trim() || null;
function number(value: string | null, places = 2, digits = 12): string | null {
  const candidate = clean(value);
  if (!candidate || !/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(candidate)) return null;
  const plain = candidate.replaceAll(",", ""), parsed = new Decimal(plain);
  if (parsed.gte(new Decimal(10).pow(digits)) || parsed.decimalPlaces() > places) return null;
  return parsed.toFixed(Math.min(places, plain.split(".")[1]?.length ?? 0));
}
function currency(value: string | null) {
  const printed = clean(value)?.toUpperCase() ?? null;
  if (!printed) return null;
  return ["AED", "DHS", "DH", "DIRHAM", "DIRHAMS", "UAE DIRHAM", "UAE DIRHAMS"].includes(printed.replace(/\.$/, "")) ? "AED" : printed;
}
/** A missing factor is recoverable only when the printed product is represented exactly. */
function factor(amount: string, divisor: string, places: number, digits: number): string | null {
  if (new Decimal(divisor).lte(0)) return null;
  const result = new Decimal(amount).div(divisor);
  if (result.isNegative() || result.gte(new Decimal(10).pow(digits)) || result.decimalPlaces() > places || !result.times(divisor).equals(amount)) return null;
  return result.toFixed(result.decimalPlaces());
}
/** Convert a printed gross monetary amount using printed tax evidence and cent rounding. */
function netFromGross(gross: string, taxAmount: string | null, rate: string | null): string | null {
  const amount = new Decimal(gross);
  let net: Decimal;
  if (taxAmount !== null) {
    net = amount.minus(taxAmount);
    if (net.isNegative()) return null;
  } else if (rate !== null) net = amount.div(new Decimal(1).plus(new Decimal(rate).div(100))).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  else return null;
  if (rate !== null) {
    const tax = net.times(rate).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    if (!net.plus(tax).equals(amount) || taxAmount !== null && !tax.equals(taxAmount)) return null;
  }
  return net.toFixed(2);
}
function printedNetAmount(line: InvoiceEvidence["lines"][number], inclusive: boolean | null, commonRate: string | undefined) {
  const amount = number(line.amount), tax = number(line.taxAmount), ownRate = printedRate(line.taxRate), rate = ownRate ?? commonRate ?? null;
  if (amount === null) return null;
  if (inclusive === false) return amount;
  if (inclusive === true) {
    if (clean(line.taxAmount) !== null && tax === null || clean(line.taxRate) !== null && ownRate === null) return null;
    return netFromGross(amount, tax, rate);
  }
  return tax !== null && new Decimal(tax).isZero() || rate !== null && new Decimal(rate).isZero() ? amount : null;
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
    currency: currency(raw.currency), jobNumber: clean(raw.jobNumber),
    subtotal: number(raw.subtotal), discount: number(raw.discount),
    vatAmount: number(raw.vatAmount), vatRate: printedRate(raw.vatRate), total: number(raw.total),
  };
  if (evidence.discount !== null) fields.discount = evidence.discount;
  const readableLines = raw.lines.filter(line => Object.values(line).some(value => clean(value) !== null));
  const printedRates = readableLines.map(line => printedRate(line.taxRate));
  const rates = new Set(printedRates.filter(value => value !== null).map(value => new Decimal(value!).toString()));
  const mixed = rates.size > 1 || evidence.vatRate !== null && [...rates].some(rate => !new Decimal(rate).equals(evidence.vatRate!));
  if (mixed) warnings.push("Different tax rates are printed. The items were filled; choose the correct Books tax for each line.");
  else if (evidence.vatRate !== null) fields.vatRate = evidence.vatRate;
  else if (readableLines.length && printedRates.every(value => value !== null) && rates.size === 1) fields.vatRate = printedRates[0]!;
  if (fields.vatRate === undefined && !mixed)
    warnings.push("VAT rate was not clearly printed. Choose the correct tax from the original invoice; it has not been inferred from the total.");

  // The form subtracts its header discount once from pre-discount net items.
  // Discounted printed row amounts must not silently become a second discount.
  const hasDiscount = evidence.discount !== null && new Decimal(evidence.discount).gt(0);
  let derivationBasisProven = !hasDiscount;
  if (hasDiscount && evidence.subtotal !== null && evidence.vatAmount !== null && evidence.total !== null && readableLines.length) {
    const netAmounts = readableLines.map(line => printedNetAmount(line, raw.taxInclusive, fields.vatRate));
    if (netAmounts.every(value => value !== null)) {
      const netSubtotal = netAmounts.reduce((sum, value) => sum.plus(value!), new Decimal(0));
      const afterDiscount = netSubtotal.minus(evidence.discount!);
      derivationBasisProven = netSubtotal.equals(evidence.subtotal) && !afterDiscount.isNegative() &&
        afterDiscount.plus(evidence.vatAmount).equals(evidence.total) && (fields.vatRate === undefined ||
          afterDiscount.times(fields.vatRate).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).equals(evidence.vatAmount));
    }
  }
  if (!derivationBasisProven) warnings.push("The printed discount basis is unclear. Readable cells were filled, but missing quantities or net prices were not calculated.");

  let convertedInclusive = false;
  const lines = readableLines.map((line, index) => {
    const description = clean(line.description) ?? "";
    const printedQuantity = number(line.quantity, 3, 8), printedPrice = number(line.unitPrice), printedAmount = number(line.amount);
    const taxAmount = number(line.taxAmount), taxRate = printedRate(line.taxRate) ?? fields.vatRate ?? null;
    const invalidTax = clean(line.taxAmount) !== null && taxAmount === null || clean(line.taxRate) !== null && printedRate(line.taxRate) === null;
    if (invalidTax) warnings.push(`Item ${index + 1}: its printed tax amount or rate is unsupported; choose the correct tax from the invoice.`);
    let quantity = printedQuantity !== null && new Decimal(printedQuantity).gt(0) ? printedQuantity : null;
    let unitPrice = printedPrice;
    if (raw.taxInclusive === true) {
      // A printed gross unit price can first recover a missing quantity. It is
      // never placed in the form's net-price cell without a supported conversion.
      if (derivationBasisProven && quantity === null && clean(line.quantity) === null && printedAmount !== null && printedPrice !== null)
        quantity = factor(printedAmount, printedPrice, 3, 8);
      if (quantity !== null && new Decimal(quantity).lte(0)) quantity = null;
      const gross = printedPrice !== null && quantity !== null
        ? new Decimal(printedPrice).times(quantity).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2) : printedAmount;
      const net = gross !== null ? netFromGross(gross, taxAmount, taxRate) : null;
      if (gross !== null && printedAmount !== null && !close(gross, printedAmount))
        warnings.push(`Item ${index + 1}: its printed quantity and gross unit price do not match the printed amount. The independent values were kept.`);
      unitPrice = !derivationBasisProven || invalidTax ? null : quantity !== null ? net !== null ? factor(net, quantity, 2, 12) : null :
        printedPrice !== null && taxRate !== null ? netFromGross(printedPrice, null, taxRate) : null;
      if (unitPrice !== null) convertedInclusive = true;
      else warnings.push(`Item ${index + 1}: the printed price includes tax; enter its net unit price${printedAmount !== null ? ` (printed line amount ${printedAmount})` : ""}.`);
    } else {
      const netAmount = printedNetAmount(line, raw.taxInclusive, fields.vatRate);
      if (derivationBasisProven && quantity === null && clean(line.quantity) === null && unitPrice !== null && netAmount !== null)
        quantity = factor(netAmount, unitPrice, 3, 8);
      if (quantity !== null && new Decimal(quantity).lte(0)) quantity = null;
      if (derivationBasisProven && unitPrice === null && clean(line.unitPrice) === null && quantity !== null && netAmount !== null)
        unitPrice = factor(netAmount, quantity, 2, 12);
    }
    if (!description) warnings.push(`Item ${index + 1}: add the unreadable description.`);
    if (quantity === null) warnings.push(`Item ${index + 1}: fill the unreadable quantity${printedAmount !== null ? ` (printed line amount ${printedAmount})` : ""}.`);
    if (unitPrice === null && raw.taxInclusive !== true) warnings.push(`Item ${index + 1}: fill the unreadable unit price${printedAmount !== null ? ` (printed line amount ${printedAmount})` : ""}.`);
    if (quantity !== null && unitPrice !== null) {
      const calculated = new Decimal(quantity).times(unitPrice).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      const expectedAmount = raw.taxInclusive === true && printedAmount !== null ? netFromGross(printedAmount, taxAmount, taxRate) : printedAmount;
      if (calculated.gt("999999999999.99") || expectedAmount !== null && !close(calculated, expectedAmount) ||
        taxAmount !== null && taxRate !== null && !close(calculated.times(taxRate).div(100), taxAmount))
        warnings.push(`Item ${index + 1}: its readable quantity, price or tax does not match the printed line amount. The values were kept.`);
    }
    return { description, quantity: quantity ?? "", unitPrice: unitPrice ?? "" };
  });
  if (convertedInclusive) warnings.push("Tax-inclusive prices were converted to net amounts using printed tax.");
  if (lines.length) fields.lines = lines;
  else warnings.push("No item details could be read. Enter the invoice lines below.");
  if (lines.length && lines.every(line => line.quantity && line.unitPrice)) {
    const subtotal = lines.reduce((sum, line) => sum.plus(new Decimal(line.quantity).times(line.unitPrice).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)), new Decimal(0));
    const extractedNet = subtotal.minus(evidence.discount ?? "0"), rate = fields.vatRate;
    if (subtotal.gt("999999999999.99") || evidence.subtotal !== null && !close(subtotal, evidence.subtotal) ||
      evidence.discount !== null && new Decimal(evidence.discount).gt(subtotal) ||
      evidence.vatAmount !== null && rate !== undefined && !close(extractedNet.times(rate).div(100), evidence.vatAmount) ||
      evidence.total !== null && evidence.vatAmount !== null && !close(extractedNet.plus(evidence.vatAmount), evidence.total) ||
      evidence.total !== null && rate !== undefined && !close(extractedNet.plus(extractedNet.times(rate).div(100)), evidence.total))
      warnings.push("The readable items do not match the printed subtotal, VAT or total. The items were filled without changing their values.");
  }
  if (evidence.subtotal !== null && evidence.vatAmount !== null && evidence.total !== null) {
    // Missing discount is not filled in; reconciliation can use zero only as a consistency check.
    const printedNet = new Decimal(evidence.subtotal).minus(evidence.discount ?? "0");
    if (!close(printedNet.plus(evidence.vatAmount), evidence.total) ||
        (evidence.vatRate !== null && !close(printedNet.times(evidence.vatRate).div(100), evidence.vatAmount))) {
      warnings.push("The printed subtotal, VAT or total do not reconcile. Check the amounts manually.");
    }
  }
  if (!fields.invoiceNumber) warnings.push("Invoice number was not clearly read. Enter it from the original.");
  if (!fields.invoiceDate) warnings.push("Invoice date was not clearly read. Select it from the original.");
  return { fields, evidence, warnings: [...new Set(warnings)].slice(0, 20), requiresHumanReview: false };
}
