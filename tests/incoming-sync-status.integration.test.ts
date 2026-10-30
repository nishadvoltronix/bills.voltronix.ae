import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
import type { IncomingSyncStatus } from "@/lib/incoming-sync-types";
import { db } from "@/lib/db";
import { getIncomingSyncStatus } from "@/lib/services/incoming-sync-status";
import { assertMySqlTestDatabase, bindTestDestination, createTestCompany } from "./company-fixtures";

const tag = randomUUID().slice(0, 8);
const organizationBase = `99884${Number.parseInt(tag, 16)}`;
const booksA = `${organizationBase}1`, booksB = `${organizationBase}2`, booksC = `${organizationBase}3`;
const crmOrganization = `${organizationBase}4`;
const stateIds = { booksA: `incoming-status-${tag}-books-a`, booksB: `incoming-status-${tag}-books-b`,
  booksC: `incoming-status-${tag}-books-c`, crm: `incoming-status-${tag}-crm`, otherDc: `incoming-status-${tag}-crm-eu` };
const privateValues = { scopeHash: "d".repeat(64), leaseToken: `fictional-private-lease-${tag}`,
  providerError: `FICTIONAL_PRIVATE_PROVIDER_ERROR_${tag}`, cursor: `fictional-private-cursor-${tag}` };
let admin: Actor, reader: Actor, accounts: Actor, entry: Actor, outsider: Actor;
let companyA: Awaited<ReturnType<typeof createTestCompany>>,
  companyB: Awaited<ReturnType<typeof createTestCompany>>,
  companyC: Awaited<ReturnType<typeof createTestCompany>>;
let lastSuccess: Date, nextRun: Date;
const ids = (result: IncomingSyncStatus) => result.sources.map(source => source.id).sort();

beforeAll(async () => {
  assertMySqlTestDatabase();
  vi.stubEnv("INCOMING_SYNC_ENABLED", "true");
  vi.stubEnv("INCOMING_SYNC_INTERVAL_SECONDS", "300");
  vi.stubEnv("INCOMING_SYNC_RECONCILE_SECONDS", "86400");
  vi.stubEnv("INCOMING_SYNC_MAX_REQUESTS", "40");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Status reads must not contact a provider."); }));
  [admin, reader, accounts, entry, outsider] = await Promise.all(
    (["ADMIN", "MANAGEMENT", "ACCOUNTS", "DATA_ENTRY", "ADMIN"] as const).map((role, index) =>
      db.user.create({ data: { name: `Fictional incoming status reader ${index}`, role,
        email: `incoming-status-${tag}-${index}@example.invalid`, passwordHash: "unusable-status-fixture" } })));
  companyA = await createTestCompany(`incoming status Alpha ${tag}`, [admin, reader, entry]);
  companyB = await createTestCompany(`incoming status Beta ${tag}`, [admin, accounts]);
  companyC = await createTestCompany(`incoming status Private ${tag}`, [outsider]);
  for (const [companyId, organizationId] of [[companyA.id, booksA], [companyB.id, booksB], [companyC.id, booksC]])
    await bindTestDestination(companyId, { target: "ZOHO", organizationId, environment: "production" });
  for (const company of [companyA, companyB])
    await db.companyCrmSource.create({ data: { companyId: company.id, organizationId: crmOrganization,
      dataCenter: "US", environment: "production" } });
  const now = new Date();
  lastSuccess = new Date(now.valueOf() - 3_600_000);
  nextRun = new Date(now.valueOf() + 3_600_000);
  // Satisfy the migration's source CHECK (Books has a company; shared CRM does not),
  // paired lease fields, permitted statuses, and nonnegative progress counters.
  const common = { dataCenter: "US", environment: "production", scopeHash: privateValues.scopeHash,
    checkpoint: { cursor: privateValues.cursor, providerResponse: "fictional-private-provider-payload" },
    watermark: lastSuccess, lastReconciledAt: lastSuccess, nextRunAt: nextRun,
    lastHeartbeatAt: now, lastAttemptAt: now, lastErrorCode: privateValues.providerError,
    leaseToken: privateValues.leaseToken, leaseExpiresAt: nextRun, failures: 2, providerReads: 97 };
  await db.incomingSyncState.createMany({ data: [
    { ...common, id: stateIds.booksA, target: "ZOHO", organizationId: booksA, companyId: companyA.id,
      status: "WAITING_QUOTA", backoffUntil: nextRun, lastSuccessAt: lastSuccess, processedCount: 17 },
    { ...common, id: stateIds.booksB, target: "ZOHO", organizationId: booksB, companyId: companyB.id,
      status: "IDLE", lastSuccessAt: now, processedCount: 0 },
    { ...common, id: stateIds.booksC, target: "ZOHO", organizationId: booksC, companyId: companyC.id,
      status: "RUNNING", processedCount: 37 },
    { ...common, id: stateIds.crm, target: "CRM", organizationId: crmOrganization, companyId: null,
      status: "PENDING", processedCount: 987654321 },
    { ...common, id: stateIds.otherDc, target: "CRM", organizationId: crmOrganization, companyId: null,
      dataCenter: "EU", status: "BLOCKED", processedCount: 999 },
  ] });
});

