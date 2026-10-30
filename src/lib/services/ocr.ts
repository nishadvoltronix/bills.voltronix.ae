import "server-only";
import { randomUUID } from "node:crypto";
import { Prisma, type OcrDocument } from "@prisma/client";
import { z } from "zod";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  companyFilter,
  companyIdsForActor,
  requireCompanyAccess,
  resolveCompanyForCreate,
} from "@/lib/company";
import { normalizeInvoiceNumber } from "@/lib/finance";
import { HttpError } from "@/lib/http";
import {
  applyOcrTemplate,
  matchingOcrVendors,
  sameOcrInvoice,
  templateMappingsSchema,
  type OcrEvidence,
} from "@/lib/ocr-extraction";
import { canCreateBill, canManageVendors } from "@/lib/permissions";
import {
  actOnBill,
  createBillInTransaction,
  prepareBillBooksSelections,
  finalizeBillInTransaction,
  billInclude,
  getBill,
  serializeBill,
} from "@/lib/services/bills";
import {
  storePrivateDocument,
  readPrivateDocument,
  deletePrivateDocument,
  MAX_DOCUMENT_BYTES,
  type PrivateDocumentMetadata,
} from "@/lib/services/documents";
import {
  azureOcrProvider,
  ocrProviderStatus,
  OcrProviderError,
  type DurableOcrProvider,
} from "@/lib/services/ocr-provider";
import { billInputSchema } from "@/lib/validation";

export const MAX_OCR_FILES = 10;
const MAX_BATCH_BYTES = 40 * 1024 * 1024;
const MAX_ATTEMPTS = 5;
const MAX_POLLS = 60;
const scope = async (actor: Actor) => ({
  ...(await companyFilter(actor)),
  ...(actor.role === "DATA_ENTRY" ? { createdById: actor.id } : {}),
});
const writer = (actor: Actor) => {
  if (!canCreateBill(actor))
    throw new HttpError(403, "Your role cannot upload or review OCR invoices.");
};
const jsonValue = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

async function accessibleDocument(actor: Actor, id: string) {
  const document = await db.ocrDocument.findFirst({
    where: { id, batch: await scope(actor) },
    include: { batch: true, scannerImports: scannerLabelInclude },
  });
  if (!document) throw new HttpError(404, "OCR document not found.");
  return document;
}
const scannerLabelInclude = {
  where: { status: "IMPORTED" as const },
  take: 1,
  select: { source: { select: { name: true } } },
};
type ScannerLabel = { scannerImports?: { source: { name: string } }[] };
function publicDocument(document: OcrDocument & ScannerLabel) {
  const {
    storageKey: _storageKey,
    leaseToken: _leaseToken,
    leaseUntil: _leaseUntil,
    sha256: _sha256,
    scannerImports: _scannerImports,
    ...safe
  } = document;
  void _storageKey;
  void _leaseToken;
  void _leaseUntil;
  void _sha256;
  return {
    ...safe,
    scannerSourceName: _scannerImports?.[0]?.source.name ?? null,
  };
}
const ocrBillSelect = {
  id: true,
  invoiceNumber: true,
  status: true,
  version: true,
  createdById: true,
} as const;
function publicBatch(batch: {
  id: string;
  companyId: string;
  createdAt: Date;
  documents: (OcrDocument &
    ScannerLabel & {
      bill?: {
        id: string;
        invoiceNumber: string;
        status: string;
        version: number;
        createdById: string;
      } | null;
    })[];
}) {
  const counts = {
    total: batch.documents.length,
    queued: 0,
    processing: 0,
    review: 0,
    failed: 0,
    posted: 0,
  };
  const keys = {
    QUEUED: "queued",
    PROCESSING: "processing",
    REVIEW_REQUIRED: "review",
    FAILED: "failed",
    POSTED: "posted",
  } as const;
  for (const document of batch.documents) counts[keys[document.status]]++;
  return {
    id: batch.id,
    companyId: batch.companyId,
    createdAt: batch.createdAt,
    counts,
    documents: batch.documents.map((document) => ({
      ...publicDocument(document),
      bill: document.bill,
    })),
  };
}

