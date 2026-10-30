import { Role } from "@prisma/client";
import { z } from "zod";
import { hashPassword } from "../src/lib/password";
import { createDb } from "../src/lib/db";

const input = z.object({
  email: z
    .email()
    .max(254)
    .transform((value) => value.trim().toLowerCase()),
  name: z.string().trim().min(2).max(100),
  password: z.string().min(14).max(128),
  role: z.enum(Role),
});

async function main() {
  if (process.env.ALLOW_USER_PROVISIONING !== "true") {
    throw new Error(
      "Set ALLOW_USER_PROVISIONING=true explicitly in your secure environment before provisioning a user.",
    );
  }
  const parsed = input.safeParse({
    email: process.env.NEW_USER_EMAIL,
    name: process.env.NEW_USER_NAME,
    password: process.env.NEW_USER_PASSWORD,
    role: process.env.NEW_USER_ROLE,
  });
  if (!parsed.success)
    throw new Error(
      "Provide valid NEW_USER_EMAIL, NEW_USER_NAME, NEW_USER_PASSWORD (14–128 characters), and NEW_USER_ROLE (ADMIN, ACCOUNTS, DATA_ENTRY, MANAGEMENT). Values are never logged.",
    );
  const db = createDb();
  try {
    const passwordHash = await hashPassword(parsed.data.password);
    await db.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: parsed.data.email,
          name: parsed.data.name,
          role: parsed.data.role,
          passwordHash,
        },
      });
      await tx.auditLog.create({
        data: {
          action: "USER_PROVISIONED",
          entityType: "User",
          entityId: user.id,
          details: { role: user.role, source: "operator_cli" },
        },
      });
    });
    console.log(
      "User created with an audit record. No existing user or password was changed.",
    );
  } finally {
    await db.$disconnect();
  }
}
main().catch((error: unknown) => {
  if (
    error instanceof Error &&
    (error.message.startsWith("Set ALLOW_") ||
      error.message.startsWith("Provide valid"))
  )
    console.error(error.message);
  else
    console.error(
      "User provisioning failed. Confirm the database is available and the email is not already registered.",
    );
  process.exitCode = 1;
});
