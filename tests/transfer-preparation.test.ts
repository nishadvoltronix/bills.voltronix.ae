import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "dotenv";
import {
  prepareTransfer,
  updateTransferEnvironment,
} from "../deploy/prepare-transfer.mjs";
import { deploymentCommand } from "../deploy/entrypoint.mjs";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (
      path.dirname(path.resolve(directory)) !== path.resolve(tmpdir()) ||
      !path.basename(directory).startsWith("bills-transfer-")
    )
      throw new Error("Unexpected fixture cleanup target.");
    rmSync(directory, { recursive: true, force: true });
  }
});
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "bills-transfer-"));
  directories.push(directory);
  writeFileSync(
    path.join(directory, ".env.production"),
    [
      "APP_ENV=production",
      "NODE_ENV=production",
      "APP_URL=https://bills.voltronix.ae",
      "ALLOW_DEMO_SEED=false",
      "ZOHO_BOOKS_WRITE_ENABLED=false",
      "ZOHO_BOOKS_LIVE_ENABLED=false",
      "ALLOW_PRODUCTION_ACCOUNTING_WRITES=false",
      "INTEGRATION_NETWORK_ENABLED=true",
      "INCOMING_SYNC_ENABLED=true",
      "INCOMING_SYNC_INTERVAL_SECONDS=60",
      "INCOMING_SYNC_OPERATOR_EMAIL=",
      "INCOMING_SYNC_OPERATOR_PASSWORD=",
      "PRIVATE_UNRELATED=preserved",
      `INTEGRATION_TOKEN_ENCRYPTION_KEY=${"b".repeat(64)}`,
      "",
    ].join("\r\n"),
    { mode: 0o600 },
  );
  return directory;
}
describe("private transfer setup preparation", () => {
  it("creates fresh nonseed credentials and a separate offline setup environment without enabling writes", () => {
    const directory = fixture(),
      digest = "a".repeat(64);
    expect(
      prepareTransfer({ directory, manifestSha256: digest }),
    ).toMatchObject({
      prepared: true,
      databaseConnections: 0,
      providerRequests: 0,
    });
    const runtime = parse(
      readFileSync(path.join(directory, ".env.production")),
    );
    const setup = parse(readFileSync(path.join(directory, ".env.setup")));
    const accounting = parse(
      readFileSync(path.join(directory, ".env.accounting")),
    );
    expect(runtime).toMatchObject({
      PRIVATE_UNRELATED: "preserved",
      INTEGRATION_NETWORK_ENABLED: "true",
      INCOMING_SYNC_ENABLED: "true",
      INCOMING_SYNC_OPERATOR_EMAIL: "admin@voltronix.ae",
      INTEGRATION_TOKEN_ENCRYPTION_KEY: "b".repeat(64),
      ZOHO_BOOKS_WRITE_ENABLED: "false",
    });
    expect(runtime.INCOMING_SYNC_OPERATOR_PASSWORD).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
    expect(setup).toMatchObject({
      ACCOUNT_OPERATOR_EMAIL: runtime.INCOMING_SYNC_OPERATOR_EMAIL,
      ACCOUNT_OPERATOR_PASSWORD: runtime.INCOMING_SYNC_OPERATOR_PASSWORD,
      NEW_USER_PASSWORD: runtime.INCOMING_SYNC_OPERATOR_PASSWORD,
      ZOHO_DATA_TRANSFER_SHA256: digest,
      INCOMING_SYNC_ENABLED: "false",
      INTEGRATION_NETWORK_ENABLED: "false",
      ZOHO_BOOKS_NETWORK_ENABLED: "false",
      ZOHO_CRM_NETWORK_ENABLED: "false",
      ALLOW_ZOHO_DATA_RESTORE: "true",
    });
    expect(accounting).toMatchObject({
      ACCOUNT_OPERATOR_PASSWORD: runtime.INCOMING_SYNC_OPERATOR_PASSWORD,
      INTEGRATION_NETWORK_ENABLED: "true",
      ZOHO_BOOKS_NETWORK_ENABLED: "true",
      ZOHO_CRM_NETWORK_ENABLED: "false",
      INCOMING_SYNC_ENABLED: "false",
      ZOHO_BOOKS_WRITE_ENABLED: "false",
      ZOHO_BOOKS_LIVE_ENABLED: "false",
      ALLOW_PRODUCTION_ACCOUNTING_WRITES: "false",
      ALLOW_USER_PROVISIONING: "false",
      ALLOW_OPERATIONAL_COMPANY_SETUP: "false",
      ALLOW_CRM_OPERATIONAL_SOURCE_SETUP: "false",
      ALLOW_ZOHO_DATA_RESTORE: "false",
      ALLOW_ZOHO_DATA_EXPORT: "false",
      ALLOW_BOOKS_POSTING_ACTIVATION: "false",
    });
    expect(accounting.NEW_USER_PASSWORD).toBeUndefined();
    expect(accounting.ZOHO_DATA_TRANSFER_SHA256).toBeUndefined();
    const previous = readFileSync(path.join(directory, ".env.setup"), "utf8");
    prepareTransfer({ directory, manifestSha256: digest });
    expect(readFileSync(path.join(directory, ".env.setup"), "utf8")).toBe(
      previous,
    );
  });

  it("preserves enabled production posting while deriving independent offline and accounting environments from current mappings", () => {
    const directory = fixture(),
      runtimeFile = path.join(directory, ".env.production");
    const enabled =
      readFileSync(runtimeFile, "utf8")
        .replace(
          "ZOHO_BOOKS_WRITE_ENABLED=false",
          "ZOHO_BOOKS_WRITE_ENABLED=true",
        )
        .replace(
          "ZOHO_BOOKS_LIVE_ENABLED=false",
          "ZOHO_BOOKS_LIVE_ENABLED=true",
        ) +
      'ZOHO_BOOKS_ORGANIZATIONS_JSON=\'[{"organizationId":"123","name":"Reviewed company","mapping":{"lineSelectionRequired":true}}]\'\r\n';
    writeFileSync(runtimeFile, enabled, { mode: 0o600 });
    expect(
      prepareTransfer({ directory, manifestSha256: "a".repeat(64) }),
    ).toMatchObject({
      runtimeWriteFlagsEnabled: true,
      setupWritesEnabled: false,
      accountingWritesEnabled: false,
      accounting: ".env.accounting",
      databaseConnections: 0,
      providerRequests: 0,
    });
    const runtime = parse(readFileSync(runtimeFile));
    expect(runtime.ZOHO_BOOKS_WRITE_ENABLED).toBe("true");
    expect(runtime.ZOHO_BOOKS_LIVE_ENABLED).toBe("true");
    const unchanged = (text: string) =>
      text.replace(/^INCOMING_SYNC_OPERATOR_(?:EMAIL|PASSWORD)=[^\r\n]*/gm, "");
    expect(unchanged(readFileSync(runtimeFile, "utf8"))).toBe(
      unchanged(enabled),
    );
    for (const name of [".env.setup", ".env.accounting"]) {
      const derived = parse(readFileSync(path.join(directory, name)));
      expect(derived.ZOHO_BOOKS_WRITE_ENABLED).toBe("false");
      expect(derived.ZOHO_BOOKS_LIVE_ENABLED).toBe("false");
      expect(derived.ALLOW_PRODUCTION_ACCOUNTING_WRITES).toBe("false");
      expect(derived.INTEGRATION_TOKEN_ENCRYPTION_KEY).toBe(
        runtime.INTEGRATION_TOKEN_ENCRYPTION_KEY,
      );
      expect(derived.ZOHO_BOOKS_ORGANIZATIONS_JSON).toBe(
        runtime.ZOHO_BOOKS_ORGANIZATIONS_JSON,
      );
    }
    const current = readFileSync(runtimeFile, "utf8").replace(
      '"Reviewed company"',
      '"Current reviewed company"',
    );
    writeFileSync(runtimeFile, current);
    prepareTransfer({ directory, manifestSha256: "a".repeat(64) });
    expect(
      parse(readFileSync(path.join(directory, ".env.accounting")))
        .ZOHO_BOOKS_ORGANIZATIONS_JSON,
    ).toBe(parse(current).ZOHO_BOOKS_ORGANIZATIONS_JSON);
    expect(readFileSync(runtimeFile, "utf8")).toBe(current);
  });

  it.each([
    ["true", "false", "false"],
    ["false", "true", "false"],
    ["maybe", "maybe", "false"],
    ["true", "true", "true"],
  ])(
    "refuses inconsistent or legacy write flags (%s, %s, %s) before preparing credentials",
    (write, live, legacy) => {
      const directory = fixture(),
        filename = path.join(directory, ".env.production");
      const contents = readFileSync(filename, "utf8")
        .replace(
          "ZOHO_BOOKS_WRITE_ENABLED=false",
          `ZOHO_BOOKS_WRITE_ENABLED=${write}`,
        )
        .replace(
          "ZOHO_BOOKS_LIVE_ENABLED=false",
          `ZOHO_BOOKS_LIVE_ENABLED=${live}`,
        )
        .replace(
          "ALLOW_PRODUCTION_ACCOUNTING_WRITES=false",
          `ALLOW_PRODUCTION_ACCOUNTING_WRITES=${legacy}`,
        );
      writeFileSync(filename, contents);
      expect(() =>
        prepareTransfer({ directory, manifestSha256: "a".repeat(64) }),
      ).toThrow();
      expect(readFileSync(filename, "utf8")).toBe(contents);
      expect(existsSync(path.join(directory, ".env.accounting"))).toBe(false);
      expect(
        existsSync(path.join(directory, ".private/setup-operator.json")),
      ).toBe(false);
    },
  );

  it("disables inherited provisioning and operation gates in the accounting process", () => {
    const directory = fixture(),
      filename = path.join(directory, ".env.production");
    const denied = [
      "ALLOW_USER_PROVISIONING",
      "ALLOW_OPERATIONAL_COMPANY_SETUP",
      "ALLOW_CRM_OPERATIONAL_SOURCE_SETUP",
      "ALLOW_ZOHO_DATA_RESTORE",
      "ALLOW_ZOHO_DATA_EXPORT",
      "ALLOW_BOOKS_POSTING_ACTIVATION",
      "ALLOW_BOOKS_CATALOG_READ",
      "ALLOW_BOOKS_SUPPLIER_SETUP",
      "ALLOW_BOOKS_OPERATIONAL_VERIFICATION",
      "ALLOW_BOOKS_AUTHORIZATION",
    ];
    writeFileSync(
      filename,
      readFileSync(filename, "utf8") +
        denied.map((key) => `${key}=true`).join("\r\n") +
        "\r\n",
    );
    prepareTransfer({ directory, manifestSha256: "a".repeat(64) });
    const accounting = parse(
      readFileSync(path.join(directory, ".env.accounting")),
    );
    for (const key of denied) expect(accounting[key]).toBe("false");
  });

  it("rejects an unsafe accounting destination before writing runtime or setup files", () => {
    const directory = fixture(),
      target = path.join(directory, "unexpected-directory");
    mkdirSync(target);
    symlinkSync(
      target,
      path.join(directory, ".env.accounting"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const before = readFileSync(
      path.join(directory, ".env.production"),
      "utf8",
    );
    expect(() =>
      prepareTransfer({ directory, manifestSha256: "a".repeat(64) }),
    ).toThrow();
    expect(readFileSync(path.join(directory, ".env.production"), "utf8")).toBe(
      before,
    );
    expect(existsSync(path.join(directory, ".env.setup"))).toBe(false);
    expect(
      existsSync(path.join(directory, ".private/setup-operator.json")),
    ).toBe(false);
  });

  it("ships the explicit activation command while keeping the accounting override write-disabled", () => {
    expect(deploymentCommand("operator", ["books:activate"])).toEqual([
      "--conditions=react-server",
      "--import=tsx",
      "scripts/books-activate.ts",
    ]);
    expect(readFileSync("deploy/Dockerfile.dockerignore", "utf8")).toContain(
      "!scripts/books-activate.ts",
    );
    const compose = readFileSync("deploy/compose.accounting.yaml", "utf8");
    expect(compose).toContain("file: ./.env.accounting");
    for (const key of [
      "ZOHO_BOOKS_WRITE_ENABLED",
      "ZOHO_BOOKS_LIVE_ENABLED",
      "ALLOW_PRODUCTION_ACCOUNTING_WRITES",
      "INCOMING_SYNC_ENABLED",
      "ZOHO_CRM_NETWORK_ENABLED",
      "ALLOW_USER_PROVISIONING",
      "ALLOW_ZOHO_DATA_RESTORE",
    ])
      expect(compose).toContain(`${key}: "false"`);
    expect(compose).toContain('ZOHO_BOOKS_NETWORK_ENABLED: "true"');
  });

  it("preserves existing configuration when the requested operator conflicts", () => {
    const directory = fixture();
    prepareTransfer({ directory, manifestSha256: "a".repeat(64) });
    const before = readFileSync(
      path.join(directory, ".env.production"),
      "utf8",
    );
    expect(() =>
      prepareTransfer({
        directory,
        manifestSha256: "a".repeat(64),
        adminEmail: "someone@voltronix.ae",
      }),
    ).toThrow();
    expect(readFileSync(path.join(directory, ".env.production"), "utf8")).toBe(
      before,
    );
  });

  it("refuses altered stored operator credentials and malformed digests", () => {
    const directory = fixture();
    mkdirSync(path.join(directory, ".private"));
    writeFileSync(
      path.join(directory, ".private/setup-operator.json"),
      JSON.stringify({
        email: "admin@voltronix.ae",
        name: "Billing administrator",
        password: "short",
      }),
    );
    expect(() =>
      prepareTransfer({ directory, manifestSha256: "a".repeat(64) }),
    ).toThrow();
    expect(() =>
      prepareTransfer({ directory, manifestSha256: "../not-a-digest" }),
    ).toThrow();
    expect(() =>
      updateTransferEnvironment("A=one\nA=two\n", { A: "new" }),
    ).toThrow();
    expect(() =>
      updateTransferEnvironment("A=one\nexport A=two\n", { A: "new" }),
    ).toThrow();
    expect(() => updateTransferEnvironment(" A=two\n", { A: "new" })).toThrow();
  });
});
