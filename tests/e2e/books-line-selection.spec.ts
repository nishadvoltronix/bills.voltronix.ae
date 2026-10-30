import { expect, test, type Page } from "@playwright/test";
import type { Bill, Job, Vendor } from "../../src/components/types";
import type { BooksSelection } from "../../src/lib/books-selection";

// Every business/provider response is a fictional fixture. Authentication alone
// uses the local test account; these checks never create bills or contact Zoho.
const companies = [
  { id: "line-options-alpha", name: "Fictional Line Company Alpha", organizationId: "910010001", suffix: "Alpha", prefix: "71" },
  { id: "line-options-beta", name: "Fictional Line Company Beta", organizationId: "910010002", suffix: "Beta", prefix: "72" },
];
const vendors: Vendor[] = companies.map(company => ({ id: `${company.id}-vendor`, companyId: company.id,
  name: `Fictional Supplier ${company.suffix}`, currency: "AED", trn: "100000000000001" }));
const jobs: Job[] = companies.map(company => ({ id: `${company.id}-job`, companyId: company.id,
  jobNumber: `FICTIONAL-${company.suffix}`, name: `Fictional Project ${company.suffix}`, customer: "Fictional job customer",
  currency: "AED", contractValue: "1000.00", approvedVariations: "0.00" }));

function options(company = companies[0]) {
  return { companyId: company.id, organizationId: company.organizationId, dataCenter: "US", environment: "production",
    accounts: [
      { id: `${company.prefix}01`, name: `Fictional Expense ${company.suffix}`, type: "expense", selectable: true },
      { id: `${company.prefix}02`, name: `Fictional Asset ${company.suffix}`, type: "fixed_asset", selectable: true },
      { id: `${company.prefix}03`, name: `Fictional Inactive ${company.suffix}`, type: "expense", selectable: false },
    ],
    taxes: [
      { id: `${company.prefix}11`, name: `Fictional VAT 5 ${company.suffix}`, rate: "5.00", selectable: true },
      { id: `${company.prefix}12`, name: `Fictional VAT 0 ${company.suffix}`, rate: "0.00", selectable: true },
    ],
    customers: [{ id: `${company.prefix}21`, name: `Fictional Customer ${company.suffix}`, currency: "AED" }],
    warning: null as string | null, hasMoreCustomers: false,
  };
}
function selection(company = companies[0]): BooksSelection {
  const value = options(company);
  return { organizationId: company.organizationId, dataCenter: "US", environment: "production",
    accountId: value.accounts[0].id, accountName: value.accounts[0].name,
    taxId: value.taxes[0].id, taxName: value.taxes[0].name, taxRate: "5.00",
    customerId: value.customers[0].id, customerName: value.customers[0].name };
}
const companyInput = (page: Page) => page.getByRole("combobox", { name: "Company", exact: true });
const control = (page: Page, kind: string, line = 1) => page.getByRole("combobox", { name: `Line ${line} ${kind}`, exact: true });
async function choose(page: Page, kind: string, name: string, line = 1) {
  await control(page, kind, line).fill(name);
  await page.getByRole("option", { name: new RegExp(`^${name}`) }).click();
}
async function open(page: Page, index = 0) {
  await page.goto("/bills/new");
  await companyInput(page).selectOption(companies[index].id);
  const supplier = page.getByRole("combobox", { name: "Vendor Name", exact: true });
  await supplier.fill(vendors[index].name);
  await page.getByRole("option", { name: new RegExp(`^${vendors[index].name}`) }).click();
  await page.getByLabel(/^Job \/ project/).selectOption(jobs[index].id);
  await page.getByLabel("Bill#").fill("FICTIONAL-LINE-SELECTION");
  await page.getByLabel("Bill Date").fill("2026-10-29");
  await page.getByLabel("Line 1 description").fill("Fictional line selection test");
  await page.getByLabel("Line 1 unit price").fill("100.00");
}
async function chooseLine(page: Page, index = 0, line = 1, zeroRate = false) {
  const value = options(companies[index]);
  await choose(page, "account", value.accounts[0].name, line);
  await choose(page, "tax", value.taxes[zeroRate ? 1 : 0].name, line);
}
async function captureSaves(page: Page) {
  const saves: Record<string, unknown>[] = [];
  await page.route("**/api/bills", route => {
    saves.push(route.request().postDataJSON());
    return route.fulfill({ status: 422, json: { error: "Fictional line payload inspected; no bill created." } });
  });
  return saves;
}
async function save(page: Page) {
  await page.getByRole("button", { name: "Save as draft", exact: true }).click();
  await expect(page.getByText("Fictional line payload inspected; no bill created.", { exact: true })).toBeVisible();
}
function fixtureBill(): Bill {
  return { id: "fictional-books-line-bill", companyId: companies[0].id, vendorId: vendors[0].id, jobId: jobs[0].id,
    invoiceNumber: "FICTIONAL-SAVED-LINE", invoiceDate: "2026-10-29", category: "MATERIALS", currency: "AED",
    status: "DRAFT", version: 7, discount: "0.00", vatRate: "5.00", subtotal: "100.00", vatAmount: "5.00",
    total: "105.00", paidAmount: "0.00", createdAt: "2026-10-29T08:00:00Z", vendor: vendors[0], job: jobs[0],
    lines: [{ description: "Fictional saved accounting line", quantity: "1", unitPrice: "100.00", booksSelection: selection() }],
    documents: [{ id: "fictional-original", fileName: "FICTIONAL-original.pdf" }], payments: [], syncRecords: [] };
}

