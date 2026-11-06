import "server-only";
import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { z } from "zod";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import { normalizeInvoiceNumber } from "@/lib/finance";
import { matchesAutofillVendorIdentity, usableAutofillVendorIdentity, type AutofillVendorIdentity } from "@/lib/bill-autofill-vendor";
import { matchesExactJobSearch, parseExactJobSearch } from "@/lib/job-search";
import { billScope, canCreateBill } from "@/lib/permissions";
import { MAX_INVOICE_ATTACHMENTS, MAX_INVOICE_FILE_BYTES, MAX_INVOICE_TOTAL_BYTES } from "@/lib/invoice-attachments";
import { authenticationAttemptKey, reserveAuthenticationAttempt } from "@/lib/security/authentication-attempts";
import type { InvoiceAutofillCapability, InvoiceAutofillResponse, InvoiceAutofillVendor, InvoiceAutofillVendorSelection } from "@/lib/manual-bill-autofill-types";
import { detectDocumentType } from "./documents";
import { extractInvoice, invoiceAutofillStatus } from "./openai-invoice";
import { searchBillVendors } from "./bill-vendor-lookup";

const identity = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const contextSchema = z.object({ companyId: identity, jobId: identity }).strict();
const requestSchema = contextSchema.extend({ requestId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) }).strict();
type Scope = z.infer<typeof contextSchema>;
type Input = z.infer<typeof requestSchema> & { files: readonly File[] };
type MimeType = "application/pdf" | "image/jpeg" | "image/png";
const maximumBodyBytes = MAX_INVOICE_TOTAL_BYTES + 128 * 1024;
const maximumPages = 20;
const maximumVendors = 5000;
const maximumInflight = 3;
let inflight = 0;
const inflightActors = new Set<string>();
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

async function discoverBooksVendor(actor: Actor, companyId: string, identity: AutofillVendorIdentity): Promise<InvoiceAutofillVendorSelection | null> {
  if (!usableAutofillVendorIdentity(identity) || !identity.vendorName) return null;
  const fullName = identity.vendorName.trim().slice(0, 100);
  const generic = new Set(["the", "and", "llc", "ltd", "limited", "company", "trading", "co", "inc", "llp", "fze", "fzco", "services", "materials", "building"]);
  const token = identity.vendorName.normalize("NFKC").match(/[\p{L}\p{N}]+/gu)?.filter(value => value.length >= 3 && !generic.has(value.toLowerCase()))
    .sort((left, right) => right.length - left.length)[0]?.slice(0, 100);
  const queries = [...new Set([fullName, ...(token && token !== fullName ? [token] : [])])];
  const matches = new Map<string, InvoiceAutofillVendorSelection>();
  let destination: string | null = null;
  for (const q of queries) {
    let completed = false;
    for (let page = 1; page <= 2; page++) {
      const result = await searchBillVendors(actor, { companyId, q, page });
      if (result.warning || !result.organizationId || !result.dataCenter || !result.environment || result.companyId !== companyId) return null;
      const currentDestination = JSON.stringify([result.organizationId, result.dataCenter, result.environment]);
      if (destination && destination !== currentDestination) return null;
      destination = currentDestination;
      for (const row of result.vendors) {
        if (row.companyId !== companyId || row.selectable === false || !row.externalVendorId || !/^\d{1,30}$/.test(row.externalVendorId) ||
          row.organizationId !== result.organizationId || row.dataCenter !== result.dataCenter || row.environment !== result.environment ||
          !matchesAutofillVendorIdentity(identity, row)) continue;
        matches.set(JSON.stringify([row.organizationId, row.dataCenter, row.environment, row.externalVendorId]), {
          companyId, id: row.id, name: row.name, trn: row.trn, currency: row.currency,
          externalVendorId: row.externalVendorId, organizationId: row.organizationId, dataCenter: row.dataCenter, environment: row.environment,
        });
      }
      if (matches.size > 1) return null;
      if (!result.hasMore) { completed = true; break; }
    }
    if (!completed) return null;
  }
  return matches.size === 1 ? [...matches.values()][0] : null;
}

async function authorizedJob(actor: Actor, input: Scope) {
  if (!canCreateBill(actor)) throw new HttpError(403, "Your role cannot prepare bill entries.");
  const current = await db.user.findFirst({ where: { id: actor.id, active: true, role: actor.role,
    memberships: { some: { companyId: input.companyId, active: true, company: { active: true } } } }, select: { id: true } });
  if (!current) throw new HttpError(403, "Current bill-entry access to this company is required.");
  const job = await db.job.findFirst({ where: { id: input.jobId, companyId: input.companyId },
    select: { id: true, companyId: true, jobNumber: true, currency: true } });
  if (!job) throw new HttpError(404, "Job not found in the selected company.");
  return job;
}

