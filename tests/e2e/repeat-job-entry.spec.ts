import { expect, test, type Page } from "@playwright/test";
import type { Bill, BillBooksOptions, Job, Vendor } from "../../src/components/types";

// Authentication uses only the existing local fixture. Every business request,
// including creates, uploads and retries, is intercepted before any real write.
const company = { id: "repeat-fictional-company", name: "Fictional Repeat Company" };
const organizationId = "998800001";
const job: Job = { id: "repeat-fictional-job", companyId: company.id, jobNumber: "JOB-5383",
  name: "Fictional Repeat Installation", customer: "Fictional Repeat Customer", currency: "AED",
  contractValue: "1000.00", approvedVariations: "0.00" };
const vendor: Vendor = { id: "repeat-fictional-vendor", companyId: company.id,
  name: "Fictional Repeat Supplier", currency: "AED", email: "repeat@example.invalid" };
const options: BillBooksOptions = { companyId: company.id, organizationId, dataCenter: "US", environment: "production",
  accounts: [{ id: "88101", name: "Fictional Repeat Expense", type: "expense", selectable: true }],
  taxes: [{ id: "88111", name: "Fictional Repeat VAT", rate: "5.00", selectable: true }, { id: "NO_VAT", name: "No VAT", rate: "0.00", selectable: true }],
  customers: [{ id: "88121", name: "Fictional Repeat Books Customer", currency: "AED" }], warning: null, hasMoreCustomers: false };
const original = (name: string) => ({ name, mimeType: "application/pdf",
  buffer: Buffer.from(`%PDF-1.4\n% Fictional repeat-entry original ${name}\n%%EOF`) });
type Payload = { companyId: string; vendorId: string; jobId: string; invoiceNumber: string; invoiceDate: string;
  orderNumber: string; paymentTerms: string; dueDate: string; description: string; category: string; currency: string;
  discount: string; vatRate: string; notes: string; lines: NonNullable<Bill["lines"]>; submit: boolean; version?: number };
type Fixture = { creates: Payload[]; updates: Payload[]; attachments: string[]; uploads: { billId: string; fileName: string; version: number }[]; submits: string[]; searches: number;
  unexpected: string[]; bills: Map<string, Bill>; failCreate: boolean; failAttachment: boolean; failFinalize: boolean;
  holdAttachment: Promise<void> | null; finalizedSync: "PENDING" | "FAILED" | "SYNCED";
  attachmentFault: { name: string; kind: "reject" | "lost_after_store" } | null; vendorVat?: Vendor["booksVat"] };

function storedBill(id: string, input: Payload): Bill {
  return { ...input, id, paymentTerms: input.paymentTerms as Bill["paymentTerms"], version: input.version ?? 1,
    status: "DRAFT", paymentStatus: "UNPAID", subtotal: "100.00", vatAmount: "5.00", total: "105.00",
    paidAmount: "0.00", outstanding: "105.00", createdAt: "2026-11-04T08:00:00Z", vendor, job,
    documents: [], payments: [], syncRecords: [] };
}

