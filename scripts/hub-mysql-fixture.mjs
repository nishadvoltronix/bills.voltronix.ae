import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MYSQL_LOCAL } from "./mysql-local.mjs";
import {
  databaseGrantScope,
  openLocalAdmin,
  sqlIdentifier,
  verifyLocalServer,
} from "./lib/mysql-local-admin.mjs";

// Dedicated synthetic Hub acceptance fixture. Never reads Hub .env or an existing
// Hub schema, and never changes server-global configuration or runtime grants.
const hubRoot = "G:\\hub.voltronix.ae";
const fixtureContainer = path.join(
  MYSQL_LOCAL.root,
  ".local",
  "mysql-dev",
  "hub-fixtures",
);
const moduleAt = (relative) => pathToFileURL(path.join(hubRoot, relative)).href;
const { connectMysql } = await import(
  moduleAt("server/src/crm/db/mysql/driver.ts")
);
const {
  migrateMysqlApplicationSchema,
  assertMysqlMigrationsCurrent,
  mysqlMigrations,
} = await import(moduleAt("server/src/crm/db/mysql/migrations.ts"));
const { mysqlRuntimePrivileges, assertMysqlRuntimePrivileges } = await import(
  moduleAt("server/src/crm/db/mysql/runtime-privileges.ts")
);
const action = process.argv[2];
const fixtureId = action === "setup" ? randomUUID() : process.argv[3];
if (
  !["setup", "status"].includes(action) ||
  !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
    fixtureId ?? "",
  )
)
  throw new Error(
    "Use node --import=tsx scripts/hub-mysql-fixture.mjs setup|status <fixture-id>.",
  );
