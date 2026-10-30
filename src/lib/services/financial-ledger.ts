import "server-only";
import { Prisma, type BooksBill } from "@prisma/client";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { companyFilter } from "@/lib/company";
import { HttpError } from "@/lib/http";
import { billScope } from "@/lib/permissions";
import { isRecognizedBillStatus } from "@/lib/finance";
import {
  aggregateAmounts,
  booksFinancialAmounts,
  decimalAmount,
  exactMoney,
  jsonRecord,
  type FinancialAmounts,
} from "@/lib/books-financials";
import { billInclude } from "./bills";

const limit = 50_000;
const mirrorFields = [
  "id",
  "companyId",
  "organizationId",
  "dataCenter",
  "environment",
  "externalBillId",
  "billNumber",
  "vendorId",
  "vendorName",
  "status",
  "currencyCode",
  "billDate",
  "total",
  "taxTotal",
  "balance",
  "paymentMade",
  "vendorCreditsApplied",
  "detailImportRunId",
  "lastImportRunId",
  "isStale",
] as const;
const taxGuardKeys = [
  "is_reverse_charge_applied",
  "is_tds_applied",
  "tds_total",
  "tax_amount_withheld",
  "withholding_tax_total",
  "reverse_charge_vat_total",
  "acquisition_vat_total",
] as const;
type LedgerMirror = Pick<BooksBill, (typeof mirrorFields)[number]> & {
  company: { name: string };
  sourceDetail: unknown;
};
async function readMirrorProjection(
  tx: Prisma.TransactionClient,
  companyIds: string[],
): Promise<LedgerMirror[]> {
  if (!companyIds.length) return [];
  const values = Prisma.join(
    taxGuardKeys.flatMap((key) => [
      Prisma.sql`${key}`,
      Prisma.sql`JSON_EXTRACT(b.sourceDetail, ${`$.${key}`})`,
    ]),
  );
  const present = Prisma.join(
    taxGuardKeys.flatMap((key) => [
      Prisma.sql`${key}`,
      Prisma.sql`JSON_CONTAINS_PATH(b.sourceDetail, 'one', ${`$.${key}`})`,
    ]),
  );
  // Never transfer full supplier/bill source JSON to an aggregate request. Keep
  // explicit presence bits so a missing tax key remains different from null.
  const rows = await tx.$queryRaw<
    (Pick<BooksBill, (typeof mirrorFields)[number]> & {
      companyName: string;
      taxDetails: unknown;
    })[]
  >(Prisma.sql`
    SELECT ${Prisma.join(mirrorFields.map((field) => Prisma.raw(`b.\`${field}\``)))}, c.name AS companyName,
      CASE WHEN JSON_TYPE(b.sourceDetail) = 'OBJECT' THEN JSON_OBJECT('values', JSON_OBJECT(${values}), 'present', JSON_OBJECT(${present})) ELSE NULL END AS taxDetails
    FROM BooksBill b JOIN Company c ON c.id = b.companyId
    WHERE b.companyId IN (${Prisma.join(companyIds)})
    ORDER BY b.billDate DESC, b.id ASC LIMIT ${limit + 1}`);
  return rows.map(({ companyName, taxDetails, ...row }) => {
    const packed =
      typeof taxDetails === "string"
        ? jsonRecord(JSON.parse(taxDetails))
        : jsonRecord(taxDetails);
    const values = jsonRecord(packed.values),
      present = jsonRecord(packed.present);
    const sourceDetail =
      taxDetails === null
        ? null
        : Object.fromEntries(
            taxGuardKeys
              .filter((key) => present[key] === 1 || present[key] === true)
              .map((key) => [key, values[key]]),
          );
    return { ...row, company: { name: companyName }, sourceDetail };
  });
}
export const realJobFilter: Prisma.JobWhereInput = {
  OR: [{ isDemo: false }, { externalCrmId: { not: null } }],
};
export async function freshFinancialActor(actor: Actor): Promise<Actor> {
  const current = await db.user.findUnique({
    where: { id: actor.id },
    select: { active: true, role: true },
  });
  if (!current?.active || current.role !== actor.role)
    throw new HttpError(403, "Your access changed. Sign in again.");
  return { ...actor, role: current.role };
}
type Native = Prisma.BillGetPayload<{ include: typeof billInclude }>;
export function nativeFinancialAmounts(bill: Native): FinancialAmounts {
  const recognized = isRecognizedBillStatus(bill.status);
  return {
    invoicedTotal: recognized ? bill.total.toFixed(2) : "0.00",
    recognizedExpenses: recognized
      ? bill.subtotal.minus(bill.discount).toFixed(2)
      : "0.00",
    paidExpenses: recognized ? bill.paidAmount.toFixed(2) : "0.00",
    outstanding: recognized
      ? bill.total.minus(bill.paidAmount).toFixed(2)
      : "0.00",
    creditsApplied: "0.00",
  };
}
export type MirrorIdentity = {
  id: string;
  companyId: string;
  organizationId: string;
  externalBillId: string;
  dataCenter: string;
  environment: string;
};
type NativeIdentity = {
  id: string;
  companyId: string;
  jobId: string;
  syncRecords: {
    target: string;
    externalId: string | null;
    organizationId: string | null;
  }[];
};
type Destination = {
  companyId: string;
  organizationId: string;
  dataCenter: string;
  environment: string;
};
type History = {
  billId: string;
  organizationId: string | null;
  snapshot: unknown;
};
/** Only confirmed provider identifiers can relate an imported bill to a job.
 * Project names, PO strings and free text are deliberately not matching keys. */
export function nativeMirrorLinks(
  natives: NativeIdentity[],
  mirrors: MirrorIdentity[],
  destinations: Destination[],
  history: History[],
) {
  const duplicates = new Set<string>();
  const linkedJobs = new Map<string, string>();
  const conflictingMirrors = new Set<string>();
  let ambiguousCount = 0;
  for (const native of natives) {
    for (const sync of native.syncRecords.filter(
      (record) =>
        record.target === "ZOHO" && record.externalId && record.organizationId,
    )) {
      const candidates = mirrors.filter(
        (mirror) =>
          mirror.companyId === native.companyId &&
          mirror.organizationId === sync.organizationId &&
          mirror.externalBillId === sync.externalId,
      );
      if (!candidates.length) continue;
      // A mirrored provider identity must not be counted a second time locally.
      duplicates.add(native.id);
      const recorded = history
        .filter(
          (item) =>
            item.billId === native.id &&
            item.organizationId === sync.organizationId,
        )
        .map((item) => jsonRecord(jsonRecord(item.snapshot).destination));
      const contexts = recorded.length
        ? recorded
        : destinations.filter(
            (item) =>
              item.companyId === native.companyId &&
              item.organizationId === sync.organizationId,
          );
      const verified = candidates.filter((mirror) =>
        contexts.some(
          (context) =>
            context.dataCenter === mirror.dataCenter &&
            context.environment === mirror.environment,
        ),
      );
      if (
        verified.length === 1 &&
        !conflictingMirrors.has(verified[0].id) &&
        (!linkedJobs.has(verified[0].id) ||
          linkedJobs.get(verified[0].id) === native.jobId)
      )
        linkedJobs.set(verified[0].id, native.jobId);
      else {
        ambiguousCount++;
        for (const mirror of verified) {
          conflictingMirrors.add(mirror.id);
          linkedJobs.delete(mirror.id);
        }
      }
    }
  }
  return { duplicates, linkedJobs, ambiguousCount };
}

export async function loadFinancialLedger(
  actor: Actor,
  requestedCompanyId?: string,
  currency?: string,
) {
  actor = await freshFinancialActor(actor);
  const scope = await companyFilter(actor, requestedCompanyId);
  const importedAllowed = actor.role !== "DATA_ENTRY";
  const companyIds =
    typeof scope.companyId === "string"
      ? [scope.companyId]
      : scope.companyId.in;
  const data = await db.$transaction(
    async (tx) => {
      const [
        jobs,
        nativeBills,
        mirrors,
        destinations,
        history,
        runs,
        currencies,
        crmJobCount,
        crmReviewJobCount,
      ] = await Promise.all([
        tx.job.findMany({
          where: { ...scope, currency, ...realJobFilter },
          include: {
            company: { select: { name: true } },
            bills: { where: billScope(actor) },
            crmSnapshots: {
              where: { isStale: false },
              orderBy: { importedAt: "desc" },
              select: {
                linkStatus: true,
                stage: true,
                sourceModifiedAt: true,
                amount: true,
                approvedVariations: true,
              },
            },
          },
          orderBy: { jobNumber: "asc" },
          take: limit + 1,
        }),
        tx.bill.findMany({
          where: {
            ...scope,
            ...billScope(actor),
            currency,
            job: realJobFilter,
          },
          include: billInclude,
          orderBy: { createdAt: "desc" },
          take: limit + 1,
        }),
        importedAllowed ? readMirrorProjection(tx, companyIds) : [],
        importedAllowed
          ? tx.companyIntegrationDestination.findMany({
              where: { ...scope, target: "ZOHO" },
              select: {
                companyId: true,
                organizationId: true,
                dataCenter: true,
                environment: true,
              },
            })
          : [],
        importedAllowed
          ? tx.integrationJob.findMany({
              where: {
                bill: { ...scope, currency },
                target: "ZOHO",
                operation: "CREATE_BILL",
              },
              select: { billId: true, organizationId: true, snapshot: true },
            })
          : [],
        importedAllowed
          ? tx.booksImportRun.findMany({
              where: scope,
              orderBy: { startedAt: "desc" },
              select: {
                companyId: true,
                organizationId: true,
                dataCenter: true,
                environment: true,
                listingComplete: true,
                status: true,
                startedAt: true,
                completedAt: true,
                runKind: true,
              },
            })
          : [],
        importedAllowed
          ? tx.booksBill.findMany({
              where: { ...scope, isStale: false },
              distinct: ["currencyCode"],
              select: { currencyCode: true },
            })
          : [],
        importedAllowed
          ? tx.crmJobSnapshot.count({
              where: {
                ...scope,
                currencyCode: currency,
                isStale: false,
                normalizedJobNumber: { not: null },
              },
            })
          : 0,
        importedAllowed
          ? tx.crmJobSnapshot.count({
              where: {
                ...scope,
                currencyCode: currency,
                isStale: false,
                normalizedJobNumber: { not: null },
                OR: [
                  { canonicalJobId: null },
                  { linkStatus: { not: "READY" } },
                ],
              },
            })
          : 0,
      ]);
      return {
        jobs,
        nativeBills,
        mirrors,
        destinations,
        history,
        runs,
        currencies,
        crmJobCount,
        crmReviewJobCount,
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: 30_000,
    },
  );
  // A revocation during this read cannot expose the completed response.
  await freshFinancialActor(actor);
  const after = await companyFilter(actor, requestedCompanyId);
  if (JSON.stringify(scope) !== JSON.stringify(after))
    throw new HttpError(403, "Your company access changed. Reload this page.");
  const truncated = [data.jobs, data.nativeBills, data.mirrors].some(
    (rows) => rows.length > limit,
  );
  const currentMirrors = data.mirrors.filter((bill) => !bill.isStale);
  const links = nativeMirrorLinks(
    data.nativeBills,
    // A confirmed deleted provider record must not resurrect its older native
    // amount. Its identity still supersedes the local copy; its cost is absent.
    data.mirrors,
    data.destinations,
    data.history,
  );
  const nativeBills = data.nativeBills.filter(
    (bill) => !links.duplicates.has(bill.id),
  );
  const mirrors = currentMirrors.map((bill) => ({
    ...bill,
    jobId: links.linkedJobs.get(bill.id) ?? null,
    amounts: booksFinancialAmounts(bill),
  }));
  const latestRuns = new Map<string, (typeof data.runs)[number]>();
  for (const run of data.runs) {
    const key = [
      run.companyId,
      run.organizationId,
      run.dataCenter,
      run.environment,
    ].join("|");
    // A failed or incremental refresh does not erase the last verified full
    // inventory. Conversely an incremental page is never a full baseline.
    if (!latestRuns.has(key)) latestRuns.set(key, run);
    const baseline = latestRuns.get(key)!;
    if (
      !(
        baseline.runKind === "FULL" &&
        baseline.listingComplete &&
        baseline.status === "COMPLETE"
      ) &&
      run.runKind === "FULL" &&
      run.listingComplete &&
      run.status === "COMPLETE"
    )
      latestRuns.set(key, run);
  }
  const booksListingComplete = [...latestRuns.values()].every(
    (run) =>
      run.runKind === "FULL" &&
      run.listingComplete &&
      run.status === "COMPLETE",
  );
  return {
    actor,
    ...data,
    nativeBills,
    mirrors,
    links,
    truncated,
    booksListingComplete,
    staleBooksBillCount: data.mirrors.filter((bill) => bill.isStale).length,
    currencies: [
      ...new Set([
        ...data.currencies.map((row) => row.currencyCode),
        ...data.jobs.map((job) => job.currency),
        ...data.nativeBills.map((bill) => bill.currency),
      ]),
    ].sort(),
  };
}
export type FinancialLedger = Awaited<ReturnType<typeof loadFinancialLedger>>;
export function importedBillSummary(
  bill: FinancialLedger["mirrors"][number],
  jobs: { id: string; jobNumber: string }[],
) {
  return {
    id: bill.id,
    billNumber: bill.billNumber,
    companyId: bill.companyId,
    companyName: bill.company.name.replace(/^\[CONNECTION CHECK\]\s*/, ""),
    vendorName: bill.vendorName,
    currency: bill.currencyCode,
    total: bill.total,
    status: bill.status,
    billDate: bill.billDate?.toISOString().slice(0, 10) ?? null,
    jobId: bill.jobId,
    jobNumber: jobs.find((job) => job.id === bill.jobId)?.jobNumber ?? null,
    href: `/bills/books/${bill.id}`,
  };
}
export function ledgerJobAmounts(
  ledger: FinancialLedger,
  job: { id: string; companyId: string; currency: string },
) {
  const linked = ledger.mirrors.filter((bill) => bill.jobId === job.id);
  const unlinked = ledger.mirrors.filter(
    (bill) =>
      bill.companyId === job.companyId &&
      !bill.jobId &&
      bill.amounts.recognized !== false,
  );
  const nativeLinked = ledger.nativeBills.filter(
    (bill) => bill.jobId === job.id,
  );
  const nativeCurrencyMismatch =
    ledger.jobs
      .find((row) => row.id === job.id)
      ?.bills.some((bill) => bill.currency !== job.currency) ?? false;
  const totals = aggregateAmounts([
    ...nativeLinked
      .filter((bill) => bill.currency === job.currency)
      .map(nativeFinancialAmounts),
    ...linked
      .filter((bill) => bill.currencyCode === job.currency)
      .map((bill) => bill.amounts),
  ]);
  const complete =
    !ledger.truncated &&
    ledger.booksListingComplete &&
    unlinked.length === 0 &&
    !nativeCurrencyMismatch &&
    nativeLinked.every((bill) => bill.currency === job.currency) &&
    linked.every(
      (bill) => bill.amounts.complete && bill.currencyCode === job.currency,
    ) &&
    !ledger.links.ambiguousCount;
  return { totals, linked, unlinked, complete };
}
export function nullableProfit(value: string | null, expenses: string | null) {
  const amount = decimalAmount(value),
    cost = decimalAmount(expenses);
  return amount && cost && amount.gt(0) ? exactMoney(amount.minus(cost)) : null;
}
