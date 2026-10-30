import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
import { serializeZohoDataTransferManifest, zohoDataTransferManifestHash } from "@/lib/services/zoho-data-transfer-format";
import { restoreFixture, restoreFixtureEnvironment } from "./helpers/zoho-restore-fixture";
import { transferOriginalBytes } from "./helpers/zoho-data-transfer-fixture";
const mocks = vi.hoisted(() => ({ user: vi.fn(), transaction: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { user: { findUnique: mocks.user }, $transaction: mocks.transaction } }));
import { assertZohoDataRestoreEnvironment, checkZohoDataTransfer, restoreZohoDataTransfer, validateZohoRestoreEvidence } from "@/lib/services/zoho-data-transfer-import";

const actor: Actor = { id: "restore-admin", role: "ADMIN", name: "Fixture operator", email: "restore@example.invalid" };
const operating = { ...restoreFixtureEnvironment, ALLOW_ZOHO_DATA_RESTORE: "true", APP_ENV: "production", NODE_ENV: "production",
  APP_URL: "https://billing.example.invalid", DATABASE_URL: "mysql://billing_runtime:fictional-password@database.example.invalid:3306/billing_operational",
  DATABASE_TLS_MODE: "verify-full" };
const directories: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(operating)) vi.stubEnv(key, value);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Provider access is forbidden for restore tests."); }));
});
afterEach(async () => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
describe("explicit offline restore gates", () => {
  it("accepts only an explicitly enabled, offline verified TLS operational runtime", () => {
    expect(() => assertZohoDataRestoreEnvironment()).not.toThrow();
  });
  it.each([
    ["ALLOW_ZOHO_DATA_RESTORE", "false"], ["APP_ENV", "development"], ["NODE_ENV", "development"],
    ["APP_URL", "http://billing.example.invalid"], ["DATABASE_URL", "mysql://root:fictional@127.0.0.1:3308/voltronix_billing_dev"],
    ["INTEGRATION_TEST_MODE", "true"], ["DATABASE_TLS_MODE", "disabled"], ["NODE_TLS_REJECT_UNAUTHORIZED", "0"],
    ["INTEGRATION_NETWORK_ENABLED", "true"], ["ZOHO_BOOKS_NETWORK_ENABLED", "true"], ["ZOHO_CRM_NETWORK_ENABLED", "true"],
    ["ZOHO_BOOKS_WRITE_ENABLED", "true"], ["ZOHO_BOOKS_LIVE_ENABLED", "true"], ["ALLOW_PRODUCTION_ACCOUNTING_WRITES", "true"],
    ["INCOMING_SYNC_ENABLED", "true"], ["INCOMING_SYNC_ENABLED", ""],
  ])("rejects %s=%s before reading database or bundle", async (key, value) => {
    vi.stubEnv(key, value);
    await expect(restoreZohoDataTransfer(actor, {})).rejects.toMatchObject({ code: "OFFLINE_RESTORE_ENVIRONMENT" });
    expect(mocks.user).not.toHaveBeenCalled(); expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it.each([null, { active: false, role: "ADMIN" }, { active: true, role: "ACCOUNTS" }])("requires a current active Admin", async operator => {
    mocks.user.mockResolvedValue(operator);
    await expect(restoreZohoDataTransfer(actor, { directory: path.resolve(".local/absent-bundle"), manifestSha256: "a".repeat(64), reference: "Fictional approved transfer" }))
      .rejects.toMatchObject({ code: "OPERATOR_REAUTHENTICATION" });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
describe("independent imported-source evidence validation", () => {
  it("rebuilds real job values from exact source records and retains unassigned inventory", () => {
    const evidence = validateZohoRestoreEvidence(restoreFixture());
    expect(evidence.restoredJobs).toHaveLength(2);
    expect(evidence.restoredJobs.map(job => ({ companyId: job.companyId, isDemo: job.isDemo, contractValue: job.contractValue })))
      .toEqual([{ companyId: "company-books-us-11", isDemo: false, contractValue: "1000.00" }, { companyId: "company-books-us-12", isDemo: false, contractValue: "1000.00" }]);
  });
  it("rejects local canonical amounts that disagree with CRM rather than guessing", () => {
    const manifest = restoreFixture(); manifest.canonicalJobs[0].contractValue = "999.00";
    expect(() => validateZohoRestoreEvidence(manifest)).toThrow(/CRM_CANONICAL_VALUES_CHANGED/);
  });
  it("rejects copied columns that disagree with the original Books bill", () => {
    const manifest = restoreFixture(); manifest.booksBills[0].total = "999.00";
    expect(() => validateZohoRestoreEvidence(manifest)).toThrow(/BOOKS_VALUES_CHANGED/);
  });
  it("rejects guessed company routing for unassigned CRM source records", () => {
    const manifest = restoreFixture(); manifest.crmSnapshots[2].companyId = manifest.companies[0].id;
    expect(() => validateZohoRestoreEvidence(manifest)).toThrow(/CRM_PROJECTION_CHANGED/);
  });
  it("rejects a stale canonical job or source credential replacement", () => {
    const manifest = restoreFixture(); manifest.crmSnapshots[0].isStale = true;
    expect(() => validateZohoRestoreEvidence(manifest)).toThrow(/CRM_CANONICAL_REVIEW_REQUIRED/);
    manifest.crmSnapshots[0].isStale = false; manifest.sourceCredentials[0].connectionFingerprint = "0".repeat(64);
    expect(() => validateZohoRestoreEvidence(manifest)).toThrow(/SOURCE_CONNECTION_CHANGED/);
  });
  it("requires complete raw CRM fields even for unassigned rows", () => {
    const manifest = restoreFixture(); delete manifest.crmSnapshots[2].sourceRecordJson.Created_Time;
    expect(() => validateZohoRestoreEvidence(manifest)).toThrow(/CRM_FIELDS_INCOMPLETE/);
  });
  it.each([{ "ZOHO:99": "2026-11-02T00:00:00.000Z" }, { "ZOHO:11": "tomorrow" }])("rejects an unknown source or malformed target cooldown", values => {
    vi.stubEnv("INCOMING_SYNC_NOT_BEFORE_JSON", JSON.stringify(values));
    expect(() => validateZohoRestoreEvidence(restoreFixture())).toThrow(/TARGET_COOLDOWN_CONFIGURATION/);
  });
  it("checks exact reviewed manifest and original bytes without writing a database", async () => {
    const manifest = restoreFixture();
    const directory = await mkdtemp(path.join(os.tmpdir(), "zoho-restore-fixture-")); directories.push(directory);
    await mkdir(path.join(directory, "originals"));
    await writeFile(path.join(directory, "manifest.json"), serializeZohoDataTransferManifest(manifest));
    await writeFile(path.join(directory, manifest.attachments[0].assetPath), transferOriginalBytes);
    const input = { directory, manifestSha256: zohoDataTransferManifestHash(manifest) };
    expect(await checkZohoDataTransfer(input)).toMatchObject({ status: "SOURCE_CACHE_VERIFIED", counts: { booksBills: 2, originals: 2, crmSnapshots: 3, jobs: 2 } });
    await writeFile(path.join(directory, manifest.attachments[0].assetPath), Buffer.from(transferOriginalBytes).fill(65, 15, 16));
    await expect(checkZohoDataTransfer(input)).rejects.toMatchObject({ code: "ORIGINAL_INTEGRITY" });
    await expect(checkZohoDataTransfer({ ...input, manifestSha256: "0".repeat(64) })).rejects.toMatchObject({ code: "MANIFEST_DIGEST" });
    expect(mocks.user).not.toHaveBeenCalled(); expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