async function fixture(page: Page): Promise<Fixture> {
  const state: Fixture = { creates: [], updates: [], attachments: [], uploads: [], submits: [], searches: 0,
    unexpected: [], bills: new Map(), failCreate: false, failAttachment: false, failFinalize: false, holdAttachment: null, finalizedSync: "PENDING", attachmentFault: null };
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    if (method === "GET" && path === "/api/companies") return route.fulfill({ json: { companies: [company,
      { id: "repeat-other-company", name: "Fictional Other Company" }] } });
    if (method === "GET" && path === "/api/jobs") return route.fulfill({ json: { jobs: [job] } });
    if (method === "GET" && path === `/api/jobs/${job.id}`) return route.fulfill({ json: { job, bills: [] } });
    if (method === "GET" && ["/api/dashboard/search", "/api/jobs/search"].includes(path)) {
      state.searches++;
      return route.fulfill({ json: { query: url.searchParams.get("q") ?? "", companyId: null, jobs: [], bills: [], hasMore: false, warning: null } });
    }
    if (method === "GET" && path === "/api/integrations") return route.fulfill({ json: { zoho: { organizations: [{
      companyId: company.id, organizationId, name: company.name, dataCenter: "US", environment: "production",
      status: "CONNECTED", connected: true, writeEnabled: true, missing: [], postingMissing: [],
    }] } } });
    if (method === "GET" && path === "/api/bills/options") {
      expect(url.searchParams.get("companyId")).toBe(company.id);
      return route.fulfill({ json: options });
    }
    if (method === "GET" && path === "/api/vendors/search") {
      expect(url.searchParams.get("companyId")).toBe(company.id);
      const hydration = url.searchParams.has("vendorId");
      return route.fulfill({ json: { companyId: company.id, organizationId, dataCenter: "US", environment: "production",
        vendors: hydration ? [] : [{ ...vendor, externalVendorId: "998811001", organizationId, dataCenter: "US", environment: "production" }],
        selectedVendor: hydration ? { ...vendor, booksVat: state.vendorVat } : null, hasMore: false, warning: null } });
    }
    if (method === "POST" && path === "/api/vendors/resolve") {
      expect(request.postDataJSON()).toMatchObject({ companyId: company.id, organizationId, externalVendorId: "998811001" });
      return route.fulfill({ json: { vendor: { ...vendor, booksVat: state.vendorVat } } });
    }
    if (method === "POST" && path === "/api/bills") {
      const input = request.postDataJSON() as Payload;
      expect(input).toMatchObject({ companyId: company.id, jobId: job.id, vendorId: vendor.id, submit: false });
      state.creates.push(input);
      if (state.failCreate) { state.failCreate = false; return route.fulfill({ status: 503, json: { error: "Fictional create interruption." } }); }
      const bill = storedBill(`repeat-created-${state.creates.length}`, input);
      state.bills.set(bill.id, bill);
      return route.fulfill({ status: 201, json: { bill } });
    }
    const match = /^\/api\/bills\/([^/]+)(?:\/(attachment|actions))?$/.exec(path);
    if (match && state.bills.has(match[1])) {
      const bill = state.bills.get(match[1])!;
      if (method === "GET" && !match[2]) return route.fulfill({ json: { bill } });
      if (method === "PATCH" && !match[2]) {
        const input = request.postDataJSON() as Payload;
        state.updates.push(input);
        expect(input.version).toBe(bill.version);
        const finalized = ["READY", "APPROVED"].includes(bill.status);
        const updated = { ...storedBill(bill.id, input), version: bill.version + 1,
          ...(finalized ? { status: bill.status, paidAmount: bill.paidAmount, paymentStatus: bill.paymentStatus, payments: bill.payments,
            documents: bill.documents, editEligibility: bill.editEligibility,
            ...(bill.editEligibility?.mode === "provider_update" ? { syncOperation: "UPDATE_BILL" as const } : {}),
            syncRecords: [{ id: `${bill.id}-sync`, target: "ZOHO", status: state.finalizedSync, organizationId,
              externalId: bill.syncRecords?.find(record => record.target === "ZOHO")?.externalId ?? (state.finalizedSync === "SYNCED" ? "998899001" : null) }] } : {}) };
        state.bills.set(updated.id, updated);
        return route.fulfill({ json: { bill: updated } });
      }
      if (method === "POST" && match[2] === "attachment") {
        state.attachments.push(bill.id);
        const fileName = /filename="([^"]+)"/.exec(request.postDataBuffer()?.toString() ?? "")?.[1];
        expect(fileName).toBeTruthy();
        const version = Number(request.headers()["x-bill-version"]);
        state.uploads.push({ billId: bill.id, fileName: fileName!, version });
        const duplicate = bill.documents?.find(document => document.fileName === fileName);
        expect(version === bill.version || duplicate && version === bill.version - 1).toBeTruthy();
        expect(request.headers()["content-type"]).toContain("multipart/form-data;");
        expect(request.postDataBuffer()?.toString()).toContain("Fictional repeat-entry original");
        if (state.failAttachment) { state.failAttachment = false; return route.fulfill({ status: 503, json: { error: "Fictional upload interruption." } }); }
        if (state.attachmentFault && state.attachmentFault.name === fileName && state.attachmentFault.kind === "reject") {
          state.attachmentFault = null;
          return route.fulfill({ status: 422, json: { error: "Fictional document cannot be combined; remove or replace this pending original." } });
        }
        if (state.holdAttachment) await state.holdAttachment;
        const document = duplicate ?? { id: `${bill.id}-original${bill.documents?.length ? `-${bill.documents.length + 1}` : ""}`, fileName };
        if (!duplicate) { bill.version++; bill.documents = [...bill.documents ?? [], document]; }
        if (state.attachmentFault && state.attachmentFault.name === fileName && state.attachmentFault.kind === "lost_after_store") {
          state.attachmentFault = null;
          return route.abort("failed");
        }
        return route.fulfill({ json: { document: { ...document, billVersion: bill.version, alreadyAttached: !!duplicate } } });
      }
      if (method === "POST" && match[2] === "actions") {
        state.submits.push(bill.id);
        expect(request.postDataJSON()).toEqual({ action: "submit", version: bill.version });
        if (state.failFinalize) { state.failFinalize = false; return route.fulfill({ status: 503, json: { error: "Fictional finalization interruption." } }); }
        bill.status = "READY"; bill.version++;
        bill.syncRecords = [{ id: `${bill.id}-sync`, target: "ZOHO", status: state.finalizedSync, organizationId,
          externalId: state.finalizedSync === "SYNCED" ? "998899001" : null,
          lastError: state.finalizedSync === "FAILED" ? "Fictional supplier VAT registration needs review; keep the invoice VAT unchanged." : null }];
        return route.fulfill({ json: { bill } });
      }
    }
    state.unexpected.push(`${method} ${path}`);
    return route.fulfill({ status: 422, json: { error: "Unexpected fictional request; no business data was changed." } });
  });
  return state;
}

