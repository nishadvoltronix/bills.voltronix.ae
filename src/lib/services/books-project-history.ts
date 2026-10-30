import "server-only";
import { createHash } from "node:crypto";
import { Prisma, type BooksProjectAssociation } from "@prisma/client";
import { z } from "zod";
import type { Actor } from "@/lib/auth";
import { companyIdsForActor, requireCompanyAccess } from "@/lib/company";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import { canViewFinancialSummary } from "@/lib/permissions";
import { crmJobSourceScope } from "@/lib/services/crm-job-access";

const externalId = z.string().regex(/^\d{1,30}$/);
const sourceSchema = z.object({
  organizationId: externalId,
  dataCenter: z.enum(["US", "EU", "IN", "AU", "JP", "CA", "CN", "SA", "AE"]),
  environment: z.enum(["production", "sandbox"]),
}).strict();
const objectJson = z.record(z.string(), z.json());
const inputSchema = z.object({
  companyId: z.string().min(1).max(100),
  booksSource: sourceSchema,
  crmSource: sourceSchema,
  portalId: externalId,
  sourceProject: z.unknown(),
  sourceDealsPages: z.array(z.unknown()).min(1).max(50),
  sourceCrmRecords: z.array(z.unknown()).max(10_000),
  verifiedAt: z.iso.datetime({ offset: true }),
}).strict();

export type BooksProjectAssociationInput = z.input<typeof inputSchema>;
type Store = Prisma.TransactionClient;
type SourceRecord = Prisma.InputJsonObject;
const TTL = 24 * 60 * 60_000;
const REFRESH = 5 * 60_000;
const invalid = (message: string) => new HttpError(422, message);
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
const text = (value: unknown) => typeof value === "string" && value.trim() !== "" ? value : null;
const sourceKey = (organizationId: string, dataCenter: string, environment: string) =>
  `${organizationId}:${dataCenter}:${environment}`;

/** Native Books list and detail responses use different positive provenance markers. */
export function isZohoProjectsSourceProject(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const listMarker = Object.hasOwn(row, "other_service_app_source");
  const detailMarker = Object.hasOwn(row, "is_from_zoho_projects");
  return (!listMarker || row.other_service_app_source === 1) &&
    (!detailMarker || row.is_from_zoho_projects === true) &&
    (row.other_service_app_source === 1 || row.is_from_zoho_projects === true);
}

