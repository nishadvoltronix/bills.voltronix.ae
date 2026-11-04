import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import type { InvoiceAutofillResponse } from "../../src/lib/manual-bill-autofill-types";
import type { Bill, BillBooksOptions, Job, Vendor } from "../../src/components/types";
import { calculateBill } from "../../src/lib/finance";

// Every extraction and business request is intercepted. Only existing LOCAL
// authentication is real; these tests never contact an AI/accounting provider.
const company = { id: "autofill-company", name: "Fictional Autofill Company" }, organizationId = "880001";
const job: Job = { id: "autofill-job", companyId: company.id, jobNumber: "JOB-5383", name: "Fictional Autofill Job", customer: "Fictional customer",
  currency: "AED", contractValue: null, approvedVariations: "0" };
const vendor: Vendor = { id: "autofill-vendor", companyId: company.id, name: "Fictional Exact Supplier", trn: "100000000000003", currency: "AED",
  booksVat: { status: "verified", taxTreatment: "vat_registered", hasTaxRegistrationNumber: true, checkedAt: "2026-11-04T12:00:00Z", warning: null } };
const options: BillBooksOptions = { companyId: company.id, organizationId, dataCenter: "US", environment: "production",
  accounts: [{ id: "88101", name: "Fictional Expense", type: "expense", selectable: true }],
  taxes: [{ id: "88111", name: "Fictional VAT", rate: "5.00", selectable: true }, { id: "NO_VAT", name: "No VAT", rate: "0.00", selectable: true }],
  customers: [], hasMoreCustomers: false, warning: null };
const original = (name: string) => ({ name, mimeType: "application/pdf", buffer: Buffer.from(`%PDF-1.4\n% Fictional autofill original ${name}\n%%EOF`) });
type Reply = { status?: number; json: unknown };
type Fixture = { enabled: boolean; reads: InvoiceAutofillResponse[]; creates: Record<string, unknown>[]; uploads: string[]; actions: string[];
  unexpected: string[]; bill: Bill | null; respond: (reply: InvoiceAutofillResponse, ordinal: number) => Promise<Reply> };

