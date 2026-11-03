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
  it("shows the saved supplier, job, totals and a real amount/reference form for an unpaid bill", () => {
    const html = render();
    expect(html).toContain("Fictional supplier"); expect(html).toContain("JOB-FICTIONAL");
    expect(html).toContain("Invoice total"); expect(html).toContain("Balance due");
    expect(html).toContain('value="105.00"'); expect(html).toContain("Payment reference");
    expect(html).toContain("does not transfer funds or update Zoho Books");
    expect(html).not.toContain('aria-label="Paid in full"');
    expect(html).not.toMatch(/type="date"|Payment method|Bank account|Mark as paid/);
  });
  it("keeps partial payment distinct and uses only the remaining amount", () => {
    const html = render({ paymentStatus: "PARTIALLY_PAID", paidAmount: "40.00", payments: [{ id: "payment", amount: "40.00",
      reference: "FICTIONAL-RECEIPT", createdAt: "2026-11-03T08:00:00.000Z" }] });
    expect(html).toContain("partially paid"); expect(html).toContain('value="65.00"');
    expect(html).toContain("FICTIONAL-RECEIPT"); expect(html).toContain("Recorded on (Dubai)");
    expect(html).not.toContain('aria-label="Paid in full"');
  });
  it("shows the green-ribbon label and no entry form only after the server confirms exact full payment", () => {
    const html = render({ paymentStatus: "PAID", paidAmount: "105.00" });
    expect(html).toContain('aria-label="Paid in full"'); expect(html).toContain("This bill has no outstanding amount.");
    expect(html).not.toContain("Confirm payment");
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
