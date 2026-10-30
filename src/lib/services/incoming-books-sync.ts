import "server-only";
import { createHash } from "node:crypto";
import { Prisma, type BooksBill } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { IntegrationError } from "@/lib/integrations/config";
import {
  booksSnapshotFields,
  parseBooksBillDetail,
  parseBooksBillPage,
} from "./books-import";
import type {
  IncomingSyncInput,
  IncomingSyncResult,
} from "./incoming-sync-types";
import {
  assertIncomingBooksContext as assertContext,
  incomingBooksIdentity as identity,
} from "./incoming-books-context";
import {
  getBooksAttachmentSourceMetadata,
  importIncomingBooksBillAttachment,
} from "./books-attachments";
import { detectDocumentType } from "./documents";
import { HttpError } from "@/lib/http";

type Source = Prisma.InputJsonObject;
const id = z.string().regex(/^\d{1,30}$/);
const progressSchema = z
  .object({
    version: z.literal(1),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    runId: z.string().min(1).max(100),
    mode: z.enum(["incremental", "reconcile"]),
    startedAt: z.string().datetime(),
    modifiedAfter: z.string().nullable(),
    page: z.number().int().min(1).max(100_000),
    seenIds: z.array(id).max(200_000),
    completedRows: z.number().int().nonnegative(),
    pendingPage: z.array(z.record(z.string(), z.json())).max(200).nullable(),
    pendingIndex: z.number().int().min(0).max(200),
    sourceVerified: z.boolean().default(false),
    hasMore: z.boolean(),
    phase: z.enum(["LIST", "MISSING", "DONE"]),
    missingIds: z.array(id).max(200_000),
    missingIndex: z.number().int().nonnegative(),
  })
  .strict();
type Progress = z.infer<typeof progressSchema>;
const options = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  timeout: 30_000,
};
const blocked = (code: string, message: string) =>
  new IntegrationError(code, message, "BLOCKED");
const fingerprint = (input: IncomingSyncInput) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        input.source.target,
        input.source.companyId,
        input.source.organizationId,
        input.source.dataCenter,
        input.source.environment,
      ]),
    )
    .digest("hex");
const remoteIdentity = (input: IncomingSyncInput, externalBillId: string) => ({
  organizationId: input.source.organizationId,
  dataCenter: input.source.dataCenter,
  environment: input.source.environment,
  externalBillId,
});
const jsonProgress = (progress: Progress) =>
  progress as unknown as Prisma.InputJsonObject;

/** Books documents a modified-time filter but not modified-time sorting.
 * Always exhaust created_time-ordered pages; the overlap covers boundary ties.
 * https://www.zoho.com/books/api/v3/bills/#list-bills */
export function booksModifiedAfter(watermark: string): string {
  const time = Date.parse(watermark);
  if (!Number.isFinite(time))
    throw blocked(
      "INCOMING_BOOKS_WATERMARK_INVALID",
      "The Books cursor is invalid.",
    );
  return new Date(Math.max(0, time - 5 * 60_000))
    .toISOString()
    .replace(/\.\d{3}Z$/, "+0000");
}
const modifiedTime = (value: unknown) =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? Date.parse(value)
    : null;
const summaryKeys = [
  "bill_number",
  "vendor_id",
  "vendor_name",
  "status",
  "currency_code",
  "date",
  "due_date",
  "total",
  "balance",
  "has_attachment",
  "attachment_name",
  "reference_number",
] as const;
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
/** Volatile due_days display fields must not force thousands of daily detail GETs. */
export function booksBillNeedsDetail(
  existing: Pick<
    BooksBill,
    | "sourceSummary"
    | "sourceDetail"
    | "sourceModifiedAt"
    | "lastImportRunId"
    | "detailImportRunId"
    | "isStale"
  > | null,
  summary: Source,
): boolean {
  if (
    !existing ||
    existing.isStale ||
    existing.sourceDetail === null ||
    existing.detailImportRunId !== existing.lastImportRunId
  )
    return true;
  const before = modifiedTime(existing.sourceModifiedAt),
    after = modifiedTime(summary.last_modified_time);
  if (before !== null && after !== null && after < before) return false;
  if (before === null || after === null || before !== after) return true;
  const previous = object(existing.sourceSummary);
  return summaryKeys.some(
    (key) => JSON.stringify(previous[key]) !== JSON.stringify(summary[key]),
  );
}

