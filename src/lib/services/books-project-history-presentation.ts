import "server-only";
import type { Actor } from "@/lib/auth";
import { companyFilter } from "@/lib/company";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import { describeBooksAttachments } from "./books-attachments";
import { freshFinancialActor } from "./financial-ledger";
import { loadBooksProjectHistory, type BooksProjectHistoryRelation } from "./books-project-history";

const relationIdentity = (relation: BooksProjectHistoryRelation) => JSON.stringify([
  relation.billId, relation.companyId, relation.organizationId, relation.dataCenter, relation.environment,
  relation.booksProjectId, relation.snapshotId, relation.externalCrmId, relation.canonicalJobId,
  relation.sourceCompanyId, relation.jobNumber, relation.verifiedAt,
]);

/** Project membership proves history, never a financial allocation to a job. */
export async function presentProjectHistory(actor: Actor, relations: BooksProjectHistoryRelation[]) {
  actor = await freshFinancialActor(actor);
  if (actor.role === "DATA_ENTRY" || !relations.length) return { booksBills: [], historyCompanies: [] };
  const scope = await companyFilter(actor);
  const byId = new Map<string, BooksProjectHistoryRelation[]>();
  for (const relation of relations) byId.set(relation.billId, [...byId.get(relation.billId) ?? [], relation]);
  const rows = await db.booksBill.findMany({
    where: { AND: [scope, { OR: relations.map((relation) => ({ id: relation.billId,
      companyId: relation.companyId, organizationId: relation.organizationId, dataCenter: relation.dataCenter,
      environment: relation.environment })) }], isStale: false, detailFetchedAt: { not: null } },
    include: { company: { select: { name: true } }, attachments: true },
    orderBy: [{ billDate: "desc" }, { billNumber: "asc" }, { id: "asc" }],
  });
  const current = rows.flatMap((row) => {
    if (row.detailImportRunId !== row.lastImportRunId || !row.sourceDetail || typeof row.sourceDetail !== "object" || Array.isArray(row.sourceDetail)) return [];
    const lines = row.sourceDetail.line_items;
    if (!Array.isArray(lines)) return [];
    const matching = (byId.get(row.id) ?? []).filter((relation) => relation.companyId === row.companyId &&
      relation.organizationId === row.organizationId && relation.dataCenter === row.dataCenter && relation.environment === row.environment &&
      lines.some((line) => line && typeof line === "object" && !Array.isArray(line) && line.project_id === relation.booksProjectId));
    return matching.length ? [{ row, matching }] : [];
  });
  const historyCompanies = [...new Map(current.map(({ row }) => [row.companyId,
    { id: row.companyId, name: row.company.name.replace(/^\[CONNECTION CHECK\]\s*/, "") }])).values()];
  const booksBills = current.map(({ row, matching }) => {
    const relation = matching[0];
    const uniqueJob = matching.every((value) => value.canonicalJobId === relation.canonicalJobId && value.jobNumber === relation.jobNumber);
    return { id: row.id, billNumber: row.billNumber, companyId: row.companyId,
      companyName: row.company.name.replace(/^\[CONNECTION CHECK\]\s*/, ""), vendorName: row.vendorName,
      currency: row.currencyCode, total: row.total, status: row.status,
      billDate: row.billDate?.toISOString().slice(0, 10) ?? null,
      jobId: uniqueJob ? relation.canonicalJobId : null, jobNumber: uniqueJob ? relation.jobNumber : null,
      href: `/bills/books/${row.id}`, ...describeBooksAttachments(row, row.attachments),
      relationEvidence: "Verified Books project → Zoho Projects → CRM deal relationship",
      allocationKnown: false,
    };
  });
  await freshFinancialActor(actor);
  if (JSON.stringify(scope) !== JSON.stringify(await companyFilter(actor)))
    return { booksBills: [], historyCompanies: [] };
  if (current.length) {
    // A project may have moved to another CRM deal while its bill/originals were read.
    // Recheck the exact proof, not only whether the old snapshot remains accessible.
    const latest = await loadBooksProjectHistory(actor);
    const verified = new Set(latest.relations.map(relationIdentity));
    if (current.some(({ matching }) => matching.some((relation) => !verified.has(relationIdentity(relation)))))
      throw new HttpError(409, "Project history changed during refresh. Please try again.");
  }
  return { booksBills, historyCompanies };
}
