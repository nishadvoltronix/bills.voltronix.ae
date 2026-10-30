import Decimal from "decimal.js";

const Exact = Decimal.clone({
  precision: 120,
  rounding: Decimal.ROUND_HALF_UP,
});
export const booksRecognizedStatuses = new Set([
  "open",
  "overdue",
  "paid",
  "partially_paid",
  "unpaid",
]);
const excludedStatuses = new Set([
  "draft",
  "void",
  "cancelled",
  "canceled",
  "rejected",
  "pending_approval",
]);
export type FinancialAmounts = {
  invoicedTotal: string | null;
  recognizedExpenses: string | null;
  paidExpenses: string | null;
  outstanding: string | null;
  creditsApplied: string | null;
};
export function decimalAmount(value: unknown): Decimal | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (!/^-?\d+(?:\.\d+)?$/.test(String(value)) || String(value).length > 100)
    return null;
  try {
    const parsed = new Exact(value);
    return parsed.isFinite() ? parsed : null;
  } catch {
    return null;
  }
}
export function exactMoney(value: Decimal): string {
  return value.toFixed(Math.max(2, value.decimalPlaces()));
}
export function sumKnown(values: (string | null)[]): string | null {
  let total = new Exact(0);
  for (const value of values) {
    const parsed = decimalAmount(value);
    if (!parsed) return null;
    total = total.plus(parsed);
  }
  return exactMoney(total);
}
export function jsonRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
const empty: FinancialAmounts = {
  invoicedTotal: "0.00",
  recognizedExpenses: "0.00",
  paidExpenses: "0.00",
  outstanding: "0.00",
  creditsApplied: "0.00",
};
const unknown: FinancialAmounts = {
  invoicedTotal: null,
  recognizedExpenses: null,
  paidExpenses: null,
  outstanding: null,
  creditsApplied: null,
};

/** Provider balances, cash payments and vendor credits are separate measures.
 * VAT-exclusive cost uses the provider's discounted/adjusted total less its tax;
 * subtracting discounts again from this total would understate the expense.
 * Source contract: https://www.zoho.com/books/api/v3/bills/#get-a-bill
 */
export function booksFinancialAmounts(bill: {
  status: string;
  total: string;
  balance: string;
  taxTotal: string | null;
  paymentMade: string | null;
  vendorCreditsApplied: string | null;
  sourceDetail: unknown;
  detailImportRunId: string | null;
  lastImportRunId: string;
}) {
  const status = bill.status.toLowerCase();
  if (excludedStatuses.has(status))
    return { ...empty, recognized: false, complete: true };
  if (!booksRecognizedStatuses.has(status))
    return { ...unknown, recognized: null, complete: false };
  const source = jsonRecord(bill.sourceDetail);
  const currentDetail =
    bill.sourceDetail !== null &&
    bill.detailImportRunId === bill.lastImportRunId;
  const total = decimalAmount(bill.total);
  const balance = decimalAmount(bill.balance);
  const tax = currentDetail ? decimalAmount(bill.taxTotal) : null;
  const payment = currentDetail ? decimalAmount(bill.paymentMade) : null;
  const credits = currentDetail
    ? decimalAmount(bill.vendorCreditsApplied)
    : null;
  // These edition-specific tax treatments do not establish the ordinary VAT
  // cost equation. Keep gross/balance evidence but withhold a guessed net cost.
  const specialTax =
    source.is_reverse_charge_applied === true ||
    source.is_tds_applied === true ||
    [
      "tds_total",
      "tax_amount_withheld",
      "withholding_tax_total",
      "reverse_charge_vat_total",
      "acquisition_vat_total",
    ].some(
      (key) =>
        source[key] !== undefined &&
        decimalAmount(source[key])?.isZero() !== true,
    );
  const valid = (value: Decimal | null) =>
    value !== null && !value.isNegative();
  const cost =
    currentDetail &&
    !specialTax &&
    valid(total) &&
    valid(tax) &&
    total!.gte(tax!)
      ? total!.minus(tax!)
      : null;
  const result: FinancialAmounts = {
    invoicedTotal: valid(total) ? exactMoney(total!) : null,
    recognizedExpenses: cost ? exactMoney(cost) : null,
    paidExpenses: valid(payment) ? exactMoney(payment!) : null,
    outstanding: valid(balance) ? exactMoney(balance!) : null,
    creditsApplied: valid(credits) ? exactMoney(credits!) : null,
  };
  return {
    ...result,
    recognized: true,
    complete: Object.values(result).every((value) => value !== null),
  };
}

export function aggregateAmounts(rows: FinancialAmounts[]): FinancialAmounts {
  return Object.fromEntries(
    Object.keys(empty).map((key) => [
      key,
      sumKnown(rows.map((row) => row[key as keyof FinancialAmounts])),
    ]),
  ) as FinancialAmounts;
}
