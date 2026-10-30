import "server-only";
import { createHash } from "node:crypto";
import { Prisma, type BooksBill, type BooksImportRun } from "@prisma/client";
import Decimal from "decimal.js";
import { z } from "zod";
import type { Actor } from "@/lib/auth";
import { companyFilter, requireCompanyAccess } from "@/lib/company";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import { IntegrationError } from "@/lib/integrations/config";
import { assertBooksImportContext as importContext, assertBooksBillReader as assertReader } from "@/lib/services/books-import-access";
import { describeBooksAttachments } from "@/lib/services/books-attachments";

const externalId = z.string().regex(/^\d{1,30}$/);
const text = (limit: number) => z.string().max(limit);
const money = z.union([z.number().finite(), z.string().max(100).regex(/^-?\d+(?:\.\d+)?$/)]);
const sourceDate = z.string().refine((value) => value === "" ||
  /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) &&
  new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value);
const rowSchema = z.object({
  bill_id: externalId, vendor_id: externalId, bill_number: text(500), vendor_name: text(500),
  status: text(100).min(1), currency_code: z.string().regex(/^[A-Z]{3}$/),
  date: sourceDate, due_date: sourceDate.optional(), total: money, balance: money,
  last_modified_time: text(60).optional(),
}).loose();
const detailSchema = rowSchema.extend({
  sub_total: money, tax_total: money, line_items: z.array(z.record(z.string(), z.json())),
  payment_made: money.optional(), vendor_credits_applied: money.optional(),
  payments: z.array(z.record(z.string(), z.json())).optional(),
  vendor_credits: z.array(z.record(z.string(), z.json())).optional(),
  documents: z.array(z.record(z.string(), z.json())).optional(),
});
const invalid = (code: string, message: string) => new IntegrationError(code, message, "BLOCKED");
type Source = Prisma.InputJsonObject;
type Store = Prisma.TransactionClient;

function jsonSource(value: unknown): Source {
  if (!value || typeof value !== "object" || Array.isArray(value) || !z.json().safeParse(value).success)
    throw invalid("BOOKS_SNAPSHOT_INVALID", "The Books snapshot is not a valid JSON object.");
  return value as Source;
}

/** Validate identity and pagination without discarding any original provider fields. */
export function parseBooksBillPage(value: unknown, expectedPage: number) {
  const parsed = z.object({ code: z.literal(0), bills: z.array(rowSchema).max(200),
    page_context: z.object({ page: z.number().int().positive(), has_more_page: z.boolean() }),
  }).safeParse(value);
  if (!parsed.success || parsed.data.page_context.page !== expectedPage ||
    new Set(parsed.data.bills.map((bill) => bill.bill_id)).size !== parsed.data.bills.length ||
    (parsed.data.page_context.has_more_page && parsed.data.bills.length === 0))
    throw invalid("BOOKS_BILL_PAGE_INVALID", "Books returned invalid, duplicate or incomplete bill pagination.");
  const source = jsonSource(value);
  return { bills: source.bills as Source[], hasMore: parsed.data.page_context.has_more_page };
}

export function parseBooksBillDetail(value: unknown, expectedBillId: string): Source {
  const parsed = z.object({ code: z.literal(0), bill: detailSchema }).safeParse(value);
  if (!parsed.success || parsed.data.bill.bill_id !== expectedBillId)
    throw invalid("BOOKS_BILL_DETAIL_INVALID", "Books returned an incomplete bill or a different bill identity.");
  return jsonSource((value as { bill: unknown }).bill);
}

function decimalText(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = money.safeParse(value);
  if (!parsed.success) throw invalid("BOOKS_AMOUNT_INVALID", "A Books amount was not a valid decimal.");
  const result = typeof parsed.data === "string" ? parsed.data : new Decimal(String(parsed.data)).toFixed();
  if (result.length > 100) throw invalid("BOOKS_AMOUNT_INVALID", "A Books amount exceeded the supported snapshot length.");
  return result;
}

