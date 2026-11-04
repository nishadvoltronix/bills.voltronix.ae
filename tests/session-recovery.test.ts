import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "../src/components/api";
import {
  SESSION_REQUIRED_CODE, SESSION_EXPIRED_EVENT, SESSION_RESTORED_EVENT,
  clearSessionRecovery, isLocalApi, isSessionExpired, restoreSession,
} from "../src/lib/session-recovery";

const origin = "https://bills.example.test";
let events: EventTarget;
let fetchMock: ReturnType<typeof vi.fn>;
const unauthorized = (marked = true) => Response.json({ error: "Please sign in to continue.",
  ...(marked ? { code: SESSION_REQUIRED_CODE } : {}) }, { status: 401 });

beforeEach(() => {
  clearSessionRecovery();
  events = new EventTarget();
  vi.stubGlobal("window", Object.assign(events, { location: { href: origin + "/bills/new", origin } }));
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { clearSessionRecovery(); vi.unstubAllGlobals(); });

describe("application session recovery", () => {
  it("coalesces simultaneous protected failures and blocks subsequent API work until recovery", async () => {
    const expired = vi.fn(); events.addEventListener(SESSION_EXPIRED_EVENT, expired);
    fetchMock.mockImplementation(async () => unauthorized());
    const results = await Promise.allSettled([api("/api/companies"), api("/api/bills")]);
    expect(results.every(result => result.status === "rejected" && result.reason instanceof ApiError && result.reason.code === SESSION_REQUIRED_CODE)).toBe(true);
    expect(expired).toHaveBeenCalledTimes(1); expect(isSessionExpired()).toBe(true);
    await expect(api("/api/bills", { method: "POST", body: "{}" })).rejects.toMatchObject({ code: SESSION_REQUIRED_CODE });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 403, 500, 503])("does not treat unmarked %i as session expiry", async status => {
    const expired = vi.fn(); events.addEventListener(SESSION_EXPIRED_EVENT, expired);
    fetchMock.mockResolvedValue(Response.json({ error: "Provider or validation failure" }, { status }));
    await expect(api("/api/bills/options")).rejects.toMatchObject({ status, code: undefined });
    expect(isSessionExpired()).toBe(false); expect(expired).not.toHaveBeenCalled();
  });

  it("does not trust session markers from foreign URLs or non-API paths", async () => {
    fetchMock.mockImplementation(async () => unauthorized());
    for (const url of ["https://provider.example.test/api/foo", "//elsewhere.example.test/api/foo", "/login"])
      await expect(api(url)).rejects.toMatchObject({ code: undefined });
    expect(isSessionExpired()).toBe(false);
    expect(isLocalApi("/api/bills")).toBe(true);
    expect(isLocalApi(origin + "/api/bills")).toBe(true);
  });

  it("ignores a response whose request was cancelled", async () => {
    const controller = new AbortController(); controller.abort();
    fetchMock.mockResolvedValue(unauthorized());
    await expect(api("/api/companies", { signal: controller.signal })).rejects.toMatchObject({ status: 401 });
    expect(isSessionExpired()).toBe(false);
  });

  it("allows explicit sign-in and logout while locked without replaying the failed mutation", async () => {
    fetchMock.mockResolvedValueOnce(unauthorized());
    await expect(api("/api/bills/id/actions", { method: "POST", body: "{}" })).rejects.toBeInstanceOf(ApiError);
    fetchMock.mockResolvedValueOnce(unauthorized(false));
    await expect(api("/api/auth/login", { method: "POST", body: "{}" })).rejects.toMatchObject({ code: undefined });
    expect(isSessionExpired()).toBe(true);
    fetchMock.mockResolvedValueOnce(Response.json({ success: true }));
    await api("/api/auth/logout", { method: "POST" });
    const restored = vi.fn(); events.addEventListener(SESSION_RESTORED_EVENT, restored);
    restoreSession();
    expect(restored).toHaveBeenCalledTimes(1); expect(isSessionExpired()).toBe(false);
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(["/api/bills/id/actions", "/api/auth/login", "/api/auth/logout"]);
  });

  it("does not relock a restored session or replay a late failed write", async () => {
    let resolve!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>(done => { resolve = done; }));
    const pending = api("/api/bills/id", { method: "PATCH", body: "{}" });
    restoreSession(); resolve(unauthorized());
    await expect(pending).rejects.toMatchObject({ code: SESSION_REQUIRED_CODE });
    expect(isSessionExpired()).toBe(false); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
