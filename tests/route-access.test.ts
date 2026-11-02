import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { AUTH_RESOURCE_PATH_HEADER, canAccessRoleApiPath } from "@/lib/route-access";

describe("restricted accountant HTTP resources", () => {
  it.each([
    "/api/auth/me", "/api/auth/password", "/api/auth/logout", "/api/companies",
    "/api/bills", "/api/bills/bill_1", "/api/bills/bill_1/attachment", "/api/bills/books/book_1",
    "/api/bills/books/book_1/attachments/file_1", "/api/bills/options",
    "/api/vendors", "/api/vendors/search", "/api/vendors/resolve", "/api/vendors/directory",
    "/api/jobs", "/api/jobs/search", "/api/jobs/resolve", "/api/jobs/job_1", "/api/jobs/crm/snapshot_1",
    "/api/crm/jobs/job_1/expenses", "/api/dashboard/search", "/api/documents/file_1",
    "/api/integrations", "/api/integrations/jobs/operation_1", "/api/integrations/vendor-mapping",
  ])("retains the bill-entry resource %s", pathname => {
    expect(canAccessRoleApiPath("ACCOUNTS", pathname)).toBe(true);
  });

  it.each([
    "/api/dashboard", "/api/reports/bills", "/api/audit", "/api/operations", "/api/ocr",
    "/api/ocr/templates", "/api/ocr/batches/batch_1", "/api/ocr/documents/document_1/review",
    "/api/integrations/jobs", "/api/integrations/incoming-status", "/api/integrations/crm/authorization",
    "/api/integrations/oauth/zoho/authorize", "/api/scanner/imports", "/api/hub/job-billing",
    "/dashboard", "/api/bills/../dashboard", "/api/bills/%2fsecret", "/api/bills?role=ADMIN", "",
  ])("denies resources outside bill/vendor entry: %s", pathname => {
    expect(canAccessRoleApiPath("ACCOUNTS", pathname)).toBe(false);
  });

  it("fails closed without the trusted resource header", () => {
    expect(canAccessRoleApiPath("ACCOUNTS", null)).toBe(false);
    expect(canAccessRoleApiPath("ACCOUNTS", undefined)).toBe(false);
  });

  it.each(["ADMIN", "MANAGEMENT", "DATA_ENTRY"])("preserves the existing resource policy for %s", role => {
    expect(canAccessRoleApiPath(role, "/api/dashboard")).toBe(true);
    expect(canAccessRoleApiPath(role, "/api/ocr")).toBe(true);
  });

  it.each(["/api/dashboard", "/api/ocr/templates", "/bills/manual"])("replaces caller scope with actual pathname %s", pathname => {
    const response = proxy(new NextRequest(`http://local.test${pathname}?ignored=1`, {
      headers: { [AUTH_RESOURCE_PATH_HEADER]: "/api/bills" },
    }));
    expect(response.headers.get(`x-middleware-request-${AUTH_RESOURCE_PATH_HEADER}`)).toBe(pathname);
    expect(response.headers.get(AUTH_RESOURCE_PATH_HEADER)).toBeNull();
  });
});