export async function listOcrBatches(actor: Actor, cursor?: string) {
  const filter = await scope(actor);
  if (cursor) {
    z.string().min(1).max(100).parse(cursor);
    if (
      !(await db.ocrBatch.findFirst({
        where: { id: cursor, ...filter },
        select: { id: true },
      }))
    )
      throw new HttpError(404, "OCR page not found.");
  }
  const batches = await db.ocrBatch.findMany({
    where: filter,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 31,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: {
      documents: {
        orderBy: { createdAt: "asc" },
        include: {
          bill: { select: ocrBillSelect },
          scannerImports: scannerLabelInclude,
        },
      },
    },
  });
  const visible = batches.slice(0, 30);
  return {
    provider: ocrProviderStatus(),
    batches: visible.map(publicBatch),
    nextCursor: batches.length > 30 ? visible.at(-1)!.id : null,
  };
}
export async function getOcrBatch(actor: Actor, id: string) {
  const batch = await db.ocrBatch.findFirst({
    where: { id, ...(await scope(actor)) },
    include: {
      documents: {
        orderBy: { createdAt: "asc" },
        include: {
          bill: { select: ocrBillSelect },
          scannerImports: scannerLabelInclude,
        },
      },
    },
  });
  if (!batch) throw new HttpError(404, "OCR batch not found.");
  return publicBatch(batch);
}
export async function readOcrUploads(request: Request): Promise<File[]> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.startsWith("multipart/form-data;"))
    throw new HttpError(415, "Upload invoice files using multipart/form-data.");
  const maximum = MAX_BATCH_BYTES + 128 * 1024;
  if (Number(request.headers.get("content-length")) > maximum)
    throw new HttpError(413, "An OCR batch must be 40 MB or smaller.");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "Choose invoice files.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    bytes += item.value.byteLength;
    if (bytes > maximum) {
      await reader.cancel();
      throw new HttpError(413, "An OCR batch must be 40 MB or smaller.");
    }
    chunks.push(item.value);
  }
  let form: FormData;
  try {
    form = await new Response(Buffer.concat(chunks), {
      headers: { "Content-Type": contentType },
    }).formData();
  } catch {
    throw new HttpError(400, "The file upload is invalid.");
  }
  const files = [...form.getAll("files"), ...form.getAll("file")];
  if (
    !files.length ||
    files.length > MAX_OCR_FILES ||
    files.some((file) => !(file instanceof File))
  )
    throw new HttpError(422, "Choose between 1 and 10 invoice files.");
  return files as File[];
}

/** Shared ordering serializes same-company hashes across scanner and human upload owners. */
export async function lockOcrIntake(
  tx: Prisma.TransactionClient,
  actor: Actor,
  companyId: string,
) {
  await tx.$queryRaw(
    Prisma.sql`SELECT \`id\` FROM \`Company\` WHERE \`id\`=${companyId} FOR UPDATE`,
  );
  await tx.$queryRaw(
    Prisma.sql`SELECT \`id\` FROM \`User\` WHERE \`id\`=${actor.id} FOR UPDATE`,
  );
  await requireCompanyAccess(actor, companyId, tx);
}

