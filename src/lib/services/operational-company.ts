import "server-only";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import { requireCompanyAccess } from "@/lib/company";
import {
  getBooksOrganizations,
  getConfig,
  productionBooksRuntimeReady,
} from "@/lib/integrations/config";

const inputSchema = z
  .object({
    companyName: z
      .string()
      .trim()
      .min(2)
      .max(160)
      .regex(/^[^\u0000-\u001f\u007f]+$/),
    organizationId: z.string().regex(/^\d{1,30}$/),
    reference: z
      .string()
      .trim()
      .min(10)
      .max(160)
      .regex(/^[^\u0000-\u001f\u007f]+$/),
  })
  .strict();

/** Establishes an explicit company assignment before OAuth; never certifies Books or enables writes. */
export async function prepareOperationalBooksCompany(
  actor: Actor,
  payload: unknown,
) {
  if (
    process.env.ALLOW_OPERATIONAL_COMPANY_SETUP !== "true" ||
    !productionBooksRuntimeReady(process.env) ||
    [
      "ZOHO_BOOKS_WRITE_ENABLED",
      "ZOHO_BOOKS_LIVE_ENABLED",
      "ALLOW_PRODUCTION_ACCOUNTING_WRITES",
    ].some((name) => process.env[name] !== "false")
  )
    throw new HttpError(
      409,
      "Company setup requires an operational production runtime, explicit operator enablement and all Books write settings disabled.",
    );
  if (actor.role !== "ADMIN")
    throw new HttpError(403, "An active administrator is required.");
  const input = inputSchema.parse(payload);
  const profile = getBooksOrganizations().find(
    (item) => item.organizationId === input.organizationId,
  );
  if (
    !profile ||
    profile.name !== input.companyName ||
    /\[(DEMO|CONNECTION CHECK)\]/i.test(input.companyName)
  )
    throw new HttpError(
      422,
      "The company name and organization must match an explicitly configured operating company profile.",
    );
  const config = getConfig("ZOHO", process.env, input.organizationId);
  if (config.environment !== "production")
    throw new HttpError(
      409,
      "An exact production Books destination is required.",
    );
  const companyId = `company-books-${config.dataCenter.toLowerCase()}-${config.organizationId}`;
  const destination = {
    target: "ZOHO" as const,
    organizationId: config.organizationId,
    dataCenter: config.dataCenter,
    environment: config.environment,
  };
  return db.$transaction(
    async (tx) => {
      const operator = await tx.user.findUnique({
        where: { id: actor.id },
        select: { active: true, role: true },
      });
      if (!operator?.active || operator.role !== "ADMIN")
        throw new HttpError(403, "An active administrator is required.");
      const binding = await tx.companyIntegrationDestination.findUnique({
        where: { target_organizationId_dataCenter_environment: destination },
      });
      if (binding && binding.companyId !== companyId)
        throw new HttpError(
          409,
          "This Books destination already belongs to another company. Its assignment was preserved.",
        );
      const existing = await tx.company.findUnique({
        where: { id: companyId },
      });
      if (existing) {
        if (
          !existing.active ||
          existing.isDemo ||
          existing.name !== input.companyName
        )
          throw new HttpError(
            409,
            "The existing company cannot be repurposed by this setup command.",
          );
        await requireCompanyAccess(actor, companyId, tx);
      } else {
        if (
          await tx.company.findFirst({
            where: { name: input.companyName },
            select: { id: true },
          })
        )
          throw new HttpError(
            409,
            "A company with this name already exists. Review its existing assignment before proceeding.",
          );
        await tx.company.create({
          data: {
            id: companyId,
            name: input.companyName,
            isDemo: false,
            liveAccountingEnabled: false,
            memberships: { create: { userId: actor.id } },
          },
        });
      }
      if (!binding)
        await tx.companyIntegrationDestination.create({
          data: { companyId, ...destination, liveEnabled: false },
        });
      if (!existing || !binding)
        await tx.auditLog.create({
          data: {
            actorId: actor.id,
            companyId,
            action: "OPERATIONAL_COMPANY_PREPARED",
            entityType: "Company",
            entityId: companyId,
            details: {
              organizationId: input.organizationId,
              dataCenter: config.dataCenter,
              reference: input.reference,
              source: "reauthenticated_operator",
              providerVerified: false,
              financialWritesEnabled: false,
            },
          },
        });
      return {
        companyId,
        organizationId: input.organizationId,
        created: !existing,
        destinationCreated: !binding,
        providerRequests: 0,
        financialWritesEnabled: false,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}
