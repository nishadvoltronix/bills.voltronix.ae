import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import { preProcessFile } from "typescript";
import { inspectProductionFiles, prepareProductionFiles } from "../deploy/prepare.mjs";
import {
  deploymentCommand,
  migrationEnvironment,
  validateDeploymentEnvironment,
} from "../deploy/entrypoint.mjs";

function production() {
  return {
    NODE_ENV: "production",
    APP_ENV: "production",
    APP_URL: "https://bills.voltronix.ae",
    INTEGRATION_TEST_MODE: "false",
    DATABASE_URL: "mysql://billing_runtime:private-value@db.example.invalid:3306/billing_operational",
    DATABASE_TLS_MODE: "verify-full",
    UPLOAD_DIR: "/var/lib/voltronix/uploads",
  };
}

describe("production deployment entrypoint", () => {
  it("includes every local dependency of the packaged worker and operator scripts in the Docker build context", () => {
    const root = process.cwd();
    const scripts = new Set(readFileSync("deploy/Dockerfile.dockerignore", "utf8")
      .split(/\r?\n/).filter(line => /^!scripts\/.*\.(?:ts|tsx|mjs|js)$/.test(line)).map(line => line.slice(1)));
    const pending = [...scripts];
    const visited = new Set<string>();
    while (pending.length) {
      const file = pending.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      const imports = preProcessFile(readFileSync(path.join(root, file), "utf8"), true, true).importedFiles;
      for (const { fileName } of imports) {
        if (!fileName.startsWith(".") && !fileName.startsWith("@/")) continue;
        const base = fileName.startsWith("@/") ? path.resolve(root, "src", fileName.slice(2))
          : path.resolve(root, path.dirname(file), fileName);
        const dependency = [base, ...[".ts", ".tsx", ".mjs", ".js", "/index.ts"].map(extension => base + extension)]
          .find(candidate => existsSync(candidate) && statSync(candidate).isFile());
        expect(dependency, `${file}: local import ${fileName} must resolve`).toBeDefined();
        const relative = path.relative(root, dependency!).replaceAll("\\", "/");
        expect(relative.startsWith("src/") || scripts.has(relative), `${file} needs ${relative} in the Docker context`).toBe(true);
        if (/\.(?:ts|tsx|mjs|js)$/.test(relative)) pending.push(relative);
      }
    }
  });

  it("loads the actual Next TypeScript config through Node without the TypeScript package", () => {
    const source = `
      import { registerHooks } from 'node:module';
      import path from 'node:path';
      registerHooks({resolve(specifier, context, nextResolve) {
        if (specifier === 'typescript' || /node_modules[/\\\\]typescript[/\\\\]/.test(specifier))
          throw new Error('The runtime TypeScript compiler must not be loaded.');
        return nextResolve(specifier, context);
      }});
      process.env.__NEXT_NODE_NATIVE_TS_LOADER_ENABLED = 'true';
      const { transpileConfig } = await import('./node_modules/next/dist/build/next-config-ts/transpile-config.js');
      const config = await transpileConfig({nextConfigPath:path.resolve('next.config.ts'),dir:process.cwd()});
      if (!process.features.typescript || process.env.__NEXT_NODE_NATIVE_TS_LOADER_ENABLED !== 'true' || config.poweredByHeader !== false)
        throw new Error('Native configuration loading failed.');
      console.log('Native config loaded without TypeScript.');
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
      cwd: process.cwd(), encoding: "utf8", windowsHide: true, timeout: 15000,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("Falling back");
    expect(result.stdout).toContain("Native config loaded without TypeScript.");
  });

  it("allows startup without enabling provider writes or demanding a fabricated grant", () => {
    expect(() => validateDeploymentEnvironment(production())).not.toThrow();
    expect(deploymentCommand("web")).not.toContain("migrate");
    expect(deploymentCommand("sync")).toContain("--watch");
    expect(deploymentCommand("incoming")).toContain("scripts/incoming-sync-worker.ts");
    expect(deploymentCommand("incoming")).toContain("--watch");
    expect(deploymentCommand("job-history")).toEqual(["--conditions=react-server", "--import=tsx", "scripts/job-history-worker.ts", "--watch"]);
  });

  it("defaults to Books readiness and retains explicit local-ledger preflight and recovery/setup commands", () => {
    const context = readFileSync("deploy/Dockerfile.dockerignore", "utf8");
    for (const operator of ["user:manage", "backup:verify", "company:prepare-manual", "crm:prepare"]) {
      const command = deploymentCommand("operator", [operator]);
      const script = command.find((part: string) => part.startsWith("scripts/"));
      expect(context.split(/\r?\n/)).toContain(`!${script}`);
      expect(() => readFileSync(script!, "utf8")).not.toThrow();
    }
    expect(deploymentCommand("check")).toContain("scripts/check-sync-readiness.ts");
    expect(deploymentCommand("check:manual")).toContain("scripts/check-manual-readiness.ts");
    expect(context.split(/\r?\n/)).toContain("!scripts/check-manual-readiness.ts");
    expect(context.split(/\r?\n/)).toContain("!scripts/incoming-sync-worker.ts");
    expect(context.split(/\r?\n/)).toContain("!scripts/job-history-worker.ts");
    expect(context.split(/\r?\n/)).toContain("!scripts/lib/books-attachment-state.ts");
    expect(deploymentCommand("check:sync")).toContain("scripts/check-sync-readiness.ts");
  });

  it("ships typed-entry synchronization without enabling unverified financial writes", () => {
    const template = readFileSync("deploy/production.env.example", "utf8");
    const values = Object.fromEntries(template.split(/\r?\n/).filter(line => line && !line.startsWith("#"))
      .map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    expect(values).toMatchObject({ MANUAL_ENTRY_ONLY: "false", INTEGRATION_NETWORK_ENABLED: "true",
      ZOHO_BOOKS_NETWORK_ENABLED: "true", ZOHO_CRM_NETWORK_ENABLED: "true", INCOMING_SYNC_ENABLED: "true",
      INCOMING_SYNC_INTERVAL_SECONDS: "60",
      ZOHO_BOOKS_WRITE_ENABLED: "false", ZOHO_BOOKS_LIVE_ENABLED: "false",
      ALLOW_PRODUCTION_ACCOUNTING_WRITES: "false", OCR_PROVIDER: "disabled", SCANNER_IMPORT_ENABLED: "false" });
    const compose = readFileSync("deploy/compose.yaml", "utf8");
    const sync = compose.split("  sync:\n")[1]?.split("  ocr:")[0]
      ?? compose.split("  sync:\r\n")[1]?.split("  ocr:")[0];
    expect(sync).toContain("command: [sync]");
    expect(sync).not.toContain("profiles:");
    expect(compose).toContain("profiles: [ocr]");
    expect(compose).toContain("command: [incoming]");
    expect(compose).toContain("command: [job-history]");
    const privateCa = readFileSync("deploy/compose.mysql-ca.yaml", "utf8");
    const incomingCa = privateCa.split(/  incoming:\r?\n/)[1]?.split(/\r?\n  \w/)[0];
    expect(incomingCa).toContain("source: mysql_ca");
    expect(incomingCa).toContain("target: mysql_ca");
    expect(privateCa.split(/  job-history:\r?\n/)[1]?.split(/\r?\n  \w/)[0]).toContain("source: mysql_ca");
  });

  it.each([
    { APP_ENV: "development" },
    { APP_URL: "http://127.0.0.1:3000" },
    { INTEGRATION_TEST_MODE: "true" },
    { DATABASE_TLS_MODE: "disabled" },
    { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
    { DATABASE_TLS_CA_FILE: "relative-private-ca.pem" },
    { DATABASE_URL: "mysql://billing_runtime:secret@127.0.0.1:3308/voltronix_billing_dev" },
    { DATABASE_URL: "mysql://root:secret@db.example.invalid/billing_operational" },
    { DATABASE_URL: "mysql://billing_migrator:secret@db.example.invalid/billing_operational" },
    { DATABASE_URL: "mysql://billing_runtime:secret@db.example.invalid/billing_operational?sslaccept=accept_invalid_certs" },
    { DATABASE_URL: "bad-secret-connection-value" },
    { SEED_ADMIN_PASSWORD: "private-seed-password" },
    { UPLOAD_DIR: "/app/public/uploads" },
  ])("rejects development, weak transport and exposed-storage settings without printing them", (override) => {
    let message = "";
    try { validateDeploymentEnvironment({ ...production(), ...override }); }
    catch (error) { message = String(error); }
    expect(message).toContain("Error:");
    for (const value of Object.values(override)) expect(message).not.toContain(value);
  });

  it("requires a separate explicit migration invocation and supplies strict TLS only to its child", () => {
    const env = {
      ...production(),
      DATABASE_URL: "mysql://billing_migrator:private-value@db.example.invalid:3306/billing_operational",
      DATABASE_TLS_CA_FILE: "/run/secrets/mysql_ca",
      ALLOW_PRODUCTION_MIGRATION: "false",
    };
    expect(() => migrationEnvironment(env)).toThrow("explicitly enabled");
    env.ALLOW_PRODUCTION_MIGRATION = "true";
    const result = migrationEnvironment(env);
    const url = new URL(result.DATABASE_URL);
    expect(url.searchParams.get("sslaccept")).toBe("strict");
    expect(url.searchParams.get("sslcert")).toBe("/run/secrets/mysql_ca");
    expect(env.DATABASE_URL).not.toContain("?");
    expect(() => migrationEnvironment({ ...env, DATABASE_TLS_CA_FILE: "relative-ca.pem" })).toThrow("absolute");
  });

  it("does not execute arbitrary startup programs or shell strings", () => {
    expect(() => deploymentCommand("sh", ["-c", "something"])).toThrow("supported");
    expect(() => deploymentCommand("web", ["; echo private"])).toThrow("supported");
    expect(() => deploymentCommand("operator", ["unknown"])).toThrow("supported");
    expect(deploymentCommand("operator", ["books:authorize", "--organization=100"]))
      .toEqual(["--conditions=react-server", "--import=tsx", "scripts/books-authorize.ts", "--organization=100"]);
  });
});

describe("private production configuration preparation", () => {
  function withDirectory(run: (directory: string) => void) {
    const directory = mkdtempSync(path.join(os.tmpdir(), "bills-deployment-test-"));
    try {
      for (const name of ["production.env.example", "migration.env.example"])
        writeFileSync(path.join(directory, name), readFileSync(path.join("deploy", name)));
      run(directory);
    } finally {
      if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("bills-deployment-test-"))
        throw new Error("Unexpected test directory.");
      rmSync(directory, { recursive: true, force: true });
    }
  }

  function supplyConfiguration(directory: string) {
    const runtime = { ...parseEnv(readFileSync(path.join(directory, ".env.production"), "utf8")),
      ...production(), ZOHO_BOOKS_DC: "US", ZOHO_BOOKS_CLIENT_ID: "private-client-id",
      ZOHO_BOOKS_CLIENT_SECRET: "private-client-secret", ZOHO_BOOKS_ORGANIZATIONS_JSON: JSON.stringify([
        { organizationId: "100", name: "Operating company" },
      ]), ZOHO_CRM_DC: "US", ZOHO_CRM_ORGANIZATION_ID: "200", ZOHO_CRM_CLIENT_ID: "private-crm-client-id",
      ZOHO_CRM_CLIENT_SECRET: "private-crm-secret", ZOHO_CRM_MAPPING_JSON: JSON.stringify({ verified: true }),
      INCOMING_SYNC_OPERATOR_EMAIL: "operator@example.invalid", INCOMING_SYNC_OPERATOR_PASSWORD: "private-operator-password",
    };
    const migration = { ...production(),
      DATABASE_URL: "mysql://billing_migrator:private-migration-value@db.example.invalid:3306/billing_operational",
      ALLOW_PRODUCTION_MIGRATION: "false",
    };
    const save = (name: string, values: Record<string, string>) => writeFileSync(path.join(directory, name),
      Object.entries(values).map(([key, value]) => `${key}='${value}'`).join("\n"));
    save(".env.production", runtime);
    save(".env.migration", migration);
    return { runtime, migration, save };
  }

  it("creates private fresh-install files and preserves an existing encryption key and all operator inputs", () => {
    withDirectory(directory => {
      expect(prepareProductionFiles(directory).map(file => file.status)).toEqual(["CREATED", "CREATED"]);
      const file = path.join(directory, ".env.production");
      const first = readFileSync(file, "utf8");
      expect(parseEnv(first).INTEGRATION_TOKEN_ENCRYPTION_KEY).toMatch(/^[a-f0-9]{64}$/);
      writeFileSync(file, `${first}\nACCOUNT_OPERATOR_PASSWORD=private-saved-input\n`);
      const preserved = readFileSync(file, "utf8");
      expect(prepareProductionFiles(directory).map(result => result.status)).toEqual(["PRESERVED", "PRESERVED"]);
      expect(readFileSync(file, "utf8")).toBe(preserved);
      const report = inspectProductionFiles(directory);
      expect(report.status).toBe("INPUT_REQUIRED");
      expect(report.missing).toContain("runtime.DATABASE_URL");
      expect(JSON.stringify(report)).not.toContain("private-saved-input");
      expect(report.databaseConnections).toBe(0);
      expect(report.providerRequests).toBe(0);
    });
  });

  it("distinguishes setup configuration from enabled posting without changing write or migration flags", () => {
    withDirectory(directory => {
      prepareProductionFiles(directory);
      const { runtime, save } = supplyConfiguration(directory);
      expect(inspectProductionFiles(directory)).toMatchObject({ status: "CONFIGURATION_PRESENT_UNVERIFIED", phase: "SETUP_WRITES_DISABLED" });
      expect(inspectProductionFiles(directory, { requirePosting: true }).invalid).toContain("runtime.BOOKS_POSTING_DISABLED");
      expect(parseEnv(readFileSync(path.join(directory, ".env.production"), "utf8")).ZOHO_BOOKS_WRITE_ENABLED).toBe("false");
      expect(parseEnv(readFileSync(path.join(directory, ".env.migration"), "utf8")).ALLOW_PRODUCTION_MIGRATION).toBe("false");
      save(".env.production", { ...runtime, ZOHO_BOOKS_WRITE_ENABLED: "true", ZOHO_BOOKS_LIVE_ENABLED: "true" });
      expect(inspectProductionFiles(directory, { requirePosting: true })).toMatchObject({
        status: "CONFIGURATION_PRESENT_UNVERIFIED", phase: "POSTING_CONFIGURED_UNVERIFIED", databaseConnections: 0, providerRequests: 0,
      });
    });
  });

  it("rejects mismatched database destinations and placeholder or malformed provider configuration without leaking values", () => {
    withDirectory(directory => {
      prepareProductionFiles(directory);
      const { runtime, migration, save } = supplyConfiguration(directory);
      save(".env.migration", { ...migration, DATABASE_URL: "mysql://billing_migrator:private-other-db@db.example.invalid/another_operational" });
      save(".env.production", { ...runtime, ZOHO_BOOKS_ORGANIZATIONS_JSON: "[]", ZOHO_CRM_MAPPING_JSON: "null",
        ZOHO_CRM_ENVIRONMENT: "sandbox", ZOHO_BOOKS_DC: "INVALID", ZOHO_BOOKS_REFRESH_TOKENS_JSON: "private-invalid-token" });
      const report = inspectProductionFiles(directory);
      expect(report.status).toBe("INPUT_REQUIRED");
      expect(report.invalid).toEqual(expect.arrayContaining(["DATABASE_IDENTITY_PAIR", "runtime.ZOHO_BOOKS_ORGANIZATIONS_JSON",
        "runtime.ZOHO_CRM_MAPPING_JSON", "runtime.ZOHO_CRM_ENVIRONMENT", "runtime.ZOHO_BOOKS_DC", "runtime.ZOHO_BOOKS_REFRESH_TOKENS_JSON"]));
      for (const secret of ["private-other-db", "private-client-secret", "private-operator-password", "private-invalid-token"])
        expect(JSON.stringify(report)).not.toContain(secret);
    });
  });

  it("selects only the required Compose overrides from the actual database and prepared CA receipt", () => {
    withDirectory(directory => {
      prepareProductionFiles(directory);
      const { runtime, migration, save } = supplyConfiguration(directory);
      const command = (extra = "") => `docker compose -f deploy/compose.yaml${extra} run --rm --no-deps web check:sync`;
      const caOverride = " -f deploy/compose.mysql-ca.yaml";
      expect(inspectProductionFiles(directory).nextCheck).toBe(command());
      const withCa = { DATABASE_TLS_CA_FILE: "/run/secrets/mysql_ca" };
      save(".env.production", { ...runtime, ...withCa });
      save(".env.migration", { ...migration, ...withCa });
      expect(inspectProductionFiles(directory).nextCheck).toBe(command(caOverride));

      mkdirSync(path.join(directory, ".private", "mysql"), { recursive: true });
      const ca = "fixture-public-ca", receiptFile = path.join(directory, ".private", "mysql", "prepared.json");
      const receipt = { version: 1, hostname: "mysql", database: "billing_operational",
        caSha256: createHash("sha256").update(ca).digest("hex") };
      writeFileSync(path.join(directory, ".private", "mysql-ca.pem"), ca);
      writeFileSync(receiptFile, JSON.stringify(receipt));
      // Leftover owned-database files must not change an external database hint.
      expect(inspectProductionFiles(directory).nextCheck).toBe(command(caOverride));
      save(".env.production", { ...runtime, ...withCa, DATABASE_URL: runtime.DATABASE_URL.replace("db.example.invalid", "mysql") });
      save(".env.migration", { ...migration, ...withCa, DATABASE_URL: migration.DATABASE_URL.replace("db.example.invalid", "mysql") });
      const report = inspectProductionFiles(directory);
      expect(report.nextCheck).toBe(command(`${caOverride} -f deploy/compose.mysql.yaml`));
      expect(report.databaseConnections).toBe(0);
      expect(report.providerRequests).toBe(0);
      expect(JSON.stringify(report)).not.toContain("private-value");
      writeFileSync(receiptFile, JSON.stringify({ ...receipt, caSha256: "0".repeat(64) }));
      expect(inspectProductionFiles(directory).nextCheck).toBe(command(caOverride));
      writeFileSync(receiptFile, JSON.stringify(receipt));
      save(".env.migration", { ...migration, ...withCa });
      expect(inspectProductionFiles(directory).nextCheck).toBe(command(caOverride));
    });
  });

  it("rejects duplicate Books organizations and conflicting scoped versus shared bootstrap tokens", () => {
    withDirectory(directory => {
      prepareProductionFiles(directory);
      const { runtime, save } = supplyConfiguration(directory);
      save(".env.production", { ...runtime,
        ZOHO_BOOKS_ORGANIZATIONS_JSON: JSON.stringify([{ organizationId: "100", name: "A" }, { organizationId: "100", name: "B" }]),
        ZOHO_BOOKS_REFRESH_TOKEN: "private-shared-token", ZOHO_BOOKS_REFRESH_TOKENS_JSON: JSON.stringify({ "100": "private-scoped-token" }),
      });
      expect(inspectProductionFiles(directory).invalid).toEqual(expect.arrayContaining([
        "runtime.ZOHO_BOOKS_ORGANIZATIONS_JSON", "runtime.BOOKS_REFRESH_TOKEN_CONFLICT",
      ]));
    });
  });
});
