import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Isolated development server only. Never reads .env or another application's data.
// MySQL initialization: https://dev.mysql.com/doc/refman/8.4/en/data-directory-initialization.html
// Password initialization: https://dev.mysql.com/doc/refman/8.4/en/resetting-permissions.html
export const MYSQL_LOCAL = Object.freeze({
  root: path.resolve(import.meta.dirname, ".."),
  binaryRoot:
    "G:\\hub.voltronix.ae\\.local-dev\\mysql-native-3306-20261020\\mysql-8.4.11-winx64",
  host: "127.0.0.1",
  port: 3308,
  database: "voltronix_billing_dev",
  applicationUser: "voltronix_billing_app",
  migrationUser: "voltronix_billing_migrate",
});
const privateRoot = path.join(MYSQL_LOCAL.root, ".local", "mysql-dev");
const dataDirectory = path.join(privateRoot, "data");
const manifestFile = path.join(privateRoot, "instance.json");
const secretsFile = path.join(privateRoot, "secrets.json");
const serverConfig = path.join(privateRoot, "server.ini");
const bootstrapFile = path.join(privateRoot, "bootstrap.sql");
const mysql = path.join(MYSQL_LOCAL.binaryRoot, "bin", "mysql.exe");
const mysqld = path.join(MYSQL_LOCAL.binaryRoot, "bin", "mysqld.exe");
const windowsPath = (value) => value.replaceAll("\\", "/");
const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function fail(message) {
  throw new Error(message);
}

function assertPaths() {
  if (process.platform !== "win32")
    fail("This retained binary requires Windows.");
  if (
    MYSQL_LOCAL.root.toLowerCase() !== "g:\\bills.voltronix.ae" ||
    realpathSync(MYSQL_LOCAL.root).toLowerCase() !==
      MYSQL_LOCAL.root.toLowerCase()
  )
    fail("This helper is restricted to the existing billing workspace.");
  for (const directory of [
    path.dirname(privateRoot),
    privateRoot,
    dataDirectory,
  ]) {
    if (
      existsSync(directory) &&
      (lstatSync(directory).isSymbolicLink() ||
        realpathSync(directory).toLowerCase() !== directory.toLowerCase())
    )
      fail("Refusing a redirected development storage directory.");
  }
  for (const binary of [mysql, mysqld])
    if (!existsSync(binary))
      fail("The explicitly selected MySQL binary is missing.");
}

