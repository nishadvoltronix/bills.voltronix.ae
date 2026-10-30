import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BooksBillRecord } from "@/components/books-bills";
import type { BooksBillDetail } from "@/lib/services/books-import";

const bill = {
  id: "fictional-import",
  companyId: "fictional-company",
  companyName: "Fictional Company",
  organizationId: "990001",
  externalBillId: "990002",
  billNumber: "FICTIONAL-1",
  vendorId: "990003",
  vendorName: "Fictional Supplier",
  status: "partially_paid",
  currencyCode: "KWD",
  billDate: "2026-10-01",
  dueDate: "2026-10-31",
  subtotal: "9007199254740993.001",
  taxTotal: "0.000",
  total: "9007199254740993.001",
  balance: "9007199254740990.001",
  paymentMade: "2.000",
  vendorCreditsApplied: "1.000",
  detailAvailable: true,
  lastSeenAt: "2026-10-29T10:00:00Z",
  importedAt: "2026-10-29T10:00:00Z",
  detailFetchedAt: "2026-10-29T10:01:00Z",
  isStale: false,
  referenceNumber: "Fictional reference",
  notes: "<script>fictional</script>",
  terms: null,
  sourceModifiedAt: "2026-10-28T10:00:00Z",
  hasAttachment: true,
  attachmentCount: 1,
  attachmentsDownloaded: false,
  downloadedAttachmentCount: 0,
  attachmentStatus: "PENDING",
  lines: [
    {
      id: "line",
      name: "Fictional material",
      description: null,
      quantity: "1.000",
      rate: "9007199254740993.001",
      total: "9007199254740993.001",
      accountName: "Fictional expense",
      taxName: null,
      taxPercentage: null,
      projectName: null,
    },
  ],
  payments: [
    {
      id: "payment",
      date: "2026-10-20",
      amount: "2.000",
      referenceNumber: "Fictional payment",
      paymentMode: "Cash",
    },
  ],
  credits: [
    {
      id: "credit",
      number: "Fictional credit",
      date: "2026-10-21",
      amount: "1.000",
    },
  ],
  documents: [
    {
      id: "document",
      name: "Fictional attachment.pdf",
      attachmentId: null,
      downloaded: false,
      status: "PENDING",
      fileName: null,
      mimeType: null,
      byteSize: null,
      downloadedAt: null,
    },
  ],
} satisfies BooksBillDetail;

describe("read-only imported Books bill presentation", () => {
  it("preserves native precision and statuses, separates credits and payments and escapes source text", () => {
    const html = renderToStaticMarkup(createElement(BooksBillRecord, { bill }));
    expect(html).toContain("KWD 9007199254740993.001");
    expect(html).toContain("partially_paid");
    expect(html).toContain("Payments made");
    expect(html).toContain("Vendor credits applied");
    expect(html).toContain("KWD 2.000");
    expect(html).toContain("KWD 1.000");
    expect(html).toContain("&lt;script&gt;fictional&lt;/script&gt;");
    expect(html).not.toContain("<script>fictional</script>");
    expect(html).not.toContain("Save and sync");
    expect(html).not.toContain("Record payment");
    expect(html).toContain("Original files have not been downloaded");
    expect(html).toContain("Fictional attachment.pdf");
    expect(html).toContain("Not downloaded yet");
    expect(html).not.toContain("/attachments/");
  });

  it("distinguishes unavailable detail from empty financial records and exposes no attachment download", () => {
    const html = renderToStaticMarkup(
      createElement(BooksBillRecord, {
        bill: {
          ...bill,
          detailAvailable: false,
          detailFetchedAt: null,
          lines: [],
          payments: [],
          credits: [],
          documents: [],
          paymentMade: null,
          vendorCreditsApplied: null,
        },
      }),
    );
    expect(html).toContain("Only the bill summary has been downloaded");
    expect(html).toContain("Payments have not been downloaded");
    expect(html).toContain("Vendor credits have not been downloaded");
    expect(html).toContain("Attachment details have not been downloaded");
    expect(html).not.toContain("No payment records were returned");
    expect(html).not.toContain("download=");
  });

  it("offers authenticated original-file links only for available attachments and reports partial coverage", () => {
    const html = renderToStaticMarkup(
      createElement(BooksBillRecord, {
        bill: {
          ...bill,
          id: "bill/with space",
          attachmentCount: 2,
          downloadedAttachmentCount: 1,
          attachmentStatus: "PARTIAL",
          documents: [
            {
              id: "available",
              name: "Source document name",
              attachmentId: "local/id",
              downloaded: true,
              status: "AVAILABLE",
              fileName: "Fictional original <1>.pdf",
              mimeType: "application/pdf",
              byteSize: 2048,
              downloadedAt: "2026-10-29T12:00:00Z",
            },
            bill.documents[0],
          ],
        },
      }),
    );
    expect(html).toContain("1 of 2 original files downloaded from Zoho Books");
    expect(html).toContain("Fictional original &lt;1&gt;.pdf");
    expect(html).toContain("Downloaded · 2.0 KB");
    expect(html).toContain(
      'href="/api/bills/books/bill%2Fwith%20space/attachments/local%2Fid"',
    );
    expect(html).toContain(
      'href="/api/bills/books/bill%2Fwith%20space/attachments/local%2Fid?download=1"',
    );
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
    expect(html).toContain("Not downloaded yet");
    expect(html).not.toContain("/attachments/document");
    expect(html).not.toContain("zoho.com");
  });

  it("reports complete coverage and does not suggest that available originals must be viewed in Zoho", () => {
    const html = renderToStaticMarkup(
      createElement(BooksBillRecord, {
        bill: {
          ...bill,
          downloadedAttachmentCount: 1,
          attachmentsDownloaded: true,
          attachmentStatus: "COMPLETE",
          documents: [
            {
              ...bill.documents[0],
              attachmentId: "original",
              downloaded: true,
              status: "AVAILABLE",
              fileName: "Fictional attachment.pdf",
              mimeType: "application/pdf",
              byteSize: 1024,
              downloadedAt: "2026-10-29T12:00:00Z",
            },
          ],
        },
      }),
    );
    expect(html).toContain("1 of 1 original files downloaded from Zoho Books");
    expect(html).not.toContain("Not downloaded yet");
    expect(html).not.toContain("Original files have not been downloaded");
  });
});
