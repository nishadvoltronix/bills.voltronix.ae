import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HUB_BILLING_PATH, verifyHubRequest, type HubClaims } from "@/lib/hub-bridge/verify";

const now = Date.UTC(2026, 9, 28, 8);
const environment = { APP_ENV: "test", HUB_BRIDGE_ENABLED: "true", HUB_BRIDGE_ISSUER: "http://127.0.0.1:3100", HUB_BRIDGE_SECRET: "a".repeat(64) };
const claims: HubClaims = { v: 1, iss: environment.HUB_BRIDGE_ISSUER, aud: "voltronix-billing", sub: "77", companyId: "fictional-a",
  crmOrganizationId: "1234", dataCenter: "US", environment: "sandbox", dealId: "9876", jobNumber: "DEMO-77",
  iat: now / 1000, exp: now / 1000 + 30, nonce: "b".repeat(64) };
function request(changes: Record<string, unknown> = {}, path = HUB_BILLING_PATH, method = "POST") {
  const payload = Buffer.from(JSON.stringify({ ...claims, ...changes })).toString("base64url");
  const signature = createHmac("sha256", Buffer.from(environment.HUB_BRIDGE_SECRET, "hex"))
    .update(`v1\nPOST\n${HUB_BILLING_PATH}\n${payload}`).digest("hex");
  return new Request(`http://127.0.0.1:3000${path}`, { method, headers: { authorization: `Billing-HMAC ${payload}.${signature}` } });
}

describe("Hub Billing request authentication", () => {
  it("verifies the exact fixed read contract", () => expect(verifyHubRequest(request(), environment, now)).toEqual(claims));
  it("is disabled without explicit configuration and refuses production loopback", () => {
    expect(() => verifyHubRequest(request(), {}, now)).toThrow("unavailable");
    expect(() => verifyHubRequest(request(), { ...environment, APP_ENV: "production" }, now)).toThrow("unavailable");
  });
  it("rejects altered signatures and requests to another method/path/query", () => {
    const bad = request(); bad.headers.set("authorization", bad.headers.get("authorization")!.slice(0, -1) + "x");
    expect(() => verifyHubRequest(bad, environment, now)).toThrow("not authorized");
    for (const input of [request({}, "/api/bills"), request({}, HUB_BILLING_PATH, "GET"), request({}, HUB_BILLING_PATH + "?company=other")])
      expect(() => verifyHubRequest(input, environment, now)).toThrow("not authorized");
  });
  it("rejects expired, future, excessive lifetime, wrong issuer/audience and additional claims", () => {
    for (const changes of [{ exp: now / 1000 }, { iat: now / 1000 + 6, exp: now / 1000 + 30 },
      { exp: now / 1000 + 31 }, { iss: "https://attacker.invalid" }, { aud: "different" }, { role: "ADMIN" }])
      expect(() => verifyHubRequest(request(changes), environment, now)).toThrow("not authorized");
  });
  it("does not accept cookies, bodies or oversized credentials instead of a signature", () => {
    expect(() => verifyHubRequest(new Request("http://127.0.0.1:3000" + HUB_BILLING_PATH,
      { method: "POST", headers: { cookie: "session=fake" } }), environment, now)).toThrow("not authorized");
    const signed = request();
    expect(() => verifyHubRequest(new Request(signed, { body: "{}" }), environment, now)).toThrow("not authorized");
    signed.headers.set("authorization", "a".repeat(4097));
    expect(() => verifyHubRequest(signed, environment, now)).toThrow("not authorized");
  });
});
