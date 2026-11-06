import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
import type { InvoiceAutofillExtraction } from "@/lib/bill-autofill";
import { HttpError } from "@/lib/http";
import { manualBillAutofillCapability, previewManualBillAutofill, readManualBillAutofillUpload } from "@/lib/services/manual-bill-autofill";
import { GET, POST } from "@/app/api/bills/autofill/route";

const store = vi.hoisted(() => ({ user: { findFirst: vi.fn() }, job: { findFirst: vi.fn() }, vendor: { findMany: vi.fn() }, bill: { findFirst: vi.fn() },
  auditLog: { create: vi.fn() }, document: { create: vi.fn() }, payment: { create: vi.fn() }, ocrBatch: { create: vi.fn() }, integrationJob: { create: vi.fn() }, $transaction: vi.fn() }));
const model = vi.hoisted(() => ({ extractInvoice: vi.fn(), invoiceAutofillStatus: vi.fn() }));
const reserve = vi.hoisted(() => vi.fn());
const requireUser = vi.hoisted(() => vi.fn());
const vendorLookup = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ db: store }));
vi.mock("@/lib/services/openai-invoice", () => model);
vi.mock("@/lib/auth", () => ({ requireUser }));
vi.mock("@/lib/services/bill-vendor-lookup", () => ({ searchBillVendors: vendorLookup }));
vi.mock("@/lib/security/authentication-attempts", () => ({ reserveAuthenticationAttempt: reserve,
  authenticationAttemptKey: (purpose: string, identity: string) => `${purpose}:${identity}` }));

const actor = { id: "fictional-accounts", role: "ACCOUNTS" } as Actor;
const job = { id: "fictional-job", companyId: "fictional-company", jobNumber: "JOB-5383", currency: "AED" };
const vendor = { id: "fictional-vendor", name: "Fictional Supplier LLC", trn: "100000000000003", currency: "AED" };
const available = { enabled: true, configured: true, message: "Review the invoice before saving." };
const remoteVendor = (extra: Record<string, unknown> = {}) => ({ id: null, companyId: job.companyId,
  name: vendor.name, trn: vendor.trn, currency: "AED", externalVendorId: "2001", organizationId: "1001", dataCenter: "US", environment: "production", selectable: true, ...extra });
const vendorPage = (vendors = [remoteVendor()], extra: Record<string, unknown> = {}) => ({ companyId: job.companyId,
  organizationId: "1001", dataCenter: "US", environment: "production", vendors, hasMore: false, warning: null, ...extra });
