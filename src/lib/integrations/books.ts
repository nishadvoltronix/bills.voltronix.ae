import "server-only";
import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { z } from "zod";
import { calculateBill } from "@/lib/finance";
import { BOOKS_PURCHASE_ACCOUNT_TYPES, booksSelectionSchema } from "@/lib/books-selection";
import { IntegrationError, type ZohoConfig } from "./config";
import type { ZohoTransport } from "./transport";

export const snapshotSchema = z.object({
  internalBillId: z.string(),
  companyId: z.string().optional(),
  initiatedById: z.string().optional(),
  sourceVersion: z.number().int().positive(),
  destination: z
    .object({
      dataCenter: z.string(),
      environment: z.enum(["sandbox", "production"]),
      mappingHash: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      authorizationReference: z.string().optional(),
      liveAuthorizationId: z.string().optional(),
      configurationHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    })
    .optional(),
  invoiceNumber: z.string(),
  invoiceDate: z.string(),
  dueDate: z.string().nullable(),
  orderNumber: z.string().nullable(),
  paymentTerms: z.string(),
  category: z.string(),
  currency: z.string(),
  discount: z.string(),
  vatRate: z.string(),
  subtotal: z.string(),
  vatAmount: z.string(),
  total: z.string(),
  vendorId: z.string(),
  externalVendorId: z.string().nullable(),
  jobId: z.string(),
  jobNumber: z.string(),
  externalCrmJobId: z.string().nullable(),
  lines: z.array(
    z.object({
      description: z.string(),
      quantity: z.string(),
      unitPrice: z.string(),
      booksSelection: booksSelectionSchema.optional(),
    }),
  ),
  documents: z.array(
    z.object({
      id: z.string(),
      sha256: z.string(),
      fileName: z.string(),
      mimeType: z.string(),
    }),
  ),
});
export type BillSnapshot = z.infer<typeof snapshotSchema>;
export function snapshotHash(snapshot: BillSnapshot) {
  // Prisma JSONB may reorder object keys. Parse into the original schema field
  // order before hashing; destination-free legacy snapshots keep their hash.
  return createHash("sha256")
    .update(JSON.stringify(snapshotSchema.parse(snapshot)))
    .digest("hex");
}
export function booksMappingFingerprint(config: ZohoConfig) {
  return createHash("sha256")
    .update(JSON.stringify(config.booksMapping ?? null))
    .digest("hex");
}
export function stableReference(internalId: string) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(internalId))
    throw new IntegrationError(
      "INVALID_INTERNAL_ID",
      "The internal bill identifier is invalid.",
      "BLOCKED",
    );
  return `VX-BILL-${internalId}`;
}
export function wireNumber(value: string) {
  const decimal = new Decimal(value);
  const n = decimal.toNumber();
  if (!Number.isFinite(n) || !new Decimal(String(n)).equals(decimal))
    throw new IntegrationError(
      "NUMBER_PRECISION",
      "An amount cannot be represented safely by the external API.",
      "BLOCKED",
    );
  return n;
}

/** Used before finalization and again before constructing any provider payload. */
export function assertBooksLineSelections(lines: readonly { booksSelection?: unknown }[], config: ZohoConfig) {
  const selected = lines.filter(line => line.booksSelection !== null && line.booksSelection !== undefined);
  if ((config.booksMapping?.lineSelectionRequired && (!lines.length || selected.length !== lines.length)) ||
    (selected.length > 0 && selected.length !== lines.length))
    throw new IntegrationError("LINE_SELECTION_REQUIRED", "Select a Books account and tax for every line before Save and sync. You can keep this bill as a draft.", "BLOCKED");
  for (const line of selected) {
    const parsed = booksSelectionSchema.safeParse(line.booksSelection);
    if (!parsed.success || parsed.data.organizationId !== config.organizationId ||
      parsed.data.dataCenter !== config.dataCenter || parsed.data.environment !== config.environment)
      throw new IntegrationError("LINE_DESTINATION_MISMATCH", "Every line's complete Books selection must match this exact company destination.", "BLOCKED");
  }
  return selected.length > 0;
}

