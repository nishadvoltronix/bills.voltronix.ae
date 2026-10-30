import { describe, expect, it } from "vitest";
import {
  calculateBill,
  formatMoney,
  getPaymentStatus,
  normalizeInvoiceNumber,
  summarizeJob,
} from "../src/lib/finance";

const oneLine = (price = "100.00", quantity = "1") => [
  { description: "Material", quantity, unitPrice: price },
];
const job = {
  contractValue: "1000000.00",
  approvedVariations: "0",
  currency: "AED",
};
const bill = (overrides = {}) => ({
  id: "bill-1",
  status: "APPROVED",
  currency: "AED",
  subtotal: "500000.00",
  discount: "0",
  total: "525000.00",
  paidAmount: "100000.00",
  ...overrides,
});

describe("decimal-safe invoice calculation", () => {
  it("does not introduce binary floating point errors", () => {
    const result = calculateBill(oneLine("0.10", "3"), "0", "5");
    expect(result.subtotal).toBe("0.30");
    expect(result.vatAmount).toBe("0.02");
    expect(result.total).toBe("0.32");
  });

  it("rounds each line half-up before summing and applies VAT after discount", () => {
    const result = calculateBill(
      [
        { description: "A", quantity: "0.5", unitPrice: "0.01" },
        { description: "B", quantity: "0.5", unitPrice: "0.01" },
        { description: "C", quantity: "1", unitPrice: "100.00" },
      ],
      "10.02",
      "5",
    );
    expect(result.lines.map((line) => line.lineTotal)).toEqual([
      "0.01",
      "0.01",
      "100.00",
    ]);
    expect(result.subtotal).toBe("100.02");
    expect(result.netAmount).toBe("90.00");
    expect(result.vatAmount).toBe("4.50");
    expect(result.total).toBe("94.50");
  });

  it("retains exact large decimal values", () => {
    expect(calculateBill(oneLine("999999999999.99"), "0", "0").total).toBe(
      "999999999999.99",
    );
  });

  it.each([
    () => calculateBill([], "0", "5"),
    () => calculateBill(oneLine("100", "0")),
    () => calculateBill(oneLine("100", "-1")),
    () => calculateBill(oneLine("NaN")),
    () => calculateBill(oneLine("Infinity")),
    () => calculateBill(oneLine("100.001")),
    () => calculateBill(oneLine("100", "1.0001")),
    () => calculateBill(oneLine(), "101"),
    () => calculateBill(oneLine(), "-1"),
    () => calculateBill(oneLine(), "0.001"),
    () => calculateBill(oneLine(), "0", "100.01"),
    () => calculateBill(oneLine(), "0", "-5"),
    () => calculateBill(oneLine("999999999999.99"), "0", "5"),
    () => calculateBill(oneLine(), "100", "0"),
  ])("rejects unsafe or unsupported financial values %#", (operation) => {
    expect(operation).toThrow();
  });
});

