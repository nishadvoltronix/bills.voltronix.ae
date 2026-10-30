import "server-only";
import type { Actor } from "@/lib/auth";
import { companyIdsForActor, requireCompanyAccess } from "@/lib/company";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import type { IncomingSyncStatus, IncomingSyncSourceStatus } from "@/lib/incoming-sync-types";
import { incomingSyncSettings } from "./incoming-sync-config";

const roles = ["ADMIN", "ACCOUNTS", "MANAGEMENT"] as const;
const label = (value: string) => value.replace(/^\[CONNECTION CHECK\]\s*/i, "");
export async function getIncomingSyncStatus(actor: Actor, companyId?: string): Promise<IncomingSyncStatus> {
  if (!(roles as readonly string[]).includes(actor.role) || !await db.user.findFirst({ where: { id: actor.id, active: true, role: actor.role }, select: { id: true } }))
    throw new HttpError(403, "Your current role cannot view incoming source status.");
  if (companyId) await requireCompanyAccess(actor, companyId);
  const companyIds = companyId ? [companyId] : await companyIdsForActor(actor);
  const companies = await db.company.findMany({ where: { id: { in: companyIds }, active: true }, include: { crmSource: true } });
  const crm = companies.flatMap(company => company.crmSource ? [{ target: "CRM", organizationId: company.crmSource.organizationId,
    dataCenter: company.crmSource.dataCenter, environment: company.crmSource.environment }] : []);
  const settings = incomingSyncSettings();
  const states = await db.incomingSyncState.findMany({ where: { OR: [{ target: "ZOHO", companyId: { in: companyIds } }, ...crm] },
    select: { id: true, target: true, companyId: true, organizationId: true, dataCenter: true, environment: true, status: true,
      lastSuccessAt: true, nextRunAt: true, backoffUntil: true, lastHeartbeatAt: true, processedCount: true }, orderBy: [{ target: "asc" }, { organizationId: "asc" }] });
  // Recheck access after reading status, including role and membership revocation.
  const current = await companyIdsForActor(actor);
  if (companyIds.some(id => !current.includes(id)) || !await db.user.findFirst({ where: { id: actor.id, active: true, role: actor.role }, select: { id: true } }))
    throw new HttpError(403, "Your current source access changed. Refresh your session.");
  const now = Date.now();
  const heartbeat = states.reduce<Date | null>((latest, row) => row.lastHeartbeatAt && (!latest || row.lastHeartbeatAt > latest) ? row.lastHeartbeatAt : latest, null);
  const messages: Record<string, string> = { PENDING: "A source check is pending.", RUNNING: "Reading changes from Zoho.", IDLE: "The last source check completed.",
    RETRY: "The last check could not complete. A retry is scheduled.", WAITING_QUOTA: "Zoho reads are paused until the permitted retry time.",
    BLOCKED: "Source configuration or authorization needs administrator review.", DISABLED: "Automatic incoming sync is disabled." };
  return { generatedAt: new Date(now).toISOString(), enabled: settings.enabled, pollIntervalSeconds: settings.intervalSeconds,
    workerAlive: Boolean(settings.enabled && heartbeat && now - heartbeat.valueOf() <= 120_000), lastHeartbeatAt: heartbeat?.toISOString() ?? null,
    sources: states.map(row => {
      const status = (settings.enabled ? row.status : "DISABLED") as IncomingSyncSourceStatus["status"];
      const names = row.target === "ZOHO" ? companies.filter(c => c.id === row.companyId) : companies.filter(c => c.crmSource?.organizationId === row.organizationId &&
        c.crmSource.dataCenter === row.dataCenter && c.crmSource.environment === row.environment);
      return { id: row.id, kind: row.target === "ZOHO" ? "BOOKS" as const : "CRM" as const, companyId: row.companyId,
        companyName: names.map(c => label(c.name)).join(" / "), status, lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
        nextRunAt: settings.enabled ? row.nextRunAt.toISOString() : null, backoffUntil: row.backoffUntil?.toISOString() ?? null,
        isStale: !row.lastSuccessAt || now - row.lastSuccessAt.valueOf() > Math.max(settings.intervalSeconds * 3000, 900_000),
        message: messages[status] ?? messages.BLOCKED, processedCount: row.target === "ZOHO" ? row.processedCount : null };
    }) };
}
