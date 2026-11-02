import { expect, test, type Page } from "@playwright/test";

// Only authentication uses the existing LOCAL accounts test user. Every business
// response below is fictional; no provider call or financial mutation is allowed.
const company = { id: "restricted-alpha", name: "Fictional Restricted Company Alpha" };
const jobId = "restricted-job";
const crmId = "restricted-crm-snapshot";
const secretAmount = "987654.32";
const unexpectedBusinessRequests = new WeakMap<Page, string[]>();
const importedBill = {
  id: "restricted-books-bill", billNumber: "FICTIONAL-BOOKS-HISTORY", companyId: company.id,
  companyName: company.name, vendorName: "Fictional Books Supplier", currency: "AED", total: "210.00",
  status: "open", billDate: "2026-11-02", jobId, jobNumber: "TEST-JOB-RESTRICTED",
  href: "/bills/books/restricted-books-bill", documents: [], attachmentStatus: "NONE",
};
const job = {
  id: jobId, companyId: company.id, companyName: company.name, jobNumber: "TEST-JOB-RESTRICTED",
  name: "Fictional restricted project", customer: "Fictional customer", currency: "AED",
  contractValue: secretAmount, approvedVariations: "123456.78",
  summary: { adjustedValue: secretAmount, recognizedExpenses: "66666.66", paidExpenses: "55555.55",
    outstanding: "77777.77", estimatedProfit: "44444.44", remainingBudget: "33333.33",
    expensePercentage: "88.88", budgetStatus: "OVER_BUDGET" },
};
const nativeBill = {
  id: "restricted-native-bill", companyId: company.id, vendorId: "restricted-vendor", jobId,
  invoiceNumber: "FICTIONAL-WORKSPACE-HISTORY", invoiceDate: "2026-11-02", category: "MATERIALS",
  currency: "AED", status: "READY", version: 1, subtotal: "100.00", discount: "0.00", vatRate: "5.00",
  vatAmount: "5.00", total: "105.00", paidAmount: "0.00", createdAt: "2026-11-02T08:00:00Z",
  vendor: { id: "restricted-vendor", name: "Fictional Workspace Supplier" },
  job: { id: jobId, jobNumber: job.jobNumber, name: job.name }, lines: [], documents: [], payments: [], syncRecords: [],
};
const crmJob = {
  id: crmId, companyId: company.id, companyName: company.name, jobNumber: job.jobNumber,
  name: "Fictional CRM history project", customerName: job.customer, currencyCode: "AED",
  amount: secretAmount, approvedVariations: "123456.78", externalCrmId: "910010001",
  canonicalJobId: jobId, stage: "Fictional stage", linkStatus: "READY", isStale: false,
  lastSeenAt: "2026-11-02T08:00:00Z", sourceModifiedAt: "2026-11-02T08:00:00Z",
  historyCompanies: [company], booksBills: [importedBill], historyWarnings: [],
};

async function mockBusiness(page: Page) {
  const unexpected: string[] = [];
  unexpectedBusinessRequests.set(page, unexpected);
  await page.route("**/api/**", route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/auth/")) return route.continue();
    if (request.method() !== "GET") {
      unexpected.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 409, json: { error: "Fictional screen check: business writes are disabled." } });
    }
    if (url.pathname === "/api/companies") return route.fulfill({ json: { companies: [company] } });
    if (url.pathname === `/api/jobs/${jobId}`) return route.fulfill({ json: {
      job, bills: [nativeBill], booksBills: [importedBill],
      booksHistory: { verificationPending: false, warnings: [], refreshPausedUntil: null },
      financialCompleteness: { complete: false, unlinkedBooksBillCount: 7, notes: ["Fictional financial completeness notice"] },
    } });
    if (url.pathname === `/api/jobs/crm/${crmId}`) return route.fulfill({ json: { job: crmJob } });
    if (url.pathname === "/api/dashboard/search") return route.fulfill({ json: {
      query: url.searchParams.get("q"), hasMore: false,
      jobs: [{ ...job, canonicalJobId: jobId, href: `/jobs/${jobId}`, canCreateBill: true }],
      bills: [{ ...importedBill, source: "BOOKS" }],
    } });
    if (url.pathname === "/api/jobs/search") return route.fulfill({ json: {
      companyId: null, warning: null, hasMore: false, jobs: [{ ...job,
        externalCrmId: "910010001", crmOrganizationId: "910010002", booksOrganizationId: "910010003",
        sourceId: "fictional-source", dataCenter: "US", environment: "production", stage: "Fictional stage",
      }],
    } });
    unexpected.push(`GET ${url.pathname}`);
    return route.fulfill({ status: 404, json: { error: "No fictional response is configured." } });
  });
}

