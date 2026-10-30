import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
    for (const operator of ["user:manage", "backup:verify", "company:prepare-manual"]) {
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