function sourceFields(source: Source, detailed: boolean) {
  const validated = (detailed ? detailSchema : rowSchema).safeParse(source);
  if (!validated.success) throw invalid("BOOKS_SNAPSHOT_INVALID", "The Books bill snapshot was incomplete.");
  const row = validated.data;
  return {
    billNumber: row.bill_number, vendorId: row.vendor_id, vendorName: row.vendor_name,
    status: row.status, currencyCode: row.currency_code,
    billDate: row.date ? new Date(`${row.date}T00:00:00.000Z`) : null,
    dueDate: row.due_date ? new Date(`${row.due_date}T00:00:00.000Z`) : null,
    total: decimalText(row.total)!, balance: decimalText(row.balance)!,
    subtotal: detailed ? decimalText(source.sub_total) : null,
    taxTotal: detailed ? decimalText(source.tax_total) : null,
    paymentMade: detailed ? decimalText(source.payment_made) : null,
    vendorCreditsApplied: detailed ? decimalText(source.vendor_credits_applied) : null,
    sourceModifiedAt: row.last_modified_time || null,
  };
}
// Shared pure projection for the separately authorized incoming GET-only worker.
export { sourceFields as booksSnapshotFields };

async function writableRun(store: Store, actor: Actor, runId: string) {
  const run = await store.booksImportRun.findUnique({ where: { id: runId } });
  if (!run) throw new HttpError(404, "Books import not found.");
  const destination = await importContext(store, actor, run.companyId, run.organizationId);
  if (run.dataCenter !== destination.dataCenter || run.environment !== destination.environment)
    throw invalid("BOOKS_IMPORT_DESTINATION_CHANGED", "The Books source changed since this import started.");
  if (!["RUNNING", "PARTIAL"].includes(run.status))
    throw invalid("BOOKS_IMPORT_CLOSED", "Start a new import to refresh a completed or failed snapshot.");
  const latest = await store.booksImportRun.findFirst({ where: destination, orderBy: [{ startedAt: "desc" }, { id: "desc" }] });
  if (latest?.id !== run.id) throw invalid("BOOKS_IMPORT_SUPERSEDED", "A newer Books import exists. Resume the latest import.");
  return run;
}

const transactionOptions = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 60_000 };
const beginSchema = z.object({ companyId: z.string().min(1).max(100), organizationId: externalId,
  organizationName: z.string().min(1).max(200) }).strict();

/** Local writes only: this service does not contain a provider transport or enqueue operation. */
export async function beginBooksBillImport(actor: Actor, payload: unknown) {
  const input = beginSchema.parse(payload);
  return db.$transaction(async (tx) => {
    const destination = await importContext(tx, actor, input.companyId, input.organizationId);
    if (await tx.booksImportRun.findFirst({ where: { ...destination, status: "RUNNING" } }))
      throw invalid("BOOKS_IMPORT_ALREADY_RUNNING", "Resume or finish the current Books import before starting another.");
    const run = await tx.booksImportRun.create({ data: { ...destination, organizationName: input.organizationName, initiatedById: actor.id } });
    await tx.auditLog.create({ data: { actorId: actor.id, companyId: run.companyId, action: "BOOKS_SNAPSHOT_IMPORT_STARTED",
      entityType: "BooksImportRun", entityId: run.id, details: { organizationId: run.organizationId, providerFinancialWrites: 0 } } });
    return run;
  }, transactionOptions);
}

function snapshotTime(value?: Date | string) {
  const result = value === undefined ? new Date() : new Date(value);
  if (Number.isNaN(result.valueOf()) || result.valueOf() > Date.now() + 300_000)
    throw invalid("BOOKS_SNAPSHOT_TIME_INVALID", "The Books snapshot time is invalid.");
  return result;
}