async function fixture(page: Page): Promise<Fixture> {
  const state: Fixture = { enabled: true, reads: [], creates: [], uploads: [], actions: [], unexpected: [], bill: null,
    respond: async reply => ({ json: reply }) };
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    if (path.startsWith("/api/auth/")) return route.continue();
    if (method === "GET" && path === "/api/companies") return route.fulfill({ json: { companies: [company, { id: "autofill-other-company", name: "Fictional other company" }] } });
    if (method === "GET" && path === "/api/jobs") return route.fulfill({ json: { jobs: [job] } });
    if (method === "GET" && path === `/api/jobs/${job.id}`) return route.fulfill({ json: { job, bills: [] } });
    if (method === "GET" && path === "/api/bills/options") return route.fulfill({ json: options });
    if (method === "GET" && path === "/api/integrations") return route.fulfill({ json: { zoho: { organizations: [{ companyId: company.id,
      organizationId, name: company.name, writeEnabled: true, connected: true, status: "CONNECTED", dataCenter: "US", environment: "production" }] } } });
    if (method === "GET" && path === "/api/vendors/search") return route.fulfill({ json: { companyId: company.id, organizationId,
      dataCenter: "US", environment: "production", vendors: [vendor], selectedVendor: url.searchParams.has("vendorId") ? vendor : null,
      hasMore: false, warning: null } });
    if (method === "GET" && path === "/api/bills/autofill") {
      expect(Object.fromEntries(url.searchParams)).toEqual({ companyId: company.id, jobId: job.id });
      return route.fulfill({ json: { enabled: state.enabled, configured: state.enabled, message: "Fictional capability; provider calls are mocked." } });
    }
    if (method === "POST" && path === "/api/bills/autofill") {
      const bytes = request.postDataBuffer();
      if (!bytes) throw new Error("The synthetic multipart body is required.");
      const form = await new Response(Uint8Array.from(bytes).buffer, { headers: { "Content-Type": request.headers()["content-type"] } }).formData();
      expect(form.get("companyId")).toBe(company.id); expect(form.get("jobId")).toBe(job.id);
      const files = await Promise.all(form.getAll("files").map(async (value, index) => {
        if (typeof value === "string") throw new Error("The synthetic originals must be multipart Files.");
        return { index, sha256: createHash("sha256").update(Buffer.from(await value.arrayBuffer())).digest("hex"), byteSize: value.size,
          mimeType: value.type as "application/pdf" | "image/png" | "image/jpeg" };
      }));
      const reply: InvoiceAutofillResponse = { requestId: String(form.get("requestId")), source: { companyId: company.id, jobId: job.id,
        currency: "AED", fingerprint: "a".repeat(64), files }, preview: {
        fields: { invoiceNumber: `AUTO-${state.reads.length + 1}`, invoiceDate: "2026-10-31", dueDate: "2026-11-30", orderNumber: "AUTO-ORDER",
          description: "Fictional extracted description", discount: "0.00", vatRate: "5.00", vendorId: vendor.id, currency: "AED",
          lines: [{ description: "Fictional extracted first line", quantity: "1", unitPrice: "10.00" }, { description: "Fictional extracted second line", quantity: "1", unitPrice: "20.00" }] },
        vendor: { id: vendor.id, name: vendor.name, trn: vendor.trn!, currency: "AED", match: "TRN" }, vendorCandidates: [],
        evidence: { vendorName: vendor.name, vendorTrn: vendor.trn!, currency: "AED", jobNumber: "5383", subtotal: "30.00", discount: "0.00",
          vatAmount: "1.50", vatRate: "5.00", total: "31.50" }, warnings: [], requiresHumanReview: true } };
      state.reads.push(reply);
      return route.fulfill(await state.respond(reply, state.reads.length)).catch(() => undefined);
    }
    if (method === "POST" && path === "/api/bills") {
      const input = request.postDataJSON(); state.creates.push(input);
      const totals = calculateBill(input.lines, input.discount, input.vatRate);
      state.bill = { ...input, ...totals, id: "autofill-saved", version: 1, status: "DRAFT", createdAt: "2026-11-04T12:00:00Z", paidAmount: "0.00",
        paymentStatus: "UNPAID", vendor, job, documents: [], payments: [], syncRecords: [] };
      return route.fulfill({ json: { bill: state.bill } });
    }
    if (state.bill && path === `/api/bills/${state.bill.id}` && method === "GET") return route.fulfill({ json: { bill: state.bill } });
    if (state.bill && path === `/api/bills/${state.bill.id}/attachment` && method === "POST") {
      state.uploads.push(path); expect(request.headers()["x-bill-version"]).toBe(String(state.bill.version));
      state.bill.version++;
      const document = { id: `autofill-original-${state.uploads.length}`, fileName: "FICTIONAL-original.pdf" };
      state.bill.documents!.push(document);
      return route.fulfill({ json: { document: { ...document, alreadyAttached: false, billVersion: state.bill.version } } });
    }
    if (state.bill && path === `/api/bills/${state.bill.id}/actions` && method === "POST") {
      expect(request.postDataJSON()).toEqual({ action: "submit", version: state.bill.version });
      state.actions.push(path); state.bill.version++; state.bill.status = "READY";
      state.bill.syncRecords = [{ id: "autofill-sync", target: "ZOHO", status: "PENDING", externalId: null }];
      return route.fulfill({ json: { bill: state.bill } });
    }
    state.unexpected.push(`${method} ${path}`);
    return route.fulfill({ status: 422, json: { error: "Unexpected mocked request; no business state changed." } });
  });
  return state;
}
async function open(page: Page) { await page.goto(`/bills/new?jobId=${job.id}`); await expect(page.getByRole("heading", { name: "Attach the invoice first", exact: true })).toBeVisible(); }
const files = (page: Page) => page.getByLabel("Invoice attachment", { exact: true });
const preview = (page: Page) => page.locator('[aria-label="Invoice automatic reading"]');
async function ready(page: Page) { await expect(preview(page)).toContainText("Invoice details filled for review."); }
async function chooseLine(page: Page, line: number, kind: "account" | "tax", name: string) {
  await page.getByRole("combobox", { name: `Line ${line} ${kind}`, exact: true }).fill(name);
  await page.getByRole("option", { name: new RegExp(`^${name}`) }).click();
}
test.beforeEach(async ({ page, baseURL }) => {
  const email = process.env.SEED_ADMIN_EMAIL, password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password || !baseURL) throw new Error("Existing local seed authentication is required.");
  expect((await page.request.post(`${baseURL}/api/auth/login`, { headers: { Origin: baseURL }, data: { email, password } })).status()).toBe(200);
});
test.afterEach(async ({ page, baseURL }) => { if (baseURL) await page.request.post(`${baseURL}/api/auth/logout`, { headers: { Origin: baseURL } }); });

