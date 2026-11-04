import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/password";
import { authenticationAttemptKey, reserveAuthenticationAttempt } from "@/lib/security/authentication-attempts";
import { assertMySqlTestDatabase, createTestCompany } from "./company-fixtures";
import {
  administerAccount,
  authenticateAccountOperator,
  changeOwnPassword,
  listManagedUsers,
  resetManagedUserPassword,
} from "@/lib/services/accounts";

const tag = randomUUID().slice(0, 8);
const fixturePassword = "Fictional-account-test-password-247!";
let administrator: Actor;
let staff: Actor;
let accounts: Actor;

beforeAll(async () => {
  assertMySqlTestDatabase();
  const passwordHash = await hashPassword(fixturePassword);
  const users = await Promise.all(
    (["ADMIN", "DATA_ENTRY", "ACCOUNTS"] as const).map((role) =>
      db.user.create({
        data: {
          email: `account-${role.toLowerCase()}-${tag}@example.invalid`,
          name: `Fictional account ${role}`,
          role,
          passwordHash,
        },
      }),
    ),
  );
  [administrator, staff, accounts] = users;
  await createTestCompany(`account lifecycle ${tag}`, users);
});
afterAll(async () => {
  await db.$disconnect();
});

async function session(userId: string) {
  return db.session.create({
    data: {
      userId,
      tokenHash: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
}

describe("durable action budgets remain separate from login", () => {
  it("atomically allows thirty invoice reads while preserving the five-attempt login default and another actor's budget", async () => {
    const identity = `fictional-autofill-${tag}`;
    const previewKey = authenticationAttemptKey("manual-bill-autofill", identity);
    const loginKey = authenticationAttemptKey("login", identity);
    const otherKey = authenticationAttemptKey("manual-bill-autofill", `${identity}-other`);
    expect(new Set([previewKey, loginKey, otherKey]).size).toBe(3);
    const preview = await Promise.allSettled(Array.from({ length: 35 }, () => reserveAuthenticationAttempt(previewKey, "Fictional invoice budget exhausted.", 30)));
    expect(preview.filter(result => result.status === "fulfilled")).toHaveLength(30);
    expect(preview.filter(result => result.status === "rejected")).toHaveLength(5);
    for (const result of preview) if (result.status === "rejected") expect(result.reason).toMatchObject({ status: 429 });
    expect((await db.loginAttempt.findUniqueOrThrow({ where: { key: previewKey } })).count).toBe(35);
    const login = await Promise.allSettled(Array.from({ length: 6 }, () => reserveAuthenticationAttempt(loginKey)));
    expect(login.filter(result => result.status === "fulfilled")).toHaveLength(5);
    expect(login.filter(result => result.status === "rejected")).toHaveLength(1);
    await expect(reserveAuthenticationAttempt(otherKey, "Other fictional invoice budget.", 30)).resolves.toBe(1);
    // An expired preview window resets only its own reservation, never login.
    await db.loginAttempt.update({ where: { key: previewKey }, data: { windowStart: new Date(Date.now() - 16 * 60_000) } });
    await expect(reserveAuthenticationAttempt(previewKey, "Fictional invoice budget exhausted.", 30)).resolves.toBe(1);
    await expect(reserveAuthenticationAttempt(loginKey)).rejects.toMatchObject({ status: 429 });
    expect((await db.loginAttempt.findUniqueOrThrow({ where: { key: otherKey } })).count).toBe(1);
  });
});

describe("audited account lifecycle", () => {
  it("reauthenticates the actual operator instead of trusting a supplied email or role", async () => {
    await expect(
      authenticateAccountOperator(administrator.email, "wrong-password"),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      authenticateAccountOperator(accounts.email, fixturePassword),
    ).rejects.toMatchObject({ status: 401 });
    expect(
      (await authenticateAccountOperator(administrator.email, fixturePassword))
        .id,
    ).toBe(administrator.id);
    await expect(
      administerAccount(
        { ...accounts, role: "ADMIN" },
        {
          operation: "deactivate",
          email: staff.email,
          reason: "Fictional access review",
        },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("deactivates without deleting financial identity, revokes every session, and audits the operator", async () => {
    await session(staff.id);
    await session(staff.id);
    const outcome = await administerAccount(administrator, {
      operation: "deactivate",
      email: staff.email,
      reason: "Fictional employment access review",
    });
    expect(outcome.revokedSessions).toBe(2);
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: staff.id } })).active,
    ).toBe(false);
    expect(await db.session.count({ where: { userId: staff.id } })).toBe(0);
    const event = await db.auditLog.findFirstOrThrow({
      where: {
        entityType: "User",
        entityId: staff.id,
        action: "ACCOUNT_DEACTIVATE",
      },
    });
    expect(event.actorId).toBe(administrator.id);
    expect(event.details).toMatchObject({
      source: "operator_cli",
      active: false,
      reason: "Fictional employment access review",
    });
    await expect(
      administerAccount(administrator, {
        operation: "reset-password",
        email: staff.email,
        reason: "Fictional password recovery",
        newPassword: "Fictional-new-password-789!",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("reactivates only through an audited operation and refuses self-deactivation", async () => {
    await administerAccount(administrator, {
      operation: "reactivate",
      email: staff.email,
      reason: "Fictional identity reverified by operator",
    });
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: staff.id } })).active,
    ).toBe(true);
    await expect(
      administerAccount(administrator, {
        operation: "deactivate",
        email: administrator.email,
        reason: "Fictional unsafe self-deactivation",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: administrator.id } }))
        .active,
    ).toBe(true);
  });

  it("performs managed recovery and revokes old sessions without logging any credential", async () => {
    await session(staff.id);
    const replacement = "Fictional-recovered-password-785!";
    await administerAccount(administrator, {
      operation: "reset-password",
      email: staff.email,
      reason: "Fictional identity verified through approved channel",
      newPassword: replacement,
    });
    const saved = await db.user.findUniqueOrThrow({ where: { id: staff.id } });
    expect(await verifyPassword(replacement, saved.passwordHash)).toBe(true);
    expect(await verifyPassword(fixturePassword, saved.passwordHash)).toBe(
      false,
    );
    expect(await db.session.count({ where: { userId: staff.id } })).toBe(0);
    const audits = JSON.stringify(
      await db.auditLog.findMany({
        where: { entityType: "User", entityId: staff.id },
      }),
    );
    expect(audits).not.toContain(replacement);
    expect(audits).not.toContain(saved.passwordHash);
    expect(audits).not.toContain(fixturePassword);
  });

  it("requires the current password for self-service changes and revokes every session on success", async () => {
    const ownAdmin = await db.user.create({ data: { email: `self-admin-${tag}@example.invalid`, name: "Fictional self Admin", role: "ADMIN", passwordHash: await hashPassword(fixturePassword) } });
    await session(ownAdmin.id);
    await session(ownAdmin.id);
    const original = await db.user.findUniqueOrThrow({
      where: { id: ownAdmin.id },
    });
    await expect(
      changeOwnPassword(ownAdmin, {
        currentPassword: "wrong-password",
        newPassword: "Fictional-new-personal-password-928!",
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: ownAdmin.id } }))
        .passwordHash,
    ).toBe(original.passwordHash);
    const changed = await changeOwnPassword(ownAdmin, {
      currentPassword: fixturePassword,
      newPassword: "Fictional-new-personal-password-928!",
    });
    expect(changed).toEqual({ success: true, requiresSignIn: true });
    expect(await db.session.count({ where: { userId: ownAdmin.id } })).toBe(0);
    expect(
      await db.auditLog.count({
        where: {
          actorId: ownAdmin.id,
          action: "PASSWORD_CHANGED",
          entityId: ownAdmin.id,
        },
      }),
    ).toBe(1);
  });

  it("rate limits password-change guesses and does not permit resetting another account through payload fields", async () => {
    await expect(
      changeOwnPassword(administrator, {
        currentPassword: "wrong",
        newPassword: "Fictional-strong-new-password-01",
        userId: administrator.id,
      }),
    ).rejects.toThrow();
    for (let count = 0; count < 5; count++)
      await expect(
        changeOwnPassword(administrator, {
          currentPassword: "wrong",
          newPassword: "Fictional-strong-new-password-01",
        }),
      ).rejects.toMatchObject({ status: 401 });
    await expect(
      changeOwnPassword(administrator, {
        currentPassword: "wrong",
        newPassword: "Fictional-strong-new-password-01",
      }),
    ).rejects.toMatchObject({ status: 429 });
  });

  it("refuses inactive operators and records session revocation as an independent operation", async () => {
    await session(accounts.id);
    const outcome = await administerAccount(administrator, {
      operation: "revoke-sessions",
      email: accounts.email,
      reason: "Fictional lost-device investigation",
    });
    expect(outcome.revokedSessions).toBe(1);
    await db.user.update({
      where: { id: administrator.id },
      data: { active: false },
    });
    try {
      await expect(
        administerAccount(administrator, {
          operation: "reactivate",
          email: staff.email,
          reason: "Fictional unauthorized operator",
        }),
      ).rejects.toMatchObject({ status: 403 });
    } finally {
      await db.user.update({
        where: { id: administrator.id },
        data: { active: true },
      });
    }
  });

  it("requires a reason and sufficient password strength before any mutation", async () => {
    await expect(
      administerAccount(administrator, {
        operation: "deactivate",
        email: staff.email,
        reason: "",
      }),
    ).rejects.toThrow();
    await expect(
      administerAccount(administrator, {
        operation: "reset-password",
        email: staff.email,
        reason: "Fictional recovery request",
        newPassword: "short",
      }),
    ).rejects.toThrow();
    await expect(
      changeOwnPassword(administrator, {
        currentPassword: fixturePassword,
        newPassword: fixturePassword,
      }),
    ).rejects.toThrow();
  });

  it("removes self-password changes from every non-Admin role without touching credentials or sessions", async () => {
    for (const role of ["ACCOUNTS", "DATA_ENTRY", "MANAGEMENT"] as const) {
      const user = await db.user.create({ data: { email: `managed-${role}-${tag}@example.invalid`, name: "Fictional managed user", role, passwordHash: await hashPassword(fixturePassword) } });
      await session(user.id);
      await expect(changeOwnPassword(user, { currentPassword: fixturePassword, newPassword: "Fictional-blocked-replacement-789!" })).rejects.toMatchObject({ status: 403 });
      expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash).toBe(user.passwordHash);
      expect(await db.session.count({ where: { userId: user.id } })).toBe(1);
    }
  });

  it("lists only safe users fully inside Admin company scope and performs an audited, reauthenticated reset", async () => {
    const target = await db.user.create({ data: { email: `web-reset-${tag}@example.invalid`, name: "Fictional reset target", role: "ACCOUNTS", passwordHash: await hashPassword(fixturePassword) } });
    await createTestCompany(`web reset allowed ${tag}`, [administrator, target]);
    await session(target.id); await session(target.id);
    const outsider = await db.user.create({ data: { email: `web-outsider-${tag}@example.invalid`, name: "Fictional outside user", role: "ACCOUNTS", passwordHash: target.passwordHash } });
    await createTestCompany(`web outside ${tag}`, [outsider]);
    const rows = await listManagedUsers(administrator);
    expect(rows.some(user => user.id === target.id)).toBe(true);
    expect(rows.some(user => user.id === outsider.id)).toBe(false);
    for (const user of rows) expect(Object.keys(user).sort()).toEqual(["active", "email", "id", "name", "role"]);
    const newPassword = "Fictional-admin-assigned-password-787!";
    const payload = { adminCurrentPassword: fixturePassword, newPassword, confirmation: newPassword, reason: "Fictional staff identity verified by administrator" };
    await expect(resetManagedUserPassword(administrator, outsider.id, payload)).rejects.toMatchObject({ status: 404 });
    await expect(resetManagedUserPassword(administrator, administrator.id, payload)).rejects.toMatchObject({ status: 409 });
    await expect(resetManagedUserPassword(administrator, target.id, { ...payload, confirmation: "Fictional-different-confirmation-788!" })).rejects.toThrow();
    await expect(resetManagedUserPassword(administrator, target.id, { ...payload, adminCurrentPassword: "incorrect" })).rejects.toMatchObject({ status: 401 });
    const attemptKeys = [authenticationAttemptKey("login", target.email), authenticationAttemptKey("password-change", target.id), authenticationAttemptKey("account-operator", target.email)];
    await db.loginAttempt.createMany({ data: attemptKeys.map(key => ({ key, count: 5, windowStart: new Date(), lockedUntil: new Date(Date.now() + 60_000) })) });
    expect(await resetManagedUserPassword(administrator, target.id, payload)).toMatchObject({ success: true, operation: "reset-password", revokedSessions: 2 });
    const saved = await db.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(await verifyPassword(newPassword, saved.passwordHash)).toBe(true);
    expect(await db.session.count({ where: { userId: target.id } })).toBe(0);
    expect(await db.loginAttempt.count({ where: { key: { in: attemptKeys } } })).toBe(0);
    const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: target.id, action: "ACCOUNT_RESET_PASSWORD" }, orderBy: { createdAt: "desc" } });
    expect(audit.details).toMatchObject({ source: "admin_user_management", revokedSessions: 2 });
    expect(JSON.stringify(audit)).not.toContain(newPassword);
    expect(JSON.stringify(audit)).not.toContain(fixturePassword);
    expect(JSON.stringify(audit)).not.toContain(saved.passwordHash);
    expect((await db.user.findUniqueOrThrow({ where: { id: outsider.id } })).passwordHash).toBe(outsider.passwordHash);
  });

  it("rechecks target company scope and Admin credential hash after password reauthentication", async () => {
    const operator = await db.user.create({ data: { email: `web-race-admin-${tag}@example.invalid`, name: "Fictional scoped Admin", role: "ADMIN", passwordHash: await hashPassword(fixturePassword) } });
    const target = await db.user.create({ data: { email: `web-race-user-${tag}@example.invalid`, name: "Fictional scope target", role: "ACCOUNTS", passwordHash: operator.passwordHash } });
    await createTestCompany(`web race scope ${tag}`, [operator, target]);
    const payload = { adminCurrentPassword: fixturePassword, newPassword: "Fictional-race-replacement-786!", confirmation: "Fictional-race-replacement-786!", reason: "Fictional reviewed account recovery" };
    const originalDelete = db.loginAttempt.deleteMany.bind(db.loginAttempt);
    const replacementHash = await hashPassword("Fictional-rotated-admin-password-785!");
    const intercept = vi.spyOn(db.loginAttempt, "deleteMany").mockImplementation((...args) => (async () => {
      const result = await originalDelete(...args);
      await db.user.update({ where: { id: operator.id }, data: { passwordHash: replacementHash } });
      return result;
    })() as ReturnType<typeof db.loginAttempt.deleteMany>);
    try { await expect(resetManagedUserPassword(operator, target.id, payload)).rejects.toMatchObject({ status: 409 }); }
    finally { intercept.mockRestore(); }
    expect((await db.user.findUniqueOrThrow({ where: { id: target.id } })).passwordHash).toBe(target.passwordHash);
    await db.user.update({ where: { id: operator.id }, data: { passwordHash: operator.passwordHash } });
    const outside = await createTestCompany(`web race outside ${tag}`, []);
    const scopeIntercept = vi.spyOn(db.loginAttempt, "deleteMany").mockImplementation((...args) => (async () => {
      const result = await originalDelete(...args);
      await db.userCompanyMembership.create({ data: { userId: target.id, companyId: outside.id } });
      return result;
    })() as ReturnType<typeof db.loginAttempt.deleteMany>);
    try { await expect(resetManagedUserPassword(operator, target.id, payload)).rejects.toMatchObject({ status: 404 }); }
    finally { scopeIntercept.mockRestore(); }
    expect((await listManagedUsers(operator)).some(user => user.id === target.id)).toBe(false);
    expect((await db.user.findUniqueOrThrow({ where: { id: target.id } })).passwordHash).toBe(target.passwordHash);
  });
});