export async function importBooksBillSummaryPage(actor: Actor, runId: string,
  input: { response: unknown; page: number; fetchedAt?: Date | string }) {
  if (!Number.isInteger(input.page) || input.page < 1 || input.page > 100_000)
    throw invalid("BOOKS_BILL_PAGE_INVALID", "The Books page number is invalid.");
  const parsed = parseBooksBillPage(input.response, input.page);
  const fetchedAt = snapshotTime(input.fetchedAt);
  const pageHash = createHash("sha256").update(JSON.stringify(input.response)).digest("hex");
  return db.$transaction(async (tx) => {
    const run = await writableRun(tx, actor, runId);
    if (input.page === run.lastPage && run.lastPageHash === pageHash) return run;
    if (run.listingComplete || input.page !== run.lastPage + 1)
      throw invalid("BOOKS_IMPORT_PAGE_ORDER", "Import consecutive Books pages, beginning with page one.");
    const ids = parsed.bills.map((bill) => String(bill.bill_id));
    const existing = await tx.booksBill.findMany({ where: { organizationId: run.organizationId, dataCenter: run.dataCenter,
      environment: run.environment, externalBillId: { in: ids } }, select: { companyId: true, lastImportRunId: true } });
    if (existing.some((bill) => bill.companyId !== run.companyId || bill.lastImportRunId === run.id))
      throw invalid("BOOKS_IMPORT_DUPLICATE_BILL", "Books repeated a bill across pages or its local company assignment differs.");
    for (const source of parsed.bills) {
      const identity = { organizationId: run.organizationId, dataCenter: run.dataCenter, environment: run.environment,
        externalBillId: String(source.bill_id) };
      const data = { ...sourceFields(source, false), companyId: run.companyId, organizationName: run.organizationName,
        sourceSummary: source, lastImportRunId: run.id, lastSeenAt: fetchedAt, isStale: false };
      await tx.booksBill.upsert({ where: { organizationId_dataCenter_environment_externalBillId: identity },
        create: { ...identity, ...data }, update: data });
    }
    return tx.booksImportRun.update({ where: { id: run.id }, data: { lastPage: input.page, lastPageHash: pageHash,
      listedCount: { increment: parsed.bills.length }, listingComplete: !parsed.hasMore, status: "RUNNING", completedAt: null, lastErrorCode: null } });
  }, transactionOptions);
}

export async function importBooksBillDetail(actor: Actor, runId: string,
  input: { response: unknown; externalBillId: string; fetchedAt?: Date | string }) {
  externalId.parse(input.externalBillId);
  const source = parseBooksBillDetail(input.response, input.externalBillId);
  const fetchedAt = snapshotTime(input.fetchedAt);
  return db.$transaction(async (tx) => {
    const run = await writableRun(tx, actor, runId);
    const bill = await tx.booksBill.findUnique({ where: { organizationId_dataCenter_environment_externalBillId: {
      organizationId: run.organizationId, dataCenter: run.dataCenter, environment: run.environment, externalBillId: input.externalBillId,
    } } });
    if (!bill || bill.companyId !== run.companyId || bill.lastImportRunId !== run.id)
      throw invalid("BOOKS_BILL_NOT_LISTED", "Import this bill's listing in the current run before its detail.");
    if (bill.detailImportRunId === run.id && bill.detailFetchedAt && fetchedAt < bill.detailFetchedAt)
      throw invalid("BOOKS_DETAIL_OLDER", "An older detail cannot replace a newer Books snapshot.");
    await tx.booksBill.update({ where: { id: bill.id }, data: { ...sourceFields(source, true), sourceDetail: source,
      detailImportRunId: run.id, detailFetchedAt: fetchedAt, lastSeenAt: fetchedAt > bill.lastSeenAt ? fetchedAt : bill.lastSeenAt } });
    return tx.booksImportRun.update({ where: { id: run.id }, data: { detailCount: { increment: bill.detailImportRunId === run.id ? 0 : 1 },
      status: "RUNNING", completedAt: null, lastErrorCode: null } });
  }, transactionOptions);
}

