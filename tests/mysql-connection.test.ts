import { describe, expect, it } from "vitest";
import { mysqlConnectionOptions } from "@/lib/mysql-connection";

describe("MySQL application connection boundary", () => {
  it("decodes credentials without allowing query options to override the destination", () => {
    const result = mysqlConnectionOptions("mysql://fixture:password%40with%23symbols@127.0.0.1:3308/bills_test_fixture");
    expect(result).toEqual({ host: "127.0.0.1", port: 3308, database: "bills_test_fixture", user: "fixture", password: "password@with#symbols" });
  });
  it.each([
    "mysql://root:fictional@127.0.0.1/bills_test_fixture",
    "mysql://mysql.sys:fictional@127.0.0.1/bills_test_fixture",
    "mysql://fixture:fictional@127.0.0.1/bills_test_fixture?host=elsewhere.invalid",
    "mysql://fixture:fictional@127.0.0.1/bills_test_fixture#anything",
    "mysql://fixture@127.0.0.1/bills_test_fixture",
    "mysql://fixture:fictional@127.0.0.1/database/another",
    "postgresql://fixture:fictional@127.0.0.1/bills_dev",
    "not-a-url-with-a-secret",
  ])("rejects unsafe or incompatible configuration without leaking its input", (url) => {
    let failure = "";
    try { mysqlConnectionOptions(url); } catch (error) { failure = String(error); }
    expect(failure).toContain("dedicated application identity");
    expect(failure).not.toContain(url);
    expect(failure).not.toContain("fictional");
  });
});
