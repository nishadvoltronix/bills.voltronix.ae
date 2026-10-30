import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Prisma, type IntegrationJob, type LiveSyncAuthorization } from "@prisma/client";
import Decimal from "decimal.js";
import { z } from "zod";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import { assertLocalBooksConnectionEnvironment } from "@/lib/services/books-local-connection";
import { verifyBooksAccountingMetadata } from "@/lib/services/books-operational-setup";
import { readPrivateDocument } from "@/lib/services/documents";
import { booksMappingFingerprint, buildBooksPayload, snapshotHash, snapshotSchema, type BillSnapshot } from "./books";
import { approvedSnapshot, sourceInclude, type BillSource } from "./source-snapshot";
import { assertNetwork, booksConfigurationHash, getBooksOrganizations, getConfig, IntegrationError, type ZohoConfig } from "./config";
import { accessToken, connectionFingerprint } from "./oauth";
import { ZohoTransport, type ProductionWriteRequest } from "./transport";

const purpose = "LOCAL_ONE_BILL_TEST" as const;
const lifetime = 10 * 60_000;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const blocked = (message: string) => new IntegrationError("LOCAL_TEST_PERMISSION_REQUIRED", message, "BLOCKED");
const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const externalId = z.string().regex(/^\d{1,30}$/);
const label = z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const reference = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/ -]{2,159}$/);
type Store = Prisma.TransactionClient;

const sourceSchema = z.object({
  companyId: id, companyName: label, organizationId: externalId, dataCenter: z.string(),
  environment: z.literal("production"), jobId: id, jobNumber: label, jobName: label, jobIsDemo: z.boolean(),
  currency: z.string().regex(/^[A-Z]{3}$/), externalCrmId: externalId,
  crmOrganizationId: externalId, crmDataCenter: z.string(), crmEnvironment: z.literal("production"),
  crmConfigurationHash: digest, sourceModule: z.string(), snapshotId: id,
}).strict();
const proofSchema = z.object({
  version: z.literal(1), purpose: z.literal(purpose), reference, runtimeHash: digest,
  verifiedAt: z.iso.datetime(), source: sourceSchema,
  vendor: z.object({ id, externalId, name: label, currency: z.string().regex(/^[A-Z]{3}$/) }).strict(),
  accounting: z.object({ providerReads: z.number().int().positive(), currencyCount: z.number().int().positive(),
    accountCount: z.number().int().positive(), taxCount: z.number().int().positive() }).strict(),
}).strict();
type Proof = z.infer<typeof proofSchema>;
const selectedSchema = z.object({ companyId: id, organizationId: externalId, jobId: id,
  externalVendorId: externalId, reference }).strict();
const issueSchema = selectedSchema.extend({ billId: id, invoiceNumber: label,
  currency: z.string().regex(/^[A-Z]{3}$/), total: z.string().regex(/^\d+(\.\d{1,2})?$/) }).strict();
const contactSchema = z.object({ code: z.literal(0), contact: z.object({ contact_id: externalId,
  contact_name: label, contact_type: z.literal("vendor"), status: z.literal("active"),
  currency_id: externalId, currency_code: z.string().regex(/^[A-Z]{3}$/) }) });
const organizationSchema = z.object({ code: z.literal(0), organization: z.object({ organization_id: externalId,
  name: label, is_org_active: z.literal(true), currency_id: externalId,
  currency_code: z.string().regex(/^[A-Z]{3}$/), price_precision: z.literal(2) }) });

