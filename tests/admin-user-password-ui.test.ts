import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ role: "ADMIN" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/components/app-shell", () => ({ useUser: () => ({ id: "admin", role: state.role }) }));
vi.mock("@/components/api", () => ({ api: vi.fn(), errorMessage: () => "Request failed", useApi: () => ({ loading: false, error: null, reload: vi.fn(),
  data: { users: [{ id: "admin", name: "Fictional Admin", email: "admin@example.invalid", role: "ADMIN", active: true },
    { id: "target", name: "Fictional staff", email: "staff@example.invalid", role: "ACCOUNTS", active: true }] } }) }));
import { AccountSecurity } from "@/components/account-security";
import { AdminUserPasswords } from "@/components/admin-user-passwords";

beforeEach(() => { state.role = "ADMIN"; });
describe("Admin-managed password presentation", () => {
  it.each(["ACCOUNTS", "DATA_ENTRY", "MANAGEMENT"])("shows no password form or user directory for %s", role => {
    state.role = role;
    const account = renderToStaticMarkup(createElement(AccountSecurity));
    expect(account).toContain("managed by an administrator"); expect(account).not.toContain("<form"); expect(account).not.toContain('type="password"');
    expect(renderToStaticMarkup(createElement(AdminUserPasswords))).not.toContain("staff@example.invalid");
  });
  it("retains Admin own-password verification and lists reset targets without a self-reset action", () => {
    const own = renderToStaticMarkup(createElement(AccountSecurity));
    expect(own).toContain("Current password"); expect(own).toContain("Confirm new password");
    const directory = renderToStaticMarkup(createElement(AdminUserPasswords));
    expect(directory).toContain("Fictional staff"); expect(directory).toContain("Reset password");
    expect(directory).toContain("Change your own password"); expect(directory).not.toContain("passwordHash");
  });
});
