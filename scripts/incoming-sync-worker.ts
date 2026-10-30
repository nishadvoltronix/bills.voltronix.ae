import { setTimeout as delay } from "node:timers/promises";
import { db } from "../src/lib/db";
import { verifyPassword } from "../src/lib/password";
import { authenticateAccountOperator } from "../src/lib/services/accounts";
import { incomingSyncSettings } from "../src/lib/services/incoming-sync-config";
import { processIncomingSync } from "../src/lib/services/incoming-sync";
import { privateAttachmentStateFile, readAttachmentDownloadState } from "./lib/books-attachment-state";

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--watch") || new Set(args).size !== args.length)
    throw new Error("Usage: npm run worker:incoming -- [--watch]");
  const watch = args.includes("--watch");
  if (!incomingSyncSettings().enabled) { console.log(JSON.stringify({ enabled: false, message: "Incoming sync is disabled." })); return; }
  const operatorEmail = process.env.INCOMING_SYNC_OPERATOR_EMAIL || process.env.ACCOUNT_OPERATOR_EMAIL || (process.env.APP_ENV !== "production" ? process.env.SEED_ADMIN_EMAIL : undefined) || "";
  const operatorPassword = process.env.INCOMING_SYNC_OPERATOR_PASSWORD || process.env.ACCOUNT_OPERATOR_PASSWORD || (process.env.APP_ENV !== "production" ? process.env.SEED_ADMIN_PASSWORD : undefined) || "";
  const actor = await authenticateAccountOperator(operatorEmail, operatorPassword);
  const passwordHash = (await db.user.findUniqueOrThrow({ where: { id: actor.id }, select: { passwordHash: true } })).passwordHash;
  if (!await verifyPassword(operatorPassword, passwordHash)) throw new Error("Incoming operator credentials changed during startup.");
  const stateFile = process.env.INCOMING_SYNC_ATTACHMENT_STATE_FILE ? await privateAttachmentStateFile(process.env.INCOMING_SYNC_ATTACHMENT_STATE_FILE) : null;
  const stop = new AbortController();
  const shutdown = () => stop.abort();
  process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
  let lastPrint = 0;
  try {
    do {
      // A changed password or revoked operator stops the process; the supervisor restarts with current credentials.
      if (!await db.user.findFirst({ where: { id: actor.id, active: true, role: "ADMIN", passwordHash }, select: { id: true } }))
        throw new Error("Incoming operator credentials changed.");
      try {
        const result = await processIncomingSync(actor, { signal: stop.signal, externalDelay: async source => {
          if (!stateFile || source.target !== "ZOHO") return null;
          const progress = await readAttachmentDownloadState(stateFile);
          const quota = progress?.organizations[source.organizationId]?.quota;
          if (quota?.notBefore && Date.parse(quota.notBefore) > Date.now()) return new Date(quota.notBefore);
          if (quota?.reason === "DAILY_QUOTA_RESERVED" && !quota.notBefore) return new Date(Date.now() + 86_400_000);
          return null;
        } });
        if (!watch || result.processed || Date.now() - lastPrint >= 60_000) {
          console.log(JSON.stringify({ ...result, providerFinancialWrites: 0 })); lastPrint = Date.now();
        }
      } catch {
        if (!watch) throw new Error("Incoming sync could not complete its check.");
        console.error("Incoming source access or database connection needs attention. Retrying after backoff.");
        try { await delay(60_000, undefined, { signal: stop.signal }); } catch { if (!stop.signal.aborted) throw new Error("Incoming retry interrupted."); }
      }
      if (!watch || stop.signal.aborted) break;
      // Persisted source schedules control reads; a one-second tick can honor a five-second interval.
      try { await delay(1000, undefined, { signal: stop.signal }); } catch { if (!stop.signal.aborted) throw new Error("Incoming worker interrupted."); }
    } while (!stop.signal.aborted);
  } finally { process.removeListener("SIGINT", shutdown); process.removeListener("SIGTERM", shutdown); }
}
main().catch(() => { console.error("Incoming worker stopped. Check protected source status and operator configuration."); process.exitCode = 1; })
  .finally(() => db.$disconnect());
