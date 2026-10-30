import { describe, expect, it, vi } from "vitest";
import type { ZohoConfig } from "@/lib/integrations/config";
import { IntegrationError } from "@/lib/integrations/config";
import type { Fetch } from "@/lib/integrations/transport";
import { ATTACHMENT_REQUEST_INTERVAL_MS, attachmentBlockedUntil, emptyAttachmentQuota, fetchBooksOriginalAttachment, observeAttachmentQuota, quotaResetTime, runBooksAttachmentDownloads, type AttachmentDownloadState, type AttachmentResponse, type AttachmentWork } from "@/lib/services/books-attachment-download";
import { parseAttachmentDownloadArguments } from "../scripts/lib/books-attachment-state";

vi.mock("@/lib/db", () => ({ db: {} }));
const now = Date.parse("2026-10-29T12:15:34.585Z");
const work = (org = "1001", document = "3001"): AttachmentWork => ({ billId: `local-${org}`, organizationId: org, externalBillId: "2001", externalDocumentId: document });
const response = (status = 200, values: Record<string, string> = {}, code: number | null = null): AttachmentResponse => ({ status, headers: new Headers(values), providerCode: code, bytes: status === 200 ? new Uint8Array([1, 2, 3]) : null });
function stateFor(items: AttachmentWork[]): AttachmentDownloadState {
  const organizations: AttachmentDownloadState["organizations"] = {};
  for (const item of items) {
    organizations[item.organizationId] ??= { expected: 0, available: 0, quota: emptyAttachmentQuota() };
    organizations[item.organizationId].expected++;
  }
  return { version: 1, scopeHash: "a".repeat(64), startedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), status: "RUNNING", providerReads: 0, providerFinancialWrites: 0, expected: items.length, available: 0, pending: items.length, metadataPendingBills: 0, nextResumeAt: null, organizations, failures: [] };
}
function harness(items: AttachmentWork[], request: (item: AttachmentWork) => Promise<AttachmentResponse> = async () => response()) {
  let current = now;
  const starts: Array<{ org: string; at: number }> = [];
  const persisted: AttachmentDownloadState[] = [];
  const save = vi.fn(async () => undefined);
  const dependencies = { now: () => current, stopped: () => false, sleep: async (ms: number) => { current += ms; },
    request: async (item: AttachmentWork) => { starts.push({ org: item.organizationId, at: current }); return request(item); },
    save, persist: async (state: AttachmentDownloadState) => { persisted.push(structuredClone(state)); } };
  return { state: stateFor(items), starts, persisted, save, dependencies };
}

describe("bounded original attachment quota planning", () => {
  it("interprets the observed relative reset header and reserves the last 100 requests", () => {
    expect(quotaResetTime("27866", now)).toBe("2026-10-29T20:00:00.585Z");
    const quota = observeAttachmentQuota(emptyAttachmentQuota(), response(200, { "x-rate-limit-limit": "5000", "x-rate-limit-remaining": "13", "x-rate-limit-reset": "27866" }), now);
    expect(quota).toMatchObject({ remaining: 13, notBefore: "2026-10-29T20:02:00.585Z", reason: "DAILY_QUOTA_RESERVED" });
    expect(attachmentBlockedUntil(quota, now)).toBe(Date.parse(quota.notBefore!));
    expect(attachmentBlockedUntil(quota, Date.parse(quota.notBefore!))).toBeNull();
    expect(quota.remaining).toBeNull();
  });
  it("uses provider Date to avoid network delay and handles epoch reset headers", () => {
    const quota = observeAttachmentQuota(emptyAttachmentQuota(), response(200, { date: "Thu, 29 Oct 2026 12:15:34 GMT", "x-rate-limit-reset": "27866" }), now + 2000);
    expect(quota.resetAt).toBe("2026-10-29T20:00:00.000Z");
    expect(quotaResetTime(String(Date.parse("2026-10-29T20:00:00Z") / 1000), now)).toBe("2026-10-29T20:00:00.000Z");
    expect(quotaResetTime("garbage", now)).toBeNull();
  });
  it("blocks code 45 indefinitely when no safe reset is provided", () => {
    const quota = observeAttachmentQuota(emptyAttachmentQuota(), response(429, {}, 45), now);
    expect(attachmentBlockedUntil(quota, now)).toBe(Infinity);
    expect(quota.notBefore).toBeNull();
  });
  it("does not discard daily remaining counts after a minute cooldown", () => {
    const quota = { ...emptyAttachmentQuota(), remaining: 300, reason: "MINUTE_RATE_LIMIT", notBefore: new Date(now).toISOString() };
    expect(attachmentBlockedUntil(quota, now)).toBeNull();
    expect(quota.remaining).toBe(300);
  });
});

