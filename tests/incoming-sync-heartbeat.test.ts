import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingSyncState } from "@prisma/client";

const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), sources: vi.fn(), books: vi.fn(), crm: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { incomingSyncState: { findUnique: mocks.read, updateMany: mocks.write } } }));
vi.mock("@/lib/services/incoming-sync-access", () => ({ incomingSources: mocks.sources, assertIncomingSource: vi.fn() }));
vi.mock("@/lib/services/incoming-books-sync", () => ({ runIncomingBooksSync: mocks.books, syncIncomingBooksAttachments: vi.fn() }));
vi.mock("@/lib/services/incoming-crm-sync", () => ({ syncIncomingCrm: mocks.crm }));
vi.mock("@/lib/integrations/oauth", () => ({ accessToken: vi.fn() }));
vi.mock("@/lib/services/incoming-sync-config", () => ({ incomingSyncSettings: () => ({ enabled: true, intervalSeconds: 60,
  reconcileSeconds: 86400, maxRequests: 40, requestIntervalMs: 1100, leaseSeconds: 180, attachmentsEnabled: false }) }));

import { processIncomingSync } from "@/lib/services/incoming-sync";
const actor = { id: "fictional-worker", email: "worker@example.invalid", name: "Fictional worker", role: "ADMIN" as const };
const source = { target: "ZOHO" as const, companyId: "fictional-company", organizationId: "88701", dataCenter: "US",
  environment: "production", organizationName: "Fictional organization", scopeHash: "a".repeat(64) };
const now = new Date("2026-11-05T06:00:00.000Z");
let state: IncomingSyncState;
const heartbeatWrites = () => mocks.write.mock.calls.filter(([argument]) => argument.data.lastHeartbeatAt && !argument.data.leaseToken);
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
  state = { id: "fictional-source", ...source, status: "BLOCKED", checkpoint: { pendingPage: "x".repeat(292_000) },
    watermark: new Date(0), lastReconciledAt: new Date(0), nextRunAt: new Date(now.valueOf() + 3600_000), backoffUntil: null,
    lastAttemptAt: new Date(0), lastSuccessAt: null, lastHeartbeatAt: new Date(now.valueOf() - 1_000),
    lastErrorCode: "INCOMING_AUTHORIZATION_REQUIRED", failures: 1, processedCount: 10, providerReads: 20,
    leaseToken: null, leaseExpiresAt: null, createdAt: new Date(0), updatedAt: new Date(0) };
  mocks.sources.mockResolvedValue([source]); mocks.read.mockImplementation(async () => state);
  mocks.write.mockImplementation(async ({ data }) => {
    if (data.leaseToken) return { count: 0 }; // The future schedule never matches a claim.
    Object.assign(state, data, { updatedAt: new Date() }); return { count: 1 };
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("bounded incoming source liveness writes", () => {
  it.each(["IDLE", "BLOCKED", "WAITING_QUOTA", "RETRY", "PENDING", "RUNNING"])("does not rewrite a recent %s source or its large checkpoint", async status => {
    state.status = status;
    if (status === "RUNNING") { state.leaseToken = "other-owner"; state.leaseExpiresAt = new Date(now.valueOf() + 180_000); }
    const previous = structuredClone(state);
    await processIncomingSync(actor); await processIncomingSync(actor);
    expect(heartbeatWrites()).toHaveLength(0); expect(state).toEqual(previous);
    expect(mocks.books).not.toHaveBeenCalled(); expect(mocks.crm).not.toHaveBeenCalled();
  });
  it.each([null, new Date(now.valueOf() - 30_000)])("refreshes a missing or due heartbeat with an atomic timestamp predicate: %o", async previous => {
    state.lastHeartbeatAt = previous; const checkpoint = state.checkpoint, schedule = state.nextRunAt;
    await processIncomingSync(actor);
    expect(heartbeatWrites()).toHaveLength(1);
    expect(heartbeatWrites()[0][0]).toEqual({ where: { id: state.id, scopeHash: source.scopeHash,
      OR: [{ lastHeartbeatAt: null }, { lastHeartbeatAt: { lte: new Date(now.valueOf() - 30_000) } }] }, data: { lastHeartbeatAt: now } });
    expect(state.checkpoint).toBe(checkpoint); expect(state.nextRunAt).toBe(schedule); expect(state.status).toBe("BLOCKED");
  });
  it("keeps one-second polling and claim attempts while reducing idle heartbeat changes to once per30s", async () => {
    state.lastHeartbeatAt = now;
    for (let second = 1; second <= 99; second++) { vi.setSystemTime(new Date(now.valueOf() + second * 1000)); await processIncomingSync(actor); }
    expect(heartbeatWrites()).toHaveLength(3);
    expect(heartbeatWrites().map(([argument]) => argument.data.lastHeartbeatAt.valueOf() - now.valueOf())).toEqual([30_000, 60_000, 90_000]);
    expect(mocks.write.mock.calls.filter(([argument]) => argument.data.leaseToken)).toHaveLength(99);
    expect(state.checkpoint).toEqual({ pendingPage: "x".repeat(292_000) }); expect(state.providerReads).toBe(20); expect(state.processedCount).toBe(10);
  });
  it("still blocks a changed source immediately, then suppresses identical blocked rewrites", async () => {
    state.scopeHash = "f".repeat(64); state.status = "IDLE"; state.lastErrorCode = null; state.lastHeartbeatAt = now;
    await processIncomingSync(actor);
    expect(state.status).toBe("BLOCKED"); expect(state.lastErrorCode).toBe("INCOMING_SOURCE_CHANGED");
    expect(heartbeatWrites()).toHaveLength(1); const previous = structuredClone(state);
    vi.setSystemTime(new Date(now.valueOf() + 29_999)); await processIncomingSync(actor);
    expect(heartbeatWrites()).toHaveLength(1); expect(state).toEqual(previous);
    vi.setSystemTime(new Date(now.valueOf() + 30_000)); await processIncomingSync(actor);
    expect(heartbeatWrites()).toHaveLength(2);
    expect(heartbeatWrites()[0][0].where).toMatchObject({ id: state.id,
      OR: [{ leaseToken: null }, { leaseExpiresAt: { lt: now } }], AND: [{ OR: expect.arrayContaining([{ status: { not: "BLOCKED" } }, { lastErrorCode: null }]) }] });
    expect(mocks.books).not.toHaveBeenCalled();
  });
});
