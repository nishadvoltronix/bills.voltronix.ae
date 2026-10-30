import { X509Certificate } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { checkServerIdentity, rootCertificates, type ConnectionOptions } from "node:tls";
import type { mysqlConnectionOptions } from "./mysql-connection";

type Connection = ReturnType<typeof mysqlConnectionOptions>;
const configurationError = () => new Error(
  "Database transport requires verified TLS and a readable trusted CA bundle. Plaintext is limited to the isolated local development database.",
);

function trustedCertificates(file: string): string[] {
  try {
    const target = path.resolve(file);
    const information = statSync(target);
    if (!information.isFile() || information.size > 1024 * 1024) throw configurationError();
    const pem = readFileSync(target, "utf8").replace(/^\uFEFF/, "");
    if (Buffer.byteLength(pem) > 1024 * 1024) throw configurationError();
    const certificates = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
    if (!certificates?.length || pem.replace(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g, "").trim())
      throw configurationError();
    // Validate the configured public certificates before constructing a driver.
    for (const certificate of certificates) new X509Certificate(certificate);
    return certificates;
  } catch {
    // File errors may include private paths. Do not expose their original messages.
    throw configurationError();
  }
}

/**
 * Shared transport policy for web, workers and read-only operator diagnostics.
 * The driver may otherwise use a password-based self-signed fingerprint fallback;
 * an explicit CA list keeps every nonfixture connection on normal TLS validation.
 */
export function mysqlTransportOptions(
  connection: Connection,
  env: Record<string, string | undefined> = process.env,
) {
  const localFixture =
    ["development", "test"].includes(env.APP_ENV ?? "") &&
    connection.host === "127.0.0.1" && connection.port === 3308 &&
    (connection.database === "voltronix_billing_dev" || /^bills_(test|restore)_/.test(connection.database));
  const caFile = env.DATABASE_TLS_CA_FILE?.trim();
  const mode = env.DATABASE_TLS_MODE?.trim() || (localFixture && !caFile ? "disabled" : "verify-full");
  if (!["disabled", "verify-full"].includes(mode)) throw configurationError();
  if (mode === "disabled") {
    if (!localFixture || caFile) throw configurationError();
    try {
      return {
        ssl: false as const,
        permitRedirect: false,
        allowPublicKeyRetrieval: false,
        cachingRsaPublicKey: readFileSync(path.resolve(".local/mysql-dev/data/public_key.pem"), "utf8"),
      };
    } catch { throw configurationError(); }
  }
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw configurationError();
  const ssl: ConnectionOptions & { rejectUnauthorized: true } = {
    ca: caFile ? trustedCertificates(caFile) : [...rootCertificates],
    rejectUnauthorized: true,
    minVersion: "TLSv1.2",
    // Set SNI for DNS names, and bind verification to the URL's exact host even
    // when a driver supplies a different callback argument or a TLS socket.
    ...(isIP(connection.host) ? {} : { servername: connection.host }),
    checkServerIdentity: (_name, certificate) => checkServerIdentity(connection.host, certificate),
  };
  return { ssl, permitRedirect: false, allowPublicKeyRetrieval: false };
}
