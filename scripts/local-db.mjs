import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "node:fs";
import path from "node:path";

const url = new URL(process.env.DATABASE_URL ?? "postgresql://invalid");
if (
  process.env.APP_ENV !== "development" ||
  url.hostname !== "127.0.0.1" ||
  url.port !== "55432" ||
  url.pathname !== "/bills_dev" ||
  !url.password
) {
  throw new Error(
    "Local PostgreSQL helper requires APP_ENV=development and an explicit 127.0.0.1:55432/bills_dev database with credentials.",
  );
}
const databaseDir = path.resolve(".local/postgres");
const postgres = new EmbeddedPostgres({
  databaseDir,
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  port: 55432,
  persistent: true,
  authMethod: "scram-sha-256",
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
  postgresFlags: ["-h", "127.0.0.1"],
  onLog: () => {},
  onError: () => {},
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await postgres.stop();
  console.log("Local PostgreSQL stopped; development data preserved.");
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
try {
  if (!existsSync(path.join(databaseDir, "PG_VERSION")))
    await postgres.initialise();
  await postgres.start();
  const client = postgres.getPgClient();
  await client.connect();
  const existing = await client.query(
    "SELECT 1 FROM pg_database WHERE datname = $1",
    ["bills_dev"],
  );
  await client.end();
  if (existing.rowCount === 0) await postgres.createDatabase("bills_dev");
  console.log(
    "Local PostgreSQL ready at 127.0.0.1:55432, database bills_dev. Keep this terminal open. Ctrl+C stops it safely.",
  );
} catch {
  console.error(
    "Local PostgreSQL could not start. Check port 55432 and .local/postgres permissions. Existing data was preserved.",
  );
  process.exitCode = 1;
}
