import { describe, expect, it } from "vitest";
import { localTestDatabaseUrl } from "../scripts/lib/local-test-database.mjs";

describe("disposable MySQL integration database destination guard", () => {
  it("accepts explicit loopback runtime development and generated test databases", () => {
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      const url = localTestDatabaseUrl(
        `mysql://voltronix_billing_app:fictional@${host}:3308/voltronix_billing_dev`,
      );
      expect(url.hostname).toBe(host);
      expect(url.search).toBe("");
      expect(url.port).toBe("3308");
      expect(url.pathname).toBe("/voltronix_billing_dev");
    }
    expect(
      localTestDatabaseUrl(
        "mysql://bt_app_123_456:fictional@127.0.0.1:3308/bills_test_123_456",
      ).pathname,
    ).toBe("/bills_test_123_456");
  });
  it.each([
    "?host=remote.invalid",
    "?%68ost=remote.invalid",
    "?host=127.0.0.1&port=3306",
    "?connectionString=mysql://remote.invalid/production",
    "?database=production",
    "?user=root",
    "?password=other",
    "?socketPath=C:/other/mysql.sock",
    "?sslcert=C:/private.pem",
    "?charset=utf8mb4",
    "?schema=private",
    "?schema=public&host=remote.invalid",
    "#ignored-fragment",
  ])("rejects driver override %s before any connection", (suffix) => {
    expect(() =>
      localTestDatabaseUrl(
        `mysql://voltronix_billing_app:fictional@127.0.0.1:3308/voltronix_billing_dev${suffix}`,
      ),
    ).toThrow(/refused/);
  });
  it.each([
    "root",
    "%72oot",
    "mysql.sys",
    "voltronix_billing_migrate",
    "admin",
    "",
  ])(
    "refuses privileged or unrecognized application identity %s",
    (identity) => {
      expect(() =>
        localTestDatabaseUrl(
          `mysql://${identity}:fictional@127.0.0.1:3308/voltronix_billing_dev`,
        ),
      ).toThrow(/refused/);
    },
  );
  it("rejects remote, production, foreign instances and malformed URLs without leaking input", () => {
    for (const input of [
      "mysql://voltronix_billing_app:fictional@remote.invalid:3308/voltronix_billing_dev",
      "mysql://voltronix_billing_app:fictional@127.0.0.1:3308/production",
      "mysql://voltronix_billing_app:fictional@127.0.0.1:3308/bills_test_arbitrary",
      "mysql://bt_app_123_456:fictional@127.0.0.1:3308/bills_test_123_999",
      "mysql://voltronix_billing_app:fictional@127.0.0.1:3308/bills_test_123_456",
      "mysql://voltronix_billing_app:fictional@127.0.0.1:3308/voltronix_billing_dev/extra",
      "mysql://voltronix_billing_app:fictional@127.0.0.1:3306/voltronix_billing_dev",
      "mysql://voltronix_billing_app@127.0.0.1:3308/voltronix_billing_dev",
      "postgresql://voltronix_billing_app:fictional@127.0.0.1:3308/voltronix_billing_dev",
      "https://127.0.0.1/voltronix_billing_dev",
      "fictional-secret-malformed",
      undefined,
    ]) {
      let message = "";
      try {
        localTestDatabaseUrl(input);
      } catch (error) {
        message = String(error);
      }
      expect(message).toMatch(/refused/);
      expect(message).not.toContain("fictional-secret-malformed");
      expect(message).not.toContain("mysql://");
    }
  });
});
