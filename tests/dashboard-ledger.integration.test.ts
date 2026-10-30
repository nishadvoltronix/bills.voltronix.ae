import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { dashboard, getJob } from "@/lib/services/catalog";
import { searchDashboard } from "@/lib/services/dashboard-search";
import { assertMySqlTestDatabase } from "./company-fixtures";

const tag = randomUUID().slice(0, 8);
let admin: Actor, entry: Actor, outsider: Actor;
let companyId: string,
  otherCompanyId: string,
  jobId: string,
  runId: string,
  mirrorId: string;
const org = `99${BigInt(`0x${tag}`).toString()}`;
const query = (q: string) => new URLSearchParams({ q, companyId });
const report = () =>
  dashboard(admin, new URLSearchParams({ companyId, currency: "AED" }));
async function mirror(
  externalBillId: string,
  extra: Record<string, unknown> = {},
) {
  return db.booksBill.create({
    data: {
      companyId,
      organizationId: org,
      organizationName: "Fictional ledger",
      dataCenter: "US",
      environment: "production",
      externalBillId,
      billNumber: "MiXeD-Books-531",
      vendorId: "vendor-remote",
      vendorName: "Fictional source supplier",
      status: "partially_paid",
      currencyCode: "AED",
      total: "96.50",
      subtotal: "100",
      taxTotal: "4.50",
      balance: "61.50",
      paymentMade: "25",
      vendorCreditsApplied: "10",
      sourceSummary: {},
      sourceDetail: { discount: 10, adjustment: 2 },
      lastImportRunId: runId,
      detailImportRunId: runId,
      lastSeenAt: new Date(),
      billDate: new Date("2026-01-01T00:00:00Z"),
      ...extra,
    },
  });
}
beforeAll(async () => {
  assertMySqlTestDatabase();
  [admin, entry, outsider] = await Promise.all(
    (["ADMIN", "DATA_ENTRY", "MANAGEMENT"] as const).map((role) =>
      db.user.create({
        data: {
          email: `ledger-${role}-${tag}@example.invalid`,
          name: "Fictional ledger tester",
          role,
          passwordHash: "fixture-unusable",
        },
      }),
    ),
  );
  const company = await db.company.create({
    data: {
      name: "[CONNECTION CHECK] Fictional ledger company",
      isDemo: true,
      memberships: { create: [{ userId: admin.id }, { userId: entry.id }] },
      integrationDestinations: {
        create: {
          target: "ZOHO",
          organizationId: org,
          dataCenter: "US",
          environment: "production",
        },
      },
    },
  });
  companyId = company.id;
  otherCompanyId = (
    await db.company.create({
      data: {
        name: "Fictional confidential company",
        memberships: { create: { userId: outsider.id } },
      },
    })
  ).id;
  jobId = (
    await db.job.create({
      data: {
        companyId,
        jobNumber: "JOB-531",
        name: "Fictional job",
        customer: "Fictional customer",
        contractValue: "1000",
        externalCrmId: `source-${tag}`,
        isDemo: true,
      },
    })
  ).id;
  const vendor = await db.vendor.create({
    data: { companyId, name: "Fictional vendor" },
  });
  const native = await db.bill.create({
    data: {
      companyId,
      vendorId: vendor.id,
      jobId,
      invoiceNumber: "MiXeD-Books-531",
      normalizedInvoiceNumber: "MIXED-BOOKS-531",
      invoiceDate: new Date("2026-01-01"),
      category: "Materials",
      currency: "AED",
      status: "READY",
      subtotal: "100",
      vatRate: "5",
      vatAmount: "5",
      total: "105",
      createdById: admin.id,
      syncRecords: {
        create: {
          target: "ZOHO",
          status: "SYNCED",
          organizationId: org,
          externalId: "remote-1",
        },
      },
    },
  });
  expect(native.id).toBeTruthy();
  await db.bill.create({
    data: {
      companyId,
      vendorId: vendor.id,
      jobId,
      invoiceNumber: "OwN-531",
      normalizedInvoiceNumber: "OWN-531",
      invoiceDate: new Date("2026-01-01"),
      category: "Materials",
      currency: "AED",
      status: "READY",
      subtotal: "20",
      vatRate: "5",
      vatAmount: "1",
      total: "21",
      createdById: entry.id,
    },
  });
  runId = (
    await db.booksImportRun.create({
      data: {
        companyId,
        organizationId: org,
        organizationName: "Fictional source",
        dataCenter: "US",
        environment: "production",
        initiatedById: admin.id,
        status: "COMPLETE",
        listingComplete: true,
        completedAt: new Date(),
      },
    })
  ).id;
  mirrorId = (await mirror("remote-1")).id;
  const crmRun = await db.crmImportRun.create({
    data: {
      crmOrganizationId: org,
      dataCenter: "US",
      environment: "production",
      sourceModule: "Deals",
      initiatedById: admin.id,
      scopeHash: "a".repeat(64),
      mappingJson: {},
      fieldsJson: [],
      status: "COMPLETE",
      listingComplete: true,
      completedAt: new Date(),
    },
  });
  await db.crmJobSnapshot.create({
    data: {
      crmOrganizationId: org,
      dataCenter: "US",
      environment: "production",
      sourceModule: "Deals",
      externalCrmId: `source-${tag}`,
      companyId,
      jobNumber: "JOB-531",
      normalizedJobNumber: "JOB-531",
      name: "Fictional job",
      amount: "1250.00",
      approvedVariations: null,
      currencyCode: "AED",
      canonicalJobId: jobId,
      linkStatus: "READY",
      sourceRecordJson: {},
      importRunId: crmRun.id,
      lastSeenAt: new Date(),
    },
  });
  const otherRun = await db.booksImportRun.create({
    data: {
      companyId: otherCompanyId,
      organizationId: `${org}1`,
      organizationName: "Private",
      dataCenter: "US",
      environment: "production",
      initiatedById: outsider.id,
      status: "COMPLETE",
      listingComplete: true,
      completedAt: new Date(),
    },
  });
  await mirror("remote-private", {
    companyId: otherCompanyId,
    organizationId: `${org}1`,
    lastImportRunId: otherRun.id,
    detailImportRunId: otherRun.id,
    total: "999999",
    vendorName: "CONFIDENTIAL",
  });
});
afterAll(async () => {
  await db.$disconnect();
});

