import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingSyncStatus } from "@/lib/incoming-sync-types";

const mocks = vi.hoisted(() => ({ role: "ADMIN", useApi: vi.fn() }));
vi.mock("@/components/app-shell", () => ({ useUser: () => ({ id: "fixture-reader", role: mocks.role }) }));
vi.mock("@/components/api", () => ({ useApi: mocks.useApi }));
import { IncomingSyncRefresh, IncomingSyncStatusPanel } from "@/components/incoming-sync-status";

const saved: IncomingSyncStatus = { generatedAt: "2026-11-05T08:00:00Z", enabled: true, workerAlive: true,
  lastHeartbeatAt: "2026-11-05T07:59:55Z", pollIntervalSeconds: 5, sources: [{
    id: "fixture-source", kind: "BOOKS", companyId: "fixture-company", companyName: "Private source metadata",
    status: "IDLE", lastSuccessAt: "2026-11-05T07:59:50Z", nextRunAt: "2026-11-05T08:00:05Z",
    backoffUntil: null, isStale: false, message: "Private scheduled source", processedCount: 123,
  }] };
const state = () => ({ data: saved, error: null, refreshError: null, errorStatus: null as number | null,
  refreshing: false, loading: false, reload: vi.fn() });
beforeEach(() => { mocks.role = "ADMIN"; mocks.useApi.mockReset().mockReturnValue(state()); });

describe("incoming status client permissions", () => {
  it.each(["ACCOUNTS", "DATA_ENTRY"])("%s cannot request or render source status even if stale data exists", role => {
    mocks.role = role;
    expect(renderToStaticMarkup(createElement(IncomingSyncRefresh))).toBe("");
    expect(renderToStaticMarkup(createElement(IncomingSyncStatusPanel))).toBe("");
    expect(mocks.useApi.mock.calls.every(call => call[0] === null)).toBe(true);
  });

  it.each(["ADMIN", "MANAGEMENT"])("%s keeps the authorized company-scoped status read", role => {
    mocks.role = role;
    const html = renderToStaticMarkup(createElement(IncomingSyncStatusPanel, { companyId: "fixture-company" }));
    expect(html).toContain("Incoming Zoho updates"); expect(html).toContain("Private source metadata");
    expect(mocks.useApi).toHaveBeenCalledWith("/api/integrations/incoming-status?companyId=fixture-company", { keepPreviousData: true });
  });

  it.each([403, 404])("a denied status read (%s) shows an actionable notice without retained source data", errorStatus => {
    mocks.useApi.mockReturnValue({ ...state(), errorStatus });
    for (const Component of [IncomingSyncRefresh, IncomingSyncStatusPanel]) {
      const html = renderToStaticMarkup(createElement(Component));
      expect(html).toContain("Automatic refresh paused."); expect(html).toContain("Retry status check");
      expect(html).not.toContain("Private source metadata"); expect(html).not.toContain("Private scheduled source");
      expect(html).not.toContain("Source schedules");
    }
  });

  it("a transient error keeps authorized stale-status labeling instead of an access denial", () => {
    mocks.useApi.mockReturnValue({ ...state(), errorStatus: 503, refreshError: "Temporarily unavailable" });
    const html = renderToStaticMarkup(createElement(IncomingSyncStatusPanel));
    expect(html).toContain("Status refresh failed"); expect(html).toContain("current progress is unconfirmed");
    expect(html).not.toContain("Automatic refresh paused.");
  });
});