const hex = fixtureId.replaceAll("-", "");
const database = `crm_local_auth_${hex}`;
const fixtureRoot = path.join(fixtureContainer, fixtureId);
const receiptFile = path.join(fixtureRoot, "receipt.json");
let control;
let migrationConnection;
let runtimeConnection;
let receipt;
try {
  control = await openLocalAdmin();
  if (
    existsSync(fixtureContainer) &&
    (lstatSync(fixtureContainer).isSymbolicLink() ||
      realpathSync(fixtureContainer).toLowerCase() !==
        fixtureContainer.toLowerCase())
  )
    throw new Error("Redirected Hub fixture container refused.");
  if (action === "setup") {
    if (existsSync(fixtureRoot))
      throw new Error("Existing Hub fixture will not be overwritten.");
    mkdirSync(fixtureRoot, { recursive: true });
    // Every child inherits the owner-only ACL from billing's private MySQL root.
    const common = {
      provider: "mysql",
      environment: "test",
      host: "127.0.0.1",
      port: 3308,
      database,
    };
    const profiles = {
      runtime: {
        ...common,
        user: `hub_r_${hex.slice(0, 24)}`,
        password: randomBytes(32).toString("hex"),
      },
      migration: {
        ...common,
        user: `hub_m_${hex.slice(0, 24)}`,
        password: randomBytes(32).toString("hex"),
      },
    };
    receipt = {
      owner: "billing-hub-synthetic-acceptance",
      fixtureId,
      database,
      serverUuid: control.manifest.serverUuid,
      state: "preparing",
      createdAt: new Date().toISOString(),
      createdDatabase: false,
      createdUsers: [],
    };
    writeFileSync(
      path.join(fixtureRoot, "profiles.json"),
      `${JSON.stringify(profiles, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    const persist = () =>
      writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, {
        mode: 0o600,
      });
    await verifyLocalServer(control);
    await control.connection.query(
      `CREATE DATABASE ${sqlIdentifier(database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`,
    );
    receipt.createdDatabase = true;
    persist();
    for (const profile of Object.values(profiles)) {
      await control.connection.query(
        "CREATE USER ?@'127.0.0.1' IDENTIFIED BY ?",
        [profile.user, profile.password],
      );
      receipt.createdUsers.push(profile.user);
      persist();
    }
    await control.connection.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES, TRIGGER, CREATE VIEW, SHOW VIEW ON ${databaseGrantScope(database)} TO ?@'127.0.0.1'`,
      [profiles.migration.user],
    );
    // Native Hub migrations create immutable-audit triggers. On this binary-logged
    // development server, run reviewed DDL as the private administrator on a pinned
    // connection with logging disabled only for that connection. No SUPER/global
    // grant or global trust_function_creators change is given to another account.
    migrationConnection = await connectMysql({
      ...common,
      ...control.settings.admin,
    });
    const [identity] = await migrationConnection.query(
      "SELECT DATABASE() AS databaseName, @@server_uuid AS serverUuid",
    );
    if (
      identity[0].databaseName !== database ||
      identity[0].serverUuid !== control.manifest.serverUuid
    )
      throw new Error("Migration connection identity mismatch.");
    await migrationConnection.query("SET SESSION sql_log_bin=0");
    const applied = await migrateMysqlApplicationSchema(migrationConnection, {
      database,
      allowSchemaChanges: true,
    });
    await assertMysqlMigrationsCurrent(migrationConnection, database);
    for (const [table, privileges] of Object.entries(mysqlRuntimePrivileges)) {
      await control.connection.query(
        `GRANT ${privileges.join(", ")} ON ${sqlIdentifier(database)}.${sqlIdentifier(table)} TO ?@'127.0.0.1'`,
        [profiles.runtime.user],
      );
    }
    runtimeConnection = await connectMysql(profiles.runtime);
    await assertMysqlMigrationsCurrent(runtimeConnection, database);
    await assertMysqlRuntimePrivileges(runtimeConnection, database, 3308);
    writeFileSync(
      path.join(fixtureRoot, "acceptance.json"),
      `${JSON.stringify(
        {
          owner: "voltronix-billing-hub-acceptance",
          database,
          serverUuid: control.manifest.serverUuid,
          runtime: profiles.runtime,
          migration: profiles.migration,
        },
        null,
        2,
      )}\n`,
      { flag: "wx", mode: 0o600 },
    );
    const [tables] = await control.connection.execute(
      "SELECT TABLE_NAME AS name, ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME",
      [database],
    );
    const [triggers] = await control.connection.execute(
      "SELECT COUNT(*) AS count FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=?",
      [database],
    );
    receipt = {
      ...receipt,
      state: "ready",
      migrationsApplied: applied,
      migrations: mysqlMigrations.map(({ version, name }) => ({
        version,
        name,
      })),
      tables: tables.map((table) => table.name),
      tableCount: tables.length,
      triggerCount: Number(triggers[0].count),
      engine: "InnoDB",
      characterSet: "utf8mb4",
      exactNativeRuntimePrivilegesVerified: true,
      migrationUsedPrivateAdminSessionOnly: true,
      serverGlobalConfigurationChanged: false,
      applicationRootAccount: false,
      privateProfiles: path.join(fixtureRoot, "profiles.json"),
      completedAt: new Date().toISOString(),
    };
    persist();
  } else {
    if (!existsSync(receiptFile) || lstatSync(fixtureRoot).isSymbolicLink())
      throw new Error("Unknown Hub fixture refused.");
    receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
    if (
      receipt.owner !== "billing-hub-synthetic-acceptance" ||
      receipt.fixtureId !== fixtureId ||
      receipt.database !== database ||
      receipt.serverUuid !== control.manifest.serverUuid ||
      receipt.state !== "ready"
    )
      throw new Error("Unknown Hub fixture refused.");
    const profiles = JSON.parse(
      readFileSync(path.join(fixtureRoot, "profiles.json"), "utf8"),
    );
    if (
      profiles.runtime.database !== database ||
      profiles.runtime.host !== "127.0.0.1" ||
      profiles.runtime.port !== 3308 ||
      profiles.runtime.user !== `hub_r_${hex.slice(0, 24)}`
    )
      throw new Error("Hub runtime profile mismatch.");
    runtimeConnection = await connectMysql(profiles.runtime);
    await assertMysqlMigrationsCurrent(runtimeConnection, database);
    await assertMysqlRuntimePrivileges(runtimeConnection, database, 3308);
  }
  console.log(JSON.stringify(receipt, null, 2));
} catch (error) {
  const failure = {
    status: "FAILED_RETAINED_FOR_INSPECTION",
    fixtureId,
    database,
    stage: typeof error?.stage === "string" ? error.stage : undefined,
    driverCode: /^ER_[A-Z0-9_]+$/.test(error?.driverCode ?? "")
      ? error.driverCode
      : undefined,
  };
  if (existsSync(fixtureRoot))
    writeFileSync(
      path.join(fixtureRoot, "failure.json"),
      `${JSON.stringify(failure, null, 2)}\n`,
      { mode: 0o600 },
    );
  console.error(JSON.stringify(failure));
  process.exitCode = 1;
} finally {
  if (runtimeConnection) await runtimeConnection.end();
  if (migrationConnection) await migrationConnection.end();
  if (control) await control.connection.end();
}
