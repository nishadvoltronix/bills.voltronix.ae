import "server-only";
import { Prisma } from "@prisma/client";
import Decimal from "decimal.js";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  companyFilter,
  requireCompanyAccess,
  resolveCompanyForCreate,
} from "@/lib/company";
import { isRecognizedBillStatus, summarizeJob } from "@/lib/finance";
import { HttpError } from "@/lib/http";
import {
  billScope,
  canManageJobs,
  canManageVendors,
  canViewAuditLog,
  canViewFinancialSummary,
} from "@/lib/permissions";
import { jobSchema, vendorSchema } from "@/lib/validation";
import { billInclude, serializeBill } from "@/lib/services/bills";
import { describeBooksAttachments } from "@/lib/services/books-attachments";
import { loadBooksProjectHistory } from "./books-project-history";
import { presentProjectHistory } from "./books-project-history-presentation";
import {
  aggregateAmounts,
  booksFinancialAmounts,
  exactMoney,
  sumKnown,
} from "@/lib/books-financials";
import {
  freshFinancialActor,
  importedBillSummary,
  ledgerJobAmounts,
  loadFinancialLedger,
  nativeFinancialAmounts,
  nullableProfit,
  type FinancialLedger,
} from "./financial-ledger";

type JobWithBills = Prisma.JobGetPayload<{ include: { bills: true } }>;
const Exact = Decimal.clone({ precision: 120 });

export function serializeJob(actor: Actor, job: JobWithBills) {
  const visibleBills = job.bills.filter(
    (bill) => actor.role !== "DATA_ENTRY" || bill.createdById === actor.id,
  );
  const summary = summarizeJob(
    {
      contractValue: canViewFinancialSummary(actor)
        ? (job.contractValue?.toString() ?? null)
        : null,
      approvedVariations: job.approvedVariations.toString(),
      currency: job.currency,
    },
    visibleBills.map((bill) => ({
      ...bill,
      subtotal: bill.subtotal.toString(),
      discount: bill.discount.toString(),
      total: bill.total.toString(),
      paidAmount: bill.paidAmount.toString(),
    })),
  );
  return {
    id: job.id,
    companyId: job.companyId,
    jobNumber: job.jobNumber,
    name: job.name,
    customer: job.customer,
    currency: job.currency,
    isDemo: job.isDemo,
    externalCrmId: job.externalCrmId,
    contractValue: canViewFinancialSummary(actor)
      ? (job.contractValue?.toFixed(2) ?? null)
      : null,
    approvedVariations: canViewFinancialSummary(actor)
      ? job.approvedVariations.toFixed(2)
      : "0.00",
    ...summary,
    billCount: visibleBills.length,
    financialScope: actor.role === "DATA_ENTRY" ? "YOUR_BILLS" : "ORGANIZATION",
  };
}

export async function listVendors(actor: Actor, q = "", companyId?: string) {
  if (q.length > 200) throw new HttpError(422, "Search is too long.");
  return db.vendor.findMany({
    where: {
      ...(await companyFilter(actor, companyId)),
      ...(q ? { name: { contains: q } } : {}),
    },
    orderBy: { name: "asc" },
  });
}

