import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Job, Prisma } from "@prisma/client";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { getJob } from "@/lib/services/catalog";
import { booksAttachmentMetadataHash } from "@/lib/services/books-attachments";
import { searchDashboard } from "@/lib/services/dashboard-search";
import {
  assertMySqlTestDatabase,
  bindTestDestination,
  createTestCompany,
} from "./company-fixtures";

const tag = randomUUID().slice(0, 8),
  organizationA = `98${BigInt(`0x${tag}`).toString()}`,
  organizationB = `${organizationA}2`;
let admin: Actor, entry: Actor, manager: Actor, outsider: Actor;
let companyA: string, companyB: string, runA: string, runB: string;
let jobA: Job, jobB: Job, jobOtherA: Job, historyJob: Job;
let renamedMirrorId: string,
  renamedNativeId: string,
  ownNativeId: string,
  originalId: string,
  nativeDocumentId: string;
const vendors = new Map<string, string>();
const sourceDocument = {
  document_id: "70001",
  file_name: "Fictional-original.pdf",
  file_type: "pdf",
  file_size: 100,
  download_url: "https://example.invalid/provider-secret",
  opaque_token: "private-source-token",
};
const query = (q: string, companyId?: string) =>
  new URLSearchParams({ q, ...(companyId ? { companyId } : {}) });
async function job(
  companyId: string,
  jobNumber: string,
  name = "Fictional work site",
) {
  return db.job.create({
    data: {
      companyId,
      jobNumber,
      name,
      customer: "Fictional customer",
      currency: "AED",
    },
  });
}
async function native(
  job: Job,
  invoiceNumber: string,
  input: {
    actor?: Actor;
    externalId?: string;
    vendorId?: string;
    currency?: string;
  } = {},
) {
  return db.bill.create({
    data: {
      companyId: job.companyId,
      jobId: job.id,
      vendorId: input.vendorId ?? vendors.get(job.companyId)!,
      invoiceNumber,
      normalizedInvoiceNumber: invoiceNumber.toUpperCase(),
      invoiceDate: new Date("2026-01-01"),
      category: "Materials",
      currency: input.currency ?? "AED",
      status: "READY",
      subtotal: "10",
      vatRate: "0",
      vatAmount: "0",
      total: "10",
      createdById: (input.actor ?? admin).id,
      ...(input.externalId
        ? {
            syncRecords: {
              create: {
                target: "ZOHO",
                status: "SYNCED",
                externalId: input.externalId,
                organizationId:
                  job.companyId === companyA ? organizationA : organizationB,
              },
            },
          }
        : {}),
    },
  });
}
async function mirror(
  companyId: string,
  externalBillId: string,
  billNumber: string,
  extra: Partial<Prisma.BooksBillUncheckedCreateInput> = {},
) {
  return db.booksBill.create({
    data: {
      companyId,
      organizationId: companyId === companyA ? organizationA : organizationB,
      organizationName: "Fictional search company",
      dataCenter: "US",
      environment: "production",
      externalBillId,
      billNumber,
      vendorId: "80001",
      vendorName: "Fictional provider supplier",
      status: "open",
      currencyCode: "AED",
      subtotal: "10",
      taxTotal: "0",
      total: "10",
      balance: "10",
      paymentMade: "0",
      vendorCreditsApplied: "0",
      sourceSummary: {},
      sourceDetail: {},
      lastImportRunId: companyId === companyA ? runA : runB,
      detailImportRunId: companyId === companyA ? runA : runB,
      billDate: new Date("2026-01-01"),
      lastSeenAt: new Date(),
      ...extra,
    },
  });
}

