import { describe, expect, it } from "vitest";
import {
  PAYMENT_TERMS,
  resolveDueDate,
  type PaymentTerm,
} from "../src/lib/payment-terms";

describe("bill payment terms", () => {
  it.each([
    ["DUE_ON_RECEIPT", "2026-10-27"],
    ["NET_7", "2026-11-03"],
    ["NET_15", "2026-11-11"],
    ["NET_30", "2026-11-26"],
    ["NET_45", "2026-12-11"],
    ["NET_60", "2026-12-26"],
  ] as const)("calculates %s from the invoice date", (term, expected) => {
    expect(resolveDueDate("2026-10-27", term)).toBe(expected);
  });

  it("uses calendar days through month and year boundaries", () => {
    expect(resolveDueDate("2026-01-31", "NET_15")).toBe("2026-02-15");
    expect(resolveDueDate("2026-12-20", "NET_15")).toBe("2027-01-04");
  });

  it("handles leap years without relying on the host timezone", () => {
    expect(resolveDueDate("2024-02-20", "NET_15")).toBe("2024-03-06");
    expect(resolveDueDate("2025-02-20", "NET_15")).toBe("2025-03-07");
    expect(resolveDueDate("2024-02-29", "DUE_ON_RECEIPT")).toBe("2024-02-29");
  });

  it("recalculates preset dates when the bill date changes", () => {
    expect(resolveDueDate("2026-10-27", "NET_15")).toBe("2026-11-11");
    expect(resolveDueDate("2026-10-28", "NET_15")).toBe("2026-11-12");
  });

  it("preserves custom due dates and permits an unspecified custom date", () => {
    expect(resolveDueDate("2026-10-27", "CUSTOM", "2026-11-19")).toBe(
      "2026-11-19",
    );
    expect(resolveDueDate("2026-10-27", "CUSTOM")).toBe("");
  });

  it.each([
    "2026-02-30",
    "2025-02-29",
    "10/27/2026",
    "1899-12-31",
    "2200-01-01",
    "",
  ])("rejects invalid invoice date %s", (invoiceDate) =>
    expect(() => resolveDueDate(invoiceDate, "NET_15")).toThrow(),
  );

  it("rejects custom dates before the invoice or outside the valid calendar", () => {
    expect(() =>
      resolveDueDate("2026-10-27", "CUSTOM", "2026-10-26"),
    ).toThrow();
    expect(() =>
      resolveDueDate("2026-10-27", "CUSTOM", "2026-11-31"),
    ).toThrow();
  });

  it("rejects a preset whose calculated date exceeds the supported range", () => {
    expect(() => resolveDueDate("2199-12-31", "NET_7")).toThrow();
  });

  it("rejects unknown terms and exposes unique supported options", () => {
    expect(() =>
      resolveDueDate("2026-10-27", "NET_999" as PaymentTerm),
    ).toThrow();
    expect(new Set(PAYMENT_TERMS.map(({ value }) => value)).size).toBe(
      PAYMENT_TERMS.length,
    );
  });
});