export async function manualBillAutofillCapability(actor: Actor, input: unknown): Promise<InvoiceAutofillCapability> {
  const scope = contextSchema.parse(input);
  await authorizedJob(actor, scope);
  const result = invoiceAutofillStatus();
  await authorizedJob(actor, scope);
  return result;
}

/** Bounded in-memory intake. This does not create a draft or store an original. */
export async function readManualBillAutofillUpload(request: Request): Promise<Input> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.startsWith("multipart/form-data;")) throw new HttpError(415, "Upload invoice files using multipart/form-data.");
  if (Number(request.headers.get("content-length") ?? 0) > maximumBodyBytes)
    throw new HttpError(413, "Invoice attachments must total 5 MB or less.");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "Choose the invoice attachments.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximumBodyBytes) {
        await reader.cancel();
        throw new HttpError(413, "Invoice attachments must total 5 MB or less.");
      }
      chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "The invoice upload was interrupted. Select the files again.");
  }
  let form: FormData;
  try { form = await new Response(Buffer.concat(chunks), { headers: { "content-type": contentType } }).formData(); }
  catch { throw new HttpError(400, "The invoice file upload is invalid."); }
  if ([...form.keys()].some(key => !["companyId", "jobId", "requestId", "files"].includes(key)))
    throw new HttpError(422, "The invoice preview request contains unsupported fields.");
  const fields: Record<string, string> = {};
  for (const key of ["companyId", "jobId", "requestId"]) {
    const values = form.getAll(key);
    if (values.length !== 1 || typeof values[0] !== "string") throw new HttpError(422, "Select one company and job before reading the invoice.");
    fields[key] = values[0];
  }
  const files = form.getAll("files");
  if (!files.length || files.length > MAX_INVOICE_ATTACHMENTS || files.some(file => !(file instanceof File)))
    throw new HttpError(422, "Choose between one and five files for the same invoice.");
  return { ...requestSchema.parse(fields), files: files as File[] };
}

async function prepareFiles(files: readonly File[]) {
  if (!files.length || files.length > MAX_INVOICE_ATTACHMENTS || files.some(file => !(file instanceof File)))
    throw new HttpError(422, "Choose between one and five files for the same invoice.");
  if (files.some(file => file.size < 8 || file.size > MAX_INVOICE_FILE_BYTES) || files.reduce((sum, file) => sum + file.size, 0) > MAX_INVOICE_TOTAL_BYTES)
    throw new HttpError(413, "Invoice attachments must total 5 MB or less; each file must contain a readable invoice.");
  const prepared: { bytes: Buffer; mimeType: MimeType; sha256: string; byteSize: number; index: number }[] = [];
  let pages = 0, pixels = 0;
  for (const [index, file] of files.entries()) {
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.byteLength !== file.size) throw new HttpError(422, "An invoice file changed during upload. Select it again.");
    const detected = detectDocumentType(bytes);
    if (file.type && file.type !== detected.mimeType) throw new HttpError(415, "An invoice file's content does not match its declared file type.");
    const mimeType = detected.mimeType as MimeType;
    const sha256 = sha(bytes);
    if (prepared.some(other => other.sha256 === sha256)) throw new HttpError(422, "The same invoice attachment was selected more than once.");
    try {
      if (mimeType === "application/pdf") {
        const pdf = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true });
        const count = pdf.getPageCount();
        if (!count) throw new Error("Empty PDF");
        pages += count;
      } else {
        let width: number, height: number;
        if (mimeType === "image/png") {
          if (bytes.length < 24 || bytes.subarray(12, 16).toString("ascii") !== "IHDR") throw new Error("Invalid PNG");
          width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
        } else {
          const pdf = await PDFDocument.create();
          const image = await pdf.embedJpg(bytes);
          width = image.width; height = image.height;
        }
        pixels += width * height;
        if (!Number.isFinite(pixels) || !width || !height || width > 16000 || height > 16000 || pixels > 40_000_000)
          throw new HttpError(422, "Invoice images are too large to read. Select smaller images.");
        if (mimeType === "image/png") {
          const pdf = await PDFDocument.create();
          const image = await pdf.embedPng(bytes);
          if (image.width !== width || image.height !== height) throw new Error("Invalid PNG dimensions");
        }
        pages++;
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(422, "Select readable, unencrypted PDF, JPEG or PNG invoice files.");
    }
    if (pages > maximumPages) throw new HttpError(422, "Read at most 20 invoice pages at a time.");
    prepared.push({ bytes, mimeType, sha256, byteSize: bytes.byteLength, index });
  }
  return prepared;
}

