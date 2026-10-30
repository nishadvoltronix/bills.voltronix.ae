import "server-only";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Prisma } from "@prisma/client";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import { canCreateBill } from "@/lib/permissions";
import { assertBillAccess } from "@/lib/services/bills";

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

function within(directory: string, root: string) {
  const relative = path.relative(root, directory);
  return (
    !relative ||
    (!relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative) &&
      relative !== "..")
  );
}

async function storageDirectory(ensureExists = false): Promise<string> {
  // These paths are runtime private storage, never build inputs. Prevent the bundler
  // from tracing workspace secrets or uploaded invoices into a deployment artifact.
  const directory = path.resolve(
    /* turbopackIgnore: true */ process.env.UPLOAD_DIR || ".local/uploads",
  );
  const publicRoots = [path.resolve("public"), path.resolve(".next")];
  if (publicRoots.some((root) => within(directory, root)))
    throw new HttpError(
      503,
      "Private document storage is not configured correctly.",
    );
  if (ensureExists)
    await mkdir(/* turbopackIgnore: true */ directory, {
      recursive: true,
      mode: 0o700,
    });
  const physicalDirectory = await realpath(
    /* turbopackIgnore: true */ directory,
  );
  const physicalRoots = await Promise.all(
    publicRoots.map(async (root) =>
      realpath(/* turbopackIgnore: true */ root).catch(() => root),
    ),
  );
  if (physicalRoots.some((root) => within(physicalDirectory, root)))
    throw new HttpError(
      503,
      "Private document storage must not resolve to a public application directory.",
    );
  return physicalDirectory;
}

export function detectDocumentType(bytes: Buffer): {
  extension: string;
  mimeType: string;
} {
  if (bytes.subarray(0, 5).toString("ascii") === "%PDF-")
    return { extension: "pdf", mimeType: "application/pdf" };
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return { extension: "png", mimeType: "image/png" };
  if (
    bytes.length >= 3 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255
  )
    return { extension: "jpg", mimeType: "image/jpeg" };
  throw new HttpError(
    415,
    "Only PDF, PNG and JPEG invoice documents are supported.",
  );
}

export interface PrivateDocumentMetadata {
  storageKey: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
}

function validateStorageKey(storageKey: string) {
  if (!/^[a-f0-9-]{36}\.(pdf|png|jpg)$/.test(storageKey))
    throw new HttpError(404, "Document not found.");
}

