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
  const input = passwordChangeSchema.parse(payload);
  const key = authenticationAttemptKey("password-change", actor.id);
  const attempt = await reserveAuthenticationAttempt(key);
  const current = await db.user.findUnique({ where: { id: actor.id } });
  if (
    !current?.active ||
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
          key: { in: [key, authenticationAttemptKey("login", current.email)] },
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
export async function authenticateAccountOperator(
  email: string,
  password: string,
): Promise<Actor> {
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
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

/** Server/operator service only. There is deliberately no public password-recovery endpoint. */
export async function administerAccount(actor: Actor, payload: unknown) {
  const input = administrationSchema.parse(payload);
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
      const target = await tx.user.findUnique({
        where: { email: input.email },
      });
      if (!target) throw new HttpError(404, "Account not found.");
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
            source: "operator_cli",
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
