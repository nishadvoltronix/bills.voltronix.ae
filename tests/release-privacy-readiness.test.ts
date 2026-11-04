import { mkdtemp, mkdir, rmdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  configuredSecrets,
  configuredSecretFiles,
  inspectRelease,
} from "../scripts/check-release.mjs";

describe("release privacy credential coverage", () => {
  it("includes short provisioning, PostgreSQL and rotated credentials", () => {
    const secrets = configuredSecrets({
      NEW_USER_PASSWORD: "S8!x",
      PGPASSWORD: "PG9!",
      POSTGRES_PASSWORD: "Db3!",
      ZOHO_BOOKS_CLIENT_SECRET_PREVIOUS: "Old7!",
      ZOHO_CRM_REFRESH_TOKEN: "Tok4!",
      ACCOUNT_NEW_PASSWORD: "New2!",
      AZURE_DOCUMENT_INTELLIGENCE_KEY: "Azure6!",
      OPENAI_API_KEY: "OpenAI7!",
    });
    for (const value of [
      "S8!x",
      "PG9!",
      "Db3!",
      "Old7!",
      "Tok4!",
      "New2!",
      "Azure6!",
      "OpenAI7!",
    ])
      expect(secrets).toContain(value);
  });
  it("extracts passwords from all database URL variants without discarding encoded forms", () => {
    const secrets = configuredSecrets({
      RESTORE_DATABASE_URL:
        "postgresql://user:p%40ss%2Bword@127.0.0.1/bills_restore_fixture",
      TEST_DATABASE_URL:
        "postgresql://user@127.0.0.1/bills_test_fixture?password=Short9%21",
    });
    expect(secrets).toContain("p@ss+word");
    expect(secrets).toContain("p%40ss%2Bword");
    expect(secrets).toContain("Short9!");
  });
  it("extracts each scoped Books token, including escaped values and rejected duplicate entries", () => {
    const map = '{"100":"fictional-first-token","100":"fictional-duplicate-token","200":"fictional\\\"escaped\\\\token"}';
    const secrets = configuredSecrets({ ZOHO_BOOKS_REFRESH_TOKENS_JSON: map });
    expect(secrets).toContain(map);
    expect(secrets).toContain("fictional-first-token");
    expect(secrets).toContain("fictional-duplicate-token");
    expect(secrets).toContain('fictional"escaped\\token');
    expect(secrets).toContain('fictional\\"escaped\\\\token');
    expect(secrets).toContain("fictional%22escaped%5Ctoken");
    expect(secrets).not.toContain("100");
    expect(secrets).not.toContain("200");
  });
  it("ignores non-secret flags and includes JSON and URI escaped credentials", () => {
    const secrets = configuredSecrets({
      APP_ENV: "production",
      ALLOW_ACCOUNT_ADMINISTRATION: "true",
      APP_URL: "https://public.invalid",
      ACCOUNT_OPERATOR_PASSWORD: 'fictional"value\\with spaces',
    });
    expect(secrets).not.toContain("true");
    expect(secrets).not.toContain("production");
    expect(secrets).not.toContain("https://public.invalid");
    expect(secrets).toContain('fictional\\"value\\\\with spaces');
    expect(secrets).toContain("fictional%22value%5Cwith%20spaces");
  });
  it("detects an actual short secret and private trace without treating arbitrary fixtures as secrets", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "voltronix-privacy-fixture-"),
    );
    const server = path.join(root, "server");
    const bundle = path.join(server, "route.js");
    const trace = path.join(server, "route.js.nft.json");
    await mkdir(server);
    try {
      await writeFile(
        bundle,
        'const demo = "Fictional-test-only-password-46";',
      );
      await writeFile(
        trace,
        JSON.stringify({ files: ["../../node_modules/example/index.js"] }),
      );
      expect(await inspectRelease(root, { NEW_USER_PASSWORD: "S8!x" })).toEqual(
        { checked: 2, secretMatches: 0, privateReferences: 0 },
      );
      await writeFile(bundle, 'const leaked = "S8!x";');
      await writeFile(
        trace,
        JSON.stringify({
          files: ["../../.env", "../../.local/uploads/fixture.pdf"],
        }),
      );
      expect(await inspectRelease(root, { NEW_USER_PASSWORD: "S8!x" })).toEqual(
        { checked: 2, secretMatches: 1, privateReferences: 2 },
      );
      await writeFile(bundle, 'const leaked = "fictional-map-token-only";');
      expect(await inspectRelease(root, {
        ZOHO_BOOKS_REFRESH_TOKENS_JSON: '{"100":"fictional-map-token-only","200":"fictional-second-token"}',
      })).toEqual({ checked: 2, secretMatches: 1, privateReferences: 2 });
    } finally {
      // Remove only these known fixture files and empty directories, never recursively.
      await unlink(bundle).catch(() => undefined);
      await unlink(trace).catch(() => undefined);
      await rmdir(server);
      await rmdir(root);
    }
  });
  it("scans a file-backed OpenAI key and detects its trace path without exposing its contents", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "voltronix-file-key-fixture-"));
    const server = path.join(root, "server"), key = path.join(root, "provider-key.txt"), bundle = path.join(server, "route.js"), trace = path.join(server, "route.js.nft.json");
    const secret = 'fictional"key\\with spaces';
    await mkdir(server);
    try {
      await writeFile(key, `${secret}\n`, { mode: 0o600 });
      await writeFile(bundle, `const fixture=${JSON.stringify(secret)};`);
      await writeFile(trace, JSON.stringify({ files: [path.relative(server, key)] }));
      const environment = { OPENAI_API_KEY_FILE: key, OPENAI_INVOICE_MODEL: "fictional-model", BILL_AUTOFILL_ENABLED: "true" };
      const values = await configuredSecretFiles(environment);
      expect(values.secrets).toContain(secret);
      expect(values.secrets).toContain('fictional\\"key\\\\with spaces');
      expect(values.secrets).toContain("fictional%22key%5Cwith%20spaces");
      expect(values.secrets).not.toContain(key);
      expect(await inspectRelease(root, environment)).toEqual({ checked: 2, secretMatches: 1, privateReferences: 1 });
      await writeFile(bundle, "const fixture=true;");
      await writeFile(trace, JSON.stringify({ files: [key] }));
      expect(await inspectRelease(root, environment)).toEqual({ checked: 2, secretMatches: 0, privateReferences: 1 });
    } finally {
      for (const file of [bundle, trace, key]) await unlink(file).catch(() => undefined);
      await rmdir(server); await rmdir(root);
    }
  });
  it("fails closed on missing, empty, oversized or relative file-backed credential configuration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "voltronix-invalid-key-fixture-"));
    const key = path.join(root, "provider-key.txt");
    try {
      await expect(configuredSecretFiles({ OPENAI_API_KEY_FILE: key })).rejects.toThrow();
      await writeFile(key, "");
      await expect(configuredSecretFiles({ OPENAI_API_KEY_FILE: key })).rejects.toThrow();
      await writeFile(key, "x".repeat(65_537));
      await expect(configuredSecretFiles({ OPENAI_API_KEY_FILE: key })).rejects.toThrow();
      await expect(configuredSecretFiles({ OPENAI_API_KEY_FILE: "relative-key.txt" })).rejects.toThrow();
      expect(await configuredSecretFiles({ OPENAI_API_KEY_FILE: "", OPENAI_INVOICE_MODEL: "fictional-model" })).toEqual({ secrets: [], paths: [] });
    } finally { await unlink(key).catch(() => undefined); await rmdir(root); }
  });
});