beforeAll(async () => {
  assertMySqlTestDatabase();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Dashboard lookup must not call a provider");
    }),
  );
  [admin, entry, manager, outsider] = await Promise.all(
    (["ADMIN", "DATA_ENTRY", "MANAGEMENT", "MANAGEMENT"] as const).map(
      (role, index) =>
        db.user.create({
          data: {
            email: `manual-lookup-${index}-${tag}@example.invalid`,
            name: "Fictional lookup reader",
            role,
            passwordHash: "unusable",
          },
        }),
    ),
  );
  companyA = (
    await createTestCompany(`manual lookup A ${tag}`, [admin, entry, manager])
  ).id;
  companyB = (
    await createTestCompany(`manual lookup B ${tag}`, [admin, outsider])
  ).id;
  for (const [companyId, organizationId] of [
    [companyA, organizationA],
    [companyB, organizationB],
  ]) {
    await bindTestDestination(companyId, {
      target: "ZOHO",
      organizationId,
      environment: "production",
    });
    vendors.set(
      companyId,
      (
        await db.vendor.create({
          data: { companyId, name: "Fictional search supplier" },
        })
      ).id,
    );
    const run = await db.booksImportRun.create({
      data: {
        companyId,
        organizationId,
        organizationName: "Fictional search company",
        dataCenter: "US",
        environment: "production",
        initiatedById: admin.id,
        status: "COMPLETE",
        listingComplete: true,
        completedAt: new Date(),
      },
    });
    if (companyId === companyA) runA = run.id;
    else runB = run.id;
  }
  [jobA, jobB, jobOtherA, historyJob] = await Promise.all([
    job(companyA, "JOB-ALPHA", "Fictional Switch Room"),
    job(companyB, "JOB-BRAVO"),
    job(companyA, "JOB-CHARLIE"),
    job(companyA, "JOB-HISTORY"),
  ]);
  renamedNativeId = (
    await native(jobA, "LOCAL-ORIGINAL-001", { externalId: "90001" })
  ).id;
  ownNativeId = (await native(jobA, "ENTRY-OWN-001", { actor: entry })).id;
  renamedMirrorId = (
    await mirror(companyA, "90001", "RENAMED-SOURCE-001", {
      sourceSummary: { has_attachment: true },
      sourceDetail: { documents: [sourceDocument] },
    })
  ).id;
  originalId = (
    await db.booksBillAttachment.create({
      data: {
        billId: renamedMirrorId,
        companyId: companyA,
        organizationId: organizationA,
        dataCenter: "US",
        environment: "production",
        externalDocumentId: sourceDocument.document_id,
        sourceMetadata: sourceDocument,
        sourceMetadataHash: booksAttachmentMetadataHash(sourceDocument),
        storageKey: `${randomUUID()}.pdf`,
        fileName: "Fictional-original.pdf",
        mimeType: "application/pdf",
        byteSize: 100,
        sha256: "a".repeat(64),
        downloadedAt: new Date(),
      },
    })
  ).id;
  nativeDocumentId = (
    await db.document.create({
      data: {
        billId: ownNativeId,
        storageKey: `${randomUUID()}.pdf`,
        fileName: "Fictional-own.pdf",
        mimeType: "application/pdf",
        byteSize: 100,
        sha256: "b".repeat(64),
        uploadedById: entry.id,
      },
    })
  ).id;
  await db.document.create({
    data: {
      billId: renamedNativeId,
      storageKey: `${randomUUID()}.pdf`,
      fileName: "Fictional-admin-private.pdf",
      mimeType: "application/pdf",
      byteSize: 100,
      sha256: "c".repeat(64),
      uploadedById: admin.id,
    },
  });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await db.$disconnect();
});