async function assertRun(
  tx: Prisma.TransactionClient,
  input: IncomingSyncInput,
  progress: Progress,
) {
  await assertContext(tx, input);
  const run = await tx.booksImportRun.findFirst({
    where: {
      id: progress.runId,
      ...identity(input),
      initiatedById: input.actor.id,
    },
  });
  if (
    !run ||
    run.runKind !== (progress.mode === "reconcile" ? "FULL" : "INCREMENTAL")
  )
    throw blocked(
      "INCOMING_BOOKS_RUN_CHANGED",
      "The Books progress no longer matches its source run.",
    );
  const latest = await tx.booksImportRun.findFirst({
    where: identity(input),
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  if (latest?.id !== run.id)
    throw blocked(
      "INCOMING_BOOKS_SUPERSEDED",
      "A newer Books import superseded this refresh.",
    );
  if (!["RUNNING", "PARTIAL", "COMPLETE"].includes(run.status))
    throw blocked("INCOMING_BOOKS_RUN_CLOSED", "The Books refresh is closed.");
  return run;
}
async function start(input: IncomingSyncInput): Promise<Progress> {
  const mode = input.watermark ? input.mode : "reconcile";
  return db.$transaction(async (tx) => {
    await assertContext(tx, input);
    if (
      await tx.booksImportRun.findFirst({
        where: { ...identity(input), status: "RUNNING" },
        select: { id: true },
      })
    )
      throw blocked(
        "INCOMING_BOOKS_IMPORT_BUSY",
        "Another Books snapshot import is still running.",
      );
    const run = await tx.booksImportRun.create({
      data: {
        ...identity(input),
        organizationName: input.source.organizationName,
        initiatedById: input.actor.id,
        runKind: mode === "reconcile" ? "FULL" : "INCREMENTAL",
      },
    });
    await tx.auditLog.create({
      data: {
        actorId: input.actor.id,
        companyId: input.source.companyId!,
        action: "INCOMING_BOOKS_STARTED",
        entityType: "BooksImportRun",
        entityId: run.id,
        details: {
          organizationId: input.source.organizationId,
          mode,
          providerFinancialWrites: 0,
        },
      },
    });
    const progress: Progress = {
      version: 1,
      sourceHash: fingerprint(input),
      runId: run.id,
      mode,
      startedAt: run.startedAt.toISOString(),
      modifiedAfter:
        mode === "incremental" && input.watermark
          ? booksModifiedAfter(input.watermark)
          : null,
      page: 1,
      seenIds: [],
      completedRows: 0,
      pendingPage: null,
      pendingIndex: 0,
      sourceVerified: false,
      hasMore: true,
      phase: "LIST",
      missingIds: [],
      missingIndex: 0,
    };
    // Run creation and its resumable cursor must survive or roll back together.
    await input.checkpoint(jsonProgress(progress), tx);
    return progress;
  }, options);
}
async function existingBill(input: IncomingSyncInput, externalBillId: string) {
  const bill = await db.booksBill.findUnique({
    where: {
      organizationId_dataCenter_environment_externalBillId: remoteIdentity(
        input,
        externalBillId,
      ),
    },
  });
  if (bill && bill.companyId !== input.source.companyId)
    throw blocked(
      "INCOMING_BOOKS_COMPANY_CONFLICT",
      "This provider bill is already assigned to another company.",
    );
  return bill;
}
async function commitBill(
  input: IncomingSyncInput,
  progress: Progress,
  summary: Source,
  detail: Source | null,
) {
  const externalBillId = String(summary.bill_id);
  await db.$transaction(async (tx) => {
    const run = await assertRun(tx, input, progress);
    if (run.status === "COMPLETE")
      throw blocked(
        "INCOMING_BOOKS_RUN_CLOSED",
        "This Books refresh already completed.",
      );
    const current = await tx.booksBill.findUnique({
      where: {
        organizationId_dataCenter_environment_externalBillId: remoteIdentity(
          input,
          externalBillId,
        ),
      },
    });
    if (current && current.companyId !== input.source.companyId)
      throw blocked(
        "INCOMING_BOOKS_COMPANY_CONFLICT",
        "The Books bill company differs from its source.",
      );
    const oldTime = modifiedTime(current?.sourceModifiedAt),
      incomingTime = modifiedTime(
        detail?.last_modified_time ?? summary.last_modified_time,
      );
    const preserveNewer =
      current !== null &&
      oldTime !== null &&
      incomingTime !== null &&
      incomingTime < oldTime;
    if (!detail && (!current || booksBillNeedsDetail(current, summary)))
      throw blocked(
        "INCOMING_BOOKS_DETAIL_CHANGED",
        "The bill changed while its refresh was being committed.",
      );
    if (preserveNewer) {
      await tx.booksBill.update({
        where: { id: current.id },
        data: { lastSeenAt: new Date(), isStale: false },
      });
    } else if (detail) {
      const data = {
        ...booksSnapshotFields(detail, true),
        companyId: input.source.companyId!,
        organizationName: input.source.organizationName,
        sourceSummary: summary,
        sourceDetail: detail,
        lastImportRunId: run.id,
        detailImportRunId: run.id,
        detailFetchedAt: new Date(),
        lastSeenAt: new Date(),
        isStale: false,
      };
      await tx.booksBill.upsert({
        where: {
          organizationId_dataCenter_environment_externalBillId: remoteIdentity(
            input,
            externalBillId,
          ),
        },
        create: { ...remoteIdentity(input, externalBillId), ...data },
        update: data,
      });
    } else {
      await tx.booksBill.update({
        where: { id: current!.id },
        data: {
          sourceSummary: summary,
          lastImportRunId: run.id,
          detailImportRunId: run.id,
          lastSeenAt: new Date(),
          isStale: false,
        },
      });
    }
    await tx.booksImportRun.update({
      where: { id: run.id },
      data: {
        listedCount: progress.seenIds.length,
        detailCount: progress.completedRows + 1,
        lastPage: progress.page,
        status: "RUNNING",
        completedAt: null,
        lastErrorCode: null,
      },
    });
  }, options);
}
function notFound(error: unknown): boolean {
  return (
    error instanceof IntegrationError &&
    error.code === "INCOMING_REMOTE_NOT_FOUND"
  );
}

/** GET-only ingestion. No Bill, Payment, Job or outbound queue mutations occur. */
export async function runIncomingBooksSync(
  input: IncomingSyncInput,
): Promise<IncomingSyncResult> {
  if (
    input.source.target !== "ZOHO" ||
    !input.source.companyId ||
    !id.safeParse(input.source.organizationId).success ||
    !["sandbox", "production"].includes(input.source.environment) ||
    !Number.isInteger(input.maxRequests) ||
    input.maxRequests < 1
  )
    throw blocked(
      "INCOMING_BOOKS_SOURCE_INVALID",
      "The incoming Books source or request budget is invalid.",
    );
  if (input.watermark !== null) booksModifiedAfter(input.watermark);
  let progress =
    input.continuation == null
      ? null
      : progressSchema.parse(input.continuation);
  if (
    progress &&
    (progress.sourceHash !== fingerprint(input) ||
      progress.pendingIndex > (progress.pendingPage?.length ?? 0) ||
      progress.missingIndex > progress.missingIds.length ||
      new Set(progress.seenIds).size !== progress.seenIds.length)
  )
    throw blocked(
      "INCOMING_BOOKS_CHECKPOINT_INVALID",
      "Books progress belongs to a different source or has invalid pagination.",
    );
  let requests = 0,
    processed = 0;
  const get = async (path: string, query?: Record<string, string>) => {
    requests++;
    return input.get(path, query);
  };
  const pause = async (): Promise<IncomingSyncResult> => {
    if (progress) await input.checkpoint(jsonProgress(progress));
    return {
      complete: false,
      continuation: progress ? jsonProgress(progress) : null,
      processed,
    };
  };
  if (input.stopped()) return pause();
  try {
    if (!progress) {
      progress = await start(input);
    }
    const run = await db.$transaction(
      (tx) => assertRun(tx, input, progress!),
      options,
    );
    if (run.status === "COMPLETE")
      return {
        complete: true,
        continuation: null,
        watermark: progress.startedAt,
        reconciled: progress.mode === "reconcile",
        processed,
      };
    if (!progress.sourceVerified) {
      if (input.stopped() || requests >= input.maxRequests) return pause();
      const proof = z
        .object({
          code: z.literal(0),
          organization: z.object({ organization_id: id }),
        })
        .safeParse(
          await get(`/books/v3/organizations/${input.source.organizationId}`),
        );
      if (
        !proof.success ||
        proof.data.organization.organization_id !== input.source.organizationId
      )
        throw blocked(
          "INCOMING_BOOKS_ORGANIZATION_MISMATCH",
          "Books did not confirm the exact configured source organization.",
        );
      progress.sourceVerified = true;
      await input.checkpoint(jsonProgress(progress));
    }
    while (progress.phase === "LIST") {
      if (input.stopped()) return pause();
      if (!progress.pendingPage) {
        if (requests >= input.maxRequests) return pause();
        const response = await get("/books/v3/bills", {
          page: String(progress.page),
          per_page: "200",
          filter_by: "Status.All",
          sort_column: "created_time",
          sort_order: "A",
          ...(progress.modifiedAfter
            ? { last_modified_time: progress.modifiedAfter }
            : {}),
        });
        const page = parseBooksBillPage(response, progress.page);
        const seen = new Set(progress.seenIds);
        if (page.bills.some((bill) => seen.has(String(bill.bill_id))))
          throw blocked(
            "INCOMING_BOOKS_DUPLICATE_PAGE",
            "Books repeated a bill across pages; reconciliation was not applied.",
          );
        progress.pendingPage = page.bills as z.infer<
          typeof progressSchema
        >["pendingPage"];
        progress.pendingIndex = 0;
        progress.hasMore = page.hasMore;
        progress.seenIds.push(
          ...page.bills.map((bill) => String(bill.bill_id)),
        );
        if (progress.seenIds.length > 200_000)
          throw blocked(
            "INCOMING_BOOKS_SCAN_LIMIT",
            "The Books refresh exceeded its safe inventory limit.",
          );
        await input.checkpoint(jsonProgress(progress));
      }
      while (progress.pendingIndex < progress.pendingPage!.length) {
        if (input.stopped()) return pause();
        const summary = progress.pendingPage![progress.pendingIndex] as Source,
          externalBillId = String(summary.bill_id);
        const current = await existingBill(input, externalBillId);
        let detail: Source | null = null;
        if (booksBillNeedsDetail(current, summary)) {
          if (requests >= input.maxRequests) return pause();
          try {
            detail = parseBooksBillDetail(
              await get(`/books/v3/bills/${externalBillId}`),
              externalBillId,
            );
          } catch (error) {
            if (!notFound(error)) throw error;
            // It can be deleted between the list and exact detail requests.
            // Only a verified not-found result is evidence of disappearance.
            await db.$transaction(async (tx) => {
              await assertRun(tx, input, progress!);
              await tx.booksBill.updateMany({
                where: { ...identity(input), externalBillId },
                data: { isStale: true },
              });
              await tx.booksImportRun.update({
                where: { id: progress!.runId },
                data: {
                  listedCount: progress!.seenIds.length - 1,
                  detailCount: progress!.completedRows,
                },
              });
            }, options);
            progress.seenIds = progress.seenIds.filter(
              (value) => value !== externalBillId,
            );
            progress.pendingIndex++;
            processed++;
            await input.checkpoint(jsonProgress(progress));
            continue;
          }
        }
        await commitBill(input, progress, summary, detail);
        progress.pendingIndex++;
        progress.completedRows++;
        processed++;
        await input.checkpoint(jsonProgress(progress));
      }
      progress.pendingPage = null;
      progress.pendingIndex = 0;
      if (progress.hasMore) progress.page++;
      else {
        progress.phase = progress.mode === "reconcile" ? "MISSING" : "DONE";
        if (progress.phase === "MISSING") {
          const candidates = await db.booksBill.findMany({
            where: { ...identity(input), isStale: false },
            select: { externalBillId: true },
            take: 200_001,
          });
          if (candidates.length > 200_000)
            throw blocked(
              "INCOMING_BOOKS_SCAN_LIMIT",
              "The Books inventory exceeded its safe reconciliation limit.",
            );
          const seen = new Set(progress.seenIds);
          progress.missingIds = candidates
            .map((bill) => bill.externalBillId)
            .filter((id) => !seen.has(id));
        }
      }
      await input.checkpoint(jsonProgress(progress));
    }
    while (
      progress.phase === "MISSING" &&
      progress.missingIndex < progress.missingIds.length
    ) {
      if (input.stopped() || requests >= input.maxRequests) return pause();
      const externalBillId = progress.missingIds[progress.missingIndex];
      let detail: Source | null = null;
      try {
        detail = parseBooksBillDetail(
          await get(`/books/v3/bills/${externalBillId}`),
          externalBillId,
        );
      } catch (error) {
        if (!notFound(error)) throw error;
        await db.$transaction(async (tx) => {
          await assertRun(tx, input, progress!);
          await tx.booksBill.updateMany({
            where: { ...identity(input), externalBillId },
            data: { isStale: true },
          });
        }, options);
      }
      if (detail) {
        await commitBill(
          input,
          { ...progress, seenIds: [...progress.seenIds, externalBillId] },
          detail,
          detail,
        );
        progress.seenIds.push(externalBillId);
        progress.completedRows++;
        processed++;
      }
      progress.missingIndex++;
      await input.checkpoint(jsonProgress(progress));
    }
    progress.phase = "DONE";
    await db.$transaction(async (tx) => {
      await assertRun(tx, input, progress!);
      await tx.booksImportRun.update({
        where: { id: progress!.runId },
        data: {
          listingComplete: true,
          listedCount: progress!.seenIds.length,
          detailCount: progress!.completedRows,
          status: "COMPLETE",
          completedAt: new Date(),
          lastErrorCode: null,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: input.actor.id,
          companyId: input.source.companyId!,
          action: "INCOMING_BOOKS_COMPLETED",
          entityType: "BooksImportRun",
          entityId: progress!.runId,
          details: {
            organizationId: input.source.organizationId,
            mode: progress!.mode,
            seen: progress!.seenIds.length,
            providerFinancialWrites: 0,
          },
        },
      });
    }, options);
    return {
      complete: true,
      continuation: null,
      watermark: progress.startedAt,
      reconciled: progress.mode === "reconcile",
      processed,
    };
  } catch (error) {
    if (progress) {
      if (
        error instanceof IntegrationError &&
        error.code === "INCOMING_BOOKS_DUPLICATE_PAGE"
      ) {
        // Restart an unstable listing with the same conservative watermark.
        // Previously committed good snapshots remain usable throughout.
        progress.page = 1;
        progress.seenIds = [];
        progress.completedRows = 0;
        progress.pendingPage = null;
        progress.pendingIndex = 0;
        progress.hasMore = true;
        progress.phase = "LIST";
        progress.missingIds = [];
        progress.missingIndex = 0;
      }
      // Persist progress before marking partial; a failed GET must never replace
      // the existing good detail or advance the successful watermark.
      await input.checkpoint(jsonProgress(progress)).catch(() => undefined);
      await db
        .$transaction(async (tx) => {
          const run = await assertRun(tx, input, progress!);
          if (run.status !== "COMPLETE")
            await tx.booksImportRun.update({
              where: { id: run.id },
              data: {
                status: "PARTIAL",
                completedAt: new Date(),
                lastErrorCode:
                  error instanceof IntegrationError
                    ? error.code.slice(0, 100)
                    : "INCOMING_BOOKS_REFRESH_FAILED",
              },
            });
        }, options)
        .catch(() => undefined);
    }
    throw error;
  }
}

/** Called only after the worker commits metadata success. This pass never reads
 * or writes the metadata checkpoint, watermark, or provider accounting data. */
export async function syncIncomingBooksAttachments(input: IncomingSyncInput) {
  if (
    !input.getBytes ||
    !Number.isInteger(input.maxRequests) ||
    input.maxRequests < 1
  )
    throw blocked(
      "INCOMING_BOOKS_ATTACHMENT_CONFIG",
      "A bounded GET-only original downloader is required.",
    );
  await db.$transaction((tx) => assertContext(tx, input), options);
  const metadata = Prisma.sql`JSON_EXTRACT(b.sourceDetail, CONCAT('$.documents[', d.position - 1, ']'))`;
  const pendingScope = Prisma.sql`
    FROM BooksBill b
    JOIN JSON_TABLE(b.sourceDetail, '$.documents[*]' COLUMNS (
      position FOR ORDINALITY,
      documentId VARCHAR(100) PATH '$.document_id' NULL ON EMPTY NULL ON ERROR
    )) d
    LEFT JOIN BooksBillAttachment a ON a.billId = b.id AND a.externalDocumentId = d.documentId
    WHERE b.companyId = ${input.source.companyId} AND b.organizationId = ${input.source.organizationId}
      AND b.dataCenter = ${input.source.dataCenter} AND b.environment = ${input.source.environment}
      AND b.isStale = 0 AND b.detailImportRunId = b.lastImportRunId
      AND (a.id IS NULL OR CAST(a.sourceMetadata AS CHAR) <> CAST(${metadata} AS CHAR))`;
  const work = await db.$queryRaw<
    { billId: string; externalBillId: string; documentId: string | null }[]
  >(Prisma.sql`
    SELECT b.id AS billId, b.externalBillId, d.documentId ${pendingScope}
    ORDER BY b.detailFetchedAt DESC, b.id, d.position LIMIT ${input.maxRequests * 4}`);
  let processed = 0,
    failed = 0,
    requests = 0;
  for (const item of work) {
    if (input.stopped() || requests >= input.maxRequests) break;
    try {
      if (!item.documentId || !id.safeParse(item.documentId).success)
        throw new HttpError(422, "The source document identity is invalid.");
      const bill = await db.$transaction(async (tx) => {
        await assertContext(tx, input);
        const bill = await tx.booksBill.findFirst({
          where: { id: item.billId, ...identity(input), isStale: false },
        });
        if (!bill || bill.externalBillId !== item.externalBillId)
          throw blocked(
            "INCOMING_BOOKS_SOURCE_CHANGED",
            "The original attachment source changed.",
          );
        return bill;
      }, options);
      const source = getBooksAttachmentSourceMetadata(bill, item.documentId);
      requests++;
      const bytes = await input.getBytes(
        `/books/v3/bills/${item.externalBillId}/documents/${item.documentId}`,
      );
      const mimeType = detectDocumentType(Buffer.from(bytes)).mimeType;
      await importIncomingBooksBillAttachment(input, {
        billId: bill.id,
        organizationId: bill.organizationId,
        externalDocumentId: item.documentId,
        expectedSourceMetadataHash: source.sourceMetadataHash,
        file: new File([new Uint8Array(bytes)], source.fileName, {
          type: mimeType,
        }),
      });
      processed++;
    } catch (error) {
      // Local unsupported/mutated metadata is a per-document issue. Provider
      // errors, quota responses and lease failures stop this batch immediately.
      if (
        !(error instanceof HttpError) ||
        ![409, 415, 422].includes(error.status)
      )
        throw error;
      failed++;
    }
  }
  await db.$transaction((tx) => assertContext(tx, input), options);
  const counts = await db.$queryRaw<{ pending: bigint | number }[]>(
    Prisma.sql`SELECT COUNT(*) AS pending ${pendingScope}`,
  );
  return { processed, pending: Number(counts[0]?.pending ?? 0), failed };
}