/** Server-only primitive: callers must authorize the owning bill/OCR record first. */
export async function storePrivateDocument(
  file: File,
): Promise<PrivateDocumentMetadata> {
  if (file.size < 8 || file.size > MAX_DOCUMENT_BYTES)
    throw new HttpError(413, "Choose a document between 8 bytes and 10 MB.");
  const bytes = Buffer.from(await file.arrayBuffer());
  const detected = detectDocumentType(bytes);
  if (file.type && file.type !== detected.mimeType)
    throw new HttpError(
      415,
      "The file content does not match its declared file type.",
    );
  const storageKey = `${randomUUID()}.${detected.extension}`;
  const directory = await storageDirectory(true);
  const destination = path.join(
    /* turbopackIgnore: true */ directory,
    storageKey,
  );
  const originalName =
    path
      .basename(file.name.replace(/\\/g, "/"))
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .slice(0, 180) || `invoice.${detected.extension}`;
  // A verified PDF must not download with a user-supplied .html/.exe extension.
  const stem =
    path
      .basename(originalName, path.extname(originalName))
      .replace(/[. ]+$/g, "")
      .slice(0, 170) || "invoice";
  const fileName = `${stem}.${detected.extension}`;
  await writeFile(/* turbopackIgnore: true */ destination, bytes, {
    flag: "wx",
    mode: 0o600,
  });
  return {
    storageKey,
    fileName,
    mimeType: detected.mimeType,
    byteSize: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/** Reads only a previously stored key, checks file type/size and SHA-256 integrity. Not a malware scan. */
export async function readPrivateDocument(metadata: {
  storageKey: string;
  sha256: string;
  byteSize?: number;
}): Promise<Buffer> {
  validateStorageKey(metadata.storageKey);
  const directory = await storageDirectory();
  const filename = path.join(
    /* turbopackIgnore: true */ directory,
    metadata.storageKey,
  );
  let bytes: Buffer;
  try {
    const stat = await lstat(/* turbopackIgnore: true */ filename);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > MAX_DOCUMENT_BYTES ||
      stat.size < 8
    )
      throw new Error("Invalid private file");
    const physicalFile = await realpath(/* turbopackIgnore: true */ filename);
    if (!within(physicalFile, directory))
      throw new Error("Invalid private path");
    bytes = await readFile(/* turbopackIgnore: true */ physicalFile);
  } catch {
    throw new HttpError(
      404,
      "The stored document is unavailable. Contact an administrator.",
    );
  }
  if (
    (metadata.byteSize !== undefined &&
      metadata.byteSize !== bytes.byteLength) ||
    createHash("sha256").update(bytes).digest("hex") !== metadata.sha256
  )
    throw new HttpError(
      409,
      "The document integrity check failed. Contact an administrator.",
    );
  detectDocumentType(bytes);
  return bytes;
}

/** Only for compensating an uncommitted upload; never delete committed financial documents on sync failure. */
export async function deletePrivateDocument(storageKey: string): Promise<void> {
  validateStorageKey(storageKey);
  const filename = path.join(
    /* turbopackIgnore: true */ await storageDirectory(),
    storageKey,
  );
  await unlink(/* turbopackIgnore: true */ filename);
}

export async function readUpload(request: Request): Promise<File> {
  if (!request.headers.get("content-type")?.startsWith("multipart/form-data;"))
    throw new HttpError(415, "Upload a file using multipart/form-data.");
  const maximum = MAX_DOCUMENT_BYTES + 64 * 1024;
  if (Number(request.headers.get("content-length") ?? 0) > maximum)
    throw new HttpError(413, "Invoice documents must be 10 MB or smaller.");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "Choose an invoice document.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    length += item.value.byteLength;
    if (length > maximum) {
      await reader.cancel();
      throw new HttpError(413, "Invoice documents must be 10 MB or smaller.");
    }
    chunks.push(item.value);
  }
  let form: FormData;
  try {
    form = await new Response(Buffer.concat(chunks), {
      headers: { "content-type": request.headers.get("content-type")! },
    }).formData();
  } catch {
    throw new HttpError(400, "The file upload is invalid.");
  }
  const files = form.getAll("file");
  if (files.length !== 1 || !(files[0] instanceof File))
    throw new HttpError(422, "Choose one invoice document.");
  return files[0];
}

