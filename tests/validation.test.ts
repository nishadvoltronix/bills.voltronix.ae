import { describe, expect, it } from "vitest";
import {
  billActionSchema,
  billInputSchema,
  jobSchema,
  loginSchema,
  vendorSchema,
} from "../src/lib/validation";
import {
  billScope,
  canApproveBill,
  canCreateBill,
  canEditBill,
  canManageJobs,
  canManageVendors,
  canViewBill,
  canViewFinancialSummary,
} from "../src/lib/permissions";

const input = {
  vendorId: "vendor-1",
  jobId: "job-1",
  invoiceNumber: "INV-1",
  invoiceDate: "2026-10-27",
  category: "MATERIALS",
  currency: "AED",
  discount: "0",
  vatRate: "5",
  lines: [{ description: "Material", quantity: "1", unitPrice: "100.00" }],
};

describe("server input schemas", () => {
  it("accepts a valid input and defaults to draft", () => {
    expect(billInputSchema.parse(input).submit).toBe(false);
    expect(billInputSchema.parse(input).paymentTerms).toBe("CUSTOM");
  });
  it("accepts and trims an optional order number without requiring it", () => {
    expect(
      billInputSchema.parse({ ...input, orderNumber: "  PO-1024  " })
        .orderNumber,
    ).toBe("PO-1024");
    expect(
      billInputSchema.safeParse({ ...input, orderNumber: "x".repeat(121) })
        .success,
    ).toBe(false);
    expect(
      billInputSchema.safeParse({ ...input, orderNumber: 123 }).success,
    ).toBe(false);
    expect(
      billInputSchema.safeParse({ ...input, orderNumber: "" }).success,
    ).toBe(true);
  });
  it("derives a missing or blank preset due date on the server", () => {
    expect(
      billInputSchema.parse({ ...input, paymentTerms: "NET_15" }).dueDate,
    ).toBe("2026-11-11");
    expect(
      billInputSchema.parse({ ...input, paymentTerms: "NET_30", dueDate: "" })
        .dueDate,
    ).toBe("2026-11-26");
  });
  it("rejects contradictory preset due dates and unsupported payment terms", () => {
    expect(
      billInputSchema.safeParse({
        ...input,
        paymentTerms: "NET_15",
        dueDate: "2026-11-12",
      }).success,
    ).toBe(false);
    expect(
      billInputSchema.safeParse({ ...input, paymentTerms: "NET_999" }).success,
    ).toBe(false);
    expect(
      billInputSchema.safeParse({ ...input, paymentTerms: null }).success,
    ).toBe(false);
    expect(
      billInputSchema.safeParse({
        ...input,
        paymentTerms: "NET_15",
        dueDate: "2026-11-11",
      }).success,
    ).toBe(true);
  });
  it("retains manually specified custom due dates", () => {
    expect(
      billInputSchema.parse({
        ...input,
        paymentTerms: "CUSTOM",
        dueDate: "2026-11-12",
      }).dueDate,
    ).toBe("2026-11-12");
  });
  it.each([
    "2026-02-30",
    "2026-13-01",
    "2026-10-32",
    "not-a-date",
    "1899-12-31",
  ])("rejects invalid calendar date %s", (invoiceDate) => {
    expect(billInputSchema.safeParse({ ...input, invoiceDate }).success).toBe(
      false,
    );
  });
  it("accepts a leap day only in a leap year", () => {
    expect(
      billInputSchema.safeParse({ ...input, invoiceDate: "2024-02-29" })
        .success,
    ).toBe(true);
    expect(
      billInputSchema.safeParse({ ...input, invoiceDate: "2025-02-29" })
        .success,
    ).toBe(false);
  });
  it("requires the due date to follow the invoice date", () => {
    expect(
      billInputSchema.safeParse({ ...input, dueDate: "2026-10-26" }).success,
    ).toBe(false);
  });
  it("rejects client-supplied total and status overrides", () => {
    expect(
      billInputSchema.safeParse({ ...input, total: "1", status: "APPROVED" })
        .success,
    ).toBe(false);
  });
  it("requires exact decimal strings rather than imprecise JSON numbers", () => {
    expect(billInputSchema.safeParse({ ...input, discount: 0.1 }).success).toBe(
      false,
    );
  });
  it.each(["NaN", "Infinity", "-1", "1e8", "garbage", "1.234"])(
    "rejects unsafe unit price %s",
    (unitPrice) => {
      expect(
        billInputSchema.safeParse({
          ...input,
          lines: [{ ...input.lines[0], unitPrice }],
        }).success,
      ).toBe(false);
    },
  );
  it("returns validation errors for malformed quantity and tax instead of throwing", () => {
    expect(
      billInputSchema.safeParse({
        ...input,
        vatRate: "abc",
        lines: [{ ...input.lines[0], quantity: "abc" }],
      }).success,
    ).toBe(false);
  });
  it("restricts currencies to the supported two-decimal set", () => {
    expect(
      billInputSchema.safeParse({ ...input, currency: "JPY" }).success,
    ).toBe(false);
  });
  it("requires a concurrency version for every financial action", () => {
    expect(billActionSchema.safeParse({ action: "approve" }).success).toBe(
      false,
    );
  });
  it("requires a reason for rejection and cancellation", () => {
    expect(
      billActionSchema.safeParse({ action: "reject", version: 1 }).success,
    ).toBe(false);
    expect(
      billActionSchema.safeParse({
        action: "cancel",
        version: 1,
        reason: "Duplicate entry.",
      }).success,
    ).toBe(true);
  });
  it("requires positive payments and a reference", () => {
    expect(
      billActionSchema.safeParse({ action: "payment", version: 1, amount: "1" })
        .success,
    ).toBe(false);
    expect(
      billActionSchema.safeParse({
        action: "payment",
        version: 1,
        amount: "0",
        reference: "REF",
      }).success,
    ).toBe(false);
    expect(
      billActionSchema.safeParse({
        action: "payment",
        version: 1,
        amount: "invalid",
        reference: "REF",
      }).success,
    ).toBe(false);
    expect(
      billActionSchema.safeParse({
        action: "payment",
        version: 1,
        amount: "25.00",
        reference: "REF",
      }).success,
    ).toBe(true);
  });
  it("permits missing job values while rejecting negative adjusted value", () => {
    const base = {
      jobNumber: "JOB-01",
      name: "Test Job",
      customer: "Test Customer",
      currency: "AED",
    };
    expect(jobSchema.safeParse(base).success).toBe(true);
    expect(
      jobSchema.safeParse({
        ...base,
        contractValue: "10",
        approvedVariations: "-11",
      }).success,
    ).toBe(false);
    expect(
      jobSchema.safeParse({
        ...base,
        contractValue: "abc",
        approvedVariations: "def",
      }).success,
    ).toBe(false);
  });
  it("normalizes login email and rejects malformed vendor email", () => {
    expect(
      loginSchema.parse({
        email: "DEMO@EXAMPLE.INVALID",
        password: "supplied-through-env",
      }).email,
    ).toBe("demo@example.invalid");
    expect(
      vendorSchema.safeParse({ name: "Vendor", email: "bad" }).success,
    ).toBe(false);
  });
});

