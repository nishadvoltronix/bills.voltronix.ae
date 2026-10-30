import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionFingerprint } from "@/lib/integrations/connection-fingerprint";
import { getConfig } from "@/lib/integrations/config";
import { exportZohoDataTransfer, validateZohoTransferSourceRows } from "@/lib/services/zoho-data-transfer-export";
import { parseZohoDataTransferManifest, serializeZohoDataTransferManifest, zohoDataTransferManifestHash } from "@/lib/services/zoho-data-transfer-format";
import { transferFixtureMapping, transferOriginalBytes, zohoDataTransferFixture } from "./helpers/zoho-data-transfer-fixture";

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), readOriginal: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { $transaction: mocks.transaction } }));
vi.mock("@/lib/services/documents", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/services/documents")>(), readPrivateDocument: mocks.readOriginal,
}));
const actor = { id: "admin", email: "admin@example.test", name: "Admin", role: "ADMIN" as const };
const roots: string[] = [];
const nativeDates = (row: object) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
  typeof value === "string" && (/At$/.test(key) || ["billDate", "dueDate", "validUntil", "backoffUntil"].includes(key)) ? new Date(value) : value]));

async function setupExport() {
  const fixture = zohoDataTransferFixture();
  const root = await mkdtemp(path.join(os.tmpdir(), "voltronix-transfer-")); roots.push(root);
  const store = {
    user: { findFirst: vi.fn().mockResolvedValue({ id: actor.id }) },
    company: { findMany: vi.fn().mockResolvedValue(fixture.companies.map((row) => ({ ...nativeDates(row), active: true,
      liveAccountingEnabled: false, memberships: [{ userId: actor.id }],
      integrationDestinations: [{ ...nativeDates(row.books), target: "ZOHO", liveEnabled: false }], crmSource: nativeDates(row.crm) }))) },
    companyCrmSource: { findMany: vi.fn().mockResolvedValue(fixture.companies.map((row) => ({ companyId: row.id }))) },
    integrationCredential: { findUnique: vi.fn().mockImplementation(async ({ where }: { where: { target_organizationId: { target: "ZOHO" | "CRM"; organizationId: string } } }) => {
      const { target, organizationId } = where.target_organizationId;
      const config = getConfig(target, process.env, organizationId);
      return { target, organizationId, dataCenter: config.dataCenter, connectionFingerprint: connectionFingerprint(config),
        refreshTokenEncrypted: "private-vault-ciphertext-must-not-export", revokedAt: null, createdAt: new Date(fixture.exportedAt), updatedAt: new Date(fixture.exportedAt) };
    }) },
    booksBill: { findMany: vi.fn().mockResolvedValue(fixture.booksBills.map(nativeDates)) },
    booksBillAttachment: { findMany: vi.fn().mockResolvedValue(fixture.attachments.map(({ assetPath, ...row }, index) => {
      void assetPath; return { ...nativeDates(row), storageKey: `00000000-0000-4000-8000-00000000000${index}.pdf` };
    })) },
    booksImportRun: { findMany: vi.fn().mockResolvedValue(fixture.booksRuns.map((row) => ({ ...nativeDates(row), initiatedById: actor.id, lastErrorCode: null }))) },
    crmImportRun: { findMany: vi.fn().mockResolvedValue(fixture.crmRuns.map((row) => ({ ...nativeDates(row), initiatedById: actor.id, nextPageToken: "private-cursor", lastErrorCode: null }))) },
    crmJobSnapshot: { findMany: vi.fn().mockResolvedValue(fixture.crmSnapshots.map(nativeDates)) },
    job: { findMany: vi.fn().mockResolvedValue(fixture.canonicalJobs.map((row) => ({ ...nativeDates(row),
      contractValue: row.contractValue === null ? null : new Prisma.Decimal(row.contractValue), approvedVariations: new Prisma.Decimal(row.approvedVariations) }))) },
    booksProjectAssociation: { findMany: vi.fn().mockResolvedValue(fixture.associations.map((row) => ({ ...nativeDates(row), leaseToken: null, leaseExpiresAt: null }))) },
    incomingSyncState: { findMany: vi.fn().mockResolvedValue([{ target: "ZOHO", organizationId: "11", dataCenter: "US", environment: "production",
      status: "WAITING_QUOTA", backoffUntil: new Date("2099-01-01T00:00:00.000Z"), nextRunAt: new Date("2099-01-01T00:00:00.000Z") }]) },
  };
  mocks.transaction.mockImplementation(async (run: (tx: typeof store) => Promise<unknown>) => run(store));
  mocks.readOriginal.mockResolvedValue(transferOriginalBytes);
  return { fixture, root, store, input: { directory: path.join(root, "bundle"), companyIds: fixture.companies.map((row) => row.id) } };
}
beforeEach(() => {
  vi.clearAllMocks();
  for (const [name, value] of Object.entries({ ALLOW_ZOHO_DATA_EXPORT: "true", APP_ENV: "development", NODE_ENV: "test",
    DATABASE_URL: "mysql://test:test@127.0.0.1:3308/voltronix_billing_dev", APP_URL: "http://127.0.0.1:3000",
    INTEGRATION_TEST_MODE: "false", INTEGRATION_FIXTURE_URL: "", INTEGRATION_NETWORK_ENABLED: "false",
    ZOHO_BOOKS_WRITE_ENABLED: "false", ZOHO_BOOKS_LIVE_ENABLED: "false", ALLOW_PRODUCTION_ACCOUNTING_WRITES: "false",
    ZOHO_BOOKS_DC: "US", ZOHO_BOOKS_CLIENT_ID: "fixture-client", ZOHO_BOOKS_CLIENT_SECRET: "fixture-secret",
    ZOHO_BOOKS_ENVIRONMENT: "production", ZOHO_BOOKS_ORGANIZATIONS_JSON: JSON.stringify([{ organizationId: "11", name: "First company" }, { organizationId: "12", name: "Second company" }]),
    ZOHO_CRM_DC: "US", ZOHO_CRM_CLIENT_ID: "fixture-client", ZOHO_CRM_CLIENT_SECRET: "fixture-secret", ZOHO_CRM_ORGANIZATION_ID: "31",
    ZOHO_CRM_ENVIRONMENT: "production", ZOHO_CRM_MAPPING_JSON: JSON.stringify(transferFixtureMapping), INCOMING_SYNC_NOT_BEFORE_JSON: "" })) vi.stubEnv(name, value);
});
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("Zoho transfer contract", () => {
  it("retains exact source decimals, unassigned legacy deals and original evidence", () => {
    const fixture = zohoDataTransferFixture();
    expect(parseZohoDataTransferManifest(fixture)).toEqual(fixture);
    expect(() => validateZohoTransferSourceRows(fixture)).not.toThrow();
    expect(fixture.crmSnapshots.filter((row) => row.companyId === null)).toHaveLength(1);
    expect(zohoDataTransferManifestHash(fixture)).toBe(createHash("sha256").update(serializeZohoDataTransferManifest(fixture)).digest("hex"));
  });
  it("retains completed incoming CRM run provenance alongside manual field arrays", () => {
    const fixture = zohoDataTransferFixture();
    const fields = fixture.crmRuns[0].fieldsJson;
    if (!Array.isArray(fields)) throw new Error("Invalid fixture");
    fixture.crmRuns.push({ ...fixture.crmRuns[0], id: "incremental-run", runKind: "INCREMENTAL",
      fieldsJson: { kind: "INCOMING_CRM", version: 1, fields, since: "2026-10-01T00:00:00+00:00", phase: "done", deletedPage: 1, linkAfterId: "snapshot-2" } });
    expect(parseZohoDataTransferManifest(fixture).crmRuns[1].fieldsJson).toEqual(fixture.crmRuns[1].fieldsJson);
    expect(() => validateZohoTransferSourceRows(fixture)).not.toThrow();
    const metadata = fixture.crmRuns[1].fieldsJson;
    expect(() => parseZohoDataTransferManifest({ ...fixture, crmRuns: [fixture.crmRuns[0], { ...fixture.crmRuns[1],
      fieldsJson: { ...metadata, phase: "records" } }] })).toThrow("MANIFEST_SCHEMA");
    expect(() => parseZohoDataTransferManifest({ ...fixture, crmRuns: [fixture.crmRuns[0], { ...fixture.crmRuns[1],
      fieldsJson: { ...metadata, nextPageToken: "must-not-transfer-cursor" } }] })).toThrow("MANIFEST_SCHEMA");
  });
  it.each([
    (value: ReturnType<typeof zohoDataTransferFixture>) => { value.booksBills.push({ ...value.booksBills[0], id: "other-local-id" }); },
    (value: ReturnType<typeof zohoDataTransferFixture>) => { value.attachments[0].companyId = value.companies[1].id; },
    (value: ReturnType<typeof zohoDataTransferFixture>) => { value.booksBills[0].detailImportRunId = "different-run"; },
    (value: ReturnType<typeof zohoDataTransferFixture>) => { value.booksBills[0].sourceDetail.bill_id = "999"; },
    (value: ReturnType<typeof zohoDataTransferFixture>) => { value.attachments[0].assetPath = "../invoice.pdf"; },
    (value: ReturnType<typeof zohoDataTransferFixture>) => { value.attachments[0].sourceMetadata.file_size = 999; },
    (value: ReturnType<typeof zohoDataTransferFixture>) => { value.crmSnapshots[0].canonicalJobId = value.canonicalJobs[1].id; },
    (value: ReturnType<typeof zohoDataTransferFixture>) => { value.crmSnapshots[2].companyId = value.companies[0].id; },
    (value: ReturnType<typeof zohoDataTransferFixture>) => { value.booksRuns[0].detailCount = 0; },
    (value: ReturnType<typeof zohoDataTransferFixture>) => { value.associations[0].sourceDealsPages = []; },
    (value: ReturnType<typeof zohoDataTransferFixture>) => { value.associations[0].validUntil = "2099-01-01T00:00:00.000Z"; },
    (value: ReturnType<typeof zohoDataTransferFixture>) => { value.attachments = []; },
    (value: ReturnType<typeof zohoDataTransferFixture>) => { value.booksBills[0].detailFetchedAt = "2099-01-01T00:00:00.000Z"; },
  ])("rejects duplicate identity, cross-company or incomplete/tampered evidence", (change) => {
    const fixture = zohoDataTransferFixture(); change(fixture);
    expect(() => parseZohoDataTransferManifest(fixture)).toThrow(/Zoho data transfer validation failed/);
  });
  it("rejects secret fields and native tables with fixed safe errors", () => {
    const fixture = zohoDataTransferFixture();
    expect(() => parseZohoDataTransferManifest({ ...fixture, refreshToken: "private-do-not-log" })).toThrow("MANIFEST_SCHEMA");
    expect(() => parseZohoDataTransferManifest({ ...fixture, bills: [{ invoiceNumber: "private-do-not-log" }] })).toThrow("MANIFEST_SCHEMA");
    try { parseZohoDataTransferManifest({ ...fixture, users: [{ passwordHash: "private-do-not-log" }] }); }
    catch (error) { expect(String(error)).not.toContain("private-do-not-log"); }
  });
  it.each([
    (value: ReturnType<typeof zohoDataTransferFixture>) => { value.booksBills[0].total = "1.00"; },
    (value: ReturnType<typeof zohoDataTransferFixture>) => { value.canonicalJobs[0].contractValue = "999.00"; },
    (value: ReturnType<typeof zohoDataTransferFixture>) => { value.crmSnapshots[0].customerName = "Changed locally"; },
  ])("rejects flattened values that no longer agree with provider evidence", (change) => {
    const fixture = zohoDataTransferFixture(); change(fixture);
    expect(() => validateZohoTransferSourceRows(parseZohoDataTransferManifest(fixture))).toThrow();
  });
});

