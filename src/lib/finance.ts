import Decimal from "decimal.js";
import { booksSelectionDestination, booksSelectionFields, type BooksSelection } from "./books-selection";

// Use one rounding policy everywhere, including browser previews and server writes.
const Money = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type DecimalInput = string | number | { toString(): string };
export type PaymentStatus = "UNPAID" | "PARTIALLY_PAID" | "PAID";
export type BudgetStatus =
  "VALUE_UNAVAILABLE" | "WITHIN_BUDGET" | "NEAR_LIMIT" | "OVER_BUDGET";
const MAX_AMOUNT = new Money("999999999999.99");

function decimal(value: DecimalInput, label: string): Decimal {
  let result: Decimal;
  try {
    result = new Money(typeof value === "object" ? value.toString() : value);
  } catch {
    throw new Error(`${label} must be a valid decimal.`);
  }
  if (!result.isFinite()) throw new Error(`${label} must be finite.`);
  return result;
}

function nonnegative(value: DecimalInput, label: string): Decimal {
  const result = decimal(value, label);
  if (result.isNegative()) throw new Error(`${label} cannot be negative.`);
  if (result.greaterThan(MAX_AMOUNT))
    throw new Error(`${label} exceeds the supported limit.`);
  return result;
}

function amount(value: Decimal): string {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

export interface CalculationLineInput {
  description: string;
  quantity: DecimalInput;
  unitPrice: DecimalInput;
  booksSelection?: BooksSelection | null;
}

export function calculateBill(
  lines: CalculationLineInput[],
  discount: DecimalInput = "0",
  vatRate: DecimalInput = "0",
) {
  if (lines.length === 0 || lines.length > 100)
    throw new Error("A bill must have between 1 and 100 lines.");
  const selections = lines.map((line) => booksSelectionFields(line.booksSelection).booksSelection);
  const hasSelections = selections.some(Boolean);
  if (hasSelections && selections.some((selection) => !selection))
    throw new Error("Select a Books account and tax for every line, or clear all line selections to use the bill category and VAT rate.");
  if (hasSelections && new Set(selections.map((selection) => booksSelectionDestination(selection!))).size !== 1)
    throw new Error("All line selections must belong to the same Books organization and destination.");
  const calculatedLines = lines.map((line, index) => {
    const quantity = nonnegative(line.quantity, "Quantity");
    const unitPrice = nonnegative(line.unitPrice, "Unit price");
    if (quantity.isZero())
      throw new Error("Quantity must be greater than zero.");
    if (quantity.decimalPlaces() > 3)
      throw new Error("Quantity supports up to 3 decimal places.");
    if (unitPrice.decimalPlaces() > 2)
      throw new Error("Unit price supports up to 2 decimal places.");
    const lineTotal = quantity
      .times(unitPrice)
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    if (lineTotal.greaterThan(MAX_AMOUNT))
      throw new Error("Line total exceeds the supported limit.");
    return {
      description: line.description,
      quantity: quantity.toFixed(3),
      unitPrice: unitPrice.toFixed(2),
      lineTotal: amount(lineTotal),
      ...(selections[index] ? { booksSelection: selections[index] } : {}),
    };
  });
  const subtotal = calculatedLines.reduce(
    (sum, line) => sum.plus(line.lineTotal),
    new Money(0),
  );
  if (subtotal.greaterThan(MAX_AMOUNT))
    throw new Error("Subtotal exceeds the supported limit.");
  const discountValue = nonnegative(discount, "Discount");
  if (discountValue.decimalPlaces() > 2)
    throw new Error("Discount supports up to 2 decimal places.");
  if (discountValue.greaterThan(subtotal))
    throw new Error("Discount cannot exceed the subtotal.");
  if (hasSelections && !discountValue.isZero())
    throw new Error("Discounts cannot be combined with selected Books line taxes. Keep the original amounts and clear line selections or remove the discount only if the invoice has none.");
  const rate = nonnegative(vatRate, "VAT rate");
  if (rate.greaterThan(100) || rate.decimalPlaces() > 2)
    throw new Error(
      "VAT rate must be between 0 and 100 with at most 2 decimal places.",
    );
  const netAmount = subtotal.minus(discountValue);
  let vatAmount = netAmount
    .times(rate)
    .dividedBy(100)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  let headerRate = rate.toFixed(2);
  if (hasSelections) {
    const groups = new Map<string, { rate: Decimal; subtotal: Decimal }>();
    for (const line of calculatedLines) {
      const selection = line.booksSelection!;
      const groupRate = new Money(selection.taxRate);
      const key = JSON.stringify([booksSelectionDestination(selection), selection.taxId]);
      const group = groups.get(key);
      if (group && !group.rate.equals(groupRate)) throw new Error("The same Books tax ID cannot have different rates on one bill.");
      groups.set(key, { rate: groupRate, subtotal: (group?.subtotal ?? new Money(0)).plus(line.lineTotal) });
    }
    vatAmount = [...groups.values()].reduce((sum, group) => sum.plus(
      group.subtotal.times(group.rate).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)), new Money(0));
    const rates = new Set(selections.map((selection) => new Money(selection!.taxRate).toFixed(2)));
    // For mixed rates the line selections are authoritative; the legacy header is zero.
    headerRate = rates.size === 1 ? [...rates][0] : "0.00";
  }
  const total = netAmount.plus(vatAmount);
  if (total.greaterThan(MAX_AMOUNT))
    throw new Error("Total exceeds the supported limit.");
  if (total.lessThanOrEqualTo(0))
    throw new Error("Bill total must be greater than zero.");
  return {
    subtotal: amount(subtotal),
    discount: amount(discountValue),
    vatRate: headerRate,
    vatAmount: amount(vatAmount),
    total: amount(total),
    netAmount: amount(netAmount),
    lines: calculatedLines,
  };
}

