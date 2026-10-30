import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { MYSQL_LOCAL } from "./mysql-local.mjs";
import {
  connectionUrl,
  grantRuntimePrivileges,
  inspectMigratedSchema,
  openLocalAdmin,
  verifyRuntimePrivileges,
} from "./lib/mysql-local-admin.mjs";
import { isolatedProviderEnvironment } from "./lib/test-provider-environment.mjs";

const require = createRequire(import.meta.url);
const arguments_ = process.argv.slice(2);
if (
  arguments_.some((argument) => argument !== "--verify-only") ||
  arguments_.length > 1
)
  throw new Error("Use node scripts/mysql-migrate.mjs [--verify-only].");
let context;
const verifyOnly = arguments_.includes("--verify-only");
try {
  context = await openLocalAdmin();
  if (!verifyOnly) {
    const migration = spawnSync(
      process.execPath,
      [require.resolve("prisma/build/index.js"), "migrate", "deploy"],
      {
        cwd: MYSQL_LOCAL.root,
        env: {
          ...isolatedProviderEnvironment(process.env),
          DATABASE_URL: connectionUrl(context.settings, "migration"),
          APP_ENV: "development",
        },
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    let output = `${migration.stdout || ""}${migration.stderr || ""}`;
    for (const role of ["admin", "application", "migration"])
      output = output.replaceAll(context.settings[role].password, "[redacted]");
    output = output.replace(/mysql:\/\/[^@\s]+@/gi, "mysql://[redacted]@");
    writeFileSync(
      path.join(
        MYSQL_LOCAL.root,
        ".local",
        "mysql-dev",
        "migration-command.log",
      ),
      output,
      { mode: 0o600 },
    );
    if (migration.status !== 0) throw new Error("Migration command failed.");
  }
  const schema = await inspectMigratedSchema(
    context,
    context.settings.database,
  );
  const runtimePrivileges = await (
    verifyOnly ? verifyRuntimePrivileges : grantRuntimePrivileges
  )(context, context.settings.database, context.settings.application.user);
  const receipt = {
    ...schema,
    runtimePrivileges,
    operation: verifyOnly ? "verify" : "migrate",
    runtimePrivilegesChanged: !verifyOnly,
    checkedAt: new Date().toISOString(),
    productionChanged: false,
  };
  writeFileSync(
    path.join(
      MYSQL_LOCAL.root,
      ".local",
      "mysql-dev",
      "migration-receipt.json",
    ),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(JSON.stringify(receipt, null, 2));
} catch {
  console.error(
    "Billing MySQL migration/verification failed. Review the private migration log and local server state; no credentials were printed.",
  );
  process.exitCode = 1;
} finally {
  if (context) await context.connection.end();
}
