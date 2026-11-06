import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NativeBillPaymentRecord } from "@/components/native-bill-payment";
import { NativePaidRibbon } from "@/components/native-paid-ribbon";
import type { Bill } from "@/components/types";

const bill: Bill = {
  id: "fictional-payment-bill", companyId: "fictional-company", invoiceNumber: "FICTIONAL-PAYMENT", vendorId: "supplier", jobId: "job",
  invoiceDate: "2026-11-03", category: "MATERIALS", currency: "AED", status: "READY", paymentStatus: "UNPAID", total: "105.00",
  paidAmount: "0.00", discount: "0.00", vatRate: "5.00", version: 1, createdAt: "2026-11-03T08:00:00.000Z",
  vendor: { id: "supplier", companyId: "fictional-company", name: "Fictional supplier", currency: "AED" },
  job: { id: "job", companyId: "fictional-company", jobNumber: "JOB-FICTIONAL", name: "Fictional project", customer: "Fictional customer", currency: "AED",
    contractValue: null, approvedVariations: null }, payments: [],
};
const render = (changes: Partial<Bill> = {}) => renderToStaticMarkup(createElement(NativeBillPaymentRecord, { bill: { ...bill, ...changes } }));

describe("native bill payment presentation", () => {
  it("shows the saved bill and requires actual payment facts without claiming a funds transfer", () => {
    const html = render();
    expect(html).toContain("Fictional supplier"); expect(html).toContain("JOB-FICTIONAL");
    expect(html).toContain("Invoice total"); expect(html).toContain("Balance due");
    expect(html).toContain('value="105.00"'); expect(html).toContain("Payment reference");
    expect(html).toContain("does not transfer money");
    expect(html).toContain('type="date"'); expect(html).toContain("Payment method");
    expect(html).toContain("Paid through account");
    expect(html).toContain("Select the actual payment method");
    expect(html).not.toContain('aria-label="Paid in full"');
    expect(html).not.toContain("Mark as paid");
  });
  it("keeps partial payment distinct and uses only the remaining amount", () => {
    const html = render({ paymentStatus: "PARTIALLY_PAID", paidAmount: "40.00", payments: [{ id: "payment", amount: "40.00",
      reference: "FICTIONAL-RECEIPT", createdAt: "2026-11-03T08:00:00.000Z" }] });
    expect(html).toContain("partially paid"); expect(html).toContain('value="65.00"');
    expect(html).toContain("FICTIONAL-RECEIPT"); expect(html).toContain("Not supplied");
    expect(html).toContain("Not sent to Zoho Books: payment details are missing.");
    expect(html).not.toContain('aria-label="Paid in full"');
  });
  it("shows the green-ribbon label and no entry form only after the server confirms exact full payment", () => {
    const html = render({ paymentStatus: "PAID", paidAmount: "105.00" });
    expect(html).toContain('aria-label="Paid in full"'); expect(html).toContain("This bill has no outstanding amount.");
    expect(html).not.toContain("Confirm payment");
  });
  it("does not infer a confirmed Books payment from a local Paid bill or its synced bill record", () => {
    const html = render({ paymentStatus: "PAID", paidAmount: "105.00",
      syncRecords: [{ id: "synced-bill", status: "SYNCED", externalId: "fictional-books-bill" }],
      payments: [{ id: "payment", amount: "105.00", createdAt: "2026-11-06T08:00:00Z", paymentDate: "2026-11-05",
        paymentMode: "Cash", paidThroughAccountId: "fictional-cash",
        booksSync: { status: "QUEUED", externalPaymentId: null, errorCode: null } }] });
    expect(html).toContain("Local payment summary");
    expect(html).toContain("05 Nov 2026");
    expect(html).toContain("Queued for Zoho Books.");
    expect(html).not.toContain("Payment confirmed in Zoho Books.");
  });
  it("requires a remote payment identity before presenting Books confirmation", () => {
    const payment = { id: "payment", amount: "105.00", createdAt: "2026-11-06T08:00:00Z" };
    expect(render({ payments: [{ ...payment, booksSync: { status: "SYNCED", externalPaymentId: null } }] }))
      .toContain("Zoho Books payment confirmation is unavailable.");
    expect(render({ payments: [{ ...payment, booksSync: { status: "SYNCED", externalPaymentId: "fictional-books-payment" } }] }))
      .toContain("Payment confirmed in Zoho Books.");
  });
  it.each([
    { status: "DRAFT", paymentStatus: "PAID", paidAmount: "105.00" },
    { status: "CANCELLED", paymentStatus: "PAID", paidAmount: "105.00" },
    { paymentStatus: "UNPAID", paidAmount: "105.00" },
    { paymentStatus: "PAID", paidAmount: "40.00" },
    { paymentStatus: "PAID", total: "0.00", paidAmount: "0.00" },
    { paymentStatus: "PAID", paidAmount: "106.00" },
    { paymentStatus: "PAID", total: "invalid", paidAmount: "105.00" },
  ])("withholds a Paid ribbon for incomplete or contradictory evidence: %j", changes => {
    expect(renderToStaticMarkup(createElement(NativePaidRibbon, { bill: { ...bill, ...changes } }))).toBe("");
  });
  it("withholds actions for draft, cancelled or invalid amount records", () => {
    for (const changes of [{ status: "DRAFT" }, { status: "CANCELLED" }, { total: "invalid" }])
      expect(render(changes)).not.toContain("Confirm payment");
  });
});