describe("single global one-off attachment downloader", () => {
  it("never probes the reserved organization and finishes available company work before exiting partial", async () => {
    const items = [work("1001"), work("1002"), work("1002", "3002")];
    const run = harness(items);
    run.state.organizations["1001"].quota = { ...emptyAttachmentQuota(), notBefore: "2026-10-29T20:02:01Z", reason: "OPERATOR_NOT_BEFORE" };
    const result = await runBooksAttachmentDownloads(items, run.state, { wait: false }, run.dependencies);
    expect(run.starts.map((row) => row.org)).toEqual(["1002", "1002"]);
    expect(result).toMatchObject({ available: 2, pending: 1, status: "WAITING", nextResumeAt: "2026-10-29T20:02:01.000Z" });
    expect(run.starts[1].at - run.starts[0].at).toBeGreaterThanOrEqual(ATTACHMENT_REQUEST_INTERVAL_MS);
  });
  it("resumes once after the persisted reset and exits when all files finish", async () => {
    const items = [work()];
    const run = harness(items);
    const resume = now + 125_000;
    run.state.organizations["1001"].quota = { ...emptyAttachmentQuota(), remaining: 13, notBefore: new Date(resume).toISOString(), reason: "DAILY_QUOTA_RESERVED" };
    const result = await runBooksAttachmentDownloads(items, run.state, { wait: true }, run.dependencies);
    expect(run.starts).toEqual([{ org: "1001", at: resume }]);
    expect(run.save).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: "COMPLETE", available: 1, pending: 0, providerFinancialWrites: 0 });
  });
  it("uses one rate clock across organizations and no parallel provider calls", async () => {
    const items = [work("1001"), work("1002"), work("1001", "3002"), work("1002", "3002")];
    const run = harness(items);
    await runBooksAttachmentDownloads(items, run.state, { wait: true }, run.dependencies);
    expect(run.starts.map((row) => row.at - now)).toEqual([0, 800, 1600, 2400]);
  });
  it("honors retry-after globally and avoids retrying daily code45", async () => {
    let calls = 0;
    const items = [work("1001"), work("1002")];
    const run = harness(items, async () => ++calls === 1 ? response(429, { "retry-after": "90" }) : response());
    await runBooksAttachmentDownloads(items, run.state, { wait: true }, run.dependencies);
    expect(run.starts[1].at - now).toBe(90_000);
    const daily = harness([work()], async () => response(429, {}, 45));
    await runBooksAttachmentDownloads([work()], daily.state, { wait: true }, daily.dependencies);
    expect(daily.starts).toHaveLength(1);
    expect(daily.state).toMatchObject({ status: "PARTIAL", available: 0, pending: 1 });
  });
  it("imports the last successful response before stopping at the reserve boundary", async () => {
    const items = [work(), work("1001", "3002")];
    const run = harness(items, async () => response(200, { "x-rate-limit-remaining": "100", "x-rate-limit-reset": "27866" }));
    await runBooksAttachmentDownloads(items, run.state, { wait: false }, run.dependencies);
    expect(run.starts).toHaveLength(1);
    expect(run.state.available).toBe(1);
    expect(run.state.pending).toBe(1);
  });
  it("retains failed documents as pending and stops blocked authorization before other requests", async () => {
    const items = [work(), work("1001", "3002")];
    const run = harness(items);
    run.dependencies.save = vi.fn(async () => { throw new Error("Original metadata mismatch"); });
    await runBooksAttachmentDownloads(items, run.state, { wait: false }, run.dependencies);
    expect(run.state).toMatchObject({ status: "PARTIAL", available: 0, pending: 2, failures: [{ code: "ORIGINAL_IMPORT_FAILED" }, { code: "ORIGINAL_IMPORT_FAILED" }] });
    const blocked = harness(items, async () => { throw new IntegrationError("AUTHORIZATION_REQUIRED", "Expired", "BLOCKED"); });
    await expect(runBooksAttachmentDownloads(items, blocked.state, { wait: true }, blocked.dependencies)).rejects.toMatchObject({ code: "AUTHORIZATION_REQUIRED" });
    expect(blocked.starts).toHaveLength(1);
  });
});