describe("manual job lookup through confirmed bill identity", () => {
  it("returns a native bill's real job for a bill-number-only query and keeps job-name lookup", async () => {
    const result = await searchDashboard(
      admin,
      query("entry-own-001", companyA),
    );
    expect(result.jobs).toEqual([
      expect.objectContaining({
        id: jobA.id,
        canonicalJobId: jobA.id,
        href: `/jobs/${jobA.id}`,
        canCreateBill: true,
      }),
    ]);
    expect(result.bills[0]).toMatchObject({
      id: ownNativeId,
      jobId: jobA.id,
      relatedJobs: [
        {
          id: jobA.id,
          jobNumber: jobA.jobNumber,
          name: jobA.name,
          companyId: companyA,
        },
      ],
    });
    expect(
      (await searchDashboard(admin, query("switch room", companyA))).jobs.map(
        (row) => row.id,
      ),
    ).toContain(jobA.id);
  });

  it("resolves a renamed Books bill through its provider identity even when its native bill number differs", async () => {
    const result = await searchDashboard(
      admin,
      query("renamed-source-001", companyA),
    );
    expect(result.jobs.map((row) => row.id)).toEqual([jobA.id]);
    expect(result.bills).toHaveLength(1);
    expect(result.bills[0]).toMatchObject({
      id: renamedMirrorId,
      source: "BOOKS",
      jobId: jobA.id,
      relatedJobs: [
        {
          id: jobA.id,
          jobNumber: jobA.jobNumber,
          name: jobA.name,
          companyId: companyA,
        },
      ],
    });
    expect(result.hasMore).toBe(false);
    const unsupported = await mirror(companyA, "90002", "UNLINKED-SOURCE-001");
    const unknown = await searchDashboard(
      admin,
      query("unlinked-source-001", companyA),
    );
    expect(unknown.jobs).toEqual([]);
    expect(unknown.bills[0]).toMatchObject({
      id: unsupported.id,
      jobId: null,
      relatedJobs: [],
    });
  });

  it("returns every scoped job for ambiguous bill numbers without choosing a company or supplier", async () => {
    const anotherVendor = await db.vendor.create({
      data: { companyId: companyA, name: "Fictional second supplier" },
    });
    await native(jobA, "AMBIGUOUS-REFERENCE", { externalId: "90010" });
    await native(jobOtherA, "AMBIGUOUS-REFERENCE", {
      vendorId: anotherVendor.id,
      externalId: "90011",
    });
    await native(jobB, "AMBIGUOUS-REFERENCE", { externalId: "90012" });
    await mirror(companyA, "90010", "AMBIGUOUS-REFERENCE");
    await mirror(companyA, "90011", "AMBIGUOUS-REFERENCE");
    await mirror(companyB, "90012", "AMBIGUOUS-REFERENCE");
    const all = await searchDashboard(admin, query("ambiguous-reference"));
    expect(all.jobs.map((row) => row.id).sort()).toEqual(
      [jobA.id, jobB.id, jobOtherA.id].sort(),
    );
    expect(all.bills).toHaveLength(3);
    expect(
      all.bills.every(
        (row) => row.source === "BOOKS" && row.relatedJobs.length === 1,
      ),
    ).toBe(true);
    const scoped = await searchDashboard(
      admin,
      query("ambiguous-reference", companyA),
    );
    expect(scoped.jobs.map((row) => row.id).sort()).toEqual(
      [jobA.id, jobOtherA.id].sort(),
    );
    expect(
      scoped.bills.every(
        (row) => row.companyId === companyA && row.relatedJobs.length === 1,
      ),
    ).toBe(true);
    expect(
      (await searchDashboard(outsider, query("ambiguous-reference"))).jobs.map(
        (row) => row.id,
      ),
    ).toEqual([jobB.id]);
  });

  it("rejects conflicting confirmed identities and keeps differently scoped Books identities unassigned", async () => {
    await native(jobA, "CONFLICT-NATIVE-A", { externalId: "90003" });
    await expect(
      native(jobOtherA, "CONFLICT-NATIVE-B", { externalId: "90003" }),
    ).rejects.toMatchObject({ code: "P2002" });
    const conflict = await mirror(companyA, "90003", "CONFLICT-SOURCE-ONLY");
    const ambiguous = await searchDashboard(
      admin,
      query("conflict-source-only", companyA),
    );
    expect(ambiguous.jobs.map((row) => row.id)).toEqual([jobA.id]);
    expect(ambiguous.bills[0]).toMatchObject({
      id: conflict.id,
      jobId: jobA.id,
      relatedJobs: [{ id: jobA.id }],
    });
    await native(jobA, "ENV-NATIVE", { externalId: "90004" });
    const wrongEnvironment = await mirror(
      companyA,
      "90004",
      "ENV-SOURCE-ONLY",
      { environment: "sandbox" },
    );
    const otherEnvironment = await searchDashboard(
      admin,
      query("env-source-only", companyA),
    );
    expect(otherEnvironment.jobs).toEqual([]);
    expect(otherEnvironment.bills[0]).toMatchObject({
      id: wrongEnvironment.id,
      relatedJobs: [],
    });
  });

  it("applies role, ownership, company and real-job rules to bill-derived candidates", async () => {
    expect(
      (await searchDashboard(entry, query("entry-own-001", companyA))).jobs.map(
        (row) => row.id,
      ),
    ).toEqual([jobA.id]);
    expect(
      await searchDashboard(entry, query("local-original-001", companyA)),
    ).toMatchObject({ jobs: [], bills: [] });
    expect(
      await searchDashboard(entry, query("renamed-source-001", companyA)),
    ).toMatchObject({ jobs: [], bills: [] });
    expect(
      (await searchDashboard(manager, query("renamed-source-001", companyA)))
        .jobs[0].canCreateBill,
    ).toBe(false);
    await expect(
      searchDashboard(outsider, query("renamed-source-001", companyA)),
    ).rejects.toMatchObject({ status: 404 });
    const demo = await db.job.create({
      data: {
        companyId: companyA,
        jobNumber: "DEMO-JOB",
        name: "Fictional demonstration",
        customer: "Fictional customer",
        isDemo: true,
      },
    });
    const demonstration = await native(demo, "DEMO-INVOICE-ONLY");
    const filtered = await searchDashboard(
      admin,
      query("demo-invoice-only", companyA),
    );
    expect(filtered.jobs).toEqual([]);
    expect(filtered.bills[0]).toMatchObject({
      id: demonstration.id,
      jobId: null,
      relatedJobs: [],
    });
    await db.user.update({
      where: { id: manager.id },
      data: { active: false },
    });
    try {
      await expect(
        searchDashboard(manager, query("renamed-source-001", companyA)),
      ).rejects.toMatchObject({ status: 403 });
    } finally {
      await db.user.update({
        where: { id: manager.id },
        data: { active: true },
      });
    }
    await db.userCompanyMembership.update({
      where: { userId_companyId: { userId: entry.id, companyId: companyA } },
      data: { active: false },
    });
    try {
      await expect(
        searchDashboard(entry, query("entry-own-001", companyA)),
      ).rejects.toMatchObject({ status: 404 });
    } finally {
      await db.userCompanyMembership.update({
        where: { userId_companyId: { userId: entry.id, companyId: companyA } },
        data: { active: true },
      });
    }
  });

  it("ranks exact bill-derived jobs first and reports truncation instead of omitting more matches silently", async () => {
    const exact = await job(companyA, "ZZZ-EXACT", "Fictional exact bill job");
    await native(exact, "BULK-LOOKUP");
    for (let index = 0; index < 23; index++)
      await native(
        await job(companyA, `AAA-BROAD-${index}`),
        `BULK-LOOKUP-${index}`,
      );
    const result = await searchDashboard(admin, query("bulk-lookup", companyA));
    expect(result.jobs).toHaveLength(20);
    expect(result.jobs[0].id).toBe(exact.id);
    expect(result.bills).toHaveLength(20);
    expect(result.hasMore).toBe(true);
  });
});

