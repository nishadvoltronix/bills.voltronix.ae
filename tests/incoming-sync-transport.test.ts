import { describe, expect, it, vi } from "vitest";
import type { ZohoConfig } from "@/lib/integrations/config";
import { createIncomingReader, incomingEndpoint, incomingResponseBackoff } from "@/lib/services/incoming-sync-transport";
import { incomingSyncSettings } from "@/lib/services/incoming-sync-config";

vi.mock("@/lib/db", () => ({ db: {} }));
const config = { target: "ZOHO", organizationId: "1001", environment: "production", dataCenter: "US", apiOrigin: "https://www.zohoapis.com",
  networkEnabled: true, writeEnabled: true, testMode: false } as unknown as ZohoConfig;
function harness(response = new Response(JSON.stringify({ code: 0, bills: [] })), options: { maxRequests?: number; config?: ZohoConfig } = {}) {
  let clock = Date.parse("2026-10-29T13:00:00Z");
  const requests: Array<{ url: URL; init?: RequestInit; at: number }> = [];
  const guard = vi.fn(async () => undefined), reserve = vi.fn(async () => undefined), cooldown = vi.fn(async (until: Date) => { expect(Number.isFinite(until.valueOf())).toBe(true); });
  const reader = createIncomingReader({ config: options.config ?? config, guard, reserve, cooldown, maxRequests: options.maxRequests ?? 5,
    token: async () => "test-token", now: () => clock, sleep: async ms => { clock += ms; },
    fetcher: async (url, init) => { requests.push({ url: new URL(url), init, at: clock }); return response.clone(); } });
  return { reader, requests, guard, reserve, cooldown };
}
describe("incoming GET-only source transport", () => {
  it("uses only scoped GET even when outgoing writes are enabled", async () => {
    const run = harness();
    await run.reader.get("/books/v3/bills", { page: "1" });
    expect(run.requests[0].init).toMatchObject({ method: "GET", redirect: "error", cache: "no-store" });
    expect(run.requests[0].url.searchParams.get("organization_id")).toBe("1001");
    expect(run.guard).toHaveBeenCalledTimes(2);
    expect(run.reserve).toHaveBeenCalledOnce();
  });
  it.each(["/books/v3/bills/1/approve", "/books/v3/contacts", "https://example.test", "/books/v3/bills/../organizations", "/crm/v8/Deals"])("rejects unrelated endpoint %s", path => {
    expect(() => incomingEndpoint(config, path, false)).toThrow();
  });
  it("rejects destination or authorization override before touching the provider", async () => {
    const run = harness();
    await expect(run.reader.get("/books/v3/bills", { organization_id: "1002" })).rejects.toMatchObject({ code: "INCOMING_ENDPOINT_REJECTED" });
    await expect(run.reader.get("/books/v3/bills", {}, { Authorization: "other" })).rejects.toMatchObject({ code: "INCOMING_ENDPOINT_REJECTED" });
    expect(run.requests).toHaveLength(0);
  });
  it("paces requests and yields its budget without an extra read", async () => {
    const run = harness(undefined, { maxRequests: 2 });
    await run.reader.get("/books/v3/bills"); await run.reader.get("/books/v3/bills");
    await expect(run.reader.get("/books/v3/bills")).rejects.toMatchObject({ code: "INCOMING_BATCH_YIELDED" });
    expect(run.requests).toHaveLength(2);
    expect(run.requests[1].at - run.requests[0].at).toBe(1100);
  });
  it("honors Retry-After and daily quota reset", () => {
    const now = Date.parse("2026-10-29T13:00:00Z");
    expect(incomingResponseBackoff(new Response("", { status: 429, headers: { "retry-after": "3600" } }), null, now)?.until.toISOString()).toBe("2026-10-29T14:00:00.000Z");
    expect(incomingResponseBackoff(new Response("", { status: 400, headers: { "x-rate-limit-reset": "3600" } }), { code: 45 }, now)?.until.toISOString()).toBe("2026-10-29T14:02:00.000Z");
    expect(incomingResponseBackoff(new Response("", { status: 400 }), { code: 45 }, now)?.until.toISOString()).toBe("2026-10-30T13:00:00.000Z");
  });
  it.each(["100", "0", "-8"])("preserves successful data and waits when the daily balance is %s", async (remaining) => {
    const run = harness(new Response(JSON.stringify({ code: 0, bills: [] }), { headers: { "x-rate-limit-remaining": remaining, "x-rate-limit-reset": "3600" } }));
    await expect(run.reader.get("/books/v3/bills")).resolves.toEqual({ code: 0, bills: [] });
    expect(run.cooldown).toHaveBeenCalledWith(new Date("2026-10-29T14:02:00Z"));
  });
  it("returns null for an unchanged CRM response and forwards its exact conditional header", async () => {
    const run = harness(new Response(null, { status: 204 }), { config: { ...config, target: "CRM" } });
    await expect(run.reader.get("/crm/v8/Deals", {}, { "If-Modified-Since": "2026-10-29T12:00:00Z" })).resolves.toBeNull();
    expect(run.requests[0].url.searchParams.has("organization_id")).toBe(false);
    expect(run.requests[0].init?.headers).toMatchObject({ "If-Modified-Since": "2026-10-29T12:00:00Z" });
  });
  it("distinguishes an expired CRM cursor from unrelated invalid data", async () => {
    const response = (field: string) => new Response(JSON.stringify({ code: "INVALID_DATA", details: { api_name: field } }), { status: 400 });
    const expired = harness(response("page_token"), { config: { ...config, target: "CRM" } });
    await expect(expired.reader.get("/crm/v8/Deals", { page_token: "private" })).rejects.toMatchObject({ code: "INCOMING_CURSOR_EXPIRED" });
    const invalid = harness(response("fields"), { config: { ...config, target: "CRM" } });
    await expect(invalid.reader.get("/crm/v8/Deals", { page_token: "private" })).rejects.toMatchObject({ code: "INCOMING_PROVIDER_REJECTED" });
  });
  it("keeps missing-record and authorization failures distinct", async () => {
    const missing = harness(new Response(JSON.stringify({ code: 1002 }), { status: 400 }));
    await expect(missing.reader.get("/books/v3/bills/123")).rejects.toMatchObject({ code: "INCOMING_REMOTE_NOT_FOUND" });
    const denied = harness(new Response("{}", { status: 403 }));
    await expect(denied.reader.get("/books/v3/bills/123")).rejects.toMatchObject({ code: "INCOMING_AUTHORIZATION_REQUIRED" });
  });
  it("downloads original bytes only through the scoped per-document route", async () => {
    const run = harness(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "application/pdf" } }));
    expect(await run.reader.getBytes("/books/v3/bills/12/documents/34")).toEqual(new Uint8Array([1, 2, 3]));
    await expect(run.reader.getBytes("/books/v3/documents/34")).rejects.toMatchObject({ code: "INCOMING_ENDPOINT_REJECTED" });
  });
  it("bounds polling settings", () => {
    expect(incomingSyncSettings({ NODE_ENV: "test", INCOMING_SYNC_ENABLED: "true" })).toMatchObject({ enabled: true, intervalSeconds: 60, reconcileSeconds: 86400 });
    expect(incomingSyncSettings({ NODE_ENV: "test", INCOMING_SYNC_INTERVAL_SECONDS: "" }).intervalSeconds).toBe(60);
    expect(incomingSyncSettings({ NODE_ENV: "test", INCOMING_SYNC_INTERVAL_SECONDS: "60" }).intervalSeconds).toBe(60);
    expect(incomingSyncSettings({ NODE_ENV: "test", INCOMING_SYNC_INTERVAL_SECONDS: "5" }).intervalSeconds).toBe(5);
    expect(incomingSyncSettings({ NODE_ENV: "test", INCOMING_SYNC_INTERVAL_SECONDS: "300" }).intervalSeconds).toBe(300);
    expect(incomingSyncSettings({ NODE_ENV: "test", INCOMING_SYNC_INTERVAL_SECONDS: "86400" }).intervalSeconds).toBe(86400);
    for (const value of ["4", "5.5", "86401"]) expect(() => incomingSyncSettings({ NODE_ENV: "test", INCOMING_SYNC_INTERVAL_SECONDS: value })).toThrow();
    expect(() => incomingSyncSettings({ NODE_ENV: "test", INCOMING_SYNC_INTERVAL_SECONDS: "0" })).toThrow();
    expect(() => incomingSyncSettings({ NODE_ENV: "test", INCOMING_SYNC_ENABLED: "yes" })).toThrow();
  });
});
