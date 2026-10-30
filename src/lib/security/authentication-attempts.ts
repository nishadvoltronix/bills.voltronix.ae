import "server-only";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import { Prisma } from "@prisma/client";

const WINDOW_MS = 15 * 60 * 1000;
export function authenticationAttemptKey(purpose: string, identity: string) {
  return createHash("sha256").update(`${purpose}:${identity}`).digest("hex");
}

export async function reserveAuthenticationAttempt(key: string, message = "Too many authentication attempts. Try again in 15 minutes.") {
  const now = new Date();
  const cutoff = new Date(now.getTime() - WINDOW_MS);
  // The upsert holds its row lock until the reserved count has been read.
  // Evaluate the old window before assigning windowStart (MySQL evaluates left to right).
  const attempt = await db.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO \`LoginAttempt\` (\`key\`, \`count\`, \`windowStart\`, \`lockedUntil\`)
      VALUES (${key}, 1, ${now}, NULL)
      ON DUPLICATE KEY UPDATE
        \`count\` = CASE WHEN \`windowStart\` < ${cutoff} THEN 1 ELSE LEAST(\`count\` + 1, 1000) END,
        \`lockedUntil\` = CASE WHEN \`windowStart\` < ${cutoff} THEN NULL ELSE \`lockedUntil\` END,
        \`windowStart\` = CASE WHEN \`windowStart\` < ${cutoff} THEN ${now} ELSE \`windowStart\` END
    `;
    return tx.loginAttempt.findUniqueOrThrow({ where: { key } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  if (attempt.count > 5 || (attempt.lockedUntil && attempt.lockedUntil > now)) {
    throw new HttpError(
      429,
      message,
    );
  }
  return attempt.count;
}

export async function recordFailedAuthentication(key: string, count: number) {
  if (count >= 5)
    await db.loginAttempt.updateMany({
      where: { key },
      data: { lockedUntil: new Date(Date.now() + WINDOW_MS) },
    });
}
