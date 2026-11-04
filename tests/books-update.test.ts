import { describe, expect, it } from "vitest";
import { buildBooksPayload, type BillSnapshot } from "@/lib/integrations/books";
import type { ZohoConfig } from "@/lib/integrations/config";
import { assertBooksUpdateBaseline, assertBooksUpdateMoney, booksRemoteAppliedAmount, booksRemoteMatchesPayload,
  booksUpdateTerms, reviewedBooksUpdateNotes, buildBooksUpdatePayload, parseBooksUpdateRemote, type BooksUpdateRemote } from "@/lib/integrations/books-update";

const blocked = (code: string) => expect.objectContaining({ code, kind: "BLOCKED" });
const config: ZohoConfig = { target: "ZOHO", dataCenter: "US", accountsOrigin: "https://accounts.zoho.com", apiOrigin: "https://www.zohoapis.com",
  organizationId: "1001", clientId: "fictional-client", clientSecret: "fictional-secret", environment: "production", networkEnabled: false, writeEnabled: false,
  booksMapping: { verified: true, baseCurrency: "AED", currencies: { AED: { id: "101" } }, categories: { MATERIALS: { accountId: "301" } }, taxes: { "5.00": { id: "401", percentage: "5" } } } };
function snapshot(): BillSnapshot {
  return { internalBillId: "bill", companyId: "company", initiatedById: "admin", sourceVersion: 5,
    invoiceNumber: "INV-EDIT", invoiceDate: "2026-11-04", dueDate: "2026-11-20", orderNumber: null, paymentTerms: "CUSTOM",
    category: "MATERIALS", currency: "AED", discount: "0.00", vatRate: "5.00", subtotal: "100.00", vatAmount: "5.00", total: "105.00",
    vendorId: "supplier", externalVendorId: "2001", jobId: "job", jobNumber: "JOB-5367", externalCrmJobId: null,
    lines: [{ description: "First material", quantity: "1", unitPrice: "50.00" }, { description: "Second material", quantity: "1", unitPrice: "50.00" }],
    documents: [{ id: "private-original", sha256: "d".repeat(64), fileName: "original.pdf", mimeType: "application/pdf" }],
    revision: { kind: "UPDATE_BILL", previousJobId: "previous-operation", previousPayloadHash: "a".repeat(64), externalId: "9001",
      paymentSourceHash: "b".repeat(64), documentSourceHash: "c".repeat(64), remoteLineIds: ["701", "702"],
      remoteDocuments: [{ document_id: "801", file_name: "original.pdf" }], remoteLastModified: "2026-11-04T08:00:00Z",
      preservedRemoteNotes: "VOLTRONIX internal bill bill; job JOB-5367.\nKeep this supplier note." } };
}
function remote(changed: Partial<BooksUpdateRemote> = {}): BooksUpdateRemote {
  return { bill_id: "9001", vendor_id: "2001", bill_number: "INV-EDIT", reference_number: "VX-BILL-bill", currency_code: "AED",
    total: "105.00", tax_total: "5.00", date: "2026-11-04", due_date: "2026-11-20", payment_made: "40.00", vendor_credits_applied: "10.00", balance: "55.00",
    last_modified_time: "2026-11-04T08:00:00Z", status: "open", payment_terms: 16,
    notes: "VOLTRONIX internal bill bill; job JOB-5367.\nKeep this supplier note.", documents: [{ document_id: "801", file_name: "original.pdf" }],
    line_items: [{ line_item_id: "701", account_id: "301", tax_id: "401", description: "First material", quantity: "1", rate: "50.00", is_billable: false },
      { line_item_id: "702", account_id: "301", tax_id: "401", description: "Second material", quantity: "1", rate: "50.00", is_billable: false }], ...changed };
}

