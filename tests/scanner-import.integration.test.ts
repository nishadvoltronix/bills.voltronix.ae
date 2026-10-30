import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { POST } from "@/app/api/scanner/imports/route";
import {
  authenticateScannerRequest,
  importScannerFile,
  readScannerUpload,
} from "@/lib/services/scanner-import";
import {
  createOcrBatch,
  downloadOcrDocument,
  getOcrDocument,
  listOcrBatches,
  processOcrQueue,
  retryOcrDocument,
  reviewOcrDocument,
} from "@/lib/services/ocr";
import {
  OcrProviderError,
  type DurableOcrProvider,
} from "@/lib/services/ocr-provider";
import { normalizeAzureInvoice } from "@/lib/ocr-extraction";
import { createBill } from "@/lib/services/bills";
import { attachDocument } from "@/lib/services/documents";
import { assertMySqlTestDatabase, createTestCompany } from "./company-fixtures";
import { azureInvoice } from "./fixtures/azure-invoice";

const tag = randomUUID().slice(0, 8);
const hash = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");
const pdf = () =>
  Buffer.from(`%PDF-1.7\nDEMO SCANNER TEST ${randomUUID()}\n%%EOF\n`);
let sourceA: string,
  sourceA2: string,
  sourceB: string,
  companyA: string,
  companyB: string,
  vendorId: string,
  jobId: string;
let owner: Actor,
  otherOwner: Actor,
  ownerB: Actor,
  human: Actor,
  reviewer: Actor;
const tokenA = randomBytes(32).toString("hex"),
  tokenA2 = randomBytes(32).toString("hex"),
  tokenB = randomBytes(32).toString("hex");
const endpoint = "http://127.0.0.1:3000/api/scanner/imports";
function request(
  bytes = pdf(),
  sourceId = sourceA,
  token = tokenA,
  extra: Record<string, string> = {},
) {
  return new Request(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/pdf",
      Host: new URL(endpoint).host,
      Authorization: `Bearer ${token}`,
      "X-Scanner-Source": sourceId,
      "X-Scanner-Sha256": hash(bytes),
      "X-Scanner-File-Name": "DEMO-scanner.pdf",
      ...extra,
    },
    body: new Uint8Array(bytes),
  });
}
const input = (invoiceNumber: string) => ({
  companyId: companyA,
  vendorId,
  jobId,
  invoiceNumber,
  invoiceDate: "2026-10-28",
  currency: "AED",
  category: "MATERIALS",
  vatRate: "5",
  discount: "0",
  submit: false,
  lines: [
    {
      description: "Fictional scanner materials",
      quantity: "2",
      unitPrice: "100.00",
    },
  ],
});
function configureAzure() {
  vi.stubEnv("OCR_PROVIDER", "azure_document_intelligence");
  vi.stubEnv(
    "AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT",
    "https://fictional-ocr.cognitiveservices.azure.com/",
  );
  vi.stubEnv("AZURE_DOCUMENT_INTELLIGENCE_KEY", "fictional-scanner-test-key");
}
beforeAll(async () => {
  assertMySqlTestDatabase();
  vi.stubEnv("SCANNER_IMPORT_ENABLED", "true");
  vi.stubEnv("OCR_PROVIDER", "disabled");
  vi.stubEnv("APP_URL", "http://127.0.0.1:3000");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error(
        "Live networking is forbidden in scanner database tests.",
      );
    }),
  );
  [owner, otherOwner, ownerB, human, reviewer] = await Promise.all(
    (
      [
        "DATA_ENTRY",
        "DATA_ENTRY",
        "DATA_ENTRY",
        "DATA_ENTRY",
        "ACCOUNTS",
      ] as const
    ).map((role, index) =>
      db.user.create({
        data: {
          name: `DEMO scanner actor ${index}`,
          email: `scanner-${tag}-${index}@example.invalid`,
          passwordHash: "unusable-scanner-test-login",
          role,
        },
      }),
    ),
  );
  companyA = (
    await createTestCompany(`scanner A ${tag}`, [
      owner,
      otherOwner,
      human,
      reviewer,
    ])
  ).id;
  companyB = (await createTestCompany(`scanner B ${tag}`, [ownerB])).id;
  const sources = await Promise.all(
    [
      [owner, companyA, tokenA],
      [otherOwner, companyA, tokenA2],
      [ownerB, companyB, tokenB],
    ].map(async ([actor, companyId, token], index) =>
      db.scannerSource.create({
        data: {
          companyId: companyId as string,
          uploadedById: (actor as Actor).id,
          name: `DEMO scanner source ${index}`,
          tokenHash: hash(token as string),
          active: true,
        },
      }),
    ),
  );
  [sourceA, sourceA2, sourceB] = sources.map((source) => source.id);
  vendorId = (
    await db.vendor.create({
      data: {
        companyId: companyA,
        name: "Fictional OCR Supplier",
        currency: "AED",
        isDemo: true,
      },
    })
  ).id;
  jobId = (
    await db.job.create({
      data: {
        companyId: companyA,
        jobNumber: `SCANNER-${tag}`,
        name: "DEMO scanner job",
        customer: "DEMO",
        currency: "AED",
        isDemo: true,
      },
    })
  ).id;
});
afterAll(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await db.$disconnect();
});

