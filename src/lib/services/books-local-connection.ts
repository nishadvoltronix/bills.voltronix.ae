import "server-only";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { Actor } from "@/lib/auth";
import { requireCompanyAccess } from "@/lib/company";
import { HttpError } from "@/lib/http";
import { getBooksOrganizations, getConfig } from "@/lib/integrations/config";

/** Connection-only local administration. Never enable financial writes here. */
export function assertLocalBooksConnectionEnvironment() {
  let target: URL;
  try {
    target = new URL(process.env.DATABASE_URL ?? "");
  } catch {
    throw new Error("A guarded local database is required.");
  }
  const development =
    process.env.APP_ENV === "development" &&
    target.pathname === "/voltronix_billing_dev";
  const fixture =
    process.env.APP_ENV === "test" &&
    /^\/bills_test_\d+_\d+$/.test(target.pathname) &&
    process.env.TEST_DATABASE_URL === process.env.DATABASE_URL &&
    process.env.MYSQL_TEST_EXPECTED_DATABASE === target.pathname.slice(1);
  if (
    (!development && !fixture) ||
    target.protocol !== "mysql:" ||
    target.hostname !== "127.0.0.1" ||
    target.port !== "3308" ||
    target.search ||
    target.hash ||
    process.env.APP_URL !== "http://127.0.0.1:3000" ||
    [
      "ZOHO_BOOKS_WRITE_ENABLED",
      "ZOHO_BOOKS_LIVE_ENABLED",
      "ALLOW_PRODUCTION_ACCOUNTING_WRITES",
      "INTEGRATION_TEST_MODE",
    ].some((name) => process.env[name] === "true")
  )
    throw new Error(
      "Connection checks require the guarded local application with every accounting-write mode disabled.",
    );
}

export async function prepareLocalBooksConnections(actor: Actor) {
  assertLocalBooksConnectionEnvironment();
  if (actor.role !== "ADMIN")
    throw new HttpError(403, "An active administrator is required.");
  const profiles = getBooksOrganizations();
  const destinations = profiles.map((profile) => ({
    profile,
    config: getConfig("ZOHO", process.env, profile.organizationId),
  }));
  if (
    destinations.some(
      ({ config }) =>
        config.environment !== "production" || config.writeEnabled,
    )
  )
    throw new Error(
      "This local helper prepares only disabled production-account connection checks.",
    );
  return db.$transaction(
    async (tx) => {
      const current = await tx.user.findUnique({
        where: { id: actor.id },
        select: { active: true, role: true },
      });
      if (!current?.active || current.role !== "ADMIN")
        throw new HttpError(403, "An active administrator is required.");
      const result = [];
      for (const { profile, config } of destinations) {
        const companyId = `connection-check-books-${profile.organizationId}`;
        const name = `[CONNECTION CHECK] ${profile.name}`;
        const destination = {
          target: "ZOHO" as const,
          organizationId: profile.organizationId,
          dataCenter: config.dataCenter,
          environment: config.environment,
        };
        const binding = await tx.companyIntegrationDestination.findFirst({
          where: destination,
        });
        if (binding && binding.companyId !== companyId)
          throw new HttpError(
            409,
            "This Books organization already belongs to another company. Its assignment was preserved.",
          );
        const existing = await tx.company.findUnique({
          where: { id: companyId },
        });
        if (existing) {
          if (
            !existing.active ||
            !existing.isDemo ||
            existing.liveAccountingEnabled ||
            existing.name !== name
          )
            throw new HttpError(
              409,
              "The existing company is not an unchanged connection-check workspace.",
            );
          await requireCompanyAccess(actor, companyId, tx);
          if (await tx.bill.count({ where: { companyId } }))
            throw new HttpError(
              409,
              "The connection-check workspace contains bills. Review it before continuing.",
            );
        } else {
          await tx.company.create({
            data: {
              id: companyId,
              name,
              isDemo: true,
              liveAccountingEnabled: false,
              memberships: { create: { userId: actor.id } },
            },
          });
        }
        if (
          binding &&
          (binding.liveEnabled ||
            binding.verifiedAt ||
            binding.verificationReference ||
            binding.verifiedConfigurationHash)
        )
          throw new HttpError(
            409,
            "An existing accounting verification was preserved; this helper cannot repurpose it.",
          );
        if (!binding)
          await tx.companyIntegrationDestination.create({
            data: { companyId, ...destination, liveEnabled: false },
          });
        if (!existing || !binding)
          await tx.auditLog.create({
            data: {
              actorId: actor.id,
              companyId,
              action: "BOOKS_LOCAL_CONNECTION_CHECK_PREPARED",
              entityType: "Company",
              entityId: companyId,
              details: {
                organizationId: profile.organizationId,
                dataCenter: config.dataCenter,
                financialWritesEnabled: false,
                organizationVerified: false,
                source: "reauthenticated_operator",
              },
            },
          });
        result.push({
          companyId,
          name,
          organizationId: profile.organizationId,
          dataCenter: config.dataCenter,
          financialWritesEnabled: false,
        });
      }
      return {
        connections: result,
        callbackUrl:
          "http://127.0.0.1:3000/api/integrations/oauth/zoho/callback",
        financialWritesEnabled: false,
        providerRequests: 0,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}
