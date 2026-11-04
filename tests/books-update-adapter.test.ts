import { describe, expect, it, vi } from "vitest";
import { BooksAdapter, buildBooksPayload, type BillSnapshot } from "@/lib/integrations/books";
import type { ZohoConfig } from "@/lib/integrations/config";
import { ZohoTransport } from "@/lib/integrations/transport";
import type { BooksUpdateRemote } from "@/lib/integrations/books-update";

const config: ZohoConfig = { target: "ZOHO", dataCenter: "US", accountsOrigin: "https://accounts.zoho.com", apiOrigin: "https://www.zohoapis.com",
  organizationId: "100", clientId: "fictional-client", clientSecret: "fictional-secret", environment: "production",
  networkEnabled: true, writeEnabled: true, liveRuntime: true,
  booksMapping: { verified: true, baseCurrency: "AED", currencies: { AED: { id: "101" } },
    categories: { MATERIALS: { accountId: "103" } }, taxes: { "5.00": { id: "102", percentage: "5" } } } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function sources() {
  const previous: BillSnapshot = { internalBillId: "fictional-bill", companyId: "fictional-company", initiatedById: "fictional-admin", sourceVersion: 2,
    invoiceNumber: "FIXTURE-EDIT", invoiceDate: "2026-11-04", dueDate: "2026-11-04", orderNumber: null, paymentTerms: "DUE_ON_RECEIPT",
    category: "MATERIALS", currency: "AED", discount: "0.00", vatRate: "5.00", subtotal: "100.00", vatAmount: "5.00", total: "105.00",
    vendorId: "fictional-vendor", externalVendorId: "104", jobId: "fictional-job", jobNumber: "JOB-TEST", externalCrmJobId: null,
    lines: [{ description: "Original material", quantity: "1", unitPrice: "100.00" }],
    documents: [{ id: "fictional-original", sha256: "a".repeat(64), fileName: "original.pdf", mimeType: "application/pdf" }] };
  const notes = buildBooksPayload(previous, config).notes + "\nKeep unrelated supplier instructions.";
  const remote: BooksUpdateRemote = { bill_id: "999", vendor_id: "104", bill_number: previous.invoiceNumber, reference_number: "VX-BILL-fictional-bill",
    currency_code: "AED", total: "105.00", tax_total: "5.00", date: previous.invoiceDate, due_date: previous.dueDate, payment_terms: 0,
    payment_made: "25.00", vendor_credits_applied: "0.00", balance: "80.00", status: "partially_paid", last_modified_time: "2026-11-04T09:00:00Z",
    notes, documents: [{ document_id: "801", file_name: "original.pdf" }],
    line_items: [{ line_item_id: "701", account_id: "103", tax_id: "102", customer_id: "", is_billable: false,
      description: "Original material", quantity: "1", rate: "100.00" }] };
  const desired: BillSnapshot = { ...structuredClone(previous), sourceVersion: 3,
    lines: [{ description: "Corrected material", quantity: "1", unitPrice: "120.00" }], subtotal: "120.00", vatAmount: "6.00", total: "126.00",
    revision: { kind: "UPDATE_BILL", previousJobId: "original-create", previousPayloadHash: "b".repeat(64), externalId: "999",
      paymentSourceHash: "c".repeat(64), documentSourceHash: "d".repeat(64), remoteLineIds: ["701"], remoteDocuments: structuredClone(remote.documents),
      remoteLastModified: remote.last_modified_time, preservedRemoteNotes: notes } };
  return { previous, desired, remote };
}
type Behavior = { loseResponse?: boolean; rejectStatus?: number; confirmationMismatch?: boolean; remote?: Partial<BooksUpdateRemote>; vendorTax?: string;
  customField?: "jobCustomFieldIndex" | "orderCustomFieldIndex" };
function fixture(behavior: Behavior = {}) {
  const { previous, desired, remote } = sources();
  let current: BooksUpdateRemote = { ...remote, ...behavior.remote };
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const path = new URL(input).pathname, method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (path === "/books/v3/organizations/100") return json({ code: 0, organization: { organization_id: "100", is_org_active: true, currency_code: "AED", currency_id: "101" } });
    if (method === "GET" && path === "/books/v3/contacts/104") return json({ code: 0, contact: {
      contact_id: "104", contact_type: "vendor", status: "active", currency_code: "AED", tax_treatment: behavior.vendorTax ?? "vat_registered" } });
    if (path === "/books/v3/bills/999" && method === "GET") return json({ code: 0, bill: current });
    if (path === "/books/v3/bills/999" && method === "PUT") {
      if (behavior.rejectStatus) return json({ code: 14 }, behavior.rejectStatus);
      current = { ...current, total: desired.total, tax_total: desired.vatAmount, balance: "101.00", last_modified_time: "2026-11-04T09:01:00Z",
        line_items: [{ ...current.line_items[0], description: behavior.confirmationMismatch ? "Unexpected text" : "Corrected material", rate: "120.00" }] };
      if (behavior.loseResponse) throw new Error("PRIVATE simulated disconnected response");
      return json({ code: 0, bill: { bill_id: "999" } });
    }
    throw new Error("Unexpected fixture endpoint");
  });
  const guard = vi.fn(async () => undefined);
  const settings = behavior.customField ? { ...config, booksMapping: { ...config.booksMapping!, [behavior.customField]: 1 } } : config;
  const adapter = new BooksAdapter(new ZohoTransport(settings, async () => "FICTIONAL-NOT-A-CREDENTIAL", fetcher, guard));
  return { adapter, previous, desired, calls, guard, setRemote: (value: BooksUpdateRemote) => { current = value; }, getRemote: () => structuredClone(current) };
}

