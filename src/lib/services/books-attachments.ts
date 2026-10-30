import "server-only";
import { createHash } from "node:crypto";
import {
  Prisma,
  type BooksBill,
  type BooksBillAttachment,
} from "@prisma/client";
import { z } from "zod";
import type { Actor } from "@/lib/auth";
import { companyFilter, requireCompanyAccess } from "@/lib/company";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import {
  assertBooksBillReader,
  assertBooksImportContext,
} from "@/lib/services/books-import-access";
import {
  deletePrivateDocument,
  detectDocumentType,
  MAX_DOCUMENT_BYTES,
  readPrivateDocument,
  storePrivateDocument,
} from "@/lib/services/documents";
import type { IncomingSyncInput } from "./incoming-sync-types";
import { assertIncomingBooksContext } from "./incoming-books-context";

type BillSource = Pick<
  BooksBill,
  "sourceDetail" | "sourceSummary" | "lastImportRunId" | "detailImportRunId"
>;
const externalId = z.string().regex(/^\d{1,30}$/);
const mimeTypes: Record<string, string> = {
  pdf: "application/pdf",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
};
function record(value: Prisma.JsonValue | undefined): Prisma.JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}
function documents(bill: BillSource): Prisma.JsonObject[] {
  if (
    bill.sourceDetail === null ||
    bill.detailImportRunId !== bill.lastImportRunId
  )
    return [];
  const source = record(bill.sourceDetail);
  return Array.isArray(source.documents)
    ? source.documents.filter(
        (value): value is Prisma.JsonObject =>
          value !== null && typeof value === "object" && !Array.isArray(value),
      )
    : [];
}
function canonical(value: Prisma.JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function booksAttachmentMetadataHash(source: Prisma.JsonObject) {
  return createHash("sha256").update(canonical(source)).digest("hex");
}
function sourceDocument(bill: BillSource, documentId: string) {
  const matches = documents(bill).filter(
    (item) => item.document_id === documentId,
  );
  if (matches.length !== 1)
    throw new HttpError(
      409,
      "This attachment does not belong to the current Books bill copy. Refresh the source details.",
    );
  const source = matches[0];
  const size =
    typeof source.file_size === "string" && /^\d+$/.test(source.file_size)
      ? Number(source.file_size)
      : source.file_size;
  const mimeType =
    typeof source.file_type === "string"
      ? mimeTypes[source.file_type.toLowerCase()]
      : undefined;
  if (
    !externalId.safeParse(source.document_id).success ||
    typeof source.file_name !== "string" ||
    !source.file_name ||
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 8 ||
    size > MAX_DOCUMENT_BYTES ||
    !mimeType
  )
    throw new HttpError(
      422,
      "The source attachment metadata is incomplete or unsupported.",
    );
  return {
    source,
    byteSize: size,
    mimeType,
    fileName: source.file_name,
    sourceMetadataHash: booksAttachmentMetadataHash(source),
  };
}
export const getBooksAttachmentSourceMetadata = sourceDocument;
function currentAttachment(bill: BillSource, attachment: BooksBillAttachment) {
  try {
    const source = sourceDocument(bill, attachment.externalDocumentId);
    return (
      source.sourceMetadataHash === attachment.sourceMetadataHash &&
      source.byteSize === attachment.byteSize &&
      source.mimeType === attachment.mimeType
    );
  } catch {
    return false;
  }
}

/** A whitelist for browser DTOs: source URLs and private storage keys never leave the service. */
export function describeBooksAttachments(
  bill: BillSource,
  stored: BooksBillAttachment[],
) {
  const sourceDocuments = documents(bill);
  const rows = sourceDocuments.map((source) => {
    const id =
      typeof source.document_id === "string" ? source.document_id : null;
    const name =
      typeof source.file_name === "string"
        ? source.file_name
        : typeof source.document_name === "string"
          ? source.document_name
          : typeof source.name === "string"
            ? source.name
            : null;
    const attachment = stored.find(
      (entry) =>
        entry.externalDocumentId === id && currentAttachment(bill, entry),
    );
    return {
      id,
      name,
      attachmentId: attachment?.id ?? null,
      downloaded: Boolean(attachment),
      status: attachment ? ("AVAILABLE" as const) : ("PENDING" as const),
      fileName: attachment?.fileName ?? null,
      mimeType: attachment?.mimeType ?? null,
      byteSize: attachment?.byteSize ?? null,
      downloadedAt: attachment?.downloadedAt.toISOString() ?? null,
    };
  });
  const downloadedAttachmentCount = rows.filter((row) => row.downloaded).length;
  const hasAttachment =
    rows.length > 0 ||
    record(bill.sourceSummary).has_attachment === true ||
    Boolean(record(bill.sourceDetail ?? undefined).attachment_name);
  const attachmentsDownloaded =
    rows.length > 0 && downloadedAttachmentCount === rows.length;
  const attachmentStatus = attachmentsDownloaded
    ? ("COMPLETE" as const)
    : downloadedAttachmentCount > 0
      ? ("PARTIAL" as const)
      : hasAttachment
        ? ("PENDING" as const)
        : ("NONE" as const);
  return {
    documents: rows,
    attachmentCount: rows.length,
    downloadedAttachmentCount,
    attachmentsDownloaded,
    attachmentStatus,
    hasAttachment,
  };
}

async function importBill(
  store: Prisma.TransactionClient,
  actor: Actor,
  billId: string,
  organizationId: string,
  incoming?: IncomingSyncInput,
) {
  const bill = await store.booksBill.findUnique({ where: { id: billId } });
  if (!bill) throw new HttpError(404, "Books bill not found.");
  if (incoming) await assertIncomingBooksContext(store, incoming);
  const context = incoming
    ? incoming.source
    : await assertBooksImportContext(
        store,
        actor,
        bill.companyId,
        organizationId,
      );
  if (
    incoming &&
    (bill.companyId !== incoming.source.companyId ||
      bill.isStale ||
      organizationId !== incoming.source.organizationId)
  )
    throw new HttpError(
      409,
      "The incoming attachment company or source changed.",
    );
  if (
    bill.organizationId !== context.organizationId ||
    bill.dataCenter !== context.dataCenter ||
    bill.environment !== context.environment
  )
    throw new HttpError(
      409,
      "The attachment source does not match this bill's Books organization.",
    );
  return bill;
}

/** Import only bytes already downloaded by the verified, read-only Books connection. Never queues a provider write. */
type AttachmentInput = {
  billId: string;
  organizationId: string;
  externalDocumentId: string;
  file: File;
  downloadedAt?: Date | string;
  expectedSourceMetadataHash?: string;
};
export async function importBooksBillAttachment(
  actor: Actor,
  input: AttachmentInput,
) {
  return importAttachment(actor, input);
}
export async function importIncomingBooksBillAttachment(
  incoming: IncomingSyncInput,
  input: AttachmentInput & { expectedSourceMetadataHash: string },
) {
  if (!/^[a-f0-9]{64}$/.test(input.expectedSourceMetadataHash))
    throw new HttpError(422, "The original attachment version is required.");
  return importAttachment(incoming.actor, input, incoming);
}
async function importAttachment(
  actor: Actor,
  input: AttachmentInput,
  incoming?: IncomingSyncInput,
) {
  externalId.parse(input.organizationId);
  externalId.parse(input.externalDocumentId);
  const downloadedAt =
    input.downloadedAt === undefined
      ? new Date()
      : new Date(input.downloadedAt);
  if (
    Number.isNaN(downloadedAt.getTime()) ||
    downloadedAt.getTime() > Date.now() + 60_000
  )
    throw new HttpError(
      422,
      "The original attachment download time is invalid.",
    );
  const bill = await importBill(
    db,
    actor,
    input.billId,
    input.organizationId,
    incoming,
  );
  const source = sourceDocument(bill, input.externalDocumentId);
  if (
    input.expectedSourceMetadataHash &&
    input.expectedSourceMetadataHash !== source.sourceMetadataHash
  )
    throw new HttpError(
      409,
      "The Books attachment changed while its bytes were being downloaded.",
    );
  if (!(input.file instanceof File) || input.file.size !== source.byteSize)
    throw new HttpError(
      409,
      "The downloaded attachment size differs from its original Books metadata.",
    );
  const bytes = Buffer.from(await input.file.arrayBuffer());
  const detected = detectDocumentType(bytes);
  if (
    detected.mimeType !== source.mimeType ||
    (input.file.type && input.file.type !== detected.mimeType)
  )
    throw new HttpError(
      415,
      "The downloaded attachment content differs from its original Books file type.",
    );
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const existing = await db.booksBillAttachment.findUnique({
    where: {
      billId_externalDocumentId: {
        billId: bill.id,
        externalDocumentId: input.externalDocumentId,
      },
    },
  });
  if (
    existing &&
    currentAttachment(bill, existing) &&
    existing.sha256 === sha256
  ) {
    let available = false;
    try {
      await readPrivateDocument(existing);
      available = true;
    } catch (error) {
      if (!(error instanceof HttpError) || ![404, 409].includes(error.status))
        throw error;
    }
    if (available) {
      const latest = await importBill(
        db,
        actor,
        input.billId,
        input.organizationId,
        incoming,
      );
      if (!currentAttachment(latest, existing))
        throw new HttpError(
          409,
          "The Books attachment changed during import. Retry with current metadata.",
        );
      return {
        id: existing.id,
        fileName: existing.fileName,
        byteSize: existing.byteSize,
        sha256,
        alreadyImported: true,
      };
    }
  }
  const stored = await storePrivateDocument(
    new File([bytes], source.fileName, { type: detected.mimeType }),
  );
  try {
    return await db.$transaction(
      async (tx) => {
        const latest = await importBill(
          tx,
          actor,
          input.billId,
          input.organizationId,
          incoming,
        );
        if (
          sourceDocument(latest, input.externalDocumentId)
            .sourceMetadataHash !== source.sourceMetadataHash
        )
          throw new HttpError(
            409,
            "The Books attachment changed during import. Retry with current metadata.",
          );
        const previous = await tx.booksBillAttachment.findUnique({
          where: {
            billId_externalDocumentId: {
              billId: bill.id,
              externalDocumentId: input.externalDocumentId,
            },
          },
        });
        const values = {
          billId: bill.id,
          companyId: bill.companyId,
          organizationId: bill.organizationId,
          dataCenter: bill.dataCenter,
          environment: bill.environment,
          externalDocumentId: input.externalDocumentId,
          sourceMetadata: source.source as Prisma.InputJsonObject,
          sourceMetadataHash: source.sourceMetadataHash,
          ...stored,
          downloadedAt,
        };
        const saved = await tx.booksBillAttachment.upsert({
          where: {
            billId_externalDocumentId: {
              billId: bill.id,
              externalDocumentId: input.externalDocumentId,
            },
          },
          create: values,
          update: values,
        });
        await tx.auditLog.create({
          data: {
            actorId: actor.id,
            companyId: bill.companyId,
            action: "BOOKS_ATTACHMENT_IMPORTED",
            entityType: "BooksBill",
            entityId: bill.id,
            details: {
              attachmentId: saved.id,
              organizationId: bill.organizationId,
              externalBillId: bill.externalBillId,
              externalDocumentId: input.externalDocumentId,
              byteSize: stored.byteSize,
              sha256: stored.sha256,
              sourceMetadataHash: source.sourceMetadataHash,
              replacedLocalCopy: Boolean(previous),
              previousSha256: previous?.sha256 ?? null,
              providerFinancialWrites: 0,
            },
          },
        });
        return {
          id: saved.id,
          fileName: saved.fileName,
          byteSize: saved.byteSize,
          sha256: saved.sha256,
          alreadyImported: false,
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 60_000,
      },
    );
  } catch (error) {
    await deletePrivateDocument(stored.storageKey).catch(() => undefined);
    throw error;
  }
}

async function readableAttachment(
  actor: Actor,
  billId: string,
  attachmentId: string,
) {
  await assertBooksBillReader(actor);
  const scope = await companyFilter(actor);
  const attachment = await db.booksBillAttachment.findFirst({
    where: { id: attachmentId, billId, ...scope },
    include: { bill: true },
  });
  if (!attachment) throw new HttpError(404, "Books attachment not found.");
  if (!currentAttachment(attachment.bill, attachment))
    throw new HttpError(
      409,
      "This original attachment is awaiting a current Books download.",
    );
  await requireCompanyAccess(actor, attachment.companyId);
  return attachment;
}

export async function downloadBooksBillAttachment(
  actor: Actor,
  billId: string,
  attachmentId: string,
) {
  const attachment = await readableAttachment(actor, billId, attachmentId);
  const bytes = await readPrivateDocument(attachment);
  if (detectDocumentType(bytes).mimeType !== attachment.mimeType)
    throw new HttpError(
      409,
      "The stored attachment type does not match its metadata.",
    );
  const latest = await readableAttachment(actor, billId, attachmentId);
  if (
    latest.sha256 !== attachment.sha256 ||
    latest.sourceMetadataHash !== attachment.sourceMetadataHash
  )
    throw new HttpError(
      409,
      "The Books attachment changed during download. Reload the page.",
    );
  return {
    bytes,
    fileName: latest.fileName,
    mimeType: latest.mimeType,
    byteSize: latest.byteSize,
  };
}
