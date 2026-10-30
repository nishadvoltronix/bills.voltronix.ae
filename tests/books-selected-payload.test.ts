import { describe, expect, it, vi } from "vitest";
import type { BooksSelection } from "@/lib/books-selection";
import { calculateBill } from "@/lib/finance";
import { BooksAdapter, buildBooksPayload, snapshotHash, type BillSnapshot } from "@/lib/integrations/books";
import { booksTestConfigurationHash, type ZohoConfig } from "@/lib/integrations/config";
import { ZohoTransport, type Fetch } from "@/lib/integrations/transport";

const selected: BooksSelection = { organizationId: "100", dataCenter: "US", environment: "sandbox", accountId: "110",
  accountName: "Reviewed labour account", taxId: "120", taxName: "Standard tax", taxRate: "5.00",
  customerId: "130", customerName: "Fictional customer" };
function config(requireSelections = false): ZohoConfig {
  const result: ZohoConfig = { target: "ZOHO", organizationId: "100", dataCenter: "US", environment: "sandbox",
    clientId: "fictional-client", clientSecret: "fictional-secret", apiOrigin: "https://www.zohoapis.com",
    accountsOrigin: "https://accounts.zoho.com", networkEnabled: true, writeEnabled: true,
    booksMapping: { verified: true, baseCurrency: "AED", currencies: { AED: { id: "101" } }, categories: {}, taxes: {},
      ...(requireSelections ? { lineSelectionRequired: true } : {}) } };
  result.testAuthorization = { mode: "nonproduction", organizationId: "100", dataCenter: "US",
    configurationHash: booksTestConfigurationHash(result), approvedBy: "fictional-operator",
    approvalReference: "FIXTURE-100", isolationEvidenceReference: "FIXTURE-ISOLATION-100",
    verifiedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
  return result;
}
function snapshot(): BillSnapshot {
  return { internalBillId: "selected-fixture", companyId: "company", sourceVersion: 1, invoiceNumber: "FICTIONAL-1",
    invoiceDate: "2026-10-29", dueDate: null, orderNumber: null, paymentTerms: "CUSTOM", category: "LABOUR", currency: "AED",
    discount: "0.00", vatRate: "5.00", subtotal: "100.00", vatAmount: "5.00", total: "105.00", vendorId: "local-vendor",
    externalVendorId: "104", jobId: "job", jobNumber: "FICTIONAL-JOB", externalCrmJobId: null,
    lines: [{ description: "Reviewed line", quantity: "1", unitPrice: "100.00", booksSelection: selected }], documents: [] };
}
function adapter(overrides: Record<string, unknown> = {}, requireSelections = false) {
  const read = snapshot();
  const remote = { code: 0, bill: { bill_id: "999", bill_number: read.invoiceNumber, vendor_id: "104",
    reference_number: "VX-BILL-selected-fixture", currency_code: "AED", total: "105.00", tax_total: "5.00",
    line_items: [{ account_id: "110", tax_id: "120", customer_id: "130", is_billable: false,
      description: "Reviewed line", quantity: 1, rate: 100 }] } };
  const rows: Record<string, unknown> = {
    "/books/v3/organizations/100": { code: 0, organization: { organization_id: "100", is_org_active: true, currency_code: "AED", currency_id: "101" } },
    "/books/v3/bills": { code: 0, bills: [], page_context: { has_more_page: false } },
    "/books/v3/chartofaccounts/110": { code: 0, chart_of_account: { account_id: "110", account_type: "expense", is_active: true } },
    "/books/v3/settings/taxes/120": { code: 0, tax: { tax_id: "120", tax_type: "tax", tax_percentage: 5, status: "Active" } },
    "/books/v3/contacts/130": { code: 0, contact: { contact_id: "130", contact_type: "customer", status: "active", currency_code: "USD" } },
    "/books/v3/contacts/104": { code: 0, contact: { contact_id: "104", contact_type: "vendor", status: "active", currency_code: "AED" } },
    "/books/v3/bills/999": remote, ...overrides,
  };
  const fetcher = vi.fn<Fetch>(async (url, options) => {
    const parsed = new URL(url);
    expect(parsed.searchParams.get("organization_id")).toBe("100");
    if (options?.method === "POST") {
      expect(parsed.pathname).toBe("/books/v3/bills");
      return new Response(JSON.stringify({ code: 0, bill: { bill_id: "999" } }));
    }
    if (!(parsed.pathname in rows)) throw new Error("Unexpected provider fixture request");
    return new Response(JSON.stringify(rows[parsed.pathname]));
  });
  return { adapter: new BooksAdapter(new ZohoTransport(config(requireSelections), async () => "fictional-token", fetcher)), fetcher, remote };
}

describe("explicit Books line payload and metadata changes", () => {
  it.each(["missing", "mixed", "empty"])("blocks %s required line selections before any provider request", async kind => {
    const value = snapshot();
    const unselected = { description: "Unselected purchase", quantity: "1", unitPrice: "100.00" };
    value.lines = kind === "missing" ? [unselected] : kind === "mixed" ? [...value.lines, unselected] : [];
    const fixture = adapter({}, true);
    await expect(fixture.adapter.create(value)).rejects.toMatchObject({ code: "LINE_SELECTION_REQUIRED", kind: "BLOCKED" });
    expect(fixture.fetcher).not.toHaveBeenCalled();
  });
  it("rejects mixed selection and fallback lines even under the legacy mapping mode", () => {
    const value = snapshot();
    value.lines.push({ description: "Unselected purchase", quantity: "1", unitPrice: "100" });
    expect(() => buildBooksPayload(value, config())).toThrowError(expect.objectContaining({ code: "LINE_SELECTION_REQUIRED" }));
  });
  it("revalidates a selected asset account and simple tax in required mode before creating the exact bill", async () => {
    const fixture = adapter({ "/books/v3/chartofaccounts/110": {
      code: 0, chart_of_account: { account_id: "110", account_type: "fixed_asset", is_active: true },
    } }, true);
    await expect(fixture.adapter.create(snapshot())).resolves.toMatchObject({ externalId: "999" });
    const requests = fixture.fetcher.mock.calls;
    expect(requests.some(call => new URL(call[0]).pathname === "/books/v3/chartofaccounts/110")).toBe(true);
    expect(requests.some(call => new URL(call[0]).pathname === "/books/v3/settings/taxes/120")).toBe(true);
    const posts = requests.filter(call => call[1]?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0][1]!.body as string).line_items[0]).toMatchObject({ account_id: "110", tax_id: "120" });
  });
  it("uses an explicit labour account, tax and nonbillable customer without a category fallback", () => {
    const payload = buildBooksPayload(snapshot(), config());
    expect(payload).toMatchObject({ is_item_level_tax_calc: false, line_items: [{ account_id: "110", tax_id: "120", customer_id: "130", is_billable: false }] });
    expect(payload.line_items[0]).not.toHaveProperty("item_id");
    const legacy = { ...snapshot(), lines: snapshot().lines.map(({ booksSelection, ...line }) => { void booksSelection; return line; }) };
    expect(() => buildBooksPayload(legacy, config())).toThrow(/mapping/);
  });
  it.each([{ organizationId: "200" }, { dataCenter: "EU" }, { environment: "production" }])(
    "refuses a line selected in a different destination %j", (change) => {
      const value = snapshot();
      value.lines[0].booksSelection = { ...selected, ...change } as BooksSelection;
      expect(() => buildBooksPayload(value, config())).toThrowError(expect.objectContaining({ code: "LINE_DESTINATION_MISMATCH" }));
    });
  it("requires frozen selected tax totals to match the complete line calculation", () => {
    const value = snapshot();
    value.lines.push({ ...value.lines[0], booksSelection: { ...selected, taxId: "121", taxRate: "0.00", customerId: null, customerName: null } });
    const totals = calculateBill(value.lines);
    Object.assign(value, { subtotal: totals.subtotal, vatAmount: totals.vatAmount, total: totals.total, vatRate: totals.vatRate });
    expect(buildBooksPayload(value, config()).line_items.map((line) => line.tax_id)).toEqual(["120", "121"]);
    value.vatAmount = "10.00";
    expect(() => buildBooksPayload(value, config())).toThrowError(expect.objectContaining({ code: "LOCAL_TOTAL_MISMATCH" }));
  });
  it("includes all selected IDs and rates in the immutable snapshot hash", () => {
    const original = snapshotHash(snapshot());
    for (const change of [{ accountId: "111" }, { taxId: "121" }, { taxRate: "0.00" }, { customerId: "131" }]) {
      const value = snapshot();
      value.lines[0].booksSelection = { ...selected, ...change };
      expect(snapshotHash(value)).not.toBe(original);
    }
    const reordered = JSON.parse(JSON.stringify(snapshot()));
    reordered.lines[0].booksSelection = Object.fromEntries(Object.entries(selected).reverse());
    expect(snapshotHash(reordered)).toBe(original);
  });
  it.each([
    ["inactive account", "/books/v3/chartofaccounts/110", { code: 0, chart_of_account: { account_id: "110", account_type: "expense", is_active: false } }],
    ["invalid flat account envelope", "/books/v3/chartofaccounts/110", { code: 0, account_id: "110", account_type: "expense", is_active: true }],
    ["changed tax rate", "/books/v3/settings/taxes/120", { code: 0, tax: { tax_id: "120", tax_type: "tax", tax_percentage: 10 } }],
    ["inactive tax status", "/books/v3/settings/taxes/120", { code: 0, tax: { tax_id: "120", tax_type: "tax", tax_percentage: 5, status: "Inactive" } }],
    ["unknown tax status", "/books/v3/settings/taxes/120", { code: 0, tax: { tax_id: "120", tax_type: "tax", tax_percentage: 5, status: "Unrecognized" } }],
    ["inactive customer", "/books/v3/contacts/130", { code: 0, contact: { contact_id: "130", contact_type: "customer", status: "inactive", currency_code: "AED" } }],
  ])("blocks %s before any provider POST", async (_label, path, value) => {
    const fixture = adapter({ [path as string]: value });
    await expect(fixture.adapter.create(snapshot())).rejects.toMatchObject({ code: "LINE_SELECTION_CHANGED", kind: "BLOCKED" });
    expect(fixture.fetcher.mock.calls.every((call) => call[1]?.method === "GET")).toBe(true);
  });
  it("rechecks metadata, sends only selected IDs and confirms remote line allocations", async () => {
    const fixture = adapter();
    await expect(fixture.adapter.create(snapshot())).resolves.toMatchObject({ externalId: "999" });
    const posts = fixture.fetcher.mock.calls.filter((call) => call[1]?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0][1]!.body as string).line_items[0]).toMatchObject({ account_id: "110", tax_id: "120", customer_id: "130", is_billable: false });
  });
  it("does not claim confirmation when remote allocation differs despite matching totals", async () => {
    const fixture = adapter();
    fixture.remote.bill.line_items[0].customer_id = "9999";
    await expect(fixture.adapter.create(snapshot())).rejects.toMatchObject({ code: "CREATE_UNCONFIRMED", kind: "UNKNOWN" });
    expect(fixture.fetcher.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
  });
});
