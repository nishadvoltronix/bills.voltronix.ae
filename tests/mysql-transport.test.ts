import { afterEach, describe, expect, it, vi } from "vitest";
import { rootCertificates, type PeerCertificate } from "node:tls";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mysqlConnectionOptions } from "@/lib/mysql-connection";
import { mysqlTransportOptions } from "@/lib/mysql-transport";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const remote = mysqlConnectionOptions("mysql://billing_runtime:private-password@database.example.invalid:3306/billing_operational");
const local = mysqlConnectionOptions("mysql://fixture:private-password@127.0.0.1:3308/bills_test_fixture");
const directories: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const directory of directories.splice(0)) {
    const target = path.resolve(directory);
    if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith("billing-mysql-tls-"))
      throw new Error("TLS test cleanup escaped its temporary directory.");
    rmSync(target, { recursive: true, force: true });
  }
});
function caFile(contents: string) {
  const directory = mkdtempSync(path.join(tmpdir(), "billing-mysql-tls-"));
  directories.push(directory);
  const file = path.join(directory, "trusted-ca.pem");
  writeFileSync(file, contents);
  return file;
}
function verified(env: Record<string, string | undefined> = {}) {
  const transport = mysqlTransportOptions(remote, env);
  if (!transport.ssl) throw new Error("Expected TLS for a nonfixture database.");
  return transport.ssl;
}

describe("MySQL verified transport", () => {
  it("requires standard CA validation, TLS 1.2+ and exact-host identity for a remote database", () => {
    const transport = mysqlTransportOptions(remote, { APP_ENV: "production" });
    const ssl = verified({ APP_ENV: "production" });
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(ssl.minVersion).toBe("TLSv1.2");
    expect(ssl.servername).toBe(remote.host);
    // Passing roots explicitly prevents the connector's password/fingerprint fallback.
    expect(ssl.ca).toEqual([...rootCertificates]);
    expect(transport.permitRedirect).toBe(false);
    expect(transport.allowPublicKeyRetrieval).toBe(false);
    const matching = { subject: { CN: remote.host }, subjectaltname: `DNS:${remote.host}` } as PeerCertificate;
    const other = { subject: { CN: "other.example.invalid" }, subjectaltname: "DNS:other.example.invalid" } as PeerCertificate;
    expect(ssl.checkServerIdentity!("untrusted-callback-name", matching)).toBeUndefined();
    expect(ssl.checkServerIdentity!("other.example.invalid", other)).toBeInstanceOf(Error);
  });

  it("loads a private CA bundle without adding public fallback roots", () => {
    const certificate = rootCertificates[0];
    const ssl = verified({ DATABASE_TLS_MODE: "verify-full", DATABASE_TLS_CA_FILE: caFile(`${certificate}\n`) });
    expect(ssl.ca).toEqual([certificate]);
    expect(ssl.rejectUnauthorized).toBe(true);
  });

  it.each(["disabled", "require", "verify-ca", "false", "insecure"])("rejects the unsupported or unsafe remote mode %s without disclosing credentials", (mode) => {
    expect(() => verified({ APP_ENV: "production", DATABASE_TLS_MODE: mode })).toThrow("Database transport requires verified TLS");
  });

  it("rejects a global TLS-verification bypass even when verified mode is requested", () => {
    expect(() => verified({ NODE_TLS_REJECT_UNAUTHORIZED: "0", DATABASE_TLS_MODE: "verify-full" })).toThrow("verified TLS");
  });

  it.each(["private-invalid-ca-contents", "-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----", ""])("rejects invalid CA content without echoing file contents or paths", (contents) => {
    const file = caFile(contents);
    let message = "";
    try { verified({ DATABASE_TLS_CA_FILE: file }); } catch (error) { message = String(error); }
    expect(message).toContain("readable trusted CA bundle");
    expect(message).not.toContain(file);
    expect(message).not.toContain("private-invalid");
  });

  it("rejects a missing configured CA instead of falling back to system trust", () => {
    const missing = path.join(tmpdir(), "missing-billing-mysql-ca", "private-name.pem");
    expect(() => verified({ DATABASE_TLS_CA_FILE: missing })).toThrow("readable trusted CA bundle");
  });

  it("retains the existing pinned public key for the exact local fixture only", () => {
    const read = vi.mocked(fs.readFileSync).mockReturnValue("fictional-pinned-public-key");
    const transport = mysqlTransportOptions(local, { APP_ENV: "test" });
    expect(transport.ssl).toBe(false);
    expect(transport.cachingRsaPublicKey).toBe("fictional-pinned-public-key");
    expect(read).toHaveBeenCalledWith(path.resolve(".local/mysql-dev/data/public_key.pem"), "utf8");
    expect(transport.allowPublicKeyRetrieval).toBe(false);
    expect(mysqlTransportOptions(local, { APP_ENV: "production" }).ssl).not.toBe(false);
    expect(() => mysqlTransportOptions(local, { APP_ENV: "production", DATABASE_TLS_MODE: "disabled" })).toThrow("verified TLS");
  });

  it("allows the local fixture to opt into verified TLS explicitly", () => {
    const transport = mysqlTransportOptions(local, { APP_ENV: "test", DATABASE_TLS_MODE: "verify-full" });
    expect(transport.ssl).not.toBe(false);
    if (transport.ssl) expect(transport.ssl.servername).toBeUndefined();
    expect(() => mysqlTransportOptions(local, { APP_ENV: "test", DATABASE_TLS_MODE: "disabled", DATABASE_TLS_CA_FILE: "private-ca.pem" })).toThrow("verified TLS");
  });
});
