import path from "node:path";
import { lstat, readFile, realpath } from "node:fs/promises";
import { parse } from "dotenv";
import { db } from "../src/lib/db";
import { decryptToken } from "../src/lib/integrations/oauth";
import { verifyPassword } from "../src/lib/password";
import { deriveZohoBootstrapSettings, replacePrivateEnvironmentValues } from "./lib/zoho-bootstrap-transfer";
import { replacePrivateEnvironmentFile } from "./lib/private-environment-file";
import { incomingSources } from "../src/lib/services/incoming-sync-access";
import { getBooksOrganizations, getConfig } from "../src/lib/integrations/config";

async function main() {
  if (process.argv.length !== 2 || process.env.ALLOW_ZOHO_BOOTSTRAP_TRANSFER !== "true")
    throw new Error("EXPLICIT_BOOTSTRAP_TRANSFER_REQUIRED");
  const email = process.env.ACCOUNT_OPERATOR_EMAIL || process.env.SEED_ADMIN_EMAIL || "";
  const password = process.env.ACCOUNT_OPERATOR_PASSWORD || process.env.SEED_ADMIN_PASSWORD || "";
  const operator = await db.user.findUnique({ where: { email: email.trim().toLowerCase() },
    select: { id: true, name: true, email: true, active: true, role: true, passwordHash: true } });
  if (!operator?.active || operator.role !== "ADMIN" || !password || !await verifyPassword(password, operator.passwordHash))
    throw new Error("SOURCE_OPERATOR_REQUIRED");
  const filename = path.resolve("deploy/.env.production");
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || await realpath(filename) !== filename)
    throw new Error("PRIVATE_FILE_REQUIRED");
  const before = await readFile(filename, "utf8");
  const parsed = parse(before);
  if (parsed.NODE_ENV !== "production") throw new Error("PRODUCTION_CONFIGURATION_REQUIRED");
  const target: NodeJS.ProcessEnv = { ...parsed, NODE_ENV: "production" };
  const actor = { id: operator.id, name: operator.name, email: operator.email, role: operator.role };
  const sources = await incomingSources(actor);
  const required = [...getBooksOrganizations().map(row => ({ target: "ZOHO" as const, organizationId: row.organizationId })),
    { target: "CRM" as const, organizationId: getConfig("CRM").organizationId }];
  if (required.some(identity => !sources.some(source => source.target === identity.target &&
      source.organizationId === identity.organizationId && !source.configurationError))) throw new Error("SOURCE_MEMBERSHIP_REQUIRED");
  const grants = await db.integrationCredential.findMany({ select: {
    target: true, organizationId: true, dataCenter: true, connectionFingerprint: true,
    refreshTokenEncrypted: true, revokedAt: true,
  } });
  const values = deriveZohoBootstrapSettings(process.env, target, grants, decryptToken);
  const after = replacePrivateEnvironmentValues(before, values);
  if (!await db.user.findFirst({ where: { id: operator.id, active: true, role: "ADMIN", passwordHash: operator.passwordHash } }) ||
      JSON.stringify(await incomingSources(actor)) !== JSON.stringify(sources) ||
      JSON.stringify(await db.integrationCredential.findMany({ select: { target: true, organizationId: true, dataCenter: true,
        connectionFingerprint: true, refreshTokenEncrypted: true, revokedAt: true } })) !== JSON.stringify(grants))
    throw new Error("SOURCE_AUTHORIZATION_CHANGED");
  if (await readFile(filename, "utf8") !== before) throw new Error("PRIVATE_CONFIGURATION_CHANGED");
  if (before !== after) await replacePrivateEnvironmentFile(filename, before, after);
  console.log(JSON.stringify({ prepared: true, booksOrganizations: Object.keys(JSON.parse(values.ZOHO_BOOKS_REFRESH_TOKENS_JSON)).length,
    crmSources: 1, targetEncryptionKeyPreserved: true, providerRequests: 0, databaseWrites: 0,
    providerAuthorizationRechecked: false, financialWritesEnabled: false }));
}

main().catch(() => {
  console.error("Private Zoho bootstrap preparation failed. Verify the local Admin, exact source/client grants and protected production file; no credentials were printed.");
  process.exitCode = 1;
}).finally(() => db.$disconnect());