/** Validate complete provider evidence without interpreting a relationship as a financial allocation. */
export function parseBooksProjectAssociation(value: unknown) {
  const input = inputSchema.parse(value);
  const verifiedAt = new Date(input.verifiedAt);
  if (verifiedAt.valueOf() > Date.now() + 60_000) throw invalid("Project association verification time is in the future.");
  const project = objectJson.parse(input.sourceProject);
  const booksProjectId = externalId.parse(project.project_id);
  const zprojectsProjectId = externalId.parse(project.zprojects_project_id);
  // Preserve the original list/detail representation, including the native positive source marker.
  if (!isZohoProjectsSourceProject(project))
    throw invalid("Books must supply the verified native Zoho Projects source metadata.");
  const projectName = z.string().min(1).max(500).parse(project.project_name);
  const pages = input.sourceDealsPages.map((page) => objectJson.parse(page));
  const dealIds: string[] = [];
  let pageSize: number | null = null;
  for (const [index, page] of pages.entries()) {
    const parsed = z.object({
      deals: z.array(z.object({ id: externalId })).max(200),
      info: z.object({ page: z.number().int().positive(), per_page: z.number().int().min(1).max(200),
        has_next_page: z.union([z.boolean(), z.enum(["true", "false"])]) }),
    }).parse(page);
    const more = parsed.info.has_next_page === true || parsed.info.has_next_page === "true";
    if (parsed.info.page !== index + 1 || more !== (index < pages.length - 1) ||
      (more && parsed.deals.length === 0) || parsed.deals.length > parsed.info.per_page ||
      (pageSize !== null && pageSize !== parsed.info.per_page))
      throw invalid("Zoho Projects associations require every ordered page and explicit completion.");
    pageSize = parsed.info.per_page;
    dealIds.push(...parsed.deals.map((deal) => deal.id));
  }
  if (new Set(dealIds).size !== dealIds.length) throw invalid("Zoho Projects returned duplicate CRM Deal IDs.");
  const records = input.sourceCrmRecords.map((record) => objectJson.parse(record));
  const recordIds = records.map((record) => {
    const id = externalId.parse(record.id);
    z.union([z.string().max(500), z.null()]).parse(record.DealNumber);
    const modified = new Date(z.iso.datetime({ offset: true }).parse(record.Modified_Time));
    if (modified.valueOf() > verifiedAt.valueOf() + 300_000)
      throw invalid("CRM reference metadata is newer than the verified association evidence.");
    return id;
  });
  if (new Set(recordIds).size !== recordIds.length || recordIds.length !== dealIds.length ||
    recordIds.some((id) => !dealIds.includes(id)))
    throw invalid("Exact CRM reference records are required for every associated Deal ID.");
  const proof = { booksSource: input.booksSource, crmSource: input.crmSource, portalId: input.portalId,
    sourceProject: project, sourceDealsPages: pages, sourceCrmRecords: records };
  const serialized = canonicalJson(proof);
  if (Buffer.byteLength(serialized, "utf8") > 20 * 1024 * 1024)
    throw invalid("Project association evidence exceeded the supported batch size.");
  return { ...input, booksProjectId, zprojectsProjectId, projectName, dealIds,
    sourceProject: project as SourceRecord, sourceDealsPages: pages as SourceRecord[], sourceCrmRecords: records as SourceRecord[],
    sourceHash: createHash("sha256").update(serialized).digest("hex"), verifiedAt,
    validUntil: new Date(verifiedAt.valueOf() + TTL), nextRefreshAt: new Date(verifiedAt.valueOf() + REFRESH),
    status: dealIds.length ? "VERIFIED" as const : "UNLINKED" as const };
}

async function assertImportScope(store: Store, actor: Actor, input: ReturnType<typeof parseBooksProjectAssociation>) {
  if (actor.role !== "ADMIN" || !await store.user.findFirst({ where: { id: actor.id, active: true, role: "ADMIN" }, select: { id: true } }))
    throw new HttpError(403, "An active administrator is required to import project association evidence.");
  await requireCompanyAccess(actor, input.companyId, store);
  const company = await store.company.findFirst({ where: { id: input.companyId, active: true },
    select: { integrationDestinations: { where: { target: "ZOHO", ...input.booksSource }, select: { organizationId: true } },
      crmSource: true } });
  if (!company?.integrationDestinations.length || !company.crmSource ||
    company.crmSource.organizationId !== input.crmSource.organizationId || company.crmSource.dataCenter !== input.crmSource.dataCenter ||
    company.crmSource.environment !== input.crmSource.environment)
    throw new HttpError(403, "Project evidence does not match the company's current Books and CRM sources.");
  const sharing = await store.companyCrmSource.findMany({ where: { ...input.crmSource, company: { active: true } },
    select: { company: { select: { memberships: { where: { userId: actor.id, active: true }, select: { userId: true } } } } } });
  if (!sharing.length || sharing.some((source) => !source.company.memberships.length))
    throw new HttpError(403, "Administrator access to every company sharing the CRM source is required.");
}