export async function createVendor(actor: Actor, payload: unknown) {
  if (!canManageVendors(actor))
    throw new HttpError(403, "Only Admin and Accounts may manage vendors.");
  const input = vendorSchema.parse(payload);
  return db.$transaction(
    async (tx) => {
      const companyId = await resolveCompanyForCreate(
        actor,
        input.companyId,
        tx,
      );
      const duplicate = await tx.vendor.findFirst({
        where: {
          companyId,
          OR: [
            { name: { equals: input.name } },
            ...(input.trn ? [{ trn: input.trn }] : []),
          ],
        },
      });
      if (duplicate)
        throw new HttpError(
          409,
          "A vendor with this name or tax registration number already exists.",
        );
      const vendor = await tx.vendor.create({
        data: {
          ...input,
          companyId,
          email: input.email || null,
          trn: input.trn || null,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          companyId,
          action: "VENDOR_CREATED",
          entityType: "Vendor",
          entityId: vendor.id,
          details: { name: vendor.name, currency: vendor.currency },
        },
      });
      return vendor;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export async function listJobs(actor: Actor, q = "", companyId?: string) {
  if (q.length > 200) throw new HttpError(422, "Search is too long.");
  const ledger = await loadFinancialLedger(actor, companyId);
  const query = q.normalize("NFKC").trim().toUpperCase();
  return ledger.jobs
    .filter(
      (job) =>
        !query ||
        job.id === q ||
        job.externalCrmId === q ||
        [job.jobNumber, job.name, job.customer].some((value) =>
          value?.normalize("NFKC").toUpperCase().includes(query),
        ),
    )
    .slice(0, 250)
    .map((job) => ledgerJobDto(ledger, job));
}

export async function createJob(actor: Actor, payload: unknown) {
  if (!canManageJobs(actor))
    throw new HttpError(403, "Only Admin may create local jobs.");
  const input = jobSchema.parse(payload);
  const job = await db.$transaction(async (tx) => {
    const companyId = await resolveCompanyForCreate(actor, input.companyId, tx);
    const created = await tx.job.create({
      data: {
        ...input,
        companyId,
        jobNumber: input.jobNumber.normalize("NFKC").trim().toUpperCase(),
        contractValue: input.contractValue || null,
      },
    });
    await tx.auditLog.create({
      data: {
        actorId: actor.id,
        companyId,
        action: "JOB_CREATED",
        entityType: "Job",
        entityId: created.id,
        details: {
          jobNumber: created.jobNumber,
          contractValue: created.contractValue?.toString() ?? null,
          approvedVariations: created.approvedVariations.toString(),
          currency: created.currency,
          source: "LOCAL",
        },
      },
    });
    return created;
  });
  return serializeJob(actor, { ...job, bills: [] });
}

export async function getJob(actor: Actor, id: string) {
  return getJobSnapshot(actor, id, true);
}

async function getJobSnapshot(actor: Actor, id: string, retry: boolean) {
  actor = await freshFinancialActor(actor);
  const job = await db.job.findUnique({
    where: { id },
    include: {
      bills: {
        where: billScope(actor),
        include: billInclude,
        orderBy: { invoiceDate: "desc" },
      },
    },
  });
  if (!job) throw new HttpError(404, "Job not found.");
  await requireCompanyAccess(actor, job.companyId);
  // History spans every recorded invoice currency. Financial summaries below
  // still require matching currencies before presenting a job total.
  const ledger = await loadFinancialLedger(actor, job.companyId);
  const current = ledger.jobs.find((row) => row.id === id);
  if (!current) throw new HttpError(404, "Job not found.");
  if (ledger.truncated)
    throw new HttpError(
      422,
      "This job's bill history is too large to load completely. Contact your administrator.",
    );
  const amounts = ledgerJobAmounts(ledger, current);
  // Financial projections intentionally omit source JSON and documents. Load
  // originals in one scoped query for only the bills already linked to this job.
  const historyBills = amounts.linked.length
    ? await db.booksBill.findMany({
        where: {
          companyId: job.companyId,
          isStale: false,
          OR: amounts.linked.map((bill) => ({
            id: bill.id,
            organizationId: bill.organizationId,
            dataCenter: bill.dataCenter,
            environment: bill.environment,
          })),
        },
        include: { attachments: true },
        orderBy: [{ billDate: "desc" }, { id: "asc" }],
      })
    : [];
  const linked = new Map(amounts.linked.map((bill) => [bill.id, bill]));
  // Incoming sync may advance a bill while its originals are being loaded.
  // Retry once rather than mixing one revision's totals with another's files.
  const changed =
    historyBills.length !== amounts.linked.length ||
    historyBills.some((bill) => {
      const prior = linked.get(bill.id)!;
      return (
        prior.lastImportRunId !== bill.lastImportRunId ||
        prior.detailImportRunId !== bill.detailImportRunId ||
        prior.billNumber !== bill.billNumber ||
        prior.vendorName !== bill.vendorName ||
        prior.status !== bill.status ||
        prior.currencyCode !== bill.currencyCode ||
        prior.billDate?.getTime() !== bill.billDate?.getTime() ||
        JSON.stringify(prior.amounts) !==
          JSON.stringify(booksFinancialAmounts(bill))
      );
    });
  if (changed) {
    if (retry) return getJobSnapshot(actor, id, false);
    throw new HttpError(
      409,
      "Job history changed during refresh. Please try again.",
    );
  }
  const projectHistory = actor.role === "DATA_ENTRY" ? { relations: [], warnings: [] } : await loadBooksProjectHistory(actor, job.companyId);
  const related = await presentProjectHistory(actor, projectHistory.relations.filter((relation) => relation.canonicalJobId === job.id));
  const confirmedBills = historyBills.map((bill) => ({
      ...importedBillSummary({ ...linked.get(bill.id)!, ...bill }, ledger.jobs),
      ...describeBooksAttachments(bill, bill.attachments),
      relationEvidence:
        "Linked through this workspace's confirmed Zoho bill ID",
      allocationKnown: true,
    }));
  const booksBills = [...new Map([...related.booksBills, ...confirmedBills].map((bill) => [bill.id, bill])).values()]
    .sort((left, right) => (right.billDate ?? "").localeCompare(left.billDate ?? "") || left.id.localeCompare(right.id));
  const historyWarnings = [...projectHistory.warnings];
  const verificationPending = actor.role !== "DATA_ENTRY" &&
    (!ledger.booksListingComplete || amounts.unlinked.length > 0 || historyWarnings.length > 0);
  if (verificationPending && !historyWarnings.length)
    historyWarnings.push("The complete bill history for this job has not been verified. Some company bills may still need an exact job link.");
  const historySources = actor.role === "DATA_ENTRY" ? [] : ledger.destinations
    .filter((source) => source.companyId === job.companyId)
    .map(({ organizationId, dataCenter, environment }) => ({ organizationId, dataCenter, environment }));
  const incoming = historySources.length ? await db.incomingSyncState.findMany({
    where: { target: "ZOHO", companyId: job.companyId, OR: historySources },
    select: { status: true, nextRunAt: true, backoffUntil: true },
  }) : [];
  const now = Date.now();
  const quotaDelays = incoming.flatMap((source) => [source.backoffUntil,
    source.status === "WAITING_QUOTA" ? source.nextRunAt : null])
    .filter((time): time is Date => time !== null && time.valueOf() > now);
  const booksHistory = actor.role === "DATA_ENTRY" ? undefined : {
    verificationPending, warnings: [...new Set(historyWarnings)],
    refreshPausedUntil: quotaDelays.length ? new Date(Math.max(...quotaDelays.map((time) => time.valueOf()))).toISOString() : null,
  };
  await freshFinancialActor(actor);
  await requireCompanyAccess(actor, job.companyId);
  return {
    job: ledgerJobDto(ledger, current),
    bills: job.bills.map(serializeBill),
    booksBills,
    booksHistory,
    financialCompleteness: {
      complete: amounts.complete,
      unlinkedBooksBillCount: amounts.unlinked.length,
      notes: amounts.complete
        ? []
        : [
            "Job totals are unavailable until imported Books bills have verified job links and current financial details.",
          ],
    },
  };
}

function ledgerJobDto(
  ledger: FinancialLedger,
  job: FinancialLedger["jobs"][number],
) {
  const base = serializeJob(ledger.actor, {
    ...job,
    bills: job.bills.filter((bill) => bill.currency === job.currency),
  });
  const { totals, complete, linked } = ledgerJobAmounts(ledger, job);
  const sourceValid =
    (!job.externalCrmId || job.crmSnapshots.length > 0) &&
    job.crmSnapshots.every((snapshot) => snapshot.linkStatus === "READY");
  const source = job.crmSnapshots[0];
  const valuesAgree = job.crmSnapshots.every(
    (snapshot) =>
      snapshot.amount === source?.amount &&
      snapshot.approvedVariations === source?.approvedVariations,
  );
  const contractValue =
    !canViewFinancialSummary(ledger.actor) || !sourceValid || !valuesAgree
      ? null
      : source
        ? source.amount
        : base.contractValue;
  const approvedVariations =
    !canViewFinancialSummary(ledger.actor) || !sourceValid || !valuesAgree
      ? null
      : source
        ? source.approvedVariations
        : base.approvedVariations;
  const adjustedValue =
    contractValue !== null && approvedVariations !== null
      ? sumKnown([contractValue, approvedVariations])
      : null;
  const expenses = complete ? totals.recognizedExpenses : null;
  const profit = nullableProfit(adjustedValue, expenses);
  const ratio =
    adjustedValue && expenses !== null && new Decimal(adjustedValue).gt(0)
      ? new Decimal(expenses).dividedBy(adjustedValue).times(100)
      : null;
  return {
    ...base,
    companyName: job.company.name.replace(/^\[CONNECTION CHECK\]\s*/, ""),
    adjustedValue,
    contractValue,
    approvedVariations,
    recognizedExpenses: expenses,
    paidExpenses: complete ? totals.paidExpenses : null,
    outstanding: complete ? totals.outstanding : null,
    estimatedProfit: profit,
    remainingBudget: profit,
    expensePercentage: ratio?.toFixed(2) ?? null,
    budgetStatus:
      profit === null
        ? "VALUE_UNAVAILABLE"
        : new Decimal(profit).lt(0)
          ? "OVER_BUDGET"
          : ratio!.gte(90)
            ? "NEAR_LIMIT"
            : "WITHIN_BUDGET",
    billCount:
      ledger.nativeBills.filter((bill) => bill.jobId === job.id).length +
      linked.length,
    stage: job.crmSnapshots[0]?.stage ?? null,
    sourceUpdatedAt: job.crmSnapshots[0]?.sourceModifiedAt ?? null,
  };
}

export async function dashboard(actor: Actor, params: URLSearchParams) {
  const currency = (params.get("currency") || "AED").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency))
    throw new HttpError(422, "Select a valid currency.");
  const jobId = params.get("jobId") || undefined;
  if (jobId && jobId.length > 100)
    throw new HttpError(422, "Invalid job selection.");
  const ledger = await loadFinancialLedger(
    actor,
    params.get("companyId") || undefined,
    currency,
  );
  actor = ledger.actor;
  if (jobId && !ledger.jobs.some((job) => job.id === jobId))
    throw new HttpError(404, "Job not found in this currency and company.");
  const selectedJobs = ledger.jobs.filter((job) => !jobId || job.id === jobId);
  const jobs = selectedJobs.map((job) => ledgerJobDto(ledger, job));
  const bills = ledger.nativeBills.filter(
    (bill) => !jobId || bill.jobId === jobId,
  );
  const mirrors = ledger.mirrors.filter(
    (bill) =>
      bill.currencyCode === currency && (!jobId || bill.jobId === jobId),
  );
  const unlinked = ledger.mirrors.filter(
    (bill) =>
      !bill.jobId &&
      bill.amounts.recognized !== false &&
      (!jobId || bill.companyId === selectedJobs[0]?.companyId),
  );
  const jobFinancialsComplete =
    !ledger.truncated &&
    ledger.booksListingComplete &&
    unlinked.length === 0 &&
    !ledger.links.ambiguousCount &&
    mirrors.every((bill) => bill.amounts.complete) &&
    jobs.every(
      (job) =>
        job.recognizedExpenses !== null &&
        job.paidExpenses !== null &&
        job.outstanding !== null,
    );
  const valuesAvailable =
    canViewFinancialSummary(actor) &&
    jobs.length > 0 &&
    jobs.every((job) => job.adjustedValue !== null);
  const jobValue = valuesAvailable
    ? sumKnown(jobs.map((job) => job.adjustedValue))
    : null;
  const recordedContractValue =
    canViewFinancialSummary(actor) && jobs.length > 0 && !ledger.truncated
      ? sumKnown(jobs.map((job) => job.contractValue))
      : null;
  const totals = aggregateAmounts([
    ...bills.map(nativeFinancialAmounts),
    ...mirrors.map((bill) => bill.amounts),
  ]);
  if (ledger.truncated || (jobId && !jobFinancialsComplete))
    for (const key of Object.keys(totals) as (keyof typeof totals)[])
      totals[key] = null;
  const monthly = new Map<string, Decimal>();
  const vendors = new Map<string, { name: string; amount: Decimal }>();
  const addExpense = (
    vendorId: string,
    name: string,
    date: Date | null,
    amount: string | null,
  ) => {
    if (amount === null) return;
    const cost = new Exact(amount);
    if (date) {
      const month = date.toISOString().slice(0, 7);
      monthly.set(month, (monthly.get(month) ?? new Exact(0)).plus(cost));
    }
    const vendor = vendors.get(vendorId) ?? { name, amount: new Exact(0) };
    vendor.amount = vendor.amount.plus(cost);
    vendors.set(vendorId, vendor);
  };
  for (const bill of bills.filter((bill) =>
    isRecognizedBillStatus(bill.status),
  )) {
    addExpense(
      `${bill.companyId}:native:${bill.vendorId}`,
      bill.vendor.name,
      bill.invoiceDate,
      nativeFinancialAmounts(bill).recognizedExpenses,
    );
  }
  for (const bill of mirrors.filter((bill) => bill.amounts.recognized === true))
    addExpense(
      `${bill.companyId}:${bill.organizationId}:${bill.vendorId}`,
      bill.vendorName,
      bill.billDate,
      bill.amounts.recognizedExpenses,
    );
  const notes: string[] = [];
  if (unlinked.length)
    notes.push(
      `${unlinked.length} imported Books bills have no verified job link; job expense and profit totals are unavailable.`,
    );
  if (!ledger.booksListingComplete)
    notes.push(
      "The latest Books import is incomplete. These are the available imported records.",
    );
  if (mirrors.some((bill) => !bill.amounts.complete))
    notes.push(
      "Some Books bills have unavailable financial details; affected totals are unavailable.",
    );
  if (ledger.truncated)
    notes.push(
      "The report limit was reached. Totals are unavailable; narrow the company selection.",
    );
  if (ledger.crmReviewJobCount)
    notes.push(
      `${ledger.crmReviewJobCount} CRM job records need review and are excluded from the recorded contract total.`,
    );
  if (ledger.crmJobCount)
    notes.push(
      "Recorded contract value uses verified CRM job amounts. Unknown approved variations are not treated as zero.",
    );
  return {
    currency,
    scope: actor.role === "DATA_ENTRY" ? "YOUR_BILLS" : "ORGANIZATION",
    period: "LIFETIME",
    accountingBasis: "VAT_EXCLUSIVE",
    metrics: {
      jobValue,
      recordedContractValue,
      ...totals,
      billCount: bills.length + mirrors.length,
      estimatedProfit:
        valuesAvailable && jobFinancialsComplete
          ? nullableProfit(jobValue, totals.recognizedExpenses)
          : null,
      overBudgetCount: jobs.filter((job) => job.budgetStatus === "OVER_BUDGET")
        .length,
      pendingCount: bills.filter((bill) => bill.status === "PENDING_APPROVAL")
        .length,
      readyCount: bills.filter((bill) => bill.status === "READY").length,
      draftCount: bills.filter((bill) => bill.status === "DRAFT").length,
      missingJobValues: jobs.filter(
        (job) =>
          job.adjustedValue === null ||
          new Decimal(job.adjustedValue).lessThanOrEqualTo(0),
      ).length,
    },
    jobs,
    jobOptions: ledger.jobs.map((job) => ({
      id: job.id,
      companyId: job.companyId,
      jobNumber: job.jobNumber,
      name: job.name,
    })),
    recentBills: bills.slice(0, 6).map(serializeBill),
    recentBooksBills: mirrors
      .slice(0, 6)
      .map((bill) => importedBillSummary(bill, ledger.jobs)),
    currencies: ledger.currencies,
    source: {
      booksBillCount: mirrors.length,
      nativeBillCount: bills.length,
      excludedDuplicateNativeCount: ledger.links.duplicates.size,
      unlinkedBooksBillCount: unlinked.length,
      staleBooksBillCount: ledger.staleBooksBillCount,
      unknownFinancialBillCount: mirrors.filter(
        (bill) => !bill.amounts.complete,
      ).length,
      booksLatestImportAt:
        ledger.runs
          .find((run) => run.status === "COMPLETE")
          ?.completedAt?.toISOString() ?? null,
      booksListingComplete: ledger.booksListingComplete,
      jobFinancialsComplete,
      notes,
      crmJobCount: ledger.crmJobCount,
      crmReviewJobCount: ledger.crmReviewJobCount,
    },
    monthlyExpenses: (totals.recognizedExpenses === null ? [] : [...monthly])
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-12)
      .map(([month, amount]) => ({ month, amount: exactMoney(amount) })),
    vendorExpenses: (totals.recognizedExpenses === null
      ? []
      : [...vendors.values()]
    )
      .sort((a, b) => b.amount.comparedTo(a.amount))
      .map(({ name, amount }) => ({ name, amount: exactMoney(amount) })),
  };
}

export async function auditEvents(actor: Actor) {
  if (!canViewAuditLog(actor))
    throw new HttpError(
      403,
      "Only Admin and Accounts may view the organization audit log.",
    );
  return db.auditLog.findMany({
    where: await companyFilter(actor),
    include: { actor: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}