describe("verified remote update identity and attachment evidence", () => {
  it("requires the exact external bill and an explicit document array", () => {
    expect(parseBooksUpdateRemote({ code: 0, bill: remote() }, "9001").bill_id).toBe("9001");
    expect(() => parseBooksUpdateRemote({ code: 0, bill: remote() }, "9999")).toThrow(blocked("UPDATE_REMOTE_UNVERIFIED"));
    expect(() => parseBooksUpdateRemote({ code: 0, bill: { ...remote(), documents: undefined } }, "9001")).toThrow(blocked("UPDATE_REMOTE_UNVERIFIED"));
    expect(() => parseBooksUpdateRemote({ code: 0, bill: remote({ documents: [] }) }, "9001")).not.toThrow();
  });
  it.each([
    { code: 1, bill: remote() }, { code: 0, bill: { ...remote(), bill_id: "invalid" } },
    { code: 0, bill: { ...remote(), line_items: [{ ...remote().line_items[0], line_item_id: undefined }] } },
    { code: 0, bill: { ...remote(), documents: [{ document_id: Number.MAX_SAFE_INTEGER + 1 }] } },
    { code: 0, bill: { ...remote(), last_modified_time: "" } },
    { code: 0, bill: { ...remote(), line_items: [remote().line_items[0], remote().line_items[0]] } },
    { code: 0, bill: { ...remote(), documents: [remote().documents[0], remote().documents[0]] } },
  ])("rejects malformed update evidence %#", value => {
    expect(() => parseBooksUpdateRemote(value, "9001")).toThrow(blocked("UPDATE_REMOTE_UNVERIFIED"));
  });
  it("binds the complete original line identities, documents and modification stamp", () => {
    expect(() => assertBooksUpdateBaseline(remote(), snapshot())).not.toThrow();
    for (const changed of [remote({ bill_id: "9002" }), remote({ last_modified_time: "2026-11-04T09:00:00Z" }),
      remote({ documents: [] }), remote({ documents: [{ document_id: "802", file_name: "different.pdf" }] }),
      remote({ line_items: [...remote().line_items].reverse() })])
      expect(() => assertBooksUpdateBaseline(changed, snapshot())).toThrow(blocked("UPDATE_BASELINE_CHANGED"));
  });
});

describe("provider payment and credit floors without payment mutations", () => {
  it("reconciles payments plus credits with balance, or uses either complete evidence source", () => {
    expect(booksRemoteAppliedAmount(remote())).toBe("50.00");
    expect(booksRemoteAppliedAmount(remote({ balance: undefined }))).toBe("50.00");
    expect(booksRemoteAppliedAmount(remote({ payment_made: undefined, vendor_credits_applied: undefined }))).toBe("50.00");
    expect(booksRemoteAppliedAmount(remote({ payment_made: "0", vendor_credits_applied: "0", balance: "105" }))).toBe("0.00");
  });
  it.each([
    { payment_made: undefined, vendor_credits_applied: undefined, balance: undefined },
    { payment_made: "40", vendor_credits_applied: undefined, balance: undefined },
    { payment_made: "-1", vendor_credits_applied: "0", balance: undefined },
    { payment_made: "-1", vendor_credits_applied: undefined, balance: "105" },
    { payment_made: undefined, vendor_credits_applied: "-1", balance: "105" },
    { payment_made: "60", vendor_credits_applied: undefined, balance: "55" },
    { payment_made: "40", vendor_credits_applied: "10", balance: "60" },
    { balance: "-1" }, { balance: "106" }, { payment_made: "100", vendor_credits_applied: "10", balance: undefined },
    { payment_made: "0.001", vendor_credits_applied: "0", balance: undefined }, { balance: "55.001" },
  ])("refuses missing, negative or conflicting applied-money evidence %#", changed => {
    expect(() => booksRemoteAppliedAmount(remote(changed))).toThrow(blocked("UPDATE_PAYMENTS_UNVERIFIED"));
  });
  it("rejects a new total below either local paid amount or provider applied amount", () => {
    expect(() => assertBooksUpdateMoney(remote(), { ...snapshot(), total: "49.99" }, "0.00")).toThrow(blocked("UPDATE_BELOW_PAID_AMOUNT"));
    expect(() => assertBooksUpdateMoney(remote(), { ...snapshot(), total: "60.00" }, "60.01")).toThrow(blocked("UPDATE_BELOW_PAID_AMOUNT"));
    expect(() => assertBooksUpdateMoney(remote(), snapshot(), "105.00")).not.toThrow();
  });
  it("refuses supplier changes on a paid/credited provider bill but allows verified zero-applied cases", () => {
    const desired = { ...snapshot(), externalVendorId: "2002" };
    expect(() => assertBooksUpdateMoney(remote(), desired, "0")).toThrow(blocked("UPDATE_PAID_VENDOR_CHANGE"));
    expect(() => assertBooksUpdateMoney(remote({ payment_made: "0", vendor_credits_applied: "0", balance: "105" }), desired, "0")).not.toThrow();
  });
  it.each([remote({ status: "void" }), remote({ is_locked: true }), remote({ is_line_item_invoiced: true }),
    remote({ line_items: [{ ...remote().line_items[0], is_invoiced: true }] }), remote({ line_items: [{ ...remote().line_items[0], purchaseorder_item_id: "purchase-order-line" }] })])("refuses locked or linked provider accounting %#", value => {
    expect(() => assertBooksUpdateMoney(value, snapshot(), "0")).toThrow(blocked("UPDATE_BILL_LOCKED"));
  });
});

