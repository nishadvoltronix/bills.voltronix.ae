import { PrismaClient } from "@prisma/client";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { mysqlConnectionOptions } from "@/lib/mysql-connection";
import { mysqlTransportOptions } from "@/lib/mysql-transport";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export function createDb(url = process.env.DATABASE_URL): PrismaClient {
  if (!url)
    throw new Error(
      "DATABASE_URL is required. Configure the server environment before starting the application.",
    );
  const options = mysqlConnectionOptions(url);
  return new PrismaClient({
    adapter: new PrismaMariaDb({
      ...options,
      ...mysqlTransportOptions(options),
      timezone: "+00:00",
      initSql: "SET time_zone = '+00:00'",
      decimalAsNumber: false,
      bigIntAsNumber: false,
      connectionLimit: 10,
      connectTimeout: 10000,
    }),
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });
}

export const db = globalForPrisma.prisma ?? createDb();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