async function selectVendor(page: Page) {
  await page.getByRole("combobox", { name: "Vendor Name", exact: true }).fill(vendor.name);
  await page.getByRole("option", { name: new RegExp(`^${vendor.name}`) }).click();
  await expect(page.getByRole("region", { name: "Vendor details", exact: true })).toContainText(vendor.email!);
}
async function lineOption(page: Page, kind: "account" | "tax" | "customer", name: string) {
  await page.getByRole("combobox", { name: `Line 1 ${kind}`, exact: true }).fill(name);
  await page.getByRole("option", { name: new RegExp(`^${name}`) }).click();
}
async function fill(page: Page, invoice: string, rich = false) {
  await selectVendor(page);
  await page.getByLabel("Bill#").fill(invoice);
  await page.getByLabel("Bill Date").fill("2026-10-29");
  await page.getByLabel("Line 1 description").fill(`Fictional line ${invoice}`);
  await page.getByLabel("Line 1 unit price").fill("100.00");
  await page.getByLabel("Invoice attachment", { exact: true }).setInputFiles(original("FICTIONAL-repeat-original.pdf"));
  if (rich) {
    await page.getByLabel("Order Number").fill("FICTIONAL-PREVIOUS-ORDER");
    await page.getByLabel("Payment Terms", { exact: true }).selectOption("NET_30");
    await page.getByLabel("Description", { exact: true }).fill("Fictional previous invoice description");
    await page.locator("#bill-category").selectOption("LABOUR");
    await page.getByLabel("Notes", { exact: true }).fill("Fictional previous invoice note");
    await page.getByLabel("Line 1 quantity").fill("2");
    await lineOption(page, "account", options.accounts[0].name);
    await lineOption(page, "tax", options.taxes[0].name);
    await lineOption(page, "customer", options.customers[0].name);
  }
}
async function assertFresh(page: Page, today: string) {
  await expect(page.getByRole("heading", { name: "New Bill", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Company", exact: true })).toHaveValue(company.id);
  await expect(page.getByRole("combobox", { name: "Company", exact: true })).toBeDisabled();
  await expect(page.getByLabel(/^Job \/ project/)).toHaveValue(job.id);
  await expect(page.getByLabel(/^Job \/ project/)).toBeDisabled();
  await expect(page.getByLabel("Currency", { exact: true })).toHaveValue("AED");
  for (const control of [page.getByRole("combobox", { name: "Vendor Name", exact: true }), page.getByLabel("Bill#"),
    page.getByLabel("Order Number"), page.getByLabel("Due Date"), page.getByLabel("Description", { exact: true }),
    page.getByLabel("Notes", { exact: true }), page.getByLabel("Line 1 description"), page.getByLabel("Line 1 unit price"),
    page.getByRole("combobox", { name: "Line 1 account", exact: true }), page.getByRole("combobox", { name: "Line 1 tax", exact: true }),
    page.getByRole("combobox", { name: "Line 1 customer", exact: true }), page.getByLabel("Invoice attachment", { exact: true })])
    await expect(control).toHaveValue("");
  await expect(page.getByLabel("Line 1 quantity")).toHaveValue("1");
  await expect(page.getByLabel("Payment Terms", { exact: true })).toHaveValue("CUSTOM");
  await expect(page.locator("#bill-category")).toHaveValue("MATERIALS");
  await expect(page.getByLabel("Discount amount", { exact: true })).toHaveValue("0");
  await expect(page.locator("#bill-vat")).toHaveValue("5");
  await expect(page.getByLabel("Bill Date")).toHaveValue(today);
  expect(await page.getByLabel("Invoice attachment", { exact: true }).evaluate((element: HTMLInputElement) => element.files?.length)).toBe(0);
  await expect(page.getByRole("list", { name: "Selected invoice attachments", exact: true })).toHaveCount(0);
  await expect(page.getByText("Select several files together, or add more files before saving.", { exact: true })).toBeVisible();
}
async function paymentStep(page: Page, id = "repeat-created-1") {
  await expect(page).toHaveURL(new RegExp(`/bills/${id}/payment\\?entry=1&saved=1$`));
  await expect(page.getByRole("heading", { name: "Record payment", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Add another bill", exact: true })).toHaveAttribute("href", `/bills/new?jobId=${job.id}`);
  await expect(page.getByRole("link", { name: "Back to job history", exact: true })).toHaveAttribute("href", `/jobs/${job.id}`);
}
async function continueEntry(page: Page, id = "repeat-created-1") {
  await paymentStep(page, id);
  await page.getByRole("link", { name: "Add another bill", exact: true }).click();
}

test.beforeEach(async ({ page, baseURL }) => {
  const email = process.env.SEED_ADMIN_EMAIL, password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password || !baseURL) throw new Error("The existing local fictional authentication fixture is required.");
  expect((await page.request.post(`${baseURL}/api/auth/login`, { headers: { Origin: baseURL }, data: { email, password } })).status()).toBe(200);
});
test.afterEach(async ({ page, baseURL }) => {
  if (baseURL) await page.request.post(`${baseURL}/api/auth/logout`, { headers: { Origin: baseURL } });
});

test("two consecutive saves reset every invoice field while retaining the verified job and company", async ({ page }) => {
  const state = await fixture(page);
  let release!: () => void;
  state.holdAttachment = new Promise<void>(resolve => { release = resolve; });
  try {
    await page.goto(`/bills/new?jobId=${job.id}`);
    const today = await page.getByLabel("Bill Date").inputValue();
    await fill(page, "FICTIONAL-REPEAT-FIRST", true);
    await page.getByRole("button", { name: "Save and sync", exact: true }).click();
    await expect.poll(() => state.attachments.length).toBe(1);
    expect(state.creates).toHaveLength(1);
    expect(state.submits).toHaveLength(0);
    await expect(page.getByRole("button", { name: "Back to job search", exact: true })).toHaveCount(2);
    for (const button of await page.getByRole("button", { name: "Back to job search", exact: true }).all())
      await expect(button).toBeDisabled();
    await page.locator("form.books-bill-form").evaluate(form => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(state.creates).toHaveLength(1);
    await expect(page.getByLabel("Bill#")).toHaveValue("FICTIONAL-REPEAT-FIRST");
    await expect(page.getByRole("link", { name: "View saved bill", exact: true })).toHaveCount(0);
    release(); state.holdAttachment = null;
    await paymentStep(page);
    await expect(page.getByRole("group", { name: "Saved bill confirmation", exact: true })).toContainText("FICTIONAL-REPEAT-FIRST");
    await expect(page.getByRole("link", { name: "View saved bill", exact: true })).toHaveAttribute("href", "/bills/repeat-created-1?saved=1");
    await expect(page.getByRole("link", { name: "View job history", exact: true })).toHaveAttribute("href", `/jobs/${job.id}`);
    await continueEntry(page);
    await assertFresh(page, today);
    await fill(page, "FICTIONAL-REPEAT-SECOND");
    // Fixed discounts and selected Books line taxes are deliberately exclusive.
    // The second invoice uses the manual VAT path to verify discount reset too.
    await page.getByLabel("Discount amount", { exact: true }).fill("7.50");
    await page.getByRole("button", { name: "Save as draft", exact: true }).click();
    await assertFresh(page, today);
    await expect(page.getByRole("group", { name: "Saved bill confirmation", exact: true })).toContainText("FICTIONAL-REPEAT-SECOND");
    await expect(page.getByRole("group", { name: "Saved bill confirmation", exact: true })).toContainText("Draft saved. It has not been sent to Zoho Books.");
    await expect(page.getByRole("link", { name: "View saved bill", exact: true })).toHaveAttribute("href", "/bills/repeat-created-2?saved=1");
    await expect(page.getByRole("link", { name: "Edit saved bill", exact: true })).toHaveAttribute("href", "/bills/repeat-created-2/edit");
    expect(state.creates.map(value => [value.companyId, value.jobId, value.invoiceNumber])).toEqual([
      [company.id, job.id, "FICTIONAL-REPEAT-FIRST"], [company.id, job.id, "FICTIONAL-REPEAT-SECOND"],
    ]);
    expect(state.creates[1]).toMatchObject({ orderNumber: "", paymentTerms: "CUSTOM", dueDate: "", description: "",
      category: "MATERIALS", discount: "7.50", vatRate: "5", notes: "", lines: [{ quantity: "1", unitPrice: "100.00" }] });
    expect(state.creates[1].lines[0].booksSelection).toBeUndefined();
    expect(state.attachments).toEqual(["repeat-created-1", "repeat-created-2"]);
    expect(state.submits).toEqual(["repeat-created-1"]);
    expect(state.bills.get("repeat-created-1")?.status).toBe("READY");
    expect(state.bills.get("repeat-created-2")?.status).toBe("DRAFT");
    expect(state.searches).toBe(0);
    expect(state.unexpected).toEqual([]);
    await page.setViewportSize({ width: 360, height: 780 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally { release(); }
});

test("a failed create preserves invoice fields and the selected file until an explicit retry succeeds", async ({ page }) => {
  const state = await fixture(page); state.failCreate = true;
  await page.goto(`/bills/new?jobId=${job.id}`);
  const today = await page.getByLabel("Bill Date").inputValue();
  await fill(page, "FICTIONAL-REPEAT-CREATE-ERROR", true);
  await page.getByRole("button", { name: "Save and sync", exact: true }).click();
  await expect(page.getByText("Fictional create interruption.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Bill#")).toHaveValue("FICTIONAL-REPEAT-CREATE-ERROR");
  await expect(page.getByLabel("Order Number")).toHaveValue("FICTIONAL-PREVIOUS-ORDER");
  await expect(page.getByRole("combobox", { name: "Line 1 account", exact: true })).toHaveValue(options.accounts[0].name);
  await expect(page.getByRole("group", { name: "Attachment FICTIONAL-repeat-original.pdf", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save and sync", exact: true })).toBeEnabled();
  expect([state.creates.length, state.attachments.length, state.submits.length]).toEqual([1, 0, 0]);
  await page.getByRole("button", { name: "Save and sync", exact: true }).click();
  await continueEntry(page, "repeat-created-2");
  await assertFresh(page, today);
  expect(state.creates).toHaveLength(2);
  expect(state.creates[1]).toEqual(state.creates[0]);
  expect([state.attachments.length, state.submits.length]).toEqual([1, 1]);
  expect(state.unexpected).toEqual([]);
});

for (const failure of ["attachment", "finalize"] as const) {
  test(`${failure} recovery retries only the existing saved bill before starting the next blank invoice`, async ({ page }) => {
    const state = await fixture(page);
    if (failure === "attachment") state.failAttachment = true; else state.failFinalize = true;
    await page.goto(`/bills/new?jobId=${job.id}`);
    const today = await page.getByLabel("Bill Date").inputValue();
    await fill(page, `FICTIONAL-REPEAT-${failure.toUpperCase()}`);
    await page.getByRole("button", { name: "Save and sync", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Your financial data is safely saved", exact: true })).toBeVisible();
    expect(state.creates).toHaveLength(1);
    await expect(page.getByRole("button", { name: "Save and sync", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: failure === "attachment" ? "Retry attachment" : "Retry Save and sync", exact: true }).click();
    await paymentStep(page);
    await expect(page.getByRole("link", { name: "View saved bill", exact: true })).toHaveAttribute("href", "/bills/repeat-created-1?saved=1");
    await continueEntry(page);
    await assertFresh(page, today);
    expect(state.creates).toHaveLength(1);
    expect(state.attachments).toEqual(failure === "attachment" ? ["repeat-created-1", "repeat-created-1"] : ["repeat-created-1"]);
    expect(state.submits).toEqual(failure === "finalize" ? ["repeat-created-1", "repeat-created-1"] : ["repeat-created-1"]);
    expect(state.bills.get("repeat-created-1")?.status).toBe("READY");
    expect(state.unexpected).toEqual([]);
  });
}

test("Back to job search is usable on mobile without creating a bill", async ({ page }) => {
  const state = await fixture(page);
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto(`/bills/new?jobId=${job.id}`);
  const back = page.getByRole("button", { name: "Back to job search", exact: true }).first();
  await expect(back).toBeVisible();
  await expect(back).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const bounds = await back.boundingBox();
  expect(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 360).toBe(true);
  await back.click();
  await expect(page).toHaveURL(/\/bills\/manual$/);
  await expect(page.getByRole("heading", { name: "Manual bill entry", exact: true })).toBeVisible();
  expect([state.creates.length, state.attachments.length, state.submits.length]).toEqual([0, 0, 0]);
  expect(state.unexpected).toEqual([]);
});

test("generic new entry keeps its editable allocation and opens the saved bill", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/bills/new");
  await page.getByRole("combobox", { name: "Company", exact: true }).selectOption(company.id);
  await page.getByLabel(/^Job \/ project/).selectOption(job.id);
  await expect(page.getByLabel(/^Job \/ project/)).toBeEnabled();
  await fill(page, "FICTIONAL-GENERIC-CREATE");
  await page.getByRole("button", { name: "Save as draft", exact: true }).click();
  await expect(page).toHaveURL(/\/bills\/repeat-created-1\?saved=1$/);
  expect(state.creates).toHaveLength(1);
  expect(state.submits).toHaveLength(0);
  expect(state.unexpected).toEqual([]);
});

test("editing an existing bill retains update semantics and its detail redirect", async ({ page }) => {
  const state = await fixture(page);
  const input = { companyId: company.id, vendorId: vendor.id, jobId: job.id, invoiceNumber: "FICTIONAL-EDIT-ORIGINAL",
    invoiceDate: "2026-10-29", orderNumber: "", paymentTerms: "CUSTOM", dueDate: "", description: "", category: "MATERIALS",
    currency: "AED", discount: "0", vatRate: "5", notes: "", lines: [{ description: "Fictional edit line", quantity: "1", unitPrice: "100.00" }], submit: false };
  state.bills.set("repeat-edit-existing", { ...storedBill("repeat-edit-existing", input), version: 7 });
  await page.goto("/bills/repeat-edit-existing/edit");
  await expect(page.getByRole("heading", { name: "Edit Bill", exact: true })).toBeVisible();
  await expect(page.getByLabel(/^Job \/ project/)).toBeEnabled();
  await page.getByLabel("Bill#").fill("FICTIONAL-EDIT-UPDATED");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page).toHaveURL(/\/bills\/repeat-edit-existing\?saved=1$/);
  expect(state.updates).toMatchObject([{ invoiceNumber: "FICTIONAL-EDIT-UPDATED", version: 7, jobId: job.id }]);
  expect(state.creates).toHaveLength(0);
  expect(state.submits).toHaveLength(0);
  expect(state.unexpected).toEqual([]);
});

test("payment continuation never claims sync while its saved bill is unverified and then shows a real failure", async ({ page }) => {
  const state = await fixture(page); state.finalizedSync = "FAILED";
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let savedReadStarted = false;
  await page.route("**/api/bills/repeat-created-1", async route => {
    const saved = state.bills.get("repeat-created-1");
    if (route.request().method() !== "GET" || saved?.status !== "READY") return route.fallback();
    savedReadStarted = true;
    await held;
    await route.fulfill({ json: { bill: saved } }).catch(() => undefined);
  });
  try {
    await page.goto(`/bills/new?jobId=${job.id}`);
    await fill(page, "FICTIONAL-IMMEDIATE-FAILED");
    await page.getByRole("button", { name: "Save and sync", exact: true }).click();
    const outcome = page.getByRole("group", { name: "Saved bill confirmation", exact: true });
    await expect.poll(() => savedReadStarted).toBe(true);
    await expect(page.getByText("Bill saved and synchronized with Zoho Books.", { exact: true })).toHaveCount(0);
    release();
    await paymentStep(page);
    await expect(outcome.getByRole("alert")).toContainText("Fictional supplier VAT registration needs review; keep the invoice VAT unchanged.");
    await expect(outcome).toContainText("has not synchronized with Zoho Books");
    await expect(page.getByLabel("Payment reference", { exact: true })).toHaveValue("");
    expect([state.creates.length, state.attachments.length, state.submits.length]).toEqual([1, 1, 1]);
    expect(state.unexpected).toEqual([]);
  } finally { release(); }
});

for (const nextStatus of ["FAILED", "SYNCED"] as const) {
  test(`saved outcome refreshes PENDING to ${nextStatus} without changing the optional payment inputs`, async ({ page }) => {
    await page.clock.install();
    const state = await fixture(page);
    let savedReads = 0;
    await page.route("**/api/bills/repeat-created-1", route => {
      const saved = state.bills.get("repeat-created-1");
      if (route.request().method() !== "GET" || saved?.status !== "READY") return route.fallback();
      savedReads++;
      return route.fulfill({ json: { bill: saved } });
    });
    await page.goto(`/bills/new?jobId=${job.id}`);
    await fill(page, "FICTIONAL-PENDING-SAVED");
    await page.getByRole("button", { name: "Save and sync", exact: true }).click();
    const outcome = page.getByRole("group", { name: "Saved bill confirmation", exact: true });
    await expect(outcome).toContainText("Provider confirmation is pending");
    await expect.poll(() => savedReads).toBeGreaterThan(0);
    await paymentStep(page);
    await page.getByLabel("Payment amount (AED)", { exact: true }).fill("25.00");
    await page.getByLabel("Payment reference", { exact: true }).fill("FICTIONAL-PAYMENT-UNSAVED");
    await page.getByLabel("Payment reference", { exact: true }).focus();
    const field = await page.getByLabel("Payment reference", { exact: true }).elementHandle();
    const record = state.bills.get("repeat-created-1")!.syncRecords![0];
    record.status = nextStatus;
    record.externalId = nextStatus === "SYNCED" ? "998899002" : null;
    record.lastError = nextStatus === "FAILED" ? "Fictional supplier VAT registration needs review." : null;
    await page.clock.fastForward(5000);
    await expect(outcome).toContainText(nextStatus === "FAILED"
      ? "Fictional supplier VAT registration needs review."
      : "Bill saved and synchronized with Zoho Books.");
    await expect(page.getByLabel("Payment reference", { exact: true })).toHaveValue("FICTIONAL-PAYMENT-UNSAVED");
    await expect(page.getByLabel("Payment reference", { exact: true })).toBeFocused();
    await expect(page.getByLabel("Payment amount (AED)", { exact: true })).toHaveValue("25.00");
    expect(await field?.evaluate(element => element.isConnected)).toBe(true);
    const terminalReads = savedReads;
    await page.clock.fastForward(10000);
    expect(savedReads).toBe(terminalReads);
    expect([state.creates.length, state.attachments.length, state.submits.length]).toEqual([1, 1, 1]);
    expect(state.unexpected).toEqual([]);
  });
}

test("a stale saved-outcome response cannot replace a newer saved bill or its optional payment", async ({ page }) => {
  const state = await fixture(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let firstReadStarted = false, firstReadFinished = false, holdFirstRead = false;
  await page.route("**/api/bills/repeat-created-1", async route => {
    const saved = state.bills.get("repeat-created-1");
    if (route.request().method() !== "GET" || saved?.status !== "READY") return route.fallback();
    if (!holdFirstRead) return route.fulfill({ json: { bill: saved } });
    firstReadStarted = true;
    await held;
    await route.fulfill({ json: { bill: { ...saved, syncRecords: [{ target: "ZOHO", status: "FAILED",
      externalId: null, lastError: "Fictional stale first-bill failure." }] } } }).catch(() => undefined);
    firstReadFinished = true;
  });
  try {
    await page.goto(`/bills/new?jobId=${job.id}`);
    await fill(page, "FICTIONAL-FIRST-PENDING");
    await page.getByRole("button", { name: "Save and sync", exact: true }).click();
    await paymentStep(page);
    holdFirstRead = true;
    await page.getByRole("button", { name: "Refresh saved bill status", exact: true }).click();
    await expect.poll(() => firstReadStarted).toBe(true);
    await continueEntry(page);
    await fill(page, "FICTIONAL-SECOND-SYNCED");
    state.finalizedSync = "SYNCED";
    await page.getByRole("button", { name: "Save and sync", exact: true }).click();
    const outcome = page.getByRole("group", { name: "Saved bill confirmation", exact: true });
    await expect(outcome).toContainText("FICTIONAL-SECOND-SYNCED");
    await expect(outcome).toContainText("Bill saved and synchronized with Zoho Books.");
    await page.getByLabel("Payment reference", { exact: true }).fill("FICTIONAL-SECOND-PAYMENT");
    await page.getByLabel("Payment reference", { exact: true }).focus();
    release();
    await expect.poll(() => firstReadFinished).toBe(true);
    await expect(outcome).not.toContainText("Fictional stale first-bill failure.");
    await expect(outcome).toContainText("FICTIONAL-SECOND-SYNCED");
    await expect(page.getByLabel("Payment reference", { exact: true })).toHaveValue("FICTIONAL-SECOND-PAYMENT");
    await expect(page.getByLabel("Payment reference", { exact: true })).toBeFocused();
    await expect(page).toHaveURL(/\/bills\/repeat-created-2\/payment\?entry=1&saved=1$/);
    expect([state.creates.length, state.attachments.length, state.submits.length]).toEqual([2, 2, 2]);
    expect(state.unexpected).toEqual([]);
  } finally { release(); }
});

test("saved outcome labels retained status when refresh fails and only reads on explicit recovery", async ({ page }) => {
  await page.clock.install();
  const state = await fixture(page);
  let failRead = false, savedReads = 0;
  await page.route("**/api/bills/repeat-created-1", route => {
    const saved = state.bills.get("repeat-created-1");
    if (route.request().method() !== "GET" || saved?.status !== "READY") return route.fallback();
    savedReads++;
    return failRead ? route.fulfill({ status: 503, json: { error: "Fictional status refresh interruption." } })
      : route.fulfill({ json: { bill: saved } });
  });
  await page.goto(`/bills/new?jobId=${job.id}`);
  await fill(page, "FICTIONAL-STATUS-REFRESH");
  await page.getByRole("button", { name: "Save and sync", exact: true }).click();
  const outcome = page.getByRole("group", { name: "Saved bill confirmation", exact: true });
  await expect(outcome).toContainText("Provider confirmation is pending");
  await expect.poll(() => savedReads).toBeGreaterThan(0);
  await page.getByLabel("Payment reference", { exact: true }).fill("FICTIONAL-NEXT-AFTER-REFRESH");
  failRead = true;
  await page.clock.fastForward(5000);
  await expect(outcome).toContainText("Last verified result:");
  await expect(outcome).toContainText("The latest status could not be verified. Fictional status refresh interruption.");
  await expect(page.getByLabel("Payment reference", { exact: true })).toHaveValue("FICTIONAL-NEXT-AFTER-REFRESH");
  const pausedReads = savedReads;
  await page.clock.fastForward(10000);
  expect(savedReads).toBe(pausedReads);
  failRead = false;
  const record = state.bills.get("repeat-created-1")!.syncRecords![0];
  record.status = "SYNCED"; record.externalId = "998899003";
  await outcome.getByRole("button", { name: "Refresh saved bill status", exact: true }).click();
  await expect(outcome).toContainText("Bill saved and synchronized with Zoho Books.");
  await expect(outcome).not.toContainText("Last verified result:");
  await expect(page.getByLabel("Payment reference", { exact: true })).toHaveValue("FICTIONAL-NEXT-AFTER-REFRESH");
  expect([state.creates.length, state.attachments.length, state.submits.length]).toEqual([1, 1, 1]);
  expect(state.unexpected).toEqual([]);
});

test("multiple originals accumulate, deduplicate and remove before one save, then payment can be skipped for the same job", async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`/bills/new?jobId=${job.id}`);
  const today = await page.getByLabel("Bill Date").inputValue();
  await fill(page, "FICTIONAL-MULTIPLE-ORIGINALS");
  await page.getByLabel("Invoice attachment", { exact: true }).setInputFiles([original("FICTIONAL-second.pdf"), original("FICTIONAL-third.pdf")]);
  const selected = page.getByRole("list", { name: "Selected invoice attachments", exact: true });
  await expect(selected.getByRole("group")).toHaveCount(3);
  await page.getByLabel("Invoice attachment", { exact: true }).setInputFiles(original("FICTIONAL-repeat-original.pdf"));
  await expect(selected.getByRole("group")).toHaveCount(3);
  await page.getByRole("button", { name: "Remove FICTIONAL-second.pdf", exact: true }).click();
  await expect(selected.getByRole("group")).toHaveCount(2);
  await page.getByRole("button", { name: "Save and sync", exact: true }).click();
  await paymentStep(page);
  expect(state.uploads.map(upload => [upload.fileName, upload.version])).toEqual([["FICTIONAL-repeat-original.pdf", 1], ["FICTIONAL-third.pdf", 2]]);
  expect(state.bills.get("repeat-created-1")?.documents).toHaveLength(2);
  expect(state.bills.get("repeat-created-1")).toMatchObject({ version: 4, paidAmount: "0.00", payments: [] });
  await page.getByRole("link", { name: "Skip payment", exact: true }).click();
  await assertFresh(page, today);
  expect([state.creates.length, state.submits.length, state.searches]).toEqual([1, 1, 0]);
  expect(state.unexpected).toEqual([]);
});

test("a lost upload response resumes the same original and skips completed uploads without duplicate documents", async ({ page }) => {
  const state = await fixture(page);
  state.attachmentFault = { name: "FICTIONAL-lost-response.pdf", kind: "lost_after_store" };
  await page.goto(`/bills/new?jobId=${job.id}`);
  await fill(page, "FICTIONAL-LOST-UPLOAD-RESPONSE");
  await page.getByLabel("Invoice attachment", { exact: true }).setInputFiles([original("FICTIONAL-lost-response.pdf"), original("FICTIONAL-last.pdf")]);
  await page.getByRole("button", { name: "Save and sync", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your financial data is safely saved", exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Attachment FICTIONAL-repeat-original.pdf", exact: true })).toContainText("Saved to this bill");
  await expect(page.getByRole("group", { name: "Attachment FICTIONAL-lost-response.pdf", exact: true })).toContainText("Upload needs verification");
  await expect(page.getByLabel("Invoice attachment", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Remove FICTIONAL-lost-response.pdf", exact: true })).toBeDisabled();
  expect(state.creates).toHaveLength(1); expect(state.submits).toHaveLength(0);
  expect(state.bills.get("repeat-created-1")?.documents).toHaveLength(2);
  await page.getByRole("button", { name: "Retry attachments", exact: true }).click();
  await paymentStep(page);
  expect(state.uploads.map(upload => [upload.fileName, upload.version])).toEqual([
    ["FICTIONAL-repeat-original.pdf", 1], ["FICTIONAL-lost-response.pdf", 2],
    ["FICTIONAL-lost-response.pdf", 2], ["FICTIONAL-last.pdf", 3],
  ]);
  expect(state.bills.get("repeat-created-1")?.documents).toHaveLength(3);
  expect([state.creates.length, state.submits.length]).toEqual([1, 1]);
  expect(state.unexpected).toEqual([]);
});

test("a definitely rejected pending original can be replaced without reposting saved files or creating another bill", async ({ page }) => {
  const state = await fixture(page);
  state.attachmentFault = { name: "FICTIONAL-rejected.pdf", kind: "reject" };
  await page.goto(`/bills/new?jobId=${job.id}`);
  await fill(page, "FICTIONAL-KNOWN-UPLOAD-REJECTION");
  await page.getByLabel("Invoice attachment", { exact: true }).setInputFiles([original("FICTIONAL-rejected.pdf"), original("FICTIONAL-last.pdf")]);
  await page.getByRole("button", { name: "Save and sync", exact: true }).click();
  await expect(page.getByRole("group", { name: "Attachment FICTIONAL-rejected.pdf", exact: true })).toContainText("Upload rejected");
  await expect(page.getByLabel("Invoice attachment", { exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Remove FICTIONAL-rejected.pdf", exact: true }).click();
  await page.getByLabel("Invoice attachment", { exact: true }).setInputFiles(original("FICTIONAL-replacement.pdf"));
  await page.getByRole("button", { name: "Retry attachments", exact: true }).click();
  await paymentStep(page);
  expect(state.uploads.map(upload => upload.fileName)).toEqual(["FICTIONAL-repeat-original.pdf", "FICTIONAL-rejected.pdf", "FICTIONAL-last.pdf", "FICTIONAL-replacement.pdf"]);
  expect(state.bills.get("repeat-created-1")?.documents?.map(document => document.fileName)).toEqual(["FICTIONAL-repeat-original.pdf", "FICTIONAL-last.pdf", "FICTIONAL-replacement.pdf"]);
  expect([state.creates.length, state.submits.length]).toEqual([1, 1]);
  expect(state.unexpected).toEqual([]);
});

test("attachment count and aggregate limits reject additions without discarding an already selected original", async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`/bills/new?jobId=${job.id}`);
  await fill(page, "FICTIONAL-UPLOAD-LIMITS");
  await page.getByLabel("Invoice attachment", { exact: true }).setInputFiles({ name: "FICTIONAL-too-large.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(5_000_001, 1) });
  await expect(page.getByText("Choose PDF, JPEG or PNG originals, up to 5 files and 5 MB total.", { exact: true })).toBeVisible();
  await expect(page.getByRole("list", { name: "Selected invoice attachments", exact: true }).getByRole("group")).toHaveCount(1);
  await page.getByLabel("Invoice attachment", { exact: true }).setInputFiles(Array.from({ length: 5 }, (_, index) => original(`FICTIONAL-extra-${index}.pdf`)));
  await expect(page.getByText("Keep up to 5 originals and 5 MB total, including files already saved to this bill.", { exact: true })).toBeVisible();
  await expect(page.getByRole("list", { name: "Selected invoice attachments", exact: true }).getByRole("group")).toHaveCount(1);
  expect([state.creates.length, state.attachments.length, state.submits.length]).toEqual([0, 0, 0]);
  expect(state.unexpected).toEqual([]);
});

for (const mode of ["create_revision", "provider_update"] as const) {
  test(`finalized ${mode} edits use one PATCH with fixed scope and keep payments and originals`, async ({ page }) => {
    const state = await fixture(page), id = `repeat-edit-${mode}`;
    const input: Payload = { companyId: company.id, vendorId: vendor.id, jobId: job.id, invoiceNumber: "FICTIONAL-FINAL-EDIT",
      invoiceDate: "2026-10-29", orderNumber: "", paymentTerms: "CUSTOM", dueDate: "", description: "", category: "MATERIALS",
      currency: "AED", discount: "0", vatRate: "5", notes: "", lines: [{ description: "Fictional finalized line", quantity: "1", unitPrice: "100.00" }], submit: false };
    const documents = [{ id: "fictional-retained-original", fileName: "FICTIONAL-retained.pdf", byteSize: 100 }];
    const payments = [{ id: "fictional-retained-payment", amount: "50.00", reference: "FICTIONAL-KEEP-PAYMENT", createdAt: "2026-11-04T09:00:00Z" }];
    state.bills.set(id, { ...storedBill(id, input), version: 7, status: "READY", paidAmount: "50.00", paymentStatus: "PARTIALLY_PAID", documents, payments,
      editEligibility: { allowed: true, reason: null, mode }, syncRecords: [{ target: "ZOHO", id: `${id}-sync`, status: mode === "provider_update" ? "SYNCED" : "FAILED",
        organizationId, externalId: mode === "provider_update" ? "998899001" : null }] });
    if (mode === "provider_update") {
      await page.goto(`/bills/${id}/payment?entry=1&saved=1`);
      await page.getByRole("link", { name: "Edit saved bill", exact: true }).click();
    } else {
      await page.goto(`/bills/${id}`);
      await page.getByRole("link", { name: "Edit bill", exact: true }).click();
    }
    await expect(page.getByRole("heading", { name: "Edit Bill", exact: true })).toBeVisible();
    for (const field of [page.getByRole("combobox", { name: "Company", exact: true }), page.getByLabel(/^Job \/ project/), page.getByLabel("Currency", { exact: true })])
      await expect(field).toBeDisabled();
    await expect(page.getByLabel("Invoice attachment", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "FICTIONAL-retained.pdf", exact: true })).toHaveAttribute("href", "/api/documents/fictional-retained-original");
    await expect(page.getByRole("button", { name: "Save changes", exact: true })).toHaveCount(0);
    await page.getByLabel("Notes", { exact: true }).fill("Fictional audited updated note");
    await page.getByRole("button", { name: "Save changes and sync", exact: true }).click();
    await expect(page.getByText("Choose a due date or select a known payment term before updating this finalized bill.", { exact: true })).toBeVisible();
    expect(state.updates).toHaveLength(0);
    await expect(page.getByLabel("Notes", { exact: true })).toHaveValue("Fictional audited updated note");
    await page.getByLabel("Due Date", { exact: true }).fill("2026-11-28");
    await page.getByRole("button", { name: "Save changes and sync", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/bills/${id}\\?saved=1$`));
    const saved = state.bills.get(id)!;
    expect(saved.documents).toEqual(documents); expect(saved.payments).toEqual(payments);
    expect(saved).toMatchObject({ id, status: "READY", version: 8, companyId: company.id, jobId: job.id, currency: "AED", paidAmount: "50.00" });
    expect(state.updates).toMatchObject([{ version: 7, companyId: company.id, jobId: job.id, currency: "AED", notes: "Fictional audited updated note" }]);
    expect([state.creates.length, state.attachments.length, state.submits.length]).toEqual([0, 0, 0]);
    if (mode === "provider_update") {
      await expect(page.getByText("Bill changes saved. Zoho Books update queued. Confirmation of the changes is pending.", { exact: true })).toBeVisible();
      await expect(page.getByText("Bill created in Zoho Books. Attachment synchronization is still pending.", { exact: true })).toHaveCount(0);
    }
    expect(state.unexpected).toEqual([]);
  });
}

test("an edit blocked by a current processing or uncertain operation shows its reason and no writable form", async ({ page }) => {
  const state = await fixture(page), input = { companyId: company.id, vendorId: vendor.id, jobId: job.id, invoiceNumber: "FICTIONAL-EDIT-BLOCKED",
    invoiceDate: "2026-10-29", orderNumber: "", paymentTerms: "CUSTOM", dueDate: "", description: "", category: "MATERIALS", currency: "AED",
    discount: "0", vatRate: "5", notes: "", lines: [{ description: "Fictional blocked line", quantity: "1", unitPrice: "100.00" }], submit: false };
  state.bills.set("repeat-edit-blocked", { ...storedBill("repeat-edit-blocked", input), status: "READY",
    editEligibility: { allowed: false, reason: "The existing Zoho Books outcome needs reconciliation before editing.", mode: null } });
  await page.goto("/bills/repeat-edit-blocked");
  await expect(page.getByRole("link", { name: "Edit bill", exact: true })).toHaveCount(0);
  await expect(page.getByText("The existing Zoho Books outcome needs reconciliation before editing.", { exact: true })).toBeVisible();
  await page.goto("/bills/repeat-edit-blocked/edit");
  await expect(page.getByText("The existing Zoho Books outcome needs reconciliation before editing.", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Bill#")).toHaveCount(0);
  expect([state.updates.length, state.creates.length]).toEqual([0, 0]); expect(state.unexpected).toEqual([]);
});

test("verified VAT-not-registered supplier blocks explicit zero-rate final save but allows an unchanged draft", async ({ page }) => {
  const state = await fixture(page);
  state.vendorVat = { status: "verified", taxTreatment: "vat_not_registered", hasTaxRegistrationNumber: false, checkedAt: "2026-11-04T09:00:00Z", warning: null };
  const zero = { id: "88112", name: "Fictional Zero Rate", rate: "0.00", selectable: true };
  await page.route("**/api/bills/options?**", route => route.fulfill({ json: { ...options, taxes: [...options.taxes, zero] } }));
  await page.goto(`/bills/new?jobId=${job.id}`);
  await fill(page, "FICTIONAL-VAT-CONFLICT");
  await expect(page.getByText("Zoho VAT status: VAT not registered", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save and sync", exact: true })).toBeDisabled();
  await lineOption(page, "account", options.accounts[0].name);
  await lineOption(page, "tax", "No VAT");
  await expect(page.getByRole("button", { name: "Save and sync", exact: true })).toBeEnabled();
  // The provider catalog contains a numeric Zero Rate ID; selecting it still counts as VAT.
  await lineOption(page, "tax", zero.name);
  await expect(page.getByRole("button", { name: "Save and sync", exact: true })).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "Line 1 tax", exact: true })).toHaveValue(zero.name);
  await page.getByRole("button", { name: "Save as draft", exact: true }).click();
  await expect(page.getByRole("group", { name: "Saved bill confirmation", exact: true })).toContainText("Draft saved. It has not been sent to Zoho Books.");
  expect(state.creates[0].lines[0].booksSelection).toMatchObject({ taxId: zero.id, taxRate: "0.00" });
  expect(state.submits).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("unavailable supplier metadata stays advisory while a failed fresh finalization retains the saved draft and originals", async ({ page }) => {
  const state = await fixture(page);
  state.vendorVat = { status: "unavailable", taxTreatment: "unknown", hasTaxRegistrationNumber: false, checkedAt: null, warning: "Fictional supplier VAT status is unavailable; keep a draft if final verification fails." };
  state.failFinalize = true;
  await page.goto(`/bills/new?jobId=${job.id}`);
  await fill(page, "FICTIONAL-VAT-CHECK-UNAVAILABLE", true);
  await expect(page.getByText("Fictional supplier VAT status is unavailable; keep a draft if final verification fails.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retry supplier check", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Vendor Name", exact: true })).toHaveValue(vendor.name);
  await expect(page.getByText("Fictional supplier VAT status is unavailable; keep a draft if final verification fails.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Bill#")).toHaveValue("FICTIONAL-VAT-CHECK-UNAVAILABLE");
  await expect(page.getByRole("combobox", { name: "Line 1 tax", exact: true })).toHaveValue(options.taxes[0].name);
  await expect(page.getByRole("group", { name: "Attachment FICTIONAL-repeat-original.pdf", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save and sync", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Save and sync", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your financial data is safely saved", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Record payment", exact: true })).toHaveCount(0);
  expect(state.bills.get("repeat-created-1")).toMatchObject({ status: "DRAFT", version: 2, vendorId: vendor.id,
    lines: [{ booksSelection: { taxId: options.taxes[0].id, taxRate: "5.00" } }] });
  expect(state.bills.get("repeat-created-1")?.documents).toHaveLength(1);
  await page.getByRole("button", { name: "Retry Save and sync", exact: true }).click();
  await paymentStep(page);
  expect([state.creates.length, state.attachments.length, state.submits.length]).toEqual([1, 1, 2]);
  expect(state.unexpected).toEqual([]);
});
