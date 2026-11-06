import "server-only";
import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { z } from "zod";
import { IntegrationError } from "./config";
import { stableReference, wireNumber } from "./books";
import type { ZohoTransport } from "./transport";

const id = z.string().regex(/^\d{1,30}$/);
const amount = z.union([z.string().regex(/^\d+(?:\.\d+)?$/), z.number().finite().nonnegative()]);
export const paymentSnapshotSchema = z.object({
  payment: z.object({ id: z.string(), billId: z.string(), amount: z.string(), reference: z.string(), createdById: z.string(),
    createdAt: z.string(), paymentDate: z.iso.date(),
    paymentMode: z.enum(["Cash", "Bank Transfer", "Credit Card", "Cheque", "Other"]), paidThroughAccountId: id }).strict(),
  bill: z.object({ id: z.string(), companyId: z.string(), createdById: z.string(), vendorId: z.string(), jobId: z.string(),
    invoiceNumber: z.string(), invoiceDate: z.string(), currency: z.string(), total: z.string(), externalVendorId: id, sourceHash: z.string().length(64) }).strict(),
  destination: z.object({ organizationId: id, dataCenter: z.string(), environment: z.enum(["production", "sandbox"]),
    connectionFingerprint: z.string().length(64), configurationHash: z.string().length(64) }).strict(),
}).strict();
export type PaymentSnapshot = z.infer<typeof paymentSnapshotSchema>;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export const paymentSourceHash = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
export const paymentReference = (paymentId: string) => `VX-PAY-${createHash("sha256").update(paymentId).digest("hex").slice(0, 40)}`;
const fail = (code: string, message: string, kind: "BLOCKED" | "UNKNOWN" = "BLOCKED") => new IntegrationError(code, message, kind);
const mode = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^a-z]/g, "");
const modes = { Cash: "Cash", "Bank Transfer": "Bank Transfer", "Credit Card": "Credit Card", Cheque: "Check", Other: "Others" } as const;
export function buildPaymentPayload(snapshot: PaymentSnapshot, externalBillId: string) {
  if (!id.safeParse(externalBillId).success || !new Decimal(snapshot.payment.amount).gt(0)) throw fail("PAYMENT_SOURCE_INVALID", "The saved payment or Books bill identity is invalid.");
  const value = wireNumber(snapshot.payment.amount);
  return { vendor_id: snapshot.bill.externalVendorId, amount: value, date: snapshot.payment.paymentDate,
    payment_mode: modes[snapshot.payment.paymentMode], paid_through_account_id: snapshot.payment.paidThroughAccountId,
    reference_number: paymentReference(snapshot.payment.id),
    description: `VOLTRONIX payment ${snapshot.payment.id}; bill ${snapshot.bill.id}; reference ${snapshot.payment.reference}`,
    bills: [{ bill_id: externalBillId, amount_applied: value }],
  };
}
export function paymentAcknowledgementId(raw: unknown): string {
  const parsed = z.object({ code: z.literal(0), payment_id: id.optional(), vendorpayment: z.object({ payment_id: id }).optional() }).safeParse(raw);
  if (!parsed.success || !parsed.data.payment_id && !parsed.data.vendorpayment?.payment_id ||
    parsed.data.payment_id && parsed.data.vendorpayment && parsed.data.payment_id !== parsed.data.vendorpayment.payment_id)
    throw fail("PAYMENT_CREATE_UNCONFIRMED", "Books may have recorded the payment. Reconcile before attempting another creation.", "UNKNOWN");
  return parsed.data.payment_id ?? parsed.data.vendorpayment!.payment_id;
}

export function validatePaymentBill(raw: unknown, snapshot: PaymentSnapshot, externalBillId: string, requireBalance = true) {
  const result = z.object({ code: z.literal(0), bill: z.object({ bill_id: id, vendor_id: id, bill_number: z.string(), date: z.string(),
    reference_number: z.string(), currency_code: z.string(), total: amount, balance: amount, payment_made: amount, vendor_credits_applied: amount }) }).safeParse(raw);
  if (!result.success) throw fail("PAYMENT_BILL_UNVERIFIED", "Books did not return a complete bill/payment balance.");
  const bill = result.data.bill;
  if (bill.bill_id !== externalBillId || bill.vendor_id !== snapshot.bill.externalVendorId || bill.currency_code !== snapshot.bill.currency ||
    bill.bill_number !== snapshot.bill.invoiceNumber || bill.date !== snapshot.bill.invoiceDate || bill.reference_number !== stableReference(snapshot.bill.id) ||
    !new Decimal(bill.total).eq(snapshot.bill.total) || !new Decimal(bill.balance).plus(bill.payment_made).plus(bill.vendor_credits_applied).eq(bill.total))
    throw fail("PAYMENT_BILL_CHANGED", "The exact Books bill, supplier, currency or balance differs from the saved payment source.");
  if (requireBalance && new Decimal(bill.balance).lt(snapshot.payment.amount))
    throw fail("PAYMENT_EXCEEDS_BOOKS_BALANCE", "This payment exceeds the current Books balance. Review existing payments and credits before retrying.");
  return bill;
}