export async function finishBooksBillImport(actor: Actor, runId: string, input: { lastErrorCode?: string } = {}) {
  const errorCode = input.lastErrorCode === undefined ? undefined : z.string().regex(/^[A-Z0-9_]{1,100}$/).parse(input.lastErrorCode);
  return db.$transaction(async (tx) => {
    const run = await writableRun(tx, actor, runId);
    const listedCount = await tx.booksBill.count({ where: { lastImportRunId: run.id, companyId: run.companyId } });
    const detailCount = await tx.booksBill.count({ where: { lastImportRunId: run.id, detailImportRunId: run.id, companyId: run.companyId } });
    if (listedCount !== run.listedCount) throw invalid("BOOKS_IMPORT_COUNT_MISMATCH", "The stored bill count differs from the imported pages.");
    if (run.listingComplete) await tx.booksBill.updateMany({ where: { companyId: run.companyId, organizationId: run.organizationId,
      dataCenter: run.dataCenter, environment: run.environment, lastImportRunId: { not: run.id } }, data: { isStale: true } });
    const complete = run.listingComplete && listedCount === detailCount && !errorCode;
    const updated = await tx.booksImportRun.update({ where: { id: run.id }, data: { detailCount,
      status: complete ? "COMPLETE" : "PARTIAL", completedAt: new Date(),
      lastErrorCode: errorCode ?? (complete ? null : run.listingComplete ? "DETAILS_PENDING" : "LISTING_INCOMPLETE") } });
    await tx.auditLog.create({ data: { actorId: actor.id, companyId: run.companyId, action: "BOOKS_SNAPSHOT_IMPORT_FINISHED",
      entityType: "BooksImportRun", entityId: run.id, details: { organizationId: run.organizationId, listedCount, detailCount,
        listingComplete: run.listingComplete, status: updated.status, providerFinancialWrites: 0 } } });
    return updated;
  }, transactionOptions);
}

const hasCurrentDetail = (bill: Pick<BooksBill, "sourceDetail" | "detailImportRunId" | "lastImportRunId">) =>
  bill.sourceDetail !== null && bill.detailImportRunId === bill.lastImportRunId;

function serializeBill(bill: BooksBill) {
  const detailAvailable = hasCurrentDetail(bill);
  return {
    id: bill.id, companyId: bill.companyId, companyName: bill.organizationName, organizationId: bill.organizationId,
    externalBillId: bill.externalBillId, billNumber: bill.billNumber, vendorName: bill.vendorName, vendorId: bill.vendorId,
    status: bill.status, currencyCode: bill.currencyCode, billDate: bill.billDate?.toISOString().slice(0, 10) ?? null,
    dueDate: bill.dueDate?.toISOString().slice(0, 10) ?? null, subtotal: bill.subtotal, taxTotal: bill.taxTotal,
    total: bill.total, balance: bill.balance, paymentMade: bill.paymentMade, vendorCreditsApplied: bill.vendorCreditsApplied,
    detailAvailable, importedAt: bill.importedAt.toISOString(), lastSeenAt: bill.lastSeenAt.toISOString(),
    detailFetchedAt: detailAvailable ? bill.detailFetchedAt?.toISOString() ?? null : null, isStale: bill.isStale,
  };
}
function serializeRun(run: BooksImportRun) {
  return { id: run.id, companyId: run.companyId, companyName: run.organizationName, organizationId: run.organizationId,
    status: run.status, listedCount: run.listedCount, detailCount: run.detailCount, listingComplete: run.listingComplete,
    startedAt: run.startedAt.toISOString(), completedAt: run.completedAt?.toISOString() ?? null, lastErrorCode: run.lastErrorCode };
}

const listSchema = z.object({ companyId: z.string().min(1).max(100).optional(), q: z.string().trim().max(200).optional(),
  status: z.string().min(1).max(100).optional(), currencyCode: z.string().regex(/^[A-Z]{3}$/).optional(),
  page: z.number().int().min(1).max(100_000).default(1), pageSize: z.number().int().min(1).max(100).default(50) }).strict();

