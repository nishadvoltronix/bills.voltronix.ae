import "server-only";
import type { Prisma } from "@prisma/client";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";

type CompanyDatabase = Pick<Prisma.TransactionClient, "userCompanyMembership">;

/** Membership is read from the database on every operation; administrators have no bypass. */
export async function companyIdsForActor(
  actor: Pick<Actor, "id">,
  tx: CompanyDatabase = db,
): Promise<string[]> {
  const rows = await tx.userCompanyMembership.findMany({
    where: {
      userId: actor.id,
      active: true,
      user: { active: true },
      company: { active: true },
    },
    select: { companyId: true },
  });
  return rows.map((row) => row.companyId);
}

export async function requireCompanyAccess(
  actor: Pick<Actor, "id">,
  companyId: string,
  tx: CompanyDatabase = db,
): Promise<void> {
  if (!companyId || !(await companyIdsForActor(actor, tx)).includes(companyId))
    throw new HttpError(404, "Company or record not found.");
}

export async function resolveCompanyForCreate(
  actor: Pick<Actor, "id">,
  requestedCompanyId?: string,
  tx: CompanyDatabase = db,
): Promise<string> {
  const companies = await companyIdsForActor(actor, tx);
  if (requestedCompanyId) {
    if (!companies.includes(requestedCompanyId))
      throw new HttpError(404, "Company or record not found.");
    return requestedCompanyId;
  }
  if (companies.length !== 1)
    throw new HttpError(422, "Select an authorized company before saving.");
  return companies[0];
}

export async function companyFilter(
  actor: Pick<Actor, "id">,
  requestedCompanyId?: string,
  tx: CompanyDatabase = db,
) {
  if (requestedCompanyId) {
    await requireCompanyAccess(actor, requestedCompanyId, tx);
    return { companyId: requestedCompanyId };
  }
  return { companyId: { in: await companyIdsForActor(actor, tx) } };
}

export async function listCompanies(actor: Pick<Actor, "id">) {
  return db.company.findMany({
    where: { id: { in: await companyIdsForActor(actor) }, active: true },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
}
