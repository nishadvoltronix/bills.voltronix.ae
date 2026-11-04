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
  taxes: [{ id: "88111", name: "Fictional Repeat VAT", rate: "5.00", selectable: true }],
  customers: [{ id: "88121", name: "Fictional Repeat Books Customer", currency: "AED" }], warning: null, hasMoreCustomers: false };
const original = (name: string) => ({ name, mimeType: "application/pdf",
  buffer: Buffer.from(`%PDF-1.4\n% Fictional repeat-entry original ${name}\n%%EOF`) });
type Payload = { companyId: string; vendorId: string; jobId: string; invoiceNumber: string; invoiceDate: string;
  orderNumber: string; paymentTerms: string; dueDate: string; description: string; category: string; currency: string;
  discount: string; vatRate: string; notes: string; lines: NonNullable<Bill["lines"]>; submit: boolean; version?: number };
type Fixture = { creates: Payload[]; updates: Payload[]; attachments: string[]; submits: string[]; searches: number;
  unexpected: string[]; bills: Map<string, Bill>; failCreate: boolean; failAttachment: boolean; failFinalize: boolean;
  holdAttachment: Promise<void> | null };

function storedBill(id: string, input: Payload): Bill {
  return { ...input, id, paymentTerms: input.paymentTerms as Bill["paymentTerms"], version: input.version ?? 1,
    status: "DRAFT", paymentStatus: "UNPAID", subtotal: "100.00", vatAmount: "5.00", total: "105.00",
    paidAmount: "0.00", outstanding: "105.00", createdAt: "2026-11-04T08:00:00Z", vendor, job,
    documents: [], payments: [], syncRecords: [] };
}

async function fixture(page: Page): Promise<Fixture> {
  const state: Fixture = { creates: [], updates: [], attachments: [], submits: [], searches: 0,
    unexpected: [], bills: new Map(), failCreate: false, failAttachment: false, failFinalize: false, holdAttachment: null };
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
        selectedVendor: hydration ? vendor : null, hasMore: false, warning: null } });
    }
    if (method === "POST" && path === "/api/vendors/resolve") {
      expect(request.postDataJSON()).toMatchObject({ companyId: company.id, organizationId, externalVendorId: "998811001" });
      return route.fulfill({ json: { vendor } });
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
        const updated = { ...storedBill(bill.id, input), version: bill.version + 1 };
        state.bills.set(updated.id, updated);
        return route.fulfill({ json: { bill: updated } });
      }
      if (method === "POST" && match[2] === "attachment") {
        state.attachments.push(bill.id);
        expect(request.headers()["x-bill-version"]).toBe(String(bill.version));
        expect(request.headers()["content-type"]).toContain("multipart/form-data;");
        expect(request.postDataBuffer()?.toString()).toContain("Fictional repeat-entry original");
        if (state.failAttachment) { state.failAttachment = false; return route.fulfill({ status: 503, json: { error: "Fictional upload interruption." } }); }
        if (state.holdAttachment) await state.holdAttachment;
        const document = { id: `${bill.id}-original`, fileName: "FICTIONAL-repeat-original.pdf" };
        bill.version++; bill.documents = [document];
        return route.fulfill({ json: { document: { ...document, billVersion: bill.version, alreadyAttached: false } } });
      }
      if (method === "POST" && match[2] === "actions") {
        state.submits.push(bill.id);
        expect(request.postDataJSON()).toEqual({ action: "submit", version: bill.version });
        if (state.failFinalize) { state.failFinalize = false; return route.fulfill({ status: 503, json: { error: "Fictional finalization interruption." } }); }
        bill.status = "READY"; bill.version++;
        bill.syncRecords = [{ id: `${bill.id}-sync`, target: "ZOHO", status: "PENDING", organizationId, externalId: null }];
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
  await page.getByLabel("Invoice attachment").setInputFiles(original("FICTIONAL-repeat-original.pdf"));
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
    page.getByRole("combobox", { name: "Line 1 customer", exact: true }), page.getByLabel("Invoice attachment")])
    await expect(control).toHaveValue("");
  await expect(page.getByLabel("Line 1 quantity")).toHaveValue("1");
  await expect(page.getByLabel("Payment Terms", { exact: true })).toHaveValue("CUSTOM");
  await expect(page.locator("#bill-category")).toHaveValue("MATERIALS");
  await expect(page.getByLabel("Discount amount", { exact: true })).toHaveValue("0");
  await expect(page.locator("#bill-vat")).toHaveValue("5");
  await expect(page.getByLabel("Bill Date")).toHaveValue(today);
  expect(await page.getByLabel("Invoice attachment").evaluate((element: HTMLInputElement) => element.files?.length)).toBe(0);
  await expect(page.getByText("Attach the original vendor invoice.", { exact: true })).toBeVisible();
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
    await assertFresh(page, today);
    await expect(page.getByRole("group", { name: "Saved bill confirmation", exact: true })).toBeFocused();
    await expect(page.getByRole("group", { name: "Saved bill confirmation", exact: true })).toContainText("FICTIONAL-REPEAT-FIRST");
    await expect(page).toHaveURL(new RegExp(`/bills/new\\?jobId=${job.id}$`));
    await expect(page.getByRole("link", { name: "View saved bill", exact: true })).toHaveAttribute("href", "/bills/repeat-created-1?saved=1");
    await expect(page.getByRole("link", { name: "View job history", exact: true })).toHaveAttribute("href", `/jobs/${job.id}`);
    await fill(page, "FICTIONAL-REPEAT-SECOND");
    // Fixed discounts and selected Books line taxes are deliberately exclusive.
    // The second invoice uses the manual VAT path to verify discount reset too.
    await page.getByLabel("Discount amount", { exact: true }).fill("7.50");
    await page.getByRole("button", { name: "Save as draft", exact: true }).click();
    await assertFresh(page, today);
    await expect(page.getByRole("group", { name: "Saved bill confirmation", exact: true })).toContainText("FICTIONAL-REPEAT-SECOND");
    await expect(page.getByRole("link", { name: "View saved bill", exact: true })).toHaveAttribute("href", "/bills/repeat-created-2?saved=1");
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
  expect(await page.getByLabel("Invoice attachment").evaluate((element: HTMLInputElement) => element.files?.length)).toBe(1);
  await expect(page.getByRole("button", { name: "Save and sync", exact: true })).toBeEnabled();
  expect([state.creates.length, state.attachments.length, state.submits.length]).toEqual([1, 0, 0]);
  await page.getByRole("button", { name: "Save and sync", exact: true }).click();
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
    await assertFresh(page, today);
    expect(state.creates).toHaveLength(1);
    expect(state.attachments).toEqual(failure === "attachment" ? ["repeat-created-1", "repeat-created-1"] : ["repeat-created-1"]);
    expect(state.submits).toEqual(failure === "finalize" ? ["repeat-created-1", "repeat-created-1"] : ["repeat-created-1"]);
    expect(state.bills.get("repeat-created-1")?.status).toBe("READY");
    await expect(page.getByRole("link", { name: "View saved bill", exact: true })).toHaveAttribute("href", "/bills/repeat-created-1?saved=1");
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