function protectPrivatePath(target, directory) {
  const relative = path.relative(privateRoot, path.resolve(target));
  if (relative.startsWith("..") || path.isAbsolute(relative))
    fail("Private permissions target escaped billing storage.");
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ErrorActionPreference = 'Stop'
$target = $env:BILLING_MYSQL_PRIVATE_PATH
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$existing = Get-Acl -LiteralPath $target
$existingRules = $existing.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
if ($existing.AreAccessRulesProtected -and $existingRules.Count -eq 1 -and $existingRules[0].IdentityReference -eq $sid -and $existingRules[0].AccessControlType -eq 'Allow') { exit 0 }
if ($env:BILLING_MYSQL_PRIVATE_DIRECTORY -eq 'true') {
  $acl = [System.Security.AccessControl.DirectorySecurity]::new()
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
} else {
  $acl = [System.Security.AccessControl.FileSecurity]::new()
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow')
}
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $target -AclObject $acl
$actual = Get-Acl -LiteralPath $target
$rules = $actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
if (-not $actual.AreAccessRulesProtected -or $rules.Count -ne 1 -or $rules[0].IdentityReference -ne $sid -or $rules[0].AccessControlType -ne 'Allow') { throw 'Private ACL verification failed.' }`,
    ],
    {
      env: {
        ...process.env,
        BILLING_MYSQL_PRIVATE_PATH: target,
        BILLING_MYSQL_PRIVATE_DIRECTORY: String(directory),
      },
      windowsHide: true,
      encoding: "utf8",
      timeout: 15000,
    },
  );
  if (result.status !== 0)
    fail("Unable to establish owner-only Windows storage ACLs.");
}

function writePrivate(target, contents, { exclusive = true } = {}) {
  if (path.dirname(path.resolve(target)) !== privateRoot)
    fail("Private file escaped billing storage.");
  if (existsSync(target) && lstatSync(target).isSymbolicLink())
    fail("Refusing a redirected private file.");
  writeFileSync(target, contents, {
    flag: exclusive ? "wx" : "w",
    mode: 0o600,
  });
  protectPrivatePath(target, false);
}

function command(binary, arguments_, { input, timeout = 30000 } = {}) {
  // Explicit option files and no login paths prevent inherited MySQL configuration.
  const environment = { ...process.env };
  for (const key of Object.keys(environment))
    if (/^MYSQL/i.test(key)) delete environment[key];
  const result = spawnSync(binary, arguments_, {
    input,
    env: environment,
    windowsHide: true,
    encoding: "utf8",
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
  return result;
}

function verifyBinary() {
  const result = command(mysqld, ["--no-defaults", "--version"]);
  if (result.status !== 0 || !/Ver 8\.4\.11 for Win64/.test(result.stdout))
    fail("The selected MySQL binary did not verify as MySQL 8.4.11 Win64.");
  return "8.4.11";
}

async function portAvailable() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(
      { host: MYSQL_LOCAL.host, port: MYSQL_LOCAL.port, exclusive: true },
      () => server.close(() => resolve(true)),
    );
  });
}

function readManifest({ allowInitializing = false } = {}) {
  if (!existsSync(manifestFile))
    fail("No recognized billing MySQL instance exists; run setup first.");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  if (
    manifest.owner !== "voltronix-billing-development" ||
    manifest.dataDirectory !== dataDirectory ||
    manifest.port !== MYSQL_LOCAL.port ||
    manifest.database !== MYSQL_LOCAL.database ||
    manifest.version !== "8.4.11" ||
    (manifest.state !== "ready" &&
      !(allowInitializing && manifest.state === "initializing")) ||
    !existsSync(path.join(dataDirectory, "auto.cnf"))
  )
    fail(
      "Refusing an unknown or incomplete MySQL instance; no data was overwritten.",
    );
  return manifest;
}

function client(role, sql, { allowFailure = false } = {}) {
  const optionFile = path.join(privateRoot, `${role}-client.ini`);
  const result = command(
    mysql,
    [
      `--defaults-file=${optionFile}`,
      "--no-login-paths",
      "--batch",
      "--raw",
      "--skip-column-names",
      "--connect-timeout=3",
    ],
    { input: sql },
  );
  if (result.status !== 0 && !allowFailure) {
    // Client errors can contain SQL values; keep them exclusively in private storage.
    appendFileSync(
      path.join(privateRoot, "client-errors.log"),
      result.stderr || "Client failed.\n",
    );
    fail(
      "MySQL verification failed; private diagnostic log retained, no credentials printed.",
    );
  }
  return result;
}

function connectionReceipt() {
  const result = client(
    "admin",
    `SELECT JSON_OBJECT('version', VERSION(), 'port', @@port, 'datadir', @@datadir, 'bindAddress', @@bind_address, 'globalTimezone', @@global.time_zone, 'sessionTimezone', @@session.time_zone, 'defaultEngine', @@default_storage_engine, 'characterSet', @@character_set_server, 'collation', @@collation_server, 'databaseExists', EXISTS(SELECT 1 FROM information_schema.schemata WHERE schema_name='${MYSQL_LOCAL.database}'), 'databaseCharset', (SELECT default_character_set_name FROM information_schema.schemata WHERE schema_name='${MYSQL_LOCAL.database}'));`,
  );
  const receipt = JSON.parse(result.stdout.trim());
  if (
    receipt.version !== "8.4.11" ||
    receipt.port !== MYSQL_LOCAL.port ||
    path.resolve(receipt.datadir).toLowerCase() !==
      dataDirectory.toLowerCase() ||
    receipt.bindAddress !== MYSQL_LOCAL.host ||
    receipt.globalTimezone !== "+00:00" ||
    receipt.sessionTimezone !== "+00:00" ||
    receipt.defaultEngine !== "InnoDB" ||
    receipt.characterSet !== "utf8mb4" ||
    receipt.databaseCharset !== "utf8mb4" ||
    receipt.databaseExists !== true
  )
    fail(
      "The connected MySQL instance did not match the billing development boundary.",
    );
  return receipt;
}

async function launch({ bootstrap = false } = {}) {
  if (!(await portAvailable()))
    fail("Loopback port 3308 is occupied; refusing to start another instance.");
  const arguments_ = [`--defaults-file=${serverConfig}`];
  if (bootstrap) arguments_.push(`--init-file=${bootstrapFile}`);
  const child = spawn(mysqld, arguments_, {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    cwd: privateRoot,
  });
  let launchFailed = false;
  child.once("error", () => {
    launchFailed = true;
  });
  child.unref();
  for (let attempt = 0; attempt < 60; attempt++) {
    if (launchFailed)
      fail("MySQL process could not start; existing data preserved.");
    const check = client("admin", "SELECT 1;", { allowFailure: true });
    if (check.status === 0 && check.stdout.trim() === "1") return child.pid;
    await wait(500);
  }
  fail(
    "MySQL did not become ready; private server log retained and instance left for inspection.",
  );
}

function verifyAccounts() {
  const grants = Object.fromEntries(
    ["application", "migration"].map((role) => [
      role,
      client(role, "SHOW GRANTS;").stdout.trim().split(/\r?\n/),
    ]),
  );
  for (const role of ["application", "migration"]) {
    if (
      grants[role].some(
        (grant) =>
          /WITH GRANT OPTION/.test(grant) ||
          (/ON \*\.\*/.test(grant) && !/^GRANT USAGE ON/.test(grant)),
      )
    )
      fail("A nonadministrator account has excessive global privileges.");
    const expectedScope = `ON \`${MYSQL_LOCAL.database.replaceAll("_", "\\_")}\`.*`;
    const tableScope =
      /ON `voltronix_billing_dev`\.`[A-Za-z_][A-Za-z0-9_]*` TO /;
    if (
      grants[role].some(
        (grant) =>
          !/^GRANT USAGE ON/.test(grant) &&
          !grant.includes(expectedScope) &&
          !tableScope.test(grant),
      )
    )
      fail(
        "A nonadministrator database grant is not restricted to the exact billing schema.",
      );
  }
  if (
    grants.application.some((grant) =>
      /\b(CREATE|ALTER|DROP|INDEX|TRIGGER|REFERENCES|EXECUTE)\b/.test(grant),
    )
  )
    fail("The application account unexpectedly has schema privileges.");
  if (
    client("application", "SELECT User FROM mysql.user LIMIT 1;", {
      allowFailure: true,
    }).status === 0
  )
    fail("The application account unexpectedly read the server account table.");
  return grants;
}

