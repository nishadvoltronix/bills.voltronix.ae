import "server-only";
import { isManualEntryOnly } from "@/lib/application-mode";
import { Prisma } from "@prisma/client";
import Decimal from "decimal.js";
import { z } from "zod";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { assertBooksLineTaxMode, booksLineTaxMode, booksSelectionDestination, booksSelectionFields, type BooksSelection } from "@/lib/books-selection";
import { booksConfigurationHash, booksLineSelectionRequired, getConfig } from "@/lib/integrations/config";
import { assertBooksLineSelections } from "@/lib/integrations/books";
import { connectionFingerprint } from "@/lib/integrations/connection-fingerprint";
import { LEGACY_UNSCOPED_ORGANIZATION } from "@/lib/integrations/oauth";
import { verifyBillBooksSelections } from "@/lib/services/bill-books-options";
import {
  companyFilter,
  requireCompanyAccess,
  resolveCompanyForCreate,
} from "@/lib/company";
import {
  calculateBill,
  getPaymentStatus,
  isRecognizedBillStatus,
  normalizeInvoiceNumber,
} from "@/lib/finance";
import { HttpError } from "@/lib/http";
import {
  assertBillCancellationSyncSafe,
  enqueueApprovedBillTx,
  enqueueReadyBillTx,
} from "@/lib/integrations/queue";
import {
  billScope,
  canApproveBill,
  canCreateBill,
  canEditBill,
  canViewBill,
} from "@/lib/permissions";
import {
  billActionSchema,
  billInputSchema,
  billStatusSchema,
  categorySchema,
  type BillInput,
} from "@/lib/validation";

