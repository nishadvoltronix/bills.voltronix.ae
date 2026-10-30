import { existsSync, readdirSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { mysqlConnectionOptions } from "../src/lib/mysql-connection";
import { mysqlTransportOptions } from "../src/lib/mysql-transport";
import { syncReadiness, type SyncInventory } from "./lib/sync-readiness";

async function inspectDatabase(): Promise<SyncInventory | null> {
  let client: PrismaClient | undefined;
  try {
    const options = mysqlConnectionOptions(process.env.DATABASE_URL ?? "");
    client = new PrismaClient({
      adapter: new PrismaMariaDb({
        ...options,
        ...mysqlTransportOptions(options),
        timezone: "+00:00",
        decimalAsNumber: false,
        bigIntAsNumber: false,
        connectionLimit: 2,
        connectTimeout: 10000,
      }),
      // Database failures can contain connection details; emit only fixed report codes.
      log: [],
    });
    const realRecord = {
      isDemo: false,
      NOT: {
        OR: [{ id: { startsWith: "demo-" } }, { id: { startsWith: "demo_" } }],
      },
    };
    const [credentials, companies, destinations] = await Promise.all([
      client.integrationCredential.findMany({
        where: { target: "ZOHO" },
        select: {
          organizationId: true,
          revokedAt: true,
          connectionFingerprint: true,
        },
      }),
      client.company.findMany({
        select: {
          id: true,
          active: true,
          isDemo: true,
          liveAccountingEnabled: true,
          _count: {
            select: {
              vendors: { where: realRecord },
              jobs: { where: realRecord },
              memberships: {
                where: {
                  active: true,
                  user: {
                    active: true,
                    role: { in: ["ADMIN", "ACCOUNTS", "DATA_ENTRY"] },
                  },
                },
              },
            },
          },
        },
      }),
      client.companyIntegrationDestination.findMany({
        where: { target: "ZOHO" },
        select: {
          companyId: true,
          organizationId: true,
          dataCenter: true,
          environment: true,
          liveEnabled: true,
          verifiedAt: true,
          verificationReference: true,
          verifiedConfigurationHash: true,
        },
      }),
    ]);
    const mappedDestinations = [];
    for (const destination of destinations) {
      const mappedRealVendors = await client.vendorBooksMapping.count({
        where: {
          organizationId: destination.organizationId,
          dataCenter: destination.dataCenter,
          environment: destination.environment,
          vendor: { companyId: destination.companyId, ...realRecord },
        },
      });
      mappedDestinations.push({ ...destination, mappedRealVendors });
    }
    return {
      credentials,
      companies: companies.map(({ _count, ...company }) => ({
        ...company,
        realVendors: _count.vendors,
        realJobs: _count.jobs,
        activeWriters: _count.memberships,
      })),
      destinations: mappedDestinations,
    };
  } catch {
    return null;
  } finally {
    await client?.$disconnect().catch(() => undefined);
  }
}

async function main() {
  if (process.argv.length > 2) {
    console.log(
      JSON.stringify({
        status: "BLOCKED",
        code: "UNSUPPORTED_ARGUMENTS",
        action:
          "Run npm run check:sync without arguments. Credentials belong in the private server environment.",
      }),
    );
    process.exitCode = 1;
    return;
  }
  // As with check:integrations, refuse unknown Next environment-file precedence.
  if (
    readdirSync(".").some(
      (name) => name.startsWith(".env.") && name !== ".env.example",
    )
  ) {
    console.log(
      JSON.stringify({
        status: "BLOCKED",
        code: "ENVIRONMENT_OVERRIDES",
        action:
          "Review additional environment files before inventorying this runtime. Their values were not read.",
      }),
    );
    process.exitCode = 1;
    return;
  }
  if (existsSync(".env")) process.loadEnvFile(".env");
  const report = syncReadiness(process.env, await inspectDatabase());
  console.log(JSON.stringify(report, null, 2));
  if (report.status === "BLOCKED") process.exitCode = 2;
}

main().catch(() => {
  console.log(
    JSON.stringify({
      status: "BLOCKED",
      code: "INVENTORY_FAILED",
      action:
        "Check private server configuration and file access. No provider request or financial write was attempted.",
    }),
  );
  process.exitCode = 1;
});