export async function listBooksBills(actor: Actor, payload: unknown = {}) {
  await assertReader(actor);
  const input = listSchema.parse(payload);
  const scope = await companyFilter(actor, input.companyId);
  const where: Prisma.BooksBillWhereInput = { ...scope, ...(input.status ? { status: input.status } : {}),
    ...(input.currencyCode ? { currencyCode: input.currencyCode } : {}), ...(input.q ? { OR: [
      { billNumber: { contains: input.q } }, { vendorName: { contains: input.q } }, { externalBillId: { contains: input.q } },
    ] } : {}) };
  const [bills, total, runs, statuses, currencies] = await Promise.all([
    db.booksBill.findMany({ where, orderBy: [{ billDate: "desc" }, { id: "desc" }], skip: (input.page - 1) * input.pageSize, take: input.pageSize }),
    db.booksBill.count({ where }), db.booksImportRun.findMany({ where: scope, orderBy: { startedAt: "desc" }, take: 20 }),
    db.booksBill.findMany({ where: scope, distinct: ["status"], select: { status: true }, orderBy: { status: "asc" } }),
    db.booksBill.findMany({ where: scope, distinct: ["currencyCode"], select: { currencyCode: true }, orderBy: { currencyCode: "asc" } }),
  ]);
  // Membership revocation during a long query must not release the captured rows.
  await assertReader(actor);
  const currentScope = await companyFilter(actor, input.companyId);
  if (JSON.stringify(currentScope) !== JSON.stringify(scope)) throw new HttpError(403, "Company access changed. Reload the page.");
  return { bills: bills.map(serializeBill), total, page: input.page, pageSize: input.pageSize, runs: runs.map(serializeRun),
    filters: { statuses: statuses.map((row) => row.status), currencies: currencies.map((row) => row.currencyCode) } };
}
export type BooksBillListResult = Awaited<ReturnType<typeof listBooksBills>>;

function record(value: Prisma.JsonValue | undefined): Prisma.JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function records(value: Prisma.JsonValue | undefined) {
  return Array.isArray(value) ? value.filter((entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry)).map(record) : [];
}
function stringField(value: Prisma.JsonValue | undefined): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
function displayMoney(value: Prisma.JsonValue | undefined): string | null {
  return money.safeParse(value).success ? decimalText(value) : null;
}

export async function getBooksBill(actor: Actor, id: string) {
  await assertReader(actor);
  const scope = await companyFilter(actor);
  const bill = await db.booksBill.findFirst({ where: { id, ...scope }, include: { attachments: true } });
  if (!bill) throw new HttpError(404, "Books bill not found.");
  const full = hasCurrentDetail(bill) ? record(bill.sourceDetail ?? undefined) : {};
  const summary = record(bill.sourceSummary);
  const attachmentDetails = describeBooksAttachments(bill, bill.attachments);
  await assertReader(actor);
  await requireCompanyAccess(actor, bill.companyId);
  return { ...serializeBill(bill), sourceModifiedAt: bill.sourceModifiedAt,
    referenceNumber: stringField(full.reference_number) ?? stringField(summary.reference_number),
    notes: stringField(full.notes), terms: stringField(full.terms),
    ...attachmentDetails,
    lines: records(full.line_items).map((line) => ({ id: stringField(line.line_item_id), name: stringField(line.name),
      description: stringField(line.description), quantity: displayMoney(line.quantity), rate: displayMoney(line.rate),
      total: displayMoney(line.item_total), accountName: stringField(line.account_name), taxName: stringField(line.tax_name),
      taxPercentage: displayMoney(line.tax_percentage), projectName: stringField(line.project_name) })),
    payments: records(full.payments).map((payment) => ({ id: stringField(payment.payment_id), date: stringField(payment.date),
      amount: displayMoney(payment.amount), referenceNumber: stringField(payment.reference_number), paymentMode: stringField(payment.payment_mode) })),
    credits: records(full.vendor_credits).map((credit) => ({ id: stringField(credit.vendor_credit_id),
      number: stringField(credit.vendor_credit_number), date: stringField(credit.date), amount: displayMoney(credit.amount) })),
  };
}
export type BooksBillDetail = Awaited<ReturnType<typeof getBooksBill>>;