test.beforeEach(async ({ page, baseURL }) => {
  const email = process.env.SEED_ADMIN_EMAIL, password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password || !baseURL) throw new Error("The local test account is required.");
  expect((await page.request.post(`${baseURL}/api/auth/login`, { headers: { Origin: baseURL }, data: { email, password } })).status()).toBe(200);
  await page.route("**/api/companies", route => route.fulfill({ json: { companies } }));
  await page.route("**/api/jobs", route => route.fulfill({ json: { jobs } }));
  await page.route("**/api/integrations", route => route.fulfill({ json: { zoho: { organizations: companies.map(company => ({
    companyId: company.id, organizationId: company.organizationId, name: company.name, dataCenter: "US", environment: "production",
    status: "CONNECTED", writeEnabled: false, missing: ["ZOHO_BOOKS_MAPPING_JSON"], postingMissing: ["LIVE_OPERATIONAL_ENVIRONMENT"],
  })) } } }));
  await page.route("**/api/vendors/search?*", route => {
    const params = new URL(route.request().url()).searchParams;
    const index = companies.findIndex(company => company.id === params.get("companyId"));
    const vendor = vendors[index];
    return route.fulfill({ json: { companyId: companies[index].id, organizationId: companies[index].organizationId,
      vendors: params.has("vendorId") ? [] : [vendor], selectedVendor: params.has("vendorId") ? vendor : null, warning: null, hasMore: false } });
  });
  await page.route("**/api/bills/options?*", route => {
    const params = new URL(route.request().url()).searchParams;
    const company = companies.find(item => item.id === params.get("companyId"))!;
    const value = options(company);
    const query = (params.get("customerQuery") ?? "").toLowerCase();
    if (query) value.customers = value.customers.filter(customer => customer.name.toLowerCase().includes(query));
    return route.fulfill({ json: value });
  });
});
test.afterEach(async ({ page, baseURL }) => {
  if (baseURL) await page.request.post(`${baseURL}/api/auth/logout`, { headers: { Origin: baseURL } });
});

for (const [index, company] of companies.entries()) {
  test(`saves exact account, tax and optional customer for ${company.suffix}`, async ({ page }) => {
    const saves = await captureSaves(page);
    await open(page, index);
    await chooseLine(page, index);
    await choose(page, "customer", options(company).customers[0].name);
    await save(page);
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ companyId: company.id, lines: [{ booksSelection: selection(company) }] });
  });
}

