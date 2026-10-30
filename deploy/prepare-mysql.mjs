import { spawnSync } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  X509Certificate,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

const deploymentDirectory = path.dirname(fileURLToPath(import.meta.url));
const database = "billing_operational";
const roles = { runtime: "billing_runtime", migrator: "billing_migrator" };
const caContainerPath = "/run/secrets/mysql_ca";
const sslConfig = `[req]
distinguished_name=dn
prompt=no
[dn]
CN=mysql
[ca]
basicConstraints=critical,CA:TRUE,pathlen:0
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=hash
[server]
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:mysql
authorityKeyIdentifier=keyid,issuer
`;

function regular(file, missing = false) {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("A regular private file is required.");
    return true;
  } catch (error) {
    if (missing && error.code === "ENOENT") return false;
    throw error;
  }
}

function directory(file, create = false) {
  try {
    const stat = lstatSync(file);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Redirected private directories are refused.");
  } catch (error) {
    if (!create || error.code !== "ENOENT") throw error;
    mkdirSync(file, { mode: 0o700 });
    if (process.platform === "win32") {
      const who = spawnSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5000,
      });
      const sid = who.status === 0 && who.stdout.match(/S-1-\d+(?:-\d+)+/)?.[0];
      if (!sid)
        throw new Error("The current Windows identity could not be checked.");
      const acl = spawnSync(
        "icacls.exe",
        [
          file,
          "/inheritance:r",
          "/grant:r",
          `*${sid}:(OI)(CI)F`,
          "*S-1-5-18:(OI)(CI)F",
        ],
        { windowsHide: true, timeout: 10000, stdio: "pipe" },
      );
      if (acl.status !== 0)
        throw new Error(
          "Private Windows directory permissions could not be applied.",
        );
    }
  }
}

export function findOpenSsl() {
  const candidates = [process.env.OPENSSL_BIN, "openssl"];
  if (process.platform === "win32") {
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    candidates.push(
      path.join(programFiles, "Git", "usr", "bin", "openssl.exe"),
      path.join(programFiles, "Git", "mingw64", "bin", "openssl.exe"),
    );
  }
  for (const executable of candidates) {
    if (typeof executable !== "string" || !executable) continue;
    const result = spawnSync(executable, ["version"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    });
    if (result.status === 0 && /^OpenSSL\s/.test(result.stdout))
      return executable;
  }
  throw new Error(
    "OpenSSL is required. Install OpenSSL or Git for Windows, or set OPENSSL_BIN to its executable path.",
  );
}

function openssl(executable, args) {
  const result = spawnSync(executable, args, {
    windowsHide: true,
    timeout: 30000,
    stdio: "pipe",
  });
  if (result.status !== 0)
    throw new Error(
      "Private certificate generation failed; tool output was suppressed.",
    );
}

function bootstrap(passwords) {
  // Escape the underscore because database-level GRANT uses wildcard matching.
  return `CREATE USER 'billing_runtime'@'%' IDENTIFIED BY '${passwords.runtime}' REQUIRE SSL;
CREATE USER 'billing_migrator'@'%' IDENTIFIED BY '${passwords.migrator}' REQUIRE SSL;
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES, TRIGGER, CREATE VIEW, SHOW VIEW ON \`billing\\_operational\`.* TO 'billing_migrator'@'%';
`;
}

