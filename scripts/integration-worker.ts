import { setTimeout as delay } from "node:timers/promises";
import { db } from "../src/lib/db";
import { processIntegrationJobs } from "../src/lib/integrations/queue";

// A service/scheduler owns this process. It never exposes a public worker API.
async function main() {
  const raw = process.argv.slice(2);
  const watch = raw.includes("--watch");
  const limits = raw.filter(arg => arg.startsWith("--limit="));
  const jobs = raw.filter(arg => arg.startsWith("--job-id="));
  if (new Set(raw).size !== raw.length || limits.length > 1 || jobs.length > 1 ||
    (jobs.length > 0 && (watch || limits.length > 0)) || raw.some(arg =>
      arg !== "--watch" && !/^--(?:limit=(?:[1-9]|1\d|2[0-5])|job-id=[A-Za-z0-9_-]{1,100})$/.test(arg)))
    throw new Error("Usage: npm run worker:sync -- [--watch] [--limit=1..25] | --job-id=EXACT_OPERATION_ID");
  const limit = limits[0] ? Number(limits[0].slice(8)) : 5;
  const jobId = jobs[0]?.slice(9);
  const stop = new AbortController();
  const shutdown = () => stop.abort();
  process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
  let failures = 0;
  try {
    do {
      try {
        const result = await processIntegrationJobs({ ...(jobId ? { jobId } : { limit }), signal: stop.signal });
        failures = 0;
        if (!watch || result.processed) console.log(JSON.stringify({ processed: result.processed }));
      } catch (error) {
        if (!watch) throw error;
        failures = Math.min(failures + 1, 5);
        console.error("Books worker could not complete its batch; retrying after backoff.");
      }
      if (!watch || stop.signal.aborted) break;
      try { await delay(Math.min(300_000, 10_000 * 2 ** failures), undefined, { signal: stop.signal }); }
      catch { if (!stop.signal.aborted) throw new Error("Worker polling failed."); }
    } while (!stop.signal.aborted);
  } finally {
    process.removeListener("SIGINT", shutdown); process.removeListener("SIGTERM", shutdown);
  }
}
main().catch(() => {
  console.error("Integration worker failed. Review the protected queue and server configuration.");
  process.exitCode = 1;
}).finally(() => db.$disconnect());