function verifyInitialDml() {
  const database = MYSQL_LOCAL.database;
  client(
    "migration",
    `CREATE TABLE \`${database}\`.\`_billing_mysql_provisioning_probe\` (id INT PRIMARY KEY, amount DECIMAL(18,2) NOT NULL) ENGINE=InnoDB;`,
  );
  try {
    const result = client(
      "application",
      `USE \`${database}\`; INSERT INTO _billing_mysql_provisioning_probe VALUES (1,10.25); UPDATE _billing_mysql_provisioning_probe SET amount=12.50 WHERE id=1; START TRANSACTION; UPDATE _billing_mysql_provisioning_probe SET amount=99.00 WHERE id=1; ROLLBACK; SELECT amount FROM _billing_mysql_provisioning_probe WHERE id=1; DELETE FROM _billing_mysql_provisioning_probe WHERE id=1; SELECT COUNT(*) FROM _billing_mysql_provisioning_probe;`,
    );
    if (
      result.stdout.trim() !== "12.50\n0" &&
      result.stdout.trim() !== "12.50\r\n0"
    )
      fail("Application DML/transaction rollback verification failed.");
    const ddl = client(
      "application",
      `CREATE TABLE \`${database}\`.\`_billing_forbidden_ddl_probe\` (id INT);`,
      { allowFailure: true },
    );
    if (ddl.status === 0)
      fail("Application account unexpectedly created a table.");
  } finally {
    client(
      "migration",
      `DROP TABLE \`${database}\`.\`_billing_mysql_provisioning_probe\`;`,
    );
  }
}

