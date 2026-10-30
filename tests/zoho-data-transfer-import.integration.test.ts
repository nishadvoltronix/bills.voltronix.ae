import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import type { Actor } from "@/lib/auth";
import { hashPassword } from "@/lib/password";
import { incomingSources } from "@/lib/services/incoming-sync-access";
import { readPrivateDocument } from "@/lib/services/documents";
import { restoreZohoDataTransferWithStore } from "@/lib/services/zoho-data-transfer-import";
import { serializeZohoDataTransferManifest, zohoDataTransferManifestHash, type ZohoDataTransferManifest } from "@/lib/services/zoho-data-transfer-format";
import { freshTransferDatabase } from "./helpers/fresh-transfer-database";
import { restoreFixture, restoreFixtureEnvironment } from "./helpers/zoho-restore-fixture";
import { transferOriginalBytes } from "./helpers/zoho-data-transfer-fixture";

let database: Awaited<ReturnType<typeof freshTransferDatabase>>;
let actor: Actor, directory: string, uploads: string, password: string, manifest: ZohoDataTransferManifest;
const reference = "Fictional operator reviewed source-cache transfer";
beforeAll(async () => { database = await freshTransferDatabase(); }, 120000);
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "zoho-transfer-test-"));
  uploads = path.join(directory, "target-uploads");
  await mkdir(uploads); await mkdir(path.join(directory, "originals"));
  for (const [key, value] of Object.entries({ ...restoreFixtureEnvironment, UPLOAD_DIR: uploads })) vi.stubEnv(key, value);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No provider reads or writes are permitted in a restore rehearsal."); }));
  password = `Fixture-${randomUUID()}-operator`;
  actor = await database.store.user.create({ data: { email: "restore@example.invalid", name: "Fixture operator", role: "ADMIN", passwordHash: await hashPassword(password) } });
  for (const [organizationId, name] of [["11", "Operating Company One"], ["12", "Operating Company Two"]]) {
    await database.store.company.create({ data: { id: `company-books-us-${organizationId}`, name, isDemo: false,
      liveAccountingEnabled: false, memberships: { create: { userId: actor.id, active: true } },
      integrationDestinations: { create: { target: "ZOHO", organizationId, dataCenter: "US", environment: "production", liveEnabled: false } },
      crmSource: { create: { organizationId: "31", dataCenter: "US", environment: "production" } } } });
  }
  manifest = restoreFixture();
  await writeBundle();
}, 60000);
afterEach(async () => {
  if (typeof fetch === "function" && vi.isMockFunction(fetch)) expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  // This store belongs exclusively to the generated disposable database above.
  // Empty it between cases; the production service still requires every table to be empty globally.
  await database?.reset();
  if (directory) await rm(directory, { recursive: true, force: true });
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
}, 30000);
afterAll(async () => { await database?.cleanup(); }, 30000);
async function writeBundle() {
  await writeFile(path.join(directory, "manifest.json"), serializeZohoDataTransferManifest(manifest));
  for (const attachment of manifest.attachments) await writeFile(path.join(directory, attachment.assetPath), transferOriginalBytes);
}
const input = () => ({ directory, manifestSha256: zohoDataTransferManifestHash(manifest), reference });
const restore = (runtimeGuard?: () => void) => restoreZohoDataTransferWithStore(actor, input(), database.store, { password, runtimeGuard });
async function expectNoImportedRows() {
  expect(await Promise.all([database.store.booksBill.count(), database.store.booksImportRun.count(), database.store.booksBillAttachment.count(),
    database.store.crmImportRun.count(), database.store.crmJobSnapshot.count(), database.store.job.count(), database.store.booksProjectAssociation.count(),
    database.store.incomingSyncState.count(), database.store.auditLog.count()])).toEqual(Array(9).fill(0));
  expect(await readdir(uploads)).toEqual([]);
}