export const billInclude = {
  vendor: { select: { id: true, name: true } },
  job: { select: { id: true, jobNumber: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  approvedBy: { select: { id: true, name: true } },
  lines: true,
  documents: {
    select: {
      id: true,
      fileName: true,
      mimeType: true,
      byteSize: true,
      createdAt: true,
    },
  },
  payments: { orderBy: { createdAt: "desc" as const } },
  syncRecords: true,
} satisfies Prisma.BillInclude;

type DetailedBill = Prisma.BillGetPayload<{ include: typeof billInclude }>;
export function serializeBill(bill: DetailedBill) {
  const { usesBooksLineTaxes, ...fields } = bill;
  return {
    ...fields,
    ...(usesBooksLineTaxes ? { usesBooksLineTaxes: true } : {}),
    invoiceDate: bill.invoiceDate.toISOString().slice(0, 10),
    dueDate: bill.dueDate?.toISOString().slice(0, 10) ?? null,
    subtotal: bill.subtotal.toFixed(2),
    discount: bill.discount.toFixed(2),
    vatRate: bill.vatRate.toFixed(2),
    vatAmount: bill.vatAmount.toFixed(2),
    total: bill.total.toFixed(2),
    paidAmount: bill.paidAmount.toFixed(2),
    outstanding: isRecognizedBillStatus(bill.status)
      ? new Decimal(bill.total.toString())
          .minus(bill.paidAmount.toString())
          .toFixed(2)
      : "0.00",
    netAmount: new Decimal(bill.subtotal.toString())
      .minus(bill.discount.toString())
      .toFixed(2),
    paymentStatus: getPaymentStatus(
      bill.total.toString(),
      bill.paidAmount.toString(),
    ),
    lines: bill.lines.map(({ booksSelection, ...line }) => ({
      ...line,
      quantity: line.quantity.toString(),
      unitPrice: line.unitPrice.toFixed(2),
      lineTotal: line.lineTotal.toFixed(2),
      ...booksSelectionFields(booksSelection),
    })),
    payments: bill.payments.map((payment) => ({
      ...payment,
      amount: payment.amount.toFixed(2),
    })),
  };
}

export async function assertBillAccess(
  actor: Actor,
  bill: { createdById: string; companyId: string },
  tx?: Prisma.TransactionClient,
): Promise<void> {
  await requireCompanyAccess(actor, bill.companyId, tx);
  if (!canViewBill(actor, bill)) throw new HttpError(404, "Bill not found.");
}

function assertWriter(actor: Actor): void {
  if (!canCreateBill(actor))
    throw new HttpError(403, "Your role cannot create or change bills.");
}

function validatedTotals(input: BillInput) {
  if (normalizeInvoiceNumber(input.invoiceNumber).length > 360)
    throw new HttpError(422, "The normalized invoice number is too long.");
  try {
    return calculateBill(input.lines, input.discount, input.vatRate);
  } catch (error) {
    throw new HttpError(
      422,
      error instanceof Error ? error.message : "The bill totals are invalid.",
    );
  }
}

/** A process-local proof cannot be supplied through a JSON request or reused for changed lines. */
export type BillBooksVerification = Readonly<{ kind: "verified-books-lines" }>;
const lineVerifications = new WeakMap<BillBooksVerification, {
  actorId: string; companyId: string; version?: number; requested: string; expiresAt: number;
  selections: (BooksSelection | null)[]; configurationHash: string;
}>();
function selectionRequestKey(lines: BillInput["lines"]) {
  return JSON.stringify(lines.map((line) => ({ description: line.description, quantity: line.quantity,
    unitPrice: line.unitPrice, ...booksSelectionFields(line.booksSelection) })));
}
async function requireSelectionContext(store: Prisma.TransactionClient, actor: Actor, companyId: string, selection: BooksSelection) {
  const writer = await store.user.findFirst({ where: { id: actor.id, active: true,
    role: { in: ["ADMIN", "ACCOUNTS", "DATA_ENTRY"] },
    memberships: { some: { companyId, active: true, company: { active: true } } } }, select: { id: true } });
  if (!writer) throw new HttpError(403, "Current bill-entry access to this company is required.");
  const config = getConfig("ZOHO", process.env, selection.organizationId);
  if (!config.networkEnabled || config.dataCenter !== selection.dataCenter || config.environment !== selection.environment)
    throw new HttpError(422, "The selected Books connection does not match this company destination.");
  const destinations = await store.companyIntegrationDestination.findMany({ where: {
    companyId, target: "ZOHO", company: { active: true },
  }, select: { organizationId: true, dataCenter: true, environment: true } });
  if (destinations.length !== 1 || destinations[0].organizationId !== selection.organizationId ||
    destinations[0].dataCenter !== selection.dataCenter || destinations[0].environment !== selection.environment)
    throw new HttpError(422, "The selected Books organization is not the company's single exact destination.");
  const grant = await store.integrationCredential.findUnique({ where: {
    target_organizationId: { target: "ZOHO", organizationId: selection.organizationId },
  }, select: { revokedAt: true, connectionFingerprint: true } });
  if (grant ? (grant.revokedAt || grant.connectionFingerprint !== connectionFingerprint(config)) :
    (!config.refreshToken || await store.integrationCredential.findUnique({ where: {
      target_organizationId: { target: "ZOHO", organizationId: LEGACY_UNSCOPED_ORGANIZATION },
    }, select: { organizationId: true } })))
    throw new HttpError(422, "This company's current Books authorization is unavailable. Reconnect before selecting accounting options.");
  return booksConfigurationHash(config);
}

/** All provider reads finish before the caller opens its financial transaction. */
export async function prepareBillBooksSelections(actor: Actor, companyId: string, lines: BillInput["lines"], version?: number) {
  assertWriter(actor);
  const selections = lines.map((line) => booksSelectionFields(line.booksSelection).booksSelection ?? null);
  const first = selections.find((selection) => selection !== null);
  if (!first) return undefined;
  if (isManualEntryOnly())
    throw new HttpError(422, "Clear the Books line selections before saving in manual entry mode. Review the invoice VAT rate after clearing them.");
  if (selections.some((selection) => !selection || booksSelectionDestination(selection) !== booksSelectionDestination(first)))
    throw new HttpError(422, "Select an account and tax from the same Books destination for every line, or clear all line selections.");
  const configurationHash = await requireSelectionContext(db, actor, companyId, first);
  const requested = selectionRequestKey(lines);
  const normalized = await verifyBillBooksSelections(actor, companyId, selections);
  if (normalized.length !== lines.length || normalized.some((selection) => !selection) ||
    await requireSelectionContext(db, actor, companyId, first) !== configurationHash)
    throw new HttpError(409, "The Books selection configuration changed during verification. Review and save again.");
  const proof: BillBooksVerification = Object.freeze({ kind: "verified-books-lines" });
  lineVerifications.set(proof, { actorId: actor.id, companyId, version, requested, expiresAt: Date.now() + 5 * 60_000,
    selections: structuredClone(normalized), configurationHash });
  return proof;
}

async function verifiedLines(store: Prisma.TransactionClient, actor: Actor, companyId: string, lines: BillInput["lines"],
  version: number | undefined, proof?: BillBooksVerification): Promise<BillInput["lines"]> {
  if (!lines.some((line) => line.booksSelection)) return lines;
  const trusted = proof && lineVerifications.get(proof);
  if (!trusted || trusted.actorId !== actor.id || trusted.companyId !== companyId || trusted.version !== version ||
    trusted.requested !== selectionRequestKey(lines) || trusted.expiresAt < Date.now())
    throw new HttpError(422, "Selected Books lines must be verified for this exact bill before saving.");
  const first = trusted.selections[0]!;
  if (await requireSelectionContext(store, actor, companyId, first) !== trusted.configurationHash)
    throw new HttpError(409, "The Books selection configuration changed before saving. Review and save again.");
  return lines.map((line, index) => ({ ...line, booksSelection: trusted.selections[index] }));
}

function financeSnapshot(
  bill: Prisma.BillGetPayload<{ include: { lines: true } }>,
) {
  assertBooksLineTaxMode(bill.usesBooksLineTaxes, bill.lines);
  return {
    ...(bill.usesBooksLineTaxes ? { usesBooksLineTaxes: true } : {}),
    status: bill.status,
    vendorId: bill.vendorId,
    jobId: bill.jobId,
    invoiceNumber: bill.invoiceNumber,
    orderNumber: bill.orderNumber,
    paymentTerms: bill.paymentTerms,
    invoiceDate: bill.invoiceDate.toISOString().slice(0, 10),
    dueDate: bill.dueDate?.toISOString().slice(0, 10) ?? null,
    category: bill.category,
    currency: bill.currency,
    description: bill.description,
    notes: bill.notes,
    subtotal: bill.subtotal.toString(),
    discount: bill.discount.toString(),
    vatRate: bill.vatRate.toString(),
    vatAmount: bill.vatAmount.toString(),
    total: bill.total.toString(),
    paidAmount: bill.paidAmount.toString(),
    version: bill.version,
    lines: bill.lines.map((line) => ({
      description: line.description,
      quantity: line.quantity.toString(),
      unitPrice: line.unitPrice.toString(),
      lineTotal: line.lineTotal.toString(),
      ...booksSelectionFields(line.booksSelection),
    })),
  };
}

async function validateReferences(
  tx: Prisma.TransactionClient,
  vendorId: string,
  jobId: string,
  currency: string,
  companyId: string,
) {
  const vendor = await tx.vendor.findUnique({ where: { id: vendorId } });
  const job = await tx.job.findUnique({ where: { id: jobId } });
  if (
    !vendor ||
    !job ||
    vendor.companyId !== companyId ||
    job.companyId !== companyId
  )
    throw new HttpError(422, "Choose an existing vendor and job.");
  if (job.currency !== currency || vendor.currency !== currency)
    throw new HttpError(
      422,
      "Bill, vendor and job currencies must match. Currency conversion is not configured.",
    );
}

export async function createBill(actor: Actor, payload: unknown) {
  assertWriter(actor);
  const input = billInputSchema.parse(payload);
  const companyId = await resolveCompanyForCreate(actor, input.companyId);
  const verified = await prepareBillBooksSelections(actor, companyId, input.lines, input.version);
  const bill = await db.$transaction(
    (tx) => createBillInTransaction(tx, actor, input, verified),
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 20_000,
    },
  );
  return serializeBill(bill);
}

/** Shared transaction boundary for an explicitly reviewed OCR draft and its original document. */
export async function createBillInTransaction(
  tx: Prisma.TransactionClient,
  actor: Actor,
  payload: unknown,
  verification?: BillBooksVerification,
) {
  assertWriter(actor);
  const input = billInputSchema.parse(payload);
  const companyId = await resolveCompanyForCreate(actor, input.companyId, tx);
  input.lines = await verifiedLines(tx, actor, companyId, input.lines, input.version, verification);
  const totals = validatedTotals(input);
  if (new Decimal(totals.total).lessThanOrEqualTo(0))
    throw new HttpError(422, "The bill total must be greater than zero.");
  await validateReferences(
    tx,
    input.vendorId,
    input.jobId,
    input.currency,
    companyId,
  );
  const saved = await tx.bill.create({
    data: {
      companyId,
      vendorId: input.vendorId,
      jobId: input.jobId,
      invoiceNumber: input.invoiceNumber,
      orderNumber: input.orderNumber || null,
      paymentTerms: input.paymentTerms,
      normalizedInvoiceNumber: normalizeInvoiceNumber(input.invoiceNumber),
      invoiceDate: new Date(`${input.invoiceDate}T00:00:00Z`),
      dueDate: input.dueDate ? new Date(`${input.dueDate}T00:00:00Z`) : null,
      category: input.category,
      currency: input.currency,
      description: input.description || null,
      notes: input.notes || null,
      status: "DRAFT",
      createdById: actor.id,
      subtotal: totals.subtotal,
      discount: totals.discount,
      vatRate: totals.vatRate,
      vatAmount: totals.vatAmount,
      usesBooksLineTaxes: booksLineTaxMode(totals.lines),
      total: totals.total,
      lines: { create: totals.lines },
      syncRecords: {
        create: [
          { target: "ZOHO", status: "NOT_CONFIGURED" },
          { target: "CRM", status: "NOT_CONFIGURED" },
        ],
      },
    },
    include: billInclude,
  });
  await tx.auditLog.create({
    data: {
      actorId: actor.id,
      companyId,
      action: "BILL_CREATED",
      entityType: "Bill",
      entityId: saved.id,
      details: {
        after: financeSnapshot(saved),
        invoiceNumber: saved.invoiceNumber,
        jobId: saved.jobId,
        vendorId: saved.vendorId,
      },
    },
  });
  return input.submit
    ? finalizeBillInTransaction(tx, actor, saved.id, saved.version)
    : saved;
}

/** Final save after all intended attachments exist; no separate approver or payment. */
export async function finalizeBillInTransaction(
  tx: Prisma.TransactionClient,
  actor: Actor,
  id: string,
  version: number,
) {
  assertWriter(actor);
  const bill = await tx.bill.findUnique({
    where: { id },
    include: { lines: true },
  });
  if (!bill) throw new HttpError(404, "Bill not found.");
  await assertBillAccess(actor, bill, tx);
  if (bill.version !== version)
    throw new HttpError(
      409,
      "The bill changed. Refresh before saving it for synchronization.",
    );
  if (!["DRAFT", "REJECTED", "PENDING_APPROVAL"].includes(bill.status))
    throw new HttpError(
      409,
      "Only an unfinished bill can be saved for synchronization.",
    );
  await validateReferences(
    tx,
    bill.vendorId,
    bill.jobId,
    bill.currency,
    bill.companyId,
  );
  try {
    assertBooksLineTaxMode(bill.usesBooksLineTaxes, bill.lines);
  } catch {
    throw new HttpError(422, "The saved bill's tax mode does not match its line selections. Review the bill before continuing.");
  }
  if (!isManualEntryOnly()) {
    const destinations = await tx.companyIntegrationDestination.findMany({ where: {
      companyId: bill.companyId, target: "ZOHO", company: { active: true },
    }, select: { organizationId: true, dataCenter: true, environment: true } });
    for (const destination of destinations) {
      let required;
      try { required = booksLineSelectionRequired(destination.organizationId); }
      catch {
        // The policy reader handles absent legacy configuration. Invalid configured
        // policies must not turn a repairable draft into an uneditable bill.
        throw new HttpError(422, "This company's Books accounting configuration is invalid. Keep the bill as a draft until it is corrected.");
      }
      if (!required) continue;
      if (!bill.lines.length || bill.lines.some(line => line.booksSelection === null))
        throw new HttpError(422, "Select a Books account and tax for every line before Save and sync. You can keep this bill as a draft.");
      let config;
      try { config = getConfig("ZOHO", process.env, destination.organizationId); }
      catch { throw new HttpError(422, "This company's Books configuration is unavailable. Keep the bill as a draft until its connection is restored."); }
      if (destinations.length !== 1 || config.dataCenter !== destination.dataCenter || config.environment !== destination.environment)
        throw new HttpError(422, "Confirm this company's exact Books destination before Save and sync. The bill remains a draft.");
      try { assertBooksLineSelections(bill.lines, config); }
      catch (error) { throw new HttpError(422, error instanceof Error ? error.message : "Select an account and tax for every Books line."); }
    }
  }
  const totals = calculateBill(
    bill.lines.map((line) => ({
      description: line.description,
      quantity: line.quantity.toString(),
      unitPrice: line.unitPrice.toString(),
      ...booksSelectionFields(line.booksSelection),
    })),
    bill.discount.toString(),
    bill.vatRate.toString(),
  );
  if (
    new Decimal(totals.total).lessThanOrEqualTo(0) ||
    !new Decimal(totals.total).equals(bill.total.toString()) ||
    !new Decimal(totals.subtotal).equals(bill.subtotal.toString()) ||
    !new Decimal(totals.vatAmount).equals(bill.vatAmount.toString())
  )
    throw new HttpError(
      422,
      "The saved bill totals must be corrected before synchronization.",
    );
  const changed = await tx.bill.updateMany({
    where: {
      id,
      version,
      status: { in: ["DRAFT", "REJECTED", "PENDING_APPROVAL"] },
    },
    data: {
      status: "READY",
      approvedById: null,
      approvedAt: null,
      version: { increment: 1 },
    },
  });
  if (changed.count !== 1)
    throw new HttpError(409, "The bill changed during final save.");
  await enqueueReadyBillTx(tx, id, actor.id);
  const result = await tx.bill.findUniqueOrThrow({
    where: { id },
    include: billInclude,
  });
  await tx.auditLog.create({
    data: {
      actorId: actor.id,
      companyId: bill.companyId,
      action: "BILL_FINALIZED",
      entityType: "Bill",
      entityId: id,
      details: {
        before: financeSnapshot(bill),
        after: financeSnapshot(result),
        approvalRequired: false,
      },
    },
  });
  return result;
}

export async function getBill(actor: Actor, id: string) {
  const bill = await db.bill.findUnique({
    where: { id },
    include: billInclude,
  });
  if (!bill) throw new HttpError(404, "Bill not found.");
  await assertBillAccess(actor, bill);
  const auditLogs = await db.auditLog.findMany({
    where: { entityType: "Bill", entityId: id, companyId: bill.companyId },
    include: { actor: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  // Expose recovery state only after the same company/creator access check as
  // the bill. Payload snapshots, credentials and worker leases remain private.
  const integrationJobs = await db.integrationJob.findMany({
    where: { billId: id, target: "ZOHO" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      organizationId: true,
      operation: true,
      status: true,
      needsReconciliation: true,
      attempts: true,
      nextAttemptAt: true,
      externalId: true,
      lastError: true,
    },
  });
  return { ...serializeBill(bill), auditLogs, integrationJobs };
}

export async function updateBill(actor: Actor, id: string, payload: unknown) {
  assertWriter(actor);
  const rawInput = z.record(z.string(), z.unknown()).parse(payload);
  const version = z
    .number()
    .int()
    .positive()
    .optional()
    .parse(rawInput.version);
  if (!version)
    throw new HttpError(
      422,
      "The bill version is required. Refresh the bill before editing.",
    );
  const beforeVerification = await db.bill.findUnique({ where: { id }, include: { lines: true } });
  if (!beforeVerification) throw new HttpError(404, "Bill not found.");
  await assertBillAccess(actor, beforeVerification);
  if (!canEditBill(actor, beforeVerification)) throw new HttpError(403, "Only draft and rejected bills can be edited.");
  if (beforeVerification.version !== version) throw new HttpError(409, "The bill has changed. Refresh before editing.");
  const preflight = billInputSchema.parse(rawInput);
  if (preflight.companyId && preflight.companyId !== beforeVerification.companyId)
    throw new HttpError(422, "A saved bill cannot be moved to another company.");
  if (beforeVerification.lines.some((line) => line.booksSelection) && preflight.lines.some((line) => line.booksSelection === undefined))
    throw new HttpError(422, "Include each saved line's Books selection, or explicitly clear all selections. Existing selections were preserved.");
  const verification = await prepareBillBooksSelections(actor, beforeVerification.companyId, preflight.lines, version);
  const updated = await db.$transaction(
    async (tx) => {
      const bill = await tx.bill.findUnique({
        where: { id },
        include: { lines: true },
      });
      if (!bill) throw new HttpError(404, "Bill not found.");
      await assertBillAccess(actor, bill, tx);
      if (!canEditBill(actor, bill))
        throw new HttpError(
          403,
          "Only draft and rejected bills can be edited.",
        );
      if (bill.version !== version)
        throw new HttpError(
          409,
          "The bill has changed. Refresh before editing.",
        );
      // Older callers do not know these optional metadata fields. Preserve them
      // on edits, while deriving a new preset due date when the bill date changes.
      const paymentTerms =
        rawInput.paymentTerms === undefined
          ? bill.paymentTerms
          : rawInput.paymentTerms;
      const input = billInputSchema.parse({
        ...rawInput,
        orderNumber:
          rawInput.orderNumber === undefined
            ? (bill.orderNumber ?? "")
            : rawInput.orderNumber,
        paymentTerms,
        dueDate:
          rawInput.dueDate === undefined && paymentTerms === "CUSTOM"
            ? (bill.dueDate?.toISOString().slice(0, 10) ?? "")
            : rawInput.dueDate,
      });
      if (input.companyId && input.companyId !== bill.companyId)
        throw new HttpError(
          422,
          "A saved bill cannot be moved to another company.",
        );
      input.lines = await verifiedLines(tx, actor, bill.companyId, input.lines, version, verification);
      const totals = validatedTotals(input);
      await validateReferences(
        tx,
        input.vendorId,
        input.jobId,
        input.currency,
        bill.companyId,
      );
      const changed = await tx.bill.updateMany({
        where: { id, version: input.version },
        data: {
          vendorId: input.vendorId,
          jobId: input.jobId,
          invoiceNumber: input.invoiceNumber,
          orderNumber: input.orderNumber || null,
          paymentTerms: input.paymentTerms,
          normalizedInvoiceNumber: normalizeInvoiceNumber(input.invoiceNumber),
          invoiceDate: new Date(`${input.invoiceDate}T00:00:00Z`),
          dueDate: input.dueDate
            ? new Date(`${input.dueDate}T00:00:00Z`)
            : null,
          category: input.category,
          currency: input.currency,
          description:
            input.description === undefined
              ? bill.description
              : input.description || null,
          notes: input.notes || null,
          status: "DRAFT",
          subtotal: totals.subtotal,
          discount: totals.discount,
          vatRate: totals.vatRate,
          vatAmount: totals.vatAmount,
          usesBooksLineTaxes: booksLineTaxMode(totals.lines),
          total: totals.total,
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1)
        throw new HttpError(
          409,
          "The bill changed during your edit. Refresh and try again.",
        );
      await tx.billLine.deleteMany({ where: { billId: id } });
      await tx.billLine.createMany({
        data: totals.lines.map((line) => ({ ...line, billId: id })),
      });
      const result = await tx.bill.findUniqueOrThrow({
        where: { id },
        include: billInclude,
      });
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          companyId: bill.companyId,
          action: "BILL_UPDATED",
          entityType: "Bill",
          entityId: id,
          details: {
            before: financeSnapshot(bill),
            after: financeSnapshot(result),
            previous: {
              vendorId: bill.vendorId,
              jobId: bill.jobId,
              invoiceNumber: bill.invoiceNumber,
            },
            current: {
              vendorId: result.vendorId,
              jobId: result.jobId,
              invoiceNumber: result.invoiceNumber,
            },
          },
        },
      });
      return input.submit
        ? finalizeBillInTransaction(tx, actor, id, result.version)
        : result;
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 20_000,
    },
  );
  return serializeBill(updated);
}

export async function actOnBill(actor: Actor, id: string, payload: unknown) {
  assertWriter(actor);
  const input = billActionSchema.parse(payload);
  const updated = await db.$transaction(
    async (tx) => {
      const bill = await tx.bill.findUnique({
        where: { id },
        include: { lines: true },
      });
      if (!bill) throw new HttpError(404, "Bill not found.");
      await assertBillAccess(actor, bill, tx);
      if (bill.version !== input.version)
        throw new HttpError(
          409,
          "The bill has changed. Refresh before taking action.",
        );
      if (input.action === "submit")
        return finalizeBillInTransaction(tx, actor, id, input.version);
      const data: Prisma.BillUncheckedUpdateManyInput = {
        version: { increment: 1 },
      };
      const financeRole = ["ADMIN", "ACCOUNTS"].includes(actor.role);
      switch (input.action) {
        case "approve":
          if (!canApproveBill(actor, bill))
            throw new HttpError(
              403,
              "An Accounts or Admin user other than the bill creator must approve a pending bill.",
            );
          data.status = "APPROVED";
          data.approvedById = actor.id;
          data.approvedAt = new Date();
          break;
        case "reject":
          if (
            !financeRole ||
            bill.status !== "PENDING_APPROVAL" ||
            actor.id === bill.createdById
          )
            throw new HttpError(
              403,
              "A different Accounts or Admin user must review a pending bill.",
            );
          data.status = "REJECTED";
          break;
        case "cancel":
          await assertBillCancellationSyncSafe(tx, id);
          if (
            !financeRole ||
            bill.status === "CANCELLED" ||
            !bill.paidAmount.isZero()
          )
            throw new HttpError(
              409,
              "Only an unpaid, active bill can be cancelled by Accounts or Admin. Paid bills require a separately reviewed reversal.",
            );
          data.status = "CANCELLED";
          break;
        case "payment": {
          if (!financeRole || !isRecognizedBillStatus(bill.status))
            throw new HttpError(
              403,
              "Only Accounts or Admin may record payments against finalized bills.",
            );
          const amount = new Decimal(input.amount!);
          const paid = new Decimal(bill.paidAmount.toString()).plus(amount);
          if (paid.greaterThan(bill.total.toString()))
            throw new HttpError(422, "Payment exceeds the outstanding amount.");
          data.paidAmount = paid.toFixed(2);
          await tx.payment.create({
            data: {
              billId: id,
              amount: amount.toFixed(2),
              reference: input
                .reference!.normalize("NFKC")
                .trim()
                .toUpperCase(),
              createdById: actor.id,
            },
          });
          break;
        }
      }
      const changed = await tx.bill.updateMany({
        where: { id, version: input.version },
        data,
      });
      if (changed.count !== 1)
        throw new HttpError(
          409,
          "The bill changed during your request. Refresh and try again.",
        );
      if (input.action === "approve")
        await enqueueApprovedBillTx(tx, id, actor.id);
      const result = await tx.bill.findUniqueOrThrow({
        where: { id },
        include: billInclude,
      });
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          companyId: bill.companyId,
          action: `BILL_${input.action.toUpperCase()}`,
          entityType: "Bill",
          entityId: id,
          details: {
            before: financeSnapshot(bill),
            after: financeSnapshot(result),
            reason: input.reason ?? null,
            paymentReference: input.reference ?? null,
            paymentAmount: input.amount ?? null,
          },
        },
      });
      return result;
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 20_000,
    },
  );
  return serializeBill(updated);
}

