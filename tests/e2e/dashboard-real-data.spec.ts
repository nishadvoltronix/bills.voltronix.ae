import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import type { Dashboard, DashboardSearchResult, ImportedBillSummary, Job } from "../../src/components/types";
import type { IncomingSyncStatus } from "../../src/lib/incoming-sync-types";

// Authentication uses the existing local fixture account. All financial data,
// lookups and business endpoints are browser fixtures; provider calls are blocked.
const companies = [{ id: "dashboard-alpha", name: "Fictional Alpha" }, { id: "dashboard-beta", name: "Fictional Beta" }];
const jobs: Job[] = companies.map((company, index) => ({ id: `${company.id}-job`, companyId: company.id,
  companyName: company.name, jobNumber: "JOB-5383", name: `${company.name} installation`, customer: `${company.name} customer`,
  currency: index ? "USD" : "AED", contractValue: "5000.00", approvedVariations: "0.00", adjustedValue: "5000.00",
  recognizedExpenses: null, outstanding: null, paidExpenses: null, estimatedProfit: null,
  remainingBudget: null, expensePercentage: null, budgetStatus: "VALUE_UNAVAILABLE" }));
const imported: ImportedBillSummary = { id: "dashboard-imported-bill", billNumber: "INV-2468", companyId: companies[1].id,
  companyName: companies[1].name, vendorName: "Fictional supplier", currency: "USD", total: "245.67", status: "open",
  billDate: "2026-10-20", jobId: jobs[1].id, jobNumber: jobs[1].jobNumber, href: "/bills/books/dashboard-imported-bill" };
const dashboard: Dashboard = {
  currency: "AED", currencies: ["AED", "USD"],
  metrics: { jobValue: null, recordedContractValue: "10000.00", invoicedTotal: "1200.80", recognizedExpenses: "1000.00", paidExpenses: "450.25",
    outstanding: "750.55", estimatedProfit: "9000.00", overBudgetCount: 0, pendingCount: 0, readyCount: 2, draftCount: 1, billCount: 8 },
  source: { booksBillCount: 7, nativeBillCount: 2, excludedDuplicateNativeCount: 1, unlinkedBooksBillCount: 3,
    staleBooksBillCount: 0, unknownFinancialBillCount: 0, booksLatestImportAt: "2026-10-29T08:30:00Z",
    booksListingComplete: true, jobFinancialsComplete: false, crmJobCount: 3, crmReviewJobCount: 1,
    notes: ["Three imported bills have no verified job allocation."] },
  jobs, jobOptions: jobs.map(({ id, companyId, jobNumber, name }) => ({ id, companyId, jobNumber, name })),
  recentBills: [], recentBooksBills: [imported], monthlyExpenses: [], vendorExpenses: [],
};
const searchResult = (query: string): DashboardSearchResult => ({ query,
  jobs: jobs.map(job => ({ id: job.id, canonicalJobId: job.id, jobNumber: job.jobNumber, name: job.name,
    companyId: job.companyId, companyName: job.companyName!, customer: job.customer, currency: job.currency,
    canCreateBill: true, href: `/jobs/${job.id}` })),
  bills: [{ ...imported, source: "BOOKS" }], hasMore: false });
const incoming: IncomingSyncStatus = { generatedAt: "2026-10-29T12:00:00Z", enabled: true, workerAlive: true,
  lastHeartbeatAt: "2026-10-29T11:59:55Z", pollIntervalSeconds: 5, sources: [
    { id: "incoming-alpha", kind: "BOOKS", companyId: companies[0].id, companyName: companies[0].name,
      status: "WAITING_QUOTA", lastSuccessAt: "2026-10-29T10:00:00Z", nextRunAt: "2026-10-29T20:02:01Z",
      backoffUntil: "2026-10-29T20:02:01Z", isStale: true, message: "Zoho quota has paused this source.", processedCount: 12 },
    { id: "incoming-beta", kind: "CRM", companyId: null, companyName: companies[1].name,
      status: "PENDING", lastSuccessAt: null, nextRunAt: "2026-10-29T12:05:00Z", backoffUntil: null,
      isStale: true, message: "The first automatic check is pending.", processedCount: null },
  ] };
const metric = (page: Page, label: string) => page.locator(".metric-card").filter({ has: page.getByText(label, { exact: true }) }).locator(".metric-value");
const searchField = (page: Page) => page.getByRole("textbox", { name: "Job ID, bill number or job name", exact: true });
async function find(page: Page, query: string) {
  await searchField(page).fill(query);
  await page.getByRole("search", { name: "Find a job or bill" }).getByRole("button", { name: "Search", exact: true }).click();
}

