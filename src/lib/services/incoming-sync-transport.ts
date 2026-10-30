import "server-only";
import { setTimeout as delay } from "node:timers/promises";
import { assertNetwork, IntegrationError, type ZohoConfig } from "@/lib/integrations/config";
import { boundedBytes, boundedJson } from "@/lib/integrations/response";
import { retryAfterSeconds, type Fetch } from "@/lib/integrations/transport";
import { quotaResetTime } from "./books-attachment-download";
import { MAX_DOCUMENT_BYTES } from "./documents";

export class IncomingQuotaError extends IntegrationError {
  constructor(public readonly until: Date, code = "INCOMING_RATE_LIMIT") {
    super(code, "The provider limited incoming reads. Automatic retry is scheduled.", "RETRY");
  }
}
export class IncomingBudgetError extends IntegrationError {
  constructor() { super("INCOMING_BATCH_YIELDED", "The incoming batch will continue from its saved progress.", "RETRY", 5); }
}
export function incomingEndpoint(config: ZohoConfig, path: string, binary: boolean) {
  const moduleName = config.crmMapping?.jobModule ?? "Deals";
  const allowed = config.target === "ZOHO"
    ? binary ? /^\/books\/v3\/bills\/\d{1,30}\/documents\/\d{1,30}$/.test(path)
      : /^\/books\/v3\/bills(?:\/\d{1,30})?$/.test(path) || path === `/books/v3/organizations/${config.organizationId}`
    : !binary && (path === "/crm/v8/org" || path === `/crm/v8/${moduleName}` || path === `/crm/v8/${moduleName}/deleted` || new RegExp(`^/crm/v8/${moduleName}/\\d{1,30}$`).test(path));
  if (!allowed || !/^\/[A-Za-z0-9_/]+$/.test(path))
    throw new IntegrationError("INCOMING_ENDPOINT_REJECTED", "Only configured source read endpoints are permitted.", "BLOCKED");
}
export function incomingResponseBackoff(response: Response, body: unknown, now: number): IncomingQuotaError | null {
  const code = body && typeof body === "object" && "code" in body ? String(body.code) : "";
  if (code === "45") {
    const reset = quotaResetTime(response.headers.get("x-rate-limit-reset"), now);
    // An unknown daily reset receives a conservative full-day cooldown, never repeated probing.
    return new IncomingQuotaError(new Date(reset ? Date.parse(reset) + 120_000 : now + 86_400_000), "INCOMING_DAILY_QUOTA");
  }
  if (response.status === 429 || code === "TOO_MANY_REQUESTS")
    return new IncomingQuotaError(new Date(now + Math.max(65, retryAfterSeconds(response.headers.get("retry-after"), now)) * 1000));
  return null;
}

export function createIncomingReader(options: {
  config: ZohoConfig;
  token(): Promise<string>;
  guard(): Promise<void>;
  reserve(): Promise<void>;
  cooldown(until: Date): Promise<void>;
  maxRequests: number;
  intervalMs?: number;
  signal?: AbortSignal;
  fetcher?: Fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}) {
  let requests = 0, lastRequest = -Infinity;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (async ms => { await delay(ms, undefined, { signal: options.signal }); });
  async function request(path: string, query: Record<string, string> = {}, headers: Record<string, string> = {}, binary = false): Promise<unknown> {
    const config = options.config;
    assertNetwork(config);
    incomingEndpoint(config, path, binary);
    if (Object.hasOwn(query, "organization_id") || Object.keys(headers).some(key => key !== "If-Modified-Since"))
      throw new IntegrationError("INCOMING_ENDPOINT_REJECTED", "Source identity and authorization cannot be overridden.", "BLOCKED");
    if (requests >= options.maxRequests || options.signal?.aborted) throw new IncomingBudgetError();
    await options.guard();
    const gap = lastRequest + (options.intervalMs ?? 1100) - now();
    if (gap > 0) await sleep(gap);
    const token = await options.token();
    await options.guard();
    await options.reserve();
    requests++; lastRequest = now();
    const url = new URL(path, config.apiOrigin);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    if (config.target === "ZOHO") url.searchParams.set("organization_id", config.organizationId);
    let response: Response;
    try {
      response = await (options.fetcher ?? fetch)(url, { method: "GET", headers: { Authorization: `Zoho-oauthtoken ${token}`, ...headers },
        redirect: "error", cache: "no-store", signal: AbortSignal.any([AbortSignal.timeout(25_000), ...(options.signal ? [options.signal] : [])]) });
    } catch { throw new IntegrationError("INCOMING_NETWORK_UNAVAILABLE", "The source could not be reached. Retry is scheduled.", "RETRY"); }
    let body: unknown = null;
    const original = binary && response.ok && !response.headers.get("content-type")?.toLowerCase().includes("json");
    if (!original && response.status !== 204 && response.status !== 304) {
      try { body = await boundedJson(response, 8 * 1024 * 1024); }
      catch (error) { if (response.ok) throw error; }
    }
    const quota = incomingResponseBackoff(response, body, now());
    if (quota) { await options.cooldown(quota.until); throw quota; }
    const remaining = response.headers.get("x-rate-limit-remaining");
    // Zoho can return a successful response with a negative daily balance.
    // That is exhausted quota, not missing quota metadata.
    if (config.target === "ZOHO" && remaining !== null && /^-?\d+$/.test(remaining) && Number(remaining) <= 100) {
      const reset = quotaResetTime(response.headers.get("x-rate-limit-reset"), now());
      await options.cooldown(new Date(reset ? Date.parse(reset) + 120_000 : now() + 86_400_000));
    }
    const code = body && typeof body === "object" && "code" in body ? String(body.code) : "";
    const details = body && typeof body === "object" && "details" in body && body.details && typeof body.details === "object" ? body.details as Record<string, unknown> : {};
    if (config.target === "CRM" && query.page_token && (code === "EXPIRED_VALUE" || code === "TOKEN_BOUND_DATA_MISMATCH" || code === "INVALID_DATA" && details.api_name === "page_token"))
      throw new IntegrationError("INCOMING_CURSOR_EXPIRED", "The source cursor expired; restart the scan from its safe watermark.", "RETRY");
    if (/\/(?:bills|[A-Za-z][A-Za-z0-9_]*)\/\d+$/.test(path) && (response.status === 404 || config.target === "ZOHO" && code === "1002"))
      throw new IntegrationError("INCOMING_REMOTE_NOT_FOUND", "The verified source record no longer exists.", "FAILED");
    if (response.status === 401 || response.status === 403)
      throw new IntegrationError("INCOMING_AUTHORIZATION_REQUIRED", "Source authorization needs review.", "BLOCKED");
    if (response.status === 408 || response.status >= 500)
      throw new IntegrationError("INCOMING_REMOTE_UNAVAILABLE", "The provider is temporarily unavailable.", "RETRY");
    if (!response.ok && response.status !== 304 || config.target === "ZOHO" && code && code !== "0")
      throw new IntegrationError("INCOMING_PROVIDER_REJECTED", "The provider rejected this source read.", "BLOCKED");
    if (original) return boundedBytes(response, MAX_DOCUMENT_BYTES);
    if (binary) throw new IntegrationError("INCOMING_ORIGINAL_INVALID", "The source did not return original document bytes.", "FAILED");
    return body;
  }
  return { get: (path: string, query?: Record<string, string>, headers?: Record<string, string>) => request(path, query, headers),
    getBytes: async (path: string) => await request(path, {}, {}, true) as Uint8Array,
    remaining: () => Math.max(0, options.maxRequests - requests) };
}