function extraction(): InvoiceAutofillExtraction {
  return { fields: { invoiceNumber: "DEMO-001", invoiceDate: "2026-11-04", dueDate: "2026-12-04", discount: "0.00", vatRate: "5.00",
    lines: [{ description: "Fictional invoice item", quantity: "2", unitPrice: "10.00" }] },
  evidence: { vendorName: vendor.name, vendorTrn: vendor.trn, currency: "AED", jobNumber: "5383", subtotal: "20.00", discount: "0.00", vatAmount: "1.00", vatRate: "5.00", total: "21.00" },
  warnings: [], requiresHumanReview: false };
}
async function pdf(pages = 1, name = "fictional.pdf") {
  const document = await PDFDocument.create();
  for (let page = 0; page < pages; page++) document.addPage([200, 300]);
  return new File([Buffer.from(await document.save())], name, { type: "application/pdf" });
}
const png = () => new File([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJyoAAAAASUVORK5CYII=", "base64")], "fictional.png", { type: "image/png" });
async function input(files?: File[], requestId = "fixture-request") {
  return { companyId: job.companyId, jobId: job.id, requestId, files: files ?? [await pdf()] };
}
function multipart(files: (File | string)[], extra?: (form: FormData) => void) {
  const form = new FormData(); form.set("companyId", job.companyId); form.set("jobId", job.id); form.set("requestId", "fixture-request");
  for (const file of files) form.append("files", file);
  extra?.(form);
  return new Request("http://127.0.0.1:3000/api/bills/autofill", { method: "POST", headers: { origin: "http://127.0.0.1:3000" }, body: form });
}
beforeEach(() => {
  vi.clearAllMocks();
  store.user.findFirst.mockResolvedValue({ id: actor.id }); store.job.findFirst.mockResolvedValue({ ...job });
  store.vendor.findMany.mockResolvedValue([{ ...vendor }]); store.bill.findFirst.mockResolvedValue(null);
  model.invoiceAutofillStatus.mockReturnValue({ ...available }); model.extractInvoice.mockResolvedValue(extraction()); reserve.mockResolvedValue(1); requireUser.mockResolvedValue(actor);
  vendorLookup.mockReset().mockResolvedValue({ companyId: job.companyId, organizationId: null, dataCenter: null, environment: null, vendors: [], hasMore: false, warning: null });
  vi.stubEnv("APP_URL", "http://127.0.0.1:3000");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Real provider requests are forbidden in preview service tests."); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("transient manual invoice preview", () => {
  it.each(["ADMIN", "ACCOUNTS", "DATA_ENTRY"] as const)("supports current %s bill entry without creating financial or document records", async role => {
    const selected = { ...actor, role }, request = await input();
    const result = await previewManualBillAutofill(selected, request);
    expect(result).toMatchObject({ requestId: request.requestId, source: { companyId: job.companyId, jobId: job.id, currency: "AED" },
      preview: { fields: { invoiceNumber: "DEMO-001", vendorId: vendor.id, currency: "AED" }, vendor: { id: vendor.id, match: "TRN" }, requiresHumanReview: false } });
    expect(result.source.files).toEqual([{ index: 0, sha256: createHash("sha256").update(Buffer.from(await request.files[0].arrayBuffer())).digest("hex"),
      byteSize: request.files[0].size, mimeType: "application/pdf" }]);
    expect(result.source.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.preview.warnings).not.toContain(expect.stringMatching(/different job/));
    expect(reserve).toHaveBeenCalledWith(`manual-bill-autofill:${actor.id}`, expect.any(String), 30);
    expect(model.extractInvoice).toHaveBeenCalledWith([{ bytes: expect.any(Buffer), mimeType: "application/pdf" }]);
    for (const modelName of ["auditLog", "document", "payment", "ocrBatch", "integrationJob"] as const) expect(store[modelName].create).not.toHaveBeenCalled();
    expect(store.$transaction).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it("returns capability without sending documents or charging an analysis", async () => {
    expect(await manualBillAutofillCapability(actor, { companyId: job.companyId, jobId: job.id })).toEqual(available);
    expect(model.extractInvoice).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
    expect(store.user.findFirst).toHaveBeenCalledTimes(2);
  });
  it("returns readable and incomplete item cells together without a mandatory review step", async () => {
    const evidence = extraction();
    evidence.fields.lines = [
      { description: "Clear first item", quantity: "2", unitPrice: "10.00" },
      { description: "Readable second item", quantity: "", unitPrice: "" },
      { description: "", quantity: "3", unitPrice: "4.00" },
    ];
    evidence.warnings = ["The printed total differs from the item total."];
    model.extractInvoice.mockResolvedValue(evidence);
    const result = await previewManualBillAutofill(actor, await input());
    expect(result.preview.fields.lines).toEqual(evidence.fields.lines);
    expect(result.preview.requiresHumanReview).toBe(false);
    expect(result.preview.warnings).toContain(evidence.warnings[0]);
    expect(store.document.create).not.toHaveBeenCalled();
    expect(store.$transaction).not.toHaveBeenCalled();
  });
  it.each(["MANAGEMENT", "USER"])("refuses a non-entry role %s before provider/counter use", async role => {
    await expect(previewManualBillAutofill({ ...actor, role } as Actor, await input())).rejects.toMatchObject({ status: 403 });
    expect(model.extractInvoice).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
  });
  it("requires exact current role and active scoped membership", async () => {
    store.user.findFirst.mockResolvedValue(null);
    await expect(previewManualBillAutofill(actor, await input())).rejects.toMatchObject({ status: 403 });
    expect(store.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: actor.id, role: "ACCOUNTS", active: true,
      memberships: { some: { companyId: job.companyId, active: true, company: { active: true } } } }) }));
    expect(model.extractInvoice).not.toHaveBeenCalled();
  });
  it("rejects a job outside the exact company before reading documents", async () => {
    store.job.findFirst.mockResolvedValue(null);
    await expect(previewManualBillAutofill(actor, await input())).rejects.toMatchObject({ status: 404 });
    expect(store.job.findFirst).toHaveBeenCalledWith({ where: { id: job.id, companyId: job.companyId }, select: expect.anything() });
    expect(model.extractInvoice).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
  });
  it("keeps missing configuration as manual fallback without a provider call or budget charge", async () => {
    model.invoiceAutofillStatus.mockReturnValue({ enabled: true, configured: false, message: "Invoice reading is unavailable." });
    await expect(previewManualBillAutofill(actor, await input())).rejects.toMatchObject({ status: 503, message: "Invoice reading is unavailable." });
    expect(model.extractInvoice).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
  });
  it("never falls back to a name match when the printed supplier TRN differs", async () => {
    const evidence = extraction(); evidence.evidence.vendorTrn = "999999999999999"; model.extractInvoice.mockResolvedValue(evidence);
    const result = await previewManualBillAutofill(actor, await input());
    expect(result.preview.vendor).toBeNull(); expect(result.preview.fields.vendorId).toBeUndefined(); expect(result.preview.vendorCandidates).toEqual([]);
  });
  it("does not turn an unusable supplied tax identity into a name-only supplier match", async () => {
    const evidence = extraction(); evidence.evidence.vendorTrn = "---"; model.extractInvoice.mockResolvedValue(evidence);
    const result = await previewManualBillAutofill(actor, await input());
    expect(result.preview.vendor).toBeNull(); expect(result.preview.fields.vendorId).toBeUndefined();
  });
  it("uses exact normalized names only when no TRN was printed", async () => {
    const evidence = extraction(); evidence.evidence.vendorTrn = null; evidence.evidence.vendorName = "FICTIONAL SUPPLIER, L.L.C."; model.extractInvoice.mockResolvedValue(evidence);
    expect((await previewManualBillAutofill(actor, await input())).preview.vendor).toMatchObject({ id: vendor.id, match: "NAME" });
  });
  it("leaves ambiguous supplier identities for explicit user selection", async () => {
    store.vendor.findMany.mockResolvedValue([{ ...vendor }, { ...vendor, id: "fictional-other-vendor" }]);
    const result = await previewManualBillAutofill(actor, await input());
    expect(result.preview.vendor).toBeNull(); expect(result.preview.vendorCandidates).toHaveLength(2); expect(result.preview.fields.vendorId).toBeUndefined();
    expect(result.preview.warnings).toContainEqual(expect.stringMatching(/Several suppliers/));
    expect(vendorLookup).not.toHaveBeenCalled();
  });
  it("requires the printed name as well as a shared local TRN", async () => {
    store.vendor.findMany.mockResolvedValue([{ ...vendor, id: "wrong-shared-trn", name: "Different Group Supplier LLC" }]);
    const result = await previewManualBillAutofill(actor, await input());
    expect(result.preview.vendor).toBeNull(); expect(result.preview.fields.vendorId).toBeUndefined();
    store.vendor.findMany.mockResolvedValue([{ ...vendor }, { ...vendor, id: "wrong-shared-trn", name: "Different Group Supplier LLC" }]);
    expect((await previewManualBillAutofill(actor, await input())).preview.vendor?.id).toBe(vendor.id);
  });
  it("returns one unique Books-only candidate without creating a local vendor or inventing its ID", async () => {
    store.vendor.findMany.mockResolvedValue([]);
    vendorLookup.mockResolvedValue(vendorPage());
    const result = await previewManualBillAutofill(actor, await input());
    expect(result.preview.vendor).toBeNull(); expect(result.preview.fields.vendorId).toBeUndefined();
    expect(result.preview.vendorSelection).toEqual({ companyId: job.companyId, id: null, name: vendor.name, trn: vendor.trn,
      currency: "AED", externalVendorId: "2001", organizationId: "1001", dataCenter: "US", environment: "production" });
    expect(vendorLookup.mock.calls.map(([, request]) => request)).toEqual([
      { companyId: job.companyId, q: vendor.name, page: 1 }, { companyId: job.companyId, q: "Fictional", page: 1 },
    ]);
    expect(store.$transaction).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it("finds punctuation variants via one distinctive token but checks the full printed identity", async () => {
    store.vendor.findMany.mockResolvedValue([]);
    vendorLookup.mockImplementation(async (_actor, request) => vendorPage(request.q === "Fictional" ? [remoteVendor({ name: "FICTIONAL SUPPLIER, L.L.C." })] : []));
    expect((await previewManualBillAutofill(actor, await input())).preview.vendorSelection?.externalVendorId).toBe("2001");
    expect(vendorLookup).toHaveBeenCalledTimes(2);
  });
  it("refuses normalized duplicate contacts revealed only by the broader token search", async () => {
    store.vendor.findMany.mockResolvedValue([]);
    vendorLookup.mockImplementation(async (_actor, request) => vendorPage(request.q === "Fictional"
      ? [remoteVendor(), remoteVendor({ externalVendorId: "2002", name: "FICTIONAL SUPPLIER, L.L.C." })] : [remoteVendor()]));
    const result = await previewManualBillAutofill(actor, await input());
    expect(result.preview.vendorSelection).toBeNull(); expect(result.preview.fields.vendorId).toBeUndefined();
  });
  it("completes bounded search pages before choosing and deduplicates the same contact across queries", async () => {
    store.vendor.findMany.mockResolvedValue([]);
    vendorLookup.mockImplementation(async (_actor, request) => vendorPage(request.page === 1 ? [] : [remoteVendor()], { hasMore: request.page === 1 }));
    expect((await previewManualBillAutofill(actor, await input())).preview.vendorSelection?.externalVendorId).toBe("2001");
    expect(vendorLookup).toHaveBeenCalledTimes(4);
  });
  it.each([
    { hasMore: true }, { warning: "Incomplete provider catalog" }, { organizationId: null },
  ])("refuses incomplete or unavailable provider evidence: %j", async extra => {
    store.vendor.findMany.mockResolvedValue([]);
    vendorLookup.mockResolvedValue(vendorPage([remoteVendor()], extra));
    const result = await previewManualBillAutofill(actor, await input());
    expect(result.preview.vendorSelection).toBeNull(); expect(result.preview.fields.vendorId).toBeUndefined();
    expect(vendorLookup.mock.calls.length).toBeLessThanOrEqual(2);
  });
  it.each([
    { selectable: false }, { currency: "USD" }, { trn: "999999999999999" }, { name: "Another supplier with the shared TRN" },
    { companyId: "foreign-company" }, { organizationId: "1002" }, { dataCenter: "EU" }, { environment: "sandbox" }, { externalVendorId: "invalid" },
  ])("does not automatically select a conflicting provider candidate: %j", async extra => {
    store.vendor.findMany.mockResolvedValue([]); vendorLookup.mockResolvedValue(vendorPage([remoteVendor(extra)]));
    expect((await previewManualBillAutofill(actor, await input())).preview.vendorSelection).toBeNull();
  });
  it("does not let a destination change between the two searches prove a match", async () => {
    store.vendor.findMany.mockResolvedValue([]);
    vendorLookup.mockResolvedValueOnce(vendorPage()).mockResolvedValueOnce(vendorPage([remoteVendor({ organizationId: "1002" })], { organizationId: "1002" }));
    expect((await previewManualBillAutofill(actor, await input())).preview.vendorSelection).toBeNull();
  });
  it("discards remote matches when access is revoked during discovery", async () => {
    store.vendor.findMany.mockResolvedValue([]);
    vendorLookup.mockImplementation(async () => { store.user.findFirst.mockResolvedValue(null); return vendorPage(); });
    await expect(previewManualBillAutofill(actor, await input())).rejects.toMatchObject({ status: 403 });
    vendorLookup.mockRejectedValue(new HttpError(403, "Access changed.")); store.user.findFirst.mockResolvedValue({ id: actor.id });
    await expect(previewManualBillAutofill(actor, await input())).rejects.toMatchObject({ status: 403 });
  });
  it("bounds supplier lookup and preserves manual selection when the catalog is too large", async () => {
    store.vendor.findMany.mockResolvedValue(Array.from({ length: 5001 }, (_, index) => ({ ...vendor, id: `vendor-${index}` })));
    const result = await previewManualBillAutofill(actor, await input());
    expect(store.vendor.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { companyId: job.companyId, currency: "AED" }, take: 5001 }));
    expect(result.preview.vendor).toBeNull(); expect(result.preview.vendorCandidates).toEqual([]);
  });
  it("never exposes another creator's matching bill or changes the selected job", async () => {
    store.bill.findFirst.mockResolvedValue({ id: "own-matching-bill" });
    const evidence = extraction(); evidence.evidence.jobNumber = "JOB-9999"; model.extractInvoice.mockResolvedValue(evidence);
    const result = await previewManualBillAutofill(actor, await input());
    expect(store.bill.findFirst).toHaveBeenCalledWith({ where: expect.objectContaining({ companyId: job.companyId, createdById: actor.id, vendorId: vendor.id }), select: { id: true } });
    expect(result.source.jobId).toBe(job.id); expect(result.preview.fields).not.toHaveProperty("jobId");
    expect(result.preview.warnings).toContainEqual(expect.stringMatching(/different job reference/));
    expect(JSON.stringify(result)).not.toContain("own-matching-bill");
  });
  it("rejects currency conflict and leaves the pinned context unchanged", async () => {
    const evidence = extraction(); evidence.evidence.currency = "USD"; model.extractInvoice.mockResolvedValue(evidence);
    await expect(previewManualBillAutofill(actor, await input())).rejects.toMatchObject({ status: 422 });
    expect(store.vendor.findMany).not.toHaveBeenCalled();
  });
  it("never invents absent printed currency/VAT or copies IDs/actions from model fields", async () => {
    const evidence = extraction(); evidence.evidence.currency = null; evidence.evidence.vatRate = null; delete evidence.fields.vatRate;
    Object.assign(evidence.fields, { vendorId: "untrusted-vendor", companyId: "untrusted-company", jobId: "untrusted-job", category: "OTHER", paid: true, submit: true });
    Object.assign(evidence.fields.lines![0], { booksSelection: { accountId: "untrusted-account" }, taxId: "untrusted-tax" });
    model.extractInvoice.mockResolvedValue(evidence);
    const result = await previewManualBillAutofill(actor, await input());
    expect(result.preview.fields.vendorId).toBe(vendor.id); expect(result.preview.fields.currency).toBeUndefined(); expect(result.preview.fields.vatRate).toBeUndefined();
    for (const key of ["companyId", "jobId", "category", "paid", "submit"]) expect(result.preview.fields).not.toHaveProperty(key);
    expect(result.preview.fields.lines![0]).toEqual({ description: "Fictional invoice item", quantity: "2", unitPrice: "10.00" });
  });
  it("withholds all extracted details if access is revoked during inference", async () => {
    model.extractInvoice.mockImplementation(async () => { store.user.findFirst.mockResolvedValue(null); return extraction(); });
    await expect(previewManualBillAutofill(actor, await input())).rejects.toMatchObject({ status: 403 });
    expect(store.vendor.findMany).not.toHaveBeenCalled();
  });
  it("withholds details if the job or membership changes during the final lookup", async () => {
    store.vendor.findMany.mockImplementation(async () => { store.job.findFirst.mockResolvedValue({ ...job, currency: "USD" }); return [vendor]; });
    await expect(previewManualBillAutofill(actor, await input())).rejects.toMatchObject({ status: 409 });
  });
  it("does not call the provider after the durable actor budget is exhausted", async () => {
    reserve.mockRejectedValue(Object.assign(new Error("Budget exhausted"), { status: 429 }));
    await expect(previewManualBillAutofill(actor, await input())).rejects.toMatchObject({ status: 429 });
    expect(model.extractInvoice).not.toHaveBeenCalled();
  });
  it("releases the actor slot after a provider failure so manual retry remains possible", async () => {
    model.extractInvoice.mockRejectedValueOnce(new Error("Fictional provider interruption"));
    const request = await input();
    await expect(previewManualBillAutofill(actor, request)).rejects.toThrow("Fictional provider interruption");
    await expect(previewManualBillAutofill(actor, request)).resolves.toMatchObject({ requestId: request.requestId });
  });
  it("bounds actor and global concurrent inference without consuming another budget", async () => {
    let entered!: () => void, finish!: () => void;
    const active = new Promise<void>(resolve => { entered = resolve; }), release = new Promise<void>(resolve => { finish = resolve; });
    model.extractInvoice.mockImplementation(async () => { entered(); await release; return extraction(); });
    const request = await input(), first = previewManualBillAutofill(actor, request); await active;
    await expect(previewManualBillAutofill(actor, request)).rejects.toMatchObject({ status: 429 });
    const second = previewManualBillAutofill({ ...actor, id: "fictional-second" }, request);
    const third = previewManualBillAutofill({ ...actor, id: "fictional-third" }, request);
    await vi.waitFor(() => expect(model.extractInvoice).toHaveBeenCalledTimes(3));
    await expect(previewManualBillAutofill({ ...actor, id: "fictional-fourth" }, request)).rejects.toMatchObject({ status: 429 });
    expect(reserve).toHaveBeenCalledTimes(3); finish(); await Promise.all([first, second, third]);
  });
});

