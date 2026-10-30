import "server-only";
import { assertNetwork, IntegrationError, type ZohoConfig } from "@/lib/integrations/config";
import { boundedBytes, boundedJson } from "@/lib/integrations/response";
import { retryAfterSeconds, type Fetch } from "@/lib/integrations/transport";
import { MAX_DOCUMENT_BYTES } from "@/lib/services/documents";

export const ATTACHMENT_REQUEST_INTERVAL_MS = 800;
export const ATTACHMENT_DAILY_RESERVE = 100;
export const ATTACHMENT_RESET_BUFFER_MS = 120_000;
export type AttachmentQuota = { limit: number | null; remaining: number | null; resetAt: string | null; observedAt: string | null; notBefore: string | null; reason: string | null };
export const emptyAttachmentQuota = (): AttachmentQuota => ({ limit: null, remaining: null, resetAt: null, observedAt: null, notBefore: null, reason: null });
export type AttachmentWork = { billId: string; organizationId: string; externalBillId: string; externalDocumentId: string };
export type AttachmentResponse = { status: number; providerCode: number | null; headers: Headers; bytes: Uint8Array | null };

function integer(value: string | null) {
  return value !== null && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
}

/** Zoho currently reports reset as seconds remaining; epoch/HTTP timestamps are accepted too. */
export function quotaResetTime(value: string | null, now: number): string | null {
  if (!value) return null;
  const numeric = integer(value);
  const millis = numeric === null ? Date.parse(value) : numeric > 1_000_000_000_000 ? numeric : numeric > 1_000_000_000 ? numeric * 1000 : now + numeric * 1000;
  return Number.isFinite(millis) && millis >= now - 60_000 && millis <= now + 7 * 86_400_000 ? new Date(millis).toISOString() : null;
}

export function observeAttachmentQuota(previous: AttachmentQuota, response: AttachmentResponse, now: number): AttachmentQuota {
  const date = Date.parse(response.headers.get("date") ?? "");
  const serverNow = Number.isFinite(date) && Math.abs(date - now) < 300_000 ? date : now;
  const remaining = integer(response.headers.get("x-rate-limit-remaining"));
  const updated: AttachmentQuota = { ...previous,
    limit: integer(response.headers.get("x-rate-limit-limit")) ?? previous.limit,
    remaining: remaining ?? (previous.remaining === null ? null : Math.max(0, previous.remaining - 1)),
    resetAt: quotaResetTime(response.headers.get("x-rate-limit-reset"), serverNow) ?? previous.resetAt,
    observedAt: new Date(now).toISOString() };
  if (response.providerCode === 45 || updated.remaining !== null && updated.remaining <= ATTACHMENT_DAILY_RESERVE) {
    updated.reason = "DAILY_QUOTA_RESERVED";
    updated.notBefore = updated.resetAt ? new Date(Date.parse(updated.resetAt) + ATTACHMENT_RESET_BUFFER_MS).toISOString() : null;
  }
  return updated;
}

/** Returns null when allowed, infinity when the provider omitted a safe reset time. */
export function attachmentBlockedUntil(quota: AttachmentQuota, now: number): number | null {
  if (!quota.notBefore && quota.remaining !== null && quota.remaining <= ATTACHMENT_DAILY_RESERVE) {
    quota.reason = "DAILY_QUOTA_RESERVED";
    quota.notBefore = quota.resetAt ? new Date(Date.parse(quota.resetAt) + ATTACHMENT_RESET_BUFFER_MS).toISOString() : null;
  }
  if (quota.notBefore) {
    const at = Date.parse(quota.notBefore);
    if (at > now) return at;
    if (quota.reason === "DAILY_QUOTA_RESERVED" || quota.reason === "OPERATOR_NOT_BEFORE") {
      quota.remaining = null;
      quota.resetAt = null;
    }
    quota.notBefore = null;
    quota.reason = null;
    return null;
  }
  if (quota.reason === "DAILY_QUOTA_RESERVED") return Infinity;
  return null;
}

/** Exactly one original bill document GET; bounded, single body consumption, no redirect or provider write. */
export async function fetchBooksOriginalAttachment(config: ZohoConfig, token: () => Promise<string>, item: AttachmentWork, fetcher: Fetch = fetch): Promise<AttachmentResponse> {
  assertNetwork(config);
  if (config.target !== "ZOHO" || config.environment !== "production" || config.writeEnabled || config.organizationId !== item.organizationId ||
    !/^\d{1,30}$/.test(item.externalBillId) || !/^\d{1,30}$/.test(item.externalDocumentId))
    throw new IntegrationError("ATTACHMENT_SOURCE_INVALID", "The read-only original attachment source is invalid.", "BLOCKED");
  const endpoint = `/books/v3/bills/${item.externalBillId}/documents/${item.externalDocumentId}`;
  const url = new URL(endpoint, config.apiOrigin);
  if (url.origin !== config.apiOrigin || url.pathname !== endpoint) throw new IntegrationError("ATTACHMENT_SOURCE_INVALID", "The original attachment endpoint is invalid.", "BLOCKED");
  url.searchParams.set("organization_id", item.organizationId);
  const authorization = `Zoho-oauthtoken ${await token()}`;
  let response: Response;
  try {
    response = await fetcher(url, { method: "GET", headers: { Authorization: authorization }, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(25_000) });
  } catch {
    throw new IntegrationError("REQUEST_INTERRUPTED", "The original attachment could not be reached.", "RETRY");
  }
  if (!response.ok || response.headers.get("content-type")?.toLowerCase().includes("json")) {
    let providerCode: number | null = null;
    try {
      const body = await boundedJson(response, 16 * 1024);
      if (body && typeof body === "object" && "code" in body && Number.isSafeInteger(Number(body.code))) providerCode = Number(body.code);
    } catch { /* HTTP status and headers remain usable even if an error body is invalid. */ }
    return { status: response.status, providerCode, headers: response.headers, bytes: null };
  }
  return { status: response.status, providerCode: null, headers: response.headers, bytes: await boundedBytes(response, MAX_DOCUMENT_BYTES) };
}