describe("exact original file GET and bounded error handling", () => {
  const config = { target: "ZOHO", apiOrigin: "https://www.zohoapis.com", organizationId: "1001", environment: "production", networkEnabled: true, writeEnabled: false } as ZohoConfig;
  it("fetches the nested bill/document endpoint once and rejects redirect following", async () => {
    const fetcher = vi.fn<Fetch>(async () => new Response("%PDF-original", { headers: { "content-type": "application/pdf" } }));
    const result = await fetchBooksOriginalAttachment(config, async () => "fictional-token", work(), fetcher);
    expect(new URL(fetcher.mock.calls[0][0] as unknown as URL).href).toBe("https://www.zohoapis.com/books/v3/bills/2001/documents/3001?organization_id=1001");
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "GET", redirect: "error", cache: "no-store" });
    expect(new TextDecoder().decode(result.bytes!)).toBe("%PDF-original");
  });
  it("consumes a JSON rate error exactly once with no clone and retains its headers", async () => {
    const reply = new Response(JSON.stringify({ code: 45, message: "not returned to operators" }), { status: 429, headers: { "x-rate-limit-remaining": "0" } });
    const clone = vi.spyOn(reply, "clone");
    const result = await fetchBooksOriginalAttachment(config, async () => "fictional-token", work(), async () => reply);
    expect(result).toMatchObject({ status: 429, providerCode: 45, bytes: null });
    expect(clone).not.toHaveBeenCalled();
    expect(reply.bodyUsed).toBe(true);
  });
  it("rejects oversized originals and source overrides without additional network calls", async () => {
    await expect(fetchBooksOriginalAttachment(config, async () => "fictional-token", work(), async () => new Response("bytes", { headers: { "content-length": String(11 * 1024 * 1024) } }))).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
    const fetcher = vi.fn();
    await expect(fetchBooksOriginalAttachment(config, async () => "fictional-token", work("9999"), fetcher)).rejects.toMatchObject({ code: "ATTACHMENT_SOURCE_INVALID" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("explicit resumable downloader options", () => {
  it("accepts a private state and explicit no-probe time without shell credentials", () => {
    const options = parseAttachmentDownloadArguments(["--wait", "--state=.local/private.json", "--organization=828765858", "--not-before-org=828765858:2026-10-29T20:02:01Z"]);
    expect(options).toMatchObject({ wait: true, state: ".local/private.json", organizations: ["828765858"] });
    expect(options.notBefore.get("828765858")).toBe("2026-10-29T20:02:01.000Z");
  });
  it.each([{ args: ["--not-before-org=1001:bad"] }, { args: ["--wait", "--wait"] }, { args: ["--organization=../bad"] }, { args: ["--password=secret"] }, { args: ["--state="] }])("rejects ambiguous or invalid options", ({ args }) => {
    expect(() => parseAttachmentDownloadArguments(args)).toThrow();
  });
});