const listSchema = z.object({
  companyId: z.string().min(1).max(100).optional(),
  q: z.string().max(200).optional(),
  status: billStatusSchema.optional(),
  paymentStatus: z.enum(["UNPAID", "PARTIALLY_PAID", "PAID"]).optional(),
  jobId: z.string().max(100).optional(),
  vendorId: z.string().max(100).optional(),
  category: categorySchema.optional(),
  dateFrom: z.iso.date().optional(),
  dateTo: z.iso.date().optional(),
  sort: z
    .enum(["date_desc", "date_asc", "total_desc", "total_asc"])
    .default("date_desc"),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export async function listBills(actor: Actor, params: URLSearchParams) {
  const input = listSchema.parse(
    Object.fromEntries([...params].filter(([, value]) => value !== "")),
  );
  if (input.dateFrom && input.dateTo && input.dateFrom > input.dateTo)
    throw new HttpError(422, "The start date must precede the end date.");
  const where: Prisma.BillWhereInput = {
    ...(await companyFilter(actor, input.companyId)),
    ...billScope(actor),
    status: input.status,
    jobId: input.jobId,
    vendorId: input.vendorId,
    category: input.category,
  };
  if (input.q)
    where.OR = [
      { invoiceNumber: { contains: input.q } },
      { vendor: { name: { contains: input.q } } },
      { job: { jobNumber: { contains: input.q } } },
    ];
  if (input.dateFrom || input.dateTo)
    where.invoiceDate = {
      gte: input.dateFrom ? new Date(`${input.dateFrom}T00:00:00Z`) : undefined,
      lte: input.dateTo ? new Date(`${input.dateTo}T00:00:00Z`) : undefined,
    };
  if (input.paymentStatus === "UNPAID") where.paidAmount = { equals: 0 };
  if (input.paymentStatus === "PARTIALLY_PAID")
    where.paidAmount = { gt: 0, lt: db.bill.fields.total };
  if (input.paymentStatus === "PAID")
    where.paidAmount = { gt: 0, equals: db.bill.fields.total };
  const orderBy: Prisma.BillOrderByWithRelationInput[] = input.sort.startsWith(
    "total",
  )
    ? [{ total: input.sort.endsWith("asc") ? "asc" : "desc" }, { id: "asc" }]
    : [
        { invoiceDate: input.sort.endsWith("asc") ? "asc" : "desc" },
        { createdAt: "desc" },
        { id: "asc" },
      ];
  const [bills, total] = await db.$transaction(
    async (tx) => {
      const bills = await tx.bill.findMany({
        where,
        include: billInclude,
        orderBy,
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
      });
      const total = await tx.bill.count({ where });
      return [bills, total] as const;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
  return {
    bills: bills.map(serializeBill),
    total,
    page: input.page,
    pageSize: input.pageSize,
  };
}