export type AttachmentDownloadState = {
  version: 1; scopeHash: string; startedAt: string; updatedAt: string;
  status: "RUNNING" | "WAITING" | "PARTIAL" | "COMPLETE" | "INTERRUPTED";
  providerReads: number; providerFinancialWrites: 0; expected: number; available: number; pending: number;
  metadataPendingBills: number; nextResumeAt: string | null;
  organizations: Record<string, { expected: number; available: number; quota: AttachmentQuota }>;
  failures: Array<{ billId: string; externalDocumentId: string; code: string }>;
};
export type DownloadDependencies = {
  now(): number; sleep(milliseconds: number): Promise<void>; stopped(): boolean;
  request(item: AttachmentWork): Promise<AttachmentResponse>;
  save(item: AttachmentWork, bytes: Uint8Array): Promise<void>;
  persist(state: AttachmentDownloadState): Promise<void>;
};

/** One worker shared by every company. Completion is a one-off drain, never a recurring sync. */
export async function runBooksAttachmentDownloads(work: AttachmentWork[], state: AttachmentDownloadState, options: { wait: boolean }, dependencies: DownloadDependencies) {
  const pending = [...work];
  const attempts = new Map<string, number>();
  let lastRequestAt = -Infinity;
  const persist = async () => { state.updatedAt = new Date(dependencies.now()).toISOString(); state.pending = state.expected - state.available; await dependencies.persist(state); };
  while (pending.length > 0 && !dependencies.stopped()) {
    const now = dependencies.now();
    let earliest = Infinity;
    const index = pending.findIndex((item) => {
      const blocked = attachmentBlockedUntil(state.organizations[item.organizationId].quota, now);
      if (blocked === null) return true;
      earliest = Math.min(earliest, blocked);
      return false;
    });
    if (index < 0) {
      state.status = "WAITING";
      state.nextResumeAt = Number.isFinite(earliest) ? new Date(earliest).toISOString() : null;
      await persist();
      if (!options.wait || !Number.isFinite(earliest)) break;
      await dependencies.sleep(Math.max(1, Math.min(60_000, earliest - now)));
      continue;
    }
    state.status = "RUNNING";
    state.nextResumeAt = null;
    const item = pending[index];
    const gap = lastRequestAt + ATTACHMENT_REQUEST_INTERVAL_MS - now;
    if (gap > 0) { await dependencies.sleep(gap); continue; }
    lastRequestAt = dependencies.now();
    const key = `${item.billId}:${item.externalDocumentId}`;
    state.providerReads++;
    await persist(); // A restart never forgets that this request may have consumed quota.
    try {
      const response = await dependencies.request(item);
      const org = state.organizations[item.organizationId];
      org.quota = observeAttachmentQuota(org.quota, response, dependencies.now());
      if (response.providerCode === 45) { await persist(); continue; }
      if (response.status === 429) {
        const resume = dependencies.now() + Math.max(65, retryAfterSeconds(response.headers.get("retry-after"), dependencies.now())) * 1000;
        for (const group of Object.values(state.organizations)) {
          if (group.quota.reason !== "DAILY_QUOTA_RESERVED" && (!group.quota.notBefore || Date.parse(group.quota.notBefore) < resume)) {
            group.quota.notBefore = new Date(resume).toISOString(); group.quota.reason = "MINUTE_RATE_LIMIT";
          }
        }
        await persist();
        continue;
      }
      if (response.status === 401 || response.status === 403) throw new IntegrationError("AUTHORIZATION_REQUIRED", "Books attachment authorization needs review.", "BLOCKED");
      if (response.status === 408 || response.status >= 500) throw new IntegrationError("REMOTE_UNAVAILABLE", "The original attachment is temporarily unavailable.", "RETRY");
      if (!response.bytes || response.status < 200 || response.status >= 300) throw new IntegrationError("ORIGINAL_DOWNLOAD_REJECTED", "Books did not return original attachment bytes.", "FAILED");
      await dependencies.save(item, response.bytes);
      pending.splice(index, 1);
      state.available++;
      org.available++;
      attempts.delete(key);
    } catch (error) {
      const count = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, count);
      if (error instanceof IntegrationError && error.kind === "BLOCKED") throw error;
      if (error && typeof error === "object" && "status" in error && [401, 403].includes(Number(error.status))) throw error;
      if (error instanceof IntegrationError && error.kind === "RETRY" && count < 3) {
        await dependencies.sleep(Math.min(60_000, count * 10_000));
      } else {
        state.failures.push({ billId: item.billId, externalDocumentId: item.externalDocumentId,
          code: error instanceof IntegrationError ? error.code : "ORIGINAL_IMPORT_FAILED" });
        pending.splice(index, 1);
      }
    }
    await persist();
  }
  state.status = dependencies.stopped() ? "INTERRUPTED" : state.available === state.expected && state.metadataPendingBills === 0 ? "COMPLETE" : state.nextResumeAt ? "WAITING" : "PARTIAL";
  await persist();
  return state;
}
