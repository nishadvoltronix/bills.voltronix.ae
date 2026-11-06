import { expect, test, type Page } from "@playwright/test";
import type { BillBooksOptions, Job, Vendor } from "../../src/components/types";
import type { BillItemSuggestions } from "../../src/lib/services/bill-item-suggestions";

// Only LOCAL authentication reaches the app. Every item, company, vendor,
// accounting option and bill response is fictional; business writes are blocked.
const companyA = { id: "item-company-a", name: "Fictional Item Company A" };
const companyB = { id: "item-company-b", name: "Fictional Item Company B" };
const jobA: Job = { id: "item-job-a", companyId: companyA.id, jobNumber: "JOB-ITEM-A", name: "Fictional job A",
  customer: "Fictional customer", currency: "AED", contractValue: null, approvedVariations: null };
const secondJob: Job = { ...jobA, id: "item-job-a-second", jobNumber: "JOB-ITEM-SECOND" };
const jobB: Job = { ...jobA, id: "item-job-b", companyId: companyB.id, jobNumber: "JOB-ITEM-B" };
const vendor: Vendor = { id: "item-vendor", companyId: companyA.id, name: "Fictional item supplier", currency: "AED" };
const options: BillBooksOptions = { companyId: companyA.id, organizationId: "91001", dataCenter: "US", environment: "production",
  accounts: [{ id: "91101", name: "Fictional item expense", type: "expense", selectable: true }],
  taxes: [{ id: "91201", name: "Fictional item VAT", rate: "5.00", selectable: true }],
  customers: [{ id: "91301", name: "Fictional item customer", currency: "AED" }], warning: null, hasMoreCustomers: false };
type Read = { companyId: string; jobId: string; q: string };
type Reply = { status?: number; data?: BillItemSuggestions };
const description = (page: Page, line = 1) => page.getByLabel(`Line ${line} description`, { exact: true });
const list = (page: Page, line = 1) => page.getByRole("listbox", { name: `Line ${line} previous item descriptions`, exact: true });
const envelope = (read: Read, descriptions = ["Cabinet installation", "Cable tray installation"]): BillItemSuggestions => ({
  companyId: read.companyId, jobId: read.jobId, suggestions: descriptions.map(description => ({ description })),
});
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function fixture(page: Page) {
  const state = { reads: [] as Read[], bills: [] as Record<string, unknown>[], unexpected: [] as string[],
    lookup: async (read: Read): Promise<Reply> => ({ data: envelope(read) }) };
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()), endpoint = url.pathname;
    if (endpoint.startsWith("/api/auth/")) return route.continue();
    if (request.method() === "GET") {
      if (endpoint === "/api/companies") return route.fulfill({ json: { companies: [companyA, companyB] } });
      if (endpoint === "/api/jobs") return route.fulfill({ json: { jobs: [jobA, secondJob, jobB] } });
      const job = [jobA, secondJob, jobB].find(job => endpoint === `/api/jobs/${job.id}`);
      if (job) return route.fulfill({ json: { job, bills: [] } });
      if (endpoint === "/api/integrations") return route.fulfill({ json: { zoho: { organizations: [] } } });
      if (endpoint === "/api/bills/autofill") return route.fulfill({ json: { enabled: false, configured: false, message: "Fictional manual fixture." } });
      if (endpoint === "/api/bills/options") return route.fulfill({ json: { ...options, companyId: url.searchParams.get("companyId") } });
      if (endpoint === "/api/vendors/search") return route.fulfill({ json: { companyId: companyA.id, organizationId: "91001",
        dataCenter: "US", environment: "production", vendors: [vendor], selectedVendor: null, warning: null, hasMore: false } });
      if (endpoint === "/api/bills/item-suggestions") {
        const read = { companyId: url.searchParams.get("companyId")!, jobId: url.searchParams.get("jobId")!, q: url.searchParams.get("q")! };
        state.reads.push(read);
        const reply = await state.lookup(read);
        return route.fulfill({ status: reply.status ?? 200, json: reply.data ?? { error: "Fictional item lookup unavailable." } }).catch(() => {});
      }
    }
    if (request.method() === "POST" && endpoint === "/api/bills") {
      state.bills.push(request.postDataJSON());
      return route.fulfill({ status: 422, json: { error: "Fictional description-only save inspected." } });
    }
    state.unexpected.push(`${request.method()} ${endpoint}`);
    return route.fulfill({ status: 422, json: { error: "Unexpected fixture request; no business data changed." } });
  });
  return state;
}
async function scope(page: Page, companyId = companyA.id, jobId = jobA.id) {
  await page.goto("/bills/new");
  await page.getByRole("combobox", { name: "Company", exact: true }).selectOption(companyId);
  await page.getByLabel(/^Job \/ project/).selectOption(jobId);
}
test.beforeEach(async ({ page, baseURL }) => {
  const email = process.env.SEED_ADMIN_EMAIL, password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password || !baseURL) throw new Error("Existing LOCAL test authentication is required.");
  expect((await page.request.post(baseURL + "/api/auth/login", { headers: { Origin: baseURL }, data: { email, password } })).status()).toBe(200);
});
test.afterEach(async ({ page, baseURL }) => {
  if (baseURL) await page.request.post(baseURL + "/api/auth/logout", { headers: { Origin: baseURL } });
});

