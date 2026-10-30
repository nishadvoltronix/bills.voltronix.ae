import { getBooksOrganizations, getConfig, type Target } from "../../src/lib/integrations/config";
import { connectionFingerprint } from "../../src/lib/integrations/connection-fingerprint";
import { parse } from "dotenv";

export type TransferGrant = {
  target: Target;
  organizationId: string;
  dataCenter: string;
  connectionFingerprint: string;
  refreshTokenEncrypted: string;
  revokedAt: Date | null;
};

/** Private bootstrap values only. The caller must protect the resulting file; never log this object. */
export function deriveZohoBootstrapSettings(
  source: NodeJS.ProcessEnv,
  target: NodeJS.ProcessEnv,
  grants: TransferGrant[],
  decrypt: (ciphertext: string) => string,
): Record<string, string> {
  const fail = (): never => { throw new Error("ZOHO_BOOTSTRAP_TRANSFER_REJECTED"); };
  if (source.APP_ENV !== "development" || target.APP_ENV !== "production" ||
      target.APP_URL !== "https://bills.voltronix.ae" ||
      ["ZOHO_BOOKS_WRITE_ENABLED", "ZOHO_BOOKS_LIVE_ENABLED", "ALLOW_PRODUCTION_ACCOUNTING_WRITES"]
        .some(key => target[key] !== "false")) fail();
  let sourceDatabase: URL;
  try { sourceDatabase = new URL(source.DATABASE_URL ?? ""); } catch { return fail(); }
  if (sourceDatabase.hostname !== "127.0.0.1" || sourceDatabase.port !== "3308" ||
      sourceDatabase.pathname !== "/voltronix_billing_dev" || sourceDatabase.protocol !== "mysql:") fail();
  const sourceProfiles = getBooksOrganizations(source);
  const targetProfiles = getBooksOrganizations(target);
  if (JSON.stringify(sourceProfiles.map(row => row.organizationId).sort()) !==
      JSON.stringify(targetProfiles.map(row => row.organizationId).sort())) fail();
  const destinations: Array<{ target: Target; organizationId: string }> = [
    ...targetProfiles.map(row => ({ target: "ZOHO" as const, organizationId: row.organizationId })),
    { target: "CRM", organizationId: target.ZOHO_CRM_ORGANIZATION_ID ?? "" },
  ];
  const books: Record<string, string> = {};
  let crm = "";
  for (const identity of destinations) {
    const a = getConfig(identity.target, source, identity.organizationId);
    const b = getConfig(identity.target, target, identity.organizationId);
    const matching = grants.filter(row => row.target === identity.target && row.organizationId === identity.organizationId);
    if (a.environment !== "production" || b.environment !== "production" ||
        connectionFingerprint(a) !== connectionFingerprint(b) || matching.length !== 1) fail();
    const grant = matching[0];
    if (grant.revokedAt || grant.dataCenter !== b.dataCenter ||
        grant.connectionFingerprint !== connectionFingerprint(b)) fail();
    let token: string;
    try { token = decrypt(grant.refreshTokenEncrypted); } catch { return fail(); }
    if (!/^[A-Za-z0-9._~-]{20,4096}$/.test(token) || (b.refreshToken && b.refreshToken !== token)) fail();
    if (identity.target === "ZOHO") books[identity.organizationId] = token;
    else crm = token;
  }
  return {
    ZOHO_BOOKS_REFRESH_TOKEN: "",
    ZOHO_BOOKS_REFRESH_TOKENS_JSON: JSON.stringify(books),
    ZOHO_CRM_REFRESH_TOKEN: crm,
  };
}

/** Preserve every unrelated line; refuse ambiguous or multiline values. */
export function replacePrivateEnvironmentValues(contents: string, values: Record<string, string>): string {
  let result = contents;
  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /['\r\n\0]/.test(value))
      throw new Error("PRIVATE_ENVIRONMENT_UPDATE_REJECTED");
    const pattern = new RegExp(`^${key}=.*$`, "gm");
    const matches = result.match(pattern) ?? [];
    const assignments = result.match(new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=`, "gm")) ?? [];
    const previous = matches[0]?.slice(key.length + 1).trim() ?? "";
    if (matches.length > 1 || assignments.length !== matches.length ||
        ((previous.startsWith("'") || previous.startsWith('"')) && (previous.length < 2 || !previous.endsWith(previous[0]))))
      throw new Error("PRIVATE_ENVIRONMENT_UPDATE_REJECTED");
    const line = `${key}='${value}'`;
    result = matches.length ? result.replace(pattern, () => `${line}${matches[0]?.endsWith("\r") ? "\r" : ""}`)
      : `${result}${result.endsWith("\n") ? "" : newline}${line}${newline}`;
  }
  const before = parse(contents), after = parse(result);
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (after[key] !== (Object.hasOwn(values, key) ? values[key] : before[key]))
      throw new Error("PRIVATE_ENVIRONMENT_UPDATE_REJECTED");
  }
  return result;
}
