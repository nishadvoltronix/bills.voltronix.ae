import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Role } from "@prisma/client";

const mocks = vi.hoisted(() => ({ cookie: undefined as string | undefined, resource: "/api/bills", session: vi.fn(), user: vi.fn(),
  verifyPassword: vi.fn(), hashPassword: vi.fn(), reserve: vi.fn(), transaction: vi.fn(), currentUser: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => mocks.cookie ? { value: mocks.cookie } : undefined }),
  headers: async () => new Headers({ "x-voltronix-resource-path": mocks.resource }),
}));
vi.mock("@/lib/db", () => ({ db: { session: { findUnique: mocks.session }, user: { findUnique: mocks.user }, $transaction: mocks.transaction } }));
vi.mock("@/lib/password", () => ({ hashPassword: mocks.hashPassword, verifyPassword: mocks.verifyPassword }));
vi.mock("@/lib/security/authentication-attempts", () => ({ reserveAuthenticationAttempt: mocks.reserve }));

import { requireUser, signIn } from "@/lib/auth";
import { handle, HttpError, json } from "@/lib/http";
import { SESSION_REQUIRED_CODE } from "@/lib/session-recovery";
import { IntegrationError } from "@/lib/integrations/config";
import { integrationHandle } from "@/lib/integrations/http";

const actor = { id: "fictional-user", name: "Fictional user", email: "staff@example.invalid", role: "ACCOUNTS" as Role, active: true };
const read = () => handle(async () => json({ user: await requireUser() }));
beforeEach(() => {
  vi.resetAllMocks(); mocks.cookie = "a".repeat(64); mocks.resource = "/api/bills";
  vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("APP_ENV", "test"); vi.stubEnv("APP_URL", "http://127.0.0.1:3000");
  mocks.session.mockResolvedValue({ expiresAt: new Date(Date.now() + 60_000), user: actor });
  mocks.reserve.mockResolvedValue(1); mocks.hashPassword.mockResolvedValue("fictional-dummy-hash"); mocks.verifyPassword.mockResolvedValue(false);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("explicit local-session recovery marker", () => {
  it.each(["missing", "malformed", "revoked", "expired", "inactive"])("marks only an unavailable local session: %s", async condition => {
    if (condition === "missing") mocks.cookie = undefined;
    if (condition === "malformed") mocks.cookie = "not-a-session-token";
    if (condition === "revoked") mocks.session.mockResolvedValue(null);
    if (condition === "expired") mocks.session.mockResolvedValue({ expiresAt: new Date(0), user: actor });
    if (condition === "inactive") mocks.session.mockResolvedValue({ expiresAt: new Date(Date.now() + 60_000), user: { ...actor, active: false } });
    const response = await read();
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ error: "Please sign in to continue.", code: SESSION_REQUIRED_CODE });
    if (["missing", "malformed"].includes(condition)) expect(mocks.session).not.toHaveBeenCalled();
  });
  it("returns the same user and does not alter a valid session", async () => {
    expect(await requireUser()).toEqual({ id: actor.id, name: actor.name, email: actor.email, role: actor.role });
    expect(mocks.session).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ include: { user: true } }));
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("keeps role denial distinct from session expiry", async () => {
    const response = await handle(async () => json(await requireUser(["ADMIN"])));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "You do not have permission to perform this action." });
  });
  it("keeps a restricted-path denial distinct from session expiry", async () => {
    mocks.resource = "/api/account/users";
    const response = await read();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "This account is restricted to bill entry, bills and vendors." });
  });
  it("keeps actual wrong-password sign-in failures unmarked", async () => {
    mocks.user.mockResolvedValue({ ...actor, passwordHash: "fictional-password-hash" });
    const response = await handle(async () => json({ user: await signIn(actor.email, "fictional-wrong-password") }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "The email or password is incorrect." });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("does not misclassify credential changes during sign-in", async () => {
    mocks.user.mockResolvedValue({ ...actor, passwordHash: "fictional-password-hash" }); mocks.verifyPassword.mockResolvedValue(true);
    mocks.currentUser.mockResolvedValue(null);
    mocks.transaction.mockImplementation(async work => work({ user: { findFirst: mocks.currentUser } }));
    const response = await handle(async () => json({ user: await signIn(actor.email, "fictional-password") }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Account credentials changed. Sign in again." });
  });
  it("does not infer a session marker from a generic or upstream 401", async () => {
    for (const message of ["Billing request not authorized.", "Zoho authorization is expired.", "Please sign in to continue."]) {
      const response = await handle(async () => { throw new HttpError(401, message); });
      expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: message });
    }
  });
  it("does not present an authentication-configuration outage as an expired browser session", async () => {
    vi.stubEnv("APP_ENV", "production");
    const response = await read();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Production authentication requires a configured HTTPS application origin." });
    expect(mocks.session).not.toHaveBeenCalled();
  });
  it("preserves explicitly coded errors without converting provider failures into local-session recovery", async () => {
    const response = await integrationHandle(async () => { throw new IntegrationError("AUTH_FAILED", "Zoho authorization is unavailable.", "BLOCKED"); });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Zoho authorization is unavailable.", code: "AUTH_FAILED" });
    const coded = await handle(async () => { throw new HttpError(422, "Choose a supplier.", "SUPPLIER_REQUIRED"); });
    expect(await coded.json()).toEqual({ error: "Choose a supplier.", code: "SUPPLIER_REQUIRED" });
  });
});
