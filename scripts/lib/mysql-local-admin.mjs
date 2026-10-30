import mysql from "mysql2/promise";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import { MYSQL_LOCAL } from "../mysql-local.mjs";

const privateRoot = path.join(MYSQL_LOCAL.root, ".local", "mysql-dev");
const dataDirectory = path.join(privateRoot, "data");
const safeError = (message) => new Error(message);

export function sqlIdentifier(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))
    throw safeError("Unsafe MySQL identifier refused.");
  return `\`${value}\``;
}

export function databaseGrantScope(database) {
  sqlIdentifier(database);
  // Database-level GRANT treats underscores as wildcards unless escaped.
  return `\`${database.replaceAll("_", "\\_")}\`.*`;
}

export function assertDisposableDatabase(name) {
  if (!/^bills_test_\d+_\d+$/.test(name))
    throw safeError(
      "Only a newly generated disposable billing test database is permitted.",
    );
  return name;
}

function validateLocalState() {
  if (MYSQL_LOCAL.root.toLowerCase() !== "g:\\bills.voltronix.ae")
    throw safeError(
      "Local MySQL controls are restricted to the billing workspace.",
    );
  for (const target of [
    privateRoot,
    dataDirectory,
    path.join(privateRoot, "instance.json"),
    path.join(privateRoot, "secrets.json"),
  ]) {
    if (
      !existsSync(target) ||
      lstatSync(target).isSymbolicLink() ||
      realpathSync(target).toLowerCase() !== target.toLowerCase()
    )
      throw safeError(
        "Recognized local MySQL private state is required; redirected paths are refused.",
      );
  }
  const manifest = JSON.parse(
    readFileSync(path.join(privateRoot, "instance.json"), "utf8"),
  );
  const settings = JSON.parse(
    readFileSync(path.join(privateRoot, "secrets.json"), "utf8"),
  );
  if (
    manifest.owner !== "voltronix-billing-development" ||
    manifest.state !== "ready" ||
    manifest.port !== 3308 ||
    manifest.database !== "voltronix_billing_dev" ||
    manifest.dataDirectory !== dataDirectory ||
    manifest.version !== "8.4.11" ||
    !/^[a-f0-9-]{36}$/.test(manifest.serverUuid) ||
    settings.host !== "127.0.0.1" ||
    settings.port !== 3308 ||
    settings.database !== "voltronix_billing_dev" ||
    settings.admin?.user !== "root" ||
    settings.application?.user !== "voltronix_billing_app" ||
    settings.migration?.user !== "voltronix_billing_migrate" ||
    ![settings.admin, settings.application, settings.migration].every((role) =>
      /^[a-f0-9]{64}$/.test(role.password),
    )
  )
    throw safeError("Local MySQL control metadata failed validation.");
  return { manifest, settings };
}

export function connectionUrl(settings, role, database = settings.database) {
  sqlIdentifier(database);
  const account = typeof role === "string" ? settings[role] : role;
  return `mysql://${encodeURIComponent(account.user)}:${encodeURIComponent(account.password)}@127.0.0.1:3308/${database}`;
}

export async function openLocalAdmin() {
  const { manifest, settings } = validateLocalState();
  const connection = await mysql.createConnection({
    host: "127.0.0.1",
    port: 3308,
    user: settings.admin.user,
    password: settings.admin.password,
    timezone: "Z",
    charset: "utf8mb4",
    connectTimeout: 5000,
    supportBigNumbers: true,
    bigNumberStrings: true,
    multipleStatements: false,
  });
  const context = { connection, manifest, settings };
  try {
    await verifyLocalServer(context);
  } catch {
    await connection.end();
    throw safeError(
      "Connected server is not the provisioned billing MySQL instance.",
    );
  }
  return context;
}