/** Suggestions only: no bill, vendor, document, payment, OCR or provider financial write. */
export async function previewManualBillAutofill(actor: Actor, input: Input): Promise<InvoiceAutofillResponse> {
  const scope = requestSchema.parse({ companyId: input.companyId, jobId: input.jobId, requestId: input.requestId });
  const job = await authorizedJob(actor, scope);
  const availability = invoiceAutofillStatus();
  if (!availability.enabled || !availability.configured) throw new HttpError(503, availability.message);
  if (inflightActors.has(actor.id)) throw new HttpError(429, "An invoice is already being read for this user. Wait for it to finish.");
  if (inflight >= maximumInflight) throw new HttpError(429, "Invoice reading is busy. Try again shortly.");
  inflightActors.add(actor.id); inflight++;
  try {
    const files = await prepareFiles(input.files);
    await reserveAuthenticationAttempt(authenticationAttemptKey("manual-bill-autofill", actor.id), "Invoice reading reached its limit. Try again in 15 minutes or enter the fields manually.", 30);
    const extraction = await extractInvoice(files.map(({ bytes, mimeType }) => ({ bytes, mimeType })));
    const current = await authorizedJob(actor, scope);
    if (JSON.stringify(current) !== JSON.stringify(job)) throw new HttpError(409, "The selected job changed while the invoice was being read. Review the job and try again.");
    if (extraction.evidence.currency && extraction.evidence.currency !== job.currency)
      throw new HttpError(422, "The invoice currency differs from this job. Review the selected job and original invoice; no conversion was applied.");
    const warnings = [...extraction.warnings];
    const fields: InvoiceAutofillResponse["preview"]["fields"] = {};
    for (const key of ["invoiceNumber", "invoiceDate", "dueDate", "orderNumber", "description", "discount", "vatRate"] as const)
      if (extraction.fields[key] !== undefined) fields[key] = extraction.fields[key];
    if (extraction.fields.lines) fields.lines = extraction.fields.lines.map(({ description, quantity, unitPrice }) => ({ description, quantity, unitPrice }));
    if (extraction.evidence.currency === job.currency) fields.currency = job.currency;
    const rows = await db.vendor.findMany({ where: { companyId: scope.companyId, currency: job.currency },
      orderBy: { id: "asc" }, take: maximumVendors + 1, select: { id: true, name: true, trn: true, currency: true } });
    const suppliedTrn = extraction.evidence.vendorTrn;
    const identity = { vendorName: extraction.evidence.vendorName, vendorTrn: suppliedTrn, currency: job.currency };
    const matches = rows.length > maximumVendors ? [] : rows.filter(row => matchesAutofillVendorIdentity(identity, row));
    const vendorCandidates: InvoiceAutofillVendor[] = matches.slice(0, 10).map(row => ({ ...row, match: suppliedTrn ? "TRN" : "NAME" }));
    const vendor = matches.length === 1 ? vendorCandidates[0] : null;
    let vendorSelection: InvoiceAutofillVendorSelection | null = null;
    if (!vendor && matches.length === 0 && rows.length <= maximumVendors && usableAutofillVendorIdentity(identity)) {
      try { vendorSelection = await discoverBooksVendor(actor, scope.companyId, identity); }
      catch (error) { if (error instanceof HttpError && [401, 403, 409].includes(error.status)) throw error; }
    }
    if (vendor) fields.vendorId = vendor.id;
    else if (!vendorSelection) warnings.push(rows.length > maximumVendors ? "The supplier catalog is too large for automatic matching. Select the supplier manually." :
      matches.length > 1 ? "Several suppliers exactly match the printed identity. Select the correct supplier." : "No exact supplier match was found. Select and verify the supplier manually.");
    if (vendor && fields.invoiceNumber && await db.bill.findFirst({ where: { companyId: scope.companyId, ...billScope(actor), vendorId: vendor.id,
      normalizedInvoiceNumber: normalizeInvoiceNumber(fields.invoiceNumber) }, select: { id: true } }))
      warnings.push("A bill with this supplier and invoice number is already visible to you. Review it before saving another entry.");
    if (extraction.evidence.jobNumber) {
      const search = parseExactJobSearch(extraction.evidence.jobNumber);
      const same = search ? matchesExactJobSearch(search, job) : extraction.evidence.jobNumber.trim().toLowerCase() === job.jobNumber.toLowerCase();
      if (!same) warnings.push("The invoice shows a different job reference. Verify the selected job before saving; the job was not changed.");
    }
    // Never return extraction after access is revoked during catalog/duplicate reads.
    if (JSON.stringify(await authorizedJob(actor, scope)) !== JSON.stringify(job)) throw new HttpError(409, "The selected job changed. Refresh before using these suggestions.");
    const publicFiles = files.map(({ index, sha256, byteSize, mimeType }) => ({ index, sha256, byteSize, mimeType }));
    return { requestId: scope.requestId, source: { companyId: scope.companyId, jobId: scope.jobId, currency: job.currency,
      fingerprint: sha(JSON.stringify({ companyId: scope.companyId, jobId: scope.jobId, currency: job.currency, files: publicFiles })), files: publicFiles },
      preview: { fields, vendor, vendorSelection, vendorCandidates, evidence: extraction.evidence, warnings: [...new Set(warnings)], requiresHumanReview: false } };
  } finally { inflightActors.delete(actor.id); inflight--; }
}