describe("atomic offline source-cache restore into an independently fresh MySQL database", () => {
  it("retains exact imported bills, originals and unassigned CRM evidence while reconstructing real source jobs and requiring new provider checks", async () => {
    const originalManifest = await readFile(path.join(directory, "manifest.json"));
    const result = await restore();
    expect(result).toMatchObject({ status: "RESTORED_PENDING_PROVIDER_CHECK", providerRequests: 0, providerFinancialWrites: 0,
      counts: { companies: 2, booksBills: 2, originals: 2, crmSnapshots: 3, jobs: 2, associations: 1 } });
    const bills = await database.store.booksBill.findMany({ orderBy: { externalBillId: "asc" } });
    for (const [index, bill] of bills.entries()) {
      expect(bill).toMatchObject({ companyId: `company-books-us-${11 + index}`, externalBillId: manifest.booksBills[index].externalBillId,
        total: "105.00", balance: "105.00", sourceSummary: manifest.booksBills[index].sourceSummary, sourceDetail: manifest.booksBills[index].sourceDetail,
        importedAt: new Date(manifest.booksBills[index].importedAt), isStale: false });
      expect(bill.lastImportRunId).toBe(bill.detailImportRunId);
      expect(bill.lastImportRunId).not.toBe(manifest.booksBills[index].lastImportRunId);
    }
    const originals = await database.store.booksBillAttachment.findMany();
    for (const original of originals) expect(await readPrivateDocument(original)).toEqual(transferOriginalBytes);
    expect(new Set(originals.map(original => original.storageKey)).size).toBe(2);
    expect(await database.store.crmJobSnapshot.findFirstOrThrow({ where: { externalCrmId: "302" } })).toMatchObject({
      companyId: null, canonicalJobId: null, linkStatus: "UNASSIGNED_COMPANY", booksOrganizationId: "99", sourceRecordJson: manifest.crmSnapshots[2].sourceRecordJson });
    const jobs = await database.store.job.findMany();
    expect(jobs).toHaveLength(2); expect(jobs.every(job => !job.isDemo && job.contractValue?.toFixed(2) === "1000.00")).toBe(true);
    expect(await database.store.booksProjectAssociation.findFirstOrThrow()).toMatchObject({ status: "STALE", sourceHash: manifest.associations[0].sourceHash,
      verifiedAt: new Date(manifest.associations[0].verifiedAt), validUntil: new Date(manifest.associations[0].validUntil),
      leaseToken: null, leaseExpiresAt: null, backoffUntil: new Date(manifest.cooldowns[0].notBefore) });
    const states = await database.store.incomingSyncState.findMany();
    const currentSources = await incomingSources(actor, database.store);
    expect(states).toHaveLength(3);
    for (const state of states) {
      expect(state).toMatchObject({ checkpoint: null, watermark: null, lastSuccessAt: null, lastReconciledAt: null,
        leaseToken: null, leaseExpiresAt: null, providerReads: 0, processedCount: 0 });
      expect(state.scopeHash).toBe(currentSources.find(source => source.target === state.target && source.organizationId === state.organizationId)!.scopeHash);
    }
    expect(states.find(state => state.organizationId === "11")).toMatchObject({ status: "WAITING_QUOTA", nextRunAt: new Date(manifest.cooldowns[0].notBefore) });
    expect(await database.store.booksImportRun.findMany()).toEqual(expect.arrayContaining([expect.objectContaining({ runKind: "RESTORE" })]));
    expect(await database.store.crmImportRun.findFirstOrThrow()).toMatchObject({ runKind: "RESTORE", snapshotCount: 3, canonicalCount: 2, unassignedCount: 1 });
    expect(await Promise.all([database.store.bill.count(), database.store.vendor.count(), database.store.payment.count(), database.store.integrationJob.count(),
      database.store.liveSyncAuthorization.count(), database.store.integrationCredential.count()])).toEqual([0, 0, 0, 0, 0, 0]);
    expect(await database.store.auditLog.findFirstOrThrow()).toMatchObject({ action: "ZOHO_SOURCE_CACHE_RESTORED", entityId: result.manifestSha256 });
    expect(await readFile(path.join(directory, "manifest.json"))).toEqual(originalManifest);
    await expect(restore()).rejects.toMatchObject({ code: "TARGET_NOT_EMPTY" });
    expect(await readdir(uploads)).toHaveLength(2);
  });
  it("rolls back every imported row and staged original when the commit fails after creating rows", async () => {
    // Force a real database integrity failure at the final audit insert, after all imported tables were written.
    const transaction = database.store.$transaction.bind(database.store);
    vi.spyOn(database.store, "$transaction").mockImplementation((async (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options: object) =>
      transaction(async tx => work(new Proxy(tx, { get(target, property, receiver) {
        if (property !== "auditLog") return Reflect.get(target, property, receiver);
        return { ...target.auditLog, create: (args: Prisma.AuditLogCreateArgs) => target.auditLog.create({
          ...args, data: { ...args.data, actorId: "missing-operator-for-rollback-check" } as Prisma.AuditLogUncheckedCreateInput }) };
      } })), options)) as typeof database.store.$transaction);
    await expect(restore()).rejects.toThrow();
    await expectNoImportedRows();
  });
  it("requires reauthentication and exact prepared companies before staging any original", async () => {
    password = "wrong-fixture-password";
    await expect(restore()).rejects.toMatchObject({ code: "OPERATOR_REAUTHENTICATION" });
    await expectNoImportedRows();
    password = `Fixture-${randomUUID()}`;
    await database.store.user.update({ where: { id: actor.id }, data: { passwordHash: await hashPassword(password) } });
    await database.store.company.update({ where: { id: "company-books-us-11" }, data: { isDemo: true } });
    await expect(restore()).rejects.toMatchObject({ code: "TARGET_BINDING_MISMATCH" });
    await expectNoImportedRows();
  });
  it("preserves committed originals when the database commit acknowledgement is lost", async () => {
    const transaction = database.store.$transaction.bind(database.store);
    vi.spyOn(database.store, "$transaction").mockImplementation((async (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options: object) => {
      await transaction(work, options);
      throw new Error("Simulated connection loss after the server committed.");
    }) as unknown as typeof database.store.$transaction);
    await expect(restore()).rejects.toMatchObject({ code: "COMMIT_UNCONFIRMED" });
    expect(await database.store.booksBill.count()).toBe(2);
    expect(await database.store.auditLog.findFirstOrThrow()).toMatchObject({ action: "ZOHO_SOURCE_CACHE_RESTORED", entityId: input().manifestSha256 });
    const originals = await database.store.booksBillAttachment.findMany();
    for (const original of originals) expect(await readPrivateDocument(original)).toEqual(transferOriginalBytes);
    expect(await readdir(uploads)).toHaveLength(2);
  });
  it("retains the later target cooldown as well as the exported provider hold", async () => {
    const booksHold = new Date(Date.now() + 2 * 86_400_000).toISOString(), crmHold = new Date(Date.now() + 3 * 86_400_000).toISOString();
    vi.stubEnv("INCOMING_SYNC_NOT_BEFORE_JSON", JSON.stringify({ "ZOHO:11": booksHold, "CRM:31": crmHold }));
    await restore();
    expect(await database.store.incomingSyncState.findFirstOrThrow({ where: { target: "ZOHO", organizationId: "11" } }))
      .toMatchObject({ nextRunAt: new Date(booksHold), backoffUntil: new Date(booksHold) });
    expect(await database.store.incomingSyncState.findFirstOrThrow({ where: { target: "CRM" } }))
      .toMatchObject({ nextRunAt: new Date(crmHold), backoffUntil: new Date(crmHold) });
    expect(await database.store.booksProjectAssociation.findFirstOrThrow()).toMatchObject({ backoffUntil: new Date(crmHold) });
  });
  it("rejects nonempty native financial input even when every imported table is empty", async () => {
    await database.store.vendor.create({ data: { companyId: "company-books-us-11", name: "Existing local supplier", currency: "AED" } });
    await expect(restore()).rejects.toMatchObject({ code: "TARGET_NOT_EMPTY" });
    await expectNoImportedRows();
    expect(await database.store.vendor.count()).toBe(1);
  });
  it("rechecks authorization after staging and removes only newly staged files", async () => {
    const preserved = path.join(uploads, "operator-existing.txt"); await writeFile(preserved, "existing private file");
    let guards = 0;
    await expect(restore(() => { if (++guards === 2) throw new Error("Operator gate changed before commit."); })).rejects.toThrow(/gate changed/);
    expect(await readdir(uploads)).toEqual(["operator-existing.txt"]);
    expect(await readFile(preserved, "utf8")).toBe("existing private file");
    expect(await database.store.booksBill.count()).toBe(0); expect(await database.store.auditLog.count()).toBe(0);
  });
  it("refuses a corrupted original with a matching size and leaves the destination empty", async () => {
    await writeFile(path.join(directory, manifest.attachments[0].assetPath), Buffer.from(transferOriginalBytes).fill(65, 15, 16));
    await expect(restore()).rejects.toMatchObject({ code: "ORIGINAL_INTEGRITY" });
    await expectNoImportedRows();
  });
});