export async function attachDocument(
  actor: Actor,
  billId: string,
  file: File,
  expectedVersion?: number,
) {
  if (!canCreateBill(actor))
    throw new HttpError(403, "Your role cannot upload invoice documents.");
  const existing = await db.bill.findUnique({ where: { id: billId } });
  if (!existing) throw new HttpError(404, "Bill not found.");
  await assertBillAccess(actor, existing);
  if (!["DRAFT", "REJECTED", "PENDING_APPROVAL"].includes(existing.status))
    throw new HttpError(
      409,
      "Documents cannot be changed after final save or cancellation.",
    );
  const requestedVersion = expectedVersion ?? existing.version;
  if (
    !Number.isSafeInteger(requestedVersion) ||
    requestedVersion < 1 ||
    (existing.version !== requestedVersion &&
      existing.version !== requestedVersion + 1)
  )
    throw new HttpError(
      409,
      "The bill changed before upload. Review the saved bill before continuing.",
    );
  const stored = await storePrivateDocument(file);
  try {
    const duplicate = await db.document.findFirst({
      where: { billId, sha256: stored.sha256 },
      select: {
        id: true,
        fileName: true,
        mimeType: true,
        byteSize: true,
        createdAt: true,
      },
    });
    if (duplicate) {
      if (existing.version !== requestedVersion) {
        const originalUpload = await db.auditLog.findFirst({
          where: {
            entityType: "Bill",
            entityId: billId,
            actorId: actor.id,
            action: "DOCUMENT_ATTACHED",
            AND: [
              { details: { path: "$.documentId", equals: duplicate.id } },
              {
                details: {
                  path: "$.previousVersion",
                  equals: requestedVersion,
                },
              },
              { details: { path: "$.billVersion", equals: existing.version } },
            ],
          },
          select: { id: true },
        });
        if (!originalUpload)
          throw new HttpError(
            409,
            "The bill changed before upload recovery. Review it before continuing.",
          );
      }
      await deletePrivateDocument(stored.storageKey);
      return {
        ...duplicate,
        billVersion: existing.version,
        alreadyAttached: true,
      };
    }
    if (existing.version !== requestedVersion)
      throw new HttpError(
        409,
        "The bill changed before upload. Review it before continuing.",
      );
    return await db.$transaction(
      async (tx) => {
        await assertBillAccess(actor, existing, tx);
        const changed = await tx.bill.updateMany({
          where: {
            id: billId,
            version: existing.version,
            status: { in: ["DRAFT", "REJECTED", "PENDING_APPROVAL"] },
          },
          data: { version: { increment: 1 } },
        });
        if (changed.count !== 1)
          throw new HttpError(
            409,
            "The bill changed during upload. Refresh and try again.",
          );
        const saved = await tx.document.create({
          data: {
            billId,
            ...stored,
            uploadedById: actor.id,
          },
          select: {
            id: true,
            fileName: true,
            mimeType: true,
            byteSize: true,
            createdAt: true,
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: actor.id,
            companyId: existing.companyId,
            action: "DOCUMENT_ATTACHED",
            entityType: "Bill",
            entityId: billId,
            details: {
              documentId: saved.id,
              fileName: stored.fileName,
              byteSize: stored.byteSize,
              sha256: stored.sha256,
              previousVersion: existing.version,
              billVersion: existing.version + 1,
            },
          },
        });
        return {
          ...saved,
          billVersion: existing.version + 1,
          alreadyAttached: false,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    await deletePrivateDocument(stored.storageKey).catch(() => undefined);
    throw error;
  }
}

export async function downloadDocument(actor: Actor, documentId: string) {
  const assertCurrentReader = async () => {
    const current = await db.user.findUnique({
      where: { id: actor.id },
      select: { active: true, role: true },
    });
    if (!current?.active || current.role !== actor.role)
      throw new HttpError(403, "Your access changed. Sign in again.");
  };
  await assertCurrentReader();
  const document = await db.document.findUnique({
    where: { id: documentId },
    include: { bill: { select: { createdById: true, companyId: true } } },
  });
  if (!document) throw new HttpError(404, "Document not found.");
  await assertBillAccess(actor, document.bill);
  const bytes = await readPrivateDocument(document);
  if (detectDocumentType(bytes).mimeType !== document.mimeType)
    throw new HttpError(
      409,
      "The stored document type does not match its metadata.",
    );
  const latest = await db.document.findUnique({
    where: { id: documentId },
    include: { bill: { select: { createdById: true, companyId: true } } },
  });
  if (!latest) throw new HttpError(404, "Document not found.");
  const immutableFields = [
    "billId",
    "storageKey",
    "sha256",
    "byteSize",
    "mimeType",
    "fileName",
  ] as const;
  if (immutableFields.some((field) => latest[field] !== document[field]))
    throw new HttpError(
      409,
      "The document changed during download. Reload the page.",
    );
  await assertCurrentReader();
  await assertBillAccess(actor, latest.bill);
  return { bytes, fileName: latest.fileName, mimeType: latest.mimeType };
}