/** These checks do not enable the normal production write mode. */
export function assertLocalBooksTestEnvironment() {
  try { assertLocalBooksConnectionEnvironment(); }
  catch { throw blocked("The single-bill test requires the guarded local application and database."); }
  if (["ZOHO_BOOKS_WRITE_ENABLED", "ZOHO_BOOKS_LIVE_ENABLED", "ALLOW_PRODUCTION_ACCOUNTING_WRITES", "INTEGRATION_TEST_MODE"]
    .some(key => process.env[key] !== "false") || process.env.MANUAL_ENTRY_ONLY !== "false")
    throw blocked("Keep normal accounting-write flags disabled and Save and sync enabled for the scoped local test.");
}
export function assertLocalBooksTestSetupEnvironment() {
  assertLocalBooksTestEnvironment();
  if (process.env.ALLOW_LOCAL_BOOKS_TEST_SETUP !== "true")
    throw blocked("The trusted operator must explicitly enable setup for the one selected local test bill.");
}
function runtimeHash() {
  assertLocalBooksTestEnvironment();
  return hash(JSON.stringify([process.env.APP_ENV, process.env.APP_URL, process.env.DATABASE_URL]));
}
function configuration(organizationId: string, expected?: ZohoConfig) {
  assertLocalBooksTestEnvironment();
  const config = getConfig("ZOHO", process.env, organizationId);
  assertNetwork(config);
  if (config.target !== "ZOHO" || config.environment !== "production" || config.writeEnabled || config.liveRuntime ||
    (expected && (booksConfigurationHash(expected) !== booksConfigurationHash(config) || expected.apiOrigin !== config.apiOrigin ||
      expected.accountsOrigin !== config.accountsOrigin || expected.networkEnabled !== config.networkEnabled || expected.writeEnabled !== config.writeEnabled ||
      expected.liveRuntime !== config.liveRuntime)))
    throw blocked("The one-bill permission requires its unchanged production Books connection with normal writes disabled.");
  return config;
}
async function activeCredential(store: Store, config: ZohoConfig) {
  const grant = await store.integrationCredential.findUnique({ where: {
    target_organizationId: { target: config.target, organizationId: config.organizationId },
  }, select: { revokedAt: true, connectionFingerprint: true } });
  if (!grant || grant.revokedAt || grant.connectionFingerprint !== connectionFingerprint(config))
    throw blocked("Current organization-specific OAuth authorization is required for the selected source.");
}
async function context(store: Store, actorId: string, companyId: string, jobId: string, config: ZohoConfig) {
  configuration(config.organizationId, config);
  if (!await store.user.findFirst({ where: { id: actorId, active: true, role: "ADMIN",
    memberships: { some: { companyId, active: true, company: { active: true } } } }, select: { id: true } }))
    throw new HttpError(403, "The same active administrator and company membership are required for this local test.");
  const company = await store.company.findUnique({ where: { id: companyId }, include: { crmSource: true, integrationDestinations: true } });
  const profile = getBooksOrganizations().find(row => row.organizationId === config.organizationId);
  const destinations = company?.integrationDestinations.filter(row => row.target === "ZOHO") ?? [];
  if (!company || !profile || !company.active || !company.isDemo || company.liveAccountingEnabled ||
    company.id !== `connection-check-books-${config.organizationId}` || company.name !== `[CONNECTION CHECK] ${profile.name}` ||
    destinations.length !== 1 || destinations[0].organizationId !== config.organizationId ||
    destinations[0].dataCenter !== config.dataCenter || destinations[0].environment !== "production" || destinations[0].liveEnabled)
    throw blocked("The unchanged local company must retain its exact disabled Books organization binding.");
  const job = await store.job.findUnique({ where: { id: jobId } });
  const crmSource = company.crmSource;
  if (!job || job.companyId !== companyId || !job.externalCrmId || !/^\d{1,30}$/.test(job.externalCrmId) ||
    /^demo[-_]/i.test(job.id) || !crmSource || crmSource.environment !== "production")
    throw blocked("Select a real imported CRM job in this exact company.");
  const crm = getConfig("CRM", process.env, crmSource.organizationId);
  assertNetwork(crm);
  if (crm.organizationId !== crmSource.organizationId || crm.dataCenter !== crmSource.dataCenter || crm.environment !== crmSource.environment)
    throw blocked("The current CRM connection differs from the job's source organization.");
  const snapshots = await store.crmJobSnapshot.findMany({ where: { crmOrganizationId: crm.organizationId,
    dataCenter: crm.dataCenter, environment: crm.environment, companyId, normalizedJobNumber: job.jobNumber,
    isStale: false }, select: { id: true, canonicalJobId: true, externalCrmId: true, booksOrganizationId: true,
    currencyCode: true, linkStatus: true, sourceModule: true } });
  const snapshot = snapshots[0];
  if (snapshots.length !== 1 || snapshot.linkStatus !== "READY" || snapshot.canonicalJobId !== job.id ||
    snapshot.externalCrmId !== job.externalCrmId || snapshot.booksOrganizationId !== config.organizationId ||
    snapshot.currencyCode !== job.currency || snapshot.sourceModule !== (crm.crmMapping?.jobModule ?? "Deals"))
    throw blocked("The CRM job requires one current, unambiguous source record with the exact Books company assignment.");
  await activeCredential(store, config); await activeCredential(store, crm);
  const cooldown = await store.incomingSyncState.findUnique({ where: { target_organizationId_dataCenter_environment: {
    target: "ZOHO", organizationId: config.organizationId, dataCenter: config.dataCenter, environment: config.environment,
  } }, select: { backoffUntil: true, lastErrorCode: true } });
  // A successful low-quota reserve has no error; it preserves capacity for this manual action.
  if (cooldown?.backoffUntil && cooldown.backoffUntil.getTime() > Date.now() &&
    ["INCOMING_RATE_LIMIT", "INCOMING_DAILY_QUOTA"].includes(cooldown.lastErrorCode ?? ""))
    throw blocked("The provider reported an active quota cooldown. Preserve it until the documented retry time.");
  const source = sourceSchema.parse({ companyId, companyName: company.name, organizationId: config.organizationId,
    dataCenter: config.dataCenter, environment: config.environment, jobId, jobNumber: job.jobNumber, jobName: job.name, jobIsDemo: job.isDemo,
    currency: job.currency, externalCrmId: job.externalCrmId, crmOrganizationId: crm.organizationId,
    crmDataCenter: crm.dataCenter, crmEnvironment: crm.environment,
    crmConfigurationHash: hash(JSON.stringify([connectionFingerprint(crm), crm.crmMapping ?? null])),
    sourceModule: snapshot.sourceModule, snapshotId: snapshot.id });
  return { source, organizationName: profile.name, crm };
}

