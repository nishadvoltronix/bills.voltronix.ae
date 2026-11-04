import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOOKS_NO_VAT, type BooksSelection } from "@/lib/books-selection";
import { BooksAdapter, buildBooksPayload, type BillSnapshot } from "@/lib/integrations/books";
import { hasBooksVendorTaxConflict } from "@/lib/integrations/books-vendor-tax";
import { booksTestConfigurationHash, type ZohoConfig } from "@/lib/integrations/config";
import { ZohoTransport } from "@/lib/integrations/transport";

beforeEach(() => vi.stubEnv("ZOHO_BOOKS_ORGANIZATIONS_JSON", ""));
afterEach(() => vi.unstubAllEnvs());

function config(): ZohoConfig {
  const result: ZohoConfig = {
    target: "ZOHO", dataCenter: "US", accountsOrigin: "https://accounts.zoho.com",
    apiOrigin: "https://www.zohoapis.com", organizationId: "100", clientId: "fictional-client",
    clientSecret: "fictional-secret", environment: "sandbox", networkEnabled: true, writeEnabled: true,
    booksMapping: {
      verified: true, baseCurrency: "AED", currencies: { AED: { id: "101" } },
      taxes: { "5.00": { id: "102", percentage: "5" }, "0.00": { id: "106", percentage: "0" } },
      categories: { MATERIALS: { accountId: "103" } },
    },
  };
  result.testAuthorization = {
    mode: "nonproduction", organizationId: result.organizationId, dataCenter: result.dataCenter,
    configurationHash: booksTestConfigurationHash(result), approvedBy: "fictional-test-operator",
    approvalReference: "fixture-approval-100", isolationEvidenceReference: "fixture-isolation-100",
    verifiedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(),
  };
  return result;
}

function snapshot(tax?: "standard" | "zero" | "none"): BillSnapshot {
  const zero = tax === "zero" || tax === "none";
  const selection: BooksSelection | undefined = tax ? {
    organizationId: "100", dataCenter: "US", environment: "sandbox", accountId: "103", accountName: "Materials",
    taxId: tax === "none" ? BOOKS_NO_VAT : zero ? "106" : "102",
    taxName: tax === "none" ? "No VAT" : zero ? "Zero Rate" : "Standard Rate", taxRate: zero ? "0.00" : "5.00",
    customerId: null, customerName: null,
  } : undefined;
  return {
    internalBillId: "fictional-vat-bill", sourceVersion: 2, invoiceNumber: "VAT-FIXTURE-1",
    invoiceDate: "2026-11-04", dueDate: null, orderNumber: null, paymentTerms: "NET_30",
    category: "MATERIALS", currency: "AED", discount: "0.00", vatRate: zero ? "0.00" : "5.00",
    subtotal: "100.00", vatAmount: zero ? "0.00" : "5.00", total: zero ? "100.00" : "105.00",
    vendorId: "local-vendor", externalVendorId: "104", jobId: "local-job", jobNumber: "FIXTURE-JOB",
    externalCrmJobId: "105", documents: [],
    lines: [{ description: "Fictional materials", quantity: "2", unitPrice: "50.00", ...(selection ? { booksSelection: selection } : {}) }],
  };
}

function fixture(source: BillSnapshot, options: {
  taxTreatment?: unknown; contact?: Record<string, unknown>; existing?: boolean; incompleteSearch?: boolean;
} = {}) {
  const settings = config();
  const payload = buildBooksPayload(source, settings);
  const remote = {
    bill_id: "999", bill_number: source.invoiceNumber, vendor_id: source.externalVendorId,
    reference_number: payload.reference_number, currency_code: source.currency,
    total: source.total, tax_total: source.vatAmount, line_items: payload.line_items,
  };
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const path = new URL(input).pathname;
    if (path === "/books/v3/organizations/100") return json({ code: 0, organization: {
      organization_id: "100", is_org_active: true, currency_code: "AED", currency_id: "101",
    } });
    if (path === "/books/v3/bills" && init?.method === "GET") return json({ code: 0,
      bills: options.existing ? [{ bill_id: "999", reference_number: remote.reference_number }] : [],
      page_context: { has_more_page: options.incompleteSearch ?? false },
    });
    if (path === "/books/v3/contacts/104") return json({ code: 0, contact: {
      contact_id: "104", contact_type: "vendor", currency_code: "AED", status: "active",
      tax_treatment: options.taxTreatment, ...options.contact,
    } });
    if (path === "/books/v3/chartofaccounts/103") return json({ code: 0, chart_of_account: {
      account_id: "103", is_active: true, account_type: "expense",
    } });
    if (path === "/books/v3/settings/taxes/102" || path === "/books/v3/settings/taxes/106") return json({ code: 0, tax: {
      tax_id: path.endsWith("/102") ? "102" : "106", tax_type: "tax", is_active: true,
      tax_percentage: path.endsWith("/102") ? 5 : 0,
    } });
    if (path === "/books/v3/bills" && init?.method === "POST") return json({ code: 0, bill: { bill_id: "999" } });
    if (path === "/books/v3/bills/999") return json({ code: 0, bill: remote });
    throw new Error(`Unexpected fictional endpoint: ${path}`);
  });
  return { adapter: new BooksAdapter(new ZohoTransport(settings, async () => "fictional-token", fetcher)), fetcher,
    posts: () => fetcher.mock.calls.filter(([, init]) => init?.method === "POST"),
    contactReads: () => fetcher.mock.calls.filter(([url]) => new URL(url).pathname === "/books/v3/contacts/104"),
  };
}

