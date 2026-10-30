import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { PrismaClient } from "@prisma/client";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { mysqlConnectionOptions } from "@/lib/mysql-connection";
import { mysqlTransportOptions } from "@/lib/mysql-transport";
import { localTestDatabaseUrl } from "../../scripts/lib/local-test-database.mjs";
import { isolatedProviderEnvironment } from "../../scripts/lib/test-provider-environment.mjs";
import { assertDisposableDatabase, connectionUrl, databaseGrantScope, grantRuntimePrivileges,
  inspectMigratedSchema, openLocalAdmin, sqlIdentifier, verifyLocalServer } from "../../scripts/lib/mysql-local-admin.mjs";

/** A fresh, restricted local database; never clones or edits the existing billing database. No Vitest dependency. */
export async function freshTransferDatabase() {
  localTestDatabaseUrl(process.env.DATABASE_URL);
  const context = await openLocalAdmin();
  const tag = `${process.pid}_${Date.now()}`;
  const databaseName = assertDisposableDatabase(`bills_test_${tag}`);
  const runtime = { user: `bt_app_${tag}`, password: randomBytes(32).toString("hex") };
  const migrator = { user: `bt_mig_${tag}`, password: randomBytes(32).toString("hex") };
  const createdUsers: string[] = [];
  let created = false, closed = false;
  let store: PrismaClient | undefined;
  const cleanup = async () => {
    if (closed) return;
    try {
      await store?.$disconnect();
      await verifyLocalServer(context);
      if (created) await context.connection.query(`DROP DATABASE ${sqlIdentifier(assertDisposableDatabase(databaseName))}`);
      for (const user of createdUsers) {
        if (user !== runtime.user && user !== migrator.user) throw new Error("Unexpected disposable account identity.");
        await context.connection.query("DROP USER ?@'127.0.0.1'", [user]);
      }
    } finally {
      closed = true;
      await context.connection.end();
    }
  };
  try {
    await verifyLocalServer(context);
    await context.connection.query(`CREATE DATABASE ${sqlIdentifier(databaseName)} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`);
    created = true;
    for (const account of [runtime, migrator]) {
      await context.connection.query("CREATE USER ?@'127.0.0.1' IDENTIFIED BY ?", [account.user, account.password]);
      createdUsers.push(account.user);
    }
    await context.connection.query(`GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES, TRIGGER, CREATE VIEW, SHOW VIEW ON ${databaseGrantScope(databaseName)} TO ?@'127.0.0.1'`, [migrator.user]);
    const migration = spawnSync(process.execPath, [createRequire(import.meta.url).resolve("prisma/build/index.js"), "migrate", "deploy"], {
      cwd: process.cwd(), windowsHide: true, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
      env: { ...isolatedProviderEnvironment(process.env), APP_ENV: "test", NODE_ENV: "test", DATABASE_TLS_MODE: "disabled", DATABASE_TLS_CA_FILE: "",
        DATABASE_URL: connectionUrl(context.settings, migrator, databaseName) },
    });
    // Child output can contain URLs; retain only a fixed error in this reusable boundary.
    if (migration.status !== 0 || migration.error) throw new Error("Fresh transfer database migrations failed.");
    await inspectMigratedSchema(context, databaseName);
    await grantRuntimePrivileges(context, databaseName, runtime.user);
    const url = connectionUrl(context.settings, runtime, databaseName);
    localTestDatabaseUrl(url);
    const connection = mysqlConnectionOptions(url);
    store = new PrismaClient({ adapter: new PrismaMariaDb({ ...connection,
      ...mysqlTransportOptions(connection, { APP_ENV: "test", DATABASE_TLS_MODE: "disabled" }),
      timezone: "+00:00", initSql: "SET time_zone = '+00:00'", decimalAsNumber: false, bigIntAsNumber: false,
      connectionLimit: 5, connectTimeout: 10000 }), log: [] });
    const reset = async () => {
      if (closed || !created) throw new Error("Disposable database is no longer owned by this fixture.");
      await verifyLocalServer(context);
      const owned = sqlIdentifier(assertDisposableDatabase(databaseName));
      // Runtime audit records are immutable. Only this fixture owner may reset the
      // separately generated database; application privileges remain unchanged.
      for (const table of ["AuditLog", "IncomingSyncState", "BooksProjectAssociation", "BooksBillAttachment", "BooksBill", "BooksImportRun",
        "CrmJobSnapshot", "CrmImportRun", "Job", "Vendor", "UserCompanyMembership", "CompanyCrmSource", "CompanyIntegrationDestination", "Company", "User"])
        await context.connection.query(`DELETE FROM ${owned}.${sqlIdentifier(table)}`);
    };
    return { store, databaseName, url, cleanup, reset };
  } catch {
    await cleanup();
    throw new Error("Fresh disposable transfer database preparation failed.");
  }
}