afterAll(async () => {
  if (vi.isMockFunction(fetch)) expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await db.$disconnect();
});

describe("saved incoming synchronization status on disposable MySQL", () => {
  it("reports actual saved Books progress, quota and freshness without changing source state", async () => {
    const before = await db.incomingSyncState.findMany({ where: { id: { in: Object.values(stateIds) } }, orderBy: { id: "asc" } });
    const result = await getIncomingSyncStatus(admin);
    expect(result).toMatchObject({ enabled: true, workerAlive: true, pollIntervalSeconds: 300 });
    expect(ids(result)).toEqual([stateIds.booksA, stateIds.booksB, stateIds.crm].sort());
    expect(result.sources.find(source => source.id === stateIds.booksA)).toMatchObject({ kind: "BOOKS",
      companyId: companyA.id, companyName: companyA.name, status: "WAITING_QUOTA", isStale: true,
      lastSuccessAt: lastSuccess.toISOString(), nextRunAt: nextRun.toISOString(), backoffUntil: nextRun.toISOString(),
      processedCount: 17, message: "Zoho reads are paused until the permitted retry time." });
    expect(result.sources.find(source => source.id === stateIds.booksB)).toMatchObject({ status: "IDLE", isStale: false, processedCount: 0 });
    expect(result.sources.find(source => source.id === stateIds.crm)).toMatchObject({ status: "PENDING",
      lastSuccessAt: null, isStale: true, processedCount: null });
    expect(await db.incomingSyncState.findMany({ where: { id: { in: Object.values(stateIds) } }, orderBy: { id: "asc" } })).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("scopes Books rows and shared CRM company labels to each authorized reader and filter", async () => {
    const alpha = await getIncomingSyncStatus(reader);
    expect(ids(alpha)).toEqual([stateIds.booksA, stateIds.crm].sort());
    expect(alpha.sources.find(source => source.kind === "CRM")).toMatchObject({ companyId: null,
      companyName: companyA.name, processedCount: null });
    expect(JSON.stringify(alpha)).not.toContain(companyB.name);
    const beta = await getIncomingSyncStatus(accounts);
    expect(ids(beta)).toEqual([stateIds.booksB, stateIds.crm].sort());
    expect(beta.sources.find(source => source.kind === "CRM")).toMatchObject({ companyName: companyB.name, processedCount: null });
    expect(JSON.stringify(beta)).not.toContain(companyA.name);
    const filtered = await getIncomingSyncStatus(admin, companyA.id);
    expect(ids(filtered)).toEqual(ids(alpha));
    expect(filtered.sources.find(source => source.kind === "CRM")?.companyName).toBe(companyA.name);
    const shared = (await getIncomingSyncStatus(admin)).sources.find(source => source.kind === "CRM")!;
    expect(shared.companyName).toContain(companyA.name);
    expect(shared.companyName).toContain(companyB.name);
    expect(shared.processedCount).toBeNull();
  });

  it("keeps another company's rows and the same CRM organization in another data center private", async () => {
    await expect(getIncomingSyncStatus(reader, companyB.id)).rejects.toMatchObject({ status: 404 });
    await expect(getIncomingSyncStatus(admin, companyC.id)).rejects.toMatchObject({ status: 404 });
    await expect(getIncomingSyncStatus(outsider, companyA.id)).rejects.toMatchObject({ status: 404 });
    expect(ids(await getIncomingSyncStatus(outsider))).toEqual([stateIds.booksC]);
    expect(ids(await getIncomingSyncStatus(admin))).not.toContain(stateIds.otherDc);
  });

  it("returns only the sanitized status contract, never raw checkpoints, scope or lease secrets", async () => {
    const result = await getIncomingSyncStatus(admin);
    expect(Object.keys(result).sort()).toEqual(["generatedAt", "enabled", "workerAlive", "lastHeartbeatAt", "pollIntervalSeconds", "sources"].sort());
    for (const source of result.sources)
      expect(Object.keys(source).sort()).toEqual(["id", "kind", "companyId", "companyName", "status", "lastSuccessAt",
        "nextRunAt", "backoffUntil", "isStale", "message", "processedCount"].sort());
    const serialized = JSON.stringify(result);
    for (const forbidden of [...Object.values(privateValues), "fictional-private-provider-payload", "checkpoint", "scopeHash",
      "leaseToken", "leaseExpiresAt", "lastErrorCode", "providerReads", "organizationId", "dataCenter", "watermark", "987654321"])
      expect(serialized).not.toContain(forbidden);
  });

  it("denies Data Entry and stale or forged role claims even with current company membership", async () => {
    await expect(getIncomingSyncStatus(entry)).rejects.toMatchObject({ status: 403 });
    await expect(getIncomingSyncStatus({ ...entry, role: "MANAGEMENT" })).rejects.toMatchObject({ status: 403 });
    await expect(getIncomingSyncStatus({ ...reader, role: "ADMIN" })).rejects.toMatchObject({ status: 403 });
    await db.user.update({ where: { id: reader.id }, data: { role: "DATA_ENTRY" } });
    try {
      await expect(getIncomingSyncStatus(reader)).rejects.toMatchObject({ status: 403 });
    } finally {
      await db.user.update({ where: { id: reader.id }, data: { role: "MANAGEMENT" } });
    }
  });

  it("denies a deactivated account even when its role and membership still match", async () => {
    await db.user.update({ where: { id: reader.id }, data: { active: false } });
    try {
      await expect(getIncomingSyncStatus(reader)).rejects.toMatchObject({ status: 403 });
    } finally {
      await db.user.update({ where: { id: reader.id }, data: { active: true } });
    }
  });

  it("removes revoked company rows and shared-source labels without an administrator bypass", async () => {
    const where = { userId_companyId: { userId: admin.id, companyId: companyB.id } };
    await db.userCompanyMembership.update({ where, data: { active: false } });
    try {
      const result = await getIncomingSyncStatus(admin);
      expect(ids(result)).toEqual([stateIds.booksA, stateIds.crm].sort());
      expect(result.sources.find(source => source.kind === "CRM")?.companyName).toBe(companyA.name);
      expect(JSON.stringify(result)).not.toContain(companyB.name);
      await expect(getIncomingSyncStatus(admin, companyB.id)).rejects.toMatchObject({ status: 404 });
    } finally {
      await db.userCompanyMembership.update({ where, data: { active: true } });
    }
  });

  it("does not reveal a shared-source heartbeat after the reader loses its last membership", async () => {
    const where = { userId_companyId: { userId: reader.id, companyId: companyA.id } };
    await db.userCompanyMembership.update({ where, data: { active: false } });
    try {
      expect(await getIncomingSyncStatus(reader)).toMatchObject({ sources: [], workerAlive: false, lastHeartbeatAt: null });
      await expect(getIncomingSyncStatus(reader, companyA.id)).rejects.toMatchObject({ status: 404 });
    } finally {
      await db.userCompanyMembership.update({ where, data: { active: true } });
    }
  });

  it("excludes inactive companies from both Books visibility and shared CRM labels", async () => {
    await db.company.update({ where: { id: companyA.id }, data: { active: false } });
    try {
      const result = await getIncomingSyncStatus(admin);
      expect(ids(result)).toEqual([stateIds.booksB, stateIds.crm].sort());
      expect(result.sources.find(source => source.kind === "CRM")?.companyName).toBe(companyB.name);
      expect((await getIncomingSyncStatus(reader)).sources).toEqual([]);
      await expect(getIncomingSyncStatus(admin, companyA.id)).rejects.toMatchObject({ status: 404 });
    } finally {
      await db.company.update({ where: { id: companyA.id }, data: { active: true } });
    }
  });
});
