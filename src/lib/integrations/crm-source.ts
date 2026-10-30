import "server-only";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import { destinationCompanyForActor } from "./company-destination";
import type { ZohoConfig } from "./config";

/** A shared grant can be changed only by an Admin authorized for every bound company. */
export async function crmAuthorizationContext(
  actor: Actor,
  config: ZohoConfig,
  store: Prisma.TransactionClient = db,
) {
  if (actor.role !== "ADMIN" || config.target !== "CRM")
    throw new HttpError(403, "Only an administrator can authorize the CRM source.");
  const sources = await store.companyCrmSource.findMany({
    where: {
      organizationId: config.organizationId,
      dataCenter: config.dataCenter,
      environment: config.environment,
    },
    orderBy: { companyId: "asc" },
    select: {
      companyId: true,
      createdAt: true,
      company: {
        select: {
          name: true,
          active: true,
          memberships: {
            where: { userId: actor.id, active: true, user: { active: true, role: "ADMIN" } },
            select: { userId: true },
          },
        },
      },
    },
  });
  // Preserve the original single-company CRM authorization when no shared source is configured.
  if (!sources.length) {
    const id = await destinationCompanyForActor(actor, config, store);
    return { companies: [{ id, name: "Configured CRM company" }], fingerprint: `legacy:${id}` };
  }
  if (sources.some((source) => !source.company.active || !source.company.memberships.length))
    throw new HttpError(403, "CRM authorization requires active Admin access to every company sharing this source.");
  return {
    companies: sources.map((source) => ({ id: source.companyId, name: source.company.name })),
    fingerprint: createHash("sha256").update(JSON.stringify(sources.map((source) => [source.companyId, source.createdAt.toISOString()]))).digest("hex"),
  };
}
