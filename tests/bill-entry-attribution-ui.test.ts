import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BillTable } from "@/components/records";
import { ImportedBillsTable } from "@/components/imported-bills-table";
import type { Bill, ImportedBillSummary } from "@/components/types";

const bills: Bill[] = ["One", "Two", "Three"].map((name, index) => ({
  id: `bill-${index}`, companyId: "company", invoiceNumber: `FICTIONAL-${index}`, vendorId: "supplier", jobId: "shared-job",
  invoiceDate: "2026-01-01", category: "MATERIALS", currency: "AED", status: "DRAFT", discount: "0.00", vatRate: "0.00",
  total: "10.00", version: 1, createdAt: "2026-01-01T00:00:00.000Z", createdBy: { id: `user-${index}`, name: `Entrant ${name}` },
}));

describe("bill entry attribution presentation", () => {
  it("shows each of three entrants beside their own bill in the same job", () => {
    const html = renderToStaticMarkup(createElement(BillTable, { bills, showJob: false, showEnteredBy: true }));
    expect(html).toContain("<th>Entered by</th>");
    const rows = html.match(/<tr>.*?<\/tr>/g) ?? [];
    bills.forEach((bill, index) => {
      expect(rows[index + 1]).toContain(bill.invoiceNumber);
      expect(rows[index + 1]).toContain(bill.createdBy!.name);
      bills.filter(other => other.id !== bill.id).forEach(other => expect(rows[index + 1]).not.toContain(other.createdBy!.name));
    });
  });
  it("leaves attribution hidden unless the Admin parent enables it", () => {
    const html = renderToStaticMarkup(createElement(BillTable, { bills }));
    expect(html).not.toContain("Entered by");
    expect(html).not.toContain("Entrant One");
  });
  it("labels unknown imported entrants without inventing a local author", () => {
    const imported: ImportedBillSummary[] = [null, bills[1].createdBy!].map((enteredBy, index) => ({
      id: `import-${index}`, billNumber: `SOURCE-${index}`, companyId: "company", companyName: "Fictional company",
      vendorName: "Fictional supplier", currency: "AED", total: "10.00", status: "open", billDate: "2026-01-01",
      jobId: "shared-job", jobNumber: "JOB-SHARED", href: `/bills/books/import-${index}`, enteredBy,
    }));
    const html = renderToStaticMarkup(createElement(ImportedBillsTable, { bills: imported, showEnteredBy: true }));
    const rows = html.match(/<tr>.*?<\/tr>/g) ?? [];
    expect(rows[1]).toContain("Not recorded locally");
    expect(rows[1]).not.toContain("Entrant");
    expect(rows[2]).toContain("Entrant Two");
  });
});
