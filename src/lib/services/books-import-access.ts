import "server-only";
import type { Prisma } from "@prisma/client";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import { getConfig, IntegrationError } from "@/lib/integrations/config";
import { assertBooksCatalogEnvironment } from "@/lib/services/books-accounting-catalog";

export async function assertBooksImportContext(store: Prisma.TransactionClient, actor: Actor, companyId: string, organizationId: string) {
  assertBooksCatalogEnvironment();
  if (actor.role !== "ADMIN" || !await store.user.findFirst({ where: {
    id: actor.id, active: true, role: "ADMIN", memberships: { some: { companyId, active: true, company: { active: true } } },
  }, select: { id: true } })) throw new HttpError(403, "An active administrator with company access is required to import Books copies.");
  const config = getConfig("ZOHO", process.env, organizationId);
  if (config.environment !== "production" || config.writeEnabled)
    throw new IntegrationError("BOOKS_IMPORT_READ_ONLY_REQUIRED", "Books snapshot imports require the exact production connection with accounting writes disabled.", "BLOCKED");
  const destination = { companyId, target: "ZOHO" as const, organizationId, dataCenter: config.dataCenter, environment: config.environment };
  const binding = await store.companyIntegrationDestination.findFirst({ where: destination, include: { company: true } });
  if (!binding?.company.active) throw new IntegrationError("COMPANY_DESTINATION_MISMATCH", "The Books source is not assigned to this company.", "BLOCKED");
  if (process.env.APP_ENV !== "production" && (companyId !== `connection-check-books-${organizationId}` ||
    !binding.company.isDemo || binding.company.liveAccountingEnabled || binding.liveEnabled))
    throw new IntegrationError("COMPANY_ENVIRONMENT_MISMATCH", "Local Books copies require the disabled connection-check workspace.", "BLOCKED");
  return { organizationId, dataCenter: config.dataCenter, environment: config.environment, companyId };
}

const readRoles = ["ADMIN", "ACCOUNTS", "MANAGEMENT"] as const;
export async function assertBooksBillReader(actor: Actor) {
  if (!(readRoles as readonly string[]).includes(actor.role) || !await db.user.findFirst({
    where: { id: actor.id, active: true, role: { in: [...readRoles] } }, select: { id: true },
  })) throw new HttpError(403, "Your role cannot view imported Books bills.");
}