test("mixed VAT rates preview and save with their own tax IDs", async ({ page }) => {
  const saves = await captureSaves(page);
  await open(page);
  await chooseLine(page);
  await page.getByRole("button", { name: "Add another line", exact: true }).click();
  await page.getByLabel("Line 2 description").fill("Fictional zero-rated line");
  await page.getByLabel("Line 2 unit price").fill("100.00");
  await chooseLine(page, 0, 2, true);
  await expect(page.getByText("AED 205.00", { exact: true })).toBeVisible();
  await save(page);
  expect(saves[0]).toMatchObject({ lines: [
    { booksSelection: { taxId: "7111", taxRate: "5.00", customerId: null } },
    { booksSelection: { taxId: "7112", taxRate: "0.00", customerId: null } },
  ] });
});

test("customer can be cleared without discarding the account or tax", async ({ page }) => {
  const saves = await captureSaves(page);
  await open(page);
  await chooseLine(page);
  await choose(page, "customer", options().customers[0].name);
  await page.getByRole("button", { name: "Clear line 1 customer", exact: true }).click();
  await save(page);
  expect(saves[0]).toMatchObject({ lines: [{ booksSelection: { accountId: "7101", taxId: "7111", customerId: null, customerName: null } }] });
});

test("company change resets accounting choices and retains entered invoice values", async ({ page }) => {
  await open(page);
  await chooseLine(page);
  await choose(page, "customer", options().customers[0].name);
  await companyInput(page).selectOption(companies[1].id);
  await expect(control(page, "account")).toHaveValue("");
  await expect(control(page, "tax")).toHaveValue("");
  await expect(control(page, "customer")).toHaveValue("");
  await expect(page.getByLabel("Bill#")).toHaveValue("FICTIONAL-LINE-SELECTION");
  await expect(page.getByLabel("Line 1 unit price")).toHaveValue("100.00");
  await chooseLine(page, 1);
  await expect(control(page, "account")).toHaveValue(options(companies[1]).accounts[0].name);
});

test("saved accounting selections hydrate when absent from current search results", async ({ page }) => {
  const bill = fixtureBill();
  const patches: Record<string, unknown>[] = [];
  await page.route("**/api/bills/options?*", route => route.fulfill({ json: { ...options(), accounts: [], taxes: [], customers: [] } }));
  await page.route(`**/api/bills/${bill.id}`, route => {
    if (route.request().method() === "PATCH") {
      patches.push(route.request().postDataJSON());
      return route.fulfill({ status: 409, json: { error: "Fictional reviewed edit inspected." } });
    }
    return route.fulfill({ json: { bill } });
  });
  await page.goto(`/bills/${bill.id}/edit`);
  await expect(control(page, "account")).toHaveValue(selection().accountName);
  await expect(control(page, "tax")).toHaveValue(selection().taxName);
  await expect(control(page, "customer")).toHaveValue(selection().customerName!);
  await page.getByLabel("Notes", { exact: true }).fill("Keep the saved selections");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText("Fictional reviewed edit inspected.", { exact: true })).toBeVisible();
  expect(patches[0]).toMatchObject({ version: 7, lines: [{ booksSelection: selection() }] });
});

test("account keyboard selection does not submit and inactive accounts cannot be selected", async ({ page }) => {
  const saves = await captureSaves(page);
  await open(page);
  await control(page, "account").fill("Fictional Inactive");
  const inactive = page.getByRole("option", { name: /^Fictional Inactive Alpha/ });
  await expect(inactive).toHaveAttribute("aria-disabled", "true");
  await inactive.click({ force: true });
  await control(page, "account").fill("Fictional Asset");
  await expect(page.getByRole("option", { name: /^Fictional Asset Alpha/ })).toBeVisible();
  await control(page, "account").press("ArrowDown");
  await control(page, "account").press("Enter");
  await expect(control(page, "account")).toHaveValue("Fictional Asset Alpha");
  expect(saves).toEqual([]);
  await control(page, "account").press("Escape");
  await control(page, "account").click();
  await expect(page.getByRole("listbox", { name: "Line 1 account options", exact: true })).toBeVisible();
  await choose(page, "tax", options().taxes[0].name);
  await save(page);
  expect(saves[0]).toMatchObject({ lines: [{ booksSelection: { accountId: "7102" } }] });
});

