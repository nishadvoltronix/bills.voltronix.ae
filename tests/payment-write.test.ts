import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZohoTransport } from "@/lib/integrations/transport";
import { buildPaymentPayload, paymentSourceHash, type PaymentSnapshot } from "@/lib/integrations/books-payments";
import { consumePaymentBooksWrite, paymentWriteCapability, paymentWriteWasSubmitted, type PaymentWriteCapability } from "@/lib/integrations/payment-write";
import { stableReference } from "@/lib/integrations/books";
import type { ZohoConfig } from "@/lib/integrations/config";

const store = vi.hoisted(() => ({ paymentBooksSync: { findUnique: vi.fn(), findFirst: vi.fn() }, integrationJob: { count: vi.fn() } }));
const source = vi.hoisted(() => ({ assertPaymentBooksSource: vi.fn(), assertPaymentAccount: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: store }));
vi.mock("@/lib/services/payment-books-sync", () => source);
vi.mock("@/lib/integrations/oauth", () => ({ accessToken: vi.fn(async () => "FICTIONAL-NOT-LOGGED") }));
const config: ZohoConfig = { target: "ZOHO", dataCenter: "US", organizationId: "100", environment: "production", accountsOrigin: "https://accounts.zoho.com", apiOrigin: "https://www.zohoapis.com",
  clientId: "fictional", clientSecret: "fictional", networkEnabled: true, writeEnabled: true, liveRuntime: true,
  booksMapping: { verified: true, baseCurrency: "AED", currencies: { AED: { id: "101" } }, categories: {}, taxes: {} } };
const snapshot: PaymentSnapshot = { payment: { id: "payment", billId: "bill", amount: "10.00", reference: "HUMAN-REF", createdById: "actor", createdAt: "2026-11-06T10:00:00Z",
  paymentDate: "2026-11-06", paymentMode: "Cash", paidThroughAccountId: "400" },
  bill: { id: "bill", companyId: "company", createdById: "owner", vendorId: "vendor", jobId: "job", invoiceNumber: "INV", invoiceDate: "2026-11-01", currency: "AED", total: "100.00", externalVendorId: "200", sourceHash: "a".repeat(64) },
  destination: { organizationId: "100", dataCenter: "US", environment: "production", connectionFingerprint: "b".repeat(64), configurationHash: "c".repeat(64) } };
const payload = buildPaymentPayload(snapshot, "300");
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const fetcher = vi.fn(async (input: string | URL, options?: RequestInit) => {
  const path = new URL(input).pathname;
  if (path === "/books/v3/organizations/100") return json({ code: 0, organization: { organization_id: "100", is_org_active: true, currency_code: "AED", currency_id: "101" } });
  if (path === "/books/v3/bills/300") return json({ code: 0, bill: { bill_id: "300", vendor_id: "200", bill_number: "INV", date: "2026-11-01", reference_number: stableReference("bill"), currency_code: "AED", total: 100, balance: 100, payment_made: 0, vendor_credits_applied: 0 } });
  if (path === "/books/v3/vendorpayments" && options?.method === "POST") return json({ code: 0, payment_id: "500" });
  throw new Error("Unexpected mocked provider endpoint.");
});
function writer(capability?: PaymentWriteCapability) { return new ZohoTransport(config, async () => "fictional", fetcher, undefined, undefined, undefined, capability); }
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal("fetch", fetcher);
  store.paymentBooksSync.findUnique.mockResolvedValue({ id: "outbox", paymentId: "payment", billId: "bill", companyId: "company", organizationId: "100", dataCenter: "US", environment: "production",
    status: "PROCESSING", leaseToken: "lease", leaseUntil: new Date(Date.now() + 60_000), submittedAt: new Date(), externalBillId: "300", externalPaymentId: null, snapshot, sourceHash: paymentSourceHash(snapshot) });
  store.paymentBooksSync.findFirst.mockResolvedValue({ id: "outbox" }); store.integrationJob.count.mockResolvedValue(0);
  source.assertPaymentBooksSource.mockResolvedValue({ snapshot, externalBillId: "300" }); source.assertPaymentAccount.mockResolvedValue({ id: "400" });
});
afterEach(() => vi.unstubAllGlobals());

describe("opaque exact-payment production write boundary", () => {
  it("rejects production payment writes without a current capability", async () => {
    await expect(writer().request("/books/v3/vendorpayments", { method: "POST", body: payload })).rejects.toMatchObject({ code: "LIVE_PERMISSION_REQUIRED" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("checks source/account/balance twice and permits one exact POST only", async () => {
    const capability = paymentWriteCapability("outbox", "lease");
    await expect(writer(capability).request("/books/v3/vendorpayments", { method: "POST", body: payload })).resolves.toMatchObject({ payment_id: "500" });
    expect(paymentWriteWasSubmitted(capability)).toBe(true);
    expect(source.assertPaymentAccount).toHaveBeenCalledTimes(2);
    expect(source.assertPaymentBooksSource).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    await expect(writer(capability).request("/books/v3/vendorpayments", { method: "POST", body: payload })).rejects.toMatchObject({ code: "PAYMENT_WRITE_PERMISSION_REQUIRED" });
    expect(() => consumePaymentBooksWrite(capability)).toThrow();
  });
  it.each(["amount", "vendor_id", "paid_through_account_id", "bills"])("rejects a changed %s before network writes", async field => {
    const changed = { ...payload, [field]: field === "bills" ? [{ bill_id: "999", amount_applied: 10 }] : "999" };
    await expect(writer(paymentWriteCapability("outbox", "lease")).request("/books/v3/vendorpayments", { method: "POST", body: changed })).rejects.toMatchObject({ code: "PAYMENT_WRITE_PERMISSION_REQUIRED" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["/books/v3/bills", "/books/v3/contacts", "/books/v3/vendorpayments/500"])("does not authorize a different endpoint: %s", async path => {
    await expect(writer(paymentWriteCapability("outbox", "lease")).request(path, { method: "POST", body: payload })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("denies copied capabilities, expired leases and concurrent bill writes", async () => {
    await expect(writer({} as PaymentWriteCapability).request("/books/v3/vendorpayments", { method: "POST", body: payload })).rejects.toThrow();
    store.paymentBooksSync.findUnique.mockResolvedValueOnce(null);
    await expect(writer(paymentWriteCapability("outbox", "lease")).request("/books/v3/vendorpayments", { method: "POST", body: payload })).rejects.toThrow();
    store.integrationJob.count.mockResolvedValue(1);
    await expect(writer(paymentWriteCapability("outbox", "lease")).request("/books/v3/vendorpayments", { method: "POST", body: payload })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rechecks lease after fresh reads and never consumes rejected authority", async () => {
    store.paymentBooksSync.findFirst.mockResolvedValue(null);
    const capability = paymentWriteCapability("outbox", "lease");
    await expect(writer(capability).request("/books/v3/vendorpayments", { method: "POST", body: payload })).rejects.toThrow();
    expect(paymentWriteWasSubmitted(capability)).toBe(false);
    expect(fetcher.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
  });
});
