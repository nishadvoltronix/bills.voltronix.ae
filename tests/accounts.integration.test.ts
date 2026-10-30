import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/password";
import { assertMySqlTestDatabase, createTestCompany } from "./company-fixtures";
import {
  administerAccount,
  authenticateAccountOperator,
  changeOwnPassword,
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
    await session(accounts.id);
    await session(accounts.id);
    const original = await db.user.findUniqueOrThrow({
      where: { id: accounts.id },
    });
    await expect(
      changeOwnPassword(accounts, {
        currentPassword: "wrong-password",
        newPassword: "Fictional-new-personal-password-928!",
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: accounts.id } }))
        .passwordHash,
    ).toBe(original.passwordHash);
    const changed = await changeOwnPassword(accounts, {
      currentPassword: fixturePassword,
      newPassword: "Fictional-new-personal-password-928!",
    });
    expect(changed).toEqual({ success: true, requiresSignIn: true });
    expect(await db.session.count({ where: { userId: accounts.id } })).toBe(0);
    expect(
      await db.auditLog.count({
        where: {
          actorId: accounts.id,
          action: "PASSWORD_CHANGED",
          entityId: accounts.id,
        },
      }),
    ).toBe(1);
  });

  it("rate limits password-change guesses and does not permit resetting another account through payload fields", async () => {
    await expect(
      changeOwnPassword(staff, {
        currentPassword: "wrong",
        newPassword: "Fictional-strong-new-password-01",
        userId: administrator.id,
      }),
    ).rejects.toThrow();
    for (let count = 0; count < 5; count++)
      await expect(
        changeOwnPassword(staff, {
          currentPassword: "wrong",
          newPassword: "Fictional-strong-new-password-01",
        }),
      ).rejects.toMatchObject({ status: 401 });
    await expect(
      changeOwnPassword(staff, {
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
      changeOwnPassword(accounts, {
        currentPassword: fixturePassword,
        newPassword: fixturePassword,
      }),
    ).rejects.toThrow();
  });
});
