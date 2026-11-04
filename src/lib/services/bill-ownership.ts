import "server-only";
import type { Actor } from "@/lib/auth";
import type { Prisma } from "@prisma/client";
import { companyFilter } from "@/lib/company";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import { nativeMirrorLinks, type MirrorIdentity } from "./bill-mirror-identity";

const limit = 10_000;
const chunkSize = 100;
const nativeSelect = { id: true, companyId: true, jobId: true, createdById: true,
  syncRecords: { where: { target: "ZOHO" as const }, select: { target: true, organizationId: true, externalId: true } } } as const;
const mirrorSelect = { id: true, companyId: true, organizationId: true, externalBillId: true, dataCenter: true, environment: true } as const;

export async function assertCurrentBillReader(actor: Actor, store: Pick<Prisma.TransactionClient, "user"> = db) {
  const current = await store.user.findUnique({ where: { id: actor.id }, select: { active: true, role: true } });
  if (!current?.active || current.role !== actor.role) throw new HttpError(403, "Your access changed. Sign in again.");
}
const currentReader = assertCurrentBillReader;
function assertBounded(count: number) {
  if (count > limit) throw new HttpError(422, "This bill ownership lookup is too large. Narrow the company selection or contact an administrator.");
}

/** null means Admin company access; every other role requires unique native ownership.
 * A job, provider importer, reference or supplier name can never prove ownership. */
export async function ownedBooksBillIds(actor: Actor, requestedCompanyId?: string): Promise<string[] | null> {
  await currentReader(actor);
  if (actor.role === "ADMIN") return null;
  const scope = await companyFilter(actor, requestedCompanyId);
  const own = await db.bill.findMany({ where: { ...scope, createdById: actor.id }, select: nativeSelect, take: limit + 1 });
  assertBounded(own.length);
  const sources = [...new Map(own.flatMap(bill => bill.syncRecords.flatMap(sync => sync.organizationId && sync.externalId
    ? [[JSON.stringify([bill.companyId, sync.organizationId, sync.externalId]), { companyId: bill.companyId,
      organizationId: sync.organizationId, externalBillId: sync.externalId }] as const] : []))).values()];
  assertBounded(sources.length);
  const mirrors = new Map<string, MirrorIdentity>();
  const natives = new Map<string, typeof own[number]>();
  for (let offset = 0; offset < sources.length; offset += chunkSize) {
    const group = sources.slice(offset, offset + chunkSize);
    const [rows, candidates] = await Promise.all([
      db.booksBill.findMany({ where: { AND: [scope, { OR: group }] }, select: mirrorSelect, take: limit + 1 }),
      // Include every competing local bill, not only this user's candidates.
      db.bill.findMany({ where: { AND: [scope, { OR: group.map(source => ({ companyId: source.companyId,
        syncRecords: { some: { target: "ZOHO", organizationId: source.organizationId, externalId: source.externalBillId } } })) }] },
        select: nativeSelect, take: limit + 1 }),
    ]);
    assertBounded(rows.length); assertBounded(candidates.length);
    rows.forEach(row => mirrors.set(row.id, row)); candidates.forEach(row => natives.set(row.id, row));
    assertBounded(mirrors.size); assertBounded(natives.size);
  }
  const all = [...natives.values()];
  const [destinations, history] = await Promise.all([
    db.companyIntegrationDestination.findMany({ where: { ...scope, target: "ZOHO" },
      select: { companyId: true, organizationId: true, dataCenter: true, environment: true }, take: limit + 1 }),
    db.integrationJob.findMany({ where: { billId: { in: all.map(bill => bill.id) }, target: "ZOHO", operation: "CREATE_BILL" },
      select: { billId: true, organizationId: true, snapshot: true }, take: limit + 1 }),
  ]);
  assertBounded(destinations.length); assertBounded(history.length);
  const links = nativeMirrorLinks(all, [...mirrors.values()], destinations, history);
  const ids = [...links.linkedBills].flatMap(([id, nativeId]) => natives.get(nativeId)?.createdById === actor.id ? [id] : []);
  await currentReader(actor);
  if (JSON.stringify(scope) !== JSON.stringify(await companyFilter(actor, requestedCompanyId)))
    throw new HttpError(403, "Your company access changed. Reload this page.");
  return ids;
}

export async function booksBillOwnerScope(actor: Actor, requestedCompanyId?: string) {
  const ids = await ownedBooksBillIds(actor, requestedCompanyId);
  return ids === null ? {} : { id: { in: ids } };
}

export async function assertBooksBillOwner(actor: Actor, billId: string) {
  const ids = await ownedBooksBillIds(actor);
  if (ids !== null && !ids.includes(billId)) throw new HttpError(404, "Books bill not found.");
}

/** Recheck the complete scope so counts and filter options cannot disclose a
 * previously owned import after its unique source mapping changes mid-read. */
export async function assertBooksOwnerScopeCurrent(actor: Actor, expected: readonly string[] | null, companyId?: string) {
  const current = await ownedBooksBillIds(actor, companyId);
  if (JSON.stringify(current === null ? null : [...current].sort()) !== JSON.stringify(expected === null ? null : [...expected].sort()))
    throw new HttpError(409, "Bill ownership changed during refresh. Reload this page.");
}