/** A bounded GET-only wrapper. It cannot enable financial requests on its inner transport. */
function readTransport(config: ZohoConfig, provided?: ZohoTransport, maximum = 12) {
  if (provided && (booksConfigurationHash(provided.config) !== booksConfigurationHash(config) ||
    provided.config.target !== config.target || provided.config.apiOrigin !== config.apiOrigin || provided.config.accountsOrigin !== config.accountsOrigin ||
    !provided.config.networkEnabled || provided.config.writeEnabled))
    throw blocked("The supplied read connection differs from the exact selected source.");
  const inner = provided ?? new ZohoTransport(config, () => accessToken(config), async (url, init) => {
    if ((init?.method ?? "GET") !== "GET") throw blocked("Local test setup permits provider GET requests only.");
    const response = await fetch(url, init);
    if (config.target === "ZOHO" && response.ok) assertLocalBooksTestReadQuota(response.headers.get("x-rate-limit-remaining"));
    return response;
  });
  // Defined lazily: Transport imports the capability validator from this module.
  return new class extends ZohoTransport {
    reads = 0;
    private lastAt = 0;
    constructor() { super(config, () => accessToken(config)); }
    override async request(path: string, options: Parameters<ZohoTransport["request"]>[1] = {}) {
      if ((options.method ?? "GET") !== "GET" || ++this.reads > maximum)
        throw blocked("The bounded local test metadata-read budget was exceeded.");
      if (!provided) {
        const delay = 1100 - (Date.now() - this.lastAt);
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
        this.lastAt = Date.now();
      }
      return inner.request(path, { ...options, method: "GET" });
    }
  }();
}
/** Signed values occur in successful provider responses; negative never means unknown. */
export function assertLocalBooksTestReadQuota(remaining: string | null) {
  if (remaining === null || !/^-?\d+$/.test(remaining) || !Number.isSafeInteger(Number(remaining)) || Number(remaining) < 16)
    throw blocked("Books did not confirm sufficient remaining quota for this bounded manual test.");
}
async function verifyFiles(bill: BillSource) {
  for (const document of bill.documents)
    if (hash(await readPrivateDocument(document)) !== document.sha256)
      throw blocked("A saved document no longer matches the exact permitted bill snapshot.");
}
async function vendorForBill(store: Store, bill: BillSource, config: ZohoConfig) {
  const mapping = await store.vendorBooksMapping.findUnique({ where: { vendorId_organizationId_dataCenter_environment: {
    vendorId: bill.vendorId, organizationId: config.organizationId, dataCenter: config.dataCenter, environment: config.environment,
  } } });
  if (!mapping || bill.vendor.companyId !== bill.companyId || bill.job.companyId !== bill.companyId ||
    bill.vendor.isDemo || /^demo[-_]/i.test(bill.vendorId) || bill.vendor.currency !== bill.currency || bill.job.currency !== bill.currency ||
    (bill.vendor.externalZohoId && bill.vendor.externalZohoId !== mapping.externalVendorId))
    throw blocked("The bill requires its exact verified existing supplier, job and matching currency.");
  return { id: bill.vendorId, externalId: mapping.externalVendorId, name: bill.vendor.name, currency: bill.vendor.currency };
}
function permittedSnapshot(bill: BillSource, config: ZohoConfig, permitId: string, proofHash: string, vendorId: string, version = bill.version) {
  const snapshot = approvedSnapshot(bill, vendorId);
  snapshot.sourceVersion = version;
  snapshot.destination = { dataCenter: config.dataCenter, environment: "production", mappingHash: booksMappingFingerprint(config),
    configurationHash: booksConfigurationHash(config), liveAuthorizationId: permitId, authorizationReference: `${purpose}:${proofHash}` };
  buildBooksPayload(snapshot, config);
  return snapshot;
}

