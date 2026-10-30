import { spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  findOpenSsl,
  inspectOwnedMysql,
  prepareOwnedMysql,
} from "../deploy/prepare-mysql.mjs";

const require = createRequire(import.meta.url);
// js-yaml is already provided by the repository's ESLint dependency.
type ComposeDocument = {
  services: Record<
    string,
    {
      image: string;
      environment: Record<string, string>;
      volumes: string[];
      ports?: string[];
      secrets: { source: string; target: string }[];
    }
  >;
};
const { load } = require("js-yaml") as {
  load: (input: string) => ComposeDocument;
};
const temporary: string[] = [];
let fixture: string;
function temporaryDirectory() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "bills-owned-mysql-"));
  temporary.push(directory);
  return directory;
}
function environmentFiles(directory: string) {
  const common =
    "\r\nDATABASE_TLS_MODE=verify-full\r\nDATABASE_TLS_CA_FILE=\r\nINTEGRATION_TOKEN_ENCRYPTION_KEY=unchanged-private-key\r\nZOHO_BOOKS_CLIENT_SECRET=unchanged-private-client\r\nZOHO_BOOKS_WRITE_ENABLED=false\r\n";
  writeFileSync(
    path.join(directory, ".env.production"),
    `DATABASE_URL=mysql://billing_runtime:REPLACE_PRIVATELY@MYSQL_HOST:3306/billing_operational${common}`,
  );
  writeFileSync(
    path.join(directory, ".env.migration"),
    `DATABASE_URL=mysql://billing_migrator:REPLACE_PRIVATELY@MYSQL_HOST:3306/billing_operational${common}`,
  );
}
function cloneFixture() {
  const directory = temporaryDirectory();
  cpSync(path.join(fixture, ".private"), path.join(directory, ".private"), {
    recursive: true,
  });
  environmentFiles(directory);
  return directory;
}
function digests(directory: string) {
  return Object.fromEntries(
    readdirSync(directory)
      .sort()
      .map((name) => [
        name,
        createHash("sha256")
          .update(readFileSync(path.join(directory, name)))
          .digest("hex"),
      ]),
  );
}

