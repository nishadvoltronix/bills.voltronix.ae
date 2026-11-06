import { describe, expect, it, vi } from "vitest";
import { buildPaymentPayload, paymentAcknowledgementId, paymentReference, paymentSnapshotSchema, reconcileBooksPayment,
  validatePaymentBill, verifyPaymentConfirmation, type PaymentSnapshot } from "@/lib/integrations/books-payments";
import { stableReference } from "@/lib/integrations/books";
import type { ZohoTransport } from "@/lib/integrations/transport";

const snapshot: PaymentSnapshot = { payment: { id: "fictional-payment", billId: "fictional-bill", amount: "10.50", reference: "HUMAN-TRANSFER-REF",
  createdById: "actor", createdAt: "2026-11-06T10:00:00.000Z", paymentDate: "2026-11-05", paymentMode: "Cash", paidThroughAccountId: "501" },
  bill: { id: "fictional-bill", companyId: "company", createdById: "owner", vendorId: "local-vendor", jobId: "job", invoiceNumber: "INV-001",
    invoiceDate: "2026-10-01", currency: "AED", total: "100.00", externalVendorId: "201", sourceHash: "a".repeat(64) },
  destination: { organizationId: "101", dataCenter: "US", environment: "production", connectionFingerprint: "b".repeat(64), configurationHash: "c".repeat(64) } };
const bill = (extra: Record<string, unknown> = {}) => ({ code: 0, bill: { bill_id: "301", vendor_id: "201", bill_number: "INV-001", date: "2026-10-01",
  reference_number: stableReference("fictional-bill"), currency_code: "AED", total: 100, balance: 100, payment_made: 0, vendor_credits_applied: 0, ...extra } });
const payment = (extra: Record<string, unknown> = {}) => ({ code: 0, vendorpayment: { payment_id: "401", vendor_id: "201", reference_number: paymentReference(snapshot.payment.id),
  date: "2026-11-05", amount: 10.5, balance: 0, payment_mode: "Cash", paid_through_account_id: "501", currency_id: "601",
  bills: [{ bill_id: "301", amount_applied: 10.5 }], vendorpayment_refunds: [], ...extra } });
const list = (rows: { payment_id: string; reference_number: string }[], page = 1, more = false) => ({ code: 0, vendorpayments: rows, page_context: { page, has_more_page: more } });
const match = { payment_id: "401", reference_number: paymentReference(snapshot.payment.id) };

