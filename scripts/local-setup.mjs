import { randomBytes } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";

// This helper only provisions a new, local development environment. It never overwrites .env.
const databasePassword = randomBytes(32).toString("base64url");
const adminPassword = randomBytes(24).toString("base64url");
const accountsPassword = randomBytes(24).toString("base64url");
const settings = [
  "# LOCAL DEVELOPMENT ONLY. Generated secrets; never commit or share this file.",
  `DATABASE_URL="postgresql://bills_local:${databasePassword}@127.0.0.1:55432/bills_dev?schema=public"`,
  'APP_URL="http://127.0.0.1:3000"',
  'APP_ENV="development"',
  'UPLOAD_DIR=".local/uploads"',
  'ALLOW_DEMO_SEED="true"',
  'SEED_ADMIN_EMAIL="admin@voltronix.test"',
  `SEED_ADMIN_PASSWORD="${adminPassword}"`,
  'SEED_ACCOUNTS_EMAIL="accounts@voltronix.test"',
  `SEED_ACCOUNTS_PASSWORD="${accountsPassword}"`,
  "",
].join("\n");
try {
  await writeFile(".env", settings, { flag: "wx", mode: 0o600 });
  await mkdir(".local/uploads", { recursive: true });
  console.log(
    "Created ignored .env with unique local credentials. Read it locally to sign in after seeding.",
  );
  console.log(
    "Next: npm run db:local (keep running), then npm run db:migrate and npm run db:seed in a second terminal.",
  );
} catch (error) {
  if (error.code === "EEXIST")
    console.error(
      ".env already exists; it was preserved. Use your existing local configuration.",
    );
  else console.error("Local setup failed. Check workspace write permissions.");
  process.exitCode = 1;
}