test("attachment-first reads all pages once, requires review and explicit save, then uses payment and the same job", async ({ page }) => {
  const state = await fixture(page); await open(page);
  const attachment = await files(page).boundingBox(), supplier = await page.getByRole("combobox", { name: "Vendor Name", exact: true }).boundingBox();
  expect(attachment!.y).toBeLessThan(supplier!.y);
  await files(page).setInputFiles([original("FICTIONAL-page-one.pdf"), original("FICTIONAL-page-two.pdf")]);
  await ready(page);
  await expect(page.locator("#invoice-number")).toHaveValue("AUTO-1");
  await expect(page.locator("#invoice-date")).toHaveValue("2026-10-31");
  await expect(page.getByRole("combobox", { name: "Vendor Name", exact: true })).toHaveValue(vendor.name);
  await expect(page.getByLabel("Line 2 unit price", { exact: true })).toHaveValue("20.00");
  await expect(page.getByRole("combobox", { name: "Line 1 account", exact: true })).toHaveValue("");
  expect(state.reads).toHaveLength(1); expect(state.reads[0].source.files).toHaveLength(2);
  expect([state.creates.length, state.uploads.length, state.actions.length]).toEqual([0, 0, 0]);
  await page.getByRole("button", { name: "Save and sync", exact: true }).click();
  await expect(page.getByText("Compare the current originals with all bill values, then confirm your review before final save.", { exact: true })).toBeVisible();
  expect(state.creates).toHaveLength(0);
  for (const line of [1, 2]) { await chooseLine(page, line, "account", options.accounts[0].name); await chooseLine(page, line, "tax", options.taxes[0].name); }
  await page.locator("#autofill-reviewed").check();
  await page.getByRole("button", { name: "Save and sync", exact: true }).click();
  await expect(page).toHaveURL(/\/bills\/autofill-saved\/payment\?entry=1&saved=1$/);
  expect([state.creates.length, state.uploads.length, state.actions.length]).toEqual([1, 2, 1]);
  expect(state.bill).toMatchObject({ companyId: company.id, jobId: job.id, paidAmount: "0.00", payments: [] });
  await page.getByRole("link", { name: "Add another bill", exact: true }).click();
  await expect(page.locator("#bill-company")).toHaveValue(company.id); await expect(page.locator("#bill-company")).toBeDisabled();
  await expect(page.locator("#bill-job")).toHaveValue(job.id); await expect(page.locator("#bill-job")).toBeDisabled();
  await expect(page.locator("#invoice-number")).toHaveValue("");
  expect(state.unexpected).toEqual([]);
});

test("a late reading keeps human fields and line edits, while filling only untouched values", async ({ page }) => {
  const state = await fixture(page); let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; }); state.respond = async reply => { await hold; return { json: reply }; };
  try {
    await open(page); await page.locator("#invoice-number").fill("HUMAN-NUMBER");
    await files(page).setInputFiles(original("FICTIONAL-held.pdf"));
    await expect(preview(page)).toContainText("Reading invoice"); await expect.poll(() => state.reads.length).toBe(1);
    await page.getByLabel("Line 1 description", { exact: true }).fill("Human line"); await page.getByLabel("Line 1 unit price", { exact: true }).fill("7.00");
    await page.locator("#bill-description").fill("Human description"); release(); await ready(page);
    await expect(page.locator("#invoice-number")).toHaveValue("HUMAN-NUMBER");
    await expect(page.locator("#bill-description")).toHaveValue("Human description");
    await expect(page.getByLabel("Line 1 unit price", { exact: true })).toHaveValue("7.00");
    await expect(page.getByLabel("Line 2 unit price", { exact: true })).toHaveCount(0);
    await expect(page.locator("#invoice-date")).toHaveValue("2026-10-31");
    await expect(preview(page)).toContainText("Fields you edited were kept.");
    expect([state.creates.length, state.uploads.length, state.actions.length]).toEqual([0, 0, 0]); expect(state.unexpected).toEqual([]);
  } finally { release(); }
});

test("changing originals rejects an old response and resets review for the current pages", async ({ page }) => {
  const state = await fixture(page); let release!: () => void, finished = false;
  const hold = new Promise<void>(resolve => { release = resolve; });
  state.respond = async (reply, ordinal) => { if (ordinal === 1) { await hold; finished = true; } return { json: reply }; };
  try {
    await open(page); await files(page).setInputFiles(original("FICTIONAL-first.pdf"));
    await expect.poll(() => state.reads.length).toBe(1);
    await files(page).setInputFiles(original("FICTIONAL-added-page.pdf")); await ready(page);
    await expect(page.locator("#invoice-number")).toHaveValue("AUTO-2"); release(); await expect.poll(() => finished).toBe(true);
    await expect(page.locator("#invoice-number")).toHaveValue("AUTO-2");
    await page.locator("#autofill-reviewed").check();
    await page.getByRole("button", { name: "Remove FICTIONAL-added-page.pdf", exact: true }).click();
    await expect(page.locator("#autofill-reviewed")).not.toBeChecked();
    await expect.poll(() => state.reads.length).toBe(3); await ready(page);
    await expect(page.locator("#invoice-number")).toHaveValue("AUTO-3");
    await expect(page.locator("#autofill-reviewed")).not.toBeChecked();
    expect(state.reads.map(read => read.source.files.length)).toEqual([1, 2, 1]); expect(state.creates).toEqual([]); expect(state.unexpected).toEqual([]);
  } finally { release(); }
});