describe("scanner intake on real MySQL with no live provider calls", () => {
  it("persists one private original, safe label and visible OCR setup failure without a financial write", async () => {
    const before = await Promise.all([
      db.bill.count(),
      db.payment.count(),
      db.integrationJob.count(),
    ]);
    const bytes = pdf();
    const response = await POST(request(bytes));
    const result = await response.json();
    expect(response.status).toBe(201);
    expect(result).toMatchObject({
      status: "IMPORTED",
      duplicate: false,
      ocrStatus: "FAILED",
    });
    const record = await db.scannerImport.findUniqueOrThrow({
      where: { id: result.importId },
    });
    expect(record).toMatchObject({
      sha256: hash(bytes),
      byteSize: bytes.length,
      ocrDocumentId: result.ocrDocumentId,
    });
    const document = await getOcrDocument(reviewer, result.ocrDocumentId);
    expect(document.failureCode).toBe("NOT_CONFIGURED");
    expect(document.scannerSourceName).toBe("DEMO scanner source 0");
    expect(document).not.toHaveProperty("scannerImports");
    expect(document).not.toHaveProperty("storageKey");
    expect(
      (await downloadOcrDocument(owner, result.ocrDocumentId)).bytes.equals(
        bytes,
      ),
    ).toBe(true);
    expect(
      await Promise.all([
        db.bill.count(),
        db.payment.count(),
        db.integrationJob.count(),
      ]),
    ).toEqual(before);
  });

  it("accepts NextRequest loopback normalization only with the configured local authority", async () => {
    const bytes = pdf();
    const next = new NextRequest(request(bytes));
    expect(new URL(next.url).hostname).toBe("localhost");
    expect((await POST(next)).status).toBe(201);

    await db.scannerSource.update({
      where: { id: sourceA },
      data: { active: false },
    });
    try {
      expect((await POST(new NextRequest(request(bytes)))).status).toBe(401);
    } finally {
      await db.scannerSource.update({
        where: { id: sourceA },
        data: { active: true },
      });
    }

    const at = (url: string, host: string) => {
      const original = request(bytes, sourceA, tokenA, { Host: host });
      return new NextRequest(url, {
        method: "POST",
        headers: original.headers,
        body: new Uint8Array(bytes),
      });
    };
    expect(
      (
        await POST(
          at("http://127.0.0.1:3001/api/scanner/imports", "127.0.0.1:3000"),
        )
      ).status,
    ).toBe(403);
    expect((await POST(at(endpoint, "foreign.example:3000"))).status).toBe(403);
    expect((await POST(at(endpoint, "127.0.0.1:3001"))).status).toBe(403);
    expect(
      (
        await POST(
          at(
            "http://remote.example:3000/api/scanner/imports",
            "127.0.0.1:3000",
          ),
        )
      ).status,
    ).toBe(403);
    vi.stubEnv("APP_URL", "http://remote.example:3000");
    try {
      expect(
        (
          await POST(
            at(
              "http://remote.example:3000/api/scanner/imports",
              "remote.example:3000",
            ),
          )
        ).status,
      ).toBe(403);
    } finally {
      vi.stubEnv("APP_URL", "http://127.0.0.1:3000");
    }

    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("APP_URL", "https://billing.example");
    try {
      // Native HTTPS requests must retain the configured public origin and Host.
      expect(
        (
          await authenticateScannerRequest(
            at(
              "https://billing.example/api/scanner/imports",
              "billing.example",
            ),
          )
        ).sourceId,
      ).toBe(sourceA);
      expect(
        (
          await POST(
            at("http://billing.example/api/scanner/imports", "billing.example"),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await POST(
            at(
              "https://billing.example/api/scanner/imports",
              "foreign.example",
            ),
          )
        ).status,
      ).toBe(403);
      vi.stubEnv("APP_URL", "https://127.0.0.1:3000");
      expect(
        (
          await POST(
            at("https://127.0.0.1:3000/api/scanner/imports", "127.0.0.1:3000"),
          )
        ).status,
      ).toBe(403);
    } finally {
      vi.stubEnv("APP_ENV", "test");
      vi.stubEnv("APP_URL", "http://127.0.0.1:3000");
    }
  });

  it("recovers a lost HTTP acknowledgement and renamed copy using the same durable hash receipt", async () => {
    const bytes = pdf();
    const first = await (await POST(request(bytes))).json();
    const repeated = await POST(
      request(bytes, sourceA, tokenA, {
        "X-Scanner-File-Name": "DEMO-renamed.pdf",
      }),
    );
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({
      importId: first.importId,
      ocrDocumentId: first.ocrDocumentId,
      duplicate: true,
    });
    expect(await db.ocrDocument.count({ where: { sha256: hash(bytes) } })).toBe(
      1,
    );
    expect(
      await db.scannerImport.count({
        where: { sourceId: sourceA, sha256: hash(bytes) },
      }),
    ).toBe(1);
  });

  it("serializes concurrent duplicate uploads from one source", async () => {
    const bytes = pdf();
    const responses = await Promise.all([
      POST(request(bytes)),
      POST(request(bytes)),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 201,
    ]);
    const [a, b] = await Promise.all(
      responses.map((response) => response.json()),
    );
    expect(a.importId).toBe(b.importId);
    expect(a.ocrDocumentId).toBe(b.ocrDocumentId);
    expect(await db.ocrDocument.count({ where: { sha256: hash(bytes) } })).toBe(
      1,
    );
  });

  it("deduplicates concurrent different-source owners in one company without exposing another owner's record", async () => {
    const bytes = pdf();
    const responses = await Promise.all([
      POST(request(bytes)),
      POST(request(bytes, sourceA2, tokenA2)),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 201,
    ]);
    const rows = await Promise.all(
      responses.map((response) => response.json()),
    );
    expect(rows.find((row) => row.status === "DUPLICATE")).toMatchObject({
      duplicate: true,
      ocrDocumentId: null,
      reviewUrl: null,
    });
    expect(await db.ocrDocument.count({ where: { sha256: hash(bytes) } })).toBe(
      1,
    );
    expect(
      await db.scannerImport.count({ where: { sha256: hash(bytes) } }),
    ).toBe(2);
  });

  it("shares company hash locking with concurrent manual upload and existing bill attachments", async () => {
    const bytes = pdf();
    const results = await Promise.allSettled([
      POST(request(bytes)),
      createOcrBatch(
        human,
        [
          new File([new Uint8Array(bytes)], "DEMO-manual.pdf", {
            type: "application/pdf",
          }),
        ],
        companyA,
      ),
    ]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    expect(await db.ocrDocument.count({ where: { sha256: hash(bytes) } })).toBe(
      1,
    );
    const attachedBytes = pdf();
    const bill = await createBill(human, input(`DEMO-SCANNER-ATTACHED-${tag}`));
    await attachDocument(
      human,
      bill.id,
      new File([new Uint8Array(attachedBytes)], "DEMO-attached.pdf", {
        type: "application/pdf",
      }),
    );
    const response = await POST(request(attachedBytes));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "DUPLICATE",
      duplicate: true,
      ocrDocumentId: null,
    });
    expect(
      await db.ocrDocument.count({ where: { sha256: hash(attachedBytes) } }),
    ).toBe(0);
  });

  it("keeps companies separate while rejecting source/token substitution and private access", async () => {
    const bytes = pdf();
    expect((await POST(request(bytes, sourceB, tokenA))).status).toBe(401);
    const a = await (await POST(request(bytes))).json();
    const b = await (await POST(request(bytes, sourceB, tokenB))).json();
    expect(a.ocrDocumentId).not.toBe(b.ocrDocumentId);
    await expect(
      getOcrDocument(reviewer, b.ocrDocumentId),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      downloadOcrDocument(ownerB, a.ocrDocumentId),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      getOcrDocument(otherOwner, a.ocrDocumentId),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("enforces source revocation, current membership, current role, transport and machine-only auth", async () => {
    const bytes = pdf();
    expect(
      (
        await POST(
          request(bytes, sourceA, tokenA, { Cookie: "voltronix_session=fake" }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await POST(
          request(bytes, sourceA, tokenA, { Origin: "http://127.0.0.1:3000" }),
        )
      ).status,
    ).toBe(403);
    vi.stubEnv("SCANNER_IMPORT_ENABLED", "false");
    expect((await POST(request(bytes))).status).toBe(503);
    vi.stubEnv("SCANNER_IMPORT_ENABLED", "true");
    vi.stubEnv("APP_ENV", "production");
    expect((await POST(request(bytes))).status).toBe(403);
    vi.stubEnv("APP_ENV", "test");
    await db.scannerSource.update({
      where: { id: sourceA },
      data: { active: false },
    });
    try {
      expect((await POST(request(bytes))).status).toBe(401);
    } finally {
      await db.scannerSource.update({
        where: { id: sourceA },
        data: { active: true },
      });
    }
    await db.userCompanyMembership.update({
      where: { userId_companyId: { userId: owner.id, companyId: companyA } },
      data: { active: false },
    });
    try {
      expect((await POST(request(bytes))).status).toBe(401);
    } finally {
      await db.userCompanyMembership.update({
        where: { userId_companyId: { userId: owner.id, companyId: companyA } },
        data: { active: true },
      });
    }
    await db.user.update({
      where: { id: owner.id },
      data: { role: "MANAGEMENT" },
    });
    try {
      expect((await POST(request(bytes))).status).toBe(401);
    } finally {
      await db.user.update({
        where: { id: owner.id },
        data: { role: "DATA_ENTRY" },
      });
    }
    const identity = await authenticateScannerRequest(request(bytes));
    await db.scannerSource.update({
      where: { id: sourceA },
      data: { tokenHash: hash(randomBytes(32)) },
    });
    try {
      await expect(
        importScannerFile(identity, await readScannerUpload(request(bytes))),
      ).rejects.toMatchObject({ status: 401 });
    } finally {
      await db.scannerSource.update({
        where: { id: sourceA },
        data: { tokenHash: hash(tokenA) },
      });
    }
    expect(
      await db.scannerImport.count({
        where: { sourceId: sourceA, sha256: hash(bytes) },
      }),
    ).toBe(0);
  });

  it("rejects incomplete/invalid PDFs, hash mismatches and unsafe filenames with no OCR rows", async () => {
    const bytes = Buffer.from("%PDF-1.7\nDEMO unfinished scanner copy");
    const response = await POST(request(bytes));
    expect(response.status).toBe(415);
    expect(
      await db.scannerImport.findUnique({
        where: { sourceId_sha256: { sourceId: sourceA, sha256: hash(bytes) } },
      }),
    ).toMatchObject({
      status: "REJECTED",
      failureCode: "INVALID_PDF",
      ocrDocumentId: null,
    });
    expect((await POST(request(bytes))).status).toBe(415);
    const complete = pdf();
    expect(
      (
        await POST(
          request(complete, sourceA, tokenA, {
            "X-Scanner-Sha256": "0".repeat(64),
          }),
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await POST(
          request(complete, sourceA, tokenA, {
            "X-Scanner-File-Name": encodeURIComponent("../private.pdf"),
          }),
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await POST(
          request(complete, sourceA, tokenA, { "Content-Type": "image/png" }),
        )
      ).status,
    ).toBe(415);
    expect(
      await db.ocrDocument.count({
        where: { sha256: { in: [hash(bytes), hash(complete)] } },
      }),
    ).toBe(0);
  });

  it("preserves committed original when the database commit acknowledgement is lost", async () => {
    const bytes = pdf();
    const identity = await authenticateScannerRequest(request(bytes));
    const upload = await readScannerUpload(request(bytes));
    const transaction = db.$transaction.bind(db);
    let interrupted = false;
    const spy = vi.spyOn(db, "$transaction").mockImplementation((async (
      ...args: unknown[]
    ) => {
      const result = await (
        transaction as (...values: unknown[]) => Promise<unknown>
      )(...args);
      if (!interrupted) {
        interrupted = true;
        throw new Error(
          "Simulated lost commit acknowledgement after real commit",
        );
      }
      return result;
    }) as typeof db.$transaction);
    try {
      await expect(importScannerFile(identity, upload)).rejects.toThrow(
        "lost commit acknowledgement",
      );
    } finally {
      spy.mockRestore();
    }
    const row = await db.scannerImport.findUniqueOrThrow({
      where: { sourceId_sha256: { sourceId: sourceA, sha256: hash(bytes) } },
    });
    expect(
      (await downloadOcrDocument(owner, row.ocrDocumentId!)).bytes.equals(
        bytes,
      ),
    ).toBe(true);
    const recovered = await POST(request(bytes));
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({
      importId: row.id,
      duplicate: true,
      ocrDocumentId: row.ocrDocumentId,
    });
  });

  it("recovers missing Azure and provider failure on the same OCR original, then requires human draft review", async () => {
    const bytes = pdf();
    const response = await POST(request(bytes));
    const imported = await response.json();
    configureAzure();
    await retryOcrDocument(owner, imported.ocrDocumentId);
    const operation = randomUUID();
    const invoiceNumber = `DEMO-SCANNER-OCR-${tag}`;
    const adapter: DurableOcrProvider = {
      start: vi.fn(async () => ({
        requestId: operation,
        retryAfterSeconds: 0,
      })),
      poll: vi.fn(async () => {
        throw new OcrProviderError(
          "AUTHORIZATION_FAILED",
          "Fictional provider failure",
        );
      }),
    };
    await processOcrQueue(1, adapter);
    await processOcrQueue(1, adapter);
    expect(
      await db.ocrDocument.findUnique({
        where: { id: imported.ocrDocumentId },
      }),
    ).toMatchObject({ status: "FAILED", providerRequestId: operation });
    await retryOcrDocument(owner, imported.ocrDocumentId);
    adapter.poll = vi.fn(async () => ({
      status: "succeeded" as const,
      extraction: normalizeAzureInvoice(azureInvoice(invoiceNumber)),
    }));
    await processOcrQueue(1, adapter);
    expect(adapter.start).toHaveBeenCalledTimes(1);
    const document = await getOcrDocument(reviewer, imported.ocrDocumentId);
    expect(document.status).toBe("REVIEW_REQUIRED");
    expect(document.billId).toBeNull();
    const draft = await reviewOcrDocument(reviewer, document.id, {
      version: document.version,
      confirmed: true,
      bill: input(invoiceNumber),
    });
    expect(draft).toMatchObject({
      status: "DRAFT",
      paidAmount: "0.00",
      total: "210.00",
    });
    expect(await db.payment.count({ where: { billId: draft.id } })).toBe(0);
    expect(await db.integrationJob.count({ where: { billId: draft.id } })).toBe(
      0,
    );
    expect(
      (await downloadOcrDocument(reviewer, document.id)).bytes.equals(bytes),
    ).toBe(true);
    vi.stubEnv("OCR_PROVIDER", "disabled");
  });

  it("keeps older review batches reachable with scoped cursor pagination and safe scanner labels", async () => {
    const pageUser = await db.user.create({
      data: {
        name: "DEMO scanner pagination",
        email: `scanner-page-${tag}@example.invalid`,
        role: "DATA_ENTRY",
        passwordHash: "unusable",
      },
    });
    const pageCompany = await createTestCompany(`scanner page ${tag}`, [
      pageUser,
    ]);
    for (let index = 0; index < 32; index++)
      await db.ocrBatch.create({
        data: { companyId: pageCompany.id, createdById: pageUser.id },
      });
    const first = await listOcrBatches(pageUser);
    expect(first.batches).toHaveLength(30);
    expect(first.nextCursor).toBeTruthy();
    const second = await listOcrBatches(pageUser, first.nextCursor!);
    expect(second.batches).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.batches, ...second.batches].map((batch) => batch.id))
        .size,
    ).toBe(32);
    await expect(
      listOcrBatches(ownerB, first.nextCursor!),
    ).rejects.toMatchObject({ status: 404 });
  });
});
