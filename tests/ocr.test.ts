import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyOcrTemplate,
  matchingOcrVendors,
  sameOcrInvoice,
  normalizeAzureInvoice,
  templateMappingsSchema,
} from "@/lib/ocr-extraction";
import {
  azureOcrProvider,
  ocrProviderStatus,
} from "@/lib/services/ocr-provider";
import { azureInvoice } from "./fixtures/azure-invoice";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
function configured() {
  vi.stubEnv("OCR_PROVIDER", "azure_document_intelligence");
  vi.stubEnv(
    "AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT",
    "https://fictional-ocr.cognitiveservices.azure.com/",
  );
  vi.stubEnv(
    "AZURE_DOCUMENT_INTELLIGENCE_KEY",
    "fictional-test-key-not-a-credential",
  );
}
describe("structured OCR evidence", () => {
  it("extracts multipage invoice fields, confidence, job reference and VAT-exclusive arithmetic", () => {
    const result = normalizeAzureInvoice(azureInvoice());
    expect(result.fields).toMatchObject({
      invoiceNumber: "DEMO-OCR-001",
      invoiceDate: "2026-10-27",
      dueDate: "2026-11-26",
      currency: "AED",
      vatRate: "5.00",
      lines: [
        {
          description: "Fictional materials",
          quantity: "2.000",
          unitPrice: "100.00",
        },
      ],
    });
    expect(result.total).toBe("210.00"); // AmountDue includes prior balances and must never become the bill total.
    expect(result.confidence.invoiceNumber).toBe(0.98);
    expect(result.jobNumber).toBe("OCR-TEST");
    expect(result.pageCount).toBe(2);
    expect(result.requiresHumanReview).toBe(true);
    expect(result.warnings).toEqual([]);
  });
  it("warns about low confidence and source total mismatches without replacing source evidence", () => {
    const data = azureInvoice();
    data.documents[0].fields.InvoiceId.confidence = 0.42;
    data.documents[0].fields.InvoiceTotal.valueCurrency.amount = 211;
    const result = normalizeAzureInvoice(data);
    expect(result.total).toBe("211.00");
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Low confidence"),
        expect.stringContaining("total differs"),
      ]),
    );
  });
  it("does not invent fields for unreadable invoices", () => {
    const result = normalizeAzureInvoice({
      pages: [{}],
      documents: [{ fields: {} }],
    });
    expect(result.fields.invoiceNumber).toBeUndefined();
    expect(result.fields.currency).toBeUndefined();
    expect(result.total).toBeUndefined();
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Missing invoiceNumber"),
        expect.stringContaining("source totals"),
      ]),
    );
  });
  it("rejects documents containing multiple invoices and warns about page caps", () => {
    expect(() => normalizeAzureInvoice({ documents: [{}, {}] })).toThrow(
      "one invoice per file",
    );
    expect(normalizeAzureInvoice(azureInvoice(), 2).warnings).toContainEqual(
      expect.stringContaining("2-page limit"),
    );
  });
  it("applies controlled mappings without mutating extracted evidence", () => {
    const source = normalizeAzureInvoice(azureInvoice());
    const mapped = applyOcrTemplate(source, {
      orderNumber: "CustomerId",
      jobNumber: "CustomerId",
      category: "MATERIALS",
    });
    expect(mapped.fields.orderNumber).toBe("OCR-TEST");
    expect(source.fields.orderNumber).toBe("PO-FICTIONAL-001");
    expect(mapped.confidence.orderNumber).toBeUndefined();
    expect(mapped.requiresHumanReview).toBe(true);
    expect(
      templateMappingsSchema.safeParse({
        invoiceNumber: "https://evil.invalid",
      }).success,
    ).toBe(false);
    expect(
      templateMappingsSchema.safeParse({ total: "AmountDue" }).success,
    ).toBe(false);
  });
  it("does not accept negative financial extraction as a positive invoice", () => {
    const data = azureInvoice();
    data.documents[0].fields.InvoiceTotal.valueCurrency.amount = -210;
    expect(normalizeAzureInvoice(data).total).toBeUndefined();
  });
  it("leaves missing quantities and unit rates empty instead of multiplying a line amount twice", () => {
    const data = azureInvoice();
    const values = data.documents[0].fields.Items.valueArray[0].valueObject;
    delete (values as Partial<typeof values>).UnitPrice;
    const result = normalizeAzureInvoice(data);
    expect(result.fields.lines?.[0]).toMatchObject({
      quantity: "2.000",
      unitPrice: "",
    });
    expect(result.warnings).toContainEqual(
      expect.stringContaining("line amount is not a unit rate"),
    );
    delete (values as Partial<typeof values>).Quantity;
    delete (values as Partial<typeof values>).Description;
    const incomplete = normalizeAzureInvoice(data);
    expect(incomplete.fields.lines?.[0]).toMatchObject({
      quantity: "",
      unitPrice: "",
      description: "",
    });
    expect(incomplete.warnings).toContainEqual(
      expect.stringContaining("description was not extracted"),
    );
    expect(incomplete.requiresHumanReview).toBe(true);
  });
  it("warns about a mismatched source line amount even when the header totals reconcile", () => {
    const data = azureInvoice();
    data.documents[0].fields.Items.valueArray[0].valueObject.Amount.valueCurrency.amount = 180;
    expect(normalizeAzureInvoice(data).warnings).toContainEqual(
      expect.stringContaining("Line 1: extracted amount differs"),
    );
  });
  it("flags invalid calendar dates without replacing the extracted evidence", () => {
    const data = azureInvoice();
    data.documents[0].fields.InvoiceDate.valueDate = "2026-02-30";
    const result = normalizeAzureInvoice(data);
    expect(result.fields.invoiceDate).toBe("2026-02-30");
    expect(result.warnings).toContainEqual(
      expect.stringContaining("Invalid invoiceDate"),
    );
    expect(result.requiresHumanReview).toBe(true);
  });
  it("retains source line and tax evidence without adding unsupported posting fields", () => {
    const data = azureInvoice();
    Object.assign(data.documents[0].fields, {
      TaxDetails: {
        valueArray: [
          {
            valueObject: {
              Amount: {
                valueCurrency: { amount: 10, currencyCode: "AED" },
                confidence: 0.98,
              },
              Rate: { valueString: "5 %", confidence: 0.96 },
            },
          },
        ],
      },
    });
    Object.assign(data.documents[0].fields.Items.valueArray[0].valueObject, {
      Tax: {
        valueCurrency: { amount: 10, currencyCode: "AED" },
        confidence: 0.97,
      },
      TaxRate: { valueString: "5%", confidence: 0.95 },
    });
    const result = normalizeAzureInvoice(data);
    expect(result.sourceLines).toEqual([
      {
        amount: "200.00",
        taxAmount: "10.00",
        taxRate: "5.00",
        currency: "AED",
      },
    ]);
    expect(result.taxDetails).toEqual([
      { amount: "10.00", rate: "5.00", currency: "AED" },
    ]);
    expect(result.confidence["lines.0.taxRate"]).toBe(0.95);
    expect(result.confidence["lines.0.taxAmount"]).toBe(0.97);
    expect(result.confidence["lines.0.amount"]).toBe(0.99);
    expect(result.fields.vatRate).toBe("5.00");
    expect(result.fields.lines?.[0]).toEqual({
      description: "Fictional materials",
      quantity: "2.000",
      unitPrice: "100.00",
    });
    expect(result.warnings).toEqual([]);
  });
  it("does not average mixed line tax rates even when aggregate source totals reconcile", () => {
    const data = azureInvoice();
    const first = data.documents[0].fields.Items.valueArray[0];
    const second = structuredClone(first);
    Object.assign(first.valueObject, {
      TaxRate: { valueString: "5%", confidence: 0.99 },
    });
    Object.assign(second.valueObject, {
      TaxRate: { valueString: "10%", confidence: 0.99 },
    });
    data.documents[0].fields.Items.valueArray.push(second);
    data.documents[0].fields.SubTotal.valueCurrency.amount = 400;
    data.documents[0].fields.TotalTax.valueCurrency.amount = 30;
    data.documents[0].fields.InvoiceTotal.valueCurrency.amount = 430;
    const result = normalizeAzureInvoice(data);
    expect(result.fields.vatRate).toBeUndefined();
    expect(result.sourceLines?.map((line) => line.taxRate)).toEqual([
      "5.00",
      "10.00",
    ]);
    expect(result.vatAmount).toBe("30.00");
    expect(result.warnings).toContainEqual(
      expect.stringContaining("no averaged rate"),
    );
    expect(result.requiresHumanReview).toBe(true);
  });
  it("retains tax-detail discrepancies and rejects unsupported printed tax values", () => {
    const data = azureInvoice();
    Object.assign(data.documents[0].fields, {
      TaxDetails: {
        valueArray: [
          {
            valueObject: {
              Amount: {
                valueCurrency: { amount: 7, currencyCode: "AED" },
                confidence: 0.99,
              },
              Rate: { valueString: "exempt or taxable", confidence: 0.7 },
            },
          },
        ],
      },
    });
    const result = normalizeAzureInvoice(data);
    expect(result.taxDetails?.[0].amount).toBe("7.00");
    expect(result.taxDetails?.[0].rate).toBeUndefined();
    expect(result.fields.vatRate).toBeUndefined();
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Invalid or unsupported tax rate"),
        expect.stringContaining("tax-detail amounts differ"),
        expect.stringContaining("Low confidence: taxDetails.0.rate"),
      ]),
    );
  });
  it("preserves precise printed tax rates without silently rounding them into the bill", () => {
    const data = azureInvoice();
    Object.assign(data.documents[0].fields.Items.valueArray[0].valueObject, {
      TaxRate: { valueString: "5.555%", confidence: 0.99 },
    });
    const result = normalizeAzureInvoice(data);
    expect(result.sourceLines?.[0].taxRate).toBe("5.555");
    expect(result.fields.vatRate).toBeUndefined();
    expect(result.warnings).toContainEqual(
      expect.stringContaining("two-decimal limit"),
    );
  });
  it("requires currency review instead of combining conflicting source currencies", () => {
    const data = azureInvoice();
    data.documents[0].fields.Items.valueArray[0].valueObject.Amount.valueCurrency.currencyCode =
      "USD";
    const result = normalizeAzureInvoice(data);
    expect(result.fields.currency).toBeUndefined();
    expect(result.fields.vatRate).toBeUndefined();
    expect(result.sourceLines?.[0].currency).toBe("USD");
    expect(result.total).toBe("210.00");
    expect(result.warnings).toContainEqual(
      expect.stringContaining("Conflicting currencies"),
    );
  });
  it("requires review when confidence is absent or invalid rather than implying certainty", () => {
    const data = azureInvoice();
    delete (data.documents[0].fields.InvoiceId as { confidence?: number })
      .confidence;
    data.documents[0].fields.Items.valueArray[0].valueObject.UnitPrice.confidence =
      Number.NaN;
    const result = normalizeAzureInvoice(data);
    expect(result.fields.invoiceNumber).toBe("DEMO-OCR-001");
    expect(result.confidence.invoiceNumber).toBeUndefined();
    expect(result.confidence["lines.0.unitPrice"]).toBeUndefined();
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Confidence unavailable: invoiceNumber"),
        expect.stringContaining("Confidence unavailable: lines.0.unitPrice"),
      ]),
    );
  });
  it("does not let name-only vendor matches override an extracted tax registration number", () => {
    const source = normalizeAzureInvoice(azureInvoice());
    source.vendorTrn = "100-200-300";
    const vendors = [
      { id: "wrong", name: source.vendorName!, trn: "999" },
      { id: "missing", name: source.vendorName!, trn: null },
      { id: "correct", name: "Fictional alternate spelling", trn: "100200300" },
    ];
    expect(
      matchingOcrVendors(source, vendors).map((vendor) => vendor.id),
    ).toEqual(["correct"]);
    expect(matchingOcrVendors(source, vendors.slice(0, 2))).toEqual([]);
    expect(
      matchingOcrVendors({ ...source, vendorTrn: undefined }, vendors).map(
        (vendor) => vendor.id,
      ),
    ).toEqual(["wrong", "missing"]);
    expect(
      matchingOcrVendors(
        { ...source, vendorTrn: undefined, vendorName: "" },
        vendors,
      ),
    ).toEqual([]);
  });
  it("detects normalized source duplicates without merging different tax identities or anonymous vendors", () => {
    const source = normalizeAzureInvoice(azureInvoice("  DEMO-DUPLICATE  "));
    const peer = normalizeAzureInvoice(azureInvoice("demo-duplicate"));
    expect(sameOcrInvoice(source, peer)).toBe(true);
    expect(
      sameOcrInvoice(
        { ...source, vendorTrn: "111" },
        { ...peer, vendorTrn: "222" },
      ),
    ).toBe(false);
    expect(
      sameOcrInvoice(
        { ...source, vendorName: undefined },
        { ...peer, vendorName: undefined },
      ),
    ).toBe(false);
    expect(
      sameOcrInvoice(
        { ...source, vendorName: "Different name", vendorTrn: "111" },
        { ...peer, vendorTrn: "111" },
      ),
    ).toBe(true);
  });
});
describe("Azure OCR adapter with mocked HTTP only", () => {
  it.each(["", "   ", "\n\t"])(
    "rejects an empty API key before network access: %j",
    async (value) => {
      configured();
      vi.stubEnv("AZURE_DOCUMENT_INTELLIGENCE_KEY", value);
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      await expect(
        azureOcrProvider.start(new Uint8Array([1])),
      ).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
      expect(ocrProviderStatus().message).toContain("enter the bill manually");
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("rejects invalid key whitespace without exposing its value", async () => {
    configured();
    vi.stubEnv("AZURE_DOCUMENT_INTELLIGENCE_KEY", "fictional-private\nvalue");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      azureOcrProvider.start(new Uint8Array([1])),
    ).rejects.toMatchObject({
      code: "INVALID_CONFIGURATION",
      message: expect.not.stringContaining("fictional-private"),
    });
    expect(JSON.stringify(ocrProviderStatus())).not.toContain(
      "fictional-private",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("reports explicit setup failure and makes no request when unconfigured", async () => {
    vi.stubEnv("OCR_PROVIDER", "disabled");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(ocrProviderStatus()).toMatchObject({
      configured: false,
      connected: false,
      status: "NOT_CONFIGURED",
    });
    await expect(
      azureOcrProvider.start(new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("submits bytes privately and polls only the configured resource", async () => {
    configured();
    const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 202,
          headers: {
            "operation-location": `https://fictional-ocr.cognitiveservices.azure.com/documentintelligence/documentModels/prebuilt-invoice/analyzeResults/${id}?api-version=2024-11-30`,
            "retry-after": "4",
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ status: "succeeded", analyzeResult: azureInvoice() }),
      );
    vi.stubGlobal("fetch", fetch);
    expect(await azureOcrProvider.start(new Uint8Array([1, 2, 3]))).toEqual({
      requestId: id,
      retryAfterSeconds: 4,
    });
    expect(await azureOcrProvider.poll(id)).toMatchObject({
      status: "succeeded",
      extraction: { total: "210.00", requiresHumanReview: true },
    });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      base64Source: "AQID",
    });
    expect(fetch.mock.calls[0][1].redirect).toBe("error");
    expect(ocrProviderStatus().connected).toBe(false); // Configuration alone is never a successful live test.
  });
  it("rejects foreign polling URLs so credentials cannot be forwarded", async () => {
    configured();
    const fetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 202,
        headers: {
          "operation-location":
            "https://evil.invalid/documentintelligence/documentModels/prebuilt-invoice/analyzeResults/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(
      azureOcrProvider.start(new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "SUBMISSION_UNKNOWN" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects non-Azure endpoints and malformed operation IDs before making requests", async () => {
    configured();
    vi.stubEnv("AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT", "http://127.0.0.1/");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      azureOcrProvider.start(new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    await expect(azureOcrProvider.poll("../secrets")).rejects.toMatchObject({
      code: "INVALID_RESULT",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("classifies authorization, rate limits, and transport failures without leaking response bodies", async () => {
    configured();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("secret-provider-detail", { status: 401 }),
      )
      .mockResolvedValueOnce(
        new Response("private", {
          status: 429,
          headers: { "retry-after": "9999" },
        }),
      )
      .mockRejectedValueOnce(new Error("secret URL"));
    vi.stubGlobal("fetch", fetch);
    await expect(
      azureOcrProvider.start(new Uint8Array([1])),
    ).rejects.toMatchObject({
      code: "AUTHORIZATION_FAILED",
      retryable: false,
      message: expect.not.stringContaining("secret"),
    });
    await expect(
      azureOcrProvider.start(new Uint8Array([1])),
    ).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
      retryAfterSeconds: 120,
    });
    await expect(
      azureOcrProvider.start(new Uint8Array([1])),
    ).rejects.toMatchObject({
      code: "SUBMISSION_UNKNOWN",
      retryable: false,
      message: expect.not.stringContaining("secret"),
    });
  });
  it("treats a submit timeout as an unknown outcome but safely retries a timed-out saved poll", async () => {
    configured();
    const fetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          new Response("sensitive provider body", { status: 408 }),
        ),
      );
    vi.stubGlobal("fetch", fetch);
    await expect(
      azureOcrProvider.start(new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "SUBMISSION_UNKNOWN", retryable: false });
    await expect(
      azureOcrProvider.poll("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
    ).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      retryable: true,
      message: expect.not.stringContaining("sensitive"),
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1].method).toBeUndefined();
  });
  it.each(["running", "notStarted"])(
    "preserves the saved operation while Azure reports %s",
    async (status) => {
      configured();
      const fetch = vi
        .fn()
        .mockResolvedValue(
          Response.json({ status }, { headers: { "retry-after": "7" } }),
        );
      vi.stubGlobal("fetch", fetch);
      await expect(
        azureOcrProvider.poll("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
      ).resolves.toEqual({ status: "running", retryAfterSeconds: 7 });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0][1].method).toBeUndefined();
    },
  );
  it("reports a failed Azure extraction without exposing provider error contents", async () => {
    configured();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({
            status: "failed",
            error: { message: "private invoice details" },
          }),
        ),
    );
    await expect(
      azureOcrProvider.poll("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
    ).rejects.toMatchObject({
      code: "EXTRACTION_FAILED",
      retryable: false,
      message: expect.not.stringContaining("private invoice"),
    });
  });
  it("rejects oversized streamed OCR responses even without a content-length header", async () => {
    configured();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
    await expect(
      azureOcrProvider.poll("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
    ).rejects.toMatchObject({ code: "RESULT_TOO_LARGE", retryable: false });
    expect(cancelled).toBe(true);
  });
  it("rejects operation IDs with misplaced separators before sending credentials", async () => {
    configured();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(azureOcrProvider.poll("-".repeat(36))).rejects.toMatchObject({
      code: "INVALID_RESULT",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([null, [], { status: "invented-success" }])(
    "rejects malformed polling envelopes: %j",
    async (payload) => {
      configured();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(payload)));
      await expect(
        azureOcrProvider.poll("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
      ).rejects.toMatchObject({ code: "INVALID_RESULT", retryable: false });
    },
  );
  it("resumes polling after an interrupted response without starting another analysis", async () => {
    configured();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("private provider detail"));
      },
    });
    const fetch = vi.fn().mockResolvedValue(new Response(stream));
    vi.stubGlobal("fetch", fetch);
    await expect(
      azureOcrProvider.poll("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
    ).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      retryable: true,
      message: expect.not.stringContaining("private provider detail"),
    });
    expect(fetch.mock.calls[0][1].method).toBeUndefined();
  });
  it("rejects resource endpoint paths instead of silently ignoring configuration mistakes", async () => {
    configured();
    vi.stubEnv(
      "AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT",
      "https://fictional-ocr.cognitiveservices.azure.com/unexpected/path",
    );
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      azureOcrProvider.start(new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