/** Selected existing provider supplier only; no contact, bill or payment is created remotely. */
export async function prepareLocalLiveTestSupplier(actor: Actor, payload: unknown, provided?: ZohoTransport) {
  assertLocalBooksTestSetupEnvironment();
  if (actor.role !== "ADMIN") throw new HttpError(403, "An administrator is required.");
  const input = selectedSchema.parse(payload);
  const config = configuration(input.organizationId);
  const before = await context(db, actor.id, input.companyId, input.jobId, config);
  const transport = readTransport(config, provided, 2);
  const organization = organizationSchema.parse(await transport.request(`/books/v3/organizations/${config.organizationId}`)).organization;
  if (organization.organization_id !== config.organizationId || organization.name !== before.organizationName ||
    organization.currency_code !== before.source.currency)
    throw blocked("The selected organization must confirm this job's exact base currency.");
  const contact = contactSchema.parse(await transport.request(`/books/v3/contacts/${input.externalVendorId}`)).contact;
  if (contact.contact_id !== input.externalVendorId || contact.currency_id !== organization.currency_id ||
    contact.currency_code !== before.source.currency)
    throw blocked("The selected active supplier must belong to the exact company and job currency.");
  return db.$transaction(async tx => {
    assertLocalBooksTestSetupEnvironment();
    if (JSON.stringify((await context(tx, actor.id, input.companyId, input.jobId, config)).source) !== JSON.stringify(before.source))
      throw blocked("The selected source changed during supplier verification.");
    const destination = { organizationId: config.organizationId, dataCenter: config.dataCenter, environment: config.environment };
    const existing = await tx.vendorBooksMapping.findUnique({ where: { organizationId_dataCenter_environment_externalVendorId: {
      ...destination, externalVendorId: input.externalVendorId,
    } }, include: { vendor: true } });
    if (existing) {
      if (existing.vendor.companyId !== input.companyId || existing.vendor.isDemo || existing.vendor.name !== contact.contact_name ||
        existing.vendor.currency !== contact.currency_code ||
        (existing.vendor.externalZohoId && existing.vendor.externalZohoId !== contact.contact_id))
        throw blocked("An existing supplier mapping conflicts with this exact source identity.");
      return { vendorId: existing.vendorId, created: false, providerReads: transport.reads, providerFinancialWrites: 0 };
    }
    if (await tx.vendor.findFirst({ where: { companyId: input.companyId,
      OR: [{ name: contact.contact_name }, { externalZohoId: contact.contact_id }] }, select: { id: true } }))
      throw blocked("An existing local supplier requires explicit identity review; no name-based mapping was inferred.");
    const vendor = await tx.vendor.create({ data: { companyId: input.companyId, name: contact.contact_name,
      currency: contact.currency_code, isDemo: false } });
    await tx.vendorBooksMapping.create({ data: { vendorId: vendor.id, ...destination, externalVendorId: contact.contact_id } });
    await tx.auditLog.create({ data: { actorId: actor.id, companyId: input.companyId, action: "LOCAL_TEST_SUPPLIER_VERIFIED",
      entityType: "Vendor", entityId: vendor.id, details: { ...destination, externalVendorId: contact.contact_id,
        jobId: input.jobId, reference: input.reference, providerFinancialWrites: 0 } } });
    return { vendorId: vendor.id, created: true, providerReads: transport.reads, providerFinancialWrites: 0 };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20_000 });
}

