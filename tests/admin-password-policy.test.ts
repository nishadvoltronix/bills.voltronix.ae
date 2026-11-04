import { describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
const access = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_target, field) => { access(field); throw new Error("Authorization must precede data access."); } }) }));
import { administerAccount, changeOwnPassword, listManagedUsers, managedPasswordResetSchema, resetManagedUserPassword } from "@/lib/services/accounts";

const payload = { adminCurrentPassword: "Fictional-admin-current-147!", newPassword: "Fictional-user-replacement-148!", confirmation: "Fictional-user-replacement-148!", reason: "Fictional identity and recovery verified" };
describe("Admin-only password service boundary", () => {
  it.each(["ACCOUNTS", "DATA_ENTRY", "MANAGEMENT"] as const)("rejects %s before reading credentials or mutating attempts", async role => {
    access.mockClear();
    const actor: Actor = { id: "non-admin", email: "staff@example.invalid", name: "Fictional staff", role };
    for (const operation of [() => changeOwnPassword(actor, {}), () => listManagedUsers(actor),
      () => resetManagedUserPassword(actor, "target", payload), () => administerAccount(actor, {})])
      await expect(operation()).rejects.toMatchObject({ status: 403 });
    expect(access).not.toHaveBeenCalled();
  });
  it("cannot forge the private HTTP reset authorization or reset the current Admin through user management", async () => {
    access.mockClear();
    const actor: Actor = { id: "admin", email: "admin@example.invalid", name: "Fictional Admin", role: "ADMIN" };
    await expect(administerAccount(actor, {}, { kind: "managed-password-reset" })).rejects.toMatchObject({ status: 403 });
    await expect(resetManagedUserPassword(actor, actor.id, payload)).rejects.toMatchObject({ status: 409 });
    expect(access).not.toHaveBeenCalled();
  });
  it("rejects weak or unconfirmed replacements, broad administration fields and secrets in audit reasons", () => {
    for (const override of [{ newPassword: "short", confirmation: "short" }, { confirmation: "Fictional-mismatch-password-149!" },
      { operation: "deactivate" }, { userId: "other" }, { reason: `Recovery ${payload.newPassword}` }, { reason: `Recovery ${payload.adminCurrentPassword}` }])
      expect(managedPasswordResetSchema.safeParse({ ...payload, ...override }).success).toBe(false);
    expect(managedPasswordResetSchema.safeParse(payload).success).toBe(true);
  });
});