test.beforeEach(async ({ page, baseURL }) => {
  const email = process.env.SEED_ADMIN_EMAIL, password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password || !baseURL) throw new Error("Local fixture account credentials and origin are required.");
  expect((await page.request.post(`${baseURL}/api/auth/login`, { headers: { Origin: baseURL }, data: { email, password } })).status()).toBe(200);
  await page.route("**/api/**", route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (request.method() !== "GET") return route.fulfill({ status: 422, json: { error: "Business writes are disabled in this browser fixture." } });
    if (path === "/api/dashboard") return route.fulfill({ json: dashboard });
    if (path === "/api/dashboard/search") return route.fulfill({ json: searchResult(url.searchParams.get("q") || "") });
    if (path === "/api/companies") return route.fulfill({ json: { companies } });
    if (path === "/api/jobs") return route.fulfill({ json: { jobs } });
    if (path === "/api/bills/books") return route.fulfill({ json: { bills: [], runs: [], total: 0, page: 1, pageSize: 50,
      filters: { statuses: [], currencies: [] } } });
    const job = jobs.find(row => path === `/api/jobs/${row.id}`);
    if (job) return route.fulfill({ json: { job, bills: [], booksBills: job.id === imported.jobId ? [imported] : [],
      financialCompleteness: { complete: false, unlinkedBooksBillCount: 3, notes: ["Imported invoices remain unallocated for this company."] } } });
    if (path === "/api/integrations") return route.fulfill({ json: { zoho: { organizations: [] } } });
    if (path === "/api/integrations/incoming-status") return route.fulfill({ json: { ...incoming, enabled: false, workerAlive: false, sources: [] } });
    if (path === "/api/bills/options") return route.fulfill({ json: { companyId: url.searchParams.get("companyId"), organizationId: null,
      dataCenter: null, environment: null, accounts: [], taxes: [], customers: [], warning: null, hasMoreCustomers: false } });
    if (path === "/api/operations") return route.fulfill({ json: { ocrReview: 0, ocrFailed: 0, ocrQueued: 0,
      syncFailures: 0, syncUnknown: 0, duplicateWarnings: 0, duplicateScanTruncated: false } });
    return route.fulfill({ status: 404, json: { error: "Unexpected fixture request." } });
  });
});
test.beforeAll(async () => { await mkdir(".local/screenshots", { recursive: true }); });
test.afterEach(async ({ page, baseURL }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  if (baseURL) await page.request.post(`${baseURL}/api/auth/logout`, { headers: { Origin: baseURL } });
});

test("silent incoming refresh polls every five seconds while visible and recovers after a failed poll", async ({ page }) => {
  await page.clock.install();
  let statusReads = 0, dashboardReads = 0, fail = false;
  let lastSuccessAt = "2026-10-29T10:00:00Z";
  await page.route("**/api/dashboard?*", route => { dashboardReads++; return route.fulfill({ json: dashboard }); });
  await page.route("**/api/integrations/incoming-status*", route => {
    statusReads++;
    if (fail) return route.fulfill({ status: 503, json: { error: "Status temporarily unavailable." } });
    return route.fulfill({ json: { ...incoming, sources: [{ ...incoming.sources[0], status: "IDLE", isStale: false,
      backoffUntil: null, lastSuccessAt, message: "The latest source check completed." }] } });
  });
  await page.goto("/dashboard");
  await expect.poll(() => dashboardReads).toBe(1);
  await expect.poll(() => statusReads).toBe(1);
  await expect(metric(page, "Recorded invoice total")).toHaveText("AED 1,200.80");
  await expect(page.getByLabel("Incoming Zoho updates", { exact: true })).toHaveCount(0);
  lastSuccessAt = "2026-10-29T12:01:00Z";
  await page.clock.fastForward(5_000);
  await expect.poll(() => statusReads).toBe(2);
  await expect.poll(() => dashboardReads).toBe(2);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.fastForward(10_000);
  expect(statusReads).toBe(2);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => statusReads).toBe(3);
  expect(dashboardReads).toBe(2);
  fail = true;
  const failedPoll = page.waitForResponse(response => new URL(response.url()).pathname === "/api/integrations/incoming-status" && response.status() === 503);
  await page.clock.fastForward(5_000);
  await failedPoll;
  await expect.poll(() => statusReads).toBe(4);
  await expect(metric(page, "Recorded invoice total")).toHaveText("AED 1,200.80");
  expect(dashboardReads).toBe(2);
  fail = false;
  lastSuccessAt = "2026-10-29T12:02:00Z";
  await page.clock.fastForward(5_000);
  await expect.poll(() => statusReads).toBe(5);
  await expect.poll(() => dashboardReads).toBe(3);
  await expect(metric(page, "Recorded invoice total")).toHaveText("AED 1,200.80");
  await expect(page.getByLabel("Incoming Zoho updates", { exact: true })).toHaveCount(0);
});

