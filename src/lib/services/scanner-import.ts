import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { Actor } from "@/lib/auth";
import { requireCompanyAccess } from "@/lib/company";
import { HttpError } from "@/lib/http";
import { createOcrBatchInTransaction, lockOcrIntake } from "@/lib/services/ocr";
import {
  storePrivateDocument,
  deletePrivateDocument,
  MAX_DOCUMENT_BYTES,
} from "@/lib/services/documents";

type Store = Pick<
  Prisma.TransactionClient,
  "scannerSource" | "userCompanyMembership"
>;
export interface ScannerIdentity {
  sourceId: string;
  companyId: string;
  actor: Actor;
  tokenHash: string;
}
export interface ScannerUpload {
  bytes: Buffer;
  sha256: string;
  fileName: string;
}
const hash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const unavailable = () =>
  new HttpError(401, "Scanner source authentication is unavailable.");

async function currentSource(
  sourceId: string,
  tokenHash: string,
  store: Store = db,
): Promise<ScannerIdentity> {
  const source = await store.scannerSource.findUnique({
    where: { id: sourceId },
    include: { uploadedBy: true, company: true },
  });
  if (
    !source?.active ||
    !source.company.active ||
    !/^[a-f0-9]{64}$/.test(source.tokenHash) ||
    !timingSafeEqual(
      Buffer.from(source.tokenHash, "hex"),
      Buffer.from(tokenHash, "hex"),
    )
  )
    throw unavailable();
  const user = source.uploadedBy;
  if (!user.active || user.role !== "DATA_ENTRY") throw unavailable();
  try {
    await requireCompanyAccess(user, source.companyId, store);
  } catch {
    throw unavailable();
  }
  return {
    sourceId: source.id,
    companyId: source.companyId,
    tokenHash,
    actor: { id: user.id, name: user.name, email: user.email, role: user.role },
  };
}

/** Dedicated intake-only machine credential; staff cookies never authorize this endpoint. */
export async function authenticateScannerRequest(
  request: Request,
): Promise<ScannerIdentity> {
  if (process.env.SCANNER_IMPORT_ENABLED !== "true")
    throw new HttpError(
      503,
      "Scanner intake is disabled. Configure the approved source before enabling intake.",
    );
  let configured: URL, incoming: URL;
  try {
    configured = new URL(process.env.APP_URL ?? "");
    incoming = new URL(request.url);
  } catch {
    throw new HttpError(
      503,
      "Scanner intake requires a configured secure application origin.",
    );
  }
  const loopbackHosts = ["127.0.0.1", "localhost", "[::1]"];
  const loopback =
    ["development", "test"].includes(process.env.APP_ENV ?? "") &&
    loopbackHosts.includes(configured.hostname) &&
    configured.protocol === "http:";
  // NextRequest canonicalizes 127.0.0.1 and [::1] to localhost. Only the explicit
  // local HTTP test exception may accept that alias, at the same port. Bind the
  // original request authority through Host; forwarded headers are not trusted here.
  const normalizedLoopback =
    loopback &&
    incoming.protocol === "http:" &&
    loopbackHosts.includes(incoming.hostname) &&
    incoming.port === configured.port;
  if (
    (!loopback && configured.protocol !== "https:") ||
    (incoming.origin !== configured.origin && !normalizedLoopback) ||
    request.headers.get("host")?.toLowerCase() !==
      configured.host.toLowerCase() ||
    configured.username ||
    configured.password ||
    configured.search ||
    configured.hash
  )
    throw new HttpError(
      403,
      "Scanner intake requires the configured HTTPS origin or the explicit local test origin.",
    );
  if (request.headers.has("cookie") || request.headers.has("origin"))
    throw new HttpError(
      403,
      "Scanner intake requires its separate machine credential.",
    );
  const sourceId = request.headers.get("x-scanner-source") ?? "";
  const token = request.headers
    .get("authorization")
    ?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(sourceId) || !token) throw unavailable();
  return currentSource(sourceId, hash(token));
}

