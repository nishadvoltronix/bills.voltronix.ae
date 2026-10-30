import "server-only";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import { getBooksOrganizations, getConfig } from "@/lib/integrations/config";
import { assertLocalBooksConnectionEnvironment } from "./books-local-connection";

/** Explicitly approved local read bindings; never creates companies or enables posting. */
export async function prepareLocalCrmSources(actor: Actor) {
  assertLocalBooksConnectionEnvironment();
  if (actor.role !== "ADMIN") throw new HttpError(403, "An active administrator is required.");
  const crm = getConfig("CRM");
  const sources = getBooksOrganizations().map((profile) => getConfig("ZOHO", process.env, profile.organizationId));
  return db.$transaction(async (tx) => {
    const result = [];
    for (const books of sources) {
      const destination = await tx.companyIntegrationDestination.findFirst({
        where: {
          target: "ZOHO", organizationId: books.organizationId, dataCenter: books.dataCenter, environment: books.environment,
          company: { active: true, memberships: { some: { userId: actor.id, active: true, user: { active: true, role: "ADMIN" } } } },
        },
        select: { companyId: true },
      });
      if (!destination) throw new HttpError(403, "Every configured Books destination needs an existing authorized company before CRM setup.");
      const identity = { organizationId: crm.organizationId, dataCenter: crm.dataCenter, environment: crm.environment };
      const existing = await tx.companyCrmSource.findUnique({ where: { companyId: destination.companyId } });
      if (existing && (existing.organizationId !== identity.organizationId || existing.dataCenter !== identity.dataCenter || existing.environment !== identity.environment))
        throw new HttpError(409, "An existing CRM source differs. Its assignment was preserved.");
      if (!existing) {
        if (await tx.job.count({ where: { companyId: destination.companyId, externalCrmId: { not: null } } }))
          throw new HttpError(409, "This company already has CRM-linked jobs. Review their original source before assigning a shared CRM source.");
        await tx.companyCrmSource.create({ data: { companyId: destination.companyId, ...identity } });
        await tx.auditLog.create({ data: { actorId: actor.id, companyId: destination.companyId, action: "CRM_LOCAL_READ_SOURCE_PREPARED", entityType: "Company", entityId: destination.companyId, details: { ...identity, booksOrganizationId: books.organizationId, financialWritesEnabled: false } } });
      }
      result.push({ companyId: destination.companyId, booksOrganizationId: books.organizationId, ...identity });
    }
    return { sources: result, financialWritesEnabled: false, providerRequests: 0 };
  }, { isolationLevel: "Serializable" });
}