describe("full reviewed update payload and independent confirmation", () => {
  it("carries all intended lines, retained remote IDs and original document identities without mutating the snapshot", () => {
    const desired = snapshot(), before = JSON.stringify(desired), payload = buildBooksUpdatePayload(desired, buildBooksPayload(desired, config));
    expect(payload.documents).toEqual(desired.revision!.remoteDocuments);
    expect(payload.line_items.map(line => line.line_item_id)).toEqual(["701", "702"]);
    expect(payload.line_items.map(line => line.description)).toEqual(["First material", "Second material"]);
    expect(JSON.stringify(desired)).toBe(before);
    expect(booksRemoteMatchesPayload(remote(), desired, payload)).toBe(true);
  });
  it("adds provider-generated IDs only for appended lines and permits explicitly reviewed line deletion", () => {
    const added = snapshot(); added.lines.push({ description: "Third material", quantity: "1", unitPrice: "50" });
    Object.assign(added, { subtotal: "150", vatAmount: "7.50", total: "157.50" });
    const addPayload = buildBooksUpdatePayload(added, buildBooksPayload(added, config));
    expect(addPayload.line_items.map(line => line.line_item_id)).toEqual(["701", "702", undefined]);
    const removed = snapshot(); removed.lines = removed.lines.slice(0, 1); Object.assign(removed, { subtotal: "50", vatAmount: "2.50", total: "52.50" });
    const removePayload = buildBooksUpdatePayload(removed, buildBooksPayload(removed, config));
    expect(removePayload.line_items).toHaveLength(1); expect(removePayload.line_items[0].line_item_id).toBe("701");
  });
  it("requires an explicit saved update revision", () => {
    const desired = snapshot(); delete desired.revision;
    expect(() => buildBooksUpdatePayload(desired, buildBooksPayload(desired, config))).toThrow(blocked("UPDATE_REVISION_REQUIRED"));
  });
  it("requires reviewed notes instead of silently overwriting unrelated provider notes", () => {
    const desired = snapshot(); delete desired.revision!.preservedRemoteNotes;
    expect(() => buildBooksUpdatePayload(desired, buildBooksPayload(desired, config))).toThrow(blocked("UPDATE_NOTES_UNVERIFIED"));
  });
  it("explicitly clears No VAT/customer fields and verifies the provider's empty or omitted forms", () => {
    const desired = snapshot(); Object.assign(desired, { vatRate: "0.00", vatAmount: "0.00", total: "100.00" });
    desired.lines = desired.lines.map(line => ({ ...line, booksSelection: { organizationId: "1001", dataCenter: "US", environment: "production",
      accountId: "301", accountName: "Materials", taxId: "NO_VAT", taxName: "No VAT", taxRate: "0.00", customerId: null, customerName: null } }));
    const payload = buildBooksUpdatePayload(desired, buildBooksPayload(desired, config));
    expect(payload.line_items.every(line => line.tax_id === "" && line.customer_id === "" && line.is_billable === false)).toBe(true);
    for (const tax_id of [undefined, null, ""]) expect(booksRemoteMatchesPayload(remote({ total: "100.00", tax_total: "0.00",
      line_items: remote().line_items.map(line => ({ ...line, tax_id, customer_id: tax_id })) }), desired, payload)).toBe(true);
  });
  it.each([
    remote({ vendor_id: "2002" }), remote({ bill_number: "OTHER" }), remote({ reference_number: "OTHER" }), remote({ currency_code: "USD" }),
    remote({ total: "104.99" }), remote({ tax_total: "4.99" }), remote({ date: "2026-11-03" }), remote({ due_date: "2026-12-01" }),
    remote({ payment_terms: 30 }), remote({ payment_terms: undefined }), remote({ notes: "Changed provider notes" }),
    remote({ line_items: [{ ...remote().line_items[0], line_item_id: "different-retained-id" }, remote().line_items[1]] }),
    remote({ line_items: [{ ...remote().line_items[0], account_id: "999" }, remote().line_items[1]] }),
    remote({ line_items: [{ ...remote().line_items[0], tax_id: "999" }, remote().line_items[1]] }),
    remote({ line_items: [{ ...remote().line_items[0], customer_id: "999" }, remote().line_items[1]] }),
    remote({ line_items: [{ ...remote().line_items[0], description: "Changed" }, remote().line_items[1]] }),
    remote({ line_items: [{ ...remote().line_items[0], quantity: "2" }, remote().line_items[1]] }),
    remote({ line_items: [{ ...remote().line_items[0], rate: "49" }, remote().line_items[1]] }),
    remote({ line_items: remote().line_items.slice(0, 1) }),
  ])("does not confirm mismatched desired fields or retained line identity %#", changed => {
    const desired = snapshot(), payload = buildBooksUpdatePayload(desired, buildBooksPayload(desired, config));
    expect(booksRemoteMatchesPayload(changed, desired, payload)).toBe(false);
  });
});

