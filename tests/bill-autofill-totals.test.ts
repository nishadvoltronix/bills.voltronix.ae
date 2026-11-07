import { describe, expect, it } from "vitest";
import { compareAutofillAmounts, fillUnsetAutofillTax } from "@/lib/bill-autofill-totals";

const catalog = { companyId: "company-a", organizationId: "123", dataCenter: "US" as const, environment: "production" as const,
  warning: null, taxes: [{ id: "456", name: "Standard VAT", rate: "5.00", selectable: true },
    { id: "789", name: "Zero Rate", rate: "0.00", selectable: true },
    { id: "NO_VAT", name: "No VAT", rate: "0.00", selectable: true }] };
const draft = { accountId: "111", accountName: "Materials", customerId: null, customerName: null };
const printed = { subtotal: "750", discount: "0", vatAmount: "37.50", total: "787.50" };
const zero = { subtotal: "750.00", discount: "0.00", vatAmount: "0.00", total: "750.00" };

describe("printed invoice amount comparison", () => {
  it("detects a net750 plus37.50VAT invoice being reduced to750 by a zero line tax", () => {
    expect(compareAutofillAmounts(printed, zero)).toEqual({ blocking: true, differences: [
      { key: "vatAmount", label: "VAT", printed: "37.50", calculated: "0.00", difference: "37.50", roundingOnly: false },
      { key: "total", label: "Total", printed: "787.50", calculated: "750.00", difference: "37.50", roundingOnly: false },
    ] });
  });
  it("accepts the matching invoice without any new verification state", () => {
    expect(compareAutofillAmounts(printed, { ...zero, vatAmount: "37.50", total: "787.50" })).toEqual({ differences: [], blocking: false });
  });
  it("keeps a one-fils rounding difference informational", () => {
    expect(compareAutofillAmounts({ total: "96.61" }, { ...zero, total: "96.60" })).toMatchObject({ blocking: false,
      differences: [{ key: "total", difference: "0.01", roundingOnly: true }] });
  });
  it("does not invent missing printed totals or crash on unsupported evidence", () => {
    expect(compareAutofillAmounts(undefined, zero).differences).toEqual([]);
    expect(compareAutofillAmounts({ total: null, vatAmount: "not money" }, zero).differences).toEqual([]);
    expect(compareAutofillAmounts(printed, null).differences).toEqual([]);
  });
  it("compares the original discount separately instead of adding it to the saved prices", () => {
    expect(compareAutofillAmounts({ subtotal: "155", discount: "15", vatAmount: "7", total: "147" },
      { subtotal: "155.00", discount: "0.00", vatAmount: "7.75", total: "162.75" })).toMatchObject({ blocking: true,
      differences: [{ key: "discount" }, { key: "vatAmount" }, { key: "total" }] });
  });
});

describe("scoped printed VAT binding", () => {
  it("fills the one exact positive tax and retains account/customer selections", () => {
    expect(fillUnsetAutofillTax(draft, catalog, "company-a", "5")).toEqual({ ...draft,
      organizationId: "123", dataCenter: "US", environment: "production", taxId: "456", taxName: "Standard VAT", taxRate: "5.00",
      unfinished: { tax: false } });
  });
  it("leaves header-only entry alone rather than requiring new Books account fields", () => {
    expect(fillUnsetAutofillTax(undefined, catalog, "company-a", "5")).toBeUndefined();
    const blank = {};
    expect(fillUnsetAutofillTax(blank, catalog, "company-a", "5")).toBe(blank);
  });
  it("never replaces an explicit Zero Rate or NoVAT choice", () => {
    for (const taxId of ["789", "NO_VAT"]) {
      const existing = { ...draft, taxId, taxName: "Existing human choice", taxRate: "0.00" };
      expect(fillUnsetAutofillTax(existing, catalog, "company-a", "5")).toBe(existing);
    }
  });
  it("preserves a cleared or typed tax even if an exact positive option exists", () => {
    expect(fillUnsetAutofillTax(draft, catalog, "company-a", "5", true)).toBe(draft);
    const typing = { ...draft, unfinished: { tax: true } };
    expect(fillUnsetAutofillTax(typing, catalog, "company-a", "5")).toBe(typing);
  });
  it("does not guess between equal-rate tax identities or fallback to zero", () => {
    expect(fillUnsetAutofillTax(draft, { ...catalog, taxes: [...catalog.taxes, { ...catalog.taxes[0], id: "999" }] }, "company-a", "5")).toBe(draft);
    expect(fillUnsetAutofillTax(draft, { ...catalog, taxes: catalog.taxes.slice(1) }, "company-a", "5")).toBe(draft);
    for (const rate of [undefined, "0", "NaN", "-5", "101"])
      expect(fillUnsetAutofillTax(draft, catalog, "company-a", rate)).toBe(draft);
  });
  it("rejects foreign company/destination and incomplete catalog warnings", () => {
    expect(fillUnsetAutofillTax(draft, catalog, "company-b", "5")).toBe(draft);
    const foreign = { ...draft, organizationId: "999" };
    expect(fillUnsetAutofillTax(foreign, catalog, "company-a", "5")).toBe(foreign);
    expect(fillUnsetAutofillTax(draft, { ...catalog, warning: "Catalog incomplete" }, "company-a", "5")).toBe(draft);
    expect(fillUnsetAutofillTax(draft, { ...catalog, taxes: catalog.taxes.map(tax => ({ ...tax, selectable: false })) }, "company-a", "5")).toBe(draft);
  });
});