export async function verifyLocalServer({ connection, manifest }) {
  const [rows] = await connection.query(
    "SELECT VERSION() AS version, @@server_uuid AS uuid, @@datadir AS datadir, @@port AS port, @@bind_address AS bindAddress, @@global.time_zone AS timeZone",
  );
  const actual = rows[0];
  if (
    actual.version !== "8.4.11" ||
    actual.uuid !== manifest.serverUuid ||
    Number(actual.port) !== 3308 ||
    actual.bindAddress !== "127.0.0.1" ||
    actual.timeZone !== "+00:00" ||
    path.resolve(actual.datadir).toLowerCase() !== dataDirectory.toLowerCase()
  )
    throw safeError(
      "Connected server is not the provisioned billing MySQL instance.",
    );
}

async function runtimePrivilegeContext(context, database, user) {
  await verifyLocalServer(context);
  if (database !== "voltronix_billing_dev") assertDisposableDatabase(database);
  const expectedUser =
    database === "voltronix_billing_dev"
      ? "voltronix_billing_app"
      : database.replace(/^bills_test_/, "bt_app_");
  if (user !== expectedUser)
    throw safeError(
      "Runtime privilege checks require the exact matching billing application account.",
    );
  const { connection } = context;
  const [tables] = await connection.execute(
    "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE'",
    [database],
  );
  if (!tables.some((table) => table.name.toLowerCase() === "auditlog"))
    throw safeError(
      "The migrated billing audit table is required before granting runtime access.",
    );
  const account = `${connection.escape(user)}@'127.0.0.1'`;
  return { connection, tables, account };
}

export async function grantRuntimePrivileges(context, database, user) {
  const { connection, tables, account } = await runtimePrivilegeContext(
    context,
    database,
    user,
  );
  await connection.query(`REVOKE ALL PRIVILEGES, GRANT OPTION FROM ${account}`);
  for (const table of tables) {
    if (table.name === "_prisma_migrations") continue;
    const privileges =
      table.name.toLowerCase() === "auditlog"
        ? "SELECT, INSERT"
        : "SELECT, INSERT, UPDATE, DELETE";
    await connection.query(
      `GRANT ${privileges} ON ${sqlIdentifier(database)}.${sqlIdentifier(table.name)} TO ${account}`,
    );
  }
  return verifyRuntimePrivileges(context, database, user);
}

export async function verifyRuntimePrivileges(context, database, user) {
  const { connection, tables, account } = await runtimePrivilegeContext(
    context,
    database,
    user,
  );
  const [grants] = await connection.query(`SHOW GRANTS FOR ${account}`);
  const statements = grants.map((row) => Object.values(row)[0]);
  const expected = new Map(
    tables
      .filter((table) => table.name !== "_prisma_migrations")
      .map((table) => [
        table.name.toLowerCase(),
        table.name.toLowerCase() === "auditlog"
          ? "INSERT,SELECT"
          : "DELETE,INSERT,SELECT,UPDATE",
      ]),
  );
  const seen = new Set();
  let usageSeen = false;
  for (const statement of statements) {
    if (statement === `GRANT USAGE ON *.* TO \`${user}\`@\`127.0.0.1\``) {
      if (usageSeen)
        throw safeError("The billing runtime account has duplicate grants.");
      usageSeen = true;
      continue;
    }
    const match = statement.match(
      /^GRANT ([A-Z, ]+) ON `([A-Za-z0-9_]+)`\.`([A-Za-z0-9_]+)` TO `([A-Za-z0-9_]+)`@`127\.0\.0\.1`$/,
    );
    const table = match?.[3].toLowerCase();
    if (
      !match ||
      match[2] !== database ||
      match[4] !== user ||
      seen.has(table) ||
      !expected.has(table) ||
      match[1].split(", ").sort().join(",") !== expected.get(table)
    )
      throw safeError(
        "The billing runtime account has unexpected or excess privileges.",
      );
    seen.add(table);
  }
  if (!usageSeen || seen.size !== expected.size)
    throw safeError(
      "The billing runtime account is missing required restricted table privileges.",
    );
  return {
    applicationTables: expected.size,
    auditSelectInsertOnly: true,
    schemaDdlDenied: true,
    globalAdministrativePrivileges: false,
  };
}