/** Complete snapshots replace previous evidence atomically. No Job, Bill, Payment or outgoing queue is written. */
export async function importBooksProjectAssociation(actor: Actor, payload: BooksProjectAssociationInput,
  guard?: { assertLease(tx: Store): Promise<void> }) {
  const input = parseBooksProjectAssociation(payload);
  return db.$transaction(async (tx) => {
    await guard?.assertLease(tx);
    await assertImportScope(tx, actor, input);
    const identity = { organizationId: input.booksSource.organizationId, dataCenter: input.booksSource.dataCenter,
      environment: input.booksSource.environment, booksProjectId: input.booksProjectId };
    const where = { organizationId_dataCenter_environment_booksProjectId: identity };
    const existing = await tx.booksProjectAssociation.findUnique({ where });
    if (existing && (existing.companyId !== input.companyId || existing.verifiedAt.valueOf() > input.verifiedAt.valueOf()))
      throw new HttpError(409, "Project evidence belongs to another company or is older than the saved verification.");
    if (existing && existing.verifiedAt.valueOf() === input.verifiedAt.valueOf() && existing.sourceHash !== input.sourceHash)
      throw new HttpError(409, "Conflicting project evidence has the same verification timestamp.");
    const snapshotCount = await tx.crmJobSnapshot.count({ where: { crmOrganizationId: input.crmSource.organizationId,
      dataCenter: input.crmSource.dataCenter, environment: input.crmSource.environment, sourceModule: "Deals",
      externalCrmId: { in: input.dealIds } } });
    if (snapshotCount !== input.dealIds.length)
      throw invalid("An associated CRM Deal is missing from the verified local CRM source inventory.");
    if (existing && existing.verifiedAt.valueOf() === input.verifiedAt.valueOf() && existing.sourceHash === input.sourceHash)
      return { id: existing.id, companyId: existing.companyId, dealCount: input.dealIds.length, changed: false,
        status: existing.status, verifiedAt: existing.verifiedAt.toISOString() };
    const data = { companyId: input.companyId, ...identity, projectName: input.projectName,
      zprojectsProjectId: input.zprojectsProjectId, portalId: input.portalId,
      crmOrganizationId: input.crmSource.organizationId, crmDataCenter: input.crmSource.dataCenter, crmEnvironment: input.crmSource.environment,
      dealIds: input.dealIds, sourceProject: input.sourceProject, sourceDealsPages: input.sourceDealsPages,
      sourceCrmRecords: input.sourceCrmRecords, sourceHash: input.sourceHash, status: input.status,
      verifiedAt: input.verifiedAt, validUntil: input.validUntil, nextRefreshAt: input.nextRefreshAt,
      lastAttemptAt: input.verifiedAt, lastErrorCode: null, failures: 0, backoffUntil: null };
    const saved = await tx.booksProjectAssociation.upsert({ where, create: data, update: data });
    await tx.auditLog.create({ data: { actorId: actor.id, companyId: input.companyId, action: "BOOKS_PROJECT_HISTORY_VERIFIED",
      entityType: "BooksProjectAssociation", entityId: saved.id, details: { booksProjectId: input.booksProjectId,
        dealCount: input.dealIds.length, sourceHash: input.sourceHash, allocationKnown: false, providerFinancialWrites: 0 } } });
    return { id: saved.id, companyId: saved.companyId, dealCount: input.dealIds.length, changed: true,
      status: saved.status, verifiedAt: saved.verifiedAt.toISOString() };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
}

export type BooksProjectHistoryRelation = {
  billId: string; companyId: string; organizationId: string; dataCenter: string; environment: string;
  booksProjectId: string; projectName: string; snapshotId: string; externalCrmId: string;
  canonicalJobId: string | null; jobNumber: string | null; displayReference: string | null;
  name: string | null; customerName: string | null; currencyCode: string | null;
  sourceCompanyId: string | null; verifiedAt: string;
};
export type BooksProjectHistory = { relations: BooksProjectHistoryRelation[]; warnings: string[] };

async function readContext(actor: Actor, requestedCompanyId?: string) {
  // A Books association never grants access to otherwise private, unassigned CRM records.
  const crmScope = await crmJobSourceScope(actor);
  if (requestedCompanyId) await requireCompanyAccess(actor, requestedCompanyId);
  const companyIds = (requestedCompanyId ? [requestedCompanyId] : await companyIdsForActor(actor)).sort();
  const companies = await db.company.findMany({ where: { id: { in: companyIds }, active: true },
    select: { id: true, integrationDestinations: { where: { target: "ZOHO" },
      select: { organizationId: true, dataCenter: true, environment: true } },
    crmSource: { select: { organizationId: true, dataCenter: true, environment: true } } }, orderBy: { id: "asc" } });
  for (const company of companies) company.integrationDestinations.sort((left, right) =>
    sourceKey(left.organizationId, left.dataCenter, left.environment).localeCompare(sourceKey(right.organizationId, right.dataCenter, right.environment)));
  return { crmScope, companyIds, companies };
}
function currentBinding(row: BooksProjectAssociation, context: Awaited<ReturnType<typeof readContext>>) {
  const company = context.companies.find((item) => item.id === row.companyId);
  return Boolean(company?.integrationDestinations.some((source) => source.organizationId === row.organizationId &&
    source.dataCenter === row.dataCenter && source.environment === row.environment) &&
    company.crmSource?.organizationId === row.crmOrganizationId && company.crmSource.dataCenter === row.crmDataCenter &&
    company.crmSource.environment === row.crmEnvironment);
}
type ProjectBill = { associationId: string; sourceHash: string; billId: string; companyId: string;
  organizationId: string; dataCenter: string; environment: string; booksProjectId: string };

/** Dynamic exact-ID history join. Values/allocations and private provider payloads are intentionally absent. */
export async function loadBooksProjectHistory(actor: Actor, requestedCompanyId?: string): Promise<BooksProjectHistory> {
  const context = await readContext(actor, requestedCompanyId);
  const result: BooksProjectHistory = { relations: [], warnings: [] };
  if (!canViewFinancialSummary(actor) || !context.companyIds.length) return result;
  const now = new Date();
  const cached = await db.booksProjectAssociation.findMany({ where: { companyId: { in: context.companyIds } },
    orderBy: [{ companyId: "asc" }, { id: "asc" }] });
  const eligible: BooksProjectAssociation[] = [];
  for (const row of cached) {
    if (!currentBinding(row, context)) continue;
    if (row.status === "STALE" || row.validUntil <= now) {
      result.warnings.push("Some project associations need fresh source verification; their bills are not linked to a CRM profile.");
      continue;
    }
    if (row.status === "VERIFIED") eligible.push(row);
  }
  const references = new Map<string, Map<string, string | null>>();
  const groups = new Map<string, { crmOrganizationId: string; dataCenter: string; environment: string; externalCrmId: Set<string> }>();
  for (const row of eligible) {
    const ids = z.array(externalId).parse(row.dealIds);
    const records = z.array(objectJson).parse(row.sourceCrmRecords);
    references.set(row.id, new Map(records.map((record) => [externalId.parse(record.id), text(record.DealNumber)])));
    const key = sourceKey(row.crmOrganizationId, row.crmDataCenter, row.crmEnvironment);
    const group = groups.get(key) ?? { crmOrganizationId: row.crmOrganizationId, dataCenter: row.crmDataCenter,
      environment: row.crmEnvironment, externalCrmId: new Set<string>() };
    ids.forEach((id) => group.externalCrmId.add(id));
    groups.set(key, group);
  }
  const snapshotSelect = { id: true, crmOrganizationId: true, dataCenter: true, environment: true, externalCrmId: true,
    companyId: true, canonicalJobId: true, jobNumber: true, name: true, customerName: true, currencyCode: true,
    linkStatus: true, canonicalJob: { select: { id: true, companyId: true, externalCrmId: true } } } satisfies Prisma.CrmJobSnapshotSelect;
  type Snapshot = Prisma.CrmJobSnapshotGetPayload<{ select: typeof snapshotSelect }>;
  const snapshots = new Map<string, Snapshot>();
  for (const group of groups.values()) {
    const ids = [...group.externalCrmId];
    for (let offset = 0; offset < ids.length; offset += 500) {
      const rows = await db.crmJobSnapshot.findMany({ where: { AND: [context.crmScope, {
        crmOrganizationId: group.crmOrganizationId, dataCenter: group.dataCenter, environment: group.environment,
        sourceModule: "Deals", externalCrmId: { in: ids.slice(offset, offset + 500) }, isStale: false,
      }] }, select: snapshotSelect });
      for (const row of rows) snapshots.set(`${sourceKey(row.crmOrganizationId, row.dataCenter, row.environment)}:${row.externalCrmId}`, row);
    }
  }
  const associationById = new Map(eligible.map((row) => [row.id, row]));
  const seen = new Set<string>();
  // JSON_TABLE projects only IDs, keeping full bill JSON and attachment metadata out of the join result.
  for (let offset = 0; offset < eligible.length; offset += 500) {
    const ids = eligible.slice(offset, offset + 500).map((row) => row.id);
    const bills = await db.$queryRaw<ProjectBill[]>(Prisma.sql`
      SELECT DISTINCT a.id AS associationId, a.sourceHash, b.id AS billId, b.companyId,
        b.organizationId, b.dataCenter, b.environment, a.booksProjectId
      FROM BooksProjectAssociation a
      JOIN BooksBill b ON b.companyId = a.companyId AND b.organizationId = a.organizationId
        AND b.dataCenter = a.dataCenter AND b.environment = a.environment
      JOIN JSON_TABLE(COALESCE(b.sourceDetail, JSON_OBJECT()), '$.line_items[*]'
        COLUMNS (lineOrdinal FOR ORDINALITY, projectId VARCHAR(100) PATH '$.project_id' NULL ON EMPTY NULL ON ERROR)) lineSource
        ON lineSource.projectId = a.booksProjectId
      WHERE a.id IN (${Prisma.join(ids)}) AND a.status = 'VERIFIED' AND a.validUntil > ${now}
        AND b.isStale = false AND b.sourceDetail IS NOT NULL AND b.detailImportRunId = b.lastImportRunId
        AND JSON_TYPE(JSON_EXTRACT(b.sourceDetail, CONCAT('$.line_items[', lineSource.lineOrdinal - 1, '].project_id'))) = 'STRING'
      ORDER BY b.id, a.id`);
    for (const bill of bills) {
      const association = associationById.get(bill.associationId)!;
      if (association.sourceHash !== bill.sourceHash) throw new HttpError(409, "Project associations changed. Reload the page.");
      if (association.validUntil.valueOf() <= Date.now()) continue;
      for (const externalCrmId of z.array(externalId).parse(association.dealIds)) {
        const snapshot = snapshots.get(`${sourceKey(association.crmOrganizationId, association.crmDataCenter, association.crmEnvironment)}:${externalCrmId}`);
        if (!snapshot) continue;
        const identity = `${bill.billId}:${snapshot.id}:${association.booksProjectId}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        const canonicalJobId = snapshot.linkStatus === "READY" && snapshot.companyId === bill.companyId &&
          snapshot.canonicalJob?.companyId === bill.companyId && snapshot.canonicalJob.externalCrmId === snapshot.externalCrmId ? snapshot.canonicalJob.id : null;
        result.relations.push({ billId: bill.billId, companyId: bill.companyId, organizationId: bill.organizationId,
          dataCenter: bill.dataCenter, environment: bill.environment, booksProjectId: association.booksProjectId,
          projectName: association.projectName, snapshotId: snapshot.id, externalCrmId, canonicalJobId,
          jobNumber: snapshot.jobNumber, displayReference: snapshot.jobNumber ?? references.get(association.id)?.get(externalCrmId) ?? null,
          name: snapshot.name, customerName: snapshot.customerName, currencyCode: snapshot.currencyCode,
          sourceCompanyId: snapshot.companyId, verifiedAt: association.verifiedAt.toISOString() });
      }
    }
  }
  if (canonicalJson(context) !== canonicalJson(await readContext(actor, requestedCompanyId)))
    throw new HttpError(403, "Source or company access changed. Reload the page.");
  result.warnings = [...new Set(result.warnings)];
  return result;
}