test("unknown printed VAT clears the untouched five-percent default and leaves the tax choice to the user", async ({ page }) => {
  const state = await fixture(page); state.respond = async reply => {
    delete reply.preview.fields.vatRate; reply.preview.evidence.vatRate = null; reply.preview.evidence.vatAmount = null;
    reply.preview.warnings = ["VAT rate was not clearly printed. Choose the correct tax from the original invoice."];
    return { json: reply };
  };
  await open(page); await files(page).setInputFiles(original("FICTIONAL-unknown-vat.pdf")); await ready(page);
  await expect(page.locator("#bill-vat")).toHaveValue("");
  await expect(preview(page)).toContainText("VAT rate was not clearly printed");
  await expect(page.getByRole("combobox", { name: "Line 1 tax", exact: true })).toHaveValue("");
  expect(state.creates).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("choosing company and job on a generic new form does not mark blank lines as human edits, including an empty browser MIME", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/bills/new");
  await page.getByRole("combobox", { name: "Company", exact: true }).selectOption(company.id);
  await page.locator("#bill-job").selectOption(job.id);
  // Playwright infers octet-stream for extensionless payloads. Create the actual
  // browser File with an empty MIME to exercise signature-based normalization.
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>("#invoice-file")!;
    const transfer = new DataTransfer();
    transfer.items.add(new File(["%PDF-1.4\n% Fictional extensionless original\n%%EOF"], "FICTIONAL-extensionless", { type: "" }));
    input.files = transfer.files; input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await ready(page);
  await expect(page.getByLabel("Line 2 unit price", { exact: true })).toHaveValue("20.00");
  expect(state.reads).toHaveLength(1); expect(state.reads[0].source.files[0].mimeType).toBe("application/pdf");
  expect(state.creates).toEqual([]); expect(state.unexpected).toEqual([]);
});

for (const changed of ["nonce", "job", "file"] as const) test(`a mismatched ${changed} preview cannot fill this bill`, async ({ page }) => {
  const state = await fixture(page); state.respond = async reply => {
    if (changed === "nonce") reply.requestId = "wrong-request";
    if (changed === "job") reply.source.jobId = "another-job";
    if (changed === "file") reply.source.files[0].sha256 = "0".repeat(64);
    return { json: reply };
  };
  await open(page); await files(page).setInputFiles(original("FICTIONAL-wrong-source.pdf"));
  await expect(preview(page)).toContainText("The reading did not match these originals and the selected job.");
  await expect(page.locator("#invoice-number")).toHaveValue("");
  await expect(page.locator("#bill-job")).toHaveValue(job.id); await expect(page.locator("#bill-company")).toHaveValue(company.id);
  await expect(page.getByRole("list", { name: "Selected invoice attachments", exact: true }).getByRole("group")).toHaveCount(1);
  expect(state.creates).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("unconfigured automatic reading retains ordinary manual entry without sending files for extraction", async ({ page }) => {
  const state = await fixture(page); state.enabled = false;
  await open(page); await files(page).setInputFiles(original("FICTIONAL-manual.pdf"));
  await expect(preview(page)).toContainText("Automatic reading is unavailable. Manual entry remains available.");
  await page.locator("#invoice-number").fill("MANUAL-ONLY");
  await page.getByRole("combobox", { name: "Vendor Name", exact: true }).fill(vendor.name);
  await page.getByRole("option", { name: new RegExp(`^${vendor.name}`) }).click();
  await page.getByLabel("Line 1 description", { exact: true }).fill("Manual line"); await page.getByLabel("Line 1 unit price", { exact: true }).fill("10.00");
  await page.getByRole("button", { name: "Save as draft", exact: true }).click();
  await expect(page.getByRole("group", { name: "Saved bill confirmation", exact: true })).toContainText("Draft saved");
  expect(state.reads).toEqual([]); expect([state.creates.length, state.uploads.length, state.actions.length]).toEqual([1, 1, 0]); expect(state.unexpected).toEqual([]);
});
