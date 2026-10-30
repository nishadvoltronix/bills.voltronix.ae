import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, chown, lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

/** Atomic replacement while retaining the operator's existing private ACL/Unix ownership. */
export async function replacePrivateEnvironmentFile(filename: string, before: string, after: string) {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() ||
      (process.platform !== "win32" && (stat.mode & 0o137) !== 0)) throw new Error("PRIVATE_ENVIRONMENT_PERMISSIONS");
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.tmp`);
  await writeFile(temporary, "", { flag: "wx", mode: 0o600 });
  try {
    if (process.platform === "win32") {
      // The empty temporary file receives the protected ACL before it receives secrets.
      await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "$ErrorActionPreference='Stop'; $a=Get-Acl -LiteralPath $env:BILLS_PRIVATE_ENV_SOURCE; " +
        "$allowed=@([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544'); " +
        "foreach($r in $a.Access){if($r.AccessControlType -eq 'Allow' -and $allowed -notcontains $r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value){throw 'PRIVATE_ACL_REQUIRED'}}; " +
        "Set-Acl -LiteralPath $env:BILLS_PRIVATE_ENV_TEMP -AclObject $a"],
      { windowsHide: true, env: { ...process.env, BILLS_PRIVATE_ENV_SOURCE: filename, BILLS_PRIVATE_ENV_TEMP: temporary }, timeout: 15_000 });
    } else {
      const created = await lstat(temporary);
      if (created.uid !== stat.uid || created.gid !== stat.gid) await chown(temporary, stat.uid, stat.gid);
      await chmod(temporary, stat.mode & 0o777);
    }
    await writeFile(temporary, after);
    if ((await lstat(filename)).isSymbolicLink() || await readFile(filename, "utf8") !== before)
      throw new Error("PRIVATE_CONFIGURATION_CHANGED");
    await rename(temporary, filename);
  } finally { await unlink(temporary).catch(() => undefined); }
}