export function buildBooksPayload(snapshot: BillSnapshot, config: ZohoConfig) {
  const mapping = config.booksMapping;
  if (!mapping)
    throw new IntegrationError(
      "MAPPING_REQUIRED",
      "Verified Books tax, currency, item and account mappings are required.",
      "BLOCKED",
    );
  if (!snapshot.externalVendorId || !/^\d+$/.test(snapshot.externalVendorId))
    throw new IntegrationError(
      "VENDOR_MAPPING_REQUIRED",
      "Map this vendor to its existing Zoho Books contact before synchronization.",
      "BLOCKED",
    );
  const currency = mapping.currencies[snapshot.currency];
  const category =
    mapping.categories[snapshot.category as keyof typeof mapping.categories];
  const tax = mapping.taxes[new Decimal(snapshot.vatRate).toFixed(2)];
  const hasSelectedLines = assertBooksLineSelections(snapshot.lines, config);
  if (
    !currency ||
    (!hasSelectedLines && (!category?.accountId || !tax || !new Decimal(tax.percentage).equals(snapshot.vatRate)))
  )
    throw new IntegrationError(
      "MAPPING_REQUIRED",
      "This bill's currency, expense account or VAT rate has no verified Books mapping.",
      "BLOCKED",
    );
  if (snapshot.currency !== mapping.baseCurrency && !currency.exchangeRate)
    throw new IntegrationError(
      "EXCHANGE_RATE_REQUIRED",
      "A reviewed exchange rate is required for a non-base-currency Books bill.",
      "BLOCKED",
    );
  if (
    currency.exchangeRate &&
    new Decimal(currency.exchangeRate).lessThanOrEqualTo(0)
  )
    throw new IntegrationError(
      "INVALID_EXCHANGE_RATE",
      "The configured exchange rate must be positive.",
      "BLOCKED",
    );
  // The published supplier-bill contract does not establish a safe equivalent
  // for this app's before-tax fixed discount. Do not move it into a post-tax adjustment.
  if (!new Decimal(snapshot.discount).isZero())
    throw new IntegrationError(
      "DISCOUNT_MAPPING_UNVERIFIED",
      "Discounted bills require a verified before-tax Books discount mapping. No external bill was created.",
      "BLOCKED",
    );
  let totals: ReturnType<typeof calculateBill>;
  try { totals = calculateBill(snapshot.lines, snapshot.discount, snapshot.vatRate); }
  catch (error) {
    throw new IntegrationError("LINE_CALCULATION_UNSUPPORTED", error instanceof Error ? error.message : "The selected line taxes cannot be reconciled.", "BLOCKED");
  }
  if (
    !new Decimal(totals.total).equals(snapshot.total) ||
    !new Decimal(totals.vatAmount).equals(snapshot.vatAmount) ||
    !new Decimal(totals.subtotal).equals(snapshot.subtotal)
  )
    throw new IntegrationError(
      "LOCAL_TOTAL_MISMATCH",
      "The approved snapshot does not reconcile to its line items.",
      "BLOCKED",
    );
  const custom_fields: { index: number; value: string }[] = [];
  if (mapping.jobCustomFieldIndex)
    custom_fields.push({
      index: mapping.jobCustomFieldIndex,
      value: snapshot.jobNumber,
    });
  if (mapping.orderCustomFieldIndex && snapshot.orderNumber)
    custom_fields.push({
      index: mapping.orderCustomFieldIndex,
      value: snapshot.orderNumber,
    });
  const terms: Record<string, number> = {
    DUE_ON_RECEIPT: 0,
    NET_7: 7,
    NET_15: 15,
    NET_30: 30,
    NET_45: 45,
    NET_60: 60,
  };
  return {
    vendor_id: snapshot.externalVendorId,
    bill_number: snapshot.invoiceNumber,
    reference_number: stableReference(snapshot.internalBillId),
    date: snapshot.invoiceDate,
    ...(snapshot.dueDate ? { due_date: snapshot.dueDate } : {}),
    ...(snapshot.paymentTerms in terms
      ? { payment_terms: terms[snapshot.paymentTerms] }
      : {}),
    currency_id: currency.id,
    ...(currency.exchangeRate
      ? { exchange_rate: wireNumber(currency.exchangeRate) }
      : {}),
    is_inclusive_tax: false,
    is_item_level_tax_calc: false,
    is_update_customer: false,
    line_items: snapshot.lines.map((line) => ({
      account_id: line.booksSelection?.accountId ?? category!.accountId,
      ...(!line.booksSelection && category?.itemId ? { item_id: category.itemId } : {}),
      description: line.description,
      quantity: wireNumber(line.quantity),
      rate: wireNumber(line.unitPrice),
      tax_id: line.booksSelection?.taxId ?? tax!.id,
      ...(line.booksSelection ? { is_billable: false,
        ...(line.booksSelection.customerId ? { customer_id: line.booksSelection.customerId } : {}) } : {}),
    })),
    ...(custom_fields.length ? { custom_fields } : {}),
    notes: `VOLTRONIX internal bill ${snapshot.internalBillId}; job ${snapshot.jobNumber}.${snapshot.orderNumber ? ` Order reference: ${snapshot.orderNumber}.` : ""}`,
  };
}
const remoteBill = z.object({
  bill_id: z.string().regex(/^\d+$/),
  bill_number: z.string(),
  vendor_id: z.string(),
  reference_number: z.string(),
  currency_code: z.string(),
  total: z.union([z.number(), z.string()]),
  tax_total: z.union([z.number(), z.string()]),
  line_items: z.unknown().optional(),
});
const selectedRemoteLines = z.array(z.object({
  account_id: z.string(), tax_id: z.string(), customer_id: z.string().nullable().optional(),
  is_billable: z.boolean(), description: z.string(), quantity: z.union([z.number(), z.string()]),
  rate: z.union([z.number(), z.string()]),
}));