test("dashboard displays imported totals while withholding incomplete profit", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(metric(page, "Recorded contract value")).toHaveText("AED 10,000.00");
  await expect(metric(page, "Recorded invoice total")).toHaveText("AED 1,200.80");
  await expect(metric(page, "Recorded payments")).toHaveText("AED 450.25");
  await expect(metric(page, "Outstanding bills")).toHaveText("AED 750.55");
  await expect(metric(page, "Estimated job profit")).toHaveText("—");
  await expect(page.getByText("Historical job costs are incomplete", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Financial data sources")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Recent Zoho Books bills" })).toBeVisible();
  await expect(page.getByRole("link", { name: imported.billNumber, exact: true })).toHaveAttribute("href", imported.href);
  await expect(page.getByText("Figures below cover bills entered in this app.", { exact: false })).toHaveCount(0);
  await page.screenshot({ path: ".local/screenshots/dashboard-fixture-desktop.png", fullPage: true, animations: "disabled" });
});

test("job reference search preserves company choice and opens its Books bills and prefilled entry", async ({ page }) => {
  const reads: string[] = [], posts: string[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname === "/api/dashboard/search") reads.push(url.search);
    if (url.pathname.startsWith("/api/") && request.method() === "POST") posts.push(url.pathname);
  });
  await page.goto("/dashboard");
  expect(reads).toEqual([]);
  await find(page, "5383");
  const results = page.getByRole("region", { name: "Matching jobs" });
  await expect(results).toContainText(companies[0].name);
  await expect(results).toContainText(companies[1].name);
  expect(reads).toEqual(["?q=5383"]);
  await page.getByRole("link", { name: `View job JOB-5383 for ${companies[1].name}`, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/jobs/${jobs[1].id}$`));
  await expect(page.getByRole("heading", { name: jobs[1].name, exact: true })).toBeVisible();
  await expect(metric(page, "Recognized expenses")).toHaveText("—");
  await expect(metric(page, "Estimated profit / loss")).toHaveText("—");
  await expect(page.getByRole("heading", { name: "Linked Zoho Books bills", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: imported.billNumber, exact: true })).toHaveAttribute("href", imported.href);
  await page.getByRole("link", { name: "Review this company's Books bills", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/bills/books\\?companyId=${companies[1].id}$`));
  await expect(page.getByRole("combobox", { name: "Company", exact: true })).toHaveValue(companies[1].id);
  await page.goto(`/jobs/${jobs[1].id}`);
  await page.getByRole("link", { name: "Add bill", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Company", exact: true })).toHaveValue(companies[1].id);
  await expect(page.getByLabel(/^Job \/ project/)).toHaveValue(jobs[1].id);
  await expect(page.getByLabel("Currency", { exact: true })).toHaveValue("USD");
  expect(posts).toEqual([]);
});

test("recorded zero contract values remain zero while missing payment evidence remains unavailable", async ({ page }) => {
  await page.route("**/api/dashboard?*", route => route.fulfill({ json: { ...dashboard,
    metrics: { ...dashboard.metrics, recordedContractValue: "0.00", jobValue: null, paidExpenses: null, recognizedExpenses: null } } }));
  await page.goto("/dashboard");
  await expect(metric(page, "Recorded contract value")).toHaveText("AED 0.00");
  await expect(metric(page, "Recorded payments")).toHaveText("—");
  await expect(metric(page, "Recognized expenses")).toHaveText("—");
  await expect(metric(page, "Recorded invoice total")).toHaveText("AED 1,200.80");
  await expect(metric(page, "Estimated job profit")).toHaveText("—");
});