function inspectBundle(directoryPath) {
  directory(directoryPath);
  const get = (name) => {
    const file = path.join(directoryPath, name);
    regular(file);
    return readFileSync(file, "utf8");
  };
  const passwords = Object.fromEntries(
    ["root", "runtime", "migrator"].map((role) => {
      const value = get(`${role}-password`);
      if (!/^[a-f0-9]{64}\n$/.test(value))
        throw new Error("Private database credential format is invalid.");
      return [role, value.trim()];
    }),
  );
  if (
    new Set(Object.values(passwords)).size !== 3 ||
    get("bootstrap.sql") !== bootstrap(passwords)
  )
    throw new Error(
      "The private database credentials and initialization script disagree.",
    );
  const caBytes = get("ca-cert.pem");
  const ca = new X509Certificate(caBytes);
  const server = new X509Certificate(get("server-cert.pem"));
  const now = Date.now();
  if (
    !ca.ca ||
    !ca.verify(ca.publicKey) ||
    !server.verify(ca.publicKey) ||
    server.ca ||
    !ca.checkPrivateKey(createPrivateKey(get("ca-key.pem"))) ||
    !server.checkPrivateKey(createPrivateKey(get("server-key.pem"))) ||
    server.issuer !== ca.subject ||
    !server.keyUsage?.includes("1.3.6.1.5.5.7.3.1") ||
    server.subjectAltName !== "DNS:mysql" ||
    server.checkHost("mysql") !== "mysql" ||
    [ca, server].some(
      (cert) =>
        new Date(cert.validFrom).getTime() > now + 60000 ||
        new Date(cert.validTo).getTime() < now + 30 * 86400000,
    )
  )
    throw new Error(
      "The preserved certificates must match their keys, cover mysql and remain valid for at least 30 days. Renew explicitly; keys were not replaced.",
    );
  const receipt = JSON.parse(get("prepared.json"));
  if (
    receipt.version !== 1 ||
    receipt.database !== database ||
    receipt.hostname !== "mysql" ||
    receipt.caSha256 !== createHash("sha256").update(caBytes).digest("hex")
  )
    throw new Error(
      "The private MySQL preparation receipt does not match its certificate.",
    );
  return {
    passwords,
    caBytes,
    serverCertificateExpiresAt: new Date(server.validTo).toISOString(),
  };
}

function environmentUpdates(directoryPath, passwords) {
  return Object.entries(roles).map(([role, user]) => {
    const name = role === "runtime" ? ".env.production" : ".env.migration";
    const file = path.join(directoryPath, name);
    regular(file);
    const original = readFileSync(file, "utf8");
    const env = parseEnv(original);
    const expected = `mysql://${user}:${passwords[role]}@mysql:3306/${database}`;
    const placeholder = `mysql://${user}:REPLACE_PRIVATELY@MYSQL_HOST:3306/${database}`;
    if (env.DATABASE_URL !== placeholder && env.DATABASE_URL !== expected)
      throw new Error(
        "An existing database URL was preserved. This helper only fills its exact fresh-install placeholder or reuses its own credentials.",
      );
    let updated = original;
    for (const [key, value] of Object.entries({
      DATABASE_URL: expected,
      DATABASE_TLS_MODE: "verify-full",
      DATABASE_TLS_CA_FILE: caContainerPath,
    })) {
      const expression = new RegExp(`^(${key}=)[^\\r\\n]*`, "gm");
      if ([...original.matchAll(expression)].length !== 1)
        throw new Error(
          "Each database environment setting must occur exactly once.",
        );
      updated = updated.replace(expression, `$1${value}`);
    }
    return { file, original, updated };
  });
}

export function inspectOwnedMysql(directoryPath = deploymentDirectory) {
  directory(directoryPath);
  directory(path.join(directoryPath, ".private"));
  const bundle = inspectBundle(path.join(directoryPath, ".private", "mysql"));
  const publicCa = path.join(directoryPath, ".private", "mysql-ca.pem");
  regular(publicCa);
  if (readFileSync(publicCa, "utf8") !== bundle.caBytes)
    throw new Error("The mounted CA differs from the owned database CA.");
  return {
    status: "PRIVATE_FILES_VALIDATED",
    privateDirectory: "deploy/.private/mysql",
    caFile: "deploy/.private/mysql-ca.pem",
    databaseHost: "mysql",
    database,
    serverCertificateExpiresAt: bundle.serverCertificateExpiresAt,
    databaseConnections: 0,
    providerRequests: 0,
  };
}

