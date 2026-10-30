import { randomUUID } from "node:crypto";
import path from "node:path";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { companyIdsForActor, listCompanies } from "@/lib/company";
import {
  createBill,
  getBill,
  listBills,
  updateBill,
  actOnBill,
} from "@/lib/services/bills";
import {
  createVendor,
  createJob,
  listVendors,
  listJobs,
  getJob,
  dashboard,
  auditEvents,
} from "@/lib/services/catalog";
import { attachDocument, downloadDocument } from "@/lib/services/documents";
import { expenseReport, operationSummary } from "@/lib/services/reports";
import {
  createOcrBatch,
  getOcrBatch,
  getOcrDocument,
  downloadOcrDocument,
  listOcrBatches,
  createOcrTemplate,
  listOcrTemplates,
  reviewOcrDocument,
} from "@/lib/services/ocr";
import {
  assertMySqlTestDatabase,
  createTestCompany,
  addTestMemberships,
} from "./company-fixtures";

const tag = randomUUID().slice(0, 8);
let adminA: Actor,
  adminB: Actor,
  both: Actor,
  writerA: Actor,
  reviewerA: Actor,
  outsider: Actor;
let companyA: string,
  companyB: string,
  vendorA: string,
  vendorB: string,
  jobA: string,
  jobB: string;
let billA: Awaited<ReturnType<typeof createBill>>,
  billB: Awaited<ReturnType<typeof createBill>>;
const payload = (
  companyId: string,
  vendorId: string,
  jobId: string,
  extras: Record<string, unknown> = {},
) => ({
  companyId,
  vendorId,
  jobId,
  invoiceNumber: `ISOLATION-${tag}-${randomUUID()}`,
  invoiceDate: "2026-10-28",
  category: "MATERIALS",
  currency: "AED",
  discount: "0",
  vatRate: "5",
  lines: [
    {
      description: "Fictional isolation materials",
      quantity: "2",
      unitPrice: "50.00",
    },
  ],
  ...extras,
});
const pdf = (marker: string) =>
  new File(
    [`%PDF-1.7\nFictional company isolation ${tag} ${marker}\n%%EOF`],
    "DEMO-isolation.pdf",
    { type: "application/pdf" },
  );

beforeAll(async () => {
  assertMySqlTestDatabase();
  vi.stubEnv("UPLOAD_DIR", path.resolve(".local", `company-isolation-${tag}`));
  vi.stubEnv("OCR_PROVIDER", "disabled");
  [adminA, adminB, both, writerA, reviewerA, outsider] = await Promise.all(
    (
      ["ADMIN", "ADMIN", "ADMIN", "DATA_ENTRY", "ACCOUNTS", "ADMIN"] as const
    ).map((role, index) =>
      db.user.create({
        data: {
          email: `company-${tag}-${index}@example.invalid`,
          name: `Fictional company actor ${index}`,
          role,
          passwordHash: "unused-isolation-fixture",
        },
      }),
    ),
  );
  companyA = (
    await createTestCompany(`isolation A ${tag}`, [
      adminA,
      both,
      writerA,
      reviewerA,
    ])
  ).id;
  companyB = (await createTestCompany(`isolation B ${tag}`, [adminB, both])).id;
  vendorA = (
    await createVendor(adminA, {
      name: `Fictional shared supplier ${tag}`,
      currency: "AED",
    })
  ).id;
  vendorB = (
    await createVendor(adminB, {
      name: `Fictional shared supplier ${tag}`,
      currency: "AED",
    })
  ).id;
  jobA = (
    await createJob(adminA, {
      jobNumber: `SAME-${tag}`,
      name: "Fictional A job",
      customer: "Fictional customer",
      contractValue: "1000.00",
      currency: "AED",
    })
  ).id;
  jobB = (
    await createJob(adminB, {
      jobNumber: `SAME-${tag}`,
      name: "Fictional B job",
      customer: "Fictional customer",
      contractValue: "1000.00",
      currency: "AED",
    })
  ).id;
  billA = await createBill(writerA, payload(companyA, vendorA, jobA));
  billB = await createBill(adminB, payload(companyB, vendorB, jobB));
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await db.$disconnect();
});