async function setup() {
  if (existsSync(privateRoot))
    fail(
      "Billing MySQL storage already exists. Use start/status; setup never overwrites it.",
    );
  if (!(await portAvailable()))
    fail("Loopback port 3308 is occupied; setup refused.");
  mkdirSync(privateRoot);
  protectPrivatePath(privateRoot, true);
  mkdirSync(dataDirectory);
  const secrets = {
    version: 1,
    host: MYSQL_LOCAL.host,
    port: MYSQL_LOCAL.port,
    database: MYSQL_LOCAL.database,
    admin: { user: "root", password: randomBytes(32).toString("hex") },
    application: {
      user: MYSQL_LOCAL.applicationUser,
      password: randomBytes(32).toString("hex"),
    },
    migration: {
      user: MYSQL_LOCAL.migrationUser,
      password: randomBytes(32).toString("hex"),
    },
  };
  writePrivate(secretsFile, `${JSON.stringify(secrets, null, 2)}\n`);
  for (const role of ["admin", "application", "migration"])
    writePrivate(
      path.join(privateRoot, `${role}-client.ini`),
      `[client]\nprotocol=TCP\nhost=127.0.0.1\nport=3308\nuser=${secrets[role].user}\npassword=${secrets[role].password}\ndefault-character-set=utf8mb4\n`,
    );
  writePrivate(
    serverConfig,
    `[mysqld]\nbasedir="${windowsPath(MYSQL_LOCAL.binaryRoot)}"\ndatadir="${windowsPath(dataDirectory)}"\nbind-address=127.0.0.1\nport=3308\nmysqlx=0\nskip-name-resolve=ON\nlocal-infile=OFF\nsecure-file-priv=NULL\ncharacter-set-server=utf8mb4\ncollation-server=utf8mb4_0900_as_cs\ndefault-storage-engine=InnoDB\ndefault-time-zone='+00:00'\nlog-error="${windowsPath(path.join(privateRoot, "server-error.log"))}"\npid-file="${windowsPath(path.join(privateRoot, "server.pid"))}"\n`,
  );
  const manifest = {
    owner: "voltronix-billing-development",
    version: "8.4.11",
    dataDirectory,
    port: MYSQL_LOCAL.port,
    database: MYSQL_LOCAL.database,
    state: "initializing",
    createdAt: new Date().toISOString(),
  };
  writePrivate(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  // Secure initialization generates a temporary root password only in the private
  // server log. The first startup replaces it before accepting client connections.
  const initialized = command(
    mysqld,
    [`--defaults-file=${serverConfig}`, "--initialize"],
    { timeout: 180000 },
  );
  if (initialized.status !== 0)
    fail(
      "MySQL initialization failed. Private logs/data retained; setup will not overwrite them.",
    );
  writePrivate(
    bootstrapFile,
    [
      `ALTER USER 'root'@'localhost' IDENTIFIED BY '${secrets.admin.password}';`,
      `CREATE USER 'root'@'127.0.0.1' IDENTIFIED BY '${secrets.admin.password}';`,
      "GRANT ALL PRIVILEGES ON *.* TO 'root'@'127.0.0.1' WITH GRANT OPTION;",
      `CREATE DATABASE \`${MYSQL_LOCAL.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs;`,
      `CREATE USER '${secrets.application.user}'@'127.0.0.1' IDENTIFIED BY '${secrets.application.password}';`,
      `CREATE USER '${secrets.migration.user}'@'127.0.0.1' IDENTIFIED BY '${secrets.migration.password}';`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON \`${MYSQL_LOCAL.database.replaceAll("_", "\\_")}\`.* TO '${secrets.application.user}'@'127.0.0.1';`,
      `GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES, TRIGGER, CREATE VIEW, SHOW VIEW ON \`${MYSQL_LOCAL.database.replaceAll("_", "\\_")}\`.* TO '${secrets.migration.user}'@'127.0.0.1';`,
      "",
    ].join("\n"),
  );
  const processId = await launch({ bootstrap: true });
  return finishProvisioning(manifest, processId);
}

function finishProvisioning(manifest, processId) {
  const connection = connectionReceipt();
  const localUuid = /server-uuid=([a-f0-9-]+)/.exec(
    readFileSync(path.join(dataDirectory, "auto.cnf"), "utf8"),
  )?.[1];
  const serverUuid = client("admin", "SELECT @@server_uuid;").stdout.trim();
  if (!localUuid || localUuid !== serverUuid)
    fail(
      "Connected server identity differs from the initialized billing data directory.",
    );
  const grants = verifyAccounts();
  verifyInitialDml();
  // Remove only the known private bootstrap file after successful authorization.
  if (existsSync(bootstrapFile)) unlinkSync(bootstrapFile);
  writePrivate(
    manifestFile,
    `${JSON.stringify({ ...manifest, state: "ready", serverUuid }, null, 2)}\n`,
    { exclusive: false },
  );
  const receipt = {
    ...connection,
    processId,
    applicationUser: MYSQL_LOCAL.applicationUser,
    migrationUser: MYSQL_LOCAL.migrationUser,
    grants,
    checks: {
      connectivity: true,
      ownerOnlyPrivateAcl: true,
      applicationDml: true,
      rollback: true,
      applicationDdlDenied: true,
      mysqlAccountTableDenied: true,
      applicationSchemaApplied: false,
    },
    checkedAt: new Date().toISOString(),
  };
  writePrivate(
    path.join(privateRoot, "provisioning-receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  return receipt;
}

export async function main(action = process.argv[2]) {
  assertPaths();
  verifyBinary();
  if (action === "setup") return setup();
  if (action === "verify-setup") {
    const manifest = readManifest({ allowInitializing: true });
    if (existsSync(path.join(privateRoot, "provisioning-receipt.json")))
      fail("Use status for an already verified instance.");
    return finishProvisioning(manifest);
  }
  if (!["start", "status"].includes(action))
    fail("Use: node scripts/mysql-local.mjs setup|start|status|verify-setup");
  const manifest = readManifest();
  if (action === "start" && (await portAvailable())) await launch();
  const connection = connectionReceipt();
  if (
    client("admin", "SELECT @@server_uuid;").stdout.trim() !==
    manifest.serverUuid
  )
    fail(
      "Connected server identity differs from the provisioned billing instance.",
    );
  return {
    ...connection,
    applicationUser: MYSQL_LOCAL.applicationUser,
    migrationUser: MYSQL_LOCAL.migrationUser,
    grants: verifyAccounts(),
    checkedAt: new Date().toISOString(),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main()
    .then((receipt) => console.log(JSON.stringify(receipt, null, 2)))
    .catch((error) => {
      // Our errors contain only fixed diagnostics. Never emit provider/OS errors.
      const safe =
        error instanceof Error &&
        /^(This |Refusing |Private |Unable |The |Loopback |No recognized |MySQL |Billing |Application |Use:|Connected )/.test(
          error.message,
        );
      console.error(
        safe
          ? error.message
          : "Local MySQL operation failed; private data was preserved.",
      );
      process.exitCode = 1;
    });
}
