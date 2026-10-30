import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { Prisma, type Role } from "@prisma/client";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import { hashPassword, verifyPassword } from "@/lib/password";
import { reserveAuthenticationAttempt } from "@/lib/security/authentication-attempts";
import { AUTH_RETURN_PATH_HEADER, loginUrl } from "@/lib/auth-navigation";

export type Actor = { id: string; email: string; name: string; role: Role };
export const SESSION_COOKIE = "voltronix_session";
const SESSION_DURATION = 8 * 60 * 60 * 1000;
const ATTEMPT_WINDOW = 15 * 60 * 1000;
let dummyPassword: Promise<string> | undefined;
const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");

function assertSecureConfiguration(): void {
  const production =
    process.env.APP_ENV === "production" ||
    (process.env.NODE_ENV === "production" &&
      !["development", "test"].includes(process.env.APP_ENV ?? ""));
  if (production) {
    let configured: URL;
    try {
      configured = new URL(process.env.APP_URL ?? "");
    } catch {
      throw new HttpError(
        503,
        "Production authentication requires a configured HTTPS application origin.",
      );
    }
    if (configured.protocol !== "https:")
      throw new HttpError(
        503,
        "Production authentication requires a configured HTTPS application origin.",
      );
  }
}

export async function getCurrentUser(): Promise<Actor | null> {
  assertSecureConfiguration();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const session = await db.session.findUnique({
    where: { tokenHash: tokenHash(token) },
    include: { user: true },
  });
  if (!session || session.expiresAt <= new Date() || !session.user.active)
    return null;
  const { id, email, name, role } = session.user;
  return { id, email, name, role };
}

export async function requireUser(roles?: readonly Role[]): Promise<Actor> {
  const actor = await getCurrentUser();
  if (!actor) throw new HttpError(401, "Please sign in to continue.");
  if (roles && !roles.includes(actor.role))
    throw new HttpError(
      403,
      "You do not have permission to perform this action.",
    );
  return actor;
}

export async function requirePageUser(): Promise<Actor> {
  const actor = await getCurrentUser();
  if (!actor)
    redirect(loginUrl((await headers()).get(AUTH_RETURN_PATH_HEADER)));
  return actor;
}

export async function signIn(email: string, password: string): Promise<Actor> {
  assertSecureConfiguration();
  const normalizedEmail = email.trim().toLowerCase();
  const attemptKey = tokenHash(`login:${normalizedEmail}`);
  const now = new Date();
  const count = await reserveAuthenticationAttempt(attemptKey, "Too many sign-in attempts. Try again in 15 minutes.");
  const user = await db.user.findUnique({ where: { email: normalizedEmail } });
  dummyPassword ??= hashPassword(randomBytes(32).toString("hex"));
  const valid = await verifyPassword(
    password,
    user?.passwordHash ?? (await dummyPassword),
  );
  if (!user?.active || !valid) {
    if (count >= 5)
      await db.loginAttempt.updateMany({
        where: { key: attemptKey },
        data: { lockedUntil: new Date(now.getTime() + ATTEMPT_WINDOW) },
      });
    throw new HttpError(401, "The email or password is incorrect.");
  }
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(now.getTime() + SESSION_DURATION);
  const oldToken = (await cookies()).get(SESSION_COOKIE)?.value;
  await db.$transaction(
    async (tx) => {
      // Recovery/deactivation must not race a password verification that started
      // before the credential change and issue a fresh session afterwards.
      const current = await tx.user.findFirst({
        where: { id: user.id, active: true, passwordHash: user.passwordHash },
      });
      if (!current)
        throw new HttpError(401, "Account credentials changed. Sign in again.");
      await tx.loginAttempt.deleteMany({ where: { key: attemptKey } });
      if (oldToken)
        await tx.session.deleteMany({
          where: { tokenHash: tokenHash(oldToken) },
        });
      await tx.session.deleteMany({
        where: { userId: user.id, expiresAt: { lt: now } },
      });
      await tx.session.create({
        data: { userId: user.id, tokenHash: tokenHash(token), expiresAt },
      });
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: "LOGIN",
          entityType: "User",
          entityId: user.id,
          details: {},
        },
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure:
      new URL(process.env.APP_URL || "http://127.0.0.1").protocol === "https:",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

export async function signOut(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token)
    await db.session.deleteMany({ where: { tokenHash: tokenHash(token) } });
  jar.delete(SESSION_COOKIE);
}

/** Used after a transaction has already revoked every session. */
export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}