/** Metadata can change after a draft was saved; reject it before a financial POST. */
export async function verifySelectedLineMetadata(transport: ZohoTransport, snapshot: BillSnapshot) {
  const selections = snapshot.lines.flatMap((line) => line.booksSelection ? [booksSelectionSchema.parse(line.booksSelection)] : []);
  if (!selections.length) return;
  const fail = () => new IntegrationError("LINE_SELECTION_CHANGED", "A selected Books account, tax or customer changed or is unavailable. Review and save the bill again before synchronization.", "BLOCKED");
  const tasks: (() => Promise<void>)[] = [];
  for (const accountId of new Set(selections.map((selection) => selection.accountId))) tasks.push(async () => {
    const result = z.object({ code: z.literal(0), chart_of_account: z.object({ account_id: z.string(), is_active: z.literal(true),
      account_type: z.enum(BOOKS_PURCHASE_ACCOUNT_TYPES) }) }).safeParse(
      await transport.request(`/books/v3/chartofaccounts/${accountId}`, { method: "GET" }));
    if (!result.success || result.data.chart_of_account.account_id !== accountId) throw fail();
  });
  const taxSchema = z.object({ tax_id: z.string(), tax_type: z.literal("tax"),
    tax_percentage: z.union([z.number().finite(), z.string().regex(/^\d+(\.\d+)?$/)]),
    is_active: z.literal(true).optional(), status: z.string().toLowerCase().pipe(z.literal("active")).optional(), tax_factor: z.literal("rate").optional() });
  for (const taxId of new Set(selections.map((selection) => selection.taxId))) tasks.push(async () => {
    const result = z.object({ code: z.literal(0), tax: z.union([taxSchema, z.array(taxSchema).min(1).max(100)]) }).safeParse(
      await transport.request(`/books/v3/settings/taxes/${taxId}`, { method: "GET" }));
    if (!result.success) throw fail();
    const matches = (Array.isArray(result.data.tax) ? result.data.tax : [result.data.tax]).filter((tax) => tax.tax_id === taxId);
    if (matches.length !== 1 || selections.some((selection) => selection.taxId === taxId &&
      !new Decimal(matches[0].tax_percentage).equals(selection.taxRate))) throw fail();
  });
  for (const customerId of new Set(selections.flatMap((selection) => selection.customerId ? [selection.customerId] : []))) tasks.push(async () => {
    const result = z.object({ code: z.literal(0), contact: z.object({ contact_id: z.string(),
      contact_type: z.literal("customer"), status: z.literal("active"), currency_code: z.enum(["AED", "USD", "EUR", "GBP", "SAR"]) }) }).safeParse(
      await transport.request(`/books/v3/contacts/${customerId}`, { method: "GET" }));
    if (!result.success || result.data.contact.contact_id !== customerId) throw fail();
  });
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, tasks.length) }, async () => {
    while (next < tasks.length) await tasks[next++]();
  }));
}
export type Confirmation = { externalId: string; confirmedAt: Date };
export interface SupplierBillAdapter {
  create(snapshot: BillSnapshot): Promise<Confirmation>;
  reconcile(snapshot: BillSnapshot): Promise<Confirmation | null>;
  attach(
    externalId: string,
    document: {
      bytes: Uint8Array;
      fileName: string;
      mimeType: string;
      sha256: string;
    },
  ): Promise<Confirmation>;
  reconcileAttachment(
    externalId: string,
    sha256: string,
  ): Promise<Confirmation | null>;
}
export class BooksAdapter implements SupplierBillAdapter {
  constructor(private readonly transport: ZohoTransport) {}
  private async confirm(externalId: string, snapshot: BillSnapshot) {
    const response = await this.transport.request(
      `/books/v3/bills/${externalId}`,
    );
    const parsed = z
      .object({ code: z.literal(0), bill: remoteBill })
      .safeParse(response);
    if (!parsed.success)
      throw new IntegrationError(
        "INVALID_CONFIRMATION",
        "Zoho did not return a verifiable supplier bill.",
        "UNKNOWN",
      );
    const remote = parsed.data.bill;
    const selectedLines = selectedRemoteLines.safeParse(remote.line_items);
    const selectionsMatch = !snapshot.lines.some((line) => line.booksSelection) || (
      selectedLines.success && selectedLines.data.length === snapshot.lines.length && snapshot.lines.every((line, index) => {
        const selection = line.booksSelection;
        const actual = selectedLines.data[index];
        return !!selection && !!actual && actual.account_id === selection.accountId && actual.tax_id === selection.taxId &&
          (actual.customer_id || null) === selection.customerId && actual.is_billable === false && actual.description === line.description &&
          new Decimal(actual.quantity).equals(line.quantity) && new Decimal(actual.rate).equals(line.unitPrice);
      })
    );
    if (
      remote.bill_id !== externalId ||
      remote.vendor_id !== snapshot.externalVendorId ||
      remote.reference_number !== stableReference(snapshot.internalBillId) ||
      remote.bill_number !== snapshot.invoiceNumber ||
      remote.currency_code !== snapshot.currency ||
      !new Decimal(remote.total).equals(snapshot.total) ||
      !new Decimal(remote.tax_total).equals(snapshot.vatAmount) || !selectionsMatch
    )
      throw new IntegrationError(
        "REMOTE_MISMATCH",
        "The remote bill exists but its identity, currency or totals differ. Reconciliation is required.",
        "UNKNOWN",
      );
    return { externalId, confirmedAt: new Date() };
  }
  async reconcile(snapshot: BillSnapshot) {
    const response = await this.transport.request("/books/v3/bills", {
      query: {
        reference_number: stableReference(snapshot.internalBillId),
        per_page: "200",
        page: "1",
      },
    });
    const parsed = z
      .object({
        code: z.literal(0),
        bills: z.array(
          z.object({ bill_id: z.string(), reference_number: z.string() }),
        ),
        page_context: z.object({ has_more_page: z.boolean() }),
      })
      .safeParse(response);
    if (!parsed.success)
      throw new IntegrationError(
        "INVALID_RECONCILIATION",
        "The external bill search response could not be verified.",
        "UNKNOWN",
      );
    const found = parsed.data.bills.filter(
      (b) => b.reference_number === stableReference(snapshot.internalBillId),
    );
    if (found.length > 1 || parsed.data.page_context?.has_more_page)
      throw new IntegrationError(
        "DUPLICATE_REMOTE_REFERENCE",
        "More than one external bill may have this internal reference. Resolve the duplicates manually.",
        "UNKNOWN",
      );
    if (!found.length) return null;
    return this.confirm(found[0].bill_id, snapshot);
  }
  async create(snapshot: BillSnapshot) {
    await this.transport.assertWritePermission();
    const payload = buildBooksPayload(snapshot, this.transport.config);
    const existing = await this.reconcile(snapshot);
    if (existing) return existing;
    await verifySelectedLineMetadata(this.transport, snapshot);
    const vendorResponse = await this.transport.request(
      `/books/v3/contacts/${snapshot.externalVendorId}`,
    );
    const vendor = z
      .object({
        code: z.literal(0),
        contact: z.object({
          contact_id: z.string(),
          contact_type: z.string(),
          currency_code: z.string(),
          status: z.literal("active"),
        }),
      })
      .safeParse(vendorResponse);
    if (
      !vendor.success ||
      vendor.data.contact.contact_id !== snapshot.externalVendorId ||
      vendor.data.contact.contact_type !== "vendor" ||
      vendor.data.contact.currency_code !== snapshot.currency
    )
      throw new IntegrationError(
        "VENDOR_MAPPING_MISMATCH",
        "The external vendor is inactive or does not match the reviewed mapping and currency.",
        "BLOCKED",
      );
    const response = await this.transport.request("/books/v3/bills", {
      method: "POST",
      body: payload,
    });
    const parsed = z
      .object({
        code: z.literal(0),
        bill: z.object({ bill_id: z.string().regex(/^\d+$/) }),
      })
      .safeParse(response);
    if (!parsed.success)
      throw new IntegrationError(
        "CREATE_UNCONFIRMED",
        "Zoho did not return a confirmed supplier bill ID. Reconcile before retrying.",
        "UNKNOWN",
      );
    try {
      return await this.confirm(parsed.data.bill.bill_id, snapshot);
    } catch {
      throw new IntegrationError(
        "CREATE_UNCONFIRMED",
        "A supplier bill may have been created, but confirmation failed. Reconcile before retrying.",
        "UNKNOWN",
      );
    }
  }
  async reconcileAttachment(externalId: string, sha256: string) {
    try {
      const result = await this.transport.request(
        `/books/v3/bills/${externalId}/attachment`,
        { binary: true },
      );
      if (!(result instanceof Uint8Array))
        throw new IntegrationError(
          "INVALID_ATTACHMENT_RESPONSE",
          "The remote attachment could not be verified.",
          "UNKNOWN",
        );
      if (createHash("sha256").update(result).digest("hex") !== sha256)
        throw new IntegrationError(
          "REMOTE_ATTACHMENT_DIFFERS",
          "A different external attachment already exists. It will not be overwritten.",
          "BLOCKED",
        );
      return { externalId, confirmedAt: new Date() };
    } catch (error) {
      if (
        error instanceof IntegrationError &&
        error.code === "REMOTE_NOT_FOUND"
      )
        return null;
      throw error;
    }
  }
  async attach(
    externalId: string,
    document: {
      bytes: Uint8Array;
      fileName: string;
      mimeType: string;
      sha256: string;
    },
  ) {
    await this.transport.assertWritePermission();
    const existing = await this.reconcileAttachment(
      externalId,
      document.sha256,
    );
    if (existing) return existing;
    const form = new FormData();
    form.set(
      "attachment",
      new Blob([new Uint8Array(document.bytes)], { type: document.mimeType }),
      document.fileName,
    );
    await this.transport.request(`/books/v3/bills/${externalId}/attachment`, {
      method: "POST",
      form,
    });
    let verified: Confirmation | null;
    try {
      verified = await this.reconcileAttachment(externalId, document.sha256);
    } catch {
      throw new IntegrationError(
        "ATTACHMENT_UNCONFIRMED",
        "An attachment may have been uploaded, but confirmation failed. Reconcile before retrying.",
        "UNKNOWN",
      );
    }
    if (!verified)
      throw new IntegrationError(
        "ATTACHMENT_UNCONFIRMED",
        "The remote attachment could not be confirmed after upload.",
        "UNKNOWN",
      );
    return verified;
  }
}
