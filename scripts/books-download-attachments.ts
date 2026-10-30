import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { db } from "../src/lib/db";
import { HttpError } from "../src/lib/http";
import { assertNetwork, getBooksOrganizations, getConfig, IntegrationError } from "../src/lib/integrations/config";
import { accessToken } from "../src/lib/integrations/oauth";
import { authenticateAccountOperator } from "../src/lib/services/accounts";
import { assertBooksCatalogEnvironment } from "../src/lib/services/books-accounting-catalog";
import { assertBooksImportContext } from "../src/lib/services/books-import-access";
import { describeBooksAttachments, getBooksAttachmentSourceMetadata, importBooksBillAttachment } from "../src/lib/services/books-attachments";
import { emptyAttachmentQuota, fetchBooksOriginalAttachment, runBooksAttachmentDownloads, type AttachmentDownloadState, type AttachmentWork } from "../src/lib/services/books-attachment-download";
import { detectDocumentType, readPrivateDocument } from "../src/lib/services/documents";
import { lockAttachmentDownloadState, parseAttachmentDownloadArguments, privateAttachmentStateFile, readAttachmentDownloadState, writeAttachmentDownloadState } from "./lib/books-attachment-state";

let release: (() => Promise<void>) | undefined;
let state: AttachmentDownloadState | undefined;
let stateFile: string | undefined;
let stopped = false;
process.on("SIGINT", () => { stopped = true; });
process.on("SIGTERM", () => { stopped = true; });