beforeAll(() => {
  fixture = temporaryDirectory();
  environmentFiles(fixture);
  prepareOwnedMysql(fixture);
}, 30000);
afterAll(() => {
  for (const directory of temporary) {
    // Only these exact test-created directories may be recursively removed.
    expect(path.dirname(path.resolve(directory))).toBe(
      path.resolve(os.tmpdir()),
    );
    expect(path.basename(directory)).toMatch(/^bills-owned-mysql-/);
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("owned MySQL private preparation", () => {
  it("generates a verified private CA and mysql server certificate without database access", () => {
    const report = inspectOwnedMysql(fixture);
    expect(report.databaseConnections).toBe(0);
    expect(report.providerRequests).toBe(0);
    const privateDirectory = path.join(fixture, ".private", "mysql");
    const certificate = new X509Certificate(
      readFileSync(path.join(privateDirectory, "server-cert.pem")),
    );
    expect(certificate.subjectAltName).toBe("DNS:mysql");
    expect(certificate.checkHost("other-host")).toBeUndefined();
    const executable = findOpenSsl();
    const verification = spawnSync(
      executable,
      [
        "verify",
        "-purpose",
        "sslserver",
        "-verify_hostname",
        "mysql",
        "-CAfile",
        path.join(privateDirectory, "ca-cert.pem"),
        path.join(privateDirectory, "server-cert.pem"),
      ],
      { encoding: "utf8", windowsHide: true },
    );
    expect(verification.status).toBe(0);
    const expiry = spawnSync(
      executable,
      [
        "x509",
        "-checkend",
        "2592000",
        "-noout",
        "-in",
        path.join(privateDirectory, "server-cert.pem"),
      ],
      { windowsHide: true },
    );
    expect(expiry.status).toBe(0);
    const passwords = ["root", "runtime", "migrator"].map((role) =>
      readFileSync(
        path.join(privateDirectory, `${role}-password`),
        "utf8",
      ).trim(),
    );
    expect(new Set(passwords).size).toBe(3);
    for (const password of passwords) {
      expect(password).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(report)).not.toContain(password);
    }
    if (process.platform !== "win32") {
      expect(statSync(privateDirectory).mode & 0o077).toBe(0);
      expect(
        statSync(path.join(privateDirectory, "server-key.pem")).mode & 0o077,
      ).toBe(0);
    }
  });

  it("preserves keys and unrelated environment bytes while filling only dedicated database settings", () => {
    const directory = cloneFixture();
    const privateDirectory = path.join(directory, ".private", "mysql");
    const before = digests(privateDirectory);
    const environments = [".env.production", ".env.migration"];
    const original = environments.map((name) =>
      readFileSync(path.join(directory, name), "utf8"),
    );
    expect(
      prepareOwnedMysql(directory, { configureEnvironment: true }).files,
    ).toBe("PRESERVED");
    expect(digests(privateDirectory)).toEqual(before);
    for (const [index, name] of environments.entries()) {
      const actual = readFileSync(path.join(directory, name), "utf8");
      const strip = (text: string) =>
        text.replace(
          /^(DATABASE_URL|DATABASE_TLS_MODE|DATABASE_TLS_CA_FILE)=[^\r\n]*/gm,
          "",
        );
      expect(strip(actual)).toBe(strip(original[index]));
      const env = parseEnv(actual);
      const url = new URL(env.DATABASE_URL!);
      expect(url.hostname).toBe("mysql");
      expect(url.username).toBe(
        index === 0 ? "billing_runtime" : "billing_migrator",
      );
      expect(url.pathname).toBe("/billing_operational");
      expect(env.DATABASE_TLS_CA_FILE).toBe("/run/secrets/mysql_ca");
      expect(env.DATABASE_TLS_MODE).toBe("verify-full");
    }
    const configured = environments.map((name) =>
      readFileSync(path.join(directory, name), "utf8"),
    );
    prepareOwnedMysql(directory, { configureEnvironment: true });
    expect(
      environments.map((name) =>
        readFileSync(path.join(directory, name), "utf8"),
      ),
    ).toEqual(configured);
  });

  it("validates both environment files before changing either and refuses an existing database", () => {
    const directory = cloneFixture();
    const runtime = path.join(directory, ".env.production");
    const original = readFileSync(runtime, "utf8");
    const migration = path.join(directory, ".env.migration");
    const external = readFileSync(migration, "utf8").replace(
      "MYSQL_HOST",
      "existing.example.invalid",
    );
    writeFileSync(migration, external);
    expect(() =>
      prepareOwnedMysql(directory, { configureEnvironment: true }),
    ).toThrow(/existing database URL/);
    expect(readFileSync(runtime, "utf8")).toBe(original);
    expect(readFileSync(migration, "utf8")).toBe(external);
  });

  it("refuses duplicate assignments and does not replace private credentials", () => {
    const directory = cloneFixture();
    const runtime = path.join(directory, ".env.production");
    const original = `${readFileSync(runtime, "utf8")}DATABASE_TLS_MODE=disabled\r\n`;
    writeFileSync(runtime, original);
    const before = digests(path.join(directory, ".private", "mysql"));
    expect(() =>
      prepareOwnedMysql(directory, { configureEnvironment: true }),
    ).toThrow(/exactly once/);
    expect(readFileSync(runtime, "utf8")).toBe(original);
    expect(digests(path.join(directory, ".private", "mysql"))).toEqual(before);
  });

  it("refuses a changed private credential instead of rotating or repairing it silently", () => {
    const directory = cloneFixture();
    const credential = path.join(
      directory,
      ".private",
      "mysql",
      "runtime-password",
    );
    writeFileSync(credential, `${"a".repeat(64)}\n`);
    const before = digests(path.dirname(credential));
    expect(() => prepareOwnedMysql(directory)).toThrow(
      /credentials and initialization script disagree/,
    );
    expect(digests(path.dirname(credential))).toEqual(before);
  });

  it("refuses an unrelated existing CA and redirected private directories", () => {
    const directory = temporaryDirectory();
    mkdirSync(path.join(directory, ".private"));
    const ca = path.join(directory, ".private", "mysql-ca.pem");
    writeFileSync(ca, "preserved-existing-provider-ca");
    expect(() => prepareOwnedMysql(directory)).toThrow(
      /existing CA was preserved/,
    );
    expect(readFileSync(ca, "utf8")).toBe("preserved-existing-provider-ca");
    expect(existsSync(path.join(directory, ".private", "mysql"))).toBe(false);
    const redirected = temporaryDirectory();
    symlinkSync(
      path.join(fixture, ".private"),
      path.join(redirected, ".private"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(() => prepareOwnedMysql(redirected)).toThrow(
      /Redirected private directories/,
    );
  });

  it("refuses concurrent preparation without removing another process's lock", () => {
    const directory = cloneFixture();
    const lock = path.join(directory, ".private", "mysql-prepare.lock");
    writeFileSync(lock, "another-operation");
    expect(() => prepareOwnedMysql(directory)).toThrow();
    expect(readFileSync(lock, "utf8")).toBe("another-operation");
  });
});

describe("owned MySQL container contract", () => {
  it("isolates database root secrets from apps, persists data and requires verified TLS", () => {
    const owned = load(readFileSync("deploy/compose.mysql.yaml", "utf8"));
    const base = load(readFileSync("deploy/compose.yaml", "utf8"));
    const ca = load(readFileSync("deploy/compose.mysql-ca.yaml", "utf8"));
    const mysql = owned.services.mysql;
    expect(mysql.image).toContain("mysql:8.4");
    expect(mysql.ports).toBeUndefined();
    expect(mysql.volumes).toContain("mysql_data:/var/lib/mysql");
    expect(mysql.environment.MYSQL_ROOT_PASSWORD_FILE).toBe(
      "/run/bills-mysql/root-password",
    );
    expect(mysql.environment.MYSQL_USER).toBeUndefined();
    expect(mysql.environment.MYSQL_ROOT_HOST).toBe("localhost");
    for (const service of [
      "web",
      "sync",
      "incoming",
      "job-history",
      "ocr",
      "migrate",
    ]) {
      expect(
        base.services[service].secrets.every(
          (secret: { source: string }) =>
            !secret.source.startsWith("mysql_root") &&
            secret.source !== "mysql_bootstrap",
        ),
      ).toBe(true);
      expect(ca.services[service].secrets).toContainEqual({
        source: "mysql_ca",
        target: "mysql_ca",
      });
      expect(owned.services[service]?.secrets).toBeUndefined();
    }
    const config = readFileSync("deploy/mysql/my.cnf", "utf8");
    expect(config).toMatch(/^lower_case_table_names=1$/m);
    expect(config).toMatch(/^require_secure_transport=ON$/m);
    expect(config).toMatch(/^ssl_key=\/run\/bills-mysql\/server-key.pem$/m);
    const wrapper = readFileSync("deploy/mysql/start.sh", "utf8");
    for (const file of ["start.sh", "healthcheck.sh", "grant-runtime.sh"]) {
      expect(readFileSync(`deploy/mysql/${file}`, "utf8")).not.toContain("\r");
    }
    expect(wrapper).toContain("chown mysql:mysql");
    expect(wrapper).toContain("chmod 0600");
    expect(wrapper).toContain('exec /usr/local/bin/docker-entrypoint.sh "$@"');
    expect(readFileSync("deploy/mysql/healthcheck.sh", "utf8")).toContain(
      "@@skip_networking=0",
    );
  });

  it("grants exactly the Prisma tables, protects AuditLog and keeps migration metadata away from the runtime", () => {
    const models = [
      ...readFileSync("prisma/mysql/schema.prisma", "utf8").matchAll(
        /^model (\w+) \{/gm,
      ),
    ]
      .map((match) => match[1])
      .sort();
    const sql = readFileSync("deploy/mysql/grant-runtime.sql", "utf8");
    const grants = [
      ...sql.matchAll(
        /^GRANT ([A-Z, ]+) ON `billing_operational`.`(\w+)` TO 'billing_runtime'@'%';$/gm,
      ),
    ];
    expect(grants.map((match) => match[2]).sort()).toEqual(models);
    for (const match of grants)
      expect(match[1]).toBe(
        match[2] === "AuditLog"
          ? "SELECT, INSERT"
          : "SELECT, INSERT, UPDATE, DELETE",
      );
    expect(sql).not.toContain("_prisma_migrations");
    expect(sql).not.toMatch(/GRANT ALL|WITH GRANT OPTION|ON\s+[^\n]*\.\*/);
    const bootstrap = readFileSync(
      path.join(fixture, ".private", "mysql", "bootstrap.sql"),
      "utf8",
    );
    expect(bootstrap.match(/REQUIRE SSL/g)).toHaveLength(2);
    expect(bootstrap).toContain(
      "ON `billing\\_operational`.* TO 'billing_migrator'",
    );
    expect(bootstrap).not.toMatch(/GRANT[^;]+TO 'billing_runtime'/);
    expect(readFileSync("deploy/mysql/grant-runtime.sh", "utf8")).toContain(
      `COUNT(*)=${models.length + 1}`,
    );
    expect(readFileSync("deploy/mysql/grant-runtime.sh", "utf8")).toContain(
      `)=${4 * (models.length - 1) + 2}`,
    );
    expect(readFileSync("deploy/mysql/grant-runtime.sh", "utf8")).toContain(
      "FROM mysql.role_edges WHERE TO_USER='billing_runtime'",
    );
  });
});
