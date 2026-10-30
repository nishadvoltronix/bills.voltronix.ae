import { describe, expect, it, vi } from "vitest";
import { validateRestoreTarget } from "@/lib/security/restore-verification";
vi.mock("@/lib/db", () => ({ db: {} }));

const local =
  "mysql://fixture:fictional@127.0.0.1:3308/bills_restore_audit";
describe("restore target connection-string boundary", () => {
  it.each([
    "?host=remote.invalid",
    "?%68ost=remote.invalid",
    "?hostaddr=192.0.2.1",
    "?port=5433",
    "?database=bills_dev",
    "?user=another",
    "?password=another",
    "?sslkey=private-file",
    "?sslrootcert=private-file",
    "?options=-c%20search_path%3Dprivate",
    "?schema=private",
    "?schema=public",
    "?schema=public&host=remote.invalid",
    "?schema=public&schema=public",
    "?SCHEMA=public",
    "#host=remote.invalid",
  ])(
    "rejects connection overrides %s before creating a database client",
    (suffix) => {
      expect(() => validateRestoreTarget(`${local}${suffix}`)).toThrow(
        "loopback databases",
      );
    },
  );
  it.each([
    local,
    "mysql://localhost/bills_restore_fixture",
    "mysql://[::1]/bills_restore_fixture",
  ])("permits the constrained disposable target %s", (url) => {
    expect(validateRestoreTarget(url).pathname).toMatch(/^\/bills_restore_/);
  });
});
