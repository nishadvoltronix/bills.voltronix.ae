import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { normalizeAzureInvoice } from "@/lib/ocr-extraction";
import { actOnBill, createBill } from "@/lib/services/bills";
import { downloadDocument } from "@/lib/services/documents";
import {
  createOcrBatch,
  createOcrTemplate,
  countOcrDuplicateWarnings,
  downloadOcrDocument,
  getOcrDocument,
  listOcrBatches,
  listOcrTemplates,
  ocrErrorsCsv,
  processOcrQueue,
  retryOcrDocument,
  reviewOcrDocument,
} from "@/lib/services/ocr";
import {
  azureOcrProvider,
  OcrProviderError,
  type DurableOcrProvider,
} from "@/lib/services/ocr-provider";
import { azureInvoice } from "./fixtures/azure-invoice";
import {
  assertMySqlTestDatabase,
  createTestCompany,
  addTestMemberships,
} from "./company-fixtures";

let staff: Actor, other: Actor, accounts: Actor, management: Actor;
let vendorId: string, jobId: string, companyId: string;
const tag = randomUUID().slice(0, 8);
const file = (name = "fictional.pdf") =>
  new File([`%PDF-1.7\nFictional OCR testing ${randomUUID()}\n%%EOF`], name, {
    type: "application/pdf",
  });
const input = (invoiceNumber: string) => ({
  vendorId,
  jobId,
  invoiceNumber,
  invoiceDate: "2026-10-27",
  currency: "AED",
  category: "MATERIALS",
  vatRate: "5",
  discount: "0",
  lines: [
    { description: "Fictional materials", quantity: "2", unitPrice: "100.00" },
  ],
  submit: false,
});
const provider = (invoiceNumber: string): DurableOcrProvider => ({
  start: vi.fn(async () => ({ requestId: randomUUID(), retryAfterSeconds: 0 })),
  poll: vi.fn(async () => ({
    status: "succeeded" as const,
    extraction: normalizeAzureInvoice(azureInvoice(invoiceNumber)),
  })),
});
async function queued(count = 1) {
  const batch = await createOcrBatch(
    staff,
    Array.from({ length: count }, () => file()),
  );
  await db.ocrDocument.updateMany({
    where: { batchId: batch.id },
    data: { status: "QUEUED", failureCode: null, lastError: null },
  });
  return batch;
}
async function extracted(invoiceNumber: string) {
  const batch = await queued();
  const mock = provider(invoiceNumber);
  await processOcrQueue(1, mock);
  await processOcrQueue(1, mock);
  return getOcrDocument(staff, batch.documents[0].id);
}
beforeAll(async () => {
  assertMySqlTestDatabase();
  vi.stubEnv("OCR_PROVIDER", "disabled");
  vi.stubEnv("UPLOAD_DIR", path.resolve(".local", `test-ocr-${tag}`));
  [staff, other, accounts, management] = await Promise.all(
    (["DATA_ENTRY", "DATA_ENTRY", "ACCOUNTS", "MANAGEMENT"] as const).map(
      (role, index) =>
        db.user.create({
          data: {
            email: `ocr-${tag}-${index}@example.invalid`,
            name: `Fictional OCR ${role}`,
            passwordHash: "unusable-test-hash",
            role,
          },
        }),
    ),
  );
  const company = await createTestCompany(`OCR workflows ${tag}`, [
    staff,
    other,
    accounts,
    management,
  ]);
  companyId = company.id;
  vendorId = (
    await db.vendor.create({
      data: {
        companyId: company.id,
        name: "Fictional OCR Supplier",
        currency: "AED",
        isDemo: true,
      },
    })
  ).id;
  jobId = (
    await db.job.create({
      data: {
        companyId: company.id,
        jobNumber: "OCR-TEST",
        name: "Fictional OCR project",
        customer: "Fictional customer",
        currency: "AED",
        contractValue: "1000",
        isDemo: true,
      },
    })
  ).id;
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await db.$disconnect();
});