/** Offline only: generate private material, optionally fill the two placeholders. */
export function prepareOwnedMysql(
  directoryPath = deploymentDirectory,
  { configureEnvironment = false } = {},
) {
  directory(directoryPath);
  const privateRoot = path.join(directoryPath, ".private");
  directory(privateRoot, true);
  const privateDirectory = path.join(privateRoot, "mysql");
  const publicCa = path.join(privateRoot, "mysql-ca.pem");
  const lock = path.join(privateRoot, "mysql-prepare.lock");
  const handle = openSync(lock, "wx", 0o600);
  let created = false;
  try {
    // lstat catches dangling links as well as redirected directories.
    let existing = false;
    try {
      lstatSync(privateDirectory);
      existing = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (!existing) {
      if (regular(publicCa, true))
        throw new Error(
          "An existing CA was preserved. Use its existing database configuration or explicitly plan a CA migration.",
        );
      const executable = findOpenSsl();
      const staged = path.join(
        privateRoot,
        `.mysql-prepare-${Date.now()}-${randomBytes(6).toString("hex")}`,
      );
      directory(staged, true);
      const write = (name, value) =>
        writeFileSync(path.join(staged, name), value, {
          flag: "wx",
          mode: 0o600,
        });
      const passwords = Object.fromEntries(
        ["root", "runtime", "migrator"].map((role) => [
          role,
          randomBytes(32).toString("hex"),
        ]),
      );
      for (const [role, value] of Object.entries(passwords))
        write(`${role}-password`, `${value}\n`);
      write("bootstrap.sql", bootstrap(passwords));
      write("openssl.cnf", sslConfig);
      for (const role of ["ca", "server"]) {
        const pair = generateKeyPairSync("rsa", {
          modulusLength: 3072,
          privateKeyEncoding: { type: "pkcs8", format: "pem" },
          publicKeyEncoding: { type: "spki", format: "pem" },
        });
        write(`${role}-key.pem`, pair.privateKey);
      }
      const file = (name) => path.join(staged, name);
      openssl(executable, [
        "req",
        "-new",
        "-x509",
        "-key",
        file("ca-key.pem"),
        "-out",
        file("ca-cert.pem"),
        "-days",
        "3650",
        "-sha256",
        "-subj",
        "/CN=Voltronix Bills MySQL CA",
        "-config",
        file("openssl.cnf"),
        "-extensions",
        "ca",
      ]);
      openssl(executable, [
        "req",
        "-new",
        "-key",
        file("server-key.pem"),
        "-out",
        file("server.csr"),
        "-config",
        file("openssl.cnf"),
      ]);
      openssl(executable, [
        "x509",
        "-req",
        "-in",
        file("server.csr"),
        "-CA",
        file("ca-cert.pem"),
        "-CAkey",
        file("ca-key.pem"),
        "-set_serial",
        `0x${randomBytes(16).toString("hex")}`,
        "-out",
        file("server-cert.pem"),
        "-days",
        "397",
        "-sha256",
        "-extfile",
        file("openssl.cnf"),
        "-extensions",
        "server",
      ]);
      unlinkSync(file("server.csr"));
      for (const name of ["ca-cert.pem", "server-cert.pem"])
        chmodSync(file(name), 0o600);
      write(
        "prepared.json",
        `${JSON.stringify(
          {
            version: 1,
            hostname: "mysql",
            database,
            createdAt: new Date().toISOString(),
            caSha256: createHash("sha256")
              .update(readFileSync(file("ca-cert.pem")))
              .digest("hex"),
          },
          null,
          2,
        )}\n`,
      );
      inspectBundle(staged);
      renameSync(staged, privateDirectory);
      created = true;
    }
    const bundle = inspectBundle(privateDirectory);
    if (!regular(publicCa, true))
      writeFileSync(publicCa, bundle.caBytes, { flag: "wx", mode: 0o444 });
    const report = inspectOwnedMysql(directoryPath);
    if (configureEnvironment) {
      // Validate both files before writing either. Updating in place preserves
      // the existing ACL, encryption key and every unrelated configuration byte.
      const changes = environmentUpdates(directoryPath, bundle.passwords);
      const applied = [];
      try {
        for (const change of changes) {
          if (change.updated === change.original) continue;
          if (readFileSync(change.file, "utf8") !== change.original)
            throw new Error("Configuration changed during preparation.");
          writeFileSync(change.file, change.updated);
          applied.push(change);
        }
      } catch (error) {
        for (const change of applied.reverse())
          writeFileSync(change.file, change.original);
        throw error;
      }
    }
    return {
      ...report,
      files: created ? "CREATED" : "PRESERVED",
      environmentConfigured: configureEnvironment,
    };
  } finally {
    closeSync(handle);
    unlinkSync(lock);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const args = process.argv.slice(2);
    if (
      args.length > 1 ||
      args.some((arg) => !["--configure-env", "--check"].includes(arg))
    )
      throw new Error(
        "Use node deploy/prepare-mysql.mjs [--configure-env|--check].",
      );
    console.log(
      JSON.stringify(
        args[0] === "--check"
          ? inspectOwnedMysql()
          : prepareOwnedMysql(undefined, {
              configureEnvironment: args[0] === "--configure-env",
            }),
        null,
        2,
      ),
    );
  } catch {
    console.error(
      "Owned MySQL preparation failed. Review private files, placeholders, permissions and certificate validity; no secrets were printed or replaced.",
    );
    process.exitCode = 1;
  }
}