async function login(page: Page, returnPath = "/dashboard") {
  const email = process.env.SEED_ACCOUNTS_EMAIL;
  const password = process.env.SEED_ACCOUNTS_PASSWORD;
  if (!email || !password) throw new Error("The existing LOCAL accounts test credentials are required.");
  await page.goto(`/login?${new URLSearchParams({ next: returnPath })}`);
  await page.getByLabel("Work email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: /Login.*Sign in to workspace/ }).click();
  await expect(page).toHaveURL(/\/bills\/manual$/);
}

test.beforeEach(async ({ page, baseURL }) => {
  if (baseURL !== "http://127.0.0.1:3000") throw new Error("Restricted UI checks require the LOCAL development app.");
  await mockBusiness(page);
});

test.afterEach(async ({ page, baseURL }) => {
  if (baseURL === "http://127.0.0.1:3000")
    await page.request.post(`${baseURL}/api/auth/logout`, { headers: { Origin: baseURL } });
  expect(unexpectedBusinessRequests.get(page) ?? []).toEqual([]);
});

test("accounts lands at bill entry with only its four navigation items and scoped search", async ({ page }) => {
  await login(page);
  await expect(page.getByRole("heading", { name: "Manual bill entry", exact: true })).toBeVisible();
  const nav = page.getByRole("navigation");
  await expect(nav.getByRole("link")).toHaveText(["Bill entry", "Bills", "Vendors", "Account security"]);
  await expect(nav.getByRole("link", { name: /Overview|Zoho Books|Jobs|Management|Audit|OCR|Batch/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Voltronix workspace", exact: true })).toHaveAttribute("href", "/bills/manual");
  await page.getByLabel(/^Job ID, bill number or job name/).fill("TEST-JOB");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("link", { name: `View job history ${job.jobNumber} for ${company.name}`, exact: true })).toBeVisible();
  await expect(page.getByText(importedBill.billNumber, { exact: true })).toBeVisible();
  await expect(page.getByText("AED 210.00", { exact: true })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Contract value", exact: true })).toHaveCount(0);
  await expect(page.getByText(/987,654\.32|987654\.32/)).toHaveCount(0);
});

test("accounts job history keeps individual bills and entry without aggregate job metrics", async ({ page }) => {
  await login(page);
  await page.goto(`/jobs/${jobId}`);
  await expect(page.getByRole("heading", { name: job.name, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to bill entry", exact: true })).toHaveAttribute("href", "/bills/manual");
  await expect(page.getByRole("link", { name: "Add bill", exact: true })).toHaveAttribute("href", `/bills/new?jobId=${jobId}`);
  await expect(page.getByText(nativeBill.invoiceNumber, { exact: true })).toBeVisible();
  await expect(page.getByText(importedBill.billNumber, { exact: true })).toBeVisible();
  await expect(page.getByText("AED 105.00", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("AED 210.00", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Recorded contract value|Recognized expenses|Estimated profit|Remaining budget|Approved variations|Adjusted job value|Over budget:/i)).toHaveCount(0);
  await expect(page.getByText("Fictional financial completeness notice", { exact: true })).toHaveCount(0);
});

test("accounts CRM history keeps invoice amounts without contract and variation cards", async ({ page }) => {
  await login(page);
  await page.goto(`/jobs/crm/${crmId}`);
  await expect(page.getByRole("heading", { name: crmJob.name, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to bill entry", exact: true })).toHaveAttribute("href", "/bills/manual");
  await expect(page.getByRole("link", { name: "Open billing profile", exact: true })).toHaveAttribute("href", `/jobs/${jobId}`);
  await expect(page.getByText(importedBill.billNumber, { exact: true })).toBeVisible();
  await expect(page.getByText("AED 210.00", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/CRM contract value|CRM deal amount|Approved variations|Invoice costs and profit/)).toHaveCount(0);
  await expect(page.getByText(/987,654\.32|987654\.32/)).toHaveCount(0);
});
