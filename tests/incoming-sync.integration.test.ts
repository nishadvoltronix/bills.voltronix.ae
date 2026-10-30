import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { assertIncomingLease, processIncomingSync } from "@/lib/services/incoming-sync";
import { incomingSources } from "@/lib/services/incoming-sync-access";
import type { IncomingSyncInput } from "@/lib/services/incoming-sync-types";
import { assertMySqlTestDatabase, bindTestDestination, createTestCompany } from "./company-fixtures";

const mocks = vi.hoisted(() => ({ books: vi.fn(), attachments: vi.fn(), crm: vi.fn() }));
vi.mock("@/lib/services/incoming-books-sync", () => ({ runIncomingBooksSync: mocks.books, syncIncomingBooksAttachments: mocks.attachments }));
vi.mock("@/lib/services/incoming-crm-sync", () => ({ syncIncomingCrm: mocks.crm }));
vi.mock("@/lib/integrations/oauth", () => ({ accessToken: async () => "fictional-worker-token" }));
const tag = randomUUID().slice(0, 8), organizationId = "98770101";
let actor: Actor, companyId: string;
beforeAll(async () => {
  assertMySqlTestDatabase();
  for (const [key, value] of Object.entries({ INCOMING_SYNC_ENABLED: "true", INCOMING_SYNC_ATTACHMENTS_ENABLED: "false", INCOMING_SYNC_NOT_BEFORE_JSON: "",
    ZOHO_BOOKS_DC: "US", ZOHO_BOOKS_ENVIRONMENT: "production", ZOHO_BOOKS_CLIENT_ID: "fictional-worker-client", ZOHO_BOOKS_CLIENT_SECRET: "fictional-worker-secret",
    ZOHO_BOOKS_ORGANIZATIONS_JSON: JSON.stringify([{ organizationId, name: "Fictional worker company" }]), INTEGRATION_NETWORK_ENABLED: "true", ZOHO_BOOKS_NETWORK_ENABLED: "true",
    ZOHO_BOOKS_WRITE_ENABLED: "false", INTEGRATION_TEST_MODE: "false" })) vi.stubEnv(key, value);
  actor = await db.user.create({ data: { email: `incoming-worker-${tag}@example.invalid`, name: "Fictional worker", role: "ADMIN", passwordHash: "not-a-password" } });
  companyId = (await createTestCompany(`incoming worker ${tag}`, [actor])).id;
  await bindTestDestination(companyId, { target: "ZOHO", organizationId, environment: "production" });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("No provider reads are allowed in worker fixtures."); }));
});
beforeEach(async () => {
  vi.stubEnv("INCOMING_SYNC_INTERVAL_SECONDS", "5");
  vi.stubEnv("INCOMING_SYNC_NOT_BEFORE_JSON", "");
  await db.user.update({ where: { id: actor.id }, data: { role: "ADMIN", active: true } });
  await db.userCompanyMembership.updateMany({ where: { userId: actor.id, companyId }, data: { active: true } });
  await db.incomingSyncState.deleteMany({ where: { target: "ZOHO", organizationId } });
  mocks.books.mockReset(); mocks.attachments.mockReset(); mocks.crm.mockReset();
  mocks.books.mockImplementation(async (input: IncomingSyncInput) => {
    await db.$transaction(tx => input.assertLease(tx));
    return { complete: true, watermark: new Date().toISOString(), reconciled: true, processed: 2 };
  });
});
afterAll(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await db.$disconnect(); });
const state = () => db.incomingSyncState.findFirstOrThrow({ where: { target: "ZOHO", organizationId } });
async function oldIntervalState(data: Prisma.IncomingSyncStateUpdateInput = {}) {
  await processIncomingSync(actor);
  const previous = await state(), lastSuccessAt = new Date(Date.now() - 10_000);
  const saved = await db.incomingSyncState.update({ where: { id: previous.id }, data: {
    lastSuccessAt, nextRunAt: new Date(lastSuccessAt.valueOf() + 300_000), ...data,
  } });
  mocks.books.mockClear();
  return saved;
}