describe("persisted OCR workflows on real MySQL with mocked provider", () => {
  it("stores originals privately, reports missing configuration, scopes access, and rejects duplicate files", async () => {
    const original = file("=FICTIONAL.pdf");
    const batch = await createOcrBatch(staff, [original]);
    expect(batch.counts.failed).toBe(1);
    expect(batch.documents[0]).toMatchObject({
      failureCode: "NOT_CONFIGURED",
      extraction: null,
    });
    expect((await listOcrBatches(other)).batches).toHaveLength(0);
    await expect(
      getOcrDocument(other, batch.documents[0].id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      downloadOcrDocument(other, batch.documents[0].id),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (
        await downloadOcrDocument(staff, batch.documents[0].id)
      ).bytes.toString(),
    ).toContain("Fictional OCR");
    await expect(createOcrBatch(staff, [original])).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      createOcrBatch(staff, [file(), original, original]),
    ).rejects.toMatchObject({ status: 409 });
    await expect(createOcrBatch(management, [file()])).rejects.toMatchObject({
      status: 403,
    });
    expect(await ocrErrorsCsv(staff, batch.id)).toContain('"\'=FICTIONAL.pdf"');
    await expect(
      retryOcrDocument(staff, batch.documents[0].id),
    ).rejects.toMatchObject({ status: 503 });
  });
  it("persists provider polling before human review, never creating a bill automatically", async () => {
    const count = await db.bill.count();
    const batch = await queued();
    const mock = provider(`OCR-PERSIST-${tag}`);
    await Promise.all([processOcrQueue(1, mock), processOcrQueue(1, mock)]);
    expect(mock.start).toHaveBeenCalledTimes(1);
    const processing = await db.ocrDocument.findUniqueOrThrow({
      where: { id: batch.documents[0].id },
    });
    if (processing.status !== "REVIEW_REQUIRED") await processOcrQueue(1, mock);
    const review = await getOcrDocument(staff, processing.id);
    expect(review).toMatchObject({
      status: "REVIEW_REQUIRED",
      suggestedInput: { vendorId, jobId, invoiceNumber: `OCR-PERSIST-${tag}` },
      verifiedInput: null,
    });
    expect(await db.bill.count()).toBe(count);
    await expect(retryOcrDocument(staff, processing.id)).rejects.toMatchObject({
      status: 409,
    });
  });
  it("versions controlled vendor templates and reuses the active version without dropping source fields", async () => {
    await expect(
      createOcrTemplate(staff, {
        vendorId,
        name: "Forbidden template",
        mappings: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
    const first = await createOcrTemplate(accounts, {
      vendorId,
      name: "Fictional mapping v1",
      mappings: { jobNumber: "CustomerId", category: "MATERIALS" },
    });
    const second = await createOcrTemplate(accounts, {
      vendorId,
      name: "Fictional mapping v2",
      mappings: { orderNumber: "CustomerId", category: "EQUIPMENT" },
    });
    expect(second.version).toBe(first.version + 1);
    const templates = await listOcrTemplates(accounts);
    expect(templates.find((template) => template.id === first.id)?.active).toBe(
      false,
    );
    const review = await extracted(`OCR-TEMPLATE-${tag}`);
    expect(review.templateId).toBe(second.id);
    expect(review.suggestedInput).toMatchObject({
      orderNumber: "OCR-TEST",
      category: "EQUIPMENT",
    });
    expect(review.extraction).toMatchObject({
      providerFields: { PurchaseOrder: "PO-FICTIONAL-001" },
    });
  });
  it("requires explicit human confirmation then creates one audited draft and attaches its original atomically", async () => {
    const review = await extracted(`OCR-REVIEW-${tag}`);
    const request = {
      version: review.version,
      confirmed: true,
      bill: input(`OCR-REVIEW-${tag}`),
    };
    await expect(
      reviewOcrDocument(staff, review.id, { ...request, confirmed: false }),
    ).rejects.toThrow();
    await expect(
      reviewOcrDocument(management, review.id, request),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      reviewOcrDocument(other, review.id, request),
    ).rejects.toMatchObject({ status: 404 });
    const saved = await reviewOcrDocument(staff, review.id, request);
    expect(saved).toMatchObject({ status: "DRAFT", total: "210.00" });
    expect((await reviewOcrDocument(staff, review.id, request)).id).toBe(
      saved.id,
    );
    const posted = await db.ocrDocument.findUniqueOrThrow({
      where: { id: review.id },
    });
    expect(posted).toMatchObject({
      status: "POSTED",
      billId: saved.id,
      reviewedById: staff.id,
      verifiedInput: expect.objectContaining({
        invoiceNumber: `OCR-REVIEW-${tag}`,
      }),
    });
    expect(posted.extraction).toEqual(review.extraction);
    const attachment = await db.document.findFirstOrThrow({
      where: { billId: saved.id },
    });
    expect(
      (await downloadDocument(staff, attachment.id)).bytes.toString(),
    ).toContain("Fictional OCR");
    expect(
      await db.auditLog.count({
        where: { entityId: saved.id, action: "OCR_REVIEWED_AND_DRAFT_CREATED" },
      }),
    ).toBe(1);
    const draft = await db.bill.findUniqueOrThrow({ where: { id: saved.id } });
    await actOnBill(staff, saved.id, {
      action: "submit",
      version: draft.version,
    });
    const submitted = await db.bill.findUniqueOrThrow({
      where: { id: saved.id },
    });
    expect(submitted).toMatchObject({
      status: "READY",
      approvedById: null,
      approvedAt: null,
    });
    expect(await db.payment.count({ where: { billId: saved.id } })).toBe(0);
  });
  it("finalizes a reviewed OCR invoice with its original and no separate approval", async () => {
    const review = await extracted(`OCR-DIRECT-SYNC-${tag}`);
    const request = {
      version: review.version,
      confirmed: true,
      bill: { ...input(`OCR-DIRECT-SYNC-${tag}`), submit: true },
    };
    const saved = await reviewOcrDocument(staff, review.id, request);
    expect(saved).toMatchObject({
      status: "READY",
      approvedById: null,
      approvedAt: null,
      paymentStatus: "UNPAID",
    });
    expect(saved.documents).toHaveLength(1);
    expect(saved.documents[0].fileName).toBe(review.fileName);
    expect((await reviewOcrDocument(staff, review.id, request)).id).toBe(
      saved.id,
    );
    expect(
      await db.auditLog.count({
        where: {
          entityId: saved.id,
          action: "BILL_FINALIZED",
          actorId: staff.id,
        },
      }),
    ).toBe(1);
    expect(
      await db.auditLog.count({
        where: { entityId: saved.id, action: "BILL_APPROVE" },
      }),
    ).toBe(0);
    expect(await db.integrationJob.count({ where: { billId: saved.id } })).toBe(
      0,
    );
    expect(
      saved.syncRecords.find((record) => record.target === "ZOHO"),
    ).toMatchObject({ status: "FAILED" });
  });
  it("blocks duplicate bill creation without consuming the unposted OCR review", async () => {
    const number = `OCR-DUPLICATE-${tag}`;
    await createBill(staff, input(number));
    const review = await extracted(number);
    expect(review.warnings).toContainEqual(
      expect.stringContaining("already exists"),
    );
    expect(
      (await countOcrDuplicateWarnings(staff)).count,
    ).toBeGreaterThanOrEqual(1);
    expect(await countOcrDuplicateWarnings(other)).toMatchObject({
      count: 0,
      documentsChecked: 0,
      truncated: false,
    });
    await expect(
      reviewOcrDocument(staff, review.id, {
        version: review.version,
        confirmed: true,
        bill: input(number),
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    expect(
      await db.ocrDocument.findUniqueOrThrow({ where: { id: review.id } }),
    ).toMatchObject({
      status: "REVIEW_REQUIRED",
      billId: null,
      version: review.version,
    });
  });
  it("bounds attempts and preserves originals after permanent provider failures", async () => {
    const batch = await queued();
    const id = batch.documents[0].id;
    const fail: DurableOcrProvider = {
      start: vi.fn(async () => {
        throw new OcrProviderError(
          "AUTHORIZATION_FAILED",
          "Fictional provider authorization failure.",
        );
      }),
      poll: vi.fn(),
    };
    await processOcrQueue(1, fail);
    expect(
      await db.ocrDocument.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({
      status: "FAILED",
      attempts: 1,
      failureCode: "AUTHORIZATION_FAILED",
    });
    expect((await downloadOcrDocument(staff, id)).bytes.length).toBeGreaterThan(
      8,
    );
    await db.ocrDocument.update({ where: { id }, data: { attempts: 5 } });
    await expect(retryOcrDocument(staff, id)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("prevents concurrent cross-owner duplicate intake and enforces the unfinished-document quota atomically", async () => {
    const original = file();
    const duplicates = await Promise.allSettled([
      createOcrBatch(staff, [original]),
      createOcrBatch(other, [original]),
    ]);
    expect(
      duplicates.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const owner = await db.user.create({
      data: {
        email: `ocr-quota-${tag}@example.invalid`,
        name: "Fictional quota owner",
        role: "DATA_ENTRY",
        passwordHash: "unusable-test-hash",
      },
    });
    await addTestMemberships(companyId, [owner]);
    const batch = await createOcrBatch(owner, [file()]);
    // Synthetic FAILED metadata exercises the quota without scheduling nonexistent fixture files.
    await db.ocrDocument.createMany({
      data: Array.from({ length: 48 }, () => ({
        batchId: batch.id,
        status: "FAILED" as const,
        storageKey: `${randomUUID()}.pdf`,
        fileName: "fictional-quota-placeholder.pdf",
        mimeType: "application/pdf",
        byteSize: 8,
        sha256: randomUUID(),
        failureCode: "TEST_FIXTURE",
      })),
    });
    const results = await Promise.allSettled([
      createOcrBatch(owner, [file()]),
      createOcrBatch(owner, [file()]),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      await db.ocrDocument.count({
        where: { batch: { createdById: owner.id }, status: { not: "POSTED" } },
      }),
    ).toBe(50);
  });

  it("holds uncertain submissions for acknowledged retry and recovers an expired lease without resubmission", async () => {
    const batch = await queued();
    const id = batch.documents[0].id;
    await db.ocrDocument.update({
      where: { id },
      data: {
        status: "PROCESSING",
        attempts: 1,
        leaseUntil: new Date(0),
        leaseToken: randomUUID(),
        providerRequestId: null,
      },
    });
    const mock = provider(`OCR-UNKNOWN-${tag}`);
    await processOcrQueue(1, mock);
    expect(mock.start).not.toHaveBeenCalled();
    expect(
      await db.ocrDocument.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({
      status: "FAILED",
      failureCode: "SUBMISSION_UNKNOWN",
      attempts: 1,
    });
    await expect(retryOcrDocument(staff, id)).rejects.toMatchObject({
      status: 409,
    });
    vi.stubEnv("OCR_PROVIDER", "azure_document_intelligence");
    vi.stubEnv(
      "AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT",
      "https://fictional-ocr.cognitiveservices.azure.com",
    );
    vi.stubEnv(
      "AZURE_DOCUMENT_INTELLIGENCE_KEY",
      "fictional-test-key-not-a-credential",
    );
    expect(
      await retryOcrDocument(staff, id, { acknowledgeUnknown: true }),
    ).toMatchObject({ status: "QUEUED", attempts: 1 });
    expect(
      await db.auditLog.findFirstOrThrow({
        where: { action: "OCR_RETRY_REQUESTED", entityId: id },
      }),
    ).toMatchObject({
      actorId: staff.id,
      details: {
        acknowledgedUnknown: true,
        previousFailure: "SUBMISSION_UNKNOWN",
        attemptCount: 1,
      },
    });
    await db.ocrDocument.update({ where: { id }, data: { status: "FAILED" } });
    vi.stubEnv("OCR_PROVIDER", "disabled");
  });

  it("shows source-duplicate warnings on both documents after the later batch extraction finishes", async () => {
    const batch = await queued(2);
    const mock = provider(`OCR-PEERS-${tag}`);
    await processOcrQueue(2, mock);
    await processOcrQueue(2, mock);
    for (const document of batch.documents) {
      const review = await getOcrDocument(staff, document.id);
      expect(review.status).toBe("REVIEW_REQUIRED");
      expect(review.warnings).toContainEqual(
        expect.stringContaining("Another file in this batch"),
      );
      expect(review.billId).toBeNull();
    }
  });

  it("keeps uncertain source totals immutable and requires explicit review before corrected draft creation", async () => {
    const batch = await queued();
    const id = batch.documents[0].id;
    const data = azureInvoice(`OCR-UNCERTAIN-${tag}`);
    data.documents[0].fields.InvoiceId.confidence = 0.3;
    data.documents[0].fields.InvoiceTotal.valueCurrency.amount = 211;
    const evidence = normalizeAzureInvoice(data);
    const mock: DurableOcrProvider = {
      start: async () => ({ requestId: randomUUID(), retryAfterSeconds: 0 }),
      poll: async () => ({ status: "succeeded", extraction: evidence }),
    };
    await processOcrQueue(1, mock);
    await processOcrQueue(1, mock);
    const review = await getOcrDocument(staff, id);
    expect(review.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Low confidence"),
        expect.stringContaining("total differs"),
      ]),
    );
    const payload = {
      version: review.version,
      confirmed: false,
      bill: input(`OCR-UNCERTAIN-CORRECTED-${tag}`),
    };
    await expect(reviewOcrDocument(staff, id, payload)).rejects.toThrow();
    expect(
      (await db.ocrDocument.findUniqueOrThrow({ where: { id } })).billId,
    ).toBeNull();
    const bill = await reviewOcrDocument(staff, id, {
      ...payload,
      confirmed: true,
    });
    expect(bill).toMatchObject({ status: "DRAFT", total: "210.00" });
    expect(
      await db.ocrDocument.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({
      extraction: { total: "211.00", confidence: { invoiceNumber: 0.3 } },
      verifiedInput: { invoiceNumber: `OCR-UNCERTAIN-CORRECTED-${tag}` },
    });
  });

  it("stops both submission and polling when their durable limits are exhausted", async () => {
    for (const limits of [
      {
        attempts: 5,
        pollCount: 0,
        providerRequestId: null,
        status: "QUEUED" as const,
      },
      {
        attempts: 1,
        pollCount: 60,
        providerRequestId: randomUUID(),
        status: "PROCESSING" as const,
      },
    ]) {
      const batch = await queued();
      const id = batch.documents[0].id;
      await db.ocrDocument.update({ where: { id }, data: limits });
      const mock = provider(`OCR-LIMIT-${tag}`);
      await processOcrQueue(1, mock);
      expect(mock.start).not.toHaveBeenCalled();
      expect(mock.poll).not.toHaveBeenCalled();
      expect(
        await db.ocrDocument.findUniqueOrThrow({ where: { id } }),
      ).toMatchObject({
        status: "FAILED",
        failureCode: "PROCESSING_LIMIT",
        attempts: limits.attempts,
        pollCount: limits.pollCount,
      });
      await expect(retryOcrDocument(staff, id)).rejects.toMatchObject({
        status: 409,
      });
    }
  });

  it("does not replace evidence or append a completion audit after a worker loses its lease", async () => {
    const batch = await queued();
    const id = batch.documents[0].id;
    await db.ocrDocument.update({
      where: { id },
      data: {
        status: "PROCESSING",
        attempts: 1,
        providerRequestId: randomUUID(),
      },
    });
    const mock: DurableOcrProvider = {
      start: vi.fn(),
      poll: async () => {
        await db.ocrDocument.update({
          where: { id },
          data: {
            leaseToken: randomUUID(),
            leaseUntil: new Date(Date.now() + 60000),
            version: { increment: 1 },
          },
        });
        return {
          status: "succeeded",
          extraction: normalizeAzureInvoice(azureInvoice(`OCR-STALE-${tag}`)),
        };
      },
    };
    await processOcrQueue(1, mock);
    expect(
      await db.ocrDocument.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({ status: "PROCESSING", extraction: null });
    expect(
      await db.auditLog.count({
        where: {
          entityType: "OcrDocument",
          entityId: id,
          action: "OCR_EXTRACTION_COMPLETED",
        },
      }),
    ).toBe(0);
    await db.ocrDocument.update({
      where: { id },
      data: { status: "FAILED", leaseToken: null, leaseUntil: null },
    });
  });

  it("creates one unpaid manual draft from a failed OCR original without claiming an extraction succeeded", async () => {
    vi.stubEnv("OCR_PROVIDER", "disabled");
    const original = file("fictional-manual-fallback.pdf");
    const batch = await createOcrBatch(staff, [original]);
    const document = batch.documents[0];
    expect(document).toMatchObject({
      status: "FAILED",
      failureCode: "NOT_CONFIGURED",
    });
    const request = {
      version: document.version,
      confirmed: true,
      mode: "manual",
      bill: input(`OCR-MANUAL-${tag}`),
    };
    const bill = await reviewOcrDocument(staff, document.id, request);
    expect(bill).toMatchObject({
      status: "DRAFT",
      paymentStatus: "UNPAID",
      paidAmount: "0.00",
      total: "210.00",
      approvedById: null,
    });
    expect((await reviewOcrDocument(staff, document.id, request)).id).toBe(
      bill.id,
    );
    const posted = await db.ocrDocument.findUniqueOrThrow({
      where: { id: document.id },
    });
    const attachment = await db.document.findFirstOrThrow({
      where: { billId: bill.id },
    });
    expect(posted).toMatchObject({
      status: "POSTED",
      billId: bill.id,
      extraction: null,
      verifiedInput: { invoiceNumber: `OCR-MANUAL-${tag}` },
    });
    expect(attachment.storageKey).toBe(posted.storageKey);
    expect((await downloadDocument(staff, attachment.id)).bytes).toEqual(
      Buffer.from(await original.arrayBuffer()),
    );
    expect(await db.document.count({ where: { billId: bill.id } })).toBe(1);
    expect(await db.payment.count({ where: { billId: bill.id } })).toBe(0);
    expect(
      await db.auditLog.findFirstOrThrow({
        where: { entityId: bill.id, action: "OCR_MANUAL_DRAFT_CREATED" },
      }),
    ).toMatchObject({
      actorId: staff.id,
      companyId,
      details: {
        entryMode: "MANUAL_AFTER_OCR_FAILURE",
        previousFailureCode: "NOT_CONFIGURED",
        extractionVerified: false,
      },
    });
    expect(
      await db.auditLog.count({
        where: { entityId: bill.id, action: "OCR_REVIEWED_AND_DRAFT_CREATED" },
      }),
    ).toBe(0);
    await expect(retryOcrDocument(staff, document.id)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("finalizes manually reviewed failed OCR with its original without an approver", async () => {
    const batch = await createOcrBatch(staff, [
      file("direct-manual-fallback.pdf"),
    ]);
    const document = batch.documents[0];
    const saved = await reviewOcrDocument(staff, document.id, {
      version: document.version,
      confirmed: true,
      mode: "manual",
      bill: { ...input(`OCR-MANUAL-DIRECT-${tag}`), submit: true },
    });
    expect(saved).toMatchObject({
      status: "READY",
      paidAmount: "0.00",
      approvedById: null,
      approvedAt: null,
    });
    expect(saved.documents).toHaveLength(1);
    expect(await db.payment.count({ where: { billId: saved.id } })).toBe(0);
    expect(
      await db.ocrDocument.findUniqueOrThrow({ where: { id: document.id } }),
    ).toMatchObject({
      status: "POSTED",
      extraction: null,
      billId: saved.id,
      reviewedById: staff.id,
    });
  });
  it("retains manual fallback permission, confirmation, state, company and version guards", async () => {
    const batch = await createOcrBatch(staff, [file()]);
    const document = batch.documents[0];
    const request = {
      version: document.version,
      confirmed: true,
      mode: "manual",
      bill: input(`OCR-MANUAL-GUARDS-${tag}`),
    };
    await expect(
      reviewOcrDocument(other, document.id, request),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      reviewOcrDocument(management, document.id, request),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      reviewOcrDocument(staff, document.id, { ...request, confirmed: false }),
    ).rejects.toThrow();
    await expect(
      reviewOcrDocument(staff, document.id, { ...request, mode: undefined }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      reviewOcrDocument(staff, document.id, {
        ...request,
        version: document.version + 1,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      reviewOcrDocument(staff, document.id, {
        ...request,
        bill: { ...request.bill, companyId: "not-this-company" },
      }),
    ).rejects.toMatchObject({ status: 422 });
    for (const status of ["QUEUED", "PROCESSING"] as const) {
      await db.ocrDocument.update({
        where: { id: document.id },
        data: { status },
      });
      await expect(
        reviewOcrDocument(staff, document.id, request),
      ).rejects.toMatchObject({ status: 409 });
    }
    await db.ocrDocument.update({
      where: { id: document.id },
      data: { status: "FAILED" },
    });
    await createBill(staff, request.bill);
    await expect(
      reviewOcrDocument(staff, document.id, request),
    ).rejects.toMatchObject({ code: "P2002" });
    expect(
      await db.ocrDocument.findUniqueOrThrow({ where: { id: document.id } }),
    ).toMatchObject({
      status: "FAILED",
      version: document.version,
      billId: null,
      extraction: null,
      verifiedInput: null,
    });
    expect(
      await db.document.count({
        where: {
          storageKey: (
            await db.ocrDocument.findUniqueOrThrow({
              where: { id: document.id },
            })
          ).storageKey,
        },
      }),
    ).toBe(0);
  });

  it.each(["NOT_CONFIGURED", "INVALID_CONFIGURATION"])(
    "resumes the accepted Azure operation after %s without another submission",
    async (failureCode) => {
      const batch = await queued();
      const id = batch.documents[0].id;
      const mock = provider(`OCR-RESUME-${failureCode}-${tag}`);
      await processOcrQueue(1, mock);
      const started = await db.ocrDocument.findUniqueOrThrow({ where: { id } });
      expect(started.providerRequestId).toBeTruthy();
      vi.stubEnv(
        "OCR_PROVIDER",
        failureCode === "NOT_CONFIGURED"
          ? "disabled"
          : "azure_document_intelligence",
      );
      vi.stubEnv(
        "AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT",
        "http://invalid.example",
      );
      vi.stubEnv(
        "AZURE_DOCUMENT_INTELLIGENCE_KEY",
        "fictional-test-key-not-a-credential",
      );
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(
          new Error("No provider network request is permitted."),
        );
      try {
        await processOcrQueue(1, {
          start: mock.start,
          poll: azureOcrProvider.poll,
        });
        expect(fetch).not.toHaveBeenCalled();
        expect(
          await db.ocrDocument.findUniqueOrThrow({ where: { id } }),
        ).toMatchObject({
          status: "FAILED",
          failureCode,
          providerRequestId: started.providerRequestId,
          attempts: 1,
        });
        vi.stubEnv("OCR_PROVIDER", "azure_document_intelligence");
        vi.stubEnv(
          "AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT",
          "https://fictional-ocr.cognitiveservices.azure.com",
        );
        expect(await retryOcrDocument(staff, id)).toMatchObject({
          status: "PROCESSING",
          providerRequestId: started.providerRequestId,
          attempts: 1,
        });
        await processOcrQueue(1, mock);
        expect(mock.start).toHaveBeenCalledTimes(1);
        expect(mock.poll).toHaveBeenCalledWith(started.providerRequestId);
        expect((await getOcrDocument(staff, id)).status).toBe(
          "REVIEW_REQUIRED",
        );
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        fetch.mockRestore();
        vi.stubEnv("OCR_PROVIDER", "disabled");
      }
    },
  );

  it("does not resubmit a terminal failed extraction and still permits manual entry", async () => {
    const batch = await queued();
    const id = batch.documents[0].id;
    const mock = provider(`OCR-TERMINAL-${tag}`);
    await processOcrQueue(1, mock);
    const operation = await db.ocrDocument.findUniqueOrThrow({ where: { id } });
    await processOcrQueue(1, {
      start: mock.start,
      poll: async () => {
        throw new OcrProviderError(
          "EXTRACTION_FAILED",
          "The fictional original could not be analyzed.",
        );
      },
    });
    await expect(retryOcrDocument(staff, id)).rejects.toMatchObject({
      status: 409,
    });
    expect(
      (await db.ocrDocument.findUniqueOrThrow({ where: { id } }))
        .providerRequestId,
    ).toBe(operation.providerRequestId);
    const failed = await getOcrDocument(staff, id);
    const bill = await reviewOcrDocument(staff, id, {
      version: failed.version,
      confirmed: true,
      mode: "manual",
      bill: input(`OCR-TERMINAL-MANUAL-${tag}`),
    });
    expect(bill).toMatchObject({ status: "DRAFT", paymentStatus: "UNPAID" });
    expect(mock.start).toHaveBeenCalledTimes(1);
  });

  it("does not let a stale worker replace a manually corrected draft or attach extraction evidence", async () => {
    const batch = await queued();
    const id = batch.documents[0].id;
    await db.ocrDocument.update({
      where: { id },
      data: {
        status: "PROCESSING",
        attempts: 1,
        providerRequestId: randomUUID(),
      },
    });
    let manualBillId: string | undefined;
    const mock: DurableOcrProvider = {
      start: vi.fn(),
      poll: async () => {
        // A newer worker has reclaimed/failed this expired operation. Its human
        // owner then saves corrections while this old request is still in flight.
        await db.ocrDocument.update({
          where: { id },
          data: {
            status: "FAILED",
            failureCode: "NETWORK_ERROR",
            leaseToken: null,
            leaseUntil: null,
            version: { increment: 1 },
          },
        });
        const failed = await getOcrDocument(staff, id);
        const bill = await reviewOcrDocument(staff, id, {
          version: failed.version,
          confirmed: true,
          mode: "manual",
          bill: {
            ...input(`OCR-KEPT-CORRECTION-${tag}`),
            notes: "Human correction must remain unchanged",
          },
        });
        manualBillId = bill.id;
        return {
          status: "succeeded",
          extraction: normalizeAzureInvoice(
            azureInvoice(`OCR-LATE-RESULT-${tag}`),
          ),
        };
      },
    };
    await processOcrQueue(1, mock);
    expect(manualBillId).toBeTruthy();
    expect(
      await db.ocrDocument.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({
      status: "POSTED",
      billId: manualBillId,
      extraction: null,
      verifiedInput: {
        invoiceNumber: `OCR-KEPT-CORRECTION-${tag}`,
        notes: "Human correction must remain unchanged",
      },
    });
    expect(
      await db.bill.findUniqueOrThrow({ where: { id: manualBillId } }),
    ).toMatchObject({
      invoiceNumber: `OCR-KEPT-CORRECTION-${tag}`,
      status: "DRAFT",
      notes: "Human correction must remain unchanged",
    });
    expect(
      await db.auditLog.count({
        where: { entityId: id, action: "OCR_EXTRACTION_COMPLETED" },
      }),
    ).toBe(0);
    expect(mock.start).not.toHaveBeenCalled();
  });

  it.each(["QUEUED", "PROCESSING"] as const)(
    "rechecks the upload owner's current OCR permission before %s provider work",
    async (status) => {
      const batch = await queued();
      const id = batch.documents[0].id;
      const operationId = status === "PROCESSING" ? randomUUID() : null;
      await db.ocrDocument.update({
        where: { id },
        data: {
          status,
          providerRequestId: operationId,
          attempts: operationId ? 1 : 0,
        },
      });
      await db.user.update({
        where: { id: staff.id },
        data: { role: "MANAGEMENT" },
      });
      const mock = provider(`OCR-ROLE-REVOKED-${tag}`);
      try {
        await processOcrQueue(1, mock);
        expect(mock.start).not.toHaveBeenCalled();
        expect(mock.poll).not.toHaveBeenCalled();
        expect(
          await db.ocrDocument.findUniqueOrThrow({ where: { id } }),
        ).toMatchObject({
          status: "FAILED",
          failureCode: "OCR_PERMISSION_REVOKED",
          providerRequestId: operationId,
          attempts: operationId ? 1 : 0,
          pollCount: 0,
          extraction: null,
          billId: null,
        });
      } finally {
        await db.user.update({
          where: { id: staff.id },
          data: { role: "DATA_ENTRY" },
        });
      }
    },
  );

  it("rejects invalid OCR file signatures, declared MIME types and oversized files without retaining metadata", async () => {
    const before = await db.ocrDocument.count();
    await expect(
      createOcrBatch(staff, [
        new File(["not an invoice document"], "bad.pdf", {
          type: "application/pdf",
        }),
      ]),
    ).rejects.toMatchObject({ status: 415 });
    await expect(
      createOcrBatch(staff, [
        new File(["%PDF-1.7\nfictional\n%%EOF"], "wrong.png", {
          type: "image/png",
        }),
      ]),
    ).rejects.toMatchObject({ status: 415 });
    await expect(
      createOcrBatch(staff, [
        new File([new Uint8Array(10 * 1024 * 1024 + 1)], "oversized.pdf", {
          type: "application/pdf",
        }),
      ]),
    ).rejects.toMatchObject({ status: 413 });
    expect(await db.ocrDocument.count()).toBe(before);
  });
});