test("dashboard filters reuse slim job options and retain every option after selecting one job", async ({ page }) => {
  const options = jobs.map(job => ({ ...job, currency: "AED" }));
  const requests: URLSearchParams[] = [];
  let extraJobRequests = 0;
  await page.route(/\/api\/jobs(?:\?.*)?$/, route => {
    extraJobRequests++;
    return route.fulfill({ status: 500, json: { error: "Dashboard filters must use their existing response." } });
  });
  await page.route("**/api/dashboard?*", route => {
    const params = new URL(route.request().url()).searchParams;
    requests.push(params);
    const available = options.filter(job => job.currency === params.get("currency") &&
      (!params.get("companyId") || job.companyId === params.get("companyId")));
    return route.fulfill({ json: { ...dashboard, currency: params.get("currency"),
      jobs: available.filter(job => !params.get("jobId") || job.id === params.get("jobId")),
      jobOptions: available.map(({ id, companyId, jobNumber, name }) => ({ id, companyId, jobNumber, name })) } });
  });
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  const job = page.getByRole("combobox", { name: "Job", exact: true });
  await expect(job.locator("option")).toHaveCount(3);
  await job.selectOption(jobs[0].id);
  await expect.poll(() => requests.at(-1)?.get("jobId")).toBe(jobs[0].id);
  await expect(job).toBeEnabled();
  await expect(job.locator("option")).toHaveCount(3);
  await expect(job.locator(`option[value="${jobs[1].id}"]`)).toHaveCount(1);
  await job.selectOption(jobs[1].id);
  await expect.poll(() => requests.at(-1)?.get("jobId")).toBe(jobs[1].id);
  await expect(job).toBeEnabled();
  await expect(job).toHaveValue(jobs[1].id);
  await page.getByRole("combobox", { name: "Currency", exact: true }).selectOption("USD");
  await expect.poll(() => requests.at(-1)?.get("currency")).toBe("USD");
  expect(requests.at(-1)?.has("jobId")).toBe(false);
  await expect(job).toHaveValue("");
  expect(extraJobRequests).toBe(0);
});

test("a company filter rejects mismatched search results and clears prior company navigation", async ({ page }) => {
  let correct = false;
  await page.route("**/api/dashboard/search?*", route => {
    const params = new URL(route.request().url()).searchParams;
    const result = searchResult(params.get("q")!);
    return route.fulfill({ json: correct ? { ...result,
      jobs: result.jobs.filter(job => job.companyId === params.get("companyId")), bills: [] } : result });
  });
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  const company = page.getByRole("combobox", { name: "Company", exact: true });
  await company.selectOption(companies[0].id);
  await find(page, "5383");
  await expect(page.getByText("Search results did not match your selection. Search again.", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Matching jobs" })).toHaveCount(0);
  correct = true;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("link", { name: `View job JOB-5383 for ${companies[0].name}`, exact: true })).toBeVisible();
  await company.selectOption(companies[1].id);
  await expect(page.getByRole("region", { name: "Matching jobs" })).toHaveCount(0);
  await page.getByRole("search").getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("link", { name: `View job JOB-5383 for ${companies[1].name}`, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: `View job JOB-5383 for ${companies[0].name}`, exact: true })).toHaveCount(0);
});

test("bill number search is mobile usable and changing the query discards a late prior response", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let release!: () => void;
  let waiting = false;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/dashboard/search?*", async route => {
    const query = new URL(route.request().url()).searchParams.get("q")!;
    if (query === "slow") { waiting = true; await pending; }
    return route.fulfill({ json: query === "slow" ? searchResult(query) : { query, jobs: [], bills: searchResult(query).bills, hasMore: false } }).catch(() => undefined);
  });
  try {
    await page.goto("/dashboard");
    await expect(searchField(page)).toBeVisible();
    await find(page, "slow");
    await expect.poll(() => waiting).toBe(true);
    await searchField(page).fill("INV-2468");
    await page.getByRole("search").getByRole("button", { name: "Search", exact: true }).click();
    const bill = page.getByRole("link", { name: `View bill INV-2468 for ${companies[1].name}`, exact: true });
    await expect(bill).toBeVisible();
    await expect(bill).toHaveAttribute("href", imported.href);
    await expect(page.getByRole("region", { name: "Matching bills" })).toContainText("USD 245.67");
    await expect(page.getByRole("link", { name: `View job history JOB-5383 for bill INV-2468 in ${companies[1].name}`, exact: true }))
      .toHaveAttribute("href", `/jobs/${jobs[1].id}`);
    release();
    await expect(page.getByRole("region", { name: "Matching jobs" })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: ".local/screenshots/dashboard-search-fixture-mobile.png", fullPage: true, animations: "disabled" });
    await page.getByRole("button", { name: "Clear job and bill search", exact: true }).click();
    await expect(searchField(page)).toHaveValue("");
    await expect(page.getByRole("region", { name: "Matching bills" })).toHaveCount(0);
  } finally { release(); }
});

