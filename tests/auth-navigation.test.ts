import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import {
  AUTH_RETURN_PATH_HEADER,
  canAccessRolePath,
  loginDestination,
  loginUrl,
  roleHomePath,
  safeReturnPath,
} from "@/lib/auth-navigation";
import { proxy } from "@/proxy";

describe("post-login navigation", () => {
  it("preserves an operator page and bill detail without changing role defaults", () => {
    const path = "/account/books-authorization";
    expect(loginUrl(path)).toBe(`/login?next=${encodeURIComponent(path)}`);
    expect(loginDestination("ADMIN", path)).toBe(path);
    expect(safeReturnPath("/bills/example-bill_123/edit")).toBe(
      "/bills/example-bill_123/edit",
    );
    expect(loginDestination("MANAGEMENT", null)).toBe("/management");
    expect(loginDestination("ADMIN", null)).toBe("/dashboard");
    expect(loginDestination("DATA_ENTRY", null)).toBe("/dashboard");
    expect(loginDestination("ACCOUNTS", null)).toBe("/bills/manual");
  });

  it.each([
    "/bills", "/bills/", "/bills/manual", "/bills/new",
    "/bills/example-bill_123", "/bills/example-bill_123/edit",
    "/bills/books", "/bills/books/books-bill_123",
    "/vendors", "/account", "/account/",
    "/jobs/job_123", "/jobs/crm/snapshot_123",
  ])("retains an accounts bill-entry or history destination: %s", path => {
    expect(canAccessRolePath("ACCOUNTS", path)).toBe(true);
    expect(safeReturnPath(path, "ACCOUNTS")).toBe(path);
    expect(loginDestination("ACCOUNTS", path)).toBe(path);
  });

  it.each([
    "/dashboard", "/dashboard/", "/management", "/audit", "/approvals",
    "/integrations", "/ocr", "/ocr/batch", "/ocr/documents/document_123",
    "/jobs", "/jobs/", "/account/books-authorization", "/account/crm-authorization",
    "/bills/books/example/edit", "/vendors/example", "/jobs/job_123/edit",
  ])("blocks an accounts return to a restricted page: %s", path => {
    expect(canAccessRolePath("ACCOUNTS", path)).toBe(false);
    expect(safeReturnPath(path, "ACCOUNTS")).toBeNull();
    expect(loginDestination("ACCOUNTS", path)).toBe("/bills/manual");
  });

  it("leaves other roles' home and supported page policies unchanged", () => {
    expect(roleHomePath("ADMIN")).toBe("/dashboard");
    expect(roleHomePath("DATA_ENTRY")).toBe("/dashboard");
    expect(roleHomePath("MANAGEMENT")).toBe("/management");
    for (const role of ["ADMIN", "DATA_ENTRY", "MANAGEMENT"]) {
      expect(canAccessRolePath(role, "/dashboard")).toBe(true);
      expect(loginDestination(role, "/jobs")).toBe("/jobs");
    }
  });

  it.each([
    "https://attacker.invalid/",
    "//attacker.invalid/",
    "/\\attacker.invalid/",
    "javascript:alert(1)",
    "/%2f%2fattacker.invalid",
    "/account/%252f%252fattacker.invalid",
    "/account/../api/auth/logout",
    "/account/%2e%2e/api/auth/logout",
    "/account\r\nLocation:https://attacker.invalid",
    "/account?next=https://attacker.invalid",
    "/account#section",
    "/login",
    "/api/auth/logout",
    "/_next/static/file.js",
    `/account/${"x".repeat(512)}`,
  ])("rejects unsafe or non-page return targets: %s", (value) => {
    expect(safeReturnPath(value)).toBeNull();
    expect(loginUrl(value)).toBe("/login");
    expect(loginDestination("ADMIN", value)).toBe("/dashboard");
    expect(canAccessRolePath("ACCOUNTS", value)).toBe(false);
    expect(safeReturnPath(value, "ACCOUNTS")).toBeNull();
    expect(loginDestination("ACCOUNTS", value)).toBe("/bills/manual");
  });

  it("overwrites a spoofed return header with the actual page pathname", () => {
    const response = proxy(
      new NextRequest(
        "http://local.test/account/books-authorization?ignored=1",
        {
          headers: { [AUTH_RETURN_PATH_HEADER]: "/bills" },
        },
      ),
    );
    expect(
      response.headers.get(`x-middleware-request-${AUTH_RETURN_PATH_HEADER}`),
    ).toBe("/account/books-authorization");
    expect(response.headers.get(AUTH_RETURN_PATH_HEADER)).toBeNull();
  });

  it("clears a caller-selected return header on an unsupported route", () => {
    const response = proxy(
      new NextRequest("http://local.test/login", {
        headers: { [AUTH_RETURN_PATH_HEADER]: "/account/books-authorization" },
      }),
    );
    expect(
      response.headers.get(`x-middleware-request-${AUTH_RETURN_PATH_HEADER}`),
    ).toBe("");
  });
});
