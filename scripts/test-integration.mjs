import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse } from "dotenv";
import { MYSQL_LOCAL } from "./mysql-local.mjs";
import { localTestDatabaseUrl } from "./lib/local-test-database.mjs";
import { isolatedProviderEnvironment } from "./lib/test-provider-environment.mjs";
import {
  assertDisposableDatabase,
  connectionUrl,
  databaseGrantScope,
  grantRuntimePrivileges,
  inspectMigratedSchema,
  openLocalAdmin,
  sqlIdentifier,
  verifyLocalServer,
} from "./lib/mysql-local-admin.mjs";

const require = createRequire(import.meta.url);
const options = process.argv.slice(2);
if (
  options.length > 1 ||
  options.some((option) => !["--infrastructure-only", "--ocr-restart-only", "--scanner-only"].includes(option))
)
  throw new Error(
    "Use node scripts/test-integration.mjs [--infrastructure-only|--ocr-restart-only|--scanner-only].",
  );
const tag = `${process.pid}_${Date.now()}`;
const databaseName = assertDisposableDatabase(`bills_test_${tag}`);
const runtime = {
  user: `bt_app_${tag}`,
  password: randomBytes(32).toString("hex"),
};
const migrator = {
  user: `bt_mig_${tag}`,
  password: randomBytes(32).toString("hex"),
};
const logDirectory = path.join(
  MYSQL_LOCAL.root,
  ".local",
  "mysql-dev",
  "test-runs",
  tag,
);
const receipt = {
  database: databaseName,
  serverVerified: false,
  migrationPassed: false,
  testsPassed: false,
  cleanupPassed: false,
};
let context;
let created = false;
const createdUsers = [];

function runChild(arguments_, environment, name) {
  const child = spawnSync(process.execPath, arguments_, {
    cwd: MYSQL_LOCAL.root,
    env: environment,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  let output = `${child.stdout || ""}${child.stderr || ""}`;
  for (const password of [
    runtime.password,
    migrator.password,
    ...["admin", "application", "migration"].map(
      (role) => context.settings[role].password,
    ),
  ])
    output = output.replaceAll(password, "[redacted]");
  output = output.replace(/mysql:\/\/[^@\s]+@/gi, "mysql://[redacted]@");
  writeFileSync(path.join(logDirectory, `${name}.log`), output, {
    mode: 0o600,
  });
  process.stdout.write(output);
  return child.status === 0 && !child.error;
}

try {
  const envPath = path.join(MYSQL_LOCAL.root, ".env");
  // Select only the existing URL. Never import application/provider secrets into fixtures.
  const configuredUrl =
    process.env.DATABASE_URL ??
    (existsSync(envPath)
      ? parse(readFileSync(envPath)).DATABASE_URL
      : undefined);
  localTestDatabaseUrl(configuredUrl);
  context = await openLocalAdmin();
  receipt.serverVerified = true;
  mkdirSync(logDirectory, { recursive: true });
  await verifyLocalServer(context);
  await context.connection.query(
    `CREATE DATABASE ${sqlIdentifier(databaseName)} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`,
  );
  created = true;
  for (const account of [runtime, migrator]) {
    await context.connection.query(
      "CREATE USER ?@'127.0.0.1' IDENTIFIED BY ?",
      [account.user, account.password],
    );
    createdUsers.push(account.user);
  }
  await context.connection.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES, TRIGGER, CREATE VIEW, SHOW VIEW ON ${databaseGrantScope(databaseName)} TO ?@'127.0.0.1'`,
    [migrator.user],
  );
  const environment = {
    ...isolatedProviderEnvironment(process.env),
    APP_ENV: "test",
    NODE_ENV: "test",
    APP_URL: "http://127.0.0.1:3000",
    UPLOAD_DIR: path.join(logDirectory, "uploads"),
    ALLOW_DEMO_SEED: "false",
    MYSQL_TEST_EXPECTED_DATABASE: databaseName,
    MYSQL_TEST_EXPECTED_SERVER_UUID: context.manifest.serverUuid,
  };
  const runtimeUrl = connectionUrl(context.settings, runtime, databaseName);
  localTestDatabaseUrl(runtimeUrl);
  const migrationPassed = runChild(
    [require.resolve("prisma/build/index.js"), "migrate", "deploy"],
    {
      ...environment,
      DATABASE_URL: connectionUrl(context.settings, migrator, databaseName),
    },
    "migrate",
  );
  receipt.migrationPassed = migrationPassed;
  if (!migrationPassed) throw new Error("Disposable MySQL migrations failed.");
  receipt.schema = await inspectMigratedSchema(context, databaseName);
  receipt.runtimePrivileges = await grantRuntimePrivileges(
    context,
    databaseName,
    runtime.user,
  );
  const testsPassed = runChild(
    options.includes("--scanner-only") ? [
      "--conditions=react-server", "--import=tsx", "scripts/verify-scanner-import.mjs",
    ] : options.includes("--ocr-restart-only") ? [
      "--conditions=react-server", "--import=tsx", "scripts/verify-ocr-restart.mjs",
    ] : [
      fileURLToPath(
        new URL("../node_modules/vitest/vitest.mjs", import.meta.url),
      ),
      "run",
      options.includes("--infrastructure-only")
        ? "tests/mysql.infrastructure.integration.test.ts"
        : ".integration.test.ts",
    ],
    { ...environment, DATABASE_URL: runtimeUrl, TEST_DATABASE_URL: runtimeUrl },
    "integration",
  );
  receipt.testsPassed = testsPassed;
  if (!testsPassed) process.exitCode = 1;
} catch {
  console.error(
    "Real MySQL integration run failed. Only generated local test resources were used; inspect the sanitized test logs after checking local MySQL configuration.",
  );
  process.exitCode = 1;
} finally {
  if (context) {
    try {
      // Recheck instance identity immediately before any cleanup mutation.
      await verifyLocalServer(context);
      if (created)
        await context.connection.query(
          `DROP DATABASE ${sqlIdentifier(assertDisposableDatabase(databaseName))}`,
        );
      for (const user of createdUsers) {
        if (user !== runtime.user && user !== migrator.user)
          throw new Error("Unexpected cleanup identity.");
        await context.connection.query("DROP USER ?@'127.0.0.1'", [user]);
      }
      receipt.cleanupPassed = true;
    } catch {
      console.error(
        "Disposable MySQL cleanup could not be verified; generated resource names are retained in the private receipt.",
      );
      process.exitCode = 1;
    } finally {
      await context.connection.end();
    }
  }
  if (existsSync(logDirectory))
    writeFileSync(
      path.join(logDirectory, "receipt.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
      { mode: 0o600 },
    );
  console.log(JSON.stringify(receipt, null, 2));
}
