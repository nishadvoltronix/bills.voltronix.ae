import type { SyncTarget } from "@prisma/client";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { localTestDatabaseUrl } from "../scripts/lib/local-test-database.mjs";

export function assertMySqlTestDatabase() {
  const target = localTestDatabaseUrl(process.env.DATABASE_URL);
  if (
    process.env.APP_ENV !== "test" ||
    !/^\/bills_test_\d+_\d+$/.test(target.pathname) ||
    process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
    target.pathname.slice(1) !== process.env.MYSQL_TEST_EXPECTED_DATABASE
  )
    throw new Error(
      "Company fixtures require the guarded disposable MySQL test harness.",
    );
}

export async function addTestMemberships(
  companyId: string,
  actors: readonly Pick<Actor, "id">[],
) {
  assertMySqlTestDatabase();
  await db.userCompanyMembership.createMany({
    data: actors.map((actor) => ({ companyId, userId: actor.id })),
  });
}

export async function createTestCompany(
  name: string,
  actors: readonly Pick<Actor, "id">[] = [],
) {
  assertMySqlTestDatabase();
  const company = await db.company.create({
    data: { name: `Fictional ${name}` },
  });
  if (actors.length) await addTestMemberships(company.id, actors);
  return company;
}

export async function bindTestDestination(
  companyId: string,
  destination: {
    target: SyncTarget;
    organizationId: string;
    dataCenter?: string;
    environment?: "sandbox" | "production";
  },
) {
  assertMySqlTestDatabase();
  return db.companyIntegrationDestination.create({
    data: {
      companyId,
      target: destination.target,
      organizationId: destination.organizationId,
      dataCenter: destination.dataCenter ?? "US",
      environment: destination.environment ?? "sandbox",
    },
  });
}
