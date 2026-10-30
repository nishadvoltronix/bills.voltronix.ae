import { mkdtemp, mkdir, rmdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  configuredSecrets,
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
    });
    for (const value of [
      "S8!x",
      "PG9!",
      "Db3!",
      "Old7!",
      "Tok4!",
      "New2!",
      "Azure6!",
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
});
