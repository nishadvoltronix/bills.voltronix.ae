import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
import {
  billScope, canApproveBill, canCreateBill, canEditBill, canManageJobs,
  canManageVendors, canViewAuditLog, canViewBill, canViewBooksHistory,
  canViewFinancialSummary, canViewOverview,
} from "@/lib/permissions";
import { canAccessRolePath, loginDestination, roleHomePath } from "@/lib/auth-navigation";

const { databaseAccess } = vi.hoisted(() => ({ databaseAccess: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: new Proxy({}, { get: (_target, property) => {
    databaseAccess(property);
    throw new Error("Restricted service reached the database before authorization.");
  } }),
}));

import { auditEvents, dashboard, serializeJob } from "@/lib/services/catalog";
import { expenseReport, operationSummary } from "@/lib/services/reports";

const actor = (role: Actor["role"]): Actor => ({
  id: role === "DATA_ENTRY" ? "fictional-entry" : `fictional-${role.toLowerCase()}`,
  name: "Fictional role fixture", email: "role-fixture@example.invalid", role,
});
const accounts = actor("ACCOUNTS");
const money = (value: string) => new Prisma.Decimal(value);
const job = {
  id: "fictional-job", companyId: "fictional-company", jobNumber: "FICT-ROLE-1",
  name: "Fictional role job", customer: "Fictional customer", currency: "AED",
  contractValue: money("1000"), approvedVariations: money("100"), isDemo: true,
  externalCrmId: null,
  bills: [
    { id: "fictional-own-bill", createdById: "fictional-entry", status: "READY", currency: "AED", subtotal: money("100"), discount: money("0"), total: money("100"), paidAmount: money("0") },
    { id: "fictional-other-bill", createdById: "fictional-admin", status: "READY", currency: "AED", subtotal: money("200"), discount: money("0"), total: money("200"), paidAmount: money("50") },
  ],
} as Parameters<typeof serializeJob>[1];
const privateJobFigures = [
  "contractValue", "approvedVariations", "adjustedValue", "recognizedExpenses",
  "paidExpenses", "outstanding", "estimatedProfit", "remainingBudget", "expensePercentage",
] as const;

describe("restricted Accounts access contract", () => {
  it("retains bill-entry, existing bill actions, vendor management, and Books history", () => {
    expect(canCreateBill(accounts)).toBe(true);
    expect(canManageVendors(accounts)).toBe(true);
    expect(canViewBooksHistory(accounts)).toBe(true);
    expect(canViewBill(accounts, { createdById: "fictional-another-user" })).toBe(true);
    expect(canEditBill(accounts, { createdById: "fictional-another-user", status: "DRAFT" })).toBe(true);
    expect(canApproveBill(accounts, { createdById: "fictional-another-user", status: "PENDING_APPROVAL" })).toBe(true);
    expect(billScope(accounts)).toEqual({});
    expect(canManageJobs(accounts)).toBe(false);
  });

  it("denies global overview, organization audit, and financial summaries", () => {
    expect(canViewOverview(accounts)).toBe(false);
    expect(canViewAuditLog(accounts)).toBe(false);
    expect(canViewFinancialSummary(accounts)).toBe(false);
  });

  it("lands at manual bill entry and preserves permitted deep links", () => {
    expect(roleHomePath("ACCOUNTS")).toBe("/bills/manual");
    expect(loginDestination("ACCOUNTS", null)).toBe("/bills/manual");
    for (const path of ["/bills", "/bills/manual", "/bills/new", "/bills/fictional-bill/edit", "/bills/books/fictional-import", "/vendors", "/account", "/jobs/fictional-job", "/jobs/crm/fictional-snapshot"])
      expect(loginDestination("ACCOUNTS", path)).toBe(path);
  });

  it.each(["/dashboard", "/management", "/audit", "/approvals", "/ocr", "/ocr/batch", "/integrations", "/jobs", "/account/books-authorization", "/account/crm-authorization"])(
    "rejects a direct or post-login restricted page: %s", path => {
      expect(canAccessRolePath("ACCOUNTS", path)).toBe(false);
      expect(loginDestination("ACCOUNTS", path)).toBe("/bills/manual");
    },
  );

  it.each([
    ["dashboard", () => dashboard(accounts, new URLSearchParams({ currency: "AED" }))],
    ["expense JSON/CSV source", () => expenseReport(accounts, new URLSearchParams())],
    ["operation summaries", () => operationSummary(accounts)],
    ["organization audit", () => auditEvents(accounts)],
  ] as const)("rejects %s before accessing any database model", async (_name, request) => {
    databaseAccess.mockClear();
    await expect(request()).rejects.toMatchObject({ status: 403 });
    expect(databaseAccess).not.toHaveBeenCalled();
  });

  it("redacts every job-level financial figure while retaining bill-history identity", () => {
    const result = serializeJob(accounts, job);
    for (const field of privateJobFigures) expect(result[field], field).toBeNull();
    expect(result).toMatchObject({ id: job.id, companyId: job.companyId, jobNumber: job.jobNumber, name: job.name, customer: job.customer, currency: "AED", budgetStatus: "VALUE_UNAVAILABLE", billCount: 2 });
    expect(job.contractValue?.toFixed(2)).toBe("1000.00");
    expect(job.approvedVariations.toFixed(2)).toBe("100.00");
  });

  it.each(["ADMIN", "MANAGEMENT"] as const)("preserves authorized %s summary figures", role => {
    expect(serializeJob(actor(role), job)).toMatchObject({ contractValue: "1000.00", approvedVariations: "100.00", adjustedValue: "1100.00", recognizedExpenses: "300.00", paidExpenses: "50.00", outstanding: "250.00", estimatedProfit: "800.00", billCount: 2 });
    expect(canViewFinancialSummary(actor(role))).toBe(true);
  });

  it("preserves Data Entry ownership-scoped statistics and existing role homes", () => {
    expect(serializeJob(actor("DATA_ENTRY"), job)).toMatchObject({ contractValue: null, approvedVariations: "0.00", recognizedExpenses: "100.00", paidExpenses: "0.00", outstanding: "100.00", estimatedProfit: null, billCount: 1, financialScope: "YOUR_BILLS" });
    expect(canViewOverview(actor("DATA_ENTRY"))).toBe(true);
    expect(roleHomePath("DATA_ENTRY")).toBe("/dashboard");
    expect(roleHomePath("ADMIN")).toBe("/dashboard");
    expect(roleHomePath("MANAGEMENT")).toBe("/management");
  });
});
