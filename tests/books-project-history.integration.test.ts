import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { importBooksProjectAssociation, loadBooksProjectHistory } from "@/lib/services/books-project-history";
import { getCrmJobSnapshot } from "@/lib/services/crm-job-import";
import { searchDashboard } from "@/lib/services/dashboard-search";
import { getJob } from "@/lib/services/catalog";
import { loadFinancialLedger } from "@/lib/services/financial-ledger";
import { booksAttachmentMetadataHash } from "@/lib/services/books-attachments";
import { presentProjectHistory } from "@/lib/services/books-project-history-presentation";
import { projectHistoryProof } from "./books-project-history-fixtures";
import { assertMySqlTestDatabase, bindTestDestination, createTestCompany } from "./company-fixtures";

const tag = randomUUID().slice(0, 8), prefix = `97${BigInt(`0x${tag}`).toString()}`;
const booksA = `${prefix}1`, booksB = `${prefix}2`, crmOrganizationId = `${prefix}3`;
let admin: Actor, manager: Actor, entry: Actor, outsider: Actor;
let companyA: string, companyB: string, crmRun: string, runA: string, runB: string;
let snapshotA: string, snapshotB: string, billA: string, billB: string, sameNamedJob: string;
const verifiedAt = new Date(Date.now() - 60_000).toISOString();
const proof = (companyId = companyA, dealIds = ["300001"], projectId = "100001", timestamp = verifiedAt) =>
  projectHistoryProof(companyId, companyId === companyA ? booksA : booksB, crmOrganizationId,
    { dealIds, projectId, verifiedAt: timestamp });
async function financialCounts() {
  return { jobs: await db.job.count(), bills: await db.bill.count(), payments: await db.payment.count(), outgoing: await db.integrationJob.count() };
}
async function mirror(companyId: string, externalBillId: string, projects: unknown[], extra: Partial<Prisma.BooksBillUncheckedCreateInput> = {}) {
  return db.booksBill.create({ data: { companyId, organizationId: companyId === companyA ? booksA : booksB,
    organizationName: "Fictional history company", dataCenter: "US", environment: "production", externalBillId,
    billNumber: `HISTORY-${externalBillId}`, vendorId: "600001", vendorName: "Fictional history supplier", status: "open", currencyCode: "AED",
    subtotal: "50", taxTotal: "0", total: "50", balance: "50", sourceSummary: {},
    sourceDetail: { line_items: projects.map((id) => ({ project_id: id as Prisma.InputJsonValue })) },
    lastImportRunId: companyId === companyA ? runA : runB, detailImportRunId: companyId === companyA ? runA : runB,
    lastSeenAt: new Date(), detailFetchedAt: new Date(), ...extra } });
}
async function legacy(externalCrmId: string) {
  return db.crmJobSnapshot.create({ data: { crmOrganizationId, dataCenter: "US", environment: "production", sourceModule: "Deals",
    externalCrmId, name: "Fictional Legacy Site", customerName: "Fictional legacy customer", currencyCode: "AED", amount: "500",
    linkStatus: "UNASSIGNED_COMPANY", sourceRecordJson: { id: externalCrmId, JobDealNumber: null, Books_Organization_ID: null },
    importRunId: crmRun, lastSeenAt: new Date() } });
}