describe("Books supplier VAT compatibility", () => {
  it("treats every explicit tax ID, including zero rate and mixed No VAT lines, as a VAT selection", () => {
    expect(hasBooksVendorTaxConflict("vat_not_registered", [{ tax_id: "102" }])).toBe(true);
    expect(hasBooksVendorTaxConflict("vat_not_registered", [{}, { tax_id: "106" }])).toBe(true);
    expect(hasBooksVendorTaxConflict("vat_not_registered", [{ tax_id: "0" }])).toBe(true);
    expect(hasBooksVendorTaxConflict("vat_not_registered", [{}, { tax_id: null }])).toBe(false);
  });

  it.each([undefined, null, "vat_registered", "gcc_vat_registered", "unknown", { private: "metadata" }])(
    "does not infer VAT status from unknown treatment %j", (treatment) => {
      expect(hasBooksVendorTaxConflict(treatment, [{ tax_id: "102" }])).toBe(false);
    },
  );

  it.each([undefined, "standard", "zero"] as const)(
    "blocks the known supplier conflict for %s selection before any financial POST without changing the source", async (tax) => {
      const source = snapshot(tax);
      const original = JSON.stringify(source);
      const remote = fixture(source, { taxTreatment: "vat_not_registered" });
      await expect(remote.adapter.create(source)).rejects.toMatchObject({
        code: "VENDOR_VAT_TREATMENT_MISMATCH", kind: "BLOCKED",
        message: expect.stringMatching(/original invoice.*Keep valid invoice VAT.*administrator.*Choose No VAT only/),
      });
      expect(remote.posts()).toHaveLength(0);
      expect(remote.contactReads()).toHaveLength(1);
      expect(JSON.stringify(source)).toBe(original);
    },
  );

  it("also blocks a legacy category mapping whose selected zero-rate tax would be sent", async () => {
    const source = { ...snapshot(), vatRate: "0.00", vatAmount: "0.00", total: "100.00" };
    const remote = fixture(source, { taxTreatment: "vat_not_registered" });
    await expect(remote.adapter.create(source)).rejects.toMatchObject({ code: "VENDOR_VAT_TREATMENT_MISMATCH", kind: "BLOCKED" });
    expect(remote.posts()).toHaveLength(0);
  });

  it("allows an explicit No VAT bill and sends no tax ID", async () => {
    const source = snapshot("none");
    const remote = fixture(source, { taxTreatment: "vat_not_registered" });
    await expect(remote.adapter.create(source)).resolves.toMatchObject({ externalId: "999" });
    expect(remote.posts()).toHaveLength(1);
    const payload = JSON.parse(remote.posts()[0][1]!.body as string);
    expect(payload.line_items[0]).not.toHaveProperty("tax_id");
    expect(payload.vendor_id).toBe("104");
    expect(source.lines[0].booksSelection!.taxId).toBe(BOOKS_NO_VAT);
  });

  it.each(["vat_registered", undefined])("preserves accepted VAT selections when treatment is %s", async (taxTreatment) => {
    const source = snapshot("standard");
    const remote = fixture(source, { taxTreatment, contact: { tax_reg_no: "" } });
    await expect(remote.adapter.create(source)).resolves.toMatchObject({ externalId: "999" });
    expect(remote.posts()).toHaveLength(1);
    expect(JSON.parse(remote.posts()[0][1]!.body as string).line_items[0].tax_id).toBe("102");
    expect(source.vatAmount).toBe("5.00");
  });

  it("confirms an existing canonical bill before checking current supplier classification and never posts again", async () => {
    const remote = fixture(snapshot("standard"), { taxTreatment: "vat_not_registered", existing: true });
    await expect(remote.adapter.create(snapshot("standard"))).resolves.toMatchObject({ externalId: "999" });
    expect(remote.contactReads()).toHaveLength(0);
    expect(remote.posts()).toHaveLength(0);
  });

  it("preserves the UNKNOWN reconciliation guard before any supplier check or POST", async () => {
    const remote = fixture(snapshot(), { taxTreatment: "vat_not_registered", existing: true, incompleteSearch: true });
    await expect(remote.adapter.create(snapshot())).rejects.toMatchObject({ code: "DUPLICATE_REMOTE_REFERENCE", kind: "UNKNOWN" });
    expect(remote.contactReads()).toHaveLength(0);
    expect(remote.posts()).toHaveLength(0);
  });

  it.each([{ contact_id: "9999" }, { currency_code: "USD" }, { contact_type: "customer" }, { status: "inactive" }])(
    "preserves vendor identity and currency guards before VAT classification %j", async (contact) => {
      const remote = fixture(snapshot(), { taxTreatment: "vat_not_registered", contact });
      await expect(remote.adapter.create(snapshot())).rejects.toMatchObject({ code: "VENDOR_MAPPING_MISMATCH", kind: "BLOCKED" });
      expect(remote.posts()).toHaveLength(0);
    },
  );
});
