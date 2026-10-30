import "server-only";
import { Prisma } from "@prisma/client";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { companyFilter } from "@/lib/company";
import { HttpError } from "@/lib/http";
import { billScope, canCreateBill } from "@/lib/permissions";
import {
  freshFinancialActor,
  nativeMirrorLinks,
  realJobFilter,
} from "./financial-ledger";
import { crmJobSnapshotFilter } from "./crm-job-import";
import { loadBooksProjectHistory } from "./books-project-history";

const maximum = 20;
type RelatedJob = { id: string; canonicalJobId: string | null; href: string; jobNumber: string | null;
  displayReference: string; name: string; companyId: string; companyName: string };
const company = { select: { name: true } } as const;
const jobSelect = {
  id: true,
  jobNumber: true,
  name: true,
  companyId: true,
  company,
  customer: true,
  currency: true,
  externalCrmId: true,
} as const;
const norm = (value: string) => value.normalize("NFKC").trim().toUpperCase();
const unique = <T extends { id: string }>(rows: T[]) => [
  ...new Map(rows.map((row) => [row.id, row])).values(),
];
const column = (name: string) => Prisma.raw(`\`${name}\``);
// Identifiers are code constants. Request values remain SQL parameters; LOWER
// makes case-insensitive reference matching work with our binary collation.
async function matchingIds(
  table: "Job" | "Bill" | "BooksBill" | "CrmJobSnapshot",
  fields: string[],
  exactFields: string[],
  scope: Prisma.Sql,
  query: string,
  identifiers: string[],
  exactOnly: boolean,
) {
  const pattern = `%${query.toLowerCase().replace(/[=%_]/g, "=$&")}%`;
  const fuzzy = Prisma.join(
    fields.map(
      (field) => Prisma.sql`LOWER(${column(field)}) LIKE ${pattern} ESCAPE '='`,
    ),
    " OR ",
  );
  const exact = Prisma.join(
    exactFields.map(
      (field) =>
        Prisma.sql`LOWER(${column(field)}) IN (${Prisma.join(identifiers.map((value) => value.toLowerCase()))})`,
    ),
    " OR ",
  );
  const rows = await db.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT id FROM ${column(table)} WHERE (${scope}) AND (${exactOnly ? exact : Prisma.sql`(${fuzzy}) OR (${exact})`}) ORDER BY CASE WHEN (${exact}) THEN 0 ELSE 1 END, ${column(exactFields[0])}, id LIMIT ${maximum + 1}`,
  );
  return rows.map((row) => row.id);
}

export async function searchDashboard(actor: Actor, params: URLSearchParams) {
  actor = await freshFinancialActor(actor);
  const query = (params.get("q") ?? "").trim();
  if (
    query.length < 2 ||
    query.length > 100 ||
    /[\u0000-\u001f\u007f]/.test(query)
  )
    throw new HttpError(
      422,
      "Enter 2–100 characters for a job reference or bill number.",
    );
  const requestedCompanyId = params.get("companyId") || undefined;
  const scope = await companyFilter(actor, requestedCompanyId);
  const importedAllowed = actor.role !== "DATA_ENTRY";
  const companyIds =
    typeof scope.companyId === "string"
      ? [scope.companyId]
      : scope.companyId.in;
  const sqlScope = companyIds.length
    ? Prisma.sql`companyId IN (${Prisma.join(companyIds)})`
    : Prisma.sql`1 = 0`;
  const snapshotScope = importedAllowed
    ? await crmJobSnapshotFilter(actor, requestedCompanyId)
    : null;
  const authorizedSnapshots = snapshotScope
    ? await db.crmJobSnapshot.findMany({
        where: {
          AND: [snapshotScope, { isStale: false, canonicalJobId: null }],
        },
        select: { id: true },
        take: 50_001,
      })
    : [];
  if (authorizedSnapshots.length > 50_000)
    throw new HttpError(
      422,
      "Narrow the company selection before searching this job inventory.",
    );
  const identifiers = [
    ...new Set([
      query,
      norm(query),
      ...(/^\d+$/.test(query) ? [`JOB-${query}`] : []),
    ]),
  ];
  const realJobSql = Prisma.sql`(isDemo = 0 OR externalCrmId IS NOT NULL)`;
  const findJobs = async (exact: boolean) =>
    db.job.findMany({
      where: {
        ...scope,
        id: {
          in: await matchingIds(
            "Job",
            ["id", "externalCrmId", "jobNumber", "name", "customer"],
            ["jobNumber", "id", "externalCrmId"],
            Prisma.sql`(${sqlScope}) AND (${realJobSql})`,
            query,
            identifiers,
            exact,
          ),
        },
        AND: [realJobFilter],
      },
      select: jobSelect,
    });
  const findSnapshots = async (exact: boolean) =>
    snapshotScope && authorizedSnapshots.length
      ? db.crmJobSnapshot.findMany({
          where: {
            AND: [
              snapshotScope,
              {
                canonicalJobId: null,
                isStale: false,
                id: {
                  in: await matchingIds(
                    "CrmJobSnapshot",
                    ["normalizedJobNumber", "externalCrmId", "name"],
                    ["normalizedJobNumber", "externalCrmId"],
                    Prisma.sql`id IN (${Prisma.join(authorizedSnapshots.map((row) => row.id))})`,
                    query,
                    identifiers,
                    exact,
                  ),
                },
              },
            ],
          },
          include: { company },
        })
      : [];
  const findNative = async (exact: boolean) =>
    db.bill.findMany({
      where: {
        ...scope,
        ...billScope(actor),
        id: {
          in: await matchingIds(
            "Bill",
            ["invoiceNumber"],
            ["invoiceNumber"],
            Prisma.sql`(${sqlScope}) ${actor.role === "DATA_ENTRY" ? Prisma.sql`AND createdById = ${actor.id}` : Prisma.empty}`,
            query,
            [query],
            exact,
          ),
        },
      },
      include: {
        company,
        vendor: { select: { name: true } },
        job: { select: { id: true, jobNumber: true } },
        syncRecords: true,
      },
    });
  const findBooks = async (exact: boolean) =>
    importedAllowed
      ? db.booksBill.findMany({
          where: {
            ...scope,
            isStale: false,
            id: {
              in: await matchingIds(
                "BooksBill",
                ["billNumber"],
                ["billNumber"],
                Prisma.sql`(${sqlScope}) AND isStale = 0`,
                query,
                [query],
                exact,
              ),
            },
          },
          select: {
            id: true,
            billNumber: true,
            companyId: true,
            company,
            vendorName: true,
            currencyCode: true,
            total: true,
            organizationId: true,
            externalBillId: true,
            dataCenter: true,
            environment: true,
          },
        })
      : [];
  const [j1, j2, s1, s2, n1, n2, b1, b2] = await Promise.all([
    findJobs(true),
    findJobs(false),
    findSnapshots(true),
    findSnapshots(false),
    findNative(true),
    findNative(false),
    findBooks(true),
    findBooks(false),
  ]);
  const natives = unique([...n1, ...n2]),
    mirrors = unique([...b1, ...b2]);
  const projectHistory = importedAllowed ? await loadBooksProjectHistory(actor, requestedCompanyId) : { relations: [], warnings: [] };
  const matchedMirrorIds = new Set(mirrors.map((bill) => bill.id));
  const matchedRelations = projectHistory.relations.filter((relation) => matchedMirrorIds.has(relation.billId) ||
    [relation.displayReference, relation.jobNumber, relation.name, relation.externalCrmId].some((value) => value && norm(value).includes(norm(query))));
  const s3 = snapshotScope && matchedRelations.length ? await db.crmJobSnapshot.findMany({
    where: { AND: [snapshotScope, { id: { in: [...new Set(matchedRelations.map((relation) => relation.snapshotId))] },
      canonicalJobId: null, isStale: false }] }, include: { company },
  }) : [];
  const visibleSnapshotIds = new Set(authorizedSnapshots.map((row) => row.id));
  const historyCompanies = await db.company.findMany({ where: { id: { in: [...new Set(projectHistory.relations.map((relation) => relation.companyId))] }, active: true },
    select: { id: true, name: true } });
  const companyNames = new Map(historyCompanies.map((row) => [row.id, row.name.replace(/^\[CONNECTION CHECK\]\s*/, "")]));
  const snapshotRelations = (id: string) => projectHistory.relations.filter((relation) => relation.snapshotId === id);
  const sourceReference = (id: string) => {
    const references = [...new Set(snapshotRelations(id).map((relation) => relation.displayReference).filter((value): value is string => Boolean(value)))];
    return references.length === 1 ? references[0] : null;
  };
  // Resolve bill-to-job identity from confirmed sync identifiers even when the
  // Books bill number was edited after the local bill was sent.
  const linkedNative = mirrors.length
    ? await db.bill.findMany({
        where: {
          ...scope,
          ...billScope(actor),
          syncRecords: {
            some: {
              target: "ZOHO",
              OR: mirrors.map((bill) => ({
                organizationId: bill.organizationId,
                externalId: bill.externalBillId,
              })),
            },
          },
        },
        include: { syncRecords: true, job: { select: { jobNumber: true } } },
        orderBy: { id: "asc" },
        take: 101,
      })
    : [];
  const [destinations, history] = importedAllowed
    ? await Promise.all([
        db.companyIntegrationDestination.findMany({
          where: { ...scope, target: "ZOHO" },
          select: {
            companyId: true,
            organizationId: true,
            dataCenter: true,
            environment: true,
          },
        }),
        db.integrationJob.findMany({
          where: {
            billId: { in: linkedNative.map((bill) => bill.id) },
            target: "ZOHO",
            operation: "CREATE_BILL",
          },
          select: { billId: true, organizationId: true, snapshot: true },
        }),
      ])
    : [[], []];
  const links = nativeMirrorLinks(linkedNative, mirrors, destinations, history);
  // An incomplete candidate set cannot prove that a Books identity has only
  // one job. Ask for a narrower search instead of assigning the first match.
  const linkCandidatesTruncated = linkedNative.length > 100;
  if (linkCandidatesTruncated) links.linkedJobs.clear();
  const relatedIds = [
    ...new Set([
      ...natives.map((bill) => bill.jobId),
      ...links.linkedJobs.values(),
      ...matchedRelations.flatMap((relation) => relation.canonicalJobId ? [relation.canonicalJobId] : []),
    ]),
  ];
  const relatedCandidates = relatedIds.length
    ? await db.job.findMany({
        where: { ...scope, id: { in: relatedIds }, AND: [realJobFilter] },
        select: jobSelect,
      })
    : [];
  const relatedById = new Map(relatedCandidates.map((job) => [job.id, job]));
  const relatedJob = (id: string | null): RelatedJob[] => {
    const job = id ? relatedById.get(id) : undefined;
    return job
      ? [
          {
            id: job.id,
            canonicalJobId: job.id,
            href: `/jobs/${job.id}`,
            jobNumber: job.jobNumber,
            displayReference: job.jobNumber,
            name: job.name,
            companyId: job.companyId,
            companyName: job.company.name.replace(
              /^\[CONNECTION CHECK\]\s*/,
              "",
            ),
          },
        ]
      : [];
  };
  const projectRelatedJobs = (billId: string) => unique(projectHistory.relations.filter((relation) => relation.billId === billId)
    .flatMap<RelatedJob>((relation) => relation.canonicalJobId ? relatedJob(relation.canonicalJobId) : visibleSnapshotIds.has(relation.snapshotId) ? [{
      id: relation.snapshotId, canonicalJobId: null as string | null, href: `/jobs/crm/${relation.snapshotId}`,
      jobNumber: relation.jobNumber, displayReference: sourceReference(relation.snapshotId) ?? relation.externalCrmId, name: relation.name ?? "Imported CRM deal",
      companyId: relation.companyId, companyName: companyNames.get(relation.companyId) ?? "",
    }] : []));
  const ranks = new Map<string, number>();
  const rankJob = (id: string, rank: number) =>
    ranks.set(id, Math.min(rank, ranks.get(id) ?? 1));
  for (const job of [...j1, ...j2])
    rankJob(
      job.id,
      identifiers.map(norm).includes(norm(job.jobNumber)) ||
        norm(job.id) === norm(query) ||
        job.externalCrmId === query
        ? 0
        : 1,
    );
  for (const bill of natives)
    if (relatedById.has(bill.jobId))
      rankJob(bill.jobId, norm(bill.invoiceNumber) === norm(query) ? 0 : 1);
  for (const bill of mirrors) {
    const id = links.linkedJobs.get(bill.id);
    if (id && relatedById.has(id))
      rankJob(id, norm(bill.billNumber) === norm(query) ? 0 : 1);
    for (const relation of matchedRelations.filter((entry) => entry.billId === bill.id))
      rankJob(relation.canonicalJobId ?? relation.snapshotId, norm(bill.billNumber) === norm(query) ? 0 : 1);
  }
  const jobs = [
    ...unique([...j1, ...j2, ...relatedCandidates]).map((job) => ({
      id: job.id,
      canonicalJobId: job.id as string | null,
      jobNumber: job.jobNumber,
      displayReference: job.jobNumber,
      referenceKind: "JOB" as const,
      name: job.name,
      companyId: job.companyId as string | null,
      companyName: job.company.name.replace(/^\[CONNECTION CHECK\]\s*/, ""),
      customer: job.customer,
      currency: job.currency,
      canCreateBill: canCreateBill(actor),
      href: `/jobs/${job.id}`,
      rank: ranks.get(job.id) ?? 1,
    })),
    ...unique([...s1, ...s2, ...s3]).map((job) => ({
      id: job.id,
      canonicalJobId: null,
      jobNumber: job.jobNumber,
      displayReference: job.jobNumber ?? sourceReference(job.id) ?? job.externalCrmId,
      referenceKind: job.jobNumber ? "JOB" as const : "CRM_DEAL" as const,
      historyCompanies: [...new Set(snapshotRelations(job.id).map((relation) => relation.companyId))].map((id) => ({ id, name: companyNames.get(id) ?? "" })),
      name: job.name ?? "Imported CRM job",
      companyId: job.companyId,
      companyName:
        job.company?.name.replace(/^\[CONNECTION CHECK\]\s*/, "") ??
        "Unassigned company",
      customer: job.customerName ?? "",
      currency: job.currencyCode ?? "",
      canCreateBill: false,
      href: `/jobs/crm/${job.id}`,
      rank:
        ranks.get(job.id) === 0 || identifiers.map(norm).includes(norm(job.normalizedJobNumber ?? sourceReference(job.id) ?? "")) ||
        job.externalCrmId === query
          ? 0
          : 1,
    })),
  ].sort(
    (a, b) =>
      a.rank - b.rank ||
      a.displayReference.localeCompare(b.displayReference) ||
      a.id.localeCompare(b.id),
  );
  const bills = [
    ...natives
      .filter((bill) => !links.duplicates.has(bill.id))
      .map((bill) => ({
        id: bill.id,
        billNumber: bill.invoiceNumber,
        source: "NATIVE" as const,
        companyId: bill.companyId,
        companyName: bill.company.name.replace(/^\[CONNECTION CHECK\]\s*/, ""),
        vendorName: bill.vendor.name,
        currency: bill.currency,
        total: bill.total.toFixed(2),
        jobId: relatedById.has(bill.jobId) ? bill.jobId : null,
        jobNumber: relatedById.get(bill.jobId)?.jobNumber ?? null,
        relatedJobs: relatedJob(bill.jobId),
        href: `/bills/${bill.id}`,
      })),
    ...mirrors.map((bill) => {
      const linkedId = links.linkedJobs.get(bill.id) ?? null;
      const jobId = linkedId && relatedById.has(linkedId) ? linkedId : null;
      return {
        id: bill.id,
        billNumber: bill.billNumber,
        source: "BOOKS" as const,
        companyId: bill.companyId,
        companyName: bill.company.name.replace(/^\[CONNECTION CHECK\]\s*/, ""),
        vendorName: bill.vendorName,
        currency: bill.currencyCode,
        total: bill.total,
        jobId,
        jobNumber: jobId ? (relatedById.get(jobId)?.jobNumber ?? null) : null,
        relatedJobs: unique([...relatedJob(jobId), ...projectRelatedJobs(bill.id)]),
        href: `/bills/books/${bill.id}`,
      };
    }),
  ].sort(
    (a, b) =>
      Number(norm(b.billNumber) === norm(query)) -
        Number(norm(a.billNumber) === norm(query)) ||
      a.billNumber.localeCompare(b.billNumber) ||
      a.id.localeCompare(b.id),
  );
  await freshFinancialActor(actor);
  const after = await companyFilter(
    actor,
    params.get("companyId") || undefined,
  );
  const afterSnapshotScope = snapshotScope
    ? await crmJobSnapshotFilter(actor, requestedCompanyId)
    : null;
  if (
    JSON.stringify(scope) !== JSON.stringify(after) ||
    JSON.stringify(snapshotScope) !== JSON.stringify(afterSnapshotScope)
  )
    throw new HttpError(403, "Your company access changed. Search again.");
  if (matchedRelations.length && JSON.stringify(projectHistory.relations) !== JSON.stringify((await loadBooksProjectHistory(actor, requestedCompanyId)).relations))
    throw new HttpError(409, "Project history changed during search. Search again.");
  return {
    query,
    jobs: jobs.slice(0, maximum).map((job) => {
      const { rank, ...result } = job;
      void rank;
      return result;
    }),
    bills: bills.slice(0, maximum),
    hasMore:
      jobs.length > maximum ||
      bills.length > maximum ||
      linkCandidatesTruncated ||
      [j1, j2, s1, s2, n1, n2, b1, b2].some((rows) => rows.length > maximum),
  };
}