/** Trusted operator setup for one existing draft. The ordinary form still performs the final save. */
export async function issueLocalLiveTestAuthorization(actor: Actor, payload: unknown,
  provided: { books?: ZohoTransport; crm?: ZohoTransport } = {}) {
  assertLocalBooksTestSetupEnvironment();
  if (actor.role !== "ADMIN") throw new HttpError(403, "An administrator is required.");
  const input = issueSchema.parse(payload);
  const config = configuration(input.organizationId);
  const bill = await db.bill.findUnique({ where: { id: input.billId }, include: sourceInclude });
  if (!bill || bill.status !== "DRAFT" || bill.createdById !== actor.id || bill.companyId !== input.companyId ||
    bill.jobId !== input.jobId || bill.invoiceNumber !== input.invoiceNumber || bill.currency !== input.currency ||
    !new Decimal(input.total).isPositive() || !bill.total.equals(input.total) || bill.paidAmount.gt(0))
    throw blocked("Review the exact saved draft, creator, company, job, invoice, currency and total before issuing this one-bill permission.");
  if (await db.integrationJob.findFirst({ where: { billId: bill.id }, select: { id: true } }))
    throw blocked("An existing synchronization operation cannot be replaced by a new local permission.");
  const before = await context(db, actor.id, input.companyId, input.jobId, config);
  const vendor = await vendorForBill(db, bill, config);
  if (vendor.externalId !== input.externalVendorId) throw blocked("The selected supplier differs from this bill's exact mapping.");
  const books = readTransport(config, provided.books);
  const accounting = await verifyBooksAccountingMetadata(books, before.organizationName);
  const contact = contactSchema.parse(await books.request(`/books/v3/contacts/${vendor.externalId}`)).contact;
  if (contact.contact_id !== vendor.externalId || contact.contact_name !== vendor.name || contact.currency_code !== bill.currency ||
    config.booksMapping!.currencies[bill.currency]?.id !== contact.currency_id)
    throw blocked("The saved supplier no longer matches its active provider identity or configured currency.");
  const crm = readTransport(before.crm, provided.crm, 2);
  const org = z.object({ org: z.array(z.object({ id: z.string().optional(), zgid: z.string().optional(), type: z.string() })) })
    .parse(await crm.request("/crm/v8/org"));
  if (!org.org.some(row => (row.id === before.crm.organizationId || row.zgid === before.crm.organizationId) && row.type === "production"))
    throw blocked("CRM did not confirm this job's exact production source organization.");
  const jobField = before.crm.crmMapping?.jobNumberField ?? "JobDealNumber";
  const currencyField = before.crm.crmMapping?.currencyField ?? "Currency";
  const records = z.object({ data: z.array(z.record(z.string(), z.unknown())).length(1) }).parse(await crm.request(
    `/crm/v8/${before.source.sourceModule}/${before.source.externalCrmId}`,
    { query: { fields: `id,${jobField},Books_Organization_ID,${currencyField}` } })).data;
  if (records[0].id !== before.source.externalCrmId || records[0][jobField] !== before.source.jobNumber ||
    records[0].Books_Organization_ID !== input.organizationId || records[0][currencyField] !== bill.currency)
    throw blocked("The current CRM record does not confirm this exact job, company organization and currency.");
  await verifyFiles(bill);
  const proof: Proof = proofSchema.parse({ version: 1, purpose, reference: input.reference, runtimeHash: runtimeHash(),
    verifiedAt: new Date().toISOString(), source: before.source, vendor, accounting });
  const proofHash = hash(JSON.stringify(proof));
  return db.$transaction(async tx => {
    await tx.$queryRaw(Prisma.sql`SELECT \`id\` FROM \`Bill\` WHERE \`id\`=${bill.id} FOR UPDATE`);
    assertLocalBooksTestSetupEnvironment();
    const current = await tx.bill.findUniqueOrThrow({ where: { id: bill.id }, include: sourceInclude });
    if (current.status !== "DRAFT" || current.createdById !== actor.id || current.version !== bill.version ||
      snapshotHash(approvedSnapshot(current, vendor.externalId)) !== snapshotHash(approvedSnapshot(bill, vendor.externalId)) ||
      JSON.stringify((await context(tx, actor.id, current.companyId, current.jobId, config)).source) !== JSON.stringify(proof.source) ||
      JSON.stringify(await vendorForBill(tx, current, config)) !== JSON.stringify(proof.vendor) || runtimeHash() !== proof.runtimeHash)
      throw blocked("The saved draft, source, supplier or runtime changed during verification.");
    if (await tx.integrationJob.findFirst({ where: { billId: bill.id }, select: { id: true } }))
      throw blocked("A synchronization operation already exists; its original permission cannot be replaced.");
    const previous = await tx.liveSyncAuthorization.findUnique({ where: { billId: bill.id } });
    if (previous && (previous.purpose !== purpose || previous.confirmedAt || previous.canonicalJobId || previous.revokedAt))
      throw blocked("A previous live permission requires review and cannot be replaced by this local test.");
    const authorizationId = previous?.id ?? randomUUID();
    const snapshot = permittedSnapshot(current, config, authorizationId, proofHash, vendor.externalId, current.version + 1);
    const expiresAt = new Date(Date.now() + lifetime);
    const data = { purpose, localProof: proof, localProofHash: proofHash, companyId: bill.companyId,
      actorId: actor.id, organizationId: config.organizationId, dataCenter: config.dataCenter, sourceVersion: snapshot.sourceVersion,
      challengeHash: hash(randomBytes(32)), payloadHash: snapshotHash(snapshot), configurationHash: booksConfigurationHash(config),
      expiresAt, createdAt: new Date(), confirmedAt: null };
    await tx.liveSyncAuthorization.upsert({ where: { billId: bill.id }, create: { id: authorizationId, billId: bill.id, ...data }, update: data });
    await tx.auditLog.create({ data: { actorId: actor.id, companyId: bill.companyId, action: "LOCAL_ONE_BILL_TEST_AUTHORIZED",
      entityType: "Bill", entityId: bill.id, details: { authorizationId, reference: input.reference, payloadHash: data.payloadHash,
        localProofHash: proofHash, organizationId: config.organizationId, sourceVersion: snapshot.sourceVersion,
        expiresAt: expiresAt.toISOString(), providerFinancialWrites: 0 } } });
    return { authorizationId, billId: bill.id, organizationId: config.organizationId, jobNumber: bill.job.jobNumber,
      invoiceNumber: bill.invoiceNumber, currency: bill.currency, total: bill.total.toFixed(2),
      sourceVersion: snapshot.sourceVersion, expiresAt: expiresAt.toISOString(), payloadHash: data.payloadHash,
      providerReads: books.reads + crm.reads, providerFinancialWrites: 0 };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20_000 });
}

