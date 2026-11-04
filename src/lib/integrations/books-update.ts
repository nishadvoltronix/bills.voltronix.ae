import "server-only";
import Decimal from "decimal.js";
import { z } from "zod";
import { IntegrationError } from "./config";
import type { ZohoConfig } from "./config";
import type { BillSnapshot, buildBooksPayload } from "./books";
import { PAYMENT_TERMS, resolveDueDate } from "@/lib/payment-terms";

const id = z.string().regex(/^\d{1,30}$/);
const amount = z.union([z.number().finite(), z.string().regex(/^-?\d+(\.\d+)?$/)]);
const remoteSchema = z.object({ code: z.literal(0), bill: z.object({
  bill_id: id, vendor_id: id, bill_number: z.string(), reference_number: z.string(), currency_code: z.string(),
  total: amount, tax_total: amount, date: z.string(), due_date: z.string().nullish(),
  payment_made: amount.optional(), vendor_credits_applied: amount.optional(), balance: amount.optional(),
  last_modified_time: z.string().min(1).max(100), status: z.string(), is_locked: z.boolean().optional(),
  payment_terms: z.number().int().optional(),
  is_line_item_invoiced: z.boolean().optional(), notes: z.string().optional(),
  documents: z.array(z.object({ document_id: z.union([id, z.number().int().safe().nonnegative()]).transform(String), file_name: z.string().optional() })).max(20),
  line_items: z.array(z.object({ line_item_id: id, account_id: z.string(), tax_id: z.string().nullish(), customer_id: z.string().nullish(),
    is_billable: z.boolean().optional(), description: z.string(), quantity: amount, rate: amount,
    purchaseorder_item_id: z.string().nullish(), is_invoiced: z.boolean().optional() })).min(1).max(100),
}) });
export type BooksUpdateRemote = z.infer<typeof remoteSchema>["bill"];
type Payload = ReturnType<typeof buildBooksPayload>;
const blocked = (code: string, message: string) => new IntegrationError(code, message, "BLOCKED");
export function assertBooksUpdateMapping(config: ZohoConfig) {
  if (config.booksMapping?.jobCustomFieldIndex || config.booksMapping?.orderCustomFieldIndex)
    throw blocked("UPDATE_CUSTOM_FIELDS_UNVERIFIED", "This Books connection uses mapped custom fields. Their existing values must be verified before finalized bill updates can be enabled.");
}
export function booksUpdateTerms(snapshot: BillSnapshot) {
  let dueDate: string;
  try {
    if (snapshot.dueDate !== null) {
      dueDate = resolveDueDate(snapshot.invoiceDate, "CUSTOM", snapshot.dueDate);
      if (!dueDate) throw new Error();
    } else {
      const term = PAYMENT_TERMS.find(value => value.value === snapshot.paymentTerms);
      if (!term || term.days === null) throw new Error();
      dueDate = resolveDueDate(snapshot.invoiceDate, term.value);
    }
  } catch {
    throw blocked("UPDATE_DUE_DATE_UNVERIFIED", "Choose an explicit due date for Custom terms, or select supported payment terms before saving this edit. The existing Books due date was preserved.");
  }
  const paymentTerms = (Date.parse(`${dueDate}T00:00:00Z`) - Date.parse(`${snapshot.invoiceDate}T00:00:00Z`)) / 86400000;
  if (!Number.isSafeInteger(paymentTerms) || paymentTerms < 0) throw blocked("UPDATE_DUE_DATE_UNVERIFIED", "The intended Books payment terms and due date could not be verified.");
  return { due_date: dueDate, payment_terms: paymentTerms };
}
export function reviewedBooksUpdateNotes(previous: string, desired: string, remote: string | undefined) {
  if (typeof remote !== "string" || remote.length > 10000)
    throw blocked("UPDATE_NOTES_UNVERIFIED", "The existing Books notes must be read and preserved before updating.");
  if (previous === desired) return remote;
  if (!remote.startsWith(previous)) throw blocked("UPDATE_NOTES_UNVERIFIED", "The Books order reference notes changed elsewhere. Review them before changing this order reference.");
  return desired + remote.slice(previous.length);
}
export function parseBooksUpdateRemote(value: unknown, externalId: string): BooksUpdateRemote {
  const parsed = remoteSchema.safeParse(value);
  if (!parsed.success || parsed.data.bill.bill_id !== externalId ||
    new Set(parsed.data.bill.line_items.map(line => line.line_item_id)).size !== parsed.data.bill.line_items.length ||
    new Set(parsed.data.bill.documents.map(document => document.document_id)).size !== parsed.data.bill.documents.length)
    throw blocked("UPDATE_REMOTE_UNVERIFIED", "The exact existing Books bill and its update safeguards could not be verified. No update was sent.");
  return parsed.data.bill;
}
export function booksRemoteAppliedAmount(remote: BooksUpdateRemote) {
  const total = new Decimal(remote.total);
  const payment = remote.payment_made === undefined ? null : new Decimal(remote.payment_made);
  const credits = remote.vendor_credits_applied === undefined ? null : new Decimal(remote.vendor_credits_applied);
  if (total.isNegative() || total.decimalPlaces() > 2 || [payment, credits].some(value => value && (value.isNegative() || value.decimalPlaces() > 2)))
    throw blocked("UPDATE_PAYMENTS_UNVERIFIED", "Books payment or credit amounts are invalid.");
  let applied: Decimal | null = null;
  if (payment && credits) {
    applied = payment.plus(credits);
  }
  if (remote.balance !== undefined) {
    const balance = new Decimal(remote.balance);
    if (balance.isNegative() || balance.greaterThan(total) || balance.decimalPlaces() > 2) throw blocked("UPDATE_PAYMENTS_UNVERIFIED", "The Books balance could not be reconciled safely.");
    const fromBalance = total.minus(balance);
    if (applied && !applied.equals(fromBalance)) throw blocked("UPDATE_PAYMENTS_UNVERIFIED", "Books payment, credit and balance totals disagree. Review them before editing.");
    if ([payment, credits].some(value => value && value.greaterThan(fromBalance)))
      throw blocked("UPDATE_PAYMENTS_UNVERIFIED", "A Books payment or credit amount exceeds the verified applied balance.");
    applied = fromBalance;
  }
  if (!applied || applied.isNegative() || applied.greaterThan(total))
    throw blocked("UPDATE_PAYMENTS_UNVERIFIED", "The existing Books payment and credit balance must be verified before editing.");
  return applied.toFixed(2);
}
export function assertBooksUpdateMoney(remote: BooksUpdateRemote, desired: BillSnapshot, localPaid: string) {
  const applied = new Decimal(booksRemoteAppliedAmount(remote));
  if (remote.is_locked || remote.status === "void" || remote.is_line_item_invoiced || remote.line_items.some(line => line.is_invoiced || line.purchaseorder_item_id))
    throw blocked("UPDATE_BILL_LOCKED", "This Books bill is locked, void or linked to another transaction. Review it in Books before editing.");
  if (new Decimal(desired.total).lessThan(localPaid) || new Decimal(desired.total).lessThan(applied))
    throw blocked("UPDATE_BELOW_PAID_AMOUNT", "The edited total cannot be less than the existing payments or applied vendor credits. Payment records were preserved.");
  if (remote.vendor_id !== desired.externalVendorId && applied.greaterThan(0))
    throw blocked("UPDATE_PAID_VENDOR_CHANGE", "This Books bill has payments or credits. Its supplier cannot be changed without a separately reviewed payment correction.");
}
export function booksRemoteMatchesPayload(remote: BooksUpdateRemote, snapshot: BillSnapshot, payload: Payload) {
  // Old CREATE payloads omitted CUSTOM terms without a date. Those fields were
  // not owned by that source; the fresh baseline still binds their remote value.
  const unownedLegacyTerms = !snapshot.revision && !snapshot.dueDate && !("payment_terms" in payload);
  return remote.bill_id === (snapshot.revision?.externalId ?? remote.bill_id) && remote.vendor_id === payload.vendor_id &&
    remote.bill_number === snapshot.invoiceNumber && remote.reference_number === payload.reference_number && remote.currency_code === snapshot.currency &&
    new Decimal(remote.total).equals(snapshot.total) && new Decimal(remote.tax_total).equals(snapshot.vatAmount) && remote.date === snapshot.invoiceDate &&
    (unownedLegacyTerms || remote.due_date === booksUpdateTerms(snapshot).due_date &&
      (snapshot.revision ? remote.payment_terms === booksUpdateTerms(snapshot).payment_terms :
        remote.payment_terms === undefined || remote.payment_terms === booksUpdateTerms(snapshot).payment_terms)) &&
    (snapshot.revision?.preservedRemoteNotes === undefined || remote.notes === snapshot.revision.preservedRemoteNotes) &&
    remote.line_items.length === payload.line_items.length &&
    remote.line_items.every((actual, index) => {
      const line = payload.line_items[index];
      return (!snapshot.revision?.remoteLineIds[index] || actual.line_item_id === snapshot.revision.remoteLineIds[index]) &&
        actual.account_id === line.account_id && (actual.tax_id || null) === ("tax_id" in line ? line.tax_id || null : null) &&
        (actual.customer_id || null) === ("customer_id" in line ? line.customer_id || null : null) &&
        (!("is_billable" in line) || actual.is_billable === line.is_billable) && actual.description === line.description &&
        new Decimal(actual.quantity).equals(line.quantity) && new Decimal(actual.rate).equals(line.rate);
    });
}
export function buildBooksUpdatePayload(snapshot: BillSnapshot, base: Payload) {
  const revision = snapshot.revision;
  if (!revision || revision.kind !== "UPDATE_BILL") throw blocked("UPDATE_REVISION_REQUIRED", "An exact saved update revision is required.");
  if (typeof revision.preservedRemoteNotes !== "string") throw blocked("UPDATE_NOTES_UNVERIFIED", "The reviewed Books notes are required for this update.");
  return { ...base,
    ...booksUpdateTerms(snapshot), notes: revision.preservedRemoteNotes,
    documents: revision.remoteDocuments,
    line_items: base.line_items.map((line, index) => ({ ...line,
      tax_id: "tax_id" in line ? line.tax_id ?? "" : "", customer_id: "customer_id" in line ? line.customer_id ?? "" : "", is_billable: false,
      ...(revision.remoteLineIds[index] ? { line_item_id: revision.remoteLineIds[index] } : {}) })),
  };
}
export function assertBooksUpdateBaseline(remote: BooksUpdateRemote, desired: BillSnapshot) {
  const revision = desired.revision;
  if (!revision || remote.bill_id !== revision.externalId || remote.last_modified_time !== revision.remoteLastModified ||
    JSON.stringify(remote.line_items.map(line => line.line_item_id)) !== JSON.stringify(revision.remoteLineIds) ||
    JSON.stringify(remote.documents) !== JSON.stringify(revision.remoteDocuments))
    throw blocked("UPDATE_BASELINE_CHANGED", "The Books bill or its original attachments changed after this edit was prepared. Reopen and review the bill before saving again.");
}
