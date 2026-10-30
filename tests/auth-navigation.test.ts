import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import {
  AUTH_RETURN_PATH_HEADER,
  loginDestination,
  loginUrl,
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