/** One bounded PDF body, with independently checked content hash and a basename only. */
export async function readScannerUpload(
  request: Request,
): Promise<ScannerUpload> {
  if (
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      .trim()
      .toLowerCase() !== "application/pdf"
  )
    throw new HttpError(
      415,
      "Scanner intake accepts one PDF invoice per request.",
    );
  const expected = request.headers.get("x-scanner-sha256") ?? "";
  if (!/^[a-f0-9]{64}$/.test(expected))
    throw new HttpError(422, "A valid scanner file hash is required.");
  const encodedName = request.headers.get("x-scanner-file-name") ?? "";
  let fileName: string;
  try {
    fileName = decodeURIComponent(encodedName);
  } catch {
    throw new HttpError(422, "The scanner filename is invalid.");
  }
  if (
    !fileName ||
    fileName.length > 200 ||
    encodedName.length > 1800 ||
    /[\\/\u0000-\u001f\u007f]/.test(fileName) ||
    !/\.pdf$/i.test(fileName) ||
    /[. ]$/.test(fileName)
  )
    throw new HttpError(422, "Use a PDF filename without a folder path.");
  const declared = request.headers.get("content-length");
  if (
    declared &&
    (!/^\d+$/.test(declared) || Number(declared) > MAX_DOCUMENT_BYTES)
  )
    throw new HttpError(413, "Scanner invoices must be 10 MB or smaller.");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "A PDF invoice body is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_DOCUMENT_BYTES) {
      await reader.cancel();
      throw new HttpError(413, "Scanner invoices must be 10 MB or smaller.");
    }
    chunks.push(part.value);
  }
  if (size < 8)
    throw new HttpError(415, "The scanner PDF is empty or incomplete.");
  const bytes = Buffer.concat(chunks);
  if (declared && Number(declared) !== size)
    throw new HttpError(
      422,
      "The scanner file length changed during transfer.",
    );
  if (hash(bytes) !== expected)
    throw new HttpError(
      422,
      "The scanner file hash does not match its bytes. Wait for copying to finish.",
    );
  return { bytes, sha256: expected, fileName };
}

const receiptInclude = {
  ocrDocument: {
    select: {
      id: true,
      status: true,
      batch: { select: { createdById: true } },
    },
  },
} as const;
type ReceiptRow = Prisma.ScannerImportGetPayload<{
  include: typeof receiptInclude;
}>;
function receipt(
  row: ReceiptRow,
  identity: ScannerIdentity,
  duplicate: boolean,
) {
  // Another owner's matching upload remains private even when its hash is known.
  const visible =
    row.ocrDocument?.batch.createdById === identity.actor.id
      ? row.ocrDocument
      : null;
  return {
    importId: row.id,
    status: row.status,
    duplicate,
    ocrDocumentId: visible?.id ?? null,
    ocrStatus: visible?.status ?? null,
    reviewUrl: visible ? `/ocr/documents/${visible.id}` : null,
  };
}