describe("real financial dashboard and scoped lookup", () => {
  it("counts a synchronized bill once using actual provider balances and current CRM amount", async () => {
    const data = await report();
    expect(data.metrics).toMatchObject({
      recordedContractValue: "1250.00",
      jobValue: null,
      recognizedExpenses: "112.00",
      paidExpenses: "25.00",
      outstanding: "82.50",
      creditsApplied: "10.00",
      estimatedProfit: null,
    });
    expect(data.source).toMatchObject({
      booksBillCount: 1,
      nativeBillCount: 1,
      excludedDuplicateNativeCount: 1,
      jobFinancialsComplete: true,
    });
    expect(data.jobs[0]).toMatchObject({
      companyName: "Fictional ledger company",
      contractValue: "1250.00",
      approvedVariations: null,
      adjustedValue: null,
    });
    expect((await getJob(admin, jobId)).booksBills[0].id).toBe(mirrorId);
    expect(JSON.stringify(data)).not.toContain("CONFIDENTIAL");
  });
  it("matches lowercase partial identifiers with a binary database collation", async () => {
    expect(
      (await searchDashboard(admin, query("job-53"))).jobs.map((job) => job.id),
    ).toContain(jobId);
    const result = await searchDashboard(admin, query("mixed-books"));
    expect(result.bills).toHaveLength(1);
    expect(result.bills[0]).toMatchObject({
      id: mirrorId,
      source: "BOOKS",
      jobId,
      companyId,
    });
    expect(JSON.stringify(result)).not.toContain("CONFIDENTIAL");
  });
  it("shows unknown job costs without discarding known company expenses", async () => {
    await mirror("remote-unlinked", {
      billNumber: "UNLINKED-531",
      total: "50",
      taxTotal: "0",
      paymentMade: "50",
      vendorCreditsApplied: "0",
      balance: "0",
      status: "paid",
    });
    const data = await report();
    expect(data.metrics).toMatchObject({
      recordedContractValue: "1250.00",
      recognizedExpenses: "162.00",
      estimatedProfit: null,
    });
    expect(data.jobs[0]).toMatchObject({
      recognizedExpenses: null,
      estimatedProfit: null,
      remainingBudget: null,
    });
    expect(data.source.unlinkedBooksBillCount).toBe(1);
  });
  it("limits data entry to its own native bills and withholds imported financial facts", async () => {
    const data = await dashboard(
      entry,
      new URLSearchParams({ companyId, currency: "AED" }),
    );
    expect(data.metrics).toMatchObject({
      recognizedExpenses: "20.00",
      recordedContractValue: null,
      jobValue: null,
      paidExpenses: "0.00",
    });
    expect(data.source.booksBillCount).toBe(0);
    expect((await searchDashboard(entry, query("mixed"))).bills).toEqual([]);
    expect((await searchDashboard(entry, query("own-"))).bills).toHaveLength(1);
    await expect(
      searchDashboard(outsider, query("mixed")),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("does not resurrect a synchronized native expense after confirmed provider deletion", async () => {
    await db.booksBill.update({
      where: { id: mirrorId },
      data: { isStale: true },
    });
    try {
      const data = await report();
      expect(data.metrics.recognizedExpenses).toBe("70.00");
      expect(data.source).toMatchObject({
        excludedDuplicateNativeCount: 1,
        nativeBillCount: 1,
        booksBillCount: 1,
      });
      expect(await db.bill.count({ where: { companyId } })).toBe(2);
    } finally {
      await db.booksBill.update({
        where: { id: mirrorId },
        data: { isStale: false },
      });
    }
  });
  it("rejects stale role claims before returning any financial data", async () => {
    await db.user.update({
      where: { id: admin.id },
      data: { role: "DATA_ENTRY" },
    });
    await expect(report()).rejects.toMatchObject({ status: 403 });
    await expect(searchDashboard(admin, query("job-53"))).rejects.toMatchObject(
      { status: 403 },
    );
    await db.user.update({ where: { id: admin.id }, data: { role: "ADMIN" } });
  });
  it("ranks exact matches first, bounds broad results and treats wildcards literally", async () => {
    await db.job.createMany({
      data: Array.from({ length: 24 }, (_, index) => ({
        companyId,
        jobNumber: `JOB-531-${index}`,
        name: "Fictional ranked job",
        customer: "Fictional customer",
      })),
    });
    const jobs = await searchDashboard(admin, query("job-531"));
    expect(jobs.jobs).toHaveLength(20);
    expect(jobs.jobs[0].id).toBe(jobId);
    expect(jobs.hasMore).toBe(true);
    const literal = await mirror("literal-wildcard", {
      billNumber: "LITERAL%_531",
    });
    expect(
      (await searchDashboard(admin, query("%_"))).bills.map((bill) => bill.id),
    ).toEqual([literal.id]);
    expect((await searchDashboard(admin, query("x' OR 1=1 --"))).bills).toEqual(
      [],
    );
  });
  it("preserves explicit unknown tax data in the compact JSON projection", async () => {
    await mirror("unknown-tax-detail", { sourceDetail: { tds_total: null } });
    const data = await report();
    expect(data.metrics.recognizedExpenses).toBeNull();
    expect(data.source.unknownFinancialBillCount).toBe(1);
    expect(data.monthlyExpenses).toEqual([]);
  });
});
