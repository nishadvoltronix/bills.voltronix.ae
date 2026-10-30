import "server-only";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import { getConfig, IntegrationError } from "@/lib/integrations/config";
import { connectionFingerprint } from "@/lib/integrations/connection-fingerprint";
import type { IncomingSource } from "./incoming-sync-types";

type Store = Prisma.TransactionClient;
const fail = () => new IntegrationError("INCOMING_SOURCE_CHANGED", "Incoming source routing or access requires review.", "BLOCKED");
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export async function incomingSources(actor: Actor, store: Store = db) {
  if (actor.role !== "ADMIN" || !await store.user.findFirst({ where: { id: actor.id, active: true, role: "ADMIN" }, select: { id: true } }))
    throw new HttpError(403, "An active administrator is required for incoming sync.");
  const companies = await store.company.findMany({ where: { active: true }, include: {
    memberships: { where: { userId: actor.id, active: true } }, integrationDestinations: { where: { target: "ZOHO" } }, crmSource: true,
  }, orderBy: { id: "asc" } });
  const sources: Array<IncomingSource & { scopeHash: string; configurationError?: boolean }> = [];
  for (const company of companies.filter(row => row.memberships.length)) {
    if (company.integrationDestinations.length !== 1) continue;
    const destination = company.integrationDestinations[0];
    const source: IncomingSource = { target: "ZOHO", companyId: company.id, organizationId: destination.organizationId,
      dataCenter: destination.dataCenter, environment: destination.environment, organizationName: company.name };
    try {
      const config = getConfig("ZOHO", process.env, destination.organizationId);
      if (config.environment !== "production" || config.dataCenter !== destination.dataCenter || config.environment !== destination.environment) throw fail();
      if (companies.some(other => other.id !== company.id && other.integrationDestinations.some(d => d.organizationId === destination.organizationId && d.dataCenter === destination.dataCenter && d.environment === destination.environment))) throw fail();
      sources.push({ ...source, scopeHash: digest([source.target, source.companyId, connectionFingerprint(config), destination.createdAt]) });
    } catch {
      // A broken source must not prevent other independently authorized sources from refreshing.
      sources.push({ ...source, scopeHash: digest([source, "CONFIGURATION_UNAVAILABLE"]), configurationError: true });
    }
  }
  const groups = new Map<string, typeof companies>();
  for (const company of companies.filter(row => row.crmSource)) {
    const c = company.crmSource!;
    const key = JSON.stringify([c.organizationId, c.dataCenter, c.environment]);
    groups.set(key, [...(groups.get(key) ?? []), company]);
  }
  for (const group of groups.values()) {
    if (group.some(company => !company.memberships.length)) continue;
    const binding = group[0].crmSource!;
    const source: IncomingSource = { target: "CRM", companyId: null, organizationId: binding.organizationId,
      dataCenter: binding.dataCenter, environment: binding.environment, organizationName: group.map(c => c.name).join(" / ") };
    try {
      const config = getConfig("CRM", process.env, binding.organizationId);
      if (config.environment !== "production" || config.dataCenter !== binding.dataCenter || config.environment !== binding.environment || group.some(c => c.integrationDestinations.length !== 1)) throw fail();
      const assignments = group.map(c => [c.id, c.crmSource!.createdAt, c.integrationDestinations[0].organizationId, c.integrationDestinations[0].dataCenter, c.integrationDestinations[0].environment]);
      sources.push({ ...source, scopeHash: digest([connectionFingerprint(config), config.crmMapping, assignments]) });
    } catch {
      sources.push({ ...source, scopeHash: digest([source, "CONFIGURATION_UNAVAILABLE"]), configurationError: true });
    }
  }
  return sources;
}
export async function assertIncomingSource(actor: Actor, source: IncomingSource, expectedHash: string, store: Store = db) {
  const current = (await incomingSources(actor, store)).find(row => row.target === source.target && row.organizationId === source.organizationId &&
    row.dataCenter === source.dataCenter && row.environment === source.environment && row.companyId === source.companyId);
  if (!current || current.configurationError || current.scopeHash !== expectedHash) throw fail();
  return getConfig(source.target, process.env, source.organizationId);
}
