import { constants, existsSync, readdirSync } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { mysqlConnectionOptions } from "../src/lib/mysql-connection";
import { mysqlTransportOptions } from "../src/lib/mysql-transport";
import { manualReadiness, type ManualInventory } from "./lib/manual-readiness";

async function inspectDatabase(): Promise<ManualInventory | null> {
  let client: PrismaClient | undefined;
  try {
    const options = mysqlConnectionOptions(process.env.DATABASE_URL ?? "");
    client = new PrismaClient({
      adapter: new PrismaMariaDb({
        ...options,
        ...mysqlTransportOptions(options),
        timezone: "+00:00",
        connectionLimit: 2,
        connectTimeout: 10000,
      }),
      log: [],
    });
    const realRecord = {
      isDemo: false,
      NOT: { OR: [{ id: { startsWith: "demo-" } }, { id: { startsWith: "demo_" } }] },
    };
    const companies = await client.company.findMany({
      where: { active: true, ...realRecord },
      select: {
        id: true,
        liveAccountingEnabled: true,
        memberships: {
          where: { active: true, user: { active: true } },
          select: { user: { select: { role: true } } },
        },
        _count: { select: { jobs: { where: realRecord }, vendors: { where: realRecord } } },
      },
    });
    return {
      companies: companies.map(({ memberships, _count, ...company }) => ({
        ...company,
        administrators: memberships.filter(({ user }) => user.role === "ADMIN").length,
        writers: memberships.filter(({ user }) => ["ADMIN", "ACCOUNTS", "DATA_ENTRY"].includes(user.role)).length,
        jobs: _count.jobs,
        vendors: _count.vendors,
      })),
    };
  } catch {
    return null;
  } finally {
    await client?.$disconnect().catch(() => undefined);
  }
}

function inside(directory: string, root: string) {
  const relative = path.relative(root, directory);
  return !relative || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function inspectStorage() {
  try {
    const configured = process.env.UPLOAD_DIR;
    if (!configured || !path.isAbsolute(configured)) return false;
    const directory = await realpath(configured);
    if (!(await stat(directory)).isDirectory()) return false;
    const roots = await Promise.all(["public", ".next"].map(async (name) => {
      const root = path.resolve(name);
      return realpath(root).catch(() => root);
    }));
    if (roots.some((root) => inside(directory, root))) return false;
    await access(directory, constants.R_OK | constants.W_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (process.argv.length > 2 || readdirSync(".").some(
    (name) => name.startsWith(".env.") && name !== ".env.example",
  ))
    throw new Error("Review command arguments and environment precedence.");
  if (existsSync(".env")) process.loadEnvFile(".env");
  const [inventory, storage] = await Promise.all([inspectDatabase(), inspectStorage()]);
  const report = manualReadiness(process.env, inventory, storage);
  console.log(JSON.stringify(report, null, 2));
  if (report.status === "BLOCKED") process.exitCode = 2;
}

main().catch(() => {
  console.error("Manual readiness check could not complete. Check the private environment and command arguments. No configuration values were logged.");
  process.exitCode = 1;
});
