import { describe, expect, it } from "vitest";
import { assertBooksLineTaxMode, booksLineTaxMode, booksSelectionFields, booksSelectionSchema, type BooksSelection } from "@/lib/books-selection";
import { calculateBill } from "@/lib/finance";
import { billInputSchema } from "@/lib/validation";

export const selection: BooksSelection = { organizationId: "100", dataCenter: "US", environment: "sandbox",
  accountId: "110", accountName: "Reviewed expense", taxId: "120", taxName: "Standard rate", taxRate: "5.00",
  customerId: null, customerName: null };
const line = (price: string, booksSelection: BooksSelection | null = selection) => ({
  description: "Fictional selected purchase", quantity: "1", unitPrice: price, booksSelection,
});

describe("Books selections and grouped line taxes", () => {
  it("derives the tax mode from complete selections and rejects inconsistent saved modes", () => {
    expect(booksLineTaxMode([line("10", null)])).toBe(false);
    expect(booksLineTaxMode([line("10")])).toBe(true);
    expect(() => booksLineTaxMode([line("10"), line("10", null)])).toThrow();
    expect(() => assertBooksLineTaxMode(false, [line("10")])).toThrow(/mode/);
    expect(() => assertBooksLineTaxMode(true, [line("10", null)])).toThrow(/mode/);
    expect(() => assertBooksLineTaxMode(undefined, [line("10", null)])).not.toThrow();
    expect(() => assertBooksLineTaxMode(true, [line("10")])).not.toThrow();
  });
  it("keeps null legacy lines byte-for-byte equivalent to omitted selections", () => {
    const legacy = [{ description: "Fictional selected purchase", quantity: "1", unitPrice: "100.00" }];
    expect(calculateBill([line("100.00", null)], "10", "5")).toEqual(calculateBill(legacy, "10", "5"));
    expect(booksSelectionFields(null)).toEqual({});
    expect(booksSelectionFields(undefined)).toEqual({});
  });
  it("groups by exact tax ID before rounding instead of rounding each line", () => {
    const result = calculateBill([line("0.10"), line("0.10")], "0", "0");
    expect(result).toMatchObject({ subtotal: "0.20", vatAmount: "0.01", total: "0.21", vatRate: "5.00" });
    expect(result.lines[0].booksSelection).toEqual(selection);
  });
  it("keeps different tax IDs distinct even with the same percentage", () => {
    expect(calculateBill([line("0.10"), line("0.10", { ...selection, taxId: "121" })], "0", "5").vatAmount).toBe("0.02");
  });
  it("sums mixed zero and standard rates from the selected IDs, ignoring the header rate", () => {
    const result = calculateBill([line("100.00"), line("100.00", { ...selection, taxId: "121", taxRate: "0.00" })], "0", "99");
    expect(result).toMatchObject({ subtotal: "200.00", vatAmount: "5.00", total: "205.00", vatRate: "0.00" });
  });
  it("rounds fractional line quantities before grouping their selected tax", () => {
    const result = calculateBill([{ ...line("0.01"), quantity: "0.5" }, { ...line("0.01"), quantity: "0.5" }]);
    expect(result.lines.map((item) => item.lineTotal)).toEqual(["0.01", "0.01"]);
    expect(result.total).toBe("0.02");
  });
  it.each([
    () => calculateBill([line("10.00"), line("10.00", null)]),
    () => calculateBill([line("10.00")], "1", "5"),
    () => calculateBill([line("10.00"), line("10.00", { ...selection, organizationId: "200" })]),
    () => calculateBill([line("10.00"), line("10.00", { ...selection, taxRate: "10.00" })]),
    () => calculateBill([line("10.00", { ...selection, taxRate: "100.01" })]),
  ])("rejects unsupported or inconsistent line calculations %#", (operation) => {
    expect(operation).toThrow();
  });
  it("requires complete bounded identity and strips nothing silently", () => {
    expect(booksSelectionSchema.safeParse({ ...selection, verified: true }).success).toBe(false);
    expect(booksSelectionSchema.safeParse({ ...selection, customerId: "130", customerName: null }).success).toBe(false);
    expect(booksSelectionSchema.safeParse({ ...selection, accountId: "../bills" }).success).toBe(false);
    expect(booksSelectionSchema.safeParse({ ...selection, accountName: "Account\nInjected" }).success).toBe(false);
    expect(booksSelectionSchema.safeParse({ ...selection, taxRate: "NaN" }).success).toBe(false);
  });
  it("accepts explicit selections through bill validation without asserting they are verified", () => {
    const result = billInputSchema.parse({ vendorId: "supplier", jobId: "job", invoiceNumber: "FICTIONAL-1",
      invoiceDate: "2026-10-29", category: "LABOUR", currency: "AED", lines: [line("10.00")] });
    expect(result.lines[0].booksSelection).toEqual(selection);
  });
});