describe("exact Books payment intent and reconciliation", () => {
  it("builds one exact allocation with deterministic machine reference and preserved user reference", () => {
    const payload = buildPaymentPayload(snapshot, "301");
    expect(payload).toEqual({ vendor_id: "201", amount: 10.5, date: "2026-11-05", payment_mode: "Cash", paid_through_account_id: "501",
      reference_number: paymentReference(snapshot.payment.id), description: "VOLTRONIX payment fictional-payment; bill fictional-bill; reference HUMAN-TRANSFER-REF",
      bills: [{ bill_id: "301", amount_applied: 10.5 }] });
    expect(paymentReference(snapshot.payment.id)).toMatch(/^VX-PAY-[a-f0-9]{40}$/);
    expect(paymentReference("another-payment")).not.toBe(payload.reference_number);
  });
  it("validates actual calendar dates and refuses an unrepresentable payment amount", () => {
    expect(() => paymentSnapshotSchema.parse({ ...snapshot, payment: { ...snapshot.payment, paymentDate: "2026-02-30" } })).toThrow();
    expect(() => buildPaymentPayload({ ...snapshot, payment: { ...snapshot.payment, amount: "9007199254740991.01" } }, "301")).toThrow();
    expect(() => buildPaymentPayload({ ...snapshot, payment: { ...snapshot.payment, amount: "0.00" } }, "301")).toThrow();
  });
  it.each([{ code: 0, payment_id: "401" }, { code: 0, vendorpayment: { payment_id: "401" } }, { code: 0, payment_id: "401", vendorpayment: { payment_id: "401" } }])("accepts a valid acknowledgement shape but never treats it as final proof: %j", raw => {
    expect(paymentAcknowledgementId(raw)).toBe("401");
  });
  it.each([{ code: 0 }, { code: 1, payment_id: "401" }, { code: 0, payment_id: "401", vendorpayment: { payment_id: "402" } }])("keeps malformed or conflicting acknowledgement uncertain: %j", raw => {
    expect(() => paymentAcknowledgementId(raw)).toThrow();
  });
  it("requires the exact existing bill and sufficient truthful balance", () => {
    expect(validatePaymentBill(bill(), snapshot, "301").balance).toBe(100);
    expect(() => validatePaymentBill(bill({ balance: 5, payment_made: 95 }), snapshot, "301")).toThrow();
    expect(validatePaymentBill(bill({ balance: 0, payment_made: 100 }), snapshot, "301", false).balance).toBe(0);
  });
  it.each([{ bill_id: "302" }, { vendor_id: "202" }, { bill_number: "OTHER" }, { date: "2026-10-02" }, { currency_code: "USD" },
    { reference_number: "OTHER" }, { total: 101 }, { balance: 99 }, { payment_made: -1 }, { vendor_credits_applied: 1 }])("rejects changed/unreconciled provider bill fields: %j", extra => {
    expect(() => validatePaymentBill(bill(extra), snapshot, "301")).toThrow();
  });
  it("confirms only a complete exact payment allocation/account/date/currency", () => {
    expect(verifyPaymentConfirmation(payment(), snapshot, "301", "601")).toBe("401");
    expect(verifyPaymentConfirmation(payment({ currency_code: "AED" }), snapshot, "301", "601")).toBe("401");
  });
  it.each([{ vendor_id: "202" }, { reference_number: "HUMAN-TRANSFER-REF" }, { date: "2026-11-06" }, { amount: 11 }, { balance: 1 },
    { payment_mode: "Bank Transfer" }, { paid_through_account_id: "502" }, { currency_id: "602" }, { currency_code: "USD" },
    { bills: [] }, { bills: [{ bill_id: "302", amount_applied: 10.5 }] }, { bills: [{ bill_id: "301", amount_applied: 9 }] },
    { bills: [{ bill_id: "301", amount_applied: 10.5 }, { bill_id: "302", amount_applied: 0 }] },
    { tax_amount_withheld: 1 }, { bills: [{ bill_id: "301", amount_applied: 10.5, tax_amount_withheld: 1 }] }, { vendorpayment_refunds: [{}] },
  ])("refuses conflicting payment evidence: %j", extra => {
    expect(() => verifyPaymentConfirmation(payment(extra), snapshot, "301", "601")).toThrow();
  });
  it("searches the exact bill/vendor/reference and GET-verifies the returned payment", async () => {
    const request = vi.fn().mockResolvedValueOnce(list([match])).mockResolvedValueOnce(payment());
    const transport = { request, config: { booksMapping: { currencies: { AED: { id: "601" } } } } } as unknown as ZohoTransport;
    expect(await reconcileBooksPayment(transport, snapshot, "301")).toBe("401");
    expect(request).toHaveBeenNthCalledWith(1, "/books/v3/vendorpayments", { method: "GET", query: { reference_number: paymentReference(snapshot.payment.id), bill_id: "301", vendor_id: "201", page: "1", per_page: "200" } });
    expect(request).toHaveBeenNthCalledWith(2, "/books/v3/vendorpayments/401", { method: "GET" });
  });
  it("does not treat an incomplete or replayed page as proof of absence", async () => {
    for (const responses of [
      [list([], 1, true), { code: 0, vendorpayments: [], page_context: { has_more_page: false } }],
      [list([match], 1, true), list([match], 2, false)],
      Array.from({ length: 5 }, (_, index) => list([], index + 1, true)),
    ]) {
      const request = vi.fn(); responses.forEach(response => request.mockResolvedValueOnce(response));
      await expect(reconcileBooksPayment({ request } as unknown as ZohoTransport, snapshot, "301")).rejects.toThrow();
      expect(request.mock.calls.every(([, options]) => options.method === "GET")).toBe(true);
    }
  });
  it("refuses duplicate references and mismatched detail IDs", async () => {
    const request = vi.fn().mockResolvedValue(list([match, { ...match, payment_id: "402" }]));
    await expect(reconcileBooksPayment({ request } as unknown as ZohoTransport, snapshot, "301")).rejects.toMatchObject({ code: "PAYMENT_REFERENCE_DUPLICATE" });
    request.mockReset().mockResolvedValueOnce(list([match])).mockResolvedValueOnce(payment({ payment_id: "402" }));
    await expect(reconcileBooksPayment({ request, config: { booksMapping: { currencies: { AED: { id: "601" } } } } } as unknown as ZohoTransport, snapshot, "301"))
      .rejects.toMatchObject({ code: "PAYMENT_CONFIRMATION_CONFLICT" });
  });
});