describe("role and ownership rules", () => {
  const entry = { id: "entry", role: "DATA_ENTRY" as const };
  const accounts = { id: "accounts", role: "ACCOUNTS" as const };
  const manager = { id: "manager", role: "MANAGEMENT" as const };
  const admin = { id: "admin", role: "ADMIN" as const };
  it("limits data entry to their own bills", () => {
    expect(canViewBill(entry, { createdById: "another" })).toBe(false);
    expect(canViewBill(entry, { createdById: "entry" })).toBe(true);
    expect(billScope(entry)).toEqual({ createdById: "entry" });
  });
  it("allows authorized staff to edit only unapproved drafts and rejected bills", () => {
    expect(canEditBill(entry, { createdById: "entry", status: "DRAFT" })).toBe(
      true,
    );
    expect(
      canEditBill(entry, { createdById: "entry", status: "APPROVED" }),
    ).toBe(false);
    expect(
      canEditBill(accounts, { createdById: "entry", status: "REJECTED" }),
    ).toBe(true);
  });
  it("requires independent approval, including for administrators", () => {
    expect(
      canApproveBill(admin, {
        createdById: "admin",
        status: "PENDING_APPROVAL",
      }),
    ).toBe(false);
    expect(
      canApproveBill(accounts, {
        createdById: "entry",
        status: "PENDING_APPROVAL",
      }),
    ).toBe(true);
    expect(
      canApproveBill(entry, {
        createdById: "another",
        status: "PENDING_APPROVAL",
      }),
    ).toBe(false);
  });
  it("makes management read-only and restricts master data changes", () => {
    expect(canCreateBill(manager)).toBe(false);
    expect(canManageVendors(manager)).toBe(false);
    expect(canManageJobs(accounts)).toBe(false);
    expect(canManageJobs(admin)).toBe(true);
    expect(canViewFinancialSummary(entry)).toBe(false);
  });
});