/** Storage is prepared privately by the caller; metadata, OCR and caller receipts commit together. */
export async function createOcrBatchInTransaction(
  tx: Prisma.TransactionClient,
  actor: Actor,
  companyId: string,
  stored: PrivateDocumentMetadata[],
) {
  writer(actor);
  await lockOcrIntake(tx, actor, companyId);
  const unfinished = await tx.ocrDocument.count({
    where: { batch: { createdById: actor.id }, status: { not: "POSTED" } },
  });
  if (unfinished + stored.length > 50)
    throw new HttpError(
      429,
      "Resolve your existing OCR documents before uploading more (50 unfinished documents maximum).",
    );
  const duplicate = await tx.ocrDocument.findFirst({
    where: {
      batch: { companyId },
      sha256: { in: stored.map((file) => file.sha256) },
    },
    select: { id: true },
  });
  const attachedDuplicate = await tx.document.findFirst({
    where: {
      bill: { companyId },
      sha256: { in: stored.map((file) => file.sha256) },
    },
    select: { id: true },
  });
  if (duplicate || attachedDuplicate)
    throw new HttpError(
      409,
      "One of these documents already exists. Review its existing record instead.",
    );
  const status = ocrProviderStatus();
  const saved = await tx.ocrBatch.create({
    data: {
      companyId,
      createdById: actor.id,
      documents: {
        create: stored.map((file) => ({
          ...file,
          status: status.configured ? "QUEUED" : "FAILED",
          failureCode: status.configured ? null : "NOT_CONFIGURED",
          lastError: status.configured ? null : status.message,
        })),
      },
    },
    include: { documents: true },
  });
  await tx.auditLog.create({
    data: {
      actorId: actor.id,
      companyId,
      action: "OCR_BATCH_UPLOADED",
      entityType: "OcrBatch",
      entityId: saved.id,
      details: {
        documentIds: saved.documents.map((document) => document.id),
        providerConfigured: status.configured,
      },
    },
  });
  return saved;
}
export async function createOcrBatch(
  actor: Actor,
  files: File[],
  requestedCompanyId?: string,
) {
  writer(actor);
  const companyId = await resolveCompanyForCreate(actor, requestedCompanyId);
  if (
    !files.length ||
    files.length > MAX_OCR_FILES ||
    files.some((file) => file.size < 8 || file.size > MAX_DOCUMENT_BYTES) ||
    files.reduce((sum, file) => sum + file.size, 0) > MAX_BATCH_BYTES
  )
    throw new HttpError(
      413,
      "Choose 1–10 files, each at most 10 MB, with a total at most 40 MB.",
    );
  const pending = await db.ocrDocument.count({
    where: {
      batch: { createdById: actor.id },
      status: { not: "POSTED" },
    },
  });
  if (pending + files.length > 50)
    throw new HttpError(
      429,
      "Finish processing your queued documents before uploading more.",
    );
  const stored: Awaited<ReturnType<typeof storePrivateDocument>>[] = [];
  try {
    for (const file of files) stored.push(await storePrivateDocument(file));
    if (new Set(stored.map((file) => file.sha256)).size !== stored.length)
      throw new HttpError(
        409,
        "The same document appears more than once in this batch.",
      );
    const existing = await db.ocrDocument.findFirst({
      where: {
        batch: { companyId },
        sha256: { in: stored.map((file) => file.sha256) },
      },
    });
    const attached = await db.document.findFirst({
      where: {
        bill: { companyId },
        sha256: { in: stored.map((file) => file.sha256) },
      },
      select: { id: true },
    });
    if (existing || attached)
      throw new HttpError(
        409,
        "One of these documents was already uploaded or attached to a bill. Review its existing record instead.",
      );
    const batch = await db.$transaction(
      (tx) => createOcrBatchInTransaction(tx, actor, companyId, stored),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    return publicBatch(batch);
  } catch (error) {
    // Preserve files after an uncertain commit outcome. Known validation/conflict
    // failures have rolled back and can compensate their uncommitted uploads.
    if (
      error instanceof HttpError ||
      (error instanceof Prisma.PrismaClientKnownRequestError &&
        ["P2002", "P2034", "P2025"].includes(error.code))
    )
      await Promise.all(
        stored.map((file) =>
          deletePrivateDocument(file.storageKey).catch(() => undefined),
        ),
      );
    throw error;
  }
}

async function suggest(evidence: OcrEvidence, companyId: string) {
  const suggestedInput = { ...evidence.fields };
  const warnings = [...evidence.warnings];
  const vendors = await db.vendor.findMany({
    where: { companyId },
    select: { id: true, name: true, trn: true },
  });
  const matches = matchingOcrVendors(evidence, vendors);
  if (matches.length === 1) suggestedInput.vendorId = matches[0].id;
  else
    warnings.push(
      matches.length > 1
        ? "Several vendors match the extraction. Choose the correct vendor."
        : "No exact vendor match. Select a vendor manually.",
    );
  if (evidence.jobNumber) {
    const job = await db.job.findUnique({
      where: {
        companyId_jobNumber: { companyId, jobNumber: evidence.jobNumber },
      },
      select: { id: true },
    });
    if (job) suggestedInput.jobId = job.id;
    else
      warnings.push(
        "Detected job reference did not exactly match an existing job ID.",
      );
  }
  if (suggestedInput.vendorId && suggestedInput.invoiceNumber) {
    const duplicate = await db.bill.findUnique({
      where: {
        vendorId_normalizedInvoiceNumber: {
          vendorId: suggestedInput.vendorId,
          normalizedInvoiceNumber: normalizeInvoiceNumber(
            suggestedInput.invoiceNumber,
          ),
        },
      },
      select: { id: true },
    });
    if (duplicate)
      warnings.push(
        "A bill with this vendor and invoice number already exists. Duplicate posting is blocked.",
      );
  }
  return { suggestedInput, warnings };
}
export async function getOcrDocument(actor: Actor, id: string) {
  const document = await accessibleDocument(actor, id);
  const evidence = document.extraction as unknown as OcrEvidence | null;
  const suggestions = evidence
    ? await suggest(evidence, document.batch.companyId)
    : { suggestedInput: {}, warnings: [] };
  if (evidence) {
    const peers = await db.ocrDocument.findMany({
      where: {
        batchId: document.batchId,
        id: { not: id },
        status: { in: ["REVIEW_REQUIRED", "POSTED"] },
      },
      select: { extraction: true },
    });
    if (
      peers.some(
        (peer) =>
          peer.extraction &&
          sameOcrInvoice(evidence, peer.extraction as unknown as OcrEvidence),
      )
    )
      suggestions.warnings.push(
        "Another file in this batch has the same extracted vendor/invoice number. Check for duplicates before saving.",
      );
    suggestions.warnings = [...new Set(suggestions.warnings)];
  }
  // Batch owner is kept private; authorization already used it above.
  return {
    ...publicDocument(document),
    ...suggestions,
    companyId: document.batch.companyId,
    batch: undefined,
  };
}
export async function downloadOcrDocument(actor: Actor, id: string) {
  const document = await accessibleDocument(actor, id);
  return {
    bytes: await readPrivateDocument(document),
    fileName: document.fileName,
    mimeType: document.mimeType,
  };
}
export async function reviewOcrDocument(
  actor: Actor,
  id: string,
  payload: unknown,
) {
  writer(actor);
  const request = z
    .object({
      version: z.number().int().positive(),
      confirmed: z.literal(true),
      mode: z.literal("manual").optional(),
      bill: billInputSchema,
    })
    .strict()
    .parse(payload);
  const document = await accessibleDocument(actor, id);
  if (document.billId) return getBill(actor, document.billId);
  const manual = request.mode === "manual";
  if (
    request.bill.companyId &&
    request.bill.companyId !== document.batch.companyId
  )
    throw new HttpError(
      422,
      "The reviewed bill must belong to the upload company.",
    );
  if (
    manual
      ? document.status !== "FAILED"
      : document.status !== "REVIEW_REQUIRED" || !document.extraction
  )
    throw new HttpError(
      409,
      manual
        ? "Manual entry is available only after OCR has failed. Wait for processing to finish."
        : "Only completed OCR documents can be reviewed and saved.",
    );
  await readPrivateDocument(document);
  const booksVerification = await prepareBillBooksSelections(actor, document.batch.companyId, request.bill.lines);
  const result = await db.$transaction(
    async (tx) => {
      await requireCompanyAccess(actor, document.batch.companyId, tx);
      const changed = await tx.ocrDocument.updateMany({
        where: {
          id,
          version: request.version,
          status: manual ? "FAILED" : "REVIEW_REQUIRED",
          billId: null,
        },
        data: { version: { increment: 1 } },
      });
      if (changed.count !== 1)
        throw new HttpError(
          409,
          "This OCR review changed. Refresh before saving.",
        );
      const bill = await createBillInTransaction(tx, actor, {
        ...request.bill,
        companyId: document.batch.companyId,
        submit: false,
      }, booksVerification);
      const verifiedInput = request.bill.lines.some((line) => line.booksSelection) ? {
        ...request.bill, vatRate: bill.vatRate.toFixed(2), lines: bill.lines.map((line) => ({
          description: line.description, quantity: line.quantity.toString(), unitPrice: line.unitPrice.toFixed(2),
          ...(line.booksSelection ? { booksSelection: line.booksSelection } : {}),
        })),
      } : request.bill;
      await tx.document.create({
        data: {
          billId: bill.id,
          storageKey: document.storageKey,
          fileName: document.fileName,
          mimeType: document.mimeType,
          byteSize: document.byteSize,
          sha256: document.sha256,
          uploadedById: actor.id,
        },
      });
      await tx.ocrDocument.update({
        where: { id },
        data: {
          status: "POSTED",
          billId: bill.id,
          reviewedById: actor.id,
          reviewedAt: new Date(),
          verifiedInput: jsonValue(verifiedInput),
          lastError: null,
          failureCode: null,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          companyId: document.batch.companyId,
          action: manual
            ? "OCR_MANUAL_DRAFT_CREATED"
            : "OCR_REVIEWED_AND_DRAFT_CREATED",
          entityType: "Bill",
          entityId: bill.id,
          details: {
            ocrDocumentId: id,
            batchId: document.batchId,
            verifiedInput: jsonValue(verifiedInput),
            sourceSha256: document.sha256,
            templateId: document.templateId,
            ...(manual
              ? {
                  entryMode: "MANUAL_AFTER_OCR_FAILURE",
                  previousFailureCode: document.failureCode,
                  extractionVerified: false,
                }
              : {}),
          },
        },
      });
      const saved = request.bill.submit
        ? await finalizeBillInTransaction(tx, actor, bill.id, bill.version)
        : await tx.bill.findUniqueOrThrow({
            where: { id: bill.id },
            include: billInclude,
          });
      return serializeBill(saved);
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 20_000,
    },
  );
  return result;
}
export async function retryOcrDocument(
  actor: Actor,
  id: string,
  payload: unknown = {},
) {
  writer(actor);
  const request = z
    .object({ acknowledgeUnknown: z.boolean().optional() })
    .strict()
    .parse(payload);
  const document = await accessibleDocument(actor, id);
  if (document.status !== "FAILED")
    throw new HttpError(409, "Only failed OCR documents can be retried.");
  if (
    document.failureCode === "SUBMISSION_UNKNOWN" &&
    !request.acknowledgeUnknown
  )
    throw new HttpError(
      409,
      "The previous OCR submission outcome is unknown. Inspect the provider operations, then explicitly acknowledge that retrying may incur another analysis charge.",
    );
  // A persisted reference proves Azure accepted this analysis. Configuration or
  // polling failures must not turn a retry into another chargeable submission.
  const resume = !!document.providerRequestId;
  if (
    resume &&
    ["EXTRACTION_FAILED", "INVALID_EXTRACTION"].includes(
      document.failureCode ?? "",
    )
  )
    throw new HttpError(
      409,
      "Azure finished this analysis without a usable extraction. Enter the bill manually from the retained original, or upload a corrected invoice instead of analyzing the same document again.",
    );
  if (
    (!resume && document.attempts >= MAX_ATTEMPTS) ||
    document.pollCount >= MAX_POLLS
  )
    throw new HttpError(
      409,
      "This document reached its processing limit. An administrator must investigate before further processing.",
    );
  const status = ocrProviderStatus();
  if (!status.configured) throw new HttpError(503, status.message);
  await db.$transaction(async (tx) => {
    await requireCompanyAccess(actor, document.batch.companyId, tx);
    const changed = await tx.ocrDocument.updateMany({
      where: { id, version: document.version, status: "FAILED" },
      data: {
        status: resume ? "PROCESSING" : "QUEUED",
        providerRequestId: resume ? document.providerRequestId : null,
        lastError: null,
        failureCode: null,
        nextAttemptAt: new Date(),
        leaseUntil: null,
        leaseToken: null,
        version: { increment: 1 },
      },
    });
    if (changed.count !== 1)
      throw new HttpError(
        409,
        "The document changed. Refresh before retrying.",
      );
    await tx.auditLog.create({
      data: {
        actorId: actor.id,
        companyId: document.batch.companyId,
        action: "OCR_RETRY_REQUESTED",
        entityType: "OcrDocument",
        entityId: id,
        details: {
          previousFailure: document.failureCode,
          attemptCount: document.attempts,
          acknowledgedUnknown: request.acknowledgeUnknown ?? false,
        },
      },
    });
  });
  return getOcrDocument(actor, id);
}
export async function listOcrTemplates(actor: Actor) {
  writer(actor);
  return db.ocrTemplate.findMany({
    where: { vendor: await companyFilter(actor) },
    include: { vendor: { select: { id: true, name: true } } },
    orderBy: [{ vendorId: "asc" }, { version: "desc" }],
    take: 200,
  });
}
export async function createOcrTemplate(actor: Actor, payload: unknown) {
  if (!canManageVendors(actor))
    throw new HttpError(
      403,
      "Only Admin or Accounts can publish vendor templates.",
    );
  const input = z
    .object({
      vendorId: z.string().min(1).max(100),
      name: z.string().trim().min(2).max(120),
      mappings: templateMappingsSchema,
    })
    .strict()
    .parse(payload);
  return db.$transaction(
    async (tx) => {
      const vendor = await tx.vendor.findUnique({
        where: { id: input.vendorId },
      });
      if (!vendor) throw new HttpError(422, "Choose an existing vendor.");
      await requireCompanyAccess(actor, vendor.companyId, tx);
      const previous = await tx.ocrTemplate.findFirst({
        where: { vendorId: input.vendorId },
        orderBy: { version: "desc" },
      });
      await tx.ocrTemplate.updateMany({
        where: { vendorId: input.vendorId, active: true },
        data: { active: false },
      });
      const saved = await tx.ocrTemplate.create({
        data: {
          ...input,
          mappings: input.mappings,
          version: (previous?.version ?? 0) + 1,
          createdById: actor.id,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          companyId: vendor.companyId,
          action: "OCR_TEMPLATE_VERSION_PUBLISHED",
          entityType: "OcrTemplate",
          entityId: saved.id,
          details: {
            vendorId: input.vendorId,
            version: saved.version,
            mappings: input.mappings,
            previousTemplateId: previous?.id ?? null,
          },
        },
      });
      return saved;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

/** One bounded queue tick; leases make concurrent workers and restarts safe. No financial write occurs here. */
export async function processOcrQueue(
  limit = 5,
  provider: DurableOcrProvider = azureOcrProvider,
) {
  const maximum = Math.min(10, Math.max(1, Math.floor(limit)));
  let processed = 0;
  for (let index = 0; index < maximum; index++) {
    const now = new Date();
    const leaseToken = randomUUID();
    const candidate = await db.ocrDocument.findFirst({
      where: {
        status: { in: ["QUEUED", "PROCESSING"] },
        nextAttemptAt: { lte: now },
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
      },
      orderBy: { nextAttemptAt: "asc" },
    });
    if (!candidate) break;
    const claimed = await db.ocrDocument.updateMany({
      where: {
        id: candidate.id,
        version: candidate.version,
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
      },
      data: {
        leaseToken,
        leaseUntil: new Date(now.getTime() + 60000),
        version: { increment: 1 },
      },
    });
    if (claimed.count !== 1) continue;
    processed++;
    try {
      if (candidate.status === "PROCESSING" && !candidate.providerRequestId)
        throw new OcrProviderError(
          "SUBMISSION_UNKNOWN",
          "A worker stopped before saving the OCR operation reference. Inspect provider operations before retrying; another analysis charge is possible.",
        );
      if (
        (!candidate.providerRequestId && candidate.attempts >= MAX_ATTEMPTS) ||
        candidate.pollCount >= MAX_POLLS
      )
        throw new OcrProviderError(
          "PROCESSING_LIMIT",
          "The OCR processing limit was reached. An administrator must inspect the original document.",
        );
      const owner = await db.ocrBatch.findUnique({
        where: { id: candidate.batchId },
        include: {
          createdBy: { select: { id: true, active: true, role: true } },
        },
      });
      if (!owner?.createdBy.active)
        throw new OcrProviderError(
          "ACCOUNT_INACTIVE",
          "The upload owner's account is inactive. Processing requires administrator review.",
        );
      if (!canCreateBill(owner.createdBy))
        throw new OcrProviderError(
          "OCR_PERMISSION_REVOKED",
          "The upload owner's current role cannot process OCR invoices. An administrator must review access before processing can continue.",
        );
      await requireCompanyAccess({ id: owner.createdById }, owner.companyId);
      if (!candidate.providerRequestId) {
        // Persist the attempt before network I/O, including crash/timeout cases.
        const starting = await db.ocrDocument.updateMany({
          where: { id: candidate.id, leaseToken },
          data: { attempts: { increment: 1 }, status: "PROCESSING" },
        });
        if (starting.count !== 1) continue;
        const started = await provider.start(
          await readPrivateDocument(candidate),
        );
        await db.ocrDocument.updateMany({
          where: { id: candidate.id, leaseToken },
          data: {
            status: "PROCESSING",
            providerRequestId: started.requestId,
            nextAttemptAt: new Date(
              Date.now() + started.retryAfterSeconds * 1000,
            ),
            leaseUntil: null,
            leaseToken: null,
            lastError: null,
            failureCode: null,
          },
        });
      } else {
        const polling = await db.ocrDocument.updateMany({
          where: { id: candidate.id, leaseToken },
          data: { pollCount: { increment: 1 } },
        });
        if (polling.count !== 1) continue;
        const result = await provider.poll(candidate.providerRequestId);
        if (result.status === "running") {
          await db.ocrDocument.updateMany({
            where: { id: candidate.id, leaseToken },
            data: {
              nextAttemptAt: new Date(
                Date.now() + result.retryAfterSeconds * 1000,
              ),
              leaseUntil: null,
              leaseToken: null,
            },
          });
        } else {
          let extraction = result.extraction;
          let templateId: string | null = null;
          const suggested = await suggest(extraction, owner.companyId);
          if (suggested.suggestedInput.vendorId) {
            const template = await db.ocrTemplate.findFirst({
              where: {
                vendorId: suggested.suggestedInput.vendorId,
                active: true,
              },
            });
            if (template) {
              extraction = applyOcrTemplate(extraction, template.mappings);
              templateId = template.id;
            }
          }
          const otherFiles = await db.ocrDocument.findMany({
            where: {
              batchId: candidate.batchId,
              id: { not: candidate.id },
              status: { in: ["REVIEW_REQUIRED", "POSTED"] },
            },
            select: { extraction: true },
          });
          if (
            extraction.fields.invoiceNumber &&
            otherFiles.some(
              (other) =>
                other.extraction &&
                sameOcrInvoice(
                  extraction,
                  other.extraction as unknown as OcrEvidence,
                ),
            )
          )
            extraction.warnings.push(
              "Another file in this batch has the same extracted vendor/invoice number. Check for duplicates before saving.",
            );
          await db.$transaction(async (tx) => {
            const completed = await tx.ocrDocument.updateMany({
              where: { id: candidate.id, leaseToken },
              data: {
                status: "REVIEW_REQUIRED",
                extraction: jsonValue(extraction),
                templateId,
                leaseUntil: null,
                leaseToken: null,
                failureCode: null,
                lastError: null,
              },
            });
            if (completed.count !== 1) return;
            await tx.auditLog.create({
              data: {
                companyId: owner.companyId,
                action: "OCR_EXTRACTION_COMPLETED",
                entityType: "OcrDocument",
                entityId: candidate.id,
                details: {
                  providerRequestId: candidate.providerRequestId,
                  templateId,
                  requiresHumanReview: true,
                },
              },
            });
          });
        }
      }
    } catch (error) {
      const failure =
        error instanceof OcrProviderError
          ? error
          : new OcrProviderError(
              "PROCESSING_ERROR",
              "OCR processing failed. The original document is preserved; inspect its integrity and provider configuration.",
            );
      const retry =
        failure.retryable &&
        (candidate.providerRequestId !== null ||
          candidate.attempts + 1 < MAX_ATTEMPTS) &&
        candidate.pollCount + 1 < MAX_POLLS;
      await db.ocrDocument.updateMany({
        where: { id: candidate.id, leaseToken },
        data: {
          status: retry
            ? candidate.providerRequestId
              ? "PROCESSING"
              : "QUEUED"
            : "FAILED",
          failureCode: failure.code,
          lastError: failure.message,
          nextAttemptAt: new Date(
            Date.now() +
              Math.max(
                failure.retryAfterSeconds,
                2 ** Math.min(candidate.attempts + candidate.pollCount, 7),
              ) *
                1000,
          ),
          leaseUntil: null,
          leaseToken: null,
        },
      });
    }
  }
  return { processed };
}

export async function approveOcrBatch(
  actor: Actor,
  id: string,
  payload: unknown,
) {
  if (!["ADMIN", "ACCOUNTS"].includes(actor.role))
    throw new HttpError(
      403,
      "Only independent Admin or Accounts reviewers can approve bills.",
    );
  const input = z
    .object({
      bills: z
        .array(
          z
            .object({
              id: z.string().min(1).max(100),
              version: z.number().int().positive(),
            })
            .strict(),
        )
        .min(1)
        .max(10),
      confirmed: z.literal(true),
    })
    .strict()
    .parse(payload);
  const batch = await getOcrBatch(actor, id);
  const permitted = new Set(batch.documents.map((document) => document.billId));
  if (
    input.bills.some((bill) => !permitted.has(bill.id)) ||
    new Set(input.bills.map((bill) => bill.id)).size !== input.bills.length
  )
    throw new HttpError(422, "Choose distinct reviewed bills from this batch.");
  const results = [];
  for (const bill of input.bills) {
    try {
      await actOnBill(actor, bill.id, {
        action: "approve",
        version: bill.version,
      });
      results.push({ billId: bill.id, approved: true });
    } catch (error) {
      results.push({
        billId: bill.id,
        approved: false,
        error:
          error instanceof HttpError
            ? error.message
            : "This bill could not be approved. Refresh and review it separately.",
      });
    }
  }
  return { results };
}
export async function ocrErrorsCsv(actor: Actor, id: string) {
  const batch = await getOcrBatch(actor, id);
  const cell = (value: string) =>
    `"${(/^[=+\-@\t\r]/.test(value) ? "'" : "") + value.replace(/"/g, '""')}"`;
  return [
    "Document,Status,Error code,Error",
    ...batch.documents
      .filter((document) => document.lastError)
      .map((document) =>
        [
          document.fileName,
          document.status,
          document.failureCode ?? "",
          document.lastError ?? "",
        ]
          .map(cell)
          .join(","),
      ),
  ].join("\r\n");
}

/** Current duplicate warnings, bounded and explicitly marked when the review queue is larger. */
export async function countOcrDuplicateWarnings(actor: Actor) {
  const maximum = 200;
  const documents = await db.ocrDocument.findMany({
    where: { status: "REVIEW_REQUIRED", batch: await scope(actor) },
    orderBy: { createdAt: "desc" },
    select: { extraction: true, batch: { select: { companyId: true } } },
    take: maximum + 1,
  });
  const truncated = documents.length > maximum;
  const vendors = await db.vendor.findMany({
    where: { companyId: { in: await companyIdsForActor(actor) } },
    select: { id: true, name: true, trn: true, companyId: true },
  });
  const keys = documents.slice(0, maximum).flatMap((document) => {
    const evidence = document.extraction as unknown as OcrEvidence | null;
    if (!evidence?.fields.invoiceNumber) return [];
    const matches = matchingOcrVendors(
      evidence,
      vendors.filter((vendor) => vendor.companyId === document.batch.companyId),
    );
    if (matches.length !== 1) return [];
    return [
      {
        vendorId: matches[0].id,
        normalizedInvoiceNumber: normalizeInvoiceNumber(
          evidence.fields.invoiceNumber,
        ),
      },
    ];
  });
  const existing = keys.length
    ? await db.bill.findMany({
        where: { OR: keys },
        select: { vendorId: true, normalizedInvoiceNumber: true },
      })
    : [];
  const key = (value: { vendorId: string; normalizedInvoiceNumber: string }) =>
    JSON.stringify([value.vendorId, value.normalizedInvoiceNumber]);
  const existingKeys = new Set(existing.map(key));
  const occurrences = new Map<string, number>();
  for (const value of keys)
    occurrences.set(key(value), (occurrences.get(key(value)) ?? 0) + 1);
  return {
    count: keys.filter(
      (value) =>
        existingKeys.has(key(value)) || (occurrences.get(key(value)) ?? 0) > 1,
    ).length,
    documentsChecked: Math.min(documents.length, maximum),
    truncated,
  };
}