test("clearing saved selections sends explicit null rather than silently omitting them", async ({ page }) => {
  const bill = fixtureBill();
  const patches: Record<string, unknown>[] = [];
  await page.route(`**/api/bills/${bill.id}`, route => {
    if (route.request().method() === "PATCH") {
      patches.push(route.request().postDataJSON());
      return route.fulfill({ status: 409, json: { error: "Fictional clear inspected." } });
    }
    return route.fulfill({ json: { bill } });
  });
  await page.goto(`/bills/${bill.id}/edit`);
  await expect(control(page, "account")).toHaveValue(selection().accountName);
  await page.getByRole("button", { name: "Clear all Books selections", exact: true }).click();
  await expect(control(page, "account")).toHaveValue("");
  await expect(page.getByLabel("Line 1 unit price")).toHaveValue("100.00");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText("Fictional clear inspected.", { exact: true })).toBeVisible();
  expect(patches[0]).toMatchObject({ lines: [{ booksSelection: null }] });
});

test("options API failures expose retry and preserve entered fields", async ({ page }) => {
  let failing = true;
  await page.route("**/api/bills/options?*", route => failing
    ? route.fulfill({ status: 503, json: { error: "Fictional catalog temporarily unavailable." } })
    : route.fulfill({ json: options() }));
  await open(page);
  await control(page, "account").click();
  await expect(page.getByRole("button", { name: "Retry account options", exact: true })).toBeVisible();
  failing = false;
  await page.getByRole("button", { name: "Retry account options", exact: true }).click();
  await chooseLine(page);
  await expect(page.getByLabel("Bill#")).toHaveValue("FICTIONAL-LINE-SELECTION");
  await expect(page.getByLabel("Line 1 unit price")).toHaveValue("100.00");
});