try {
  const options = parseAttachmentDownloadArguments(process.argv.slice(2));
  assertBooksCatalogEnvironment();
  stateFile = await privateAttachmentStateFile(options.state);
  release = await lockAttachmentDownloadState(stateFile);
  const previous = await readAttachmentDownloadState(stateFile);
  const actor = await authenticateAccountOperator(
    process.env.ACCOUNT_OPERATOR_EMAIL ?? (process.env.APP_ENV !== "production" ? process.env.SEED_ADMIN_EMAIL : undefined) ?? "",
    process.env.ACCOUNT_OPERATOR_PASSWORD ?? (process.env.APP_ENV !== "production" ? process.env.SEED_ADMIN_PASSWORD : undefined) ?? "",
  );
  const configured = getBooksOrganizations().map((entry) => entry.organizationId);
  const organizations = options.organizations.length ? options.organizations : configured;
  if (organizations.some((id) => !configured.includes(id)) || [...options.notBefore.keys()].some((id) => !organizations.includes(id))) throw new Error("The requested organization is not configured for this run.");
  const bills = await db.booksBill.findMany({ where: { organizationId: { in: organizations } }, include: { attachments: true }, orderBy: [{ organizationId: "asc" }, { id: "asc" }] });
  const destinations = [...new Map(bills.map((bill) => [`${bill.companyId}:${bill.organizationId}:${bill.dataCenter}:${bill.environment}`, bill])).values()];
  for (const bill of destinations) {
    const context = await assertBooksImportContext(db, actor, bill.companyId, bill.organizationId);
    if (context.dataCenter !== bill.dataCenter || context.environment !== bill.environment) throw new Error("The stored attachment source differs from current configuration.");
  }
  const database = new URL(process.env.DATABASE_URL ?? "");
  const scopeHash = createHash("sha256").update(JSON.stringify({ database: `${database.protocol}//${database.host}${database.pathname}`, organizations: [...organizations].sort(), destinations: destinations.map((bill) => [bill.companyId, bill.organizationId, bill.dataCenter, bill.environment]).sort() })).digest("hex");
  if (previous && previous.scopeHash !== scopeHash) throw new Error("Attachment progress belongs to a different database or source scope.");
  state = { version: 1, scopeHash, startedAt: previous?.startedAt ?? new Date().toISOString(), updatedAt: new Date().toISOString(), status: "RUNNING",
    providerReads: previous?.providerReads ?? 0, providerFinancialWrites: 0, expected: 0, available: 0, pending: 0, metadataPendingBills: 0, nextResumeAt: null, organizations: {}, failures: [] };
  for (const organizationId of organizations) {
    const quota = previous?.organizations[organizationId]?.quota ?? emptyAttachmentQuota();
    const guard = options.notBefore.get(organizationId);
    if (guard && Date.parse(guard) > Date.now() && (!quota.notBefore || Date.parse(guard) > Date.parse(quota.notBefore))) {
      quota.notBefore = guard; quota.reason = "OPERATOR_NOT_BEFORE";
    }
    state.organizations[organizationId] = { expected: 0, available: 0, quota };
  }
  const work: AttachmentWork[] = [];
  for (const bill of bills) {
    if (bill.sourceDetail === null || bill.detailImportRunId !== bill.lastImportRunId) { state.metadataPendingBills++; continue; }
    const description = describeBooksAttachments(bill, bill.attachments);
    if (description.hasAttachment && description.attachmentCount === 0) { state.metadataPendingBills++; continue; }
    for (const document of description.documents) {
      state.expected++;
      state.organizations[bill.organizationId].expected++;
      if (!document.id) {
        state.failures.push({ billId: bill.id, externalDocumentId: "unknown", code: "SOURCE_DOCUMENT_ID_MISSING" });
        continue;
      }
      try { getBooksAttachmentSourceMetadata(bill, document.id); }
      catch { state.failures.push({ billId: bill.id, externalDocumentId: document.id, code: "SOURCE_METADATA_INVALID" }); continue; }
      const existing = bill.attachments.find((attachment) => attachment.id === document.attachmentId);
      let available = false;
      if (existing) {
        try { await readPrivateDocument(existing); available = true; }
        catch (error) { if (!(error instanceof HttpError) || ![404, 409, 415].includes(error.status)) throw error; }
      }
      if (available) { state.available++; state.organizations[bill.organizationId].available++; }
      else work.push({ billId: bill.id, organizationId: bill.organizationId, externalBillId: bill.externalBillId, externalDocumentId: document.id });
    }
  }
  state.pending = state.expected - state.available;
  let lastPrint = 0;
  let lastStatus = "";
  const report = (progress: AttachmentDownloadState) => ({ status: progress.status, expected: progress.expected, available: progress.available, pending: progress.pending,
    metadataPendingBills: progress.metadataPendingBills, failed: progress.failures.length, providerReadAttempts: progress.providerReads, providerFinancialWrites: 0,
    nextResumeAt: progress.nextResumeAt, organizations: Object.fromEntries(Object.entries(progress.organizations).map(([id, value]) => [id, { expected: value.expected, available: value.available, notBefore: value.quota.notBefore, reason: value.quota.reason }])) });
  const persist = async (progress: AttachmentDownloadState) => {
    await writeAttachmentDownloadState(stateFile!, progress);
    if (Date.now() - lastPrint >= 60_000 || progress.status !== lastStatus) { console.log(JSON.stringify(report(progress))); lastPrint = Date.now(); lastStatus = progress.status; }
  };
  const guardSource = async (item: AttachmentWork) => {
    const bill = await db.booksBill.findUnique({ where: { id: item.billId } });
    if (!bill || bill.externalBillId !== item.externalBillId || bill.organizationId !== item.organizationId) throw new HttpError(409, "The Books bill source changed.");
    const context = await assertBooksImportContext(db, actor, bill.companyId, item.organizationId);
    if (context.dataCenter !== bill.dataCenter || context.environment !== bill.environment) throw new HttpError(409, "The Books source destination changed.");
    getBooksAttachmentSourceMetadata(bill, item.externalDocumentId);
    const config = getConfig("ZOHO", process.env, item.organizationId);
    assertNetwork(config);
    return config;
  };
  await runBooksAttachmentDownloads(work, state, { wait: options.wait }, {
    now: Date.now, stopped: () => stopped,
    sleep: async (milliseconds) => { let remaining = milliseconds; while (remaining > 0 && !stopped) { const interval = Math.min(1000, remaining); await delay(interval); remaining -= interval; } },
    request: async (item) => {
      const config = await guardSource(item);
      return fetchBooksOriginalAttachment(config, async () => { const token = await accessToken(config); await guardSource(item); return token; }, item);
    },
    save: async (item, bytes) => {
      const mimeType = detectDocumentType(Buffer.from(bytes)).mimeType;
      await importBooksBillAttachment(actor, { billId: item.billId, organizationId: item.organizationId, externalDocumentId: item.externalDocumentId,
        file: new File([new Uint8Array(bytes)], `original-${item.externalDocumentId}`, { type: mimeType }), downloadedAt: new Date() });
    }, persist,
  });
  // Verify newly imported and previously present originals once at completion, not during each wait interval.
  if (state.status === "COMPLETE") {
    const latest = await db.booksBill.findMany({ where: { organizationId: { in: organizations } }, include: { attachments: true } });
    let verified = 0;
    for (const bill of latest) {
      await assertBooksImportContext(db, actor, bill.companyId, bill.organizationId);
      const description = describeBooksAttachments(bill, bill.attachments);
      if (!description.hasAttachment) continue;
      if (!description.attachmentsDownloaded) throw new Error("Attachment coverage changed before final verification.");
      for (const document of description.documents) {
        const attachment = bill.attachments.find((entry) => entry.id === document.attachmentId);
        if (!attachment) throw new Error("An original attachment is missing during final verification.");
        await readPrivateDocument(attachment);
        verified++;
      }
    }
    if (verified !== state.expected) throw new Error("The source document count changed before final verification.");
  }
  console.log(JSON.stringify(report(state)));
  if (state.status !== "COMPLETE") process.exitCode = 2;
} catch (error) {
  if (state && stateFile) { state.status = stopped ? "INTERRUPTED" : "PARTIAL"; state.updatedAt = new Date().toISOString(); await writeAttachmentDownloadState(stateFile, state).catch(() => undefined); }
  console.error(JSON.stringify({ status: "PARTIAL", code: error instanceof IntegrationError ? error.code : error instanceof HttpError ? `HTTP_${error.status}` : "ATTACHMENT_DOWNLOAD_STOPPED", providerFinancialWrites: 0,
    message: "Original attachment download stopped. Check the private progress file, operator credentials, source configuration and state-file ownership. No provider body or credentials were printed." }));
  process.exitCode = 1;
} finally {
  if (release) await release().catch(() => { process.exitCode = 1; });
  await db.$disconnect();
}