describe("reviewed payment terms and owned order-reference notes", () => {
  it("accepts unowned legacy CUSTOM/null provider terms as the old baseline while strictly checking the reviewed replacement", () => {
    const previous = { ...snapshot(), dueDate: null, paymentTerms: "CUSTOM", revision: undefined };
    const existing = remote({ due_date: "2026-12-04", payment_terms: 30 });
    expect(booksRemoteMatchesPayload(existing, previous, buildBooksPayload(previous, config))).toBe(true);
    const desired = snapshot(), payload = buildBooksUpdatePayload(desired, buildBooksPayload(desired, config));
    expect(booksRemoteMatchesPayload(existing, desired, payload)).toBe(false);
    expect(booksRemoteMatchesPayload(remote(), desired, payload)).toBe(true);
  });
  it("derives exact payment terms from explicit due dates and preserves known legacy terms without a saved due date", () => {
    expect(booksUpdateTerms(snapshot())).toEqual({ due_date: "2026-11-20", payment_terms: 16 });
    expect(booksUpdateTerms({ ...snapshot(), dueDate: null, paymentTerms: "NET_30" })).toEqual({ due_date: "2026-12-04", payment_terms: 30 });
    expect(booksUpdateTerms({ ...snapshot(), dueDate: null, paymentTerms: "DUE_ON_RECEIPT" })).toEqual({ due_date: "2026-11-04", payment_terms: 0 });
    expect(() => booksUpdateTerms({ ...snapshot(), dueDate: "invalid-date" })).toThrow(blocked("UPDATE_DUE_DATE_UNVERIFIED"));
  });
  it.each(["CUSTOM", "UNSUPPORTED", "NET_90"])("refuses ambiguous missing due dates for %s without changing provider terms", paymentTerms => {
    expect(() => booksUpdateTerms({ ...snapshot(), dueDate: null, paymentTerms })).toThrow(blocked("UPDATE_DUE_DATE_UNVERIFIED"));
  });
  it("uses validated UTC calendar days across a leap-year boundary", () => {
    expect(booksUpdateTerms({ ...snapshot(), invoiceDate: "2028-02-28", dueDate: null, paymentTerms: "NET_7" }))
      .toEqual({ due_date: "2028-03-06", payment_terms: 7 });
    expect(() => booksUpdateTerms({ ...snapshot(), invoiceDate: "2026-02-30", dueDate: null, paymentTerms: "NET_30" })).toThrow(blocked("UPDATE_DUE_DATE_UNVERIFIED"));
    expect(() => booksUpdateTerms({ ...snapshot(), dueDate: "2026-11-03" })).toThrow(blocked("UPDATE_DUE_DATE_UNVERIFIED"));
  });
  it("updates only the exact owned prefix and preserves every unrelated suffix character", () => {
    const previous = "Owned old order.", desired = "Owned new order.", suffix = "\nSupplier's reference stays unchanged.\n";
    expect(reviewedBooksUpdateNotes(previous, desired, previous + suffix)).toBe(desired + suffix);
    expect(reviewedBooksUpdateNotes(previous, previous, "Entirely unrelated existing notes")).toBe("Entirely unrelated existing notes");
  });
  it.each([undefined, "Not the owned prefix", "x".repeat(10001)])("refuses unreviewed or unowned notes when the owned prefix changes %#", notes => {
    expect(() => reviewedBooksUpdateNotes("Owned old order.", "Owned new order.", notes)).toThrow(blocked("UPDATE_NOTES_UNVERIFIED"));
  });
});