test("dashboard job-name search exposes every related history and rejects a cross-company association", async ({ page }) => {
  const query = jobs[1].name;
  const related = [{ id: jobs[1].id, jobNumber: jobs[1].jobNumber, name: jobs[1].name,
    companyId: companies[1].id, companyName: companies[1].name }, { id: "dashboard-second-project", jobNumber: "JOB-5384",
    name: "Second fictional project", companyId: companies[1].id, companyName: companies[1].name }];
  let invalid = true;
  await page.route("**/api/dashboard/search?*", route => route.fulfill({ json: {
    ...searchResult(query), bills: [{ ...searchResult(query).bills[0], jobId: null, jobNumber: null,
      relatedJobs: invalid ? [{ ...related[0], companyId: companies[0].id }] : related }] } }));
  await page.goto("/dashboard");
  await find(page, query);
  await expect(page.getByText("Search results did not match your selection. Search again.", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Matching bills", exact: true })).toHaveCount(0);
  invalid = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  const bills = page.getByRole("region", { name: "Matching bills", exact: true });
  await expect(bills.getByRole("link", { name: /^View job history / })).toHaveCount(2);
  await expect(bills.getByRole("link", { name: `View job history JOB-5384 for bill ${imported.billNumber} in ${companies[1].name}`, exact: true }))
    .toHaveAttribute("href", "/jobs/dashboard-second-project");
  await expect(page).toHaveURL(/\/dashboard$/);
});

test("search and summary failures show unavailable data without inventing zero balances", async ({ page }) => {
  let searches = 0;
  await page.route("**/api/dashboard?*", route => route.fulfill({ status: 503, json: { error: "Fictional financial summary unavailable." } }));
  await page.route("**/api/dashboard/search?*", route => ++searches === 1
    ? route.fulfill({ status: 503, json: { error: "Fictional reference search unavailable." } })
    : route.fulfill({ json: searchResult("5383") }));
  await page.goto("/dashboard");
  await expect(page.getByText("Fictional financial summary unavailable.", { exact: true })).toBeVisible();
  await expect(page.locator(".metric-value")).toHaveCount(0);
  await find(page, "5383");
  await expect(page.getByText("Fictional reference search unavailable.", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Matching jobs" })).toHaveCount(0);
  const retry = page.getByText("Fictional reference search unavailable.", { exact: true }).locator("..", {}).locator("..").getByRole("button", { name: "Retry", exact: true });
  await retry.click();
  await expect(page.getByRole("region", { name: "Matching jobs" })).toBeVisible();
  expect(searches).toBe(2);
});

test("an unassigned CRM job is searchable for its authorized administrator without enabling bill entry", async ({ page }) => {
  const id = "dashboard-crm-unbound";
  await page.route(`**/api/jobs/crm/${id}`, route => route.fulfill({ json: { job: { id,
    companyId: null, companyName: null, externalCrmId: "99005383", jobNumber: "JOB-5383",
    name: "Fictional CRM review required", customerName: "Fictional CRM customer", currencyCode: "USD",
    amount: null, approvedVariations: null, stage: "Closed Lost", canonicalJobId: null, linkStatus: "CONFLICT",
    sourceModifiedAt: null, lastSeenAt: "2026-10-29T08:30:00Z", isStale: false } } }));
  await page.route("**/api/dashboard/search?*", route => route.fulfill({ json: { query: "5383", jobs: [{ id,
    canonicalJobId: null, jobNumber: "JOB-5383", name: "Fictional CRM review required", companyId: null,
    companyName: "Unassigned company", customer: "Fictional CRM customer", currency: "USD",
    canCreateBill: false, href: `/jobs/crm/${id}` }], bills: [], hasMore: false } }));
  await page.goto("/dashboard");
  await find(page, "5383");
  await expect(page.getByRole("region", { name: "Matching jobs" })).toContainText("Unassigned company");
  await expect(page.getByRole("link", { name: "Add bill to JOB-5383 for Unassigned company", exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "View job JOB-5383 for Unassigned company", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Fictional CRM review required", exact: true })).toBeVisible();
  await expect(page.getByText("Closed Lost", { exact: true })).toBeVisible();
  await expect(metric(page, "CRM contract value")).toHaveText("—");
  await expect(metric(page, "Approved variations")).toHaveText("—");
  await expect(page.getByRole("link", { name: "Add bill", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Open billing profile", exact: true })).toHaveCount(0);
});
