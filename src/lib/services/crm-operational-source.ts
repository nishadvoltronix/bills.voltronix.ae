import "server-only";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import type { Actor } from "@/lib/auth";
import { requireCompanyAccess } from "@/lib/company";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import { getBooksOrganizations, getConfig, productionBooksRuntimeReady } from "@/lib/integrations/config";

const inputSchema = z.object({
  companyId: z.string().min(1).max(100),
  booksOrganizationId: z.string().regex(/^\d{1,30}$/),
  crmOrganizationId: z.string().regex(/^\d{1,30}$/),
  reference: z.string().trim().min(10).max(160).regex(/^[^\u0000-\u001f\u007f]+$/),
}).strict();

/** Establishes reviewed read-source routing before OAuth; it does not certify a provider grant. */
export async function prepareOperationalCrmSource(actor: Actor, payload: unknown) {
  if (process.env.ALLOW_CRM_OPERATIONAL_SOURCE_SETUP !== "true" ||
      !productionBooksRuntimeReady(process.env) ||
      process.env.DATABASE_TLS_MODE !== "verify-full" || process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0" ||
      process.env.MANUAL_ENTRY_ONLY === "true" ||
      ["ZOHO_BOOKS_WRITE_ENABLED", "ZOHO_BOOKS_LIVE_ENABLED", "ALLOW_PRODUCTION_ACCOUNTING_WRITES"]
        .some(key => process.env[key] !== "false"))
    throw new HttpError(409, "CRM source setup requires an operational production runtime, verified database TLS, explicit enablement and disabled accounting writes.");
  if (actor.role !== "ADMIN") throw new HttpError(403, "An active administrator is required.");
  const input = inputSchema.parse(payload);
  const crm = getConfig("CRM"), books = getConfig("ZOHO", process.env, input.booksOrganizationId);
  const profile = getBooksOrganizations().find(item => item.organizationId === input.booksOrganizationId);
  if (!profile || crm.organizationId !== input.crmOrganizationId || crm.environment !== "production" ||
      books.environment !== "production" || !crm.crmMapping?.verified)
    throw new HttpError(409, "Select the configured production Books and CRM identities with an explicitly verified CRM field mapping.");
  const identity = { organizationId: crm.organizationId, dataCenter: crm.dataCenter, environment: crm.environment };
  return db.$transaction(async tx => {
    const operator = await tx.user.findUnique({ where: { id: actor.id }, select: { active: true, role: true } });
    if (!operator?.active || operator.role !== "ADMIN") throw new HttpError(403, "An active administrator is required.");
    await requireCompanyAccess(actor, input.companyId, tx);
    const company = await tx.company.findUnique({ where: { id: input.companyId }, select: {
      active: true, isDemo: true, name: true,
      integrationDestinations: { where: { target: "ZOHO" }, select: { organizationId: true, dataCenter: true, environment: true } },
    } });
    const destination = company?.integrationDestinations[0];
    if (!company?.active || company.isDemo || company.name !== profile.name ||
        company.integrationDestinations.length !== 1 || !destination ||
        destination.organizationId !== books.organizationId || destination.dataCenter !== books.dataCenter ||
        destination.environment !== books.environment)
      throw new HttpError(409, "An existing real company with the exact configured Books destination is required.");
    // Changing legacy routing or expanding a shared grant requires access to its whole source scope.
    if (await tx.companyIntegrationDestination.findFirst({ where: { target: "CRM", ...identity }, select: { companyId: true } }))
      throw new HttpError(409, "A legacy CRM destination already exists. Review its migration before preparing shared source bindings.");
    const sharing = await tx.companyCrmSource.findMany({ where: { ...identity, company: { active: true } },
      select: { companyId: true } });
    for (const source of sharing) await requireCompanyAccess(actor, source.companyId, tx);
    const existing = await tx.companyCrmSource.findUnique({ where: { companyId: input.companyId } });
    if (existing && (existing.organizationId !== identity.organizationId || existing.dataCenter !== identity.dataCenter ||
        existing.environment !== identity.environment))
      throw new HttpError(409, "This company already has a different CRM source. Its assignment was preserved.");
    if (!existing) {
      const jobs = await tx.job.count({ where: { companyId: input.companyId, externalCrmId: { not: null } } });
      const snapshots = await tx.crmJobSnapshot.count({ where: { companyId: input.companyId } });
      const associations = await tx.booksProjectAssociation.count({ where: { companyId: input.companyId } });
      if (jobs || snapshots || associations)
        throw new HttpError(409, "Existing CRM-linked records need a source review before assigning this company.");
      await tx.companyCrmSource.create({ data: { companyId: input.companyId, ...identity } });
      await tx.auditLog.create({ data: { actorId: actor.id, companyId: input.companyId, action: "CRM_OPERATIONAL_SOURCE_PREPARED",
        entityType: "Company", entityId: input.companyId, details: { ...identity, booksOrganizationId: books.organizationId,
          reference: input.reference, providerVerified: false, providerRequests: 0, financialWritesEnabled: false } } });
    }
    return { companyId: input.companyId, booksOrganizationId: books.organizationId, crmSource: identity,
      created: !existing, providerVerified: false, providerRequests: 0, financialWritesEnabled: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