beforeAll(async () => {
  assertMySqlTestDatabase();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Project history cache must not contact a provider"); }));
  vi.stubEnv("ZOHO_BOOKS_WRITE_ENABLED", "true");
  vi.stubEnv("ALLOW_PRODUCTION_ACCOUNTING_WRITES", "true");
  [admin, manager, entry, outsider] = await Promise.all((["ADMIN", "MANAGEMENT", "DATA_ENTRY", "ADMIN"] as const).map((role, index) =>
    db.user.create({ data: { email: `project-history-${index}-${tag}@example.invalid`, name: "Fictional history actor", role, passwordHash: "unusable" } })));
  companyA = (await createTestCompany(`project history A ${tag}`, [admin, manager, entry])).id;
  companyB = (await createTestCompany(`project history B ${tag}`, [admin, outsider])).id;
  for (const [companyId, organizationId] of [[companyA, booksA], [companyB, booksB]]) {
    await bindTestDestination(companyId, { target: "ZOHO", organizationId, environment: "production" });
    await db.companyCrmSource.create({ data: { companyId, organizationId: crmOrganizationId, dataCenter: "US", environment: "production" } });
    const run = await db.booksImportRun.create({ data: { companyId, organizationId, organizationName: "Fictional history company",
      dataCenter: "US", environment: "production", initiatedById: admin.id } });
    if (companyId === companyA) runA = run.id; else runB = run.id;
  }
  crmRun = (await db.crmImportRun.create({ data: { crmOrganizationId, dataCenter: "US", environment: "production", sourceModule: "Deals",
    initiatedById: admin.id, scopeHash: "a".repeat(64), mappingJson: {}, fieldsJson: [] } })).id;
  snapshotA = (await legacy("300001")).id;
  snapshotB = (await legacy("300002")).id;
  // A same-named real job is intentionally unrelated to the old Deal.
  sameNamedJob = (await db.job.create({ data: { companyId: companyA, jobNumber: "JOB-NEW-SAME-NAME", name: "Fictional Legacy Site", customer: "Fictional customer",
    externalCrmId: "999999" } })).id;
  billA = (await mirror(companyA, "400001", ["100001", "100001"])).id;
  billB = (await mirror(companyB, "400002", ["100001"])).id;
});
afterAll(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await db.$disconnect(); });

