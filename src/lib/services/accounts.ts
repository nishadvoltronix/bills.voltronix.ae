import "server-only";
import { Prisma } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import { hashPassword, verifyPassword } from "@/lib/password";
import {
  authenticationAttemptKey,
  reserveAuthenticationAttempt,
  recordFailedAuthentication,
} from "@/lib/security/authentication-attempts";

export const passwordChangeSchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newPassword: z.string().min(14, "Use at least 14 characters.").max(128),
  })
  .strict()
  .refine((input) => input.currentPassword !== input.newPassword, {
    path: ["newPassword"],
    message: "Choose a different password.",
  });

const administrationSchema = z
  .object({
    operation: z.enum([
      "deactivate",
      "reactivate",
      "reset-password",
      "revoke-sessions",
    ]),
    email: z
      .email()
      .max(254)
      .transform((email) => email.trim().toLowerCase()),
    reason: z.string().trim().min(10).max(500),
    newPassword: z.string().min(14).max(128).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.operation === "reset-password" && !input.newPassword)
      context.addIssue({
        code: "custom",
        path: ["newPassword"],
        message: "A securely supplied replacement password is required.",
      });
    if (input.operation !== "reset-password" && input.newPassword)
      context.addIssue({
        code: "custom",
        path: ["newPassword"],
        message:
          "A replacement password is only accepted for a password reset.",
      });
  });

