import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/mysql/schema.prisma",
  migrations: { path: "prisma/mysql/migrations", seed: "tsx scripts/seed.ts" },
  datasource: { url: env("DATABASE_URL") },
});