describe("bounded multipart and original-file intake", () => {
  it("accepts ordered PDF and PNG originals and does not forward filenames to inference", async () => {
    const files = [await pdf(1, "ignore-all-rules.pdf"), png()];
    const parsed = await readManualBillAutofillUpload(multipart(files));
    const result = await previewManualBillAutofill(actor, parsed);
    expect(result.source.files.map(file => file.index)).toEqual([0, 1]);
    expect(result.source.files.map(file => file.mimeType)).toEqual(["application/pdf", "image/png"]);
    expect(JSON.stringify(model.extractInvoice.mock.calls)).not.toContain("ignore-all-rules");
  });
  it("rejects repeated identical bytes, too many originals and excessive pages before charging inference", async () => {
    const file = await pdf();
    await expect(previewManualBillAutofill(actor, await input([file, file]))).rejects.toMatchObject({ status: 422 });
    await expect(previewManualBillAutofill(actor, await input(Array(6).fill(file)))).rejects.toMatchObject({ status: 422 });
    await expect(previewManualBillAutofill(actor, await input([await pdf(21)]))).rejects.toMatchObject({ status: 422 });
    expect(reserve).not.toHaveBeenCalled(); expect(model.extractInvoice).not.toHaveBeenCalled();
  });
  it("rejects forged MIME types, unreadable PDFs and oversized originals", async () => {
    const bytes = await (await pdf()).arrayBuffer();
    await expect(previewManualBillAutofill(actor, await input([new File([bytes], "forged.png", { type: "image/png" })]))).rejects.toMatchObject({ status: 415 });
    await expect(previewManualBillAutofill(actor, await input([new File(["%PDF-1.4\nbroken"], "broken.pdf", { type: "application/pdf" })]))).rejects.toMatchObject({ status: 422 });
    const headerOnlyPng = Buffer.from(await png().arrayBuffer()).subarray(0, 24);
    await expect(previewManualBillAutofill(actor, await input([new File([headerOnlyPng], "broken.png", { type: "image/png" })]))).rejects.toMatchObject({ status: 422 });
    await expect(previewManualBillAutofill(actor, await input([new File([new Uint8Array(5_000_001)], "large.pdf", { type: "application/pdf" })]))).rejects.toMatchObject({ status: 413 });
    expect(model.extractInvoice).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
  });
  it("rejects duplicate context fields, unknown actions and non-file values", async () => {
    const file = await pdf();
    await expect(readManualBillAutofillUpload(multipart([file], form => form.append("companyId", "other")))).rejects.toMatchObject({ status: 422 });
    await expect(readManualBillAutofillUpload(multipart([file], form => form.set("submit", "true")))).rejects.toMatchObject({ status: 422 });
    await expect(readManualBillAutofillUpload(multipart(["not-a-file"]))).rejects.toMatchObject({ status: 422 });
  });
  it("bounds declared and actual multipart bytes", async () => {
    await expect(readManualBillAutofillUpload(new Request("https://example.invalid", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x", "content-length": "6000000" }, body: "x" }))).rejects.toMatchObject({ status: 413 });
    await expect(readManualBillAutofillUpload(new Request("https://example.invalid", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x" }, body: new Uint8Array(5_200_000) }))).rejects.toMatchObject({ status: 413 });
  });
});

describe("manual autofill HTTP boundary", () => {
  it("enforces same origin before parsing an invoice and returns private no-store capability", async () => {
    const request = new Request("http://127.0.0.1:3000/api/bills/autofill", { method: "POST", headers: { origin: "https://other.example.invalid" }, body: "invalid" });
    expect((await POST(request)).status).toBe(403); expect(model.extractInvoice).not.toHaveBeenCalled();
    const response = await GET(new Request(`http://127.0.0.1:3000/api/bills/autofill?companyId=${job.companyId}&jobId=${job.id}`));
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(await response.json()).toEqual(available);
  });
  it("returns the reviewed transient envelope to a permitted same-origin request", async () => {
    const response = await POST(multipart([await pdf()]));
    expect(response.status).toBe(200); expect(requireUser).toHaveBeenCalledWith(["ADMIN", "ACCOUNTS", "DATA_ENTRY"]);
    expect(await response.json()).toMatchObject({ requestId: "fixture-request", source: { companyId: job.companyId, jobId: job.id }, preview: { requiresHumanReview: false } });
  });
});