describe("full job history and safe attachment metadata", () => {
  it("keeps historical bills in other currencies visible without mixing their amounts into job totals", async () => {
    const foreignVendor = await db.vendor.create({
      data: {
        companyId: companyB,
        name: "Fictional foreign supplier",
        currency: "USD",
      },
    });
    const foreignJob = await job(companyB, "JOB-CURRENCY-HISTORY");
    const foreignNative = await native(foreignJob, "FOREIGN-ORIGINAL", {
      currency: "USD",
      vendorId: foreignVendor.id,
      externalId: "90040",
    });
    const foreignMirror = await mirror(companyB, "90040", "FOREIGN-SOURCE", {
      currencyCode: "USD",
    });
    const result = await getJob(admin, foreignJob.id);
    expect(result.bills).toEqual([
      expect.objectContaining({ id: foreignNative.id, currency: "USD" }),
    ]);
    expect(result.booksBills).toEqual([
      expect.objectContaining({
        id: foreignMirror.id,
        currency: "USD",
        jobId: foreignJob.id,
      }),
    ]);
    expect(result.financialCompleteness.complete).toBe(false);
    expect(result.job).toMatchObject({
      currency: "AED",
      recognizedExpenses: null,
      paidExpenses: null,
      outstanding: null,
      estimatedProfit: null,
    });

    const nativeOnlyJob = await job(companyB, "JOB-NATIVE-CURRENCY-HISTORY");
    const nativeOnlyBill = await native(nativeOnlyJob, "FOREIGN-UNSYNCED", {
      currency: "USD",
      vendorId: foreignVendor.id,
    });
    const nativeOnly = await getJob(admin, nativeOnlyJob.id);
    expect(nativeOnly.bills).toEqual([
      expect.objectContaining({ id: nativeOnlyBill.id, currency: "USD" }),
    ]);
    expect(nativeOnly.booksBills).toEqual([]);
    expect(nativeOnly.financialCompleteness.complete).toBe(false);
    expect(nativeOnly.job).toMatchObject({
      recognizedExpenses: null,
      paidExpenses: null,
      outstanding: null,
    });
  });

  it("returns history beyond the search's twenty-result limit and whitelists original/native document fields", async () => {
    for (let index = 0; index < 25; index++)
      await native(historyJob, `FULL-HISTORY-${index}`);
    const history = await getJob(admin, historyJob.id);
    expect(history.bills).toHaveLength(25);
    const result = await getJob(admin, jobA.id);
    const imported = result.booksBills.find(
      (row) => row.id === renamedMirrorId,
    )!;
    expect(imported).toMatchObject({
      attachmentStatus: "COMPLETE",
      downloadedAttachmentCount: 1,
      documents: [
        {
          id: "70001",
          attachmentId: originalId,
          status: "AVAILABLE",
          downloaded: true,
          mimeType: "application/pdf",
        },
      ],
    });
    expect(
      result.bills.find((row) => row.id === ownNativeId)?.documents,
    ).toEqual([
      expect.objectContaining({
        id: nativeDocumentId,
        fileName: "Fictional-own.pdf",
      }),
    ]);
    const serialized = JSON.stringify(result);
    for (const secret of [
      "storageKey",
      "sourceMetadataHash",
      "sourceDetail",
      "provider-secret",
      "private-source-token",
    ])
      expect(serialized).not.toContain(secret);
  });

  it("shows changed or stale original metadata as pending and restricts native document history by ownership", async () => {
    await db.booksBill.update({
      where: { id: renamedMirrorId },
      data: {
        sourceDetail: {
          documents: [{ ...sourceDocument, file_name: "Updated-source.pdf" }],
        },
      },
    });
    try {
      const changed = (await getJob(admin, jobA.id)).booksBills.find(
        (row) => row.id === renamedMirrorId,
      )!;
      expect(changed).toMatchObject({
        attachmentStatus: "PENDING",
        downloadedAttachmentCount: 0,
        documents: [
          {
            id: "70001",
            attachmentId: null,
            status: "PENDING",
            downloaded: false,
          },
        ],
      });
      await db.booksBill.update({
        where: { id: renamedMirrorId },
        data: { detailImportRunId: null },
      });
      const stale = (await getJob(admin, jobA.id)).booksBills.find(
        (row) => row.id === renamedMirrorId,
      )!;
      expect(stale).toMatchObject({
        attachmentStatus: "PENDING",
        documents: [],
        downloadedAttachmentCount: 0,
      });
    } finally {
      await db.booksBill.update({
        where: { id: renamedMirrorId },
        data: {
          sourceDetail: { documents: [sourceDocument] },
          detailImportRunId: runA,
        },
      });
    }
    const own = await getJob(entry, jobA.id);
    expect(own.bills.map((row) => row.id)).toEqual([ownNativeId]);
    expect(own.booksBills).toEqual([]);
    expect(JSON.stringify(own)).not.toContain("Fictional-admin-private.pdf");
    await expect(getJob(outsider, jobA.id)).rejects.toMatchObject({
      status: 404,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