export function isLocalLiveTestSnapshot(snapshot: BillSnapshot) {
  return snapshot.destination?.authorizationReference?.startsWith(`${purpose}:`) === true;
}
async function validatePermit(store: Store, bill: BillSource, config: ZohoConfig, permit: LiveSyncAuthorization,
  actorId: string, reconcileOnly = false) {
  const parsed = proofSchema.safeParse(permit.localProof);
  if (!parsed.success || permit.purpose !== purpose || permit.revokedAt || permit.billId !== bill.id ||
    permit.actorId !== actorId || bill.createdById !== actorId || permit.companyId !== bill.companyId ||
    permit.organizationId !== config.organizationId || permit.dataCenter !== config.dataCenter ||
    permit.configurationHash !== booksConfigurationHash(config) || permit.sourceVersion !== bill.version ||
    !["READY", "APPROVED"].includes(bill.status) || permit.createdAt.getTime() > Date.now() ||
    permit.expiresAt.getTime() <= permit.createdAt.getTime() || permit.expiresAt.getTime() - permit.createdAt.getTime() > lifetime ||
    (!reconcileOnly && permit.expiresAt.getTime() <= Date.now()))
    throw blocked("The exact local bill permission expired, was revoked or no longer matches its saved source.");
  const proof = parsed.data;
  if (hash(JSON.stringify(proof)) !== permit.localProofHash || proof.runtimeHash !== runtimeHash() ||
    Date.parse(proof.verifiedAt) > permit.createdAt.getTime() || permit.createdAt.getTime() - Date.parse(proof.verifiedAt) > 300_000 ||
    JSON.stringify((await context(store, actorId, bill.companyId, bill.jobId, config)).source) !== JSON.stringify(proof.source) ||
    JSON.stringify(await vendorForBill(store, bill, config)) !== JSON.stringify(proof.vendor))
    throw blocked("The source proof, company, supplier, actor or local runtime changed after authorization.");
  const snapshot = permittedSnapshot(bill, config, permit.id, permit.localProofHash!, proof.vendor.externalId);
  if (snapshotHash(snapshot) !== permit.payloadHash)
    throw blocked("The saved invoice, amounts, line selections or document list differ from the permitted snapshot.");
  return snapshot;
}
export async function prepareLocalLiveTestSnapshot(store: Store, bill: BillSource, config: ZohoConfig, actorId: string) {
  const permit = await store.liveSyncAuthorization.findUnique({ where: { billId: bill.id } });
  if (!permit || permit.purpose !== purpose) return null;
  const snapshot = await validatePermit(store, bill, config, permit, actorId);
  await verifyFiles(bill);
  if (permit.confirmedAt || permit.canonicalJobId) {
    const existing = permit.canonicalJobId && await store.integrationJob.findUnique({ where: { id: permit.canonicalJobId } });
    if (!permit.confirmedAt || !existing || existing.billId !== bill.id || existing.payloadHash !== permit.payloadHash ||
      existing.idempotencyKey !== `ZOHO:${bill.id}:CREATE_BILL` || existing.initiatedById)
      throw blocked("The existing local permission does not match its original canonical operation.");
  }
  return { permit, snapshot };
}
export async function recordLocalLiveTestConfirmation(store: Store, authorizationId: string, job: IntegrationJob, actorId: string, companyId: string) {
  const previous = await store.liveSyncAuthorization.findUnique({ where: { id: authorizationId } });
  if (previous?.purpose === purpose && previous.confirmedAt && previous.canonicalJobId === job.id &&
    previous.actorId === actorId && previous.companyId === companyId && previous.billId === job.billId &&
    previous.payloadHash === job.payloadHash && !previous.revokedAt && previous.expiresAt.getTime() > Date.now()) return;
  if (job.target !== "ZOHO" || job.operation !== "CREATE_BILL" || job.initiatedById ||
    job.idempotencyKey !== `ZOHO:${job.billId}:CREATE_BILL`) throw blocked("The local permission can bind only its canonical bill operation.");
  const changed = await store.liveSyncAuthorization.updateMany({ where: { id: authorizationId, purpose, actorId, companyId,
    billId: job.billId, organizationId: job.organizationId, payloadHash: job.payloadHash, sourceVersion: job.sourceVersion,
    confirmedAt: null, canonicalJobId: null, revokedAt: null, expiresAt: { gt: new Date() } },
    data: { confirmedAt: new Date(), canonicalJobId: job.id } });
  if (changed.count !== 1) throw blocked("The one-bill permission was already consumed, changed or expired during final save.");
  await store.auditLog.create({ data: { actorId, companyId, action: "LOCAL_ONE_BILL_TEST_CONFIRMED", entityType: "Bill", entityId: job.billId,
    details: { authorizationId, jobId: job.id, organizationId: job.organizationId, payloadHash: job.payloadHash } } });
}
export async function assertLocalLiveTestJobPermission(job: IntegrationJob, config: ZohoConfig,
  options: { verifyFiles?: boolean; reconcileOnly?: boolean } = {}) {
  const snapshot = snapshotSchema.parse(job.snapshot);
  if (job.target !== "ZOHO" || job.initiatedById || !isLocalLiveTestSnapshot(snapshot) ||
    !snapshot.destination?.liveAuthorizationId || snapshot.internalBillId !== job.billId ||
    snapshot.sourceVersion !== job.sourceVersion || snapshotHash(snapshot) !== job.payloadHash ||
    snapshot.destination.environment !== "production" || snapshot.destination.dataCenter !== config.dataCenter ||
    job.organizationId !== config.organizationId || (options.reconcileOnly && !job.needsReconciliation))
    throw blocked("This operation does not carry an intact exact local-bill permission.");
  const permit = await db.liveSyncAuthorization.findUnique({ where: { id: snapshot.destination.liveAuthorizationId } });
  if (!permit || !permit.confirmedAt || permit.confirmedAt.getTime() > Date.now() || !permit.canonicalJobId || permit.payloadHash !== job.payloadHash)
    throw blocked("The local bill permission was not confirmed for its original canonical operation.");
  const canonical = await db.integrationJob.findUnique({ where: { id: permit.canonicalJobId } });
  if (!canonical || canonical.billId !== job.billId || canonical.target !== "ZOHO" || canonical.operation !== "CREATE_BILL" ||
    canonical.initiatedById || canonical.organizationId !== job.organizationId || canonical.payloadHash !== job.payloadHash ||
    canonical.idempotencyKey !== `ZOHO:${job.billId}:CREATE_BILL` ||
    (job.operation === "CREATE_BILL" ? canonical.id !== job.id : job.operation !== "ATTACH_DOCUMENT" ||
      canonical.status !== "SUCCEEDED" || canonical.externalId !== job.externalId))
    throw blocked("The local operation is not the permitted bill or one of its exact saved attachments.");
  const bill = await db.bill.findUnique({ where: { id: job.billId }, include: sourceInclude });
  if (!bill) throw blocked("The saved local test bill is unavailable.");
  const current = await validatePermit(db, bill, config, permit, permit.actorId, options.reconcileOnly);
  if (snapshotHash(current) !== job.payloadHash) throw blocked("The queued local bill changed after authorization.");
  if (options.verifyFiles !== false) await verifyFiles(bill);
  if (!options.reconcileOnly && permit.expiresAt.getTime() <= Date.now()) throw blocked("The one-bill permission expired during verification.");
  return { snapshot, expiresAt: permit.expiresAt };
}