function migrationExpectations() {
  const migrationRoot = path.join(
    MYSQL_LOCAL.root,
    "prisma",
    "mysql",
    "migrations",
  );
  const source = readdirSync(migrationRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) =>
      readFileSync(
        path.join(migrationRoot, entry.name, "migration.sql"),
        "utf8",
      ),
    )
    .join("\n");
  const checks = new Set();
  for (const event of source.matchAll(/CONSTRAINT\s+`([^`]+)`\s+CHECK|DROP\s+(?:CHECK|CONSTRAINT)\s+`([^`]+)`/g)) {
    if (event[1]) checks.add(event[1]);
    else checks.delete(event[2]);
  }
  return {
    tables: [...source.matchAll(/CREATE TABLE\s+`([^`]+)`/g)].map((match) =>
      match[1].toLowerCase(),
    ),
    checks: [...checks],
    foreignKeys: [
      ...source.matchAll(/CONSTRAINT\s+`([^`]+)`\s+FOREIGN KEY/g),
    ].map((match) => match[1]),
    uniqueIndexes: [
      ...source.matchAll(/(?:CREATE\s+)?UNIQUE INDEX\s+`([^`]+)`/g),
    ].map((match) => match[1]),
  };
}

export async function inspectMigratedSchema(context, database) {
  await verifyLocalServer(context);
  if (database !== "voltronix_billing_dev") assertDisposableDatabase(database);
  const { connection } = context;
  const expected = migrationExpectations();
  const [tables] = await connection.execute(
    "SELECT TABLE_NAME AS name, ENGINE AS engine, TABLE_COLLATION AS collation FROM information_schema.TABLES WHERE TABLE_SCHEMA=?",
    [database],
  );
  const [constraints] = await connection.execute(
    "SELECT CONSTRAINT_NAME AS name, CONSTRAINT_TYPE AS type, ENFORCED AS enforced FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=?",
    [database],
  );
  const [indexes] = await connection.execute(
    "SELECT DISTINCT TABLE_NAME AS tableName, INDEX_NAME AS name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND NON_UNIQUE=0",
    [database],
  );
  const [columns] = await connection.execute(
    "SELECT COUNT(*) AS count FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=?",
    [database],
  );
  const actualTableNames = new Set(
    tables.map((table) => table.name.toLowerCase()),
  );
  const checks = constraints.filter(
    (constraint) => constraint.type === "CHECK",
  );
  const foreignKeys = constraints.filter(
    (constraint) => constraint.type === "FOREIGN KEY",
  );
  if (
    expected.tables.some((name) => !actualTableNames.has(name)) ||
    tables.length !== expected.tables.length + 1 ||
    !actualTableNames.has("_prisma_migrations") ||
    tables.some(
      (table) =>
        table.engine !== "InnoDB" || !table.collation.startsWith("utf8mb4_"),
    ) ||
    expected.checks.some(
      (name) =>
        !checks.some(
          (constraint) =>
            constraint.name === name && constraint.enforced === "YES",
        ),
    ) ||
    expected.foreignKeys.some(
      (name) => !foreignKeys.some((constraint) => constraint.name === name),
    ) ||
    expected.uniqueIndexes.some(
      (name) => !indexes.some((index) => index.name === name),
    )
  )
    throw safeError(
      "Actual MySQL tables, constraints or indexes differ from the reviewed migrations.",
    );
  const [migrations] = await connection.query(
    `SELECT migration_name AS name, finished_at IS NOT NULL AS finished, rolled_back_at IS NULL AS active FROM ${sqlIdentifier(database)}._prisma_migrations`,
  );
  if (
    !migrations.length ||
    migrations.some((migration) => !migration.finished || !migration.active)
  )
    throw safeError(
      "MySQL migration history contains an incomplete migration.",
    );
  return {
    database,
    tables: tables.length,
    applicationTables: expected.tables.length,
    tableNames: [...actualTableNames].sort(),
    columns: Number(columns[0].count),
    enforcedChecks: checks.length,
    foreignKeys: foreignKeys.length,
    uniqueIndexesIncludingPrimary: indexes.length,
    engine: "InnoDB",
    characterSet: "utf8mb4",
    migrations: migrations.map((migration) => migration.name),
  };
}