export async function changeOwnPassword(actor: Actor, payload: unknown) {
  if (actor.role !== "ADMIN") throw new HttpError(403, "Your password is managed by an administrator.");
  const input = passwordChangeSchema.parse(payload);
  const key = authenticationAttemptKey("password-change", actor.id);
  const attempt = await reserveAuthenticationAttempt(key);
  const current = await db.user.findUnique({ where: { id: actor.id } });
  if (
    !current?.active || current.role !== "ADMIN" ||
    !(await verifyPassword(input.currentPassword, current.passwordHash))
  ) {
    await recordFailedAuthentication(key, attempt);
    throw new HttpError(
      401,
      "The current password is incorrect or the account is unavailable.",
    );
  }
  const passwordHash = await hashPassword(input.newPassword);
  await db.$transaction(
    async (tx) => {
      const updated = await tx.user.updateMany({
        where: {
          id: actor.id,
          active: true,
          role: "ADMIN",
          passwordHash: current.passwordHash,
        },
        data: { passwordHash },
      });
      if (updated.count !== 1)
        throw new HttpError(
          409,
          "Account credentials changed during the request. Sign in again.",
        );
      const revoked = await tx.session.deleteMany({
        where: { userId: actor.id },
      });
      await tx.loginAttempt.deleteMany({
        where: {
          key: { in: [key, authenticationAttemptKey("login", current.email), authenticationAttemptKey("account-operator", current.email)] },
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: "PASSWORD_CHANGED",
          entityType: "User",
          entityId: actor.id,
          details: {
            source: "authenticated_user",
            revokedSessions: revoked.count,
          },
        },
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
  return { success: true, requiresSignIn: true };
}

/** The trusted-host CLI reauthenticates a real active administrator; an email is not sufficient. */
async function authenticateOperatorProof(
  email: string,
  password: string,
) {
  const input = z
    .object({ email: z.email().max(254), password: z.string().min(1).max(128) })
    .parse({ email: email.trim().toLowerCase(), password });
  const key = authenticationAttemptKey("account-operator", input.email);
  const attempt = await reserveAuthenticationAttempt(key);
  const user = await db.user.findUnique({ where: { email: input.email } });
  const expected =
    user?.passwordHash ?? (await hashPassword(randomBytes(32).toString("hex")));
  const verified = await verifyPassword(input.password, expected);
  if (!verified || !user?.active || user.role !== "ADMIN") {
    await recordFailedAuthentication(key, attempt);
    throw new HttpError(
      401,
      "An active administrator and valid operator credentials are required.",
    );
  }
  await db.loginAttempt.deleteMany({ where: { key } });
  return { actor: { id: user.id, email: user.email, name: user.name, role: user.role } as Actor, passwordHash: user.passwordHash };
}

export async function authenticateAccountOperator(email: string, password: string): Promise<Actor> {
  return (await authenticateOperatorProof(email, password)).actor;
}

const safeUserSelect = { id: true, name: true, email: true, role: true, active: true } as const;
type AccountStore = Pick<Prisma.TransactionClient, "user" | "userCompanyMembership">;
async function adminCompanies(store: AccountStore, actor: Actor) {
  const current = await store.user.findUnique({ where: { id: actor.id }, select: { active: true, role: true } });
  if (actor.role !== "ADMIN" || !current?.active || current.role !== "ADMIN")
    throw new HttpError(403, "Only an active administrator may manage user passwords.");
  const rows = await store.userCompanyMembership.findMany({ where: { userId: actor.id, active: true, company: { active: true } }, select: { companyId: true } });
  return rows.map(row => row.companyId);
}

async function assertManagedTarget(store: AccountStore, actor: Actor, targetId: string) {
  const companies = await adminCompanies(store, actor);
  const memberships = await store.userCompanyMembership.findMany({ where: { userId: targetId, active: true, company: { active: true } }, select: { companyId: true } });
  if (!memberships.length || memberships.some(member => !companies.includes(member.companyId)))
    throw new HttpError(404, "Account not found in your authorized companies.");
}

export async function listManagedUsers(actor: Actor) {
  if (actor.role !== "ADMIN") throw new HttpError(403, "Only Admin may view user management.");
  return db.$transaction(async tx => {
    const companies = await adminCompanies(tx, actor);
    return tx.user.findMany({ where: { OR: [{ id: actor.id }, { memberships: {
      some: { active: true, company: { active: true }, companyId: { in: companies } },
      none: { active: true, company: { active: true }, companyId: { notIn: companies } },
    } }] }, select: safeUserSelect, orderBy: [{ name: "asc" }, { id: "asc" }], take: 501 });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export const managedPasswordResetSchema = z.object({
  adminCurrentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(14, "Use at least 14 characters.").max(128),
  confirmation: z.string().min(14).max(128),
  reason: z.string().trim().min(10).max(500),
}).strict().refine(value => value.newPassword === value.confirmation, { path: ["confirmation"], message: "The new passwords do not match." })
  .refine(value => !value.reason.includes(value.newPassword) && !value.reason.includes(value.adminCurrentPassword), {
    path: ["reason"], message: "Do not include passwords in the audit reason.",
  });
type ManagedResetProof = { operatorId: string; passwordHash: string; targetId: string; targetEmail: string };
const managedResets = new WeakMap<object, ManagedResetProof>();

/** An authenticated Admin must also prove their current password for this exact reset. */
export async function resetManagedUserPassword(actor: Actor, targetId: string, payload: unknown) {
  if (actor.role !== "ADMIN") throw new HttpError(403, "Only Admin may reset user passwords.");
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(targetId)) throw new HttpError(404, "Account not found.");
  if (actor.id === targetId) throw new HttpError(409, "Use Account security to change your own password.");
  const input = managedPasswordResetSchema.parse(payload);
  const verified = await authenticateOperatorProof(actor.email, input.adminCurrentPassword);
  if (verified.actor.id !== actor.id) throw new HttpError(403, "Administrator identity changed. Sign in again.");
  const target = await db.user.findUnique({ where: { id: targetId }, select: safeUserSelect });
  if (!target) throw new HttpError(404, "Account not found.");
  const proof = Object.freeze({ kind: "managed-password-reset" });
  managedResets.set(proof, { operatorId: actor.id, passwordHash: verified.passwordHash, targetId, targetEmail: target.email });
  try {
    return await administerAccount(actor, { operation: "reset-password", email: target.email, newPassword: input.newPassword, reason: input.reason }, proof);
  } finally { managedResets.delete(proof); }
}

/** Trusted CLI recovery remains available; HTTP resets require a private single-use proof. */
export async function administerAccount(actor: Actor, payload: unknown, proof?: unknown) {
  if (actor.role !== "ADMIN") throw new HttpError(403, "Only an active administrator may administer accounts.");
  const managed = proof !== undefined && typeof proof === "object" && proof !== null ? managedResets.get(proof) : undefined;
  if (proof !== undefined && !managed) throw new HttpError(403, "Current administrator verification is required.");
  const input = administrationSchema.parse(payload);
  if (managed && (managed.operatorId !== actor.id || input.operation !== "reset-password" || managed.targetEmail !== input.email))
    throw new HttpError(403, "The verified password reset no longer matches this request.");
  const passwordHash = input.newPassword
    ? await hashPassword(input.newPassword)
    : undefined;
  return db.$transaction(
    async (tx) => {
      const operator = await tx.user.findUnique({ where: { id: actor.id } });
      if (!operator?.active || operator.role !== "ADMIN")
        throw new HttpError(
          403,
          "Only an active administrator may administer accounts.",
        );
      if (managed && operator.passwordHash !== managed.passwordHash)
        throw new HttpError(409, "Administrator credentials changed. Sign in again before resetting passwords.");
      const target = await tx.user.findUnique({
        where: { email: input.email },
      });
      if (!target) throw new HttpError(404, "Account not found.");
      if (managed) {
        if (target.id !== managed.targetId || target.id === operator.id)
          throw new HttpError(409, "The selected user changed. Reload user management.");
        await assertManagedTarget(tx, actor, target.id);
      }
      if (input.operation === "deactivate" && target.id === operator.id)
        throw new HttpError(
          409,
          "Use a different administrator to deactivate this account.",
        );
      if (
        input.operation === "deactivate" &&
        target.active &&
        target.role === "ADMIN"
      ) {
        const activeAdmins = await tx.user.count({
          where: { active: true, role: "ADMIN" },
        });
        if (activeAdmins <= 1)
          throw new HttpError(
            409,
            "The final active administrator cannot be deactivated.",
          );
      }
      const active =
        input.operation === "deactivate"
          ? false
          : input.operation === "reactivate"
            ? true
            : target.active;
      if (input.operation === "reset-password" && !target.active)
        throw new HttpError(
          409,
          "Reactivate a verified account separately before resetting its password.",
        );
      if (input.operation !== "revoke-sessions")
        await tx.user.update({
          where: { id: target.id },
          data: { active, ...(passwordHash ? { passwordHash } : {}) },
        });
      const revoked = await tx.session.deleteMany({
        where: { userId: target.id },
      });
      if (input.operation === "reset-password")
        await tx.loginAttempt.deleteMany({
          where: {
            key: {
              in: [
                authenticationAttemptKey("login", target.email),
                authenticationAttemptKey("password-change", target.id),
                authenticationAttemptKey("account-operator", target.email),
              ],
            },
          },
        });
      await tx.auditLog.create({
        data: {
          actorId: operator.id,
          action: `ACCOUNT_${input.operation.toUpperCase().replaceAll("-", "_")}`,
          entityType: "User",
          entityId: target.id,
          details: {
            source: managed ? "admin_user_management" : "operator_cli",
            reason: input.reason,
            previousActive: target.active,
            active,
            revokedSessions: revoked.count,
          },
        },
      });
      return {
        success: true,
        operation: input.operation,
        revokedSessions: revoked.count,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}
