import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Fixed diagnostics only: never include supplied values in a startup error. */
export function validateDeploymentEnvironment(env, { migration = false } = {}) {
  if (env.NODE_ENV !== "production" || env.APP_ENV !== "production" ||
      env.APP_URL !== "https://bills.voltronix.ae" || env.INTEGRATION_TEST_MODE !== "false")
    throw new Error("Production runtime, exact HTTPS origin and disabled test mode are required.");
  if (env.ALLOW_DEMO_SEED === "true" || env.SEED_ADMIN_EMAIL || env.SEED_ADMIN_PASSWORD ||
      env.SEED_ACCOUNTS_EMAIL || env.SEED_ACCOUNTS_PASSWORD)
    throw new Error("Development seed configuration must not be copied into production.");
  let database;
  try { database = new URL(env.DATABASE_URL ?? ""); } catch {
    throw new Error("Configure the dedicated operational MySQL connection.");
  }
  const name = decodeURIComponent(database.pathname.slice(1));
  const user = decodeURIComponent(database.username);
  if (database.protocol !== "mysql:" || !database.hostname || !user || !database.password ||
      !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ||
      /(dev|test|demo|restore|fixture|sandbox|local)/i.test(name) ||
      ["mysql", "sys", "information_schema", "performance_schema"].includes(name.toLowerCase()) ||
      database.search || database.hash || /^(root|mysql\.)/i.test(user) ||
      (!migration && /(admin|migrat)/i.test(user)) ||
      (["127.0.0.1", "localhost", "[::1]"].includes(database.hostname) && database.port === "3308"))
    throw new Error("Use a dedicated operational database and an appropriately restricted identity.");
  if (env.DATABASE_TLS_MODE !== "verify-full" || env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
    throw new Error("Production MySQL requires verified TLS.");
  if (env.DATABASE_TLS_CA_FILE && !path.posix.isAbsolute(env.DATABASE_TLS_CA_FILE))
    throw new Error("The deployment CA bundle must use an absolute mounted path.");
  if (env.UPLOAD_DIR !== "/var/lib/voltronix/uploads")
    throw new Error("Use the mounted private invoice-storage directory.");
  if (migration && env.ALLOW_PRODUCTION_MIGRATION !== "true")
    throw new Error("The separate migration invocation must be explicitly enabled.");
}

export function deploymentCommand(mode, args = []) {
  const shared = ["--conditions=react-server", "--import=tsx"];
  if (mode === "web" && !args.length)
    return ["node_modules/next/dist/bin/next", "start", "--experimental-next-config-strip-types", "--hostname", "0.0.0.0", "--port", "3000"];
  if (mode === "sync" && !args.length)
    return [...shared, "scripts/integration-worker.ts", "--watch", "--limit=5"];
  if (mode === "incoming" && !args.length)
    return [...shared, "scripts/incoming-sync-worker.ts", "--watch"];
  if (mode === "job-history" && !args.length)
    return [...shared, "scripts/job-history-worker.ts", "--watch"];
  if (mode === "ocr" && !args.length)
    return [...shared, "scripts/ocr-worker.ts"];
  if (mode === "check:manual" && !args.length)
    return [...shared, "scripts/check-manual-readiness.ts"];
  if ((mode === "check" || mode === "check:sync") && !args.length)
    return [...shared, "scripts/check-sync-readiness.ts"];
  const operators = {
    "user:create": "scripts/create-user.ts",
    "user:manage": "scripts/manage-user.ts",
    "backup:verify": "scripts/verify-restore.ts",
    "company:prepare-manual": "scripts/company-prepare-manual.ts",
    "company:prepare": "scripts/company-prepare.ts",
    "crm:prepare": "scripts/crm-prepare.ts",
    "books:authorize": "scripts/books-authorize.ts",
    "books:catalog": "scripts/books-catalog.ts",
    "books:suppliers": "scripts/books-suppliers.ts",
    "books:verify-live": "scripts/books-verify-live.ts",
    "books:activate": "scripts/books-activate.ts",
    "data:transfer": "scripts/zoho-data-transfer.ts",
  };
  if (mode === "operator" && Object.hasOwn(operators, args[0] ?? ""))
    return [...shared, operators[args[0]], ...args.slice(1)];
  if (mode === "migrate" && !args.length)
    return ["node_modules/prisma/build/index.js", "migrate", "deploy"];
  throw new Error("Use web, sync, incoming, job-history, ocr, check, check:sync, check:manual, migrate, or a supported operator command.");
}

/** Prisma's schema engine has its own TLS URL contract; keep this child-only. */
export function migrationEnvironment(env) {
  validateDeploymentEnvironment(env, { migration: true });
  const database = new URL(env.DATABASE_URL);
  database.searchParams.set("sslaccept", "strict");
  if (env.DATABASE_TLS_CA_FILE) {
    if (!path.isAbsolute(env.DATABASE_TLS_CA_FILE))
      throw new Error("The migration CA bundle must use an absolute mounted path.");
    database.searchParams.set("sslcert", env.DATABASE_TLS_CA_FILE);
  }
  return { ...env, DATABASE_URL: database.toString() };
}

async function main() {
  const [mode = "web", ...args] = process.argv.slice(2);
  const environmentFile = mode === "migrate" ? "/run/secrets/migration_env" : "/run/secrets/app_env";
  if (!existsSync(environmentFile)) throw new Error("Mount the private deployment environment file before startup.");
  process.loadEnvFile(environmentFile);
  validateDeploymentEnvironment(process.env, { migration: mode === "migrate" });
  const command = deploymentCommand(mode, args);
  const environment = mode === "migrate" ? migrationEnvironment(process.env) : process.env;
  const child = spawn(process.execPath, command, { stdio: "inherit", env: environment });
  let interrupted;
  const signals = ["SIGTERM", "SIGINT"];
  const handlers = signals.map((signal) => {
    const handler = () => { interrupted = signal; child.kill(signal); };
    process.on(signal, handler);
    return handler;
  });
  child.once("error", () => {
    console.error("The application process could not start. Inspect the deployment image and private configuration.");
    process.exitCode = 1;
  });
  child.once("exit", (code) => {
    signals.forEach((signal, index) => process.removeListener(signal, handlers[index]));
    process.exitCode = code ?? (interrupted === "SIGTERM" ? 143 : interrupted === "SIGINT" ? 130 : 1);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch(() => {
    console.error("Deployment startup rejected. Check the protected production environment and supported command; no configuration values were logged.");
    process.exitCode = 1;
  });
