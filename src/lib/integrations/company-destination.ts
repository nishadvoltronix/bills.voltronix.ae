import "server-only";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { Actor } from "@/lib/auth";
import { HttpError } from "@/lib/http";
import { IntegrationError, type ZohoConfig } from "./config";

type Store = Prisma.TransactionClient;
function destination(config: ZohoConfig) {
  return {
    target: config.target,
    organizationId: config.organizationId,
    dataCenter: config.dataCenter,
    environment: config.environment,
  };
}

export async function destinationCompanyForActor(actor: Pick<Actor, "id">, config: ZohoConfig, store: Store = db) {
  const mapping = await store.companyIntegrationDestination.findFirst({
    where: {
      ...destination(config),
      company: { active: true, memberships: { some: { userId: actor.id, active: true, user: { active: true } } } },
    },
    select: { companyId: true },
  });
  if (!mapping) throw new HttpError(403, "This integration destination is not assigned to one of your authorized companies.");
  return mapping.companyId;
}

export async function requireDestinationForCompany(config: ZohoConfig, companyId: string, store: Store = db) {
  const mapping = await store.companyIntegrationDestination.findFirst({
    where: { ...destination(config), companyId, company: { active: true } },
    select: { companyId: true },
  });
  if (!mapping) throw new IntegrationError("COMPANY_DESTINATION_MISMATCH", "The accounting destination is not assigned to this bill's company.", "BLOCKED");
}