test("a stale tax can be reloaded and explicitly reselected without silently changing invoice values", async ({ page }) => {
  let refreshed = false;
  const fresh = options();
  fresh.accounts[0].name = "Fictional reviewed expense Alpha";
  fresh.taxes[0] = { ...fresh.taxes[0], name: "Fictional VAT 6 Alpha", rate: "6.00" };
  fresh.customers[0].name = "Fictional reviewed customer Alpha";
  const reviewedSelection = { ...selection(), accountName: fresh.accounts[0].name, taxName: fresh.taxes[0].name,
    taxRate: "6.00", customerName: fresh.customers[0].name };
  const savedBill = { ...fixtureBill(), invoiceNumber: "FICTIONAL-LINE-SELECTION", vatRate: "6.00", vatAmount: "6.00", total: "106.00",
    documents: [], lines: [{ description: "Fictional line selection test", quantity: "1", unitPrice: "100.00", booksSelection: reviewedSelection }] };
  const saves: Record<string, unknown>[] = [];
  const staleMessage = "A selected Books tax rate changed. Reload the options and review the invoice totals before saving.";
  await page.route("**/api/bills/options?*", route => route.fulfill({ json: refreshed ? fresh : options() }));
  await page.route("**/api/bills", route => {
    saves.push(route.request().postDataJSON());
    return saves.length === 1 ? route.fulfill({ status: 409, json: { error: staleMessage } })
      : route.fulfill({ status: 201, json: { bill: savedBill } });
  });
  await page.route(`**/api/bills/${savedBill.id}`, route => route.fulfill({ json: { bill: savedBill } }));
  await open(page);
  await chooseLine(page);
  await choose(page, "customer", selection().customerName!);
  await page.getByLabel("Notes", { exact: true }).fill("Fictional invoice retained during tax review");
  await page.getByRole("button", { name: "Save as draft", exact: true }).click();
  await expect(page.getByText(staleMessage, { exact: true })).toBeVisible();
  expect(saves).toHaveLength(1);
  expect(saves[0]).toMatchObject({ lines: [{ booksSelection: selection() }] });
  refreshed = true;
  const reload = page.getByRole("button", { name: "Reload Books options", exact: true });
  await reload.click();
  await control(page, "tax").click();
  const freshTax = page.getByRole("option", { name: /^Fictional VAT 6 Alpha/ });
  await expect(freshTax).toBeVisible();
  // Merely fetching the new metadata must not change any reviewed selection or total.
  await expect(control(page, "tax")).toHaveValue(selection().taxName);
  await expect(control(page, "account")).toHaveValue(selection().accountName);
  await expect(control(page, "customer")).toHaveValue(selection().customerName!);
  await expect(page.getByText("AED 105.00", { exact: true })).toBeVisible();
  await control(page, "tax").press("Escape");
  // Click the current field and choose its same ID; typing would clear that identity first.
  await control(page, "account").click();
  await page.getByRole("option", { name: /^Fictional reviewed expense Alpha/ }).click();
  await expect(control(page, "account")).toHaveValue(fresh.accounts[0].name);
  await control(page, "customer").click();
  await page.getByRole("option", { name: /^Fictional reviewed customer Alpha/ }).click();
  await expect(control(page, "customer")).toHaveValue(fresh.customers[0].name);
  await expect(page.getByText("AED 105.00", { exact: true })).toBeVisible();
  await control(page, "tax").click();
  await freshTax.click();
  await expect(control(page, "tax")).toHaveValue(fresh.taxes[0].name);
  await expect(page.getByText("AED 106.00", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Bill#")).toHaveValue("FICTIONAL-LINE-SELECTION");
  await expect(page.getByLabel("Bill Date")).toHaveValue("2026-10-29");
  await expect(page.getByLabel("Line 1 quantity")).toHaveValue("1");
  await expect(page.getByLabel("Line 1 unit price")).toHaveValue("100.00");
  await expect(page.getByLabel("Notes", { exact: true })).toHaveValue("Fictional invoice retained during tax review");
  expect(saves).toHaveLength(1);
  await page.getByRole("button", { name: "Save as draft", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/bills/${savedBill.id}\\?saved=1$`));
  await expect(page.getByRole("heading", { name: savedBill.invoiceNumber, exact: true })).toBeVisible();
  expect(saves).toHaveLength(2);
  expect(saves[1]).toMatchObject({ companyId: companies[0].id, vendorId: vendors[0].id, jobId: jobs[0].id,
    vatRate: "6.00", lines: [{ description: "Fictional line selection test", quantity: "1", unitPrice: "100.00", booksSelection: reviewedSelection }] });
});

test("empty customer search can recover without clearing account and tax", async ({ page }) => {
  await open(page);
  await chooseLine(page);
  await control(page, "customer").fill("missing fictional customer");
  await expect(page.getByText("No matching customers.", { exact: true })).toBeVisible();
  await choose(page, "customer", options().customers[0].name);
  await expect(control(page, "account")).toHaveValue(options().accounts[0].name);
  await expect(control(page, "tax")).toHaveValue(options().taxes[0].name);
});

test("a catalog response arriving after company switch cannot populate the old company", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let requested = false;
  let completed = false;
  await page.route("**/api/bills/options?*", async route => {
    const companyId = new URL(route.request().url()).searchParams.get("companyId");
    if (companyId !== companies[0].id) return route.fallback();
    requested = true;
    await gate;
    await route.fulfill({ json: options() }).catch(() => undefined);
    completed = true;
  });
  await page.goto("/bills/new");
  await companyInput(page).selectOption(companies[0].id);
  await expect.poll(() => requested).toBe(true);
  await companyInput(page).selectOption(companies[1].id);
  await chooseLine(page, 1);
  release();
  await expect.poll(() => completed).toBe(true);
  await expect(control(page, "account")).toHaveValue(options(companies[1]).accounts[0].name);
  await control(page, "account").fill("Fictional");
  await expect(page.getByRole("option", { name: /^Fictional Expense Alpha/ })).toHaveCount(0);
  await expect(page.getByRole("option", { name: /^Fictional Expense Beta/ })).toBeVisible();
});

test("an incomplete accounting selection cannot silently save as a legacy line", async ({ page }) => {
  const saves = await captureSaves(page);
  await open(page);
  await choose(page, "account", options().accounts[0].name);
  const button = page.getByRole("button", { name: "Save as draft", exact: true });
  if (await button.isEnabled()) await button.click();
  await expect(page.getByText(/select an account and tax|account and tax.*every line|every line.*account and tax/i).first()).toBeVisible();
  expect(saves).toEqual([]);
});
