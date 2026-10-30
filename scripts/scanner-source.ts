import { randomBytes, randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { Prisma } from "@prisma/client";
import { db } from "../src/lib/db";
import { authenticateAccountOperator } from "../src/lib/services/accounts";
import { requireCompanyAccess } from "../src/lib/company";
import { parseScannerConfig } from "./lib/scanner-worker";

const root = path.resolve(import.meta.dirname, "..");
const privateRoot = path.join(root, ".local", "mysql-dev", "scanner-workers");
let writtenConfig: string | undefined;
let committed = false;
let transactionStarted = false;

function guardDevelopmentDatabase() {
  const target = new URL(process.env.DATABASE_URL ?? "http://invalid");
  const allowed = process.env.APP_ENV === "development"
    ? target.pathname === "/voltronix_billing_dev"
    : process.env.APP_ENV === "test" && /^\/bills_test_\d+_\d+$/.test(target.pathname) &&
      process.env.TEST_DATABASE_URL === process.env.DATABASE_URL &&
      process.env.MYSQL_TEST_EXPECTED_DATABASE === target.pathname.slice(1);
  if (!allowed || target.protocol !== "mysql:" || target.hostname !== "127.0.0.1" || target.port !== "3308" || target.search || target.hash)
    throw new Error("Only the guarded local development/test database is supported.");
}

function protectDirectory(directory: string) {
  const relative = path.relative(privateRoot, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Private path refused.");
  for (let cursor = directory; cursor !== path.dirname(cursor); cursor = path.dirname(cursor)) {
    if (fs.existsSync(cursor) && (fs.lstatSync(cursor).isSymbolicLink() || fs.realpathSync(cursor).toLowerCase() !== cursor.toLowerCase()))
      throw new Error("Redirected private path refused.");
    if (cursor === root) break;
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") { fs.chmodSync(directory, 0o700); return; }
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
$ErrorActionPreference = 'Stop'
$target = $env:SCANNER_PRIVATE_DIRECTORY
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = [System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
Set-Acl -LiteralPath $target -AclObject $acl
$actual = Get-Acl -LiteralPath $target
$rules = $actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
if (-not $actual.AreAccessRulesProtected -or $rules.Count -ne 1 -or $rules[0].IdentityReference -ne $sid) { throw 'Private ACL validation failed.' }
`], { env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|USERPROFILE)$/i.test(key))),
    NODE_ENV: process.env.NODE_ENV ?? "development", SCANNER_PRIVATE_DIRECTORY: directory }, windowsHide: true, encoding: "utf8", timeout: 15000 });
  if (result.status !== 0) throw new Error("Private ACL setup failed.");
}

function writeWorkerConfiguration(sourceId: string, token: string) {
  const sourceDirectory = path.join(privateRoot, sourceId);
  const output = path.join(sourceDirectory, `config-${Date.now()}-${randomUUID().slice(0, 8)}`);
  protectDirectory(output);
  const settings = {
    SCANNER_FOLDER: process.env.SCANNER_FOLDER ?? "",
    SCANNER_API_URL: process.env.SCANNER_API_URL ?? process.env.APP_URL ?? "",
    SCANNER_SOURCE_ID: sourceId,
    SCANNER_TOKEN: token,
    SCANNER_STATE_DIR: path.join(sourceDirectory, "state"),
    SCANNER_POLL_SECONDS: process.env.SCANNER_POLL_SECONDS ?? "10",
    SCANNER_SETTLE_SECONDS: process.env.SCANNER_SETTLE_SECONDS ?? "30",
  };
  parseScannerConfig(settings);
  const content = Object.entries(settings).map(([key, value]) => {
    if (/[\r\n'\0]/.test(value)) throw new Error("Worker setting contains unsafe characters.");
    return `${key}='${value}'`;
  }).join("\n") + "\n";
  const parsed = parseEnv(content);
  if (Object.entries(settings).some(([key, value]) => parsed[key] !== value))
    throw new Error("Worker settings did not round-trip safely.");
  const file = path.join(output, ".env.scanner");
  fs.writeFileSync(file, content, { flag: "wx", mode: 0o600 });
  writtenConfig = file;
  return file;
}

async function main() {
  guardDevelopmentDatabase();
  if (process.env.ALLOW_SCANNER_ADMINISTRATION !== "true") throw new Error("Explicit administration enablement required.");
  const action = process.argv[2];
  if (process.argv.length !== 3 || !["create", "enable", "disable", "rotate"].includes(action))
    throw new Error("Use create, enable, disable or rotate.");
  const operator = await authenticateAccountOperator(process.env.ACCOUNT_OPERATOR_EMAIL ?? "", process.env.ACCOUNT_OPERATOR_PASSWORD ?? "");
  const sourceId = action === "create" ? randomUUID() : process.env.SCANNER_SOURCE_ID ?? "";
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(sourceId)) throw new Error("Source identity required.");
  const existing = action === "create" ? null : await db.scannerSource.findUniqueOrThrow({ where: { id: sourceId } });
  const companyId = existing?.companyId ?? process.env.SCANNER_COMPANY_ID ?? "";
  const name = (existing?.name ?? process.env.SCANNER_SOURCE_NAME ?? "").trim();
  if (!companyId || !name || name.length > 200) throw new Error("Company and source name required.");
  await requireCompanyAccess(operator, companyId);
  const token = ["create", "rotate"].includes(action) ? randomBytes(32).toString("hex") : undefined;
  const configuration = token ? writeWorkerConfiguration(sourceId, token) : undefined;
  transactionStarted = true;
  await db.$transaction(async tx => {
    const currentOperator = await tx.user.findUnique({ where: { id: operator.id }, select: { active: true, role: true } });
    if (!currentOperator?.active || currentOperator.role !== "ADMIN") throw new Error("Administrator unavailable.");
    await requireCompanyAccess(operator, companyId, tx);
    if (action === "create") {
      const uploader = await tx.user.create({ data: {
        email: `scanner-${sourceId}@scanner.invalid`, name: `[SCANNER] ${name}`.slice(0, 120),
        role: "DATA_ENTRY", active: true, passwordHash: "scanner-service-no-password-login",
        memberships: { create: { companyId } },
      } });
      await tx.scannerSource.create({ data: { id: sourceId, companyId, uploadedById: uploader.id, name,
        active: false, tokenHash: createHash("sha256").update(token!).digest("hex") } });
    } else {
      const source = await tx.scannerSource.findUniqueOrThrow({ where: { id: sourceId }, include: { uploadedBy: true } });
      if (source.companyId !== companyId) throw new Error("Source changed.");
      if (action !== "disable") {
        if (!source.uploadedBy.active || source.uploadedBy.role !== "DATA_ENTRY") throw new Error("Scanner upload identity unavailable.");
        await requireCompanyAccess({ id: source.uploadedById }, companyId, tx);
      }
      await tx.scannerSource.update({ where: { id: sourceId }, data: action === "rotate"
        ? { tokenHash: createHash("sha256").update(token!).digest("hex") }
        : { active: action === "enable" } });
    }
    await tx.auditLog.create({ data: { actorId: operator.id, companyId, action: `SCANNER_SOURCE_${action.toUpperCase()}`,
      entityType: "ScannerSource", entityId: sourceId, details: { source: "reauthenticated_operator", credentialLogged: false } } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  committed = true;
  console.log(JSON.stringify({ action, sourceId, configuration, ...(action === "create" ? { active: false, note: "Source created disabled with a dedicated DATA_ENTRY upload identity. Review assignment, enable the source and server intake separately." } : {}), credentialsPrinted: false }));
}

main().catch(() => {
  console.error("Scanner administration failed. Check the local database, explicit enablement, active Admin credentials/company membership, source/action and private output permissions. No secrets were printed.");
  process.exitCode = 1;
}).finally(async () => {
  try {
    // Keep the private credential after an uncertain commit acknowledgement. A
    // supervised retry/rotation can recover it; source files are never touched.
    if (!committed && writtenConfig && !transactionStarted) fs.unlinkSync(writtenConfig);
  } finally {
    await db.$disconnect();
  }
});
