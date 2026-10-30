export const PAYMENT_TERMS = [
  { value: "CUSTOM", label: "Custom", days: null },
  { value: "DUE_ON_RECEIPT", label: "Due on Receipt", days: 0 },
  { value: "NET_7", label: "Net 7", days: 7 },
  { value: "NET_15", label: "Net 15", days: 15 },
  { value: "NET_30", label: "Net 30", days: 30 },
  { value: "NET_45", label: "Net 45", days: 45 },
  { value: "NET_60", label: "Net 60", days: 60 },
] as const;

export type PaymentTerm = (typeof PAYMENT_TERMS)[number]["value"];

function calendarDate(value: string, label: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} must be a valid calendar date.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value ||
    value < "1900-01-01" ||
    value > "2199-12-31"
  ) {
    throw new Error(
      `${label} must be a valid calendar date between 1900 and 2199.`,
    );
  }
  return parsed;
}

/** Calendar-day terms use the bill date, never the host's locale or local clock. */
export function resolveDueDate(
  invoiceDate: string,
  paymentTerms: PaymentTerm,
  customDueDate = "",
): string {
  const date = calendarDate(invoiceDate, "Bill date");
  const term = PAYMENT_TERMS.find(({ value }) => value === paymentTerms);
  if (!term) throw new Error("Choose a supported payment term.");
  if (term.days === null) {
    if (!customDueDate) return "";
    calendarDate(customDueDate, "Due date");
    if (customDueDate < invoiceDate) {
      throw new Error("Due date cannot precede the bill date.");
    }
    return customDueDate;
  }
  date.setUTCDate(date.getUTCDate() + term.days);
  const dueDate = date.toISOString().slice(0, 10);
  calendarDate(dueDate, "Calculated due date");
  return dueDate;
}