/** Object identity is process-local; a JSON object or arbitrary callback is never permission. */
export type LocalLiveTestWriteCapability = Readonly<{ kind: "LOCAL_ONE_BILL_TEST" }>;
const capabilities = new WeakMap<LocalLiveTestWriteCapability, { jobId: string; leaseToken: string }>();
export function createLocalLiveTestWriteCapability(jobId: string, leaseToken: string): LocalLiveTestWriteCapability {
  if (!id.safeParse(jobId).success || !/^[A-Za-z0-9_-]{1,100}$/.test(leaseToken)) throw blocked("An exact leased operation is required.");
  const capability = Object.freeze({ kind: purpose });
  capabilities.set(capability, { jobId, leaseToken });
  return capability;
}
export async function assertLocalLiveTestWriteCapability(capability: LocalLiveTestWriteCapability, config: ZohoConfig,
  request?: ProductionWriteRequest) {
  const authority = capabilities.get(capability);
  if (!authority) throw blocked("A supplied object is not a trusted local write capability.");
  const readLease = async () => {
    const job = await db.integrationJob.findUnique({ where: { id: authority.jobId } });
    if (!job || job.status !== "PROCESSING" || job.leaseToken !== authority.leaseToken || !job.leaseUntil ||
      job.leaseUntil.getTime() <= Date.now() || job.needsReconciliation)
      throw blocked("Only the exact active worker lease may use this local bill permission.");
    return job;
  };
  const job = await readLease();
  const { snapshot } = await assertLocalLiveTestJobPermission(job, config);
  if (request) {
    if (job.operation === "CREATE_BILL") {
      if (request.path !== "/books/v3/bills" || request.form || JSON.stringify(request.body) !== JSON.stringify(buildBooksPayload(snapshot, config)))
        throw blocked("The outgoing bill differs from the exact permitted snapshot.");
    } else if (job.operation === "ATTACH_DOCUMENT") {
      const expected = snapshot.documents.find(document => document.id === job.documentId);
      const file = request.form?.get("attachment");
      if (!expected || request.body || request.path !== `/books/v3/bills/${job.externalId}/attachment` || !request.form ||
        [...request.form.keys()].length !== 1 || !(file instanceof File) || file.name !== expected.fileName ||
        file.type !== expected.mimeType || hash(new Uint8Array(await file.arrayBuffer())) !== expected.sha256)
        throw blocked("The outgoing attachment differs from the document included in the permitted snapshot.");
    } else throw blocked("The one-bill permission cannot authorize this provider operation.");
  }
  await assertLocalLiveTestJobPermission(await readLease(), configuration(job.organizationId, config), { verifyFiles: false });
  await readLease();
}
