import "server-only";
import type { Prisma } from "@prisma/client";
import type { Actor } from "@/lib/auth";
import { companyFilter } from "@/lib/company";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";

/** Source access only. Callers separately decide which records represent jobs.
 * Unassigned source records require Admin access to every sharing company. */
export async function crmJobSourceScope(actor: Actor, companyId?: string): Promise<Prisma.CrmJobSnapshotWhereInput> {
  if (!await db.user.findFirst({ where: { id: actor.id, active: true, role: actor.role }, select: { id: true } }))
    throw new HttpError(403, "Current account access is required.");
  const mapped = await companyFilter(actor, companyId);
  if (actor.role !== "ADMIN" || companyId) return mapped;
  const sources = await db.companyCrmSource.findMany({ where: { company: { active: true } },
    select: { organizationId: true, dataCenter: true, environment: true, company: { select: {
      memberships: { where: { userId: actor.id, active: true, user: { active: true, role: "ADMIN" } }, select: { userId: true } },
    } } }, orderBy: [{ organizationId: "asc" }, { dataCenter: "asc" }, { environment: "asc" }, { companyId: "asc" }] });
  const groups = new Map<string, { crmOrganizationId: string; dataCenter: string; environment: string; authorized: boolean }>();
  for (const source of sources) {
    const key = `${source.organizationId}:${source.dataCenter}:${source.environment}`;
    const previous = groups.get(key);
    groups.set(key, { crmOrganizationId: source.organizationId, dataCenter: source.dataCenter, environment: source.environment,
      authorized: (previous?.authorized ?? true) && source.company.memberships.length > 0 });
  }
  const unassigned = [...groups.values()].filter((source) => source.authorized).map((source) => ({
    crmOrganizationId: source.crmOrganizationId, dataCenter: source.dataCenter, environment: source.environment, companyId: null,
  }));
  return unassigned.length ? { OR: [mapped, ...unassigned] } : mapped;
}