/** Same-company lock + unique source/hash receipt give durable idempotent handoff. */
export async function importScannerFile(
  identity: ScannerIdentity,
  upload: ScannerUpload,
) {
  if (
    upload.bytes.length < 8 ||
    upload.bytes.length > MAX_DOCUMENT_BYTES ||
    hash(upload.bytes) !== upload.sha256
  )
    throw new HttpError(
      422,
      "Scanner bytes did not match the verified upload.",
    );
  const validPdf =
    /^%PDF-\d\.\d/.test(upload.bytes.subarray(0, 12).toString("ascii")) &&
    /%%EOF[\t\r\n ]*$/.test(upload.bytes.subarray(-1024).toString("latin1"));
  let stored: Awaited<ReturnType<typeof storePrivateDocument>> | undefined;
  let storageCommitted = false;
  let cleanupAllowed = false;
  try {
    if (validPdf)
      stored = await storePrivateDocument(
        new File([new Uint8Array(upload.bytes)], upload.fileName, {
          type: "application/pdf",
        }),
      );
    let result:
      { row: ReceiptRow; created: boolean; storageUsed: boolean } | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        result = await db.$transaction(
          async (tx) => {
            await lockOcrIntake(tx, identity.actor, identity.companyId);
            const current = await currentSource(
              identity.sourceId,
              identity.tokenHash,
              tx,
            );
            if (
              current.companyId !== identity.companyId ||
              current.actor.id !== identity.actor.id
            )
              throw unavailable();
            const existing = await tx.scannerImport.findUnique({
              where: {
                sourceId_sha256: {
                  sourceId: identity.sourceId,
                  sha256: upload.sha256,
                },
              },
              include: receiptInclude,
            });
            if (existing)
              return { row: existing, created: false, storageUsed: false };
            if (!validPdf || !stored) {
              const row = await tx.scannerImport.create({
                data: {
                  sourceId: identity.sourceId,
                  sha256: upload.sha256,
                  byteSize: upload.bytes.length,
                  status: "REJECTED",
                  failureCode: "INVALID_PDF",
                },
                include: receiptInclude,
              });
              return { row, created: true, storageUsed: false };
            }
            const duplicateOcr = await tx.ocrDocument.findFirst({
              where: {
                sha256: upload.sha256,
                batch: { companyId: identity.companyId },
              },
              select: { id: true },
            });
            const duplicateDocument = duplicateOcr
              ? null
              : await tx.document.findFirst({
                  where: {
                    sha256: upload.sha256,
                    bill: { companyId: identity.companyId },
                  },
                  select: { id: true },
                });
            let ocrDocumentId = duplicateOcr?.id ?? null;
            const duplicate = !!duplicateOcr || !!duplicateDocument;
            if (!duplicate) {
              const batch = await createOcrBatchInTransaction(
                tx,
                current.actor,
                current.companyId,
                [stored],
              );
              ocrDocumentId = batch.documents[0].id;
            }
            const row = await tx.scannerImport.create({
              data: {
                sourceId: identity.sourceId,
                sha256: upload.sha256,
                byteSize: upload.bytes.length,
                status: duplicate ? "DUPLICATE" : "IMPORTED",
                ocrDocumentId,
                documentId: duplicateDocument?.id ?? null,
              },
              include: receiptInclude,
            });
            await tx.auditLog.create({
              data: {
                actorId: current.actor.id,
                companyId: current.companyId,
                action: duplicate
                  ? "SCANNER_DUPLICATE_OBSERVED"
                  : "SCANNER_INVOICE_IMPORTED",
                entityType: "ScannerImport",
                entityId: row.id,
                details: {
                  scannerSourceId: current.sourceId,
                  sha256: upload.sha256,
                  ocrDocumentId,
                  duplicate,
                },
              },
            });
            return { row, created: true, storageUsed: !duplicate };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        break;
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2034" &&
          attempt < 2
        )
          continue;
        throw error;
      }
    }
    if (!result)
      throw new HttpError(
        409,
        "Scanner intake changed concurrently. Retry the same file hash.",
      );
    storageCommitted = result.storageUsed;
    cleanupAllowed = true;
    if (result.row.status === "REJECTED")
      throw new HttpError(
        415,
        "The scanner PDF is invalid or incomplete. Preserve the source and scan it again.",
      );
    return {
      created: result.created && result.row.status === "IMPORTED",
      receipt: receipt(
        result.row,
        identity,
        !result.created || result.row.status === "DUPLICATE",
      ),
    };
  } catch (error) {
    // A lost database commit acknowledgement can leave a committed OCR row. Keep
    // its private original on uncertain database failures; a later hash retry recovers it.
    cleanupAllowed =
      cleanupAllowed ||
      error instanceof HttpError ||
      (error instanceof Prisma.PrismaClientKnownRequestError &&
        ["P2002", "P2034", "P2025"].includes(error.code));
    throw error;
  } finally {
    if (stored && !storageCommitted && cleanupAllowed)
      await deletePrivateDocument(stored.storageKey).catch(() => undefined);
  }
}
