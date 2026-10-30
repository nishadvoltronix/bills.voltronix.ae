import { describe, expect, it, vi } from "vitest";
import { parseBooksBillDetail, parseBooksBillPage } from "@/lib/services/books-import";

vi.mock("@/lib/db", () => ({ db: {} }));
const summary = { bill_id: "1001", vendor_id: "2001", vendor_name: "Fictional Supplier", bill_number: "F-1",
  status: "partially_paid", currency_code: "KWD", date: "2026-10-01", due_date: "2026-10-31",
  total: "9007199254740993.001", balance: "9007199254740990.001", custom_fields: [{ label: "Retained", value: "original" }] };
const page = { code: 0, bills: [summary], page_context: { page: 1, has_more_page: false } };
const detail = { code: 0, bill: { ...summary, sub_total: "9007199254740993.001", tax_total: "0.000",
  payment_made: "2.000", vendor_credits_applied: "1.000", line_items: [], edition_specific_field: { enabled: true } } };

describe("faithful Books snapshot validation", () => {
  it("retains exact source fields and arbitrary currency precision without status mapping", () => {
    expect(parseBooksBillPage(page, 1)).toEqual({ bills: [summary], hasMore: false });
    expect(parseBooksBillDetail(detail, "1001")).toEqual(detail.bill);
    expect(parseBooksBillDetail(detail, "1001").total).toBe("9007199254740993.001");
  });
  it.each([
    { ...page, page_context: undefined },
    { ...page, page_context: { page: 2, has_more_page: false } },
    { ...page, page_context: { page: 1, has_more_page: "false" } },
    { ...page, bills: [summary, summary] },
    { ...page, bills: [], page_context: { page: 1, has_more_page: true } },
    { ...page, bills: [{ ...summary, date: "2026-02-31" }] },
    { ...page, bills: [{ ...summary, total: "NaN" }] },
    { ...page, bills: [{ ...summary, balance: undefined }] },
    { ...page, code: 57 },
  ])("refuses incomplete or inconsistent pagination without silently dropping bills", (input) => {
    expect(() => parseBooksBillPage(input, 1)).toThrow();
  });
  it("rejects mismatched bill identities and summary responses masquerading as detail", () => {
    expect(() => parseBooksBillDetail(detail, "9999")).toThrow();
    expect(() => parseBooksBillDetail({ code: 0, bill: summary }, "1001")).toThrow();
    expect(() => parseBooksBillDetail({ ...detail, bill: { ...detail.bill, line_items: undefined } }, "1001")).toThrow();
  });
});
