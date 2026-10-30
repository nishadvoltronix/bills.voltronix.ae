import { describe, expect, it } from "vitest";
import { csv, csvCell, parseReportFilters } from "@/lib/reports";
describe("report filters and safe spreadsheet exports", () => {
  it("accepts the completed-entry status independently of historical approvals", () => {
    expect(parseReportFilters(new URLSearchParams({ status: "READY" })).status).toBe("READY");
    expect(parseReportFilters(new URLSearchParams({ status: "APPROVED" })).status).toBe("APPROVED");
  });
  it.each([
    '=HYPERLINK("bad")',
    " +SUM(A1)",
    "\t@SUM(A1)",
    "\ncommand",
    "-2+3",
  ])("neutralizes formula-like text %s", (value) =>
    expect(csvCell(value)).toMatch(/^"'/),
  );
  it("quotes delimiters and embedded quotes", () =>
    expect(csv([["A,B", 'a"b']])).toBe('\uFEFF"A,B","a""b"'));
  it("rejects reversed or nonexistent calendar ranges", () => {
    expect(() =>
      parseReportFilters(
        new URLSearchParams({ from: "2026-03-01", to: "2026-02-28" }),
      ),
    ).toThrow();
    expect(() =>
      parseReportFilters(new URLSearchParams({ from: "2026-02-30" })),
    ).toThrow();
  });
  it("rejects unsupported scope filters instead of ignoring them", () =>
    expect(() =>
      parseReportFilters(new URLSearchParams({ createdById: "someone" })),
    ).toThrow());
});