test("item lookup waits for a selected company and job, skips blank text and debounces scoped typing", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/bills/new");
  await description(page).fill("cab");
  await page.waitForTimeout(350);
  expect(state.reads).toEqual([]);
  await page.getByRole("combobox", { name: "Company", exact: true }).selectOption(companyA.id);
  await description(page).click();
  await page.waitForTimeout(350);
  expect(state.reads).toEqual([]);
  await page.getByLabel(/^Job \/ project/).selectOption(jobA.id);
  await description(page).fill(" c ");
  await description(page).fill(" ca ");
  await description(page).fill(" cab ");
  await expect(list(page).getByRole("option")).toHaveCount(2);
  expect(state.reads).toEqual([{ companyId: companyA.id, jobId: jobA.id, q: "cab" }]);
  await expect(description(page)).toHaveValue(" cab ");
  await description(page).fill("   ");
  await page.waitForTimeout(350);
  expect(state.reads).toHaveLength(1);
  await expect(list(page)).toHaveCount(0);
  expect(state.bills).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("keyboard item selection copies only the description and retains row values and accounting choices", async ({ page }) => {
  const state = await fixture(page);
  await scope(page);
  await page.getByRole("combobox", { name: "Vendor Name", exact: true }).fill(vendor.name);
  await page.getByRole("option", { name: /^Fictional item supplier/ }).click();
  await page.getByLabel("Bill#").fill("FICTIONAL-ITEM-ONLY");
  await page.getByLabel("Bill Date").fill("2026-11-06");
  await page.getByLabel("Line 1 quantity").fill("3.25");
  await page.getByLabel("Line 1 unit price").fill("17.40");
  for (const [kind, name] of [["account", options.accounts[0].name], ["tax", options.taxes[0].name], ["customer", options.customers[0].name]]) {
    await page.getByRole("combobox", { name: `Line 1 ${kind}`, exact: true }).fill(name);
    await page.getByRole("option", { name: new RegExp(`^${name}`) }).click();
  }
  await description(page).fill("cab");
  await expect(list(page).getByRole("option")).toHaveCount(2);
  await expect(description(page)).toHaveAttribute("role", "combobox");
  await description(page).press("ArrowDown");
  await expect(list(page).getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  await description(page).press("ArrowDown");
  await description(page).press("Enter");
  await expect(description(page)).toHaveValue("Cable tray installation");
  await expect(description(page)).toHaveAttribute("aria-expanded", "false");
  await expect(list(page)).toHaveCount(0);
  await expect(page.getByLabel("Line 1 quantity")).toHaveValue("3.25");
  await expect(page.getByLabel("Line 1 unit price")).toHaveValue("17.40");
  await expect(page.getByRole("combobox", { name: "Company", exact: true })).toHaveValue(companyA.id);
  await expect(page.getByLabel(/^Job \/ project/)).toHaveValue(jobA.id);
  for (const [kind, name] of [["account", options.accounts[0].name], ["tax", options.taxes[0].name], ["customer", options.customers[0].name]])
    await expect(page.getByRole("combobox", { name: `Line 1 ${kind}`, exact: true })).toHaveValue(name);
  expect(state.bills).toEqual([]);
  await page.getByRole("button", { name: "Save as draft", exact: true }).click();
  await expect(page.getByText("Fictional description-only save inspected.", { exact: true })).toBeVisible();
  expect(state.bills).toHaveLength(1);
  expect(state.bills[0]).toMatchObject({ companyId: companyA.id, jobId: jobA.id, invoiceNumber: "FICTIONAL-ITEM-ONLY", submit: false,
    lines: [{ description: "Cable tray installation", quantity: "3.25", unitPrice: "17.40", booksSelection: {
      accountId: "91101", taxId: "91201", taxRate: "5.00", customerId: "91301" } }] });
  await description(page).focus();
  await description(page).press("Escape");
  await description(page).press("End");
  await description(page).press("Shift+Enter");
  await expect(description(page)).toHaveValue("Cable tray installation\n");
  expect(await description(page).evaluate((input: HTMLTextAreaElement) => ({ tag: input.tagName, required: input.required, maxLength: input.maxLength, rows: input.rows })))
    .toEqual({ tag: "TEXTAREA", required: true, maxLength: 500, rows: 2 });
  expect(state.bills).toHaveLength(1); expect(state.unexpected).toEqual([]);
});

test("late item responses cannot replace a newer query, job or company", async ({ page }) => {
  const state = await fixture(page), oldQuery = deferred(), oldJob = deferred();
  state.lookup = async read => {
    if (read.q === "old") { await oldQuery.promise; return { data: envelope(read, ["Old query item"]) }; }
    if (read.q === "job" && read.jobId === jobA.id) { await oldJob.promise; return { data: envelope(read, ["Old job item"]) }; }
    return { data: envelope(read, [read.companyId === companyB.id ? "Other company item" : read.jobId === secondJob.id ? "Second job item" : "New query item"]) };
  };
  try {
    await scope(page);
    await description(page).fill("old");
    await expect.poll(() => state.reads.some(read => read.q === "old")).toBe(true);
    await description(page).fill("new");
    await expect(list(page).getByRole("option", { name: "New query item", exact: true })).toBeVisible();
    oldQuery.release();
    await description(page).fill("job");
    await expect.poll(() => state.reads.some(read => read.q === "job")).toBe(true);
    await page.getByLabel(/^Job \/ project/).selectOption(secondJob.id);
    await description(page).click();
    await expect(list(page).getByRole("option", { name: "Second job item", exact: true })).toBeVisible();
    oldJob.release();
    await page.waitForTimeout(250);
    await expect(page.getByRole("option", { name: /Old query item|Old job item/ })).toHaveCount(0);
    await page.getByRole("combobox", { name: "Company", exact: true }).selectOption(companyB.id);
    await description(page).click();
    const beforeJob = state.reads.length;
    await page.waitForTimeout(350);
    expect(state.reads).toHaveLength(beforeJob);
    await expect(list(page)).toHaveCount(0);
    await page.getByLabel(/^Job \/ project/).selectOption(jobB.id);
    await description(page).click();
    await expect(list(page).getByRole("option", { name: "Other company item", exact: true })).toBeVisible();
    expect(state.reads.at(-1)).toMatchObject({ companyId: companyB.id, jobId: jobB.id });
    expect(state.bills).toEqual([]); expect(state.unexpected).toEqual([]);
  } finally { oldQuery.release(); oldJob.release(); }
});

test("removing a line discards its in-flight item list instead of applying it to the renumbered row", async ({ page }) => {
  const state = await fixture(page), pending = deferred();
  state.lookup = async read => {
    if (read.q === "removed") { await pending.promise; return { data: envelope(read, ["Removed row item"]) }; }
    return { data: envelope(read, ["Remaining row item"]) };
  };
  try {
    await scope(page);
    await page.getByRole("button", { name: "Add another line", exact: true }).click();
    await description(page).fill("removed");
    await expect.poll(() => state.reads.some(read => read.q === "removed")).toBe(true);
    await page.getByRole("button", { name: "Remove line 1", exact: true }).click();
    await expect(description(page)).toHaveValue("");
    pending.release();
    await description(page).fill("remaining");
    await expect(list(page).getByRole("option", { name: "Remaining row item", exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: "Removed row item", exact: true })).toHaveCount(0);
    await list(page).getByRole("option", { name: "Remaining row item", exact: true }).click();
    await expect(description(page)).toHaveValue("Remaining row item");
    expect(state.bills).toEqual([]); expect(state.unexpected).toEqual([]);
  } finally { pending.release(); }
});

test("mismatched or failed item lookups stay quiet, preserve manual text and can retry", async ({ page }) => {
  const state = await fixture(page);
  let mode: "mismatch" | "failed" | "empty" = "mismatch";
  state.lookup = async read => mode === "failed" ? { status: 503 } : { data: { ...envelope(read, []), ...(mode === "mismatch" ? { jobId: secondJob.id } : {}) } };
  await scope(page);
  await description(page).fill("My manually typed item");
  await expect(page.getByText("Previous items are unavailable. You can keep typing.", { exact: true })).toBeVisible();
  await expect(list(page).getByRole("option")).toHaveCount(0);
  mode = "failed";
  await page.getByRole("button", { name: "Retry item suggestions", exact: true }).click();
  await expect.poll(() => state.reads.length).toBe(2);
  await expect(page.getByText("Previous items are unavailable. You can keep typing.", { exact: true })).toBeVisible();
  mode = "empty";
  await page.getByRole("button", { name: "Retry item suggestions", exact: true }).click();
  await expect(page.getByText("No saved items match. You can keep typing.", { exact: true })).toBeVisible();
  await expect(description(page)).toHaveValue("My manually typed item");
  await description(page).press("Escape");
  await description(page).press("End");
  await description(page).press("Enter");
  await expect(description(page)).toHaveValue("My manually typed item\n");
  expect(state.bills).toEqual([]); expect(state.unexpected).toEqual([]);
});

test.describe("touch item selection", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test("the portal stays inside the mobile viewport and touch chooses only the description", async ({ page }) => {
    const state = await fixture(page);
    await scope(page);
    await page.getByLabel("Line 1 quantity").fill("7");
    await page.getByLabel("Line 1 unit price").fill("19.99");
    await description(page).fill("cab");
    const choice = list(page).getByRole("option", { name: "Cabinet installation", exact: true });
    await expect(choice).toBeVisible();
    const popup = await list(page).boundingBox();
    expect(popup && popup.x >= 0 && popup.width > 0 && popup.x + popup.width <= 390).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await choice.tap();
    await expect(description(page)).toHaveValue("Cabinet installation");
    await expect(list(page)).toHaveCount(0);
    await expect(page.getByLabel("Line 1 quantity")).toHaveValue("7");
    await expect(page.getByLabel("Line 1 unit price")).toHaveValue("19.99");
    expect(state.bills).toEqual([]); expect(state.unexpected).toEqual([]);
  });
});
