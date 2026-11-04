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
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("conservative invoice evidence", () => {
  it("fills printed values and preserves leading zeros, without inventing discounts or IDs", () => {
    const result = normalizeInvoiceEvidence(fixture());
    expect(result.fields).toEqual({ invoiceNumber: "00061", invoiceDate: "2026-11-04", vatRate: "5", lines: [{ description: "Material", quantity: "2", unitPrice: "100" }] });
    expect(result.requiresHumanReview).toBe(true);
    expect(result.evidence.total).toBe("210.00");
  });
  it("does not infer zero or five percent VAT from totals", () => {
    const result = normalizeInvoiceEvidence(fixture({ vatRate: null }));
    expect(result.fields.vatRate).toBeUndefined();
    expect(result.warnings.join(" ")).toContain("not been inferred");
  });
  it("accepts the explicitly printed percent sign without deriving tax", () => {
    const raw = fixture({ vatRate: "5%" }); raw.lines[0].taxRate = "5 %";
    expect(normalizeInvoiceEvidence(raw).fields.vatRate).toBe("5");
  });
  it.each(["quantity", "unitPrice"] as const)("does not invent missing %s", missing => {
    const raw = fixture(); raw.lines[0][missing] = null;
    expect(normalizeInvoiceEvidence(raw).fields.lines).toBeUndefined();
  });
  it.each([
    { subtotal: "180" }, { total: "220" }, { vatAmount: "20" }, { discount: "900" }, { taxInclusive: true },
  ])("withholds lines when financial evidence conflicts: %o", change => {
    expect(normalizeInvoiceEvidence(fixture(change)).fields.lines).toBeUndefined();
  });
  it("withholds lines with incompatible printed amounts or mixed rates", () => {
    const raw = fixture(); raw.lines[0].amount = "250";
    expect(normalizeInvoiceEvidence(raw).fields.lines).toBeUndefined();
    raw.lines[0].amount = "200"; raw.lines.push({ ...raw.lines[0], taxRate: "0" });
    expect(normalizeInvoiceEvidence(raw).fields.vatRate).toBeUndefined();
  });
  it("checks printed totals even when the printed subtotal is absent", () => {
    expect(normalizeInvoiceEvidence(fixture({ subtotal: null, total: "190" })).fields.lines).toBeUndefined();
    const raw = fixture(); raw.lines[0].taxAmount = "25";
    expect(normalizeInvoiceEvidence(raw).fields.lines).toBeUndefined();
  });
  it("rejects invalid dates and unsupported precisions", () => {
    const raw = fixture({ invoiceDate: "2026-02-30", dueDate: "04/11/2026" }); raw.lines[0].unitPrice = "1.1234";
    const result = normalizeInvoiceEvidence(raw);
    expect(result.fields.invoiceDate).toBeUndefined(); expect(result.fields.dueDate).toBeUndefined(); expect(result.fields.lines).toBeUndefined();
  });
  it.each([{ invoiceCount: 2 }, { documentType: "credit_note" as const }])("refuses multiple invoices and credit notes", change => {
    expect(() => normalizeInvoiceEvidence(fixture(change))).toThrow();
  });
  it("rejects provider write instructions and invented local IDs at schema boundary", () => {
    expect(invoiceEvidenceSchema.safeParse({ ...fixture(), paid: true, vendorId: "x", action: "submit" }).success).toBe(false);
  });
});

describe("server-only bounded OpenAI extraction", () => {
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