export function getPaymentStatus(
  total: DecimalInput,
  paidAmount: DecimalInput,
): PaymentStatus {
  const totalValue = nonnegative(total, "Total");
  const paid = nonnegative(paidAmount, "Paid amount");
  if (paid.greaterThan(totalValue))
    throw new Error("Paid amount cannot exceed the total.");
  if (paid.isZero()) return "UNPAID";
  return paid.equals(totalValue) ? "PAID" : "PARTIALLY_PAID";
}

export interface JobForSummary {
  contractValue: DecimalInput | null;
  approvedVariations: DecimalInput;
  currency: string;
}

export interface BillForSummary {
  id?: string;
  status: string;
  currency: string;
  subtotal: DecimalInput;
  discount: DecimalInput;
  total: DecimalInput;
  paidAmount: DecimalInput;
}

/** Completed entries and historical approvals count; payment/sync do not create cost. */
export function isRecognizedBillStatus(status: string): boolean {
  return status === "READY" || status === "APPROVED";
}

export function summarizeJob(job: JobForSummary, bills: BillForSummary[]) {
  let recognizedExpenses = new Money(0);
  let paidExpenses = new Money(0);
  let outstanding = new Money(0);
  const seenBills = new Set<string>();
  for (const bill of bills) {
    if (bill.currency !== job.currency)
      throw new Error("Job summaries cannot mix currencies.");
    if (bill.id && seenBills.has(bill.id)) continue;
    if (bill.id) seenBills.add(bill.id);
    // Payment and sync state never change cost recognition.
    if (!isRecognizedBillStatus(bill.status)) continue;
    const subtotal = nonnegative(bill.subtotal, "Subtotal");
    const discount = nonnegative(bill.discount, "Discount");
    const total = nonnegative(bill.total, "Total");
    const paid = nonnegative(bill.paidAmount, "Paid amount");
    if (discount.greaterThan(subtotal))
      throw new Error("Discount cannot exceed the subtotal.");
    if (paid.greaterThan(total))
      throw new Error("Paid amount cannot exceed the total.");
    recognizedExpenses = recognizedExpenses.plus(subtotal.minus(discount));
    paidExpenses = paidExpenses.plus(paid);
    outstanding = outstanding.plus(total.minus(paid));
  }
  const adjusted =
    job.contractValue === null
      ? null
      : decimal(job.contractValue, "Contract value").plus(
          decimal(job.approvedVariations, "Approved variations"),
        );
  // A missing, zero or negative adjusted contract value does not produce a profit estimate.
  const validValue = adjusted !== null && adjusted.greaterThan(0);
  const remaining = validValue ? adjusted.minus(recognizedExpenses) : null;
  const ratio = validValue
    ? recognizedExpenses.dividedBy(adjusted).times(100)
    : null;
  const budgetStatus: BudgetStatus = !validValue
    ? "VALUE_UNAVAILABLE"
    : recognizedExpenses.greaterThan(adjusted)
      ? "OVER_BUDGET"
      : ratio!.greaterThanOrEqualTo(90)
        ? "NEAR_LIMIT"
        : "WITHIN_BUDGET";
  return {
    adjustedValue: validValue ? amount(adjusted) : null,
    recognizedExpenses: amount(recognizedExpenses),
    paidExpenses: amount(paidExpenses),
    outstanding: amount(outstanding),
    remainingBudget: remaining ? amount(remaining) : null,
    estimatedProfit: remaining ? amount(remaining) : null,
    expensePercentage: ratio ? ratio.toFixed(2) : null,
    budgetStatus,
  };
}

export function normalizeInvoiceNumber(invoiceNumber: string): string {
  return invoiceNumber
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

export function formatMoney(
  value: DecimalInput | null | undefined,
  currency = "AED",
): string {
  if (value === null || value === undefined) return "—";
  const fixed = decimal(value, "Amount").toFixed(2);
  const [integer, fraction] = fixed.split(".");
  return `${currency} ${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction}`;
}
