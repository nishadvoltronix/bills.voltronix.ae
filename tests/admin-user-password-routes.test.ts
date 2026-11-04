import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/http";

const mocks = vi.hoisted(() => ({ role: "ADMIN", requireUser: vi.fn(), list: vi.fn(), reset: vi.fn(), own: vi.fn(), clear: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireUser: mocks.requireUser, clearSessionCookie: mocks.clear }));
vi.mock("@/lib/services/accounts", () => ({ listManagedUsers: mocks.list, resetManagedUserPassword: mocks.reset, changeOwnPassword: mocks.own }));
import { GET } from "@/app/api/account/users/route";
import { POST } from "@/app/api/account/users/[id]/password/route";
import { POST as ownPassword } from "@/app/api/auth/password/route";

const origin = "http://127.0.0.1:3000";
const payload = { adminCurrentPassword: "Fictional-current-password-147!", newPassword: "Fictional-assigned-password-148!", confirmation: "Fictional-assigned-password-148!", reason: "Fictional reviewed recovery" };
const request = (headers: Record<string, string> = {}, body = JSON.stringify(payload)) => new Request(`${origin}/api/account/users/target/password`, {
  method: "POST", body, headers: { Origin: origin, "Content-Type": "application/json", ...headers },
});
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("APP_URL", origin); mocks.role = "ADMIN";
  mocks.requireUser.mockImplementation(async (roles?: string[]) => {
    if (roles && !roles.includes(mocks.role)) throw new HttpError(403, "Not permitted.");
    return { id: "admin", role: mocks.role };
  });
  mocks.list.mockResolvedValue([{ id: "target", name: "Fictional user", email: "user@example.invalid", role: "ACCOUNTS", active: true }]);
  mocks.reset.mockResolvedValue({ success: true, operation: "reset-password", revokedSessions: 2 });
  mocks.own.mockResolvedValue({ success: true, requiresSignIn: true });
});

describe("Admin-only password HTTP resources", () => {
  it("returns a private safe user list through an explicit Admin guard", async () => {
    const response = await GET();
    expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.requireUser).toHaveBeenCalledWith(["ADMIN"]);
    expect(Object.keys((await response.json()).users[0]).sort()).toEqual(["active", "email", "id", "name", "role"]);
  });
  it("passes only the authenticated Admin and exact target/payload to managed recovery", async () => {
    const response = await POST(request(), { params: Promise.resolve({ id: "target" }) });
    expect(response.status).toBe(200);
    expect(mocks.requireUser).toHaveBeenCalledWith(["ADMIN"]);
    expect(mocks.reset).toHaveBeenCalledWith({ id: "admin", role: "ADMIN" }, "target", payload);
    expect(await response.json()).toEqual({ success: true, operation: "reset-password", revokedSessions: 2 });
    expect(mocks.clear).not.toHaveBeenCalled();
  });
  it.each(["ACCOUNTS", "DATA_ENTRY", "MANAGEMENT"])("denies direct listing, resets and own password POST for %s", async role => {
    mocks.role = role;
    expect((await GET()).status).toBe(403);
    expect((await POST(request({ "x-voltronix-resource-path": "/api/bills" }), { params: Promise.resolve({ id: "target" }) })).status).toBe(403);
    expect((await ownPassword(request())).status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.reset).not.toHaveBeenCalled(); expect(mocks.own).not.toHaveBeenCalled();
  });
  it.each<Record<string, string>>([{ Origin: "https://foreign.invalid" }, { "Sec-Fetch-Site": "cross-site" }])("rejects cross-origin resets before account authentication", async headers => {
    expect((await POST(request(headers), { params: Promise.resolve({ id: "target" }) })).status).toBe(403);
    expect(mocks.requireUser).not.toHaveBeenCalled(); expect(mocks.reset).not.toHaveBeenCalled();
  });
  it.each([
    [request({}, "{"), 400], [request({ "Content-Type": "text/plain" }), 415], [request({}, " ".repeat(4097)), 413],
  ])("bounds and validates the request body", async (incoming, status) => {
    expect((await POST(incoming, { params: Promise.resolve({ id: "target" }) })).status).toBe(status);
    expect(mocks.reset).not.toHaveBeenCalled();
  });
});