describe("job recognition policy", () => {
  it("recognizes a completed entry without approval and keeps payment separate", () => {
    const ready = bill({ status: "READY", paidAmount: "0.00" });
    const result = summarizeJob(job, [ready]);
    expect(result.recognizedExpenses).toBe("500000.00");
    expect(result.outstanding).toBe("525000.00");
    expect(result.paidExpenses).toBe("0.00");
    expect(summarizeJob(job, [ready, ready]).recognizedExpenses).toBe("500000.00");
    expect(summarizeJob(job, [ready, bill({ id: "historical-approved" })]).recognizedExpenses).toBe("1000000.00");
  });

  it("uses approved VAT-exclusive cost and gross payments/outstanding", () => {
    expect(summarizeJob(job, [bill()])).toEqual({
      adjustedValue: "1000000.00",
      recognizedExpenses: "500000.00",
      paidExpenses: "100000.00",
      outstanding: "425000.00",
      remainingBudget: "500000.00",
      estimatedProfit: "500000.00",
      expensePercentage: "50.00",
      budgetStatus: "WITHIN_BUDGET",
    });
  });

  it("does not recognize draft, pending, rejected or cancelled bills", () => {
    const bills = ["DRAFT", "PENDING_APPROVAL", "REJECTED", "CANCELLED"].map(
      (status, i) => bill({ id: `excluded-${i}`, status }),
    );
    expect(summarizeJob(job, bills).recognizedExpenses).toBe("0.00");
    expect(summarizeJob(job, bills).outstanding).toBe("0.00");
  });

  it("does not recognize an already aggregated bill twice", () => {
    expect(summarizeJob(job, [bill(), bill()]).recognizedExpenses).toBe(
      "500000.00",
    );
  });

  it("treats payment as settlement, not a second expense", () => {
    const unpaid = summarizeJob(job, [bill({ paidAmount: "0" })]);
    const paid = summarizeJob(job, [bill({ paidAmount: "525000" })]);
    expect(unpaid.recognizedExpenses).toBe(paid.recognizedExpenses);
    expect(paid.outstanding).toBe("0.00");
  });

  it("includes approved variations and discount exactly once", () => {
    const result = summarizeJob({ ...job, approvedVariations: "50000" }, [
      bill({ discount: "10000" }),
    ]);
    expect(result.adjustedValue).toBe("1050000.00");
    expect(result.recognizedExpenses).toBe("490000.00");
    expect(result.estimatedProfit).toBe("560000.00");
  });

  it("shows the specified provisional loss when expenses exceed value", () => {
    const result = summarizeJob(job, [
      bill({ subtotal: "1100000", total: "1155000" }),
    ]);
    expect(result.estimatedProfit).toBe("-100000.00");
    expect(result.expensePercentage).toBe("110.00");
    expect(result.budgetStatus).toBe("OVER_BUDGET");
  });

  it.each(["900000", "1000000"])(
    "marks %s as near limit without overstating a loss",
    (subtotal) => {
      expect(
        summarizeJob(job, [bill({ subtotal, total: subtotal })]).budgetStatus,
      ).toBe("NEAR_LIMIT");
    },
  );

  it.each([null, "0", "-1"])(
    "suppresses misleading profit when value is %s",
    (contractValue) => {
      const result = summarizeJob({ ...job, contractValue }, [bill()]);
      expect(result.estimatedProfit).toBeNull();
      expect(result.expensePercentage).toBeNull();
      expect(result.budgetStatus).toBe("VALUE_UNAVAILABLE");
      expect(result.recognizedExpenses).toBe("500000.00");
    },
  );

  it("rejects mixed currency aggregation", () => {
    expect(() => summarizeJob(job, [bill({ currency: "USD" })])).toThrow(
      "cannot mix currencies",
    );
  });

  it("rejects corrupt overpayment data", () => {
    expect(() =>
      summarizeJob(job, [bill({ paidAmount: "525000.01" })]),
    ).toThrow("cannot exceed");
  });
});

describe("payment and display helpers", () => {
  it.each([
    ["0", "UNPAID"],
    ["25.05", "PARTIALLY_PAID"],
    ["105.00", "PAID"],
  ])("derives settlement status from %s paid", (paid, expected) => {
    expect(getPaymentStatus("105", paid)).toBe(expected);
  });
  it("rejects overpayment and negative settlement", () => {
    expect(() => getPaymentStatus("100", "100.01")).toThrow();
    expect(() => getPaymentStatus("100", "-1")).toThrow();
  });
  it("normalizes case, whitespace and compatibility characters for duplicate matching", () => {
    expect(normalizeInvoiceNumber("  ｉｎｖ-００１   a  ")).toBe("INV-001 A");
  });
  it("formats large values without a number conversion", () => {
    expect(formatMoney("999999999999.99", "AED")).toBe(
      "AED 999,999,999,999.99",
    );
    expect(formatMoney("-100000.00")).toBe("AED -100,000.00");
    expect(formatMoney(null)).toBe("—");
  });
});
