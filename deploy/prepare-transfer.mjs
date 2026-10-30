import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";

function fail() {
  throw new Error(
    "Private transfer setup rejected. Review the existing prepared production configuration and operator files.",
  );
}
const samePath = (a, b) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
function privateFile(filename) {
  if (
    lstatSync(filename).isSymbolicLink() ||
    !lstatSync(filename).isFile() ||
    !samePath(path.resolve(realpathSync(filename)), path.resolve(filename)) ||
    (process.platform !== "win32" && (lstatSync(filename).mode & 0o037) !== 0)
  )
    fail();
  return readFileSync(filename, "utf8");
}
function protectedWrite(filename, contents) {
  if (existsSync(filename)) privateFile(filename);
  else writeFileSync(filename, "", { flag: "wx", mode: 0o600 });
  if (process.platform === "win32") {
    // Protect the empty/new file before it receives any password or provider token.
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; " +
          "& icacls.exe $env:BILLS_SETUP_PRIVATE_FILE /inheritance:r /grant:r ('*'+$sid+':F') '*S-1-5-18:F' | Out-Null; " +
          "if($LASTEXITCODE -ne 0){throw 'PRIVATE_ACL_REQUIRED'}; " +
          "foreach($r in (Get-Acl -LiteralPath $env:BILLS_SETUP_PRIVATE_FILE).Access){" +
          "if($r.AccessControlType -eq 'Allow' -and @($sid,'S-1-5-18') -notcontains $r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value){throw 'PRIVATE_ACL_REQUIRED'}}",
      ],
      {
        windowsHide: true,
        env: { ...process.env, BILLS_SETUP_PRIVATE_FILE: filename },
        stdio: "pipe",
        timeout: 15000,
      },
    );
  } else chmodSync(filename, 0o600);
  writeFileSync(filename, contents, { mode: 0o600 });
}
export function updateTransferEnvironment(contents, values) {
  let result = contents;
  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  for (const [key, value] of Object.entries(values)) {
    if (
      !/^[A-Z][A-Z0-9_]*$/.test(key) ||
      typeof value !== "string" ||
      /['\r\n\0]/.test(value)
    )
      fail();
    const expression = new RegExp(`^${key}=.*$`, "gm"),
      matches = result.match(expression) ?? [];
    const assignments =
      result.match(
        new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=`, "gm"),
      ) ?? [];
    if (matches.length > 1 || assignments.length !== matches.length) fail();
    const line = `${key}='${value}'`;
    result = matches.length
      ? result.replace(
          expression,
          () => `${line}${matches[0].endsWith("\r") ? "\r" : ""}`,
        )
      : `${result}${result.endsWith("\n") ? "" : newline}${line}${newline}`;
  }
  const before = parseEnv(contents),
    after = parseEnv(result);
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (after[key] !== (Object.hasOwn(values, key) ? values[key] : before[key]))
      fail();
  }
  return result;
}

/** Prepares one-shot setup credentials only; it never connects to a database or provider. */
export function prepareTransfer({
  directory = path.resolve(import.meta.dirname),
  manifestSha256,
  adminEmail = "admin@voltronix.ae",
}) {
  if (
    !/^[a-f0-9]{64}$/.test(manifestSha256 ?? "") ||
    !/^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(adminEmail) ||
    /\.(test|invalid)$/i.test(adminEmail)
  )
    fail();
  directory = path.resolve(directory);
  if (
    !lstatSync(directory).isDirectory() ||
    lstatSync(directory).isSymbolicLink() ||
    !samePath(path.resolve(realpathSync(directory)), directory)
  )
    fail();
  const runtimeFile = path.join(directory, ".env.production");
  const before = privateFile(runtimeFile),
    env = parseEnv(before);
  if (
    env.APP_ENV !== "production" ||
    env.NODE_ENV !== "production" ||
    env.APP_URL !== "https://bills.voltronix.ae" ||
    !["false", "true"].includes(env.ZOHO_BOOKS_WRITE_ENABLED) ||
    env.ZOHO_BOOKS_LIVE_ENABLED !== env.ZOHO_BOOKS_WRITE_ENABLED ||
    env.ALLOW_PRODUCTION_ACCOUNTING_WRITES !== "false" ||
    env.SEED_ADMIN_EMAIL ||
    env.SEED_ADMIN_PASSWORD ||
    env.ALLOW_DEMO_SEED === "true"
  )
    fail();
  const setupFile = path.join(directory, ".env.setup"),
    accountingFile = path.join(directory, ".env.accounting");
  // Inspect both destinations before any credential/configuration mutation.
  // lstat catches dangling links that existsSync intentionally does not follow.
  for (const filename of [setupFile, accountingFile]) {
    try {
      lstatSync(filename);
      privateFile(filename);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const privateRoot = path.join(directory, ".private");
  if (!existsSync(privateRoot)) mkdirSync(privateRoot, { mode: 0o700 });
  if (
    lstatSync(privateRoot).isSymbolicLink() ||
    !lstatSync(privateRoot).isDirectory() ||
    !samePath(path.resolve(realpathSync(privateRoot)), privateRoot)
  )
    fail();
  const operatorFile = path.join(privateRoot, "setup-operator.json");
  let operator;
  if (existsSync(operatorFile))
    operator = JSON.parse(privateFile(operatorFile));
  else {
    operator = {
      email: adminEmail.toLowerCase(),
      name: "Billing administrator",
      password: randomBytes(32).toString("base64url"),
    };
    protectedWrite(operatorFile, JSON.stringify(operator) + "\n");
  }
  if (
    operator.email !== adminEmail.toLowerCase() ||
    operator.name !== "Billing administrator" ||
    !/^[A-Za-z0-9_-]{43}$/.test(operator.password)
  )
    fail();
  if (
    (env.INCOMING_SYNC_OPERATOR_EMAIL &&
      env.INCOMING_SYNC_OPERATOR_EMAIL !== operator.email) ||
    (env.INCOMING_SYNC_OPERATOR_PASSWORD &&
      env.INCOMING_SYNC_OPERATOR_PASSWORD !== operator.password)
  )
    fail();
  const runtime = updateTransferEnvironment(before, {
    INCOMING_SYNC_OPERATOR_EMAIL: operator.email,
    INCOMING_SYNC_OPERATOR_PASSWORD: operator.password,
  });
  const setup = updateTransferEnvironment(runtime, {
    ALLOW_USER_PROVISIONING: "true",
    NEW_USER_EMAIL: operator.email,
    NEW_USER_NAME: operator.name,
    NEW_USER_PASSWORD: operator.password,
    NEW_USER_ROLE: "ADMIN",
    ACCOUNT_OPERATOR_EMAIL: operator.email,
    ACCOUNT_OPERATOR_PASSWORD: operator.password,
    ALLOW_OPERATIONAL_COMPANY_SETUP: "true",
    ALLOW_CRM_OPERATIONAL_SOURCE_SETUP: "true",
    ALLOW_ZOHO_DATA_RESTORE: "true",
    ZOHO_BOOKS_WRITE_ENABLED: "false",
    ZOHO_BOOKS_LIVE_ENABLED: "false",
    ALLOW_PRODUCTION_ACCOUNTING_WRITES: "false",
    INTEGRATION_NETWORK_ENABLED: "false",
    ZOHO_BOOKS_NETWORK_ENABLED: "false",
    ZOHO_CRM_NETWORK_ENABLED: "false",
    INCOMING_SYNC_ENABLED: "false",
    ZOHO_DATA_TRANSFER_DIR: "/run/zoho-transfer",
    ZOHO_DATA_TRANSFER_SHA256: manifestSha256,
    ZOHO_DATA_TRANSFER_REFERENCE: `source-cache-transfer-${manifestSha256.slice(0, 20)}`,
  });
  // Always derive current client/mapping/key values from the runtime, never
  // from a previous offline snapshot. Only explicit one-shot Books reads run here.
  const accounting = updateTransferEnvironment(runtime, {
    ACCOUNT_OPERATOR_EMAIL: operator.email,
    ACCOUNT_OPERATOR_PASSWORD: operator.password,
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
    ALLOW_BOOKS_CATALOG_READ: "false",
    ALLOW_BOOKS_SUPPLIER_SETUP: "false",
    ALLOW_BOOKS_OPERATIONAL_VERIFICATION: "false",
    ALLOW_BOOKS_AUTHORIZATION: "false",
  });
  // A changed source environment is never silently replaced by a stale snapshot.
  if (privateFile(runtimeFile) !== before) fail();
  if (before !== runtime) writeFileSync(runtimeFile, runtime, { mode: 0o600 });
  protectedWrite(setupFile, setup);
  protectedWrite(accountingFile, accounting);
  return {
    prepared: true,
    runtime: ".env.production",
    setup: ".env.setup",
    accounting: ".env.accounting",
    operator: ".private/setup-operator.json",
    manifestSha256,
    providerRequests: 0,
    databaseConnections: 0,
    runtimeWriteFlagsEnabled: env.ZOHO_BOOKS_WRITE_ENABLED === "true",
    setupWritesEnabled: false,
    accountingWritesEnabled: false,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1 || !/^--manifest-sha256=[a-f0-9]{64}$/.test(args[0]))
      fail();
    console.log(
      JSON.stringify(
        prepareTransfer({
          manifestSha256: args[0].slice("--manifest-sha256=".length),
        }),
        null,
        2,
      ),
    );
  } catch {
    console.error(
      "Private transfer setup failed. Supply the verified manifest digest and review protected configuration; no credentials were printed.",
    );
    process.exitCode = 1;
  }
}
