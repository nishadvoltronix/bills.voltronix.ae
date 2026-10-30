import { createHash, randomBytes } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { validateDeploymentEnvironment } from "./entrypoint.mjs";

const deploymentDirectory = path.dirname(fileURLToPath(import.meta.url));

function privateFile(file) {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("The environment path must be a regular private file.");
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

/** Fresh-install configuration only. Never reads development credentials. */
export function prepareProductionFiles(directory = deploymentDirectory) {
  const files = [
    ["production.env.example", ".env.production"],
    ["migration.env.example", ".env.migration"],
  ];
  // Inspect every destination before writing, including dangling symlinks.
  const existing = files.map(([, name]) => privateFile(path.join(directory, name)));
  return files.map(([template, name], index) => {
    if (existing[index]) return { file: name, status: "PRESERVED" };
    let contents = readFileSync(path.join(directory, template), "utf8");
    if (name === ".env.production") {
      if (!/^INTEGRATION_TOKEN_ENCRYPTION_KEY=$/m.test(contents.replaceAll("\r", "")))
        throw new Error("The production template must have an empty encryption-key setting.");
      contents = contents.replace(/^INTEGRATION_TOKEN_ENCRYPTION_KEY=\r?$/m,
        `INTEGRATION_TOKEN_ENCRYPTION_KEY=${randomBytes(32).toString("hex")}`);
    }
    writeFileSync(path.join(directory, name), contents, { flag: "wx", mode: 0o600 });
    return { file: name, status: "CREATED" };
  });
}

function readinessCommand(directory, runtime, migration) {
  const files = ["deploy/compose.yaml"];
  if (runtime.DATABASE_TLS_CA_FILE === "/run/secrets/mysql_ca") {
    files.push("deploy/compose.mysql-ca.yaml");
    try {
      const owned = [runtime, migration].every(env => {
        const database = new URL(env.DATABASE_URL);
        return database.protocol === "mysql:" && database.hostname === "mysql" && (database.port || "3306") === "3306" &&
          database.pathname === "/billing_operational" && env.DATABASE_TLS_MODE === "verify-full" &&
          env.DATABASE_TLS_CA_FILE === "/run/secrets/mysql_ca";
      });
      const receiptFile = path.join(directory, ".private", "mysql", "prepared.json");
      const caFile = path.join(directory, ".private", "mysql-ca.pem");
      if (owned && privateFile(receiptFile) && privateFile(caFile)) {
        const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
        if (receipt.version === 1 && receipt.hostname === "mysql" && receipt.database === "billing_operational" &&
            receipt.caSha256 === createHash("sha256").update(readFileSync(caFile)).digest("hex"))
          files.push("deploy/compose.mysql.yaml");
      }
    } catch { /* An absent/mismatched preparation receipt does not identify an owned database. */ }
  }
  return `docker compose ${files.map(file => `-f ${file}`).join(" ")} run --rm --no-deps web check:sync`;
}

/** Offline preparation check: reports field names, never their values. */
export function inspectProductionFiles(directory = deploymentDirectory, { requirePosting = false } = {}) {
  const missing = [], invalid = [];
  const read = (name) => {
    const file = path.join(directory, name);
    if (!privateFile(file)) { missing.push(name); return {}; }
    return parseEnv(readFileSync(file, "utf8"));
  };
  const runtime = read(".env.production");
  const migration = read(".env.migration");
  const required = ["DATABASE_URL", "INTEGRATION_TOKEN_ENCRYPTION_KEY", "ZOHO_BOOKS_DC",
    "ZOHO_BOOKS_CLIENT_ID", "ZOHO_BOOKS_CLIENT_SECRET", "ZOHO_BOOKS_ORGANIZATIONS_JSON",
    "ZOHO_CRM_DC", "ZOHO_CRM_ORGANIZATION_ID", "ZOHO_CRM_CLIENT_ID", "ZOHO_CRM_CLIENT_SECRET",
    "ZOHO_CRM_MAPPING_JSON", "INCOMING_SYNC_OPERATOR_EMAIL", "INCOMING_SYNC_OPERATOR_PASSWORD"];
  for (const key of required) if (!runtime[key]?.trim()) missing.push(`runtime.${key}`);
  for (const [label, env] of [["runtime", runtime], ["migration", migration]]) {
    if (/REPLACE_PRIVATELY|MYSQL_HOST/i.test(env.DATABASE_URL ?? "")) missing.push(`${label}.DATABASE_URL`);
    try {
      // Check the migration shape without enabling or executing a migration.
      validateDeploymentEnvironment(label === "migration" ? { ...env, ALLOW_PRODUCTION_MIGRATION: "true" } : env,
        { migration: label === "migration" });
    } catch { invalid.push(`${label}.DEPLOYMENT_ENVIRONMENT`); }
  }
  if (!/^[a-fA-F0-9]{64}$/.test(runtime.INTEGRATION_TOKEN_ENCRYPTION_KEY ?? "")) invalid.push("runtime.INTEGRATION_TOKEN_ENCRYPTION_KEY");
  for (const key of ["ZOHO_BOOKS_ORGANIZATIONS_JSON", "ZOHO_CRM_MAPPING_JSON", "INCOMING_SYNC_NOT_BEFORE_JSON", "ZOHO_BOOKS_REFRESH_TOKENS_JSON"]) {
    if (runtime[key]) {
      try {
        const value = JSON.parse(runtime[key]);
        if (key === "ZOHO_BOOKS_ORGANIZATIONS_JSON") {
          if (!Array.isArray(value) || !value.length || value.length > 20 || value.some(profile =>
            !profile || typeof profile !== "object" || typeof profile.organizationId !== "string" || !/^\d{1,30}$/.test(profile.organizationId) ||
            typeof profile.name !== "string" || !profile.name.trim()) ||
            new Set(value.map(profile => profile.organizationId)).size !== value.length) throw new Error("Invalid profiles");
        } else if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid object");
      } catch { invalid.push(`runtime.${key}`); }
    }
  }
  for (const product of ["BOOKS", "CRM"]) {
    if (!["US", "EU", "IN", "AU", "JP", "CA", "CN", "SA", "AE"].includes(runtime[`ZOHO_${product}_DC`]))
      invalid.push(`runtime.ZOHO_${product}_DC`);
    if (runtime[`ZOHO_${product}_ENVIRONMENT`] !== "production") invalid.push(`runtime.ZOHO_${product}_ENVIRONMENT`);
  }
  if (!/^\d{1,30}$/.test(runtime.ZOHO_CRM_ORGANIZATION_ID ?? "")) invalid.push("runtime.ZOHO_CRM_ORGANIZATION_ID");
  if (runtime.ZOHO_BOOKS_REFRESH_TOKEN && runtime.ZOHO_BOOKS_REFRESH_TOKENS_JSON) invalid.push("runtime.BOOKS_REFRESH_TOKEN_CONFLICT");
  const expected = { MANUAL_ENTRY_ONLY: "false", ALLOW_DEMO_SEED: "false", OCR_PROVIDER: "disabled",
    SCANNER_IMPORT_ENABLED: "false", HUB_BRIDGE_ENABLED: "false", INCOMING_SYNC_ENABLED: "true",
    INCOMING_SYNC_INTERVAL_SECONDS: "60", INTEGRATION_NETWORK_ENABLED: "true", ZOHO_BOOKS_NETWORK_ENABLED: "true",
    ZOHO_CRM_NETWORK_ENABLED: "true", ALLOW_PRODUCTION_ACCOUNTING_WRITES: "false" };
  for (const [key, value] of Object.entries(expected)) if (runtime[key] !== value) invalid.push(`runtime.${key}`);
  if (!["false", "true"].includes(runtime.ZOHO_BOOKS_WRITE_ENABLED) || runtime.ZOHO_BOOKS_WRITE_ENABLED !== runtime.ZOHO_BOOKS_LIVE_ENABLED)
    invalid.push("runtime.BOOKS_WRITE_FLAGS");
  const postingConfigured = runtime.ZOHO_BOOKS_WRITE_ENABLED === "true" && runtime.ZOHO_BOOKS_LIVE_ENABLED === "true";
  if (requirePosting && !postingConfigured) invalid.push("runtime.BOOKS_POSTING_DISABLED");
  if (runtime.NODE_TLS_REJECT_UNAUTHORIZED === "0" || migration.NODE_TLS_REJECT_UNAUTHORIZED === "0") invalid.push("DATABASE_TLS_VERIFICATION");
  try {
    const runtimeDb = new URL(runtime.DATABASE_URL), migrationDb = new URL(migration.DATABASE_URL);
    if (runtimeDb.hostname !== migrationDb.hostname || (runtimeDb.port || "3306") !== (migrationDb.port || "3306") ||
        runtimeDb.pathname !== migrationDb.pathname || runtimeDb.username === migrationDb.username)
      invalid.push("DATABASE_IDENTITY_PAIR");
  } catch { invalid.push("DATABASE_IDENTITY_PAIR"); }
  return { status: missing.length || invalid.length ? "INPUT_REQUIRED" : "CONFIGURATION_PRESENT_UNVERIFIED",
    phase: postingConfigured ? "POSTING_CONFIGURED_UNVERIFIED" : "SETUP_WRITES_DISABLED",
    missing: [...new Set(missing)], invalid: [...new Set(invalid)],
    nextCheck: readinessCommand(directory, runtime, migration),
    databaseConnections: 0, providerRequests: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && !["--check", "--check-posting"].includes(args[0]))) throw new Error("Unsupported arguments.");
    const files = args.length ? undefined : prepareProductionFiles();
    const report = inspectProductionFiles(undefined, { requirePosting: args[0] === "--check-posting" });
    console.log(JSON.stringify({ files, ...report }, null, 2));
    if (args.length && report.status === "INPUT_REQUIRED") process.exitCode = 2;
  } catch {
    console.error("Production configuration could not be prepared or checked. Inspect file access and templates privately; no values were logged.");
    process.exitCode = 1;
  }
}