describe("read-only local Zoho exporter", () => {
  it("exports a repeatable snapshot, verified originals and future cooldown with no source mutation or credentials", async () => {
    const { input } = await setupExport();
    const providerRequest = vi.spyOn(globalThis, "fetch");
    const result = await exportZohoDataTransfer(actor, input);
    expect(providerRequest).not.toHaveBeenCalled();
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: "RepeatableRead" }));
    const raw = await readFile(path.join(input.directory, "manifest.json"), "utf8");
    const manifest = parseZohoDataTransferManifest(JSON.parse(raw));
    expect(createHash("sha256").update(raw).digest("hex")).toBe(result.manifestSha256);
    expect(result).toMatchObject({ databaseWrites: 0, providerCalls: 0, counts: { booksBills: 2, attachments: 2, originalFiles: 1, crmSnapshots: 3, canonicalJobs: 2 } });
    expect(raw).not.toMatch(/private-vault|private-cursor|storageKey|passwordHash|refreshTokenEncrypted|initiatedById|leaseToken/);
    expect(manifest.cooldowns[0].notBefore).toBe("2099-01-01T00:00:00.000Z");
    expect(await readFile(path.join(input.directory, manifest.attachments[0].assetPath))).toEqual(transferOriginalBytes);
    expect(mocks.readOriginal).toHaveBeenCalledTimes(2);
    if (process.platform !== "win32") expect((await lstat(path.join(input.directory, "manifest.json"))).mode & 0o777).toBe(0o600);
  });
  it("refuses an existing destination and preserves its contents", async () => {
    const { input } = await setupExport(); await mkdir(input.directory);
    await expect(exportZohoDataTransfer(actor, input)).rejects.toThrow("EXPORT_FAILED");
    expect(await readdir(input.directory)).toEqual([]);
  });
  it("refuses a symlink or junction in the destination ancestry", async () => {
    const { input, root } = await setupExport();
    const physical = path.join(root, "physical"), linked = path.join(root, "linked");
    await mkdir(physical); await symlink(physical, linked, "junction");
    await expect(exportZohoDataTransfer(actor, { ...input, directory: path.join(linked, "bundle") })).rejects.toThrow("EXPORT_DIRECTORY");
    expect(await readdir(physical)).toEqual([]);
  });
  it("does not publish a manifest when an original is missing or corrupt", async () => {
    const { input } = await setupExport(); mocks.readOriginal.mockRejectedValue(new Error("secret filesystem path"));
    await expect(exportZohoDataTransfer(actor, input)).rejects.toThrow("EXPORT_FAILED");
    expect(await readdir(input.directory)).toEqual(["originals"]);
  });
  it("checks original MIME and hash even if a storage reader returns unexpected bytes", async () => {
    const { input } = await setupExport(); mocks.readOriginal.mockResolvedValue(Buffer.from("%PDF-1.7\nchanged-original"));
    await expect(exportZohoDataTransfer(actor, input)).rejects.toThrow("ORIGINAL_INTEGRITY");
    expect(await readdir(input.directory)).toEqual(["originals"]);
  });
  it("rejects missing membership or excluded companies sharing a CRM source before output", async () => {
    const { input, store } = await setupExport();
    store.companyCrmSource.findMany.mockResolvedValue([{ companyId: "outside-company" }]);
    await expect(exportZohoDataTransfer(actor, input)).rejects.toThrow("SHARED_SOURCE_INCOMPLETE");
  });
  it("rejects revoked or changed source credential provenance", async () => {
    const { input, store } = await setupExport();
    store.integrationCredential.findUnique.mockResolvedValue(null);
    await expect(exportZohoDataTransfer(actor, input)).rejects.toThrow("SOURCE_CREDENTIAL_PROVENANCE");
  });
  it("retains the latest database, configured or explicit downloader cooldown", async () => {
    const { input } = await setupExport();
    vi.stubEnv("INCOMING_SYNC_NOT_BEFORE_JSON", JSON.stringify({ "ZOHO:11": "2099-02-01T00:00:00.000Z" }));
    await exportZohoDataTransfer(actor, { ...input, additionalCooldowns: [{ target: "ZOHO", organizationId: "11", dataCenter: "US",
      environment: "production", notBefore: "2099-03-01T00:00:00.000Z" }] });
    const manifest = parseZohoDataTransferManifest(JSON.parse(await readFile(path.join(input.directory, "manifest.json"), "utf8")));
    expect(manifest.cooldowns[0].notBefore).toBe("2099-03-01T00:00:00.000Z");
  });
  it("refuses an active or incomplete source import", async () => {
    const { input, store, fixture } = await setupExport();
    store.booksImportRun.findMany.mockResolvedValue([{ ...nativeDates(fixture.booksRuns[0]), status: "RUNNING" }]);
    await expect(exportZohoDataTransfer(actor, input)).rejects.toThrow("SOURCE_IMPORT_INCOMPLETE");
  });
  it("rejects remote production source configuration before reading the database", async () => {
    const { input } = await setupExport(); vi.stubEnv("DATABASE_URL", "mysql://test:test@production-db:3306/billing");
    await expect(exportZohoDataTransfer(actor, input)).rejects.toThrow("LOCAL_SOURCE_REQUIRED");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