describe("existing bill update and independent provider confirmation", () => {
  it.each(["jobCustomFieldIndex", "orderCustomFieldIndex"] as const)("refuses unverified %s update semantics before contacting Books", async customField => {
    const h = fixture({ customField });
    await expect(h.adapter.update("999", h.desired, h.previous, "25.00")).rejects.toMatchObject({ kind: "BLOCKED" });
    expect(h.calls).toEqual([]);
  });
  it("updates only the exact existing bill, retains original document/line identities, then independently confirms all intended values", async () => {
    const h = fixture();
    await expect(h.adapter.update("999", h.desired, h.previous, "25.00")).resolves.toMatchObject({ externalId: "999" });
    const writes = h.calls.filter(call => call.method !== "GET");
    expect(writes).toHaveLength(1); expect(writes[0]).toMatchObject({ method: "PUT", path: "/books/v3/bills/999" });
    expect(writes[0].body).toMatchObject({ documents: [{ document_id: "801", file_name: "original.pdf" }],
      line_items: [{ line_item_id: "701", account_id: "103", tax_id: "102", description: "Corrected material", quantity: 1, rate: 120 }] });
    expect(writes[0].body?.notes).toBe(h.desired.revision!.preservedRemoteNotes);
    expect(h.calls.at(-1)).toMatchObject({ method: "GET", path: "/books/v3/bills/999" });
    expect(h.getRemote().payment_made).toBe("25.00");
  });
  it("confirms an already-applied desired revision without sending another write", async () => {
    const h = fixture(); await h.adapter.update("999", h.desired, h.previous, "25.00"); h.calls.length = 0;
    await expect(h.adapter.update("999", h.desired, h.previous, "25.00")).resolves.toMatchObject({ externalId: "999" });
    expect(h.calls.every(call => call.method === "GET")).toBe(true);
  });
  it("recovers a lost PUT response with GET-only desired-state reconciliation and no duplicate creation", async () => {
    const h = fixture({ loseResponse: true });
    await expect(h.adapter.update("999", h.desired, h.previous, "25.00")).rejects.toMatchObject({ kind: "UNKNOWN" });
    const before = h.calls.length;
    await expect(h.adapter.reconcileUpdate("999", h.desired)).resolves.toMatchObject({ externalId: "999" });
    expect(h.calls.slice(before).every(call => call.method === "GET")).toBe(true);
    expect(h.calls.filter(call => call.method === "PUT")).toHaveLength(1);
    expect(h.calls.some(call => call.method === "POST")).toBe(false);
  });
  it("keeps an unconfirmed update uncertain instead of claiming success", async () => {
    const h = fixture({ confirmationMismatch: true });
    await expect(h.adapter.update("999", h.desired, h.previous, "25.00")).rejects.toMatchObject({ code: "UPDATE_UNCONFIRMED", kind: "UNKNOWN" });
    await expect(h.adapter.reconcileUpdate("999", h.desired)).resolves.toBeNull();
    expect(h.calls.filter(call => call.method !== "GET")).toHaveLength(1);
  });
  it.each([401, 403, 400])("does not fall back to creation or retry after definite provider rejection %s", async rejectStatus => {
    const h = fixture({ rejectStatus });
    await expect(h.adapter.update("999", h.desired, h.previous, "25.00")).rejects.toMatchObject({ kind: rejectStatus === 400 ? "FAILED" : "BLOCKED" });
    expect(h.calls.filter(call => call.method !== "GET").map(call => call.method)).toEqual(["PUT"]);
    expect(h.getRemote().line_items[0].description).toBe("Original material");
  });
  it.each([
    [{ last_modified_time: "2026-11-04T09:00:01Z" }, "UPDATE_BASELINE_CHANGED"],
    [{ documents: [] }, "UPDATE_BASELINE_CHANGED"],
    [{ is_locked: true }, "UPDATE_BILL_LOCKED"],
    [{ balance: "1.00", payment_made: "104.00" }, "UPDATE_BASELINE_CHANGED"],
  ] as const)("refuses a changed provider baseline before writing %#", async (remote, code) => {
    const h = fixture({ remote: remote as Partial<BooksUpdateRemote> });
    // A payment change is accompanied by the provider's modification stamp.
    if ("balance" in remote) h.setRemote({ ...h.getRemote(), last_modified_time: "2026-11-04T09:00:01Z" });
    await expect(h.adapter.update("999", h.desired, h.previous, "25.00")).rejects.toMatchObject({ code, kind: "BLOCKED" });
    expect(h.calls.every(call => call.method === "GET")).toBe(true);
  });
  it("rechecks the supplier VAT treatment and preserves selected VAT on a mismatch", async () => {
    const h = fixture({ vendorTax: "vat_not_registered" });
    await expect(h.adapter.update("999", h.desired, h.previous, "25.00")).rejects.toMatchObject({ code: "VENDOR_VAT_TREATMENT_MISMATCH", kind: "BLOCKED" });
    expect(h.calls.every(call => call.method === "GET")).toBe(true); expect(h.desired.vatAmount).toBe("6.00");
  });
});
