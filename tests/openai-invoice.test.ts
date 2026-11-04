import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { invoiceEvidenceSchema, normalizeInvoiceEvidence, type InvoiceEvidence } from "@/lib/bill-autofill";
import { extractInvoice, invoiceAutofillStatus } from "@/lib/services/openai-invoice";

const fixture = (overrides: Partial<InvoiceEvidence> = {}): InvoiceEvidence => ({
  documentType: "invoice", invoiceCount: 1, vendorName: "Fictional Supplier", vendorTrn: null,
  invoiceNumber: "00061", invoiceDate: "2026-11-04", dueDate: null, orderNumber: null,
  currency: "AED", jobNumber: null, description: null, subtotal: "200.00", discount: null,
  vatAmount: "10.00", vatRate: "5", total: "210.00", taxInclusive: false,
  lines: [{ description: "Material", quantity: "2", unitPrice: "100", amount: "200", taxAmount: "10", taxRate: "5" }], warnings: [], ...overrides,
});
const files = [{ bytes: Buffer.from("%PDF-1.4 synthetic"), mimeType: "application/pdf" as const }];
const fakeKey = "sk-synthetic-unit-test-never-real";
function enabled() {
  vi.stubEnv("BILL_AUTOFILL_ENABLED", "true");
  vi.stubEnv("OPENAI_API_KEY", fakeKey);
  vi.stubEnv("OPENAI_API_KEY_FILE", "");
  vi.stubEnv("OPENAI_INVOICE_MODEL", "gpt-5.6-luna");
}
function response(evidence: unknown = fixture()) {
  return { status: "completed", output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(evidence) }] }] };
}
function frontBackFixture(complete: boolean): InvoiceEvidence {
  return fixture({ invoiceNumber: "DEMO-FRONT-BACK-001", invoiceDate: "2026-10-28", dueDate: "2026-11-27",
    subtotal: complete ? "250.00" : null, vatAmount: complete ? "12.50" : null, vatRate: complete ? "5" : null,
    total: complete ? "262.50" : null, lines: [
      { description: "Fictional front materials", quantity: "2", unitPrice: "100", amount: "200", taxAmount: null, taxRate: null },
      ...(complete ? [{ description: "Fictional back fittings", quantity: "1", unitPrice: "50", amount: "50", taxAmount: null, taxRate: null }] : []),
    ] });
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("conservative invoice evidence", () => {
  it("fills clear front-page items without inventing the missing final totals or tax rate", () => {
    const result = normalizeInvoiceEvidence(frontBackFixture(false));
    expect(result.fields.lines).toEqual([{ description: "Fictional front materials", quantity: "2", unitPrice: "100" }]);
    expect(result.fields.vatRate).toBeUndefined();
    expect(result.evidence).toMatchObject({ subtotal: null, vatAmount: null, total: null });
    expect(result.requiresHumanReview).toBe(false);
  });
  it("preserves every front/back item under the one shared invoice identity and final page totals", () => {
    const result = normalizeInvoiceEvidence(frontBackFixture(true));
    expect(result.fields).toMatchObject({ invoiceNumber: "DEMO-FRONT-BACK-001", invoiceDate: "2026-10-28", vatRate: "5",
      lines: [{ description: "Fictional front materials", quantity: "2", unitPrice: "100" }, { description: "Fictional back fittings", quantity: "1", unitPrice: "50" }] });
    expect(result.evidence).toMatchObject({ subtotal: "250.00", vatAmount: "12.50", total: "262.50" });
    expect(result.warnings.join(" ")).not.toMatch(/items do not match|need checking/);
  });
  it("keeps readable page rows and warns when missing, duplicated or carried rows contradict final totals", () => {
    const incomplete = frontBackFixture(true); incomplete.lines.pop();
    expect(normalizeInvoiceEvidence(incomplete).fields.lines).toHaveLength(1);
    expect(normalizeInvoiceEvidence(incomplete).warnings.join(" ")).toContain("do not match");
    const duplicate = frontBackFixture(true); duplicate.lines.unshift({ ...duplicate.lines[0] });
    expect(normalizeInvoiceEvidence(duplicate).fields.lines).toHaveLength(3);
    const carried = frontBackFixture(true); carried.lines.push({ ...carried.lines[0], description: "Carried forward", quantity: "1", unitPrice: "200" });
    expect(normalizeInvoiceEvidence(carried).fields.lines).toHaveLength(3);
  });
  it("keeps legitimate identical printed rows when the invoice totals include both", () => {
    const raw = fixture({ subtotal: "400", vatAmount: "20", total: "420" }); raw.lines.push({ ...raw.lines[0] });
    const result = normalizeInvoiceEvidence(raw);
    expect(result.fields.lines).toHaveLength(2); expect(result.fields.lines![0]).toEqual(result.fields.lines![1]);
  });
  it("fills printed values and preserves leading zeros, without inventing discounts or IDs", () => {
    const result = normalizeInvoiceEvidence(fixture());
    expect(result.fields).toEqual({ invoiceNumber: "00061", invoiceDate: "2026-11-04", vatRate: "5", lines: [{ description: "Material", quantity: "2", unitPrice: "100" }] });
    expect(result.requiresHumanReview).toBe(false);
    expect(result.evidence.total).toBe("210.00");
  });
  it("does not infer zero or five percent VAT from totals", () => {
    const raw = fixture({ vatRate: null }); raw.lines[0].taxRate = null;
    const result = normalizeInvoiceEvidence(raw);
    expect(result.fields.vatRate).toBeUndefined();
    expect(result.warnings.join(" ")).toContain("not been inferred");
  });
  it("accepts the explicitly printed percent sign without deriving tax", () => {
    const raw = fixture({ vatRate: "5%" }); raw.lines[0].taxRate = "5 %";
    expect(normalizeInvoiceEvidence(raw).fields.vatRate).toBe("5");
  });
  it.each(["quantity", "unitPrice"] as const)("recovers missing %s from exact printed net line math", missing => {
    const raw = fixture(); raw.lines[0][missing] = null;
    expect(normalizeInvoiceEvidence(raw).fields.lines).toEqual([{ description: "Material", quantity: "2", unitPrice: "100" }]);
  });
  it.each([
    { subtotal: "180" }, { total: "220" }, { vatAmount: "20" }, { discount: "900" }, { taxInclusive: true },
  ])("preserves readable cells when financial evidence conflicts: %o", change => {
    expect(normalizeInvoiceEvidence(fixture(change)).fields.lines).toHaveLength(1);
    expect(normalizeInvoiceEvidence(fixture(change)).warnings.length).toBeGreaterThan(0);
  });
  it("warns about incompatible amounts and leaves mixed tax selection blank without deleting items", () => {
    const raw = fixture(); raw.lines[0].amount = "250";
    expect(normalizeInvoiceEvidence(raw).fields.lines).toEqual([{ description: "Material", quantity: "2", unitPrice: "100" }]);
    raw.lines[0].amount = "200"; raw.lines.push({ ...raw.lines[0], taxRate: "0" });
    expect(normalizeInvoiceEvidence(raw).fields.vatRate).toBeUndefined();
    expect(normalizeInvoiceEvidence(raw).fields.lines).toHaveLength(2);
  });
  it("checks printed totals even when the printed subtotal is absent", () => {
    expect(normalizeInvoiceEvidence(fixture({ subtotal: null, total: "190" })).fields.lines).toHaveLength(1);
    expect(normalizeInvoiceEvidence(fixture({ subtotal: null, total: "190" })).warnings.join(" ")).toContain("do not match");
    const raw = fixture(); raw.lines[0].taxAmount = "25";
    expect(normalizeInvoiceEvidence(raw).fields.lines).toHaveLength(1);
    expect(normalizeInvoiceEvidence(raw).warnings.join(" ")).toContain("does not match");
  });
  it("rejects invalid dates and unsupported precisions", () => {
    const raw = fixture({ invoiceDate: "2026-02-30", dueDate: "04/11/2026" }); raw.lines[0].unitPrice = "1.1234";
    const result = normalizeInvoiceEvidence(raw);
    expect(result.fields.invoiceDate).toBeUndefined(); expect(result.fields.dueDate).toBeUndefined();
    expect(result.fields.lines).toEqual([{ description: "Material", quantity: "2", unitPrice: "" }]);
  });
  it("fills readable siblings and partial rows independently instead of rejecting the whole invoice", () => {
    const raw = fixture();
    raw.lines.push({ description: "Second readable item", quantity: null, unitPrice: "25", amount: null, taxAmount: null, taxRate: null },
      { description: null, quantity: "3", unitPrice: null, amount: null, taxAmount: null, taxRate: null },
      { description: "Description only", quantity: null, unitPrice: null, amount: null, taxAmount: null, taxRate: null });
    expect(normalizeInvoiceEvidence(raw).fields.lines).toEqual([
      { description: "Material", quantity: "2", unitPrice: "100" }, { description: "Second readable item", quantity: "", unitPrice: "25" },
      { description: "", quantity: "3", unitPrice: "" }, { description: "Description only", quantity: "", unitPrice: "" },
    ]);
  });
  it("does not invent quantity one or a unit price when only the printed amount is available", () => {
    const raw = fixture(); raw.lines[0] = { description: "Lump sum", quantity: null, unitPrice: null, amount: "200", taxAmount: null, taxRate: null };
    const result = normalizeInvoiceEvidence(raw);
    expect(result.fields.lines).toEqual([{ description: "Lump sum", quantity: "", unitPrice: "" }]);
    expect(result.warnings.join(" ")).toContain("printed line amount 200");
  });
  it("retains amount-only rows as blank editable cells with their printed amount in the notes", () => {
    const raw = fixture(); raw.lines[0] = { description: null, quantity: null, unitPrice: null, amount: "200", taxAmount: null, taxRate: null };
    expect(normalizeInvoiceEvidence(raw).fields.lines).toEqual([{ description: "", quantity: "", unitPrice: "" }]);
  });
  it("does not divide by zero or replace a clearly printed unsupported quantity", () => {
    const raw = fixture(); raw.lines[0].quantity = null; raw.lines[0].unitPrice = "0"; raw.lines[0].amount = "0";
    expect(normalizeInvoiceEvidence(raw).fields.lines![0]).toMatchObject({ quantity: "", unitPrice: "0" });
    raw.lines[0].quantity = "0"; raw.lines[0].unitPrice = "100"; raw.lines[0].amount = "200";
    expect(normalizeInvoiceEvidence(raw).fields.lines![0].quantity).toBe("");
  });
  it.each([
    { quantity: "3", unitPrice: null, amount: "100" },
    { quantity: null, unitPrice: "3", amount: "100" },
  ])("leaves missing factors blank when exact supported precision is impossible: %o", change => {
    const raw = fixture(); Object.assign(raw.lines[0], change);
    const result = normalizeInvoiceEvidence(raw).fields.lines![0];
    expect(result.quantity === "" || result.unitPrice === "").toBe(true);
  });
  it("does not derive a net amount from an unclear tax basis", () => {
    const raw = fixture({ taxInclusive: null, vatRate: null }); Object.assign(raw.lines[0], { unitPrice: null, taxAmount: null, taxRate: null });
    expect(normalizeInvoiceEvidence(raw).fields.lines![0]).toEqual({ description: "Material", quantity: "2", unitPrice: "" });
  });
  it("does not apply a positive header discount twice when a partial row amount already includes it", () => {
    const raw = fixture({ discount: "10", subtotal: "200", vatAmount: "9.50", total: "199.50" });
    Object.assign(raw.lines[0], { unitPrice: null, amount: "190", taxAmount: "9.50" });
    const result = normalizeInvoiceEvidence(raw);
    expect(result.fields.lines![0]).toEqual({ description: "Material", quantity: "2", unitPrice: "" });
    expect(result.fields.discount).toBe("10"); expect(result.warnings.join(" ")).toContain("discount basis is unclear");
    raw.lines[0].unitPrice = "100";
    expect(normalizeInvoiceEvidence(raw).fields.lines![0]).toEqual({ description: "Material", quantity: "2", unitPrice: "100" });
  });
  it("can derive a missing factor when all printed rows prove the net pre-discount subtotal and final totals", () => {
    const raw = fixture({ discount: "10", subtotal: "200", vatAmount: "9.50", total: "199.50" });
    Object.assign(raw.lines[0], { unitPrice: null, amount: "200", taxAmount: "10" });
    expect(normalizeInvoiceEvidence(raw).fields.lines![0]).toEqual({ description: "Material", quantity: "2", unitPrice: "100" });
    raw.subtotal = null;
    expect(normalizeInvoiceEvidence(raw).fields.lines![0].unitPrice).toBe("");
  });
  it("compares inclusive gross row amounts as net values before proving a positive discount basis", () => {
    const raw = fixture({ taxInclusive: true, discount: "10", subtotal: "200", vatAmount: "9.50", total: "199.50" });
    Object.assign(raw.lines[0], { unitPrice: "105", amount: "210", taxAmount: "10" });
    expect(normalizeInvoiceEvidence(raw).fields.lines![0]).toEqual({ description: "Material", quantity: "2", unitPrice: "100" });
    raw.subtotal = "210";
    expect(normalizeInvoiceEvidence(raw).fields.lines![0]).toEqual({ description: "Material", quantity: "2", unitPrice: "" });
  });
  it("holds an inclusive derived price when row tax and amount reflect an already applied header discount", () => {
    const raw = fixture({ taxInclusive: true, discount: "10", subtotal: "200", vatAmount: "9.50", total: "199.50" });
    Object.assign(raw.lines[0], { unitPrice: null, amount: "199.50", taxAmount: "9.50" });
    expect(normalizeInvoiceEvidence(raw).fields.lines![0]).toEqual({ description: "Material", quantity: "2", unitPrice: "" });
  });
  it("normalizes unambiguous thousands grouping and harmless trailing zero precision", () => {
    const raw = fixture(); Object.assign(raw.lines[0], { quantity: "2.0000", unitPrice: "1,000.0000", amount: "2,000.00", taxAmount: "100.00" });
    const result = normalizeInvoiceEvidence(raw);
    expect(result.fields.lines![0]).toEqual({ description: "Material", quantity: "2.000", unitPrice: "1000.00" });
    raw.lines[0].unitPrice = "1,00.00";
    expect(normalizeInvoiceEvidence(raw).fields.lines![0].unitPrice).toBe("");
  });
  it.each(["DHS", "dh", "Dhs.", "Dirham", "DIRHAMS", "AED", "UAE Dirham"])("recognizes printed UAE currency alias %s without changing monetary facts", alias => {
    expect(normalizeInvoiceEvidence(fixture({ currency: alias })).evidence.currency).toBe("AED");
  });
  it.each(["USD", "EUR", "DOLLAR", "UNKNOWN"])("does not guess a different currency from %s", value => {
    expect(normalizeInvoiceEvidence(fixture({ currency: value })).evidence.currency).toBe(value);
  });
  it("can copy a common rate actually printed on every item without deriving one from totals", () => {
    const result = normalizeInvoiceEvidence(fixture({ vatRate: null }));
    expect(result.fields.vatRate).toBe("5"); expect(result.evidence.vatRate).toBeNull();
    const raw = fixture({ vatRate: null }); raw.lines.push({ ...raw.lines[0], taxRate: null });
    expect(normalizeInvoiceEvidence(raw).fields.vatRate).toBeUndefined();
  });
  it("converts explicit inclusive front/back unit prices to exact net values", () => {
    const raw = fixture({ taxInclusive: true, subtotal: "70.00", vatAmount: "3.50", total: "73.50" });
    raw.lines = [{ description: "Front item", quantity: "2", unitPrice: "31.50", amount: "63.00", taxAmount: "3.00", taxRate: "5" },
      { description: "Back item", quantity: "1", unitPrice: "10.50", amount: "10.50", taxAmount: "0.50", taxRate: "5" }];
    const result = normalizeInvoiceEvidence(raw);
    expect(result.fields.lines).toEqual([{ description: "Front item", quantity: "2", unitPrice: "30" }, { description: "Back item", quantity: "1", unitPrice: "10" }]);
    expect(result.fields.vatRate).toBe("5"); expect(result.evidence.total).toBe("73.50"); expect(result.requiresHumanReview).toBe(false);
  });
  it.each(["quantity", "unitPrice"] as const)("recovers missing inclusive %s only through exact printed gross and tax math", missing => {
    const raw = fixture({ taxInclusive: true }); Object.assign(raw.lines[0], { unitPrice: "105", amount: "210", [missing]: null });
    expect(normalizeInvoiceEvidence(raw).fields.lines![0]).toEqual({ description: "Material", quantity: "2", unitPrice: "100" });
  });
  it("does not convert a known-quantity inclusive price when printed VAT conflicts", () => {
    const raw = fixture({ taxInclusive: true }); Object.assign(raw.lines[0], { unitPrice: "105", amount: "210", taxAmount: "9" });
    expect(normalizeInvoiceEvidence(raw).fields.lines![0]).toEqual({ description: "Material", quantity: "2", unitPrice: "" });
  });
  it("warns about a conflicting gross line amount without changing independent printed quantity and price", () => {
    const raw = fixture({ taxInclusive: true }); Object.assign(raw.lines[0], { unitPrice: "105", amount: "220", taxAmount: "10" });
    const result = normalizeInvoiceEvidence(raw);
    expect(result.fields.lines![0]).toEqual({ description: "Material", quantity: "2", unitPrice: "100" });
    expect(result.warnings.join(" ")).toContain("gross unit price do not match");
  });
  it.each([{ taxAmount: "-5" }, { taxRate: "150%" }])("does not ignore unsupported printed tax while deriving a net price: %o", change => {
    const raw = fixture({ taxInclusive: true }); Object.assign(raw.lines[0], { unitPrice: "105", amount: "210", ...change });
    expect(normalizeInvoiceEvidence(raw).fields.lines![0]).toEqual({ description: "Material", quantity: "2", unitPrice: "" });
  });
  it("does not fall back to a rounded per-unit conversion when the verified net line cannot divide exactly", () => {
    const raw = fixture({ taxInclusive: true, subtotal: "28.60", vatAmount: "1.43", total: "30.03" });
    Object.assign(raw.lines[0], { quantity: "3", unitPrice: "10.01", amount: "30.03", taxAmount: "1.43" });
    expect(normalizeInvoiceEvidence(raw).fields.lines![0]).toEqual({ description: "Material", quantity: "3", unitPrice: "" });
  });
  it("keeps a readable inclusive description and quantity when tax evidence is missing", () => {
    const raw = fixture({ taxInclusive: true, vatRate: null }); Object.assign(raw.lines[0], { unitPrice: "105", amount: "210", taxAmount: null, taxRate: null });
    expect(normalizeInvoiceEvidence(raw).fields.lines![0]).toEqual({ description: "Material", quantity: "2", unitPrice: "" });
  });
  it("can convert printed inclusive unit prices without inventing an unreadable quantity", () => {
    const raw = fixture({ taxInclusive: true }); Object.assign(raw.lines[0], { quantity: null, unitPrice: "105", amount: null, taxAmount: null });
    expect(normalizeInvoiceEvidence(raw).fields.lines![0]).toEqual({ description: "Material", quantity: "", unitPrice: "100.00" });
  });
  it.each([{ invoiceCount: 2 }, { documentType: "credit_note" as const }])("refuses multiple invoices and credit notes", change => {
    expect(() => normalizeInvoiceEvidence(fixture(change))).toThrow();
  });
  it("rejects provider write instructions and invented local IDs at schema boundary", () => {
    expect(invoiceEvidenceSchema.safeParse({ ...fixture(), paid: true, vendorId: "x", action: "submit" }).success).toBe(false);
  });
});

describe("server-only bounded OpenAI extraction", () => {
  it("submits both ordered images once and requires continuation/physical-row evidence instead of header-based invoice counts", async () => {
    enabled(); const fetcher = vi.fn().mockResolvedValue(Response.json(response(frontBackFixture(true)))); vi.stubGlobal("fetch", fetcher);
    const front = Buffer.from("synthetic-front-page-image"), back = Buffer.from("synthetic-back-page-without-repeated-identity");
    const result = await extractInvoice([{ bytes: front, mimeType: "image/png" }, { bytes: back, mimeType: "image/png" }]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.input[0].content.map((item: { image_url: string }) => item.image_url)).toEqual([
      `data:image/png;base64,${front.toString("base64")}`, `data:image/png;base64,${back.toString("base64")}`,
    ]);
    expect(body.instructions).toContain("continuation page can omit the supplier, date and invoice number");
    expect(body.instructions).toContain("carried forward or brought forward amounts");
    expect(body.instructions).toContain("Do not collapse distinct printed rows");
    expect(body.instructions).toContain("genuinely different invoice numbers");
    expect(body.instructions).toContain("Copy the unit price AS PRINTED");
    expect(body.instructions).toContain("use null only for its unreadable cells");
    expect(result.fields.lines).toHaveLength(2); expect(result.evidence.total).toBe("262.50");
  });
  it("does not contact a provider when disabled or misconfigured", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    expect(invoiceAutofillStatus().configured).toBe(false);
    await expect(extractInvoice(files)).rejects.toMatchObject({ status: 503 });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("uses strict JSON, in-memory PDF and image inputs, no storage or tools", async () => {
    enabled(); const fetcher = vi.fn().mockResolvedValue(Response.json(response())); vi.stubGlobal("fetch", fetcher);
    await extractInvoice([...files, { bytes: Buffer.from("synthetic-png"), mimeType: "image/png" }]);
    const [url, options] = fetcher.mock.calls[0]; const body = JSON.parse(options.body);
    expect(url).toBe("https://api.openai.com/v1/responses"); expect(options.redirect).toBe("error");
    expect(body.store).toBe(false); expect(body.tools).toBeUndefined(); expect(body.max_output_tokens).toBe(8000);
    expect(body.text.format.strict).toBe(true); expect(body.text.format.schema.additionalProperties).toBe(false);
    expect(body.input[0].content[0]).toMatchObject({ type: "input_file", filename: "invoice-1.pdf" });
    expect(body.input[0].content[1]).toMatchObject({ type: "input_image", detail: "high" });
    expect(body.instructions).toContain("UNTRUSTED"); expect(options.body).not.toContain(fakeKey);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403, 429, 400, 500])("never exposes provider error or secret for status %s, and never retries", async status => {
    enabled(); const fetcher = vi.fn().mockResolvedValue(new Response(`sensitive ${fakeKey}`, { status })); vi.stubGlobal("fetch", fetcher);
    await expect(extractInvoice(files)).rejects.not.toThrow(fakeKey);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    { status: "incomplete", output: [] },
    { status: "completed", output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "sensitive" }] }] },
    response({ ...fixture(), vendorId: "invented" }),
    response(fixture({ invoiceCount: 2 })),
  ])("rejects incomplete/refused/unsafe results", async body => {
    enabled(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
    await expect(extractInvoice(files)).rejects.toMatchObject({ status: 422 });
  });
  it("bounds responses even when content-length is absent", async () => {
    enabled(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("x".repeat(1024 * 1024 + 1))));
    await expect(extractInvoice(files)).rejects.toMatchObject({ status: 503 });
  });
  it("reads a protected key file and does not silently fall back when the configured file is broken", async () => {
    enabled(); const dir = mkdtempSync(path.join(os.tmpdir(), "autofill-key-test-"));
    try {
      const file = path.join(dir, "key"); writeFileSync(file, fakeKey, { mode: 0o600 }); vi.stubEnv("OPENAI_API_KEY_FILE", file);
      expect(invoiceAutofillStatus().configured).toBe(true);
      vi.stubEnv("OPENAI_API_KEY_FILE", path.join(dir, "missing"));
      expect(invoiceAutofillStatus().configured).toBe(false);
    } finally { rmSync(dir, { recursive: true }); }
  });
});