describe("source-verified project history on disposable MySQL", () => {
  it("imports complete proof idempotently without assigning legacy jobs or writing financial records", async () => {
    const before = await financialCounts();
    const original = await db.crmJobSnapshot.findUniqueOrThrow({ where: { id: snapshotA } });
    const first = await importBooksProjectAssociation(admin, proof());
    expect(first).toMatchObject({ changed: true, dealCount: 1, status: "VERIFIED" });
    expect(await importBooksProjectAssociation(admin, proof())).toMatchObject({ id: first.id, changed: false });
    const saved = await db.booksProjectAssociation.findUniqueOrThrow({ where: { id: first.id } });
    expect(saved.sourceProject).toEqual(proof().sourceProject);
    expect(saved.sourceCrmRecords).toEqual(proof().sourceCrmRecords);
    expect(saved.sourceDealsPages).toEqual(proof().sourceDealsPages);
    expect(await db.crmJobSnapshot.findUniqueOrThrow({ where: { id: snapshotA } })).toEqual(original);
    expect(await financialCounts()).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
    const history = await loadBooksProjectHistory(admin, companyA);
    expect(history.relations).toHaveLength(1);
    expect(history.relations[0]).toMatchObject({ billId: billA, companyId: companyA, booksProjectId: "100001", snapshotId: snapshotA,
      externalCrmId: "300001", canonicalJobId: null, jobNumber: null, sourceCompanyId: null, displayReference: "LEGACY-300001" });
    expect(JSON.stringify(history)).not.toMatch(/sourceProject|sourceCrmRecords|private_token|fictional-secret|private_provider_url|sourceHash|storageKey|"amount"/);
  });

  it("finds legacy history by its native reference, name and bill number without manufacturing a canonical job", async () => {
    for (const value of ["LEGACY-300001", "fictional legacy site", "history-400001"]) {
      const result = await searchDashboard(admin, new URLSearchParams({ q: value, companyId: companyA }));
      const job = result.jobs.find((row) => row.id === snapshotA);
      expect(job).toMatchObject({ id: snapshotA, canonicalJobId: null, companyId: null, jobNumber: null,
        displayReference: "LEGACY-300001", referenceKind: "CRM_DEAL", canCreateBill: false, href: `/jobs/crm/${snapshotA}`,
        historyCompanies: [{ id: companyA }] });
      if (value === "history-400001") expect(result.bills[0]).toMatchObject({ id: billA, jobId: null, jobNumber: null,
        relatedJobs: [{ id: snapshotA, canonicalJobId: null, jobNumber: null, displayReference: "LEGACY-300001", href: `/jobs/crm/${snapshotA}` }] });
    }
    expect((await searchDashboard(admin, new URLSearchParams({ q: "LEGACY-300001", companyId: companyB }))).jobs).toEqual([]);
    expect((await searchDashboard(manager, new URLSearchParams({ q: "LEGACY-300001", companyId: companyA }))).jobs).toEqual([]);
    await expect(getCrmJobSnapshot(manager, snapshotA)).rejects.toMatchObject({ status: 404 });
    const before = await financialCounts();
    const ledger = await loadFinancialLedger(admin, companyA);
    expect(ledger.mirrors.find((row) => row.id === billA)?.jobId).toBeNull();
    expect(ledger.links.linkedJobs.size).toBe(0);
    expect((await getJob(admin, sameNamedJob)).booksBills).toEqual([]);
    expect(await financialCounts()).toEqual(before);
  });

  it("returns complete legacy profile history with only safe original metadata and unknown allocation", async () => {
    const original = await db.booksBill.findUniqueOrThrow({ where: { id: billA } });
    const extraIds: string[] = [];
    const sourceDocument = { document_id: "700099", file_name: "Fictional-legacy-original.pdf", file_type: "pdf", file_size: 100,
      download_url: "https://example.invalid/private-download", access_token: "fictional-private-token" };
    let attachmentId: string | undefined;
    try {
      for (let index = 0; index < 23; index++) extraIds.push((await mirror(companyA, String(410000 + index), ["100001"])).id);
      await db.booksBill.update({ where: { id: billA }, data: { sourceSummary: { has_attachment: true },
        sourceDetail: { line_items: [{ project_id: "100001" }], documents: [sourceDocument] } } });
      attachmentId = (await db.booksBillAttachment.create({ data: { billId: billA, companyId: companyA, organizationId: booksA,
        dataCenter: "US", environment: "production", externalDocumentId: sourceDocument.document_id, sourceMetadata: sourceDocument,
        sourceMetadataHash: booksAttachmentMetadataHash(sourceDocument), storageKey: `${randomUUID()}.pdf`, fileName: sourceDocument.file_name,
        mimeType: "application/pdf", byteSize: 100, sha256: "a".repeat(64), downloadedAt: new Date() } })).id;
      const profile = await getCrmJobSnapshot(admin, snapshotA);
      expect(profile).toMatchObject({ jobNumber: null, companyId: null, canonicalJobId: null, referenceKind: "CRM_DEAL",
        displayReference: "LEGACY-300001", historyCompanies: [{ id: companyA }] });
      expect(profile.booksBills).toHaveLength(24);
      expect(new Set(profile.booksBills.map((row) => row.id)).size).toBe(24);
      expect(profile.booksBills.every((row) => row.allocationKnown === false && row.jobId === null && row.jobNumber === null)).toBe(true);
      expect(profile.booksBills.find((row) => row.id === billA)).toMatchObject({
        attachmentStatus: "COMPLETE", documents: [{ attachmentId, status: "AVAILABLE", downloaded: true, fileName: sourceDocument.file_name }],
      });
      expect(JSON.stringify(profile)).not.toMatch(/sourceDetail|sourceMetadata|storageKey|download_url|access_token|fictional-private-token|private-download/);
      expect(profile.historyWarnings.join(" ")).toMatch(/allocation/);
      expect((await getJob(admin, sameNamedJob)).booksBills).toEqual([]);
    } finally {
      if (attachmentId) await db.booksBillAttachment.delete({ where: { id: attachmentId } });
      if (extraIds.length) await db.booksBill.deleteMany({ where: { id: { in: extraIds } } });
      await db.booksBill.update({ where: { id: billA }, data: { sourceSummary: original.sourceSummary as Prisma.InputJsonValue,
        sourceDetail: original.sourceDetail as Prisma.InputJsonValue } });
    }
  });

  it("retains any current authorized project on a multi-project bill and rejects proof revocation during presentation", async () => {
    const second = await importBooksProjectAssociation(admin, proof(companyA, ["300001"], "100002"));
    const secondBill = await mirror(companyA, "400099", ["100002"]);
    const original = await db.booksBill.findUniqueOrThrow({ where: { id: billA } });
    const first = await db.booksProjectAssociation.findFirstOrThrow({ where: { companyId: companyA, booksProjectId: "100001" } });
    try {
      await db.booksBill.update({ where: { id: billA }, data: { sourceDetail: { line_items: [{ project_id: "100001" }, { project_id: "100002" }] } } });
      const relations = (await loadBooksProjectHistory(admin, companyA)).relations.filter((row) => row.billId === billA);
      expect(relations).toHaveLength(2);
      await db.booksBill.update({ where: { id: billA }, data: { sourceDetail: { line_items: [{ project_id: "100001" }] } } });
      const projected = await presentProjectHistory(admin, relations.sort((left, right) => left.booksProjectId.localeCompare(right.booksProjectId)));
      expect(projected.booksBills.map((row) => row.id)).toEqual([billA]);

      const originalFind = db.booksBill.findMany.bind(db.booksBill);
      let changed = false;
      const intercept = vi.spyOn(db.booksBill, "findMany").mockImplementation((...args) => (async () => {
        const rows = await originalFind(...args);
        if (!changed) {
          changed = true;
          await db.booksProjectAssociation.update({ where: { id: first.id }, data: { status: "STALE" } });
        }
        return rows;
      })() as ReturnType<typeof db.booksBill.findMany>);
      try { await expect(getCrmJobSnapshot(admin, snapshotA)).rejects.toMatchObject({ status: 409 }); }
      finally { intercept.mockRestore(); }
    } finally {
      await db.booksProjectAssociation.update({ where: { id: first.id }, data: { status: "VERIFIED" } });
      await db.booksBill.update({ where: { id: billA }, data: { sourceDetail: original.sourceDetail as Prisma.InputJsonValue } });
      await db.booksBill.delete({ where: { id: secondBill.id } });
      await db.booksProjectAssociation.delete({ where: { id: second.id } });
    }
  });

  it("joins new current bills immediately and rejects stale, numeric, partial or unrelated line project IDs", async () => {
    const incoming = await mirror(companyA, "400003", ["100001"]);
    const stale = await mirror(companyA, "400004", ["100001"], { isStale: true });
    const incomplete = await mirror(companyA, "400005", ["100001"], { detailImportRunId: null });
    const numeric = await mirror(companyA, "400006", [100001]);
    const unrelated = await mirror(companyA, "400007", ["100099"]);
    const ids = (await loadBooksProjectHistory(admin, companyA)).relations.map((row) => row.billId);
    expect(ids).toEqual(expect.arrayContaining([billA, incoming.id]));
    for (const excluded of [billB, stale.id, incomplete.id, numeric.id, unrelated.id]) expect(ids).not.toContain(excluded);
    await db.booksBill.update({ where: { id: incoming.id }, data: { sourceDetail: { line_items: [{ project_id: "100099" }] } } });
    expect((await loadBooksProjectHistory(admin, companyA)).relations.map((row) => row.billId)).not.toContain(incoming.id);
  });

  it("preserves multiple Deal associations and scopes the same project ID independently across Books companies", async () => {
    const newer = new Date(Date.now() - 30_000).toISOString();
    await importBooksProjectAssociation(admin, proof(companyA, ["300001", "300002"], "100001", newer));
    await importBooksProjectAssociation(admin, proof(companyB, ["300001"]));
    const own = await loadBooksProjectHistory(admin, companyA), other = await loadBooksProjectHistory(admin, companyB);
    expect(own.relations.map((row) => row.snapshotId).sort()).toEqual([snapshotA, snapshotB].sort());
    expect(own.relations.every((row) => row.billId === billA && row.canonicalJobId === null && row.sourceCompanyId === null)).toBe(true);
    expect(other.relations).toHaveLength(1);
    expect(other.relations[0]).toMatchObject({ billId: billB, companyId: companyB, snapshotId: snapshotA });
  });

  it("retains strict Admin shared-source authority even when a Books company filter is supplied", async () => {
    expect((await loadBooksProjectHistory(manager, companyA)).relations).toEqual([]);
    expect((await loadBooksProjectHistory(entry, companyA)).relations).toEqual([]);
    await expect(loadBooksProjectHistory(outsider, companyA)).rejects.toMatchObject({ status: 404 });
    expect((await loadBooksProjectHistory(outsider, companyB)).relations).toEqual([]);
    await db.userCompanyMembership.update({ where: { userId_companyId: { userId: admin.id, companyId: companyB } }, data: { active: false } });
    try {
      expect((await loadBooksProjectHistory(admin, companyA)).relations).toEqual([]);
      await expect(importBooksProjectAssociation(admin, proof(companyA, ["300001"], "100088"))).rejects.toMatchObject({ status: 403 });
    } finally {
      await db.userCompanyMembership.update({ where: { userId_companyId: { userId: admin.id, companyId: companyB } }, data: { active: true } });
    }
    await db.user.update({ where: { id: admin.id }, data: { role: "MANAGEMENT" } });
    try { await expect(loadBooksProjectHistory(admin)).rejects.toMatchObject({ status: 403 }); }
    finally { await db.user.update({ where: { id: admin.id }, data: { role: "ADMIN" } }); }
  });

  it("rejects a stale worker lease and invalid evidence without replacing previously verified relationships", async () => {
    const before = await db.booksProjectAssociation.findFirstOrThrow({ where: { companyId: companyA, booksProjectId: "100001" } });
    await expect(importBooksProjectAssociation(admin, proof(companyA, ["300001"], "100001", new Date().toISOString()),
      { assertLease: async () => { throw new Error("FICTIONAL_LEASE_LOST"); } })).rejects.toThrow("FICTIONAL_LEASE_LOST");
    await expect(importBooksProjectAssociation(admin, { ...proof(), sourceDealsPages: [
      { deals: [{ id: "300001" }], info: { page: 1, per_page: 200, has_next_page: "true" } },
    ] })).rejects.toThrow();
    await expect(importBooksProjectAssociation(admin, proof(companyA, ["888888"], "100088"))).rejects.toMatchObject({ status: 422 });
    await expect(importBooksProjectAssociation(admin, { ...proof(companyA, ["300001"], "100088"),
      booksSource: { organizationId: booksB, dataCenter: "US", environment: "production" } })).rejects.toMatchObject({ status: 403 });
    expect(await db.booksProjectAssociation.findUniqueOrThrow({ where: { id: before.id } })).toEqual(before);
  });

  it("hides expired or changed-source proof and stale CRM snapshots instead of claiming a current relationship", async () => {
    const row = await db.booksProjectAssociation.findFirstOrThrow({ where: { companyId: companyA, booksProjectId: "100001" } });
    await db.booksProjectAssociation.update({ where: { id: row.id }, data: { validUntil: new Date(Date.now() - 10_000) } });
    const expired = await loadBooksProjectHistory(admin, companyA);
    expect(expired.relations).toEqual([]); expect(expired.warnings).toHaveLength(1);
    const pendingProfile = await getJob(admin, sameNamedJob);
    expect(pendingProfile.booksBills).toEqual([]);
    expect(pendingProfile.booksHistory).toMatchObject({ verificationPending: true, warnings: expired.warnings });
    await db.booksProjectAssociation.update({ where: { id: row.id }, data: { validUntil: row.validUntil, crmEnvironment: "sandbox" } });
    expect((await loadBooksProjectHistory(admin, companyA)).relations).toEqual([]);
    await db.booksProjectAssociation.update({ where: { id: row.id }, data: { crmEnvironment: row.crmEnvironment } });
    await db.crmJobSnapshot.update({ where: { id: snapshotA }, data: { isStale: true } });
    try { expect((await loadBooksProjectHistory(admin, companyA)).relations.map((item) => item.snapshotId)).toEqual([snapshotB]); }
    finally { await db.crmJobSnapshot.update({ where: { id: snapshotA }, data: { isStale: false } }); }
  });

  it("shows unresolved job history and only the current company's Books quota delay", async () => {
    const otherRetry = new Date(Date.now() + 7200_000);
    const ownRetry = new Date(Date.now() + 3600_000);
    const other = await db.incomingSyncState.create({ data: { target: "ZOHO", companyId: companyB,
      organizationId: booksB, dataCenter: "US", environment: "production", scopeHash: "b".repeat(64),
      status: "WAITING_QUOTA", nextRunAt: otherRetry, backoffUntil: otherRetry } });
    const own = await db.incomingSyncState.create({ data: { target: "ZOHO", companyId: companyA,
      organizationId: booksA, dataCenter: "US", environment: "production", scopeHash: "a".repeat(64),
      status: "IDLE", nextRunAt: new Date() } });
    try {
      const before = await getJob(admin, sameNamedJob);
      expect(before.booksBills).toEqual([]);
      expect(before.booksHistory).toMatchObject({ verificationPending: true, refreshPausedUntil: null });
      await db.incomingSyncState.update({ where: { id: own.id }, data: { status: "WAITING_QUOTA", nextRunAt: ownRetry, backoffUntil: ownRetry } });
      const waiting = await getJob(admin, sameNamedJob);
      expect(waiting.booksBills).toEqual([]);
      expect(waiting.booksHistory?.refreshPausedUntil).toBe(ownRetry.toISOString());
      expect((await getJob(entry, sameNamedJob)).booksHistory).toBeUndefined();
      await db.incomingSyncState.update({ where: { id: own.id }, data: { status: "IDLE", nextRunAt: new Date(), backoffUntil: new Date(Date.now() - 1000) } });
      expect((await getJob(admin, sameNamedJob)).booksHistory?.refreshPausedUntil).toBeNull();
    } finally {
      await db.incomingSyncState.deleteMany({ where: { id: { in: [own.id, other.id] } } });
    }
  });

  it("permits canonical navigation only for an exact same-company CRM identity, including source-backed demo flags", async () => {
    const linked = await db.job.create({ data: { companyId: companyA, jobNumber: "JOB-EXACT-SOURCE", name: "Fictional Legacy Site",
      customer: "Fictional customer", externalCrmId: "300002", isDemo: true } });
    await db.crmJobSnapshot.update({ where: { id: snapshotB }, data: { companyId: companyA, booksOrganizationId: booksA,
      jobNumber: linked.jobNumber, normalizedJobNumber: linked.jobNumber, canonicalJobId: linked.id, linkStatus: "READY" } });
    expect((await loadBooksProjectHistory(admin, companyA)).relations.find((row) => row.snapshotId === snapshotB)?.canonicalJobId).toBe(linked.id);
    await importBooksProjectAssociation(admin, proof(companyB, ["300002"], "100002"));
    await mirror(companyB, "400008", ["100002"]);
    expect((await loadBooksProjectHistory(admin, companyB)).relations.find((row) => row.snapshotId === snapshotB)).toMatchObject({
      canonicalJobId: null, sourceCompanyId: companyA, companyId: companyB,
    });
    await db.job.update({ where: { id: linked.id }, data: { externalCrmId: "333333" } });
    expect((await loadBooksProjectHistory(admin, companyA)).relations.find((row) => row.snapshotId === snapshotB)?.canonicalJobId).toBeNull();
  });

  it("rechecks current membership after reading relationship rows", async () => {
    const original = db.$queryRaw.bind(db);
    let changed = false;
    const intercept = vi.spyOn(db, "$queryRaw").mockImplementation((...args) => (async () => {
      const rows = await original(...args);
      if (!changed) {
        changed = true;
        await db.userCompanyMembership.update({ where: { userId_companyId: { userId: admin.id, companyId: companyB } }, data: { active: false } });
      }
      return rows;
    })() as Prisma.PrismaPromise<unknown>);
    try { await expect(loadBooksProjectHistory(admin, companyA)).rejects.toMatchObject({ status: 403 }); }
    finally {
      intercept.mockRestore();
      await db.userCompanyMembership.update({ where: { userId_companyId: { userId: admin.id, companyId: companyB } }, data: { active: true } });
    }
  });

  it("replaces removed associations with a complete empty snapshot while preserving every source bill and job", async () => {
    const before = await financialCounts(), beforeBills = await db.booksBill.count();
    await importBooksProjectAssociation(admin, proof(companyA, [], "100001", new Date().toISOString()));
    expect((await loadBooksProjectHistory(admin, companyA)).relations).toEqual([]);
    expect(await db.booksProjectAssociation.findFirstOrThrow({ where: { companyId: companyA, booksProjectId: "100001" } })).toMatchObject({ status: "UNLINKED", dealIds: [] });
    expect(await financialCounts()).toEqual(before);
    expect(await db.booksBill.count()).toBe(beforeBills);
    expect(fetch).not.toHaveBeenCalled();
  });
});