describe("durable incoming worker fencing", () => {
  it("commits freshness and schedules the next read without provider financial writes", async () => {
    expect(await processIncomingSync(actor)).toMatchObject({ enabled: true, processed: 2, sources: 1 });
    const saved = await state();
    expect(saved).toMatchObject({ status: "IDLE", leaseToken: null, leaseExpiresAt: null, failures: 0, processedCount: 2, providerReads: 0 });
    expect(saved.lastSuccessAt).not.toBeNull(); expect(saved.lastReconciledAt).not.toBeNull();
    expect(saved.nextRunAt.valueOf() - saved.lastSuccessAt!.valueOf()).toBe(5000);
    await processIncomingSync(actor); expect(mocks.books).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled();
  });
  it("picks up a successful source still scheduled with the previous five-minute interval", async () => {
    const previous = await oldIntervalState();
    expect(previous.nextRunAt.valueOf()).toBeGreaterThan(Date.now());
    await processIncomingSync(actor);
    const saved = await state();
    expect(mocks.books).toHaveBeenCalledOnce();
    expect(saved.lastSuccessAt!.valueOf()).toBeGreaterThan(previous.lastSuccessAt!.valueOf());
    expect(saved.nextRunAt.valueOf() - saved.lastSuccessAt!.valueOf()).toBe(5000);
    expect(saved.processedCount).toBe(previous.processedCount + 2);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("shortens the old interval without running before five seconds have elapsed", async () => {
    await processIncomingSync(actor);
    const previous = await state(), nextRunAt = new Date(previous.lastSuccessAt!.valueOf() + 5000);
    await db.incomingSyncState.update({ where: { id: previous.id }, data: {
      nextRunAt: new Date(previous.lastSuccessAt!.valueOf() + 300_000),
    } });
    mocks.books.mockClear();
    await processIncomingSync(actor);
    const saved = await state();
    expect(mocks.books).not.toHaveBeenCalled();
    expect(saved).toEqual({ ...previous, nextRunAt, lastHeartbeatAt: saved.lastHeartbeatAt, updatedAt: saved.updatedAt });
  });
  it.each(["RETRY", "BLOCKED", "WAITING_QUOTA", "PENDING"])("preserves a future %s schedule", async status => {
    const until = new Date(Date.now() + 3600_000);
    const previous = await oldIntervalState({ status, nextRunAt: until,
      backoffUntil: status === "WAITING_QUOTA" ? until : null,
      failures: status === "RETRY" ? 2 : 0,
      lastErrorCode: status === "PENDING" ? null : "INCOMING_CHECK_FAILED",
    });
    await processIncomingSync(actor);
    const saved = await state();
    expect(saved).toEqual({ ...previous, lastHeartbeatAt: saved.lastHeartbeatAt, updatedAt: saved.updatedAt });
    expect(mocks.books).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it("leaves an active lease and its existing schedule untouched", async () => {
    const previous = await oldIntervalState({ leaseToken: "existing-owner", leaseExpiresAt: new Date(Date.now() + 60_000) });
    await processIncomingSync(actor);
    const saved = await state();
    expect(saved).toEqual({ ...previous, lastHeartbeatAt: saved.lastHeartbeatAt, updatedAt: saved.updatedAt });
    expect(mocks.books).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves unfinished progress instead of treating it as a successful idle interval", async () => {
    const previous = await oldIntervalState({ checkpoint: { version: 1, page: 2 } });
    await processIncomingSync(actor);
    const saved = await state();
    expect(saved).toEqual({ ...previous, lastHeartbeatAt: saved.lastHeartbeatAt, updatedAt: saved.updatedAt });
    expect(mocks.books).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["configured", "external"] as const)("honors a %s cooldown before shortening a successful source interval", async kind => {
    const previous = await oldIntervalState(), until = new Date(Date.now() + 3600_000);
    if (kind === "configured") vi.stubEnv("INCOMING_SYNC_NOT_BEFORE_JSON", JSON.stringify({ [`ZOHO:${organizationId}`]: until.toISOString() }));
    await processIncomingSync(actor, kind === "external" ? { externalDelay: async () => until } : {});
    expect(await state()).toMatchObject({ status: "WAITING_QUOTA", nextRunAt: until, backoffUntil: until,
      lastSuccessAt: previous.lastSuccessAt, watermark: previous.watermark, checkpoint: previous.checkpoint,
      processedCount: previous.processedCount, providerReads: 0, leaseToken: null, leaseExpiresAt: null,
    });
    expect(mocks.books).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it("persists known source cooldowns without touching OAuth or the provider", async () => {
    const until = new Date(Date.now() + 3600_000);
    await processIncomingSync(actor, { externalDelay: async () => until });
    expect(await state()).toMatchObject({ status: "WAITING_QUOTA", backoffUntil: until, providerReads: 0, lastSuccessAt: null });
    expect(mocks.books).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it("only one simultaneous worker owns a source", async () => {
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { started = resolve; });
    mocks.books.mockImplementation(async (input: IncomingSyncInput) => { await db.$transaction(tx => input.assertLease(tx)); started(); await gate;
      return { complete: true, watermark: new Date().toISOString(), processed: 1 }; });
    const first = processIncomingSync(actor); await entered;
    try { await processIncomingSync(actor); expect(mocks.books).toHaveBeenCalledOnce(); }
    finally { release(); await first; }
    expect((await state()).leaseToken).toBeNull();
  });
  it("a stale token cannot mutate or clear the next owner's lease", async () => {
    await processIncomingSync(actor); const saved = await state(), source = (await incomingSources(actor))[0];
    await db.incomingSyncState.update({ where: { id: saved.id }, data: { leaseToken: "current-owner", leaseExpiresAt: new Date(Date.now() + 60_000) } });
    await expect(db.$transaction(async tx => { await assertIncomingLease(tx, actor, source, saved, "previous-owner");
      await tx.company.update({ where: { id: companyId }, data: { name: "Wrong worker mutation" } }); })).rejects.toMatchObject({ code: "INCOMING_LEASE_LOST" });
    expect((await state()).leaseToken).toBe("current-owner");
    expect((await db.company.findUniqueOrThrow({ where: { id: companyId } })).name).not.toBe("Wrong worker mutation");
  });
  it("revoked membership fences the transaction even with a valid lease token", async () => {
    await processIncomingSync(actor); const saved = await state(), source = (await incomingSources(actor))[0];
    await db.incomingSyncState.update({ where: { id: saved.id }, data: { leaseToken: "owner", leaseExpiresAt: new Date(Date.now() + 60_000) } });
    await db.userCompanyMembership.updateMany({ where: { userId: actor.id, companyId }, data: { active: false } });
    await expect(db.$transaction(tx => assertIncomingLease(tx, actor, source, saved, "owner"))).rejects.toMatchObject({ code: "INCOMING_SOURCE_CHANGED" });
  });
  it("keeps checkpoints and previous success during a failed refresh", async () => {
    await processIncomingSync(actor); const previous = await state();
    await db.incomingSyncState.update({ where: { id: previous.id }, data: { nextRunAt: new Date(0) } });
    mocks.books.mockImplementation(async (input: IncomingSyncInput) => { await input.checkpoint({ version: 1, page: 2 }); throw new Error("private provider body must not escape"); });
    await processIncomingSync(actor);
    const saved = await state();
    expect(saved).toMatchObject({ status: "RETRY", checkpoint: { version: 1, page: 2 }, lastSuccessAt: previous.lastSuccessAt,
      watermark: previous.watermark, leaseToken: null, lastErrorCode: "INCOMING_CHECK_FAILED" });
  });
  it("a misconfigured second source does not block a healthy source", async () => {
    const second = (await createTestCompany(`incoming bad source ${tag}`, [actor])).id;
    await bindTestDestination(second, { target: "ZOHO", organizationId: "98770102", environment: "production" });
    try {
      await processIncomingSync(actor);
      expect((await state()).status).toBe("IDLE");
      expect(mocks.books).toHaveBeenCalledOnce();
      expect(await db.incomingSyncState.findFirstOrThrow({ where: { organizationId: "98770102", target: "ZOHO" } })).toMatchObject({ status: "BLOCKED", providerReads: 0 });
    } finally { await db.company.update({ where: { id: second }, data: { active: false } }); }
  });
});