describe("real MySQL company authorization", () => {
  it("scopes companies, catalogs, bill search and pagination without an Admin bypass", async () => {
    expect((await listCompanies(adminA)).map((item) => item.id)).toEqual([
      companyA,
    ]);
    expect((await listVendors(adminA)).map((item) => item.id)).toEqual([
      vendorA,
    ]);
    expect((await listJobs(adminA)).map((item) => item.id)).toEqual([jobA]);
    expect(
      (await listBills(adminA, new URLSearchParams())).bills.map(
        (item) => item.id,
      ),
    ).toEqual([billA.id]);
    expect(
      (
        await listBills(
          adminA,
          new URLSearchParams({ q: billB.invoiceNumber, pageSize: "1" }),
        )
      ).total,
    ).toBe(0);
    expect(await listCompanies(outsider)).toEqual([]);
    expect((await listBills(outsider, new URLSearchParams())).total).toBe(0);
    await expect(getBill(adminA, billB.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(getJob(adminA, jobB)).rejects.toMatchObject({ status: 404 });
    await expect(
      listBills(adminA, new URLSearchParams({ companyId: companyB })),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("requires explicit selection with several memberships and rejects mixed-company references", async () => {
    const input = payload(companyA, vendorA, jobA);
    const { companyId: omitted, ...ambiguous } = input;
    void omitted;
    await expect(createBill(both, ambiguous)).rejects.toMatchObject({
      status: 422,
    });
    await expect(
      createBill(adminA, payload(companyB, vendorB, jobB)),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      createBill(both, payload(companyA, vendorB, jobA)),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      createBill(both, payload(companyA, vendorA, jobB)),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      updateBill(
        both,
        billA.id,
        payload(companyB, vendorB, jobB, { version: billA.version }),
      ),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      actOnBill(adminA, billB.id, { action: "submit", version: billB.version }),
    ).rejects.toMatchObject({ status: 404 });
    expect((await getBill(adminB, billB.id)).status).toBe("DRAFT");
  });

  it("finds exact local and saved CRM job IDs within the selected company and retains role-scoped summaries", async () => {
    const externalCrmId = `9900${Number.parseInt(tag, 16)}`;
    await db.job.updateMany({
      where: { id: { in: [jobA, jobB] } },
      data: { externalCrmId },
    });
    try {
      const detail = await getJob(adminA, jobA);
      expect(await listJobs(adminA, jobA, companyA)).toEqual([detail.job]);
      expect(await listJobs(adminA, externalCrmId, companyA)).toEqual([detail.job]);
      expect((await listJobs(both, externalCrmId, companyB)).map(job => job.id)).toEqual([jobB]);
      expect(await listJobs(adminA, jobB)).toEqual([]);
      expect(await listJobs(adminA, jobA.slice(1), companyA)).toEqual([]);
      expect(await listJobs(adminA, externalCrmId.slice(0, -1), companyA)).toEqual([]);
      expect(await listJobs(outsider, externalCrmId)).toEqual([]);
      await expect(listJobs(adminA, externalCrmId, companyB)).rejects.toMatchObject({ status: 404 });

      const ownDetail = await getJob(writerA, jobA);
      const ownResults = await listJobs(writerA, externalCrmId, companyA);
      expect(ownResults).toEqual([ownDetail.job]);
      expect(ownResults[0]).toMatchObject({ contractValue: null, adjustedValue: null, financialScope: "YOUR_BILLS" });
      expect(ownResults[0].billCount).toBe(await db.bill.count({ where: { jobId: jobA, createdById: writerA.id } }));
    } finally {
      await db.job.updateMany({ where: { id: { in: [jobA, jobB] } }, data: { externalCrmId: null } });
    }
  });

  it("treats wildcard characters as literal job text while retaining name and customer substring searches", async () => {
    const originals = await db.job.findMany({ where: { id: { in: [jobA, jobB] } }, select: { id: true, jobNumber: true, name: true, customer: true } });
    try {
      await db.job.update({ where: { id: jobA }, data: { jobNumber: `LITERAL_${tag}`, name: "Fictional 50% job", customer: "Fictional \\ customer" } });
      await db.job.update({ where: { id: jobB }, data: { jobNumber: `LITERALX${tag}`, name: "Fictional 50percent job", customer: "Fictional slash customer" } });
      for (const q of ["%", "_", "\\", "50%", "LITERAL_"]) {
        expect((await listJobs(both, q)).map(job => job.id)).toEqual([jobA]);
        expect(await listJobs(both, q, companyB)).toEqual([]);
      }
      expect((await listJobs(adminA, "50%", companyA)).map(job => job.id)).toEqual([jobA]);
      expect((await listJobs(adminB, "slash customer", companyB)).map(job => job.id)).toEqual([jobB]);
      expect((await listJobs(both, "Fictional")).map(job => job.id).sort()).toEqual([jobA, jobB].sort());
    } finally {
      for (const { id, ...data } of originals) await db.job.update({ where: { id }, data });
    }
  });

  it("enforces company foreign keys at the actual database and rolls back the whole write", async () => {
    const before = await db.bill.count();
    await expect(
      db.$transaction(async (tx) => {
        await tx.bill.create({
          data: {
            companyId: companyA,
            vendorId: vendorB,
            jobId: jobA,
            invoiceNumber: `INVALID-${tag}`,
            normalizedInvoiceNumber: `INVALID-${tag}`,
            invoiceDate: new Date("2026-10-28"),
            currency: "AED",
            category: "MATERIALS",
            subtotal: "1",
            vatAmount: "0",
            total: "1",
            createdById: adminA.id,
            lines: {
              create: {
                description: "Must roll back",
                quantity: "1",
                unitPrice: "1",
                lineTotal: "1",
              },
            },
          },
        });
      }),
    ).rejects.toThrow();
    expect(await db.bill.count()).toBe(before);
    expect(
      await db.billLine.count({ where: { description: "Must roll back" } }),
    ).toBe(0);
  });

  it("scopes financial totals, report rows, audit entries and operation counts", async () => {
    const ready = await createBill(
      writerA,
      payload(companyA, vendorA, jobA, { submit: true }),
    );
    expect(ready).toMatchObject({ status: "READY", approvedById: null });
    expect(
      (await dashboard(adminB, new URLSearchParams({ currency: "AED" })))
        .metrics.recognizedExpenses,
    ).toBe("0.00");
    const report = await expenseReport(
      adminA,
      new URLSearchParams({ currency: "AED" }),
    );
    expect(report.totals.recognized).toBe("100.00");
    expect(report.rows.some((row) => row.id === billB.id)).toBe(false);
    expect(
      (await auditEvents(adminA)).every(
        (event) => event.companyId === companyA,
      ),
    ).toBe(true);
    const ownFailures = (await operationSummary(adminA)).syncFailures;
    await db.syncRecord.update({
      where: { billId_target: { billId: billB.id, target: "ZOHO" } },
      data: { status: "FAILED" },
    });
    // This company's new finalized bill has its own blocked configuration;
    // another company's failure must not affect that count.
    expect((await operationSummary(adminA)).syncFailures).toBe(ownFailures);
    expect((await operationSummary(adminB)).syncFailures).toBe(1);
    await expect(
      expenseReport(adminA, new URLSearchParams({ companyId: companyB })),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("restricts attachments before file access and metadata changes", async () => {
    const document = await attachDocument(adminB, billB.id, pdf("attachment"));
    await expect(downloadDocument(adminA, document.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      attachDocument(adminA, billB.id, pdf("forbidden")),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (await downloadDocument(adminB, document.id)).bytes.byteLength,
    ).toBeGreaterThan(8);
    expect(await db.document.count({ where: { billId: billB.id } })).toBe(1);
  });

  it("isolates OCR originals, batches, templates and draft company assignment", async () => {
    const bytes = pdf("shared-content");
    const a = await createOcrBatch(adminA, [bytes], companyA);
    const b = await createOcrBatch(adminB, [bytes], companyB);
    expect(
      (await listOcrBatches(adminA)).batches.map((batch) => batch.id),
    ).toContain(a.id);
    expect(
      (await listOcrBatches(adminA)).batches.map((batch) => batch.id),
    ).not.toContain(b.id);
    await expect(getOcrBatch(adminA, b.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      downloadOcrDocument(adminA, b.documents[0].id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      getOcrDocument(adminA, b.documents[0].id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      createOcrTemplate(adminA, {
        vendorId: vendorB,
        name: "Forbidden template",
        mappings: {},
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(await listOcrTemplates(outsider)).toEqual([]);
    await expect(
      reviewOcrDocument(both, b.documents[0].id, {
        version: 1,
        confirmed: true,
        bill: payload(companyA, vendorA, jobA),
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("applies membership revocation and company deactivation immediately", async () => {
    await addTestMemberships(companyA, [outsider]);
    expect(await companyIdsForActor(outsider)).toEqual([companyA]);
    expect((await getBill(outsider, billA.id)).id).toBe(billA.id);
    await db.userCompanyMembership.update({
      where: { userId_companyId: { userId: outsider.id, companyId: companyA } },
      data: { active: false },
    });
    await expect(getBill(outsider, billA.id)).rejects.toMatchObject({
      status: 404,
    });
    expect((await listBills(outsider, new URLSearchParams())).total).toBe(0);
    expect(await listJobs(outsider, jobA)).toEqual([]);
    await expect(listJobs(outsider, jobA, companyA)).rejects.toMatchObject({ status: 404 });
    await db.company.update({
      where: { id: companyB },
      data: { active: false },
    });
    await expect(getBill(adminB, billB.id)).rejects.toMatchObject({
      status: 404,
    });
    expect(await listJobs(adminB, jobB)).toEqual([]);
    await db.company.update({
      where: { id: companyB },
      data: { active: true },
    });
  });

  it("rejects overlong Unicode-normalized invoice references before persistence", async () => {
    await expect(
      createBill(
        adminA,
        payload(companyA, vendorA, jobA, { invoiceNumber: "ﷺ".repeat(30) }),
      ),
    ).rejects.toMatchObject({ status: 422 });
  });
});
