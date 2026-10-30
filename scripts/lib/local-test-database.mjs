/** Validate before constructing any client. No query/fragment overrides or privileged users. */
export function localTestDatabaseUrl(raw) {
  try {
    const url = new URL(raw);
    const user = decodeURIComponent(url.username);
    const expectedDatabase =
      user === "voltronix_billing_app"
        ? "/voltronix_billing_dev"
        : `/bills_test_${user.slice("bt_app_".length)}`;
    if (
      url.protocol !== "mysql:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.port !== "3308" ||
      !/^\/(?:voltronix_billing_dev|bills_test_\d+_\d+)$/.test(url.pathname) ||
      !url.password ||
      !/^(?:voltronix_billing_app|bt_app_\d+_\d+)$/.test(user) ||
      url.pathname !== expectedDatabase ||
      url.hash ||
      url.search
    )
      throw new Error();
    return url;
  } catch {
    // Never attach raw URL/input or a credential-bearing parse error.
    throw new Error(
      "Integration tests require an explicitly named loopback MySQL development/disposable database on port 3308, a dedicated runtime user, and no connection overrides. Remote, production and privileged destinations are refused.",
    );
  }
}
