import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { HttpError } from "@/lib/http";

export const HUB_BILLING_PATH = "/api/hub/job-billing";
export const HUB_BILLING_AUDIENCE = "voltronix-billing";
export const hubClaimsSchema = z.object({
  v: z.literal(1),
  iss: z.string().max(191),
  aud: z.literal(HUB_BILLING_AUDIENCE),
  sub: z.string().regex(/^[A-Za-z0-9._:-]{1,191}$/),
  companyId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  crmOrganizationId: z.string().regex(/^[0-9]{1,30}$/),
  dataCenter: z.enum(["US", "EU", "IN", "AU", "JP", "CA", "CN", "SA", "AE"]),
  environment: z.enum(["sandbox", "production"]),
  dealId: z.string().regex(/^[0-9]{1,30}$/),
  jobNumber: z.string().trim().min(1).max(80),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().nonnegative(),
  nonce: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type HubClaims = z.infer<typeof hubClaimsSchema>;

function configuredIssuer(value: string | undefined, local: boolean): string {
  const url = new URL(value ?? "");
  const allowed = url.protocol === "https:" && url.hostname === "hub.voltronix.ae" && !url.port;
  const loopback = local && url.protocol === "http:" && url.hostname === "127.0.0.1" && Number(url.port) >= 1024;
  if ((!allowed && !loopback) || url.origin !== value || url.username || url.password)
    throw new Error("Invalid bridge issuer.");
  return value!;
}

/** Authenticate only this fixed server-to-server read operation, never a cookie. */
export function verifyHubRequest(request: Request, env: Record<string, string | undefined> = process.env, now = Date.now()): HubClaims {
  let issuer: string;
  if (env.HUB_BRIDGE_ENABLED !== "true") throw new HttpError(503, "Billing connection unavailable.");
  try {
    issuer = configuredIssuer(env.HUB_BRIDGE_ISSUER, ["development", "test"].includes(env.APP_ENV ?? ""));
    if (!/^[a-f0-9]{64}$/i.test(env.HUB_BRIDGE_SECRET ?? "")) throw new Error();
  } catch { throw new HttpError(503, "Billing connection unavailable."); }
  const invalid = () => new HttpError(401, "Billing request not authorized.");
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== HUB_BILLING_PATH || url.search || request.body !== null)
    throw invalid();
  const header = request.headers.get("authorization") ?? "";
  if (header.length > 4096) throw invalid();
  const match = /^Billing-HMAC ([A-Za-z0-9_-]{1,3000})\.([a-f0-9]{64})$/.exec(header);
  if (!match) throw invalid();
  const [, payload, signature] = match;
  const expected = createHmac("sha256", Buffer.from(env.HUB_BRIDGE_SECRET!, "hex"))
    .update(`v1\nPOST\n${HUB_BILLING_PATH}\n${payload}`).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) throw invalid();
  let claims: HubClaims;
  try {
    const raw = Buffer.from(payload, "base64url");
    if (raw.toString("base64url") !== payload) throw new Error();
    claims = hubClaimsSchema.parse(JSON.parse(raw.toString("utf8")));
  } catch { throw invalid(); }
  const seconds = Math.floor(now / 1000);
  if (claims.iss !== issuer || claims.iat > seconds + 5 || claims.exp <= seconds ||
    claims.exp <= claims.iat || claims.exp - claims.iat > 30 || claims.iat < seconds - 30)
    throw invalid();
  return claims;
}

export function hubNonceHash(claims: HubClaims): string {
  return createHash("sha256").update(`${claims.iss}\n${claims.nonce}`).digest("hex");
}