const remotePayment = z.object({ payment_id: id, vendor_id: id, reference_number: z.string(), date: z.string(), amount,
  payment_mode: z.string(), paid_through_account_id: id, currency_code: z.string().optional(), currency_id: id.optional(), balance: amount,
  bills: z.array(z.object({ bill_id: id, amount_applied: amount, tax_amount_withheld: amount.optional() })).max(100),
  vendorpayment_refunds: z.array(z.unknown()).optional(), tax_amount_withheld: amount.optional() });
export function verifyPaymentConfirmation(raw: unknown, snapshot: PaymentSnapshot, externalBillId: string, currencyId: string) {
  const parsed = z.object({ code: z.literal(0), vendorpayment: remotePayment }).safeParse(raw);
  if (!parsed.success) throw fail("PAYMENT_CONFIRMATION_UNVERIFIED", "The vendor payment details could not be verified.", "UNKNOWN");
  const payment = parsed.data.vendorpayment, expected = buildPaymentPayload(snapshot, externalBillId);
  if (payment.vendor_id !== expected.vendor_id || payment.reference_number !== expected.reference_number || payment.date !== expected.date ||
    !new Decimal(payment.amount).eq(snapshot.payment.amount) || !new Decimal(payment.balance).isZero() ||
    mode(payment.payment_mode) !== mode(expected.payment_mode) || payment.paid_through_account_id !== expected.paid_through_account_id ||
    (!payment.currency_code && !payment.currency_id) || payment.currency_code && payment.currency_code !== snapshot.bill.currency || payment.currency_id && payment.currency_id !== currencyId ||
    payment.bills.length !== 1 || payment.bills[0].bill_id !== externalBillId || !new Decimal(payment.bills[0].amount_applied).eq(snapshot.payment.amount) ||
    !new Decimal(payment.tax_amount_withheld ?? 0).isZero() || !new Decimal(payment.bills[0].tax_amount_withheld ?? 0).isZero() || payment.vendorpayment_refunds?.length)
    throw fail("PAYMENT_CONFIRMATION_CONFLICT", "A matching payment reference exists with different payment details or allocations. Review it before any retry.", "UNKNOWN");
  return payment.payment_id;
}

/** Complete bounded reference search followed by exact payment detail verification. */
export async function reconcileBooksPayment(transport: ZohoTransport, snapshot: PaymentSnapshot, externalBillId: string): Promise<string | null> {
  const matches = new Set<string>();
  const seen = new Set<string>();
  let complete = false;
  for (let page = 1; page <= 5; page++) {
    const raw = await transport.request("/books/v3/vendorpayments", { method: "GET", query: { reference_number: paymentReference(snapshot.payment.id),
      bill_id: externalBillId, vendor_id: snapshot.bill.externalVendorId, page: String(page), per_page: "200" } });
    const parsed = z.object({ code: z.literal(0), vendorpayments: z.array(z.object({ payment_id: id, reference_number: z.string() })).max(200),
      page_context: z.object({ page: z.number().int().positive().optional(), has_more_page: z.boolean() }) }).safeParse(raw);
    if (!parsed.success || parsed.data.page_context.page !== undefined && parsed.data.page_context.page !== page || page > 1 && parsed.data.page_context.page !== page)
      throw fail("PAYMENT_SEARCH_UNVERIFIED", "Books did not confirm a complete payment-reference search.", "UNKNOWN");
    for (const row of parsed.data.vendorpayments) {
      if (seen.has(row.payment_id)) throw fail("PAYMENT_SEARCH_REPLAYED", "Books repeated a payment search identity. Review the search before retrying.", "UNKNOWN");
      seen.add(row.payment_id);
      if (row.reference_number === paymentReference(snapshot.payment.id)) matches.add(row.payment_id);
    }
    if (matches.size > 1) throw fail("PAYMENT_REFERENCE_DUPLICATE", "More than one Books payment uses this internal payment reference. Resolve the duplicates before proceeding.", "UNKNOWN");
    if (!parsed.data.page_context.has_more_page) { complete = true; break; }
  }
  if (!complete) throw fail("PAYMENT_SEARCH_LIMIT", "Books payment search exceeded its safe page limit. Review the result before retrying.", "UNKNOWN");
  const paymentId = [...matches][0];
  if (!paymentId) return null;
  const currencyId = transport.config.booksMapping?.currencies[snapshot.bill.currency]?.id;
  if (!currencyId) throw fail("PAYMENT_CURRENCY_UNVERIFIED", "The payment currency has no verified Books mapping.");
  const confirmed = verifyPaymentConfirmation(await transport.request(`/books/v3/vendorpayments/${paymentId}`, { method: "GET" }), snapshot, externalBillId, currencyId);
  if (confirmed !== paymentId) throw fail("PAYMENT_CONFIRMATION_CONFLICT", "The payment detail identity differs from the requested Books payment.", "UNKNOWN");
  return confirmed;
}
