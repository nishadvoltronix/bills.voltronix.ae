import Decimal from "decimal.js";
import { z } from "zod";
import { calculateBill, normalizeInvoiceNumber } from "@/lib/finance";
import { currencySchema, type BillInput } from "@/lib/validation";

export interface OcrEvidence {
  fields: Partial<BillInput>;
  confidence: Record<string, number>;
  warnings: string[];
  text: string;
  vendorName?: string;
  vendorTrn?: string;
  jobNumber?: string;
  subtotal?: string;
  vatAmount?: string;
  total?: string;
  // Evidence only: the bill still uses its existing single VAT rate and lines.
  // Optional so previously stored extraction JSON remains compatible.
  sourceLines?: Array<{
    amount?: string;
    taxAmount?: string;
    taxRate?: string;
    currency?: string;
  }>;
  taxDetails?: Array<{ amount?: string; rate?: string; currency?: string }>;
  providerFields: Record<string, string>;
  pageCount: number;
  requiresHumanReview: true;
}

const identity = (value?: string | null) =>
  (value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");

/** A supplied tax identity must not be silently replaced by a name-only match. */
export function matchingOcrVendors<
  T extends { id: string; name: string; trn?: string | null },
>(evidence: OcrEvidence, vendors: readonly T[]): T[] {
  const trn = identity(evidence.vendorTrn);
  const name = identity(evidence.vendorName);
  return vendors.filter((vendor) =>
    trn
      ? identity(vendor.trn) === trn
      : !!name && identity(vendor.name) === name,
  );
}

export function sameOcrInvoice(left: OcrEvidence, right: OcrEvidence): boolean {
  if (
    !left.fields.invoiceNumber ||
    !right.fields.invoiceNumber ||
    normalizeInvoiceNumber(left.fields.invoiceNumber) !==
      normalizeInvoiceNumber(right.fields.invoiceNumber)
  )
    return false;
  const leftTrn = identity(left.vendorTrn),
    rightTrn = identity(right.vendorTrn);
  if (leftTrn && rightTrn) return leftTrn === rightTrn;
  const name = identity(left.vendorName);
  return !!name && name === identity(right.vendorName);
}

export const templateMappingsSchema = z
  .object({
    invoiceNumber: z.enum(["InvoiceId", "PurchaseOrder"]).optional(),
    orderNumber: z.enum(["PurchaseOrder", "CustomerId"]).optional(),
    jobNumber: z
      .enum(["PurchaseOrder", "CustomerId", "ServiceAddressRecipient"])
      .optional(),
    category: z
      .enum(["MATERIALS", "LABOUR", "EQUIPMENT", "TRANSPORT", "OTHER"])
      .optional(),
  })
  .strict();

type UnknownRecord = Record<string, unknown>;
const record = (value: unknown): UnknownRecord =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
const text = (value: unknown, max = 1000) =>
  typeof value === "string" ? value.trim().slice(0, max) : undefined;
function fieldText(value: unknown): string | undefined {
  const field = record(value);
  return (
    text(field.valueString) ?? text(field.valueDate) ?? text(field.content)
  );
}
function number(value: unknown, places: number): string | undefined {
  const field = record(value);
  const candidate = record(field.valueCurrency).amount ?? field.valueNumber;
  if (typeof candidate !== "number" && typeof candidate !== "string")
    return undefined;
  try {
    const parsed = new Decimal(candidate);
    if (
      !parsed.isFinite() ||
      parsed.isNegative() ||
      parsed.greaterThan("999999999999.99")
    )
      return undefined;
    return parsed
      .toDecimalPlaces(places, Decimal.ROUND_HALF_UP)
      .toFixed(places);
  } catch {
    return undefined;
  }
}

function currencyCode(value: unknown): string | undefined {
  const currency = text(
    record(record(value).valueCurrency).currencyCode,
    8,
  )?.toUpperCase();
  return currency && /^[A-Z]{3}$/.test(currency) ? currency : undefined;
}

/** A printed percentage is evidence; never turn mixed rates into an average. */
function taxRate(value: unknown): string | undefined {
  const valueText = fieldText(value);
  const match = valueText?.match(/^(\d{1,3}(?:\.\d{1,4})?)\s*%?$/);
  if (!match) return undefined;
  const rate = new Decimal(match[1]);
  if (rate.greaterThan(100)) return undefined;
  return rate.toFixed(Math.max(2, rate.decimalPlaces()));
}

/** Provider evidence is always unverified. No external value authorizes a financial write. */
export function normalizeAzureInvoice(
  payload: unknown,
  maximumPages = 20,
): OcrEvidence {
  const result = record(payload);
  const documents = Array.isArray(result.documents) ? result.documents : [];
  if (documents.length !== 1)
    throw new Error(
      "Upload one invoice per file. Multiple detected invoices require separate documents.",
    );
  const source = record(record(documents[0]).fields);
  const evidence: OcrEvidence = {
    fields: { paymentTerms: "CUSTOM", discount: "0.00" },
    confidence: {},
    warnings: [],
    text: text(result.content, 100000) ?? "",
    providerFields: {},
    pageCount: Array.isArray(result.pages) ? result.pages.length : 0,
    requiresHumanReview: true,
  };
  const currencies = new Set<string>();
  const printedRates = new Set<string>();
  let invalidTaxRate = false;
  const captureCurrency = (value: unknown) => {
    const currency = currencyCode(value);
    if (currency) currencies.add(currency);
    return currency;
  };
  const captureConfidence = (target: string, value: unknown) => {
    const field = record(value);
    if (!Object.keys(field).length) return;
    const confidence = field.confidence;
    if (
      typeof confidence === "number" &&
      Number.isFinite(confidence) &&
      confidence >= 0 &&
      confidence <= 1
    )
      evidence.confidence[target] = confidence;
    else
      evidence.warnings.push(
        `Confidence unavailable: ${target}. Verify this field against the original.`,
      );
  };
  const captureTaxRate = (target: string, value: unknown) => {
    if (!Object.keys(record(value)).length) return undefined;
    captureConfidence(target, value);
    const rate = taxRate(value);
    if (rate === undefined) {
      invalidTaxRate = true;
      evidence.warnings.push(
        `Invalid or unsupported tax rate: ${target}. Read the original tax details; no rate has been assumed.`,
      );
    } else {
      printedRates.add(new Decimal(rate).toString());
      if (new Decimal(rate).decimalPlaces() > 2) {
        invalidTaxRate = true;
        evidence.warnings.push(
          `Tax rate precision exceeds the bill's two-decimal limit: ${target}. Review the accounting treatment before saving.`,
        );
      }
    }
    return rate;
  };
  for (const [key, field] of Object.entries(source).slice(0, 100)) {
    const value = fieldText(field);
    if (value) evidence.providerFields[key] = value;
  }
  const copy = (target: string, key: string) => {
    captureConfidence(target, source[key]);
    return fieldText(source[key]);
  };
  evidence.vendorName = copy("vendorName", "VendorName");
  evidence.vendorTrn = copy("vendorTrn", "VendorTaxId");
  evidence.fields.invoiceNumber = copy("invoiceNumber", "InvoiceId")?.slice(
    0,
    120,
  );
  evidence.fields.invoiceDate = copy("invoiceDate", "InvoiceDate");
  evidence.fields.dueDate = copy("dueDate", "DueDate");
  for (const name of ["invoiceDate", "dueDate"] as const) {
    const value = evidence.fields[name];
    if (value) {
      const date = new Date(`${value}T00:00:00.000Z`);
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(date.getTime()) ||
        date.toISOString().slice(0, 10) !== value ||
        value < "1900-01-01" ||
        value > "2199-12-31"
      )
        evidence.warnings.push(
          `Invalid ${name}; enter the correct calendar date from the original.`,
        );
    }
  }
  evidence.fields.orderNumber = copy("orderNumber", "PurchaseOrder")?.slice(
    0,
    120,
  );
  for (const [target, key] of [
    ["subtotal", "SubTotal"],
    ["vatAmount", "TotalTax"],
    ["total", "InvoiceTotal"],
  ] as const) {
    copy(target, key);
    evidence[target] = number(source[key], 2);
    captureCurrency(source[key]);
  }
  const currency = currencyCode(source.InvoiceTotal);
  if (currencySchema.safeParse(currency).success)
    evidence.fields.currency = currency as BillInput["currency"];
  else
    evidence.warnings.push(
      "Currency was missing or unsupported. Select the currency shown on the original invoice.",
    );
  const discount = number(source.TotalDiscount, 2);
  if (discount) {
    evidence.fields.discount = discount;
    captureConfidence("discount", source.TotalDiscount);
    captureCurrency(source.TotalDiscount);
  }
  const taxes = record(source.TaxDetails).valueArray;
  if (Array.isArray(taxes)) {
    if (taxes.length > 100)
      evidence.warnings.push(
        "The invoice has more than 100 tax details. Review the complete original tax breakdown before saving.",
      );
    evidence.taxDetails = taxes.slice(0, 100).map((item, index) => {
      const values = record(record(item).valueObject);
      captureConfidence(`taxDetails.${index}.amount`, values.Amount);
      return {
        amount: number(values.Amount, 2),
        rate: captureTaxRate(`taxDetails.${index}.rate`, values.Rate),
        currency: captureCurrency(values.Amount),
      };
    });
    if (
      evidence.taxDetails.length &&
      evidence.taxDetails.every((item) => item.amount !== undefined) &&
      evidence.vatAmount &&
      !evidence.taxDetails
        .reduce((sum, item) => sum.plus(item.amount!), new Decimal(0))
        .equals(evidence.vatAmount)
    )
      evidence.warnings.push(
        "Extracted tax-detail amounts differ from the source tax total. Verify the original breakdown.",
      );
  }
  const jobMatch = evidence.text.match(
    /\b(?:job|project)\s*(?:id|no\.?|number|#)?\s*[:#-]\s*([A-Z0-9][A-Z0-9_/-]{1,59})/i,
  );
  if (jobMatch) evidence.jobNumber = jobMatch[1];
  const items = record(source.Items).valueArray;
  if (Array.isArray(items)) {
    evidence.sourceLines = [];
    if (items.length > 100)
      evidence.warnings.push(
        "The invoice exceeds the 100-line limit. Split it through an approved accounting process before posting.",
      );
    evidence.fields.lines = items.slice(0, 100).map((item, index) => {
      const itemField = record(item);
      const values = record(itemField.valueObject);
      const amount = number(values.Amount, 2);
      const quantity = number(values.Quantity, 3);
      const unitPrice = number(values.UnitPrice, 2);
      captureCurrency(values.UnitPrice);
      captureCurrency(values.Tax);
      const lineCurrency =
        captureCurrency(values.Amount) ?? currencyCode(values.UnitPrice);
      evidence.sourceLines!.push({
        amount,
        taxAmount: number(values.Tax, 2),
        taxRate: captureTaxRate(`lines.${index}.taxRate`, values.TaxRate),
        currency: lineCurrency,
      });
      const description = fieldText(values.Description)?.slice(0, 500) ?? "";
      if (!description)
        evidence.warnings.push(
          `Line ${index + 1}: description was not extracted. Complete it during review.`,
        );
      if (!quantity || !unitPrice)
        evidence.warnings.push(
          `Line ${index + 1}: quantity or rate was not extracted. Enter the missing value from the original; a line amount is not a unit rate.`,
        );
      if (
        quantity &&
        unitPrice &&
        amount &&
        !new Decimal(quantity)
          .mul(unitPrice)
          .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
          .equals(amount)
      )
        evidence.warnings.push(
          `Line ${index + 1}: extracted amount differs from quantity multiplied by rate. Check the original line.`,
        );
      for (const [target, key] of [
        ["description", "Description"],
        ["quantity", "Quantity"],
        ["unitPrice", "UnitPrice"],
        ["amount", "Amount"],
        ["taxAmount", "Tax"],
      ]) {
        captureConfidence(`lines.${index}.${target}`, values[key]);
      }
      return {
        description,
        quantity: quantity ?? "",
        unitPrice: unitPrice ?? "",
      };
    });
  }
  const mixedRates = printedRates.size > 1;
  if (mixedRates)
    evidence.warnings.push(
      "Multiple tax rates were extracted. This bill supports one VAT rate; no averaged rate has been selected. Review the original and use an approved accounting treatment.",
    );
  if (currencies.size > 1) {
    delete evidence.fields.currency;
    evidence.warnings.push(
      "Conflicting currencies were extracted across totals or lines. Select the correct invoice currency and correct the values; no conversion has been performed.",
    );
  }
  if (!mixedRates && !invalidTaxRate && printedRates.size === 1) {
    evidence.fields.vatRate = new Decimal([...printedRates][0]).toFixed(2);
  } else if (
    !mixedRates &&
    !invalidTaxRate &&
    currencies.size <= 1 &&
    evidence.subtotal &&
    evidence.vatAmount
  ) {
    const net = new Decimal(evidence.subtotal).minus(
      evidence.fields.discount ?? 0,
    );
    if (net.greaterThan(0))
      evidence.fields.vatRate = new Decimal(evidence.vatAmount)
        .div(net)
        .mul(100)
        .toFixed(2);
  }
  if (!evidence.vendorName && !evidence.vendorTrn)
    evidence.warnings.push(
      "Missing supplier identity; select and verify the vendor from the original invoice.",
    );
  for (const name of ["invoiceNumber", "invoiceDate", "lines"] as const)
    if (
      !evidence.fields[name] ||
      (Array.isArray(evidence.fields[name]) && !evidence.fields[name].length)
    )
      evidence.warnings.push(
        `Missing ${name}; review and complete this field.`,
      );
  for (const [name, confidence] of Object.entries(evidence.confidence))
    if (confidence < 0.85)
      evidence.warnings.push(
        `Low confidence: ${name} (${Math.round(confidence * 100)}%).`,
      );
  if (!evidence.total || !evidence.subtotal || !evidence.vatAmount)
    evidence.warnings.push(
      "One or more source totals were not extracted. Verify subtotal, VAT and total manually.",
    );
  try {
    const totals = calculateBill(
      evidence.fields.lines ?? [],
      evidence.fields.discount,
      evidence.fields.vatRate ?? "0",
    );
    for (const key of ["subtotal", "vatAmount", "total"] as const)
      if (evidence[key] && !new Decimal(evidence[key]).equals(totals[key]))
        evidence.warnings.push(
          `Extracted ${key} differs from calculated VAT-exclusive lines. Correct quantities, rates, discount or tax before posting.`,
        );
  } catch {
    evidence.warnings.push(
      "Extracted lines cannot yet produce a valid bill. Correct them during review.",
    );
  }
  if (evidence.pageCount >= maximumPages)
    evidence.warnings.push(
      `OCR reached its ${maximumPages}-page limit. Check the original for further pages before creating any bill.`,
    );
  return evidence;
}

export function applyOcrTemplate(
  evidence: OcrEvidence,
  mappings: unknown,
): OcrEvidence {
  const parsed = templateMappingsSchema.parse(mappings);
  const result: OcrEvidence = structuredClone(evidence);
  for (const target of ["invoiceNumber", "orderNumber", "jobNumber"] as const) {
    const source = parsed[target];
    const value = source ? evidence.providerFields[source] : undefined;
    if (value) {
      if (target === "jobNumber") result.jobNumber = value;
      else result.fields[target] = value.slice(0, 120);
      delete result.confidence[target];
      result.warnings.push(
        `Vendor template mapped ${source} to ${target}; verify against the original.`,
      );
    }
  }
  if (parsed.category) result.fields.category = parsed.category;
  return result;
}
