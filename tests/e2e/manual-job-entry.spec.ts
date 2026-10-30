import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import type { Bill, Dashboard, DashboardSearchResult, ImportedBillSummary, Job, JobSummary } from "../../src/components/types";

// Only authentication uses the existing local seed. Every job, bill and summary
// shown below is fictional; every browser POST is intercepted before any write.
const companyA = "manual-job-company-alpha";
const companyB = "manual-job-company-beta";
const reference = "FICTIONAL-SHARED-2026";
const companies = [{ id: companyA, name: "Fictional Company Alpha" }, { id: companyB, name: "Fictional Company Beta" }];
const jobA: Job = { id: "manual-job-local-alpha", companyId: companyA, jobNumber: "FICTIONAL-ALPHA-2026", name: "Fictional Alpha Installation",
  customer: "Fictional Alpha Customer", currency: "AED", contractValue: "1000.00", approvedVariations: "0.00" };
const jobB: Job = { ...jobA, id: "manual-job-local-beta", companyId: companyB, jobNumber: "FICTIONAL-BETA-2026", name: "Fictional Beta Installation",
  customer: "Fictional Beta Customer", currency: "USD" };
type CrmMatch = Omit<Job, "id"> & { id: string | null; externalCrmId: string; stage: string | null;
  crmOrganizationId: string; dataCenter: string; environment: "production" | "sandbox"; booksOrganizationId: string; sourceId: string };
const crmA: CrmMatch = { ...jobA, id: null, externalCrmId: "980000000001", stage: "Fictional proposed",
  crmOrganizationId: "981000000001", dataCenter: "US", environment: "production", booksOrganizationId: "982000000001", sourceId: "a".repeat(64) };
const crmB: CrmMatch = { ...jobB, id: null, externalCrmId: "980000000002", stage: "Fictional confirmed",
  crmOrganizationId: "981000000002", dataCenter: "US", environment: "production", booksOrganizationId: "982000000002", sourceId: "b".repeat(64) };
const crmEnvelope = (jobs: CrmMatch[] = [], warning: string | null = null) => ({ companyId: null, jobs, warning, hasMore: false });
const crmAction = (page: Page, match: CrmMatch) => page.getByRole("button", {
  name: `Use CRM job ${match.jobNumber} for ${companies.find((company) => company.id === match.companyId)!.name}`, exact: true,
});
const resolveBody = (match: CrmMatch) => ({ companyId: match.companyId, externalCrmId: match.externalCrmId, sourceId: match.sourceId,
  crmOrganizationId: match.crmOrganizationId, dataCenter: match.dataCenter, environment: match.environment, booksOrganizationId: match.booksOrganizationId });
const resolvedJob = (match: CrmMatch) => ({ ...(match.companyId === companyA ? jobA : jobB), externalCrmId: match.externalCrmId });
const queryInput = (page: Page) => page.getByRole("textbox", { name: "Job ID, bill number or job name", exact: true });
const jobLink = (page: Page, job: Job) => page.getByRole("link", {
  name: `View job history ${job.jobNumber} for ${companies.find((company) => company.id === job.companyId)!.name}`, exact: true,
});
function searchEnvelope(query: string, jobs: Job[], bills: DashboardSearchResult["bills"] = []): DashboardSearchResult {
  return { query, jobs: jobs.map(job => ({ id: job.id, canonicalJobId: job.id, companyId: job.companyId,
    companyName: companies.find(company => company.id === job.companyId)?.name || "Unknown company", jobNumber: job.jobNumber,
    name: job.name, customer: job.customer, currency: job.currency, canCreateBill: true, href: `/jobs/${job.id}` })), bills, hasMore: false };
}
const billMatch = (job: Job, billNumber: string): DashboardSearchResult["bills"][number] => ({ id: `books-${job.id}`,
  billNumber, source: "BOOKS", companyId: job.companyId, companyName: companies.find(company => company.id === job.companyId)!.name,
  vendorName: "Fictional original supplier", currency: job.currency, total: "105.00", jobId: job.id, jobNumber: job.jobNumber,
  href: `/bills/books/books-${job.id}`, relatedJobs: [{ id: job.id, jobNumber: job.jobNumber, name: job.name,
    companyId: job.companyId, companyName: companies.find(company => company.id === job.companyId)!.name }] });
const metric = (page: Page, label: string) => page.locator(".metric-card").filter({ has: page.getByText(label, { exact: true }) }).locator(".metric-value");
type Phase = "draft" | "ready" | "paid" | "cancelled";
function bill(job: Job, id: string, status: string, net: number, paidAmount = 0): Bill {
  return { id, companyId: job.companyId, jobId: job.id, vendorId: "manual-fictional-vendor", invoiceNumber: id,
    invoiceDate: "2026-10-29", createdAt: "2026-10-29T08:00:00Z", category: "MATERIALS", currency: job.currency,
    status, paymentStatus: paidAmount ? "PARTIALLY_PAID" : "UNPAID", version: 1, discount: "0.00", vatRate: "5.00",
    subtotal: net.toFixed(2), vatAmount: (net * 0.05).toFixed(2), total: (net * 1.05).toFixed(2), paidAmount: paidAmount.toFixed(2),
    lines: [{ description: "Fictional recorded cost", quantity: "1", unitPrice: net.toFixed(2) }],
    vendor: { id: "manual-fictional-vendor", companyId: job.companyId, name: "Fictional job supplier", currency: job.currency }, job };
}
function detail(job: Job, phase: Phase = "ready") {
  const recognized = phase === "draft" ? 0 : phase === "ready" ? 100 : phase === "paid" ? 300 : 200;
  const outstanding = phase === "draft" ? 0 : phase === "ready" ? 105 : phase === "paid" ? 265 : 160;
  const paid = phase === "paid" || phase === "cancelled" ? 50 : 0;
  const summary: JobSummary = { adjustedValue: "1000.00", recognizedExpenses: recognized.toFixed(2), paidExpenses: paid.toFixed(2),
    outstanding: outstanding.toFixed(2), estimatedProfit: (1000 - recognized).toFixed(2), remainingBudget: (1000 - recognized).toFixed(2),
    expensePercentage: (recognized / 10).toFixed(2), budgetStatus: "WITHIN_BUDGET" };
  const bills = [bill(job, "FICTIONAL-DRAFT-500", "DRAFT", 500)];
  if (phase !== "draft") bills.push(bill(job, "FICTIONAL-COST-100", phase === "cancelled" ? "CANCELLED" : "READY", 100));
  if (paid) bills.push(bill(job, "FICTIONAL-PAID-200", "APPROVED", 200, paid));
  return { job: { ...job, summary }, bills };
}
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
async function find(page: Page, text = jobA.jobNumber) {
  await queryInput(page).fill(text);
  await page.getByRole("button", { name: "Search", exact: true }).click();
}
async function openManual(page: Page) {
  await page.goto("/bills/manual");
  await expect(page.getByRole("heading", { name: "Manual bill entry", exact: true })).toBeVisible();
}

test.beforeAll(async () => { await mkdir(".local/screenshots", { recursive: true }); });
test.beforeEach(async ({ page, baseURL }) => {
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password || !baseURL) throw new Error("Local fictional seed credentials and browser origin are required.");
  expect((await page.request.post(`${baseURL}/api/auth/login`, { headers: { Origin: baseURL }, data: { email, password } })).status()).toBe(200);
  await page.route("**/api/**", (route) => route.fulfill({ status: 422, json: { error: "Unexpected fixture request; no data was changed." } }));
  await page.route("**/api/companies", (route) => route.fulfill({ json: { companies } }));
  await page.route("**/api/dashboard/search?*", route => {
    const query = new URL(route.request().url()).searchParams.get("q") || "";
    return route.fulfill({ json: searchEnvelope(query, [jobA, jobB].filter(job =>
      `${job.jobNumber} ${job.name} ${job.customer}`.toLowerCase().includes(query.toLowerCase()))) });
  });
  await page.route(/\/api\/jobs(?:\?.*)?$/, (route) => {
    expect(route.request().method()).toBe("GET");
    const params = new URL(route.request().url()).searchParams;
    const q = params.get("q")?.toLowerCase() ?? "";
    return route.fulfill({ json: { jobs: [jobA, jobB].filter((job) => (!params.get("companyId") || job.companyId === params.get("companyId")) &&
      `${job.jobNumber} ${job.name} ${job.customer}`.toLowerCase().includes(q)) } });
  });
  await page.route(/\/api\/jobs\/[^/?]+$/, (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1);
    const job = [jobA, jobB].find((candidate) => candidate.id === id);
    return job ? route.fulfill({ json: detail(job) }) : route.fulfill({ status: 404, json: { error: "Fictional job not found." } });
  });
  await page.route("**/api/jobs/search?*", (route) => route.fulfill({ json: crmEnvelope() }));
  await page.route("**/api/integrations", (route) => route.fulfill({ json: { zoho: { organizations: [] } } }));
  await page.route("**/api/bills/options?*", (route) => route.fulfill({ json: {
    companyId: new URL(route.request().url()).searchParams.get("companyId"), organizationId: null, dataCenter: null, environment: null,
    accounts: [], taxes: [], customers: [], hasMoreCustomers: false, warning: null,
  } }));
  await page.route("**/api/vendors/search?*", (route) => route.fulfill({ json: {
    companyId: new URL(route.request().url()).searchParams.get("companyId"), organizationId: null, vendors: [], selectedVendor: null, hasMore: false, warning: null,
  } }));
  await page.route("**/api/vendors", (route) => route.fulfill({ json: { vendors: [] } }));
  const dashboard: Dashboard = { currency: "AED", jobs: [], recentBills: [], monthlyExpenses: [], vendorExpenses: [],
    metrics: { jobValue: "0.00", recognizedExpenses: "0.00", paidExpenses: "0.00", outstanding: "0.00", estimatedProfit: "0.00",
      overBudgetCount: 0, pendingCount: 0, readyCount: 0, draftCount: 0 } };
  await page.route("**/api/dashboard?*", (route) => route.fulfill({ json: dashboard }));
  await page.route("**/api/reports/bills?*", (route) => route.fulfill({ json: { count: 0, previewLimit: 100, rows: [],
    totals: { invoiced: "0.00", recognized: "0.00", paid: "0.00", outstanding: "0.00" } } }));
  await page.route("**/api/operations", (route) => route.fulfill({ json: { ocrReview: 0, ocrFailed: 0, ocrQueued: 0,
    syncFailures: 0, syncUnknown: 0, duplicateWarnings: 0, duplicateScanTruncated: false } }));
});
test.afterEach(async ({ page, baseURL }) => {
  if (baseURL) await page.request.post(`${baseURL}/api/auth/logout`, { headers: { Origin: baseURL } });
});

test("bill-number search opens exact job history with all native and Books original actions", async ({ page }) => {
  const match = billMatch(jobA, "FICTIONAL-HISTORY-2026");
  const imported: ImportedBillSummary = { ...match, total: "105.00", status: "open", billDate: "2026-10-29",
    relationEvidence: "Verified workspace bill synchronization", allocationKnown: false, attachmentStatus: "PARTIAL",
    attachmentCount: 3, downloadedAttachmentCount: 2, hasAttachment: true, documents: [
      { id: "source-one", name: "Source invoice.pdf", attachmentId: "stored-one", downloaded: true, status: "AVAILABLE",
        fileName: "Source invoice.pdf", mimeType: "application/pdf", byteSize: 48, downloadedAt: "2026-10-30T06:00:00Z" },
      { id: "source-two", name: "Delivery note.png", attachmentId: "stored-two", downloaded: true, status: "AVAILABLE",
        fileName: "Delivery note.png", mimeType: "image/png", byteSize: 22, downloadedAt: "2026-10-30T06:00:00Z" },
      { id: "source-pending", name: "Pending original.pdf", attachmentId: null, downloaded: false, status: "PENDING",
        fileName: null, mimeType: null, byteSize: null, downloadedAt: null },
    ] };
  const native = bill(jobA, "FICTIONAL-NATIVE-HISTORY", "READY", 100);
  native.documents = [{ id: "native-original", fileName: "Workspace original.pdf" }, { id: "native-support", fileName: "Workspace receipt.png" }];
  await page.route("**/api/dashboard/search?*", route => route.fulfill({ json: searchEnvelope(match.billNumber, [jobA], [match]) }));
  await page.route(`**/api/jobs/${jobA.id}`, route => route.fulfill({ json: { ...detail(jobA), bills: [native], booksBills: [imported],
    booksHistory: { verificationPending: true, warnings: ["Some company invoices still need verified job links."], refreshPausedUntil: "2026-10-30T20:02:00.000Z" },
    financialCompleteness: { complete: false, unlinkedBooksBillCount: 1, notes: ["Other historical bills are not assigned to this job."] } } }));
  const downloadPath = `/api/bills/books/${imported.id}/attachments/stored-one?download=1`;
  await page.route(`**${downloadPath}`, route => route.fulfill({ status: 200, contentType: "application/pdf",
    headers: { "Content-Disposition": 'attachment; filename="Source invoice.pdf"' }, body: "%PDF-1.4\n% Fictional history original\n%%EOF" }));
  await openManual(page);
  await find(page, match.billNumber);
  await expect(page.getByRole("region", { name: "Matching bills", exact: true })).toContainText(companies[0].name);
  await page.getByRole("link", { name: `View job history ${jobA.jobNumber} for bill ${match.billNumber} in ${companies[0].name}`, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/jobs/${jobA.id}$`));
  await expect(page.getByRole("heading", { name: "Linked Zoho Books bills", exact: true })).toBeVisible();
  await expect(page.getByText(/Next Books update retry after .* Dubai/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Linked workspace bills", exact: true })).toBeVisible();
  await expect(page.getByText("Job cost allocation unverified", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Review this company's Books bills", exact: true }))
    .toHaveAttribute("href", `/bills/books?companyId=${companyA}`);
  const booksDocuments = page.getByLabel(`Attachments for ${match.billNumber}`, { exact: true });
  await expect(booksDocuments.getByRole("link", { name: /^Open / })).toHaveCount(2);
  await expect(booksDocuments.getByRole("link", { name: /^Download / })).toHaveCount(2);
  await expect(booksDocuments).toContainText("Pending original.pdf");
  await expect(booksDocuments).toContainText("Not downloaded yet");
  await expect(booksDocuments.getByRole("link", { name: "Open Source invoice.pdf for FICTIONAL-HISTORY-2026", exact: true }))
    .toHaveAttribute("href", `/api/bills/books/${imported.id}/attachments/stored-one`);
  await expect(booksDocuments.getByRole("link", { name: "Open Delivery note.png for FICTIONAL-HISTORY-2026", exact: true }))
    .toHaveAttribute("href", `/api/bills/books/${imported.id}/attachments/stored-two`);
  const nativeDocuments = page.getByLabel(`Attachments for ${native.invoiceNumber}`, { exact: true });
  await expect(nativeDocuments.getByRole("link", { name: /^Open / })).toHaveCount(2);
  await expect(nativeDocuments.getByRole("link", { name: /^Download / })).toHaveCount(2);
  await expect(nativeDocuments.getByRole("link", { name: "Open Workspace original.pdf for FICTIONAL-NATIVE-HISTORY", exact: true }))
    .toHaveAttribute("href", "/api/documents/native-original?preview=1");
  await expect(nativeDocuments.getByRole("link", { name: "Download Workspace original.pdf for FICTIONAL-NATIVE-HISTORY", exact: true }))
    .toHaveAttribute("href", "/api/documents/native-original");
  const [download] = await Promise.all([page.waitForEvent("download"), booksDocuments.getByRole("link", {
    name: "Download Source invoice.pdf for FICTIONAL-HISTORY-2026", exact: true }).click()]);
  expect(download.suggestedFilename()).toBe("Source invoice.pdf");
  const firstOriginal = booksDocuments.getByRole("link", { name: "Open Source invoice.pdf for FICTIONAL-HISTORY-2026", exact: true });
  await firstOriginal.scrollIntoViewIfNeeded();
  const visibleWidth = () => firstOriginal.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return bounds.left >= 0 && bounds.right <= window.innerWidth;
  });
  expect(await visibleWidth()).toBe(true);
  await page.screenshot({ path: ".local/screenshots/manual-history-fixture-desktop.png", fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  // File controls remain in the first visible invoice column without scrolling the table sideways.
  await page.locator(".table-scroll").evaluateAll(elements => elements.forEach(element => { element.scrollLeft = 0; }));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await visibleWidth()).toBe(true);
  await page.screenshot({ path: ".local/screenshots/manual-history-fixture-mobile.png", fullPage: true, animations: "disabled" });
  await page.getByRole("link", { name: "Add bill", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Company", exact: true })).toHaveValue(companyA);
  await expect(page.getByLabel(/^Job \/ project/)).toHaveValue(jobA.id);
  await expect(page.getByRole("button", { name: "Save and sync", exact: true })).toBeVisible();
});

test("job-name search preserves the explicit company and shows empty linked history honestly", async ({ page }) => {
  await page.route(`**/api/jobs/${jobB.id}`, route => route.fulfill({ json: { ...detail(jobB), bills: [], booksBills: [],
    booksHistory: { verificationPending: true, warnings: ["The complete bill history for this job has not been verified."], refreshPausedUntil: "2026-10-30T20:02:00.000Z" },
    financialCompleteness: { complete: false, unlinkedBooksBillCount: 3, notes: ["Historical job allocations are not verified."] } } }));
  await openManual(page);
  await find(page, jobB.name);
  await expect(jobLink(page, jobB)).toBeVisible();
  await expect(jobLink(page, jobA)).toHaveCount(0);
  await jobLink(page, jobB).click();
  await expect(page.getByRole("heading", { name: "No verified related bills yet", exact: true })).toBeVisible();
  await expect(page.getByText("Verification pending", { exact: true })).toBeVisible();
  await expect(page.getByText("The complete bill history for this job has not been verified.", { exact: true })).toBeVisible();
  await expect(page.getByText(/Next Books update retry after .* Dubai/)).toBeVisible();
  const history = page.locator(".card").filter({ has: page.getByRole("heading", { name: "Linked Zoho Books bills", exact: true }) });
  await expect(history.getByText("0 bills", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("strong").filter({ hasText: /^Historical job costs are incomplete$/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Review this company's Books bills", exact: true }))
    .toHaveAttribute("href", `/bills/books?companyId=${companyB}`);
  await expect(page.getByRole("link", { name: /^Open .* for / })).toHaveCount(0);
});

test("JOB-5363 keeps unverified history distinct from quota delay without guessing bills or costs", async ({ page }) => {
  const requestedJob: Job = { ...jobA, id: "fictional-job-5363-unverified", jobNumber: "JOB-5363",
    name: "Fictional Mr Mark project", customer: "Fictional customer", companyName: companies[0].name,
    externalCrmId: "990000005363", approvedVariations: null,
    summary: { adjustedValue: null, recognizedExpenses: null, paidExpenses: null, outstanding: null,
      estimatedProfit: null, remainingBudget: null, expensePercentage: null, budgetStatus: "VALUE_UNAVAILABLE" } };
  const warning = "The complete bill history for this job has not been verified. Some company bills may still need an exact job link.";
  const mutations: string[] = [];
  let quotaPaused = true;
  page.on("request", request => {
    if (new URL(request.url()).pathname.startsWith("/api/") && !["GET", "HEAD"].includes(request.method()))
      mutations.push(new URL(request.url()).pathname);
  });
  await page.route("**/api/dashboard/search?*", route => route.fulfill({ json: searchEnvelope("5363", [requestedJob]) }));
  await page.route(/\/api\/jobs(?:\?.*)?$/, route => route.fulfill({ json: { jobs: [requestedJob] } }));
  await page.route(`**/api/jobs/${requestedJob.id}`, route => route.fulfill({ json: {
    job: requestedJob, bills: [], booksBills: [],
    booksHistory: { verificationPending: true, warnings: [warning], refreshPausedUntil: quotaPaused ? "2026-10-30T20:02:00.000Z" : null },
    financialCompleteness: { complete: false, unlinkedBooksBillCount: 9,
      notes: ["Matching names or dates do not establish a verified job association."] },
  } }));
  await openManual(page);
  await find(page, "5363");
  await jobLink(page, requestedJob).click();
  const history = page.locator(".card").filter({ has: page.getByRole("heading", { name: "Linked Zoho Books bills", exact: true }) });
  await expect(page.getByRole("heading", { name: requestedJob.name, exact: true })).toBeVisible();
  await expect(history.getByText("Verification pending", { exact: true })).toBeVisible();
  await expect(history.getByText("Bill history needs verification", { exact: true })).toBeVisible();
  await expect(history.getByRole("heading", { name: "No verified related bills yet", exact: true })).toBeVisible();
  await expect(history.getByText("A complete history is not available yet. This does not confirm that the job has no bills.", { exact: true })).toBeVisible();
  await expect(history.getByText(/Next Books update retry after 31 Oct 2026, 00:02 Dubai/)).toBeVisible();
  await expect(history.getByText("0 bills", { exact: true })).toHaveCount(0);
  await expect(history.getByRole("link", { name: /^Open |^Download / })).toHaveCount(0);
  await expect(metric(page, "Recorded contract value")).toContainText("1,000.00");
  for (const label of ["Recognized expenses", "Outstanding bills", "Estimated profit / loss"])
    await expect(metric(page, label)).toHaveText("—");
  await expect(page.getByRole("link", { name: "Review this company's Books bills", exact: true }))
    .toHaveAttribute("href", `/bills/books?companyId=${companyA}`);
  await page.setViewportSize({ width: 390, height: 844 });
  await history.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: ".local/screenshots/job5363-unverified-history-fixture-mobile.png", fullPage: true, animations: "disabled" });
  quotaPaused = false;
  await page.getByRole("button", { name: "Refresh job", exact: true }).click();
  await expect(history.getByText(/Next Books update retry after/)).toHaveCount(0);
  await expect(history.getByText("Verification pending", { exact: true })).toBeVisible();
  await expect(history.getByRole("heading", { name: "No verified related bills yet", exact: true })).toBeVisible();
  await expect(history.getByText(warning, { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Add bill", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Company", exact: true })).toHaveValue(companyA);
  await expect(page.getByLabel(/^Job \/ project/)).toHaveValue(requestedJob.id);
  expect(mutations).toEqual([]);
});

test("ambiguous bill matches retain every scoped job and require an explicit choice", async ({ page }) => {
  const anotherJob = { ...jobA, id: "manual-alpha-second", jobNumber: "FICTIONAL-ALPHA-SECOND", name: "Second fictional project" };
  const first = billMatch(jobA, "FICTIONAL-SHARED-BILL"), second = billMatch(jobB, first.billNumber);
  first.relatedJobs!.push({ id: anotherJob.id, jobNumber: anotherJob.jobNumber, name: anotherJob.name,
    companyId: companyA, companyName: companies[0].name });
  first.jobId = null;
  first.jobNumber = null;
  await page.route("**/api/dashboard/search?*", route => route.fulfill({ json: searchEnvelope(first.billNumber, [jobA, anotherJob, jobB], [first, second]) }));
  await page.route(`**/api/jobs/${anotherJob.id}`, route => route.fulfill({ json: detail(anotherJob) }));
  await page.setViewportSize({ width: 390, height: 844 });
  await openManual(page);
  await find(page, first.billNumber);
  const bills = page.getByRole("region", { name: "Matching bills", exact: true });
  await expect(bills).toContainText(companies[0].name);
  await expect(bills).toContainText(companies[1].name);
  await expect(bills.getByRole("link", { name: /^View job history / })).toHaveCount(3);
  await expect(bills).toContainText("Related to multiple jobs. Choose the history to review.");
  await expect(page).toHaveURL(/\/bills\/manual$/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await bills.getByRole("link", { name: `View job history ${anotherJob.jobNumber} for bill ${first.billNumber} in ${companies[0].name}`, exact: true }).click();
  await expect(page.getByRole("heading", { name: anotherJob.name, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Add bill", exact: true })).toHaveAttribute("href", `/bills/new?jobId=${anotherJob.id}`);
});

test("unlinked bill and unassigned CRM matches never select a billing job", async ({ page }) => {
  const unlinked = { ...billMatch(jobA, "FICTIONAL-UNLINKED"), jobId: null, jobNumber: null, relatedJobs: [] };
  const response = searchEnvelope(unlinked.billNumber, [], [unlinked]);
  response.jobs.push({ id: "unassigned-snapshot", canonicalJobId: null, jobNumber: "FICTIONAL-UNASSIGNED", name: "Unassigned source project",
    companyId: null, companyName: "Unassigned company", customer: "Fictional customer", currency: "AED", canCreateBill: false,
    href: "/jobs/crm/unassigned-snapshot" });
  await page.route("**/api/dashboard/search?*", route => route.fulfill({ json: response }));
  await openManual(page);
  await find(page, unlinked.billNumber);
  const bills = page.getByRole("region", { name: "Matching bills", exact: true });
  await expect(bills).toContainText("No verified job link");
  await expect(bills.getByRole("link", { name: /^View bill / })).toHaveAttribute("href", unlinked.href);
  await expect(bills.getByRole("link", { name: /^View job history / })).toHaveCount(0);
  await expect(page.getByText("Unassigned company", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Add bill", exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(/\/bills\/manual$/);
});

test("manual search rejects a bill whose related job belongs to another company", async ({ page }) => {
  const wrongScope = billMatch(jobA, "FICTIONAL-WRONG-COMPANY");
  wrongScope.relatedJobs = billMatch(jobB, wrongScope.billNumber).relatedJobs;
  await page.route("**/api/dashboard/search?*", route => route.fulfill({ json: searchEnvelope(wrongScope.billNumber, [jobA], [wrongScope]) }));
  await openManual(page);
  await find(page, wrongScope.billNumber);
  await expect(page.getByText("Search results could not be verified for your companies. Retry the search.", { exact: true })).toBeVisible();
  await expect(jobLink(page, jobA)).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Matching bills", exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(/\/bills\/manual$/);
});

test("dashboard Manual entry opens job lookup while direct New Bill remains available", async ({ page }) => {
  await page.goto("/dashboard");
  await page.getByRole("link", { name: /Manual entry/ }).click();
  await expect(page).toHaveURL(/\/bills\/manual$/);
  await expect(queryInput(page)).toBeVisible();
  await expect(queryInput(page)).toHaveValue("");
  await expect(page.getByRole("combobox", { name: "Company", exact: true })).toHaveCount(0);
  await expect(page.getByRole("table", { name: "Matching jobs", exact: true })).toHaveCount(0);
  await page.goto("/bills/new");
  await expect(page.getByRole("heading", { name: "New Bill", exact: true })).toBeVisible();
  await expect(page.getByLabel("Bill#")).toBeVisible();
});

for (const job of [jobA, jobB]) {
  test(`automatically finds the local ${job.companyId} job and prefills its bill`, async ({ page }) => {
    const reads: URL[] = [];
    const writes: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/jobs") || url.pathname === "/api/dashboard/search") reads.push(url);
      if (url.pathname.startsWith("/api/") && request.method() !== "GET") writes.push(url.pathname);
    });
    await openManual(page);
    expect(reads).toEqual([]);
    await find(page, job.jobNumber);
    await expect(jobLink(page, job)).toBeVisible();
    await expect(jobLink(page, job.id === jobA.id ? jobB : jobA)).toHaveCount(0);
    expect(reads.filter((url) => url.pathname === "/api/dashboard/search").at(-1)?.searchParams.get("companyId")).toBeNull();
    expect(reads.filter((url) => url.pathname === "/api/dashboard/search").at(-1)?.searchParams.get("q")).toBe(job.jobNumber);
    await jobLink(page, job).click();
    await expect(page).toHaveURL(new RegExp(`/jobs/${job.id}$`));
    await expect(page.getByRole("heading", { name: job.name, exact: true })).toBeVisible();
    await expect(metric(page, "Recognized expenses")).toContainText("100.00");
    await expect(metric(page, "Outstanding bills")).toContainText("105.00");
    await expect(page.getByRole("row").filter({ hasText: "FICTIONAL-DRAFT-500" })).toContainText("draft");
    await expect(page.getByRole("row").filter({ hasText: "FICTIONAL-COST-100" })).toContainText("Ready to sync");
    await expect(page.getByRole("link", { name: "Add bill", exact: true })).toHaveAttribute("href", `/bills/new?jobId=${job.id}`);
    // The exact hydration endpoint must remain sufficient even if the ordinary list is empty.
    await page.route(/\/api\/jobs$/, (route) => route.fulfill({ json: { jobs: [] } }));
    const beforeHydration = reads.filter((url) => url.pathname === `/api/jobs/${job.id}`).length;
    await page.getByRole("link", { name: "Add bill", exact: true }).click();
    await expect(page.getByRole("heading", { name: "New Bill", exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Company", exact: true })).toHaveValue(job.companyId);
    await expect(page.getByLabel(/^Job \/ project/)).toHaveValue(job.id);
    await expect(page.getByLabel("Currency", { exact: true })).toHaveValue(job.currency);
    expect(reads.filter((url) => url.pathname === `/api/jobs/${job.id}`).length).toBeGreaterThan(beforeHydration);
    expect(writes).toEqual([]);
  });
}

test("handles no saved match and a failed lookup retry without creating a job", async ({ page }) => {
  let failed = false;
  await page.route("**/api/dashboard/search?*", (route) => {
    const q = new URL(route.request().url()).searchParams.get("q") || "";
    if (q === "missing") return route.fulfill({ json: searchEnvelope(q, []) });
    if (!failed) { failed = true; return route.fulfill({ status: 503, json: { error: "Fictional job lookup unavailable." } }); }
    return route.fulfill({ json: searchEnvelope(q, [jobA]) });
  });
  await openManual(page);
  await find(page, "missing");
  await expect(page.getByText("No saved matching job or bill", { exact: true })).toBeVisible();
  await expect(page.getByRole("table", { name: "Matching jobs", exact: true })).toHaveCount(0);
  await find(page);
  await expect(page.getByText("Fictional job lookup unavailable.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retry job search", exact: true }).click();
  await expect(jobLink(page, jobA)).toBeVisible();
});

test("query changes discard delayed saved results and typing hides an old submitted query", async ({ page }) => {
  const pending = deferred();
  let waiting = false;
  let responded = false;
  await page.route("**/api/dashboard/search?*", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get("q") !== jobA.jobNumber) return route.fallback();
    waiting = true;
    await pending.promise;
    await route.fulfill({ json: searchEnvelope(jobA.jobNumber, [jobA]) }).catch(() => undefined);
    responded = true;
  });
  try {
    await openManual(page);
    await find(page);
    await expect.poll(() => waiting).toBe(true);
    await find(page, jobB.jobNumber);
    await expect(jobLink(page, jobB)).toBeVisible();
    pending.release();
    await expect.poll(() => responded).toBe(true);
    await expect(jobLink(page, jobA)).toHaveCount(0);
    await queryInput(page).fill("new unsent reference");
    await expect(jobLink(page, jobB)).toHaveCount(0);
  } finally { pending.release(); }
});

test("job summary refreshes finalized costs, payments and cancellations while drafts remain excluded", async ({ page }) => {
  await page.clock.install();
  let phase: Phase = "draft";
  let reads = 0;
  await page.route(`**/api/jobs/${jobA.id}`, (route) => { reads++; return route.fulfill({ json: detail(jobA, phase) }); });
  await page.goto(`/jobs/${jobA.id}`);
  await expect(metric(page, "Recognized expenses")).toHaveText(/^[^\d]*0\.00$/);
  await expect(page.getByRole("row").filter({ hasText: "FICTIONAL-DRAFT-500" })).toContainText("525.00");
  phase = "ready";
  const beforePoll = reads;
  await page.clock.fastForward(15_100);
  await expect.poll(() => reads).toBeGreaterThan(beforePoll);
  await expect(metric(page, "Recognized expenses")).toContainText("100.00");
  await expect(metric(page, "Outstanding bills")).toContainText("105.00");
  phase = "paid";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(metric(page, "Recognized expenses")).toContainText("300.00");
  await expect(metric(page, "Outstanding bills")).toContainText("265.00");
  await expect(page.locator(".job-detail-summary > div").filter({ hasText: "Paid expenses" })).toContainText("50.00");
  phase = "cancelled";
  await page.getByRole("button", { name: "Refresh job", exact: true }).click();
  await expect(metric(page, "Recognized expenses")).toContainText("200.00");
  await expect(metric(page, "Outstanding bills")).toContainText("160.00");
  await expect(metric(page, "Estimated profit / loss")).toContainText("800.00");
  await expect(page.getByRole("row").filter({ hasText: "FICTIONAL-COST-100" })).toContainText("cancelled");
  await expect(page.getByRole("row").filter({ hasText: "FICTIONAL-DRAFT-500" })).toContainText("draft");
});

test("a forbidden query job blocks the editable bill form and can retry exact hydration", async ({ page }) => {
  let forbidden = true;
  await page.route(`**/api/jobs/${jobB.id}`, (route) => forbidden
    ? route.fulfill({ status: 403, json: { error: "Fictional job access denied." } })
    : route.fulfill({ json: detail(jobB) }));
  await page.goto(`/bills/new?jobId=${jobB.id}`);
  await expect(page.getByText("Fictional job access denied.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Bill#")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save as draft", exact: true })).toHaveCount(0);
  forbidden = false;
  await page.getByRole("button", { name: /Retry/i }).click();
  await expect(page.getByRole("combobox", { name: "Company", exact: true })).toHaveValue(companyB);
  await expect(page.getByLabel(/^Job \/ project/)).toHaveValue(jobB.id);
});

test("an invalid query job ID cannot fall through to an unrelated editable bill", async ({ page }) => {
  await page.goto("/bills/new?jobId=%2Fnot-a-job");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByLabel("Bill#")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save as draft", exact: true })).toHaveCount(0);
});

test("successful hydration with a different job identity still blocks the bill form", async ({ page }) => {
  await page.route(`**/api/jobs/${jobB.id}`, (route) => route.fulfill({ json: detail(jobA) }));
  await page.goto(`/bills/new?jobId=${jobB.id}`);
  await expect(page.getByText("The selected job could not be verified. Search for the job again.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Bill#")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save as draft", exact: true })).toHaveCount(0);
});

test("summary refresh failures retain marked stale data but lost access clears it", async ({ page }) => {
  let status = 200;
  let phase: Phase = "ready";
  await page.route(`**/api/jobs/${jobA.id}`, (route) => status === 200 ? route.fulfill({ json: detail(jobA, phase) })
    : route.fulfill({ status, json: { error: status === 403 ? "Fictional job access removed." : "Fictional job refresh unavailable." } }));
  await page.goto(`/jobs/${jobA.id}`);
  await expect(metric(page, "Recognized expenses")).toContainText("100.00");
  status = 503;
  await page.getByRole("button", { name: "Refresh job", exact: true }).click();
  await expect(page.getByText(/Displayed amounts may be out of date/)).toBeVisible();
  await expect(metric(page, "Recognized expenses")).toContainText("100.00");
  status = 200;
  phase = "paid";
  await page.getByRole("button", { name: "Retry job refresh", exact: true }).click();
  await expect(metric(page, "Recognized expenses")).toContainText("300.00");
  status = 403;
  await page.getByRole("button", { name: "Refresh job", exact: true }).click();
  await expect(page.getByText("Fictional job access removed.", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: jobA.name, exact: true })).toHaveCount(0);
  await expect(page.locator(".metric-card")).toHaveCount(0);
  await expect(page.getByRole("row").filter({ hasText: "FICTIONAL-PAID-200" })).toHaveCount(0);
});

for (const match of [crmA, crmB]) {
  test(`resolves the selected live CRM job for ${match.companyId} using its exact source identity`, async ({ page }) => {
    const queries: URLSearchParams[] = [];
    const resolved: unknown[] = [];
    const local = match.companyId === companyA ? jobA : jobB;
    await page.route("**/api/jobs/search?*", (route) => {
      const params = new URL(route.request().url()).searchParams;
      queries.push(params);
      return route.fulfill({ json: crmEnvelope([match]) });
    });
    await page.route("**/api/jobs/resolve", (route) => {
      expect(route.request().method()).toBe("POST");
      resolved.push(route.request().postDataJSON());
      return route.fulfill({ json: { job: resolvedJob(match), stage: match.stage } });
    });
    await openManual(page);
    await find(page, match.jobNumber);
    await expect(crmAction(page, match)).toBeVisible();
    await expect(page.getByRole("table", { name: "Zoho CRM matches", exact: true })).toContainText(match.stage!);
    expect(queries.every((params) => !params.has("companyId") && params.get("q") === match.jobNumber)).toBe(true);
    expect(resolved).toEqual([]);
    await crmAction(page, match).click();
    await expect(page).toHaveURL(new RegExp(`/jobs/${local.id}$`));
    await expect(page.getByRole("heading", { name: local.name, exact: true })).toBeVisible();
    expect(resolved).toEqual([resolveBody(match)]);
  });
}

test("numeric job lookup preserves 5383 while selecting canonical JOB-5383 and prefilling its bill", async ({ page }) => {
  const canonicalJob = { ...jobA, jobNumber: "JOB-5383", externalCrmId: crmA.externalCrmId };
  const canonicalMatch = { ...crmA, jobNumber: canonicalJob.jobNumber };
  const savedQueries: URLSearchParams[] = [];
  const crmQueries: URLSearchParams[] = [];
  const resolved: unknown[] = [];
  await page.route("**/api/dashboard/search?*", route => {
    const params = new URL(route.request().url()).searchParams;
    savedQueries.push(params);
    return route.fulfill({ json: searchEnvelope(params.get("q") || "", [canonicalJob]) });
  });
  await page.route(/\/api\/jobs(?:\?.*)?$/, (route) => {
    const params = new URL(route.request().url()).searchParams;
    return route.fulfill({ json: { jobs: canonicalJob.jobNumber.includes(params.get("q") ?? "") ? [canonicalJob] : [] } });
  });
  await page.route("**/api/jobs/search?*", (route) => {
    crmQueries.push(new URL(route.request().url()).searchParams);
    return route.fulfill({ json: crmEnvelope([canonicalMatch]) });
  });
  await page.route("**/api/jobs/resolve", (route) => {
    resolved.push(route.request().postDataJSON());
    return route.fulfill({ json: { job: canonicalJob, stage: canonicalMatch.stage } });
  });
  await page.route(`**/api/jobs/${canonicalJob.id}`, (route) => route.fulfill({ json: detail(canonicalJob) }));
  await openManual(page);
  await expect(page.getByRole("combobox", { name: "Company", exact: true })).toHaveCount(0);
  await find(page, "5383");
  await expect(queryInput(page)).toHaveValue("5383");
  await expect(jobLink(page, canonicalJob)).toBeVisible();
  await expect(crmAction(page, canonicalMatch)).toBeVisible();
  await expect(page.getByRole("table", { name: "Zoho CRM matches", exact: true })).toContainText(companies[0].name);
  expect(savedQueries.length).toBeGreaterThan(0);
  expect(crmQueries.length).toBeGreaterThan(0);
  for (const params of [...savedQueries, ...crmQueries]) expect([...params.entries()]).toEqual([["q", "5383"]]);
  expect(resolved).toEqual([]);
  await crmAction(page, canonicalMatch).click();
  await expect(page).toHaveURL(new RegExp(`/jobs/${canonicalJob.id}$`));
  expect(resolved).toEqual([resolveBody(canonicalMatch)]);
  await page.getByRole("link", { name: "Add bill", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Company", exact: true })).toHaveValue(companyA);
  await expect(page.getByLabel(/^Job \/ project/)).toHaveValue(canonicalJob.id);
  await expect(page.getByLabel(/^Job \/ project/).locator("option:checked")).toContainText("JOB-5383");
  await expect(page.getByLabel("Currency", { exact: true })).toHaveValue("AED");
});

test("an ambiguous job reference shows both companies and uses the explicitly selected match for bill prefill", async ({ page }) => {
  const savedJobs = [{ ...jobA, jobNumber: reference }, { ...jobB, jobNumber: reference }];
  const remoteJobs = [{ ...crmA, jobNumber: reference }, { ...crmB, jobNumber: reference }];
  const resolved: unknown[] = [];
  await page.route("**/api/dashboard/search?*", route => route.fulfill({ json: searchEnvelope(reference, savedJobs) }));
  await page.route(/\/api\/jobs(?:\?.*)?$/, (route) => route.fulfill({ json: { jobs: savedJobs } }));
  await page.route("**/api/jobs/search?*", (route) => {
    expect(new URL(route.request().url()).searchParams.has("companyId")).toBe(false);
    return route.fulfill({ json: crmEnvelope(remoteJobs) });
  });
  await page.route("**/api/jobs/resolve", (route) => {
    resolved.push(route.request().postDataJSON());
    return route.fulfill({ json: { job: { ...savedJobs[1], externalCrmId: crmB.externalCrmId }, stage: crmB.stage } });
  });
  await page.route(`**/api/jobs/${jobB.id}`, (route) => route.fulfill({ json: detail(savedJobs[1]) }));
  await openManual(page);
  await find(page, reference);
  const crmTable = page.getByRole("table", { name: "Zoho CRM matches", exact: true });
  await expect(crmTable).toContainText(companies[0].name);
  await expect(crmTable).toContainText(companies[1].name);
  await expect(jobLink(page, savedJobs[0])).toBeVisible();
  await expect(jobLink(page, savedJobs[1])).toBeVisible();
  await expect(crmAction(page, remoteJobs[0])).toBeVisible();
  await expect(crmAction(page, remoteJobs[1])).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Company", exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(/\/bills\/manual$/);
  expect(resolved).toEqual([]);
  await crmAction(page, remoteJobs[1]).click();
  await expect(page).toHaveURL(new RegExp(`/jobs/${jobB.id}$`));
  expect(resolved).toEqual([resolveBody(remoteJobs[1])]);
  await page.getByRole("link", { name: "Add bill", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Company", exact: true })).toHaveValue(companyB);
  await expect(page.getByLabel(/^Job \/ project/)).toHaveValue(jobB.id);
  await expect(page.getByLabel("Currency", { exact: true })).toHaveValue("USD");
});

test("a saved job opens immediately while CRM matches still require explicit verification", async ({ page }) => {
  let resolves = 0;
  await page.route("**/api/jobs/search?*", (route) => route.fulfill({ json: crmEnvelope([{ ...crmA, id: jobA.id }]) }));
  await page.route("**/api/jobs/resolve", (route) => { resolves++; return route.fulfill({ json: { job: resolvedJob(crmA), stage: crmA.stage } }); });
  await openManual(page);
  await find(page);
  await expect(crmAction(page, crmA)).toBeVisible();
  await jobLink(page, jobA).click();
  await expect(page).toHaveURL(new RegExp(`/jobs/${jobA.id}$`));
  expect(resolves).toBe(0);
  await openManual(page);
  await find(page);
  await crmAction(page, crmA).click();
  await expect(page).toHaveURL(new RegExp(`/jobs/${jobA.id}$`));
  expect(resolves).toBe(1);
});

test("changing the query discards a late CRM result from another company", async ({ page }) => {
  const pending = deferred();
  let waiting = false;
  let responded = false;
  await page.route("**/api/jobs/search?*", async (route) => {
    const query = new URL(route.request().url()).searchParams.get("q");
    if (query !== jobA.jobNumber) return route.fulfill({ json: crmEnvelope([crmB]) });
    waiting = true;
    await pending.promise;
    await route.fulfill({ json: crmEnvelope([crmA]) }).catch(() => undefined);
    responded = true;
  });
  try {
    await openManual(page);
    await find(page);
    await expect.poll(() => waiting).toBe(true);
    await expect(jobLink(page, jobA)).toBeVisible();
    await find(page, jobB.jobNumber);
    await expect(jobLink(page, jobB)).toBeVisible();
    await expect(crmAction(page, crmB)).toBeVisible();
    pending.release();
    await expect.poll(() => responded).toBe(true);
    await expect(crmAction(page, crmA)).toHaveCount(0);
    await expect(crmAction(page, crmB)).toBeVisible();
  } finally { pending.release(); }
});

test("a new query during CRM resolution prevents late navigation into the previous company", async ({ page }) => {
  const pending = deferred();
  let waiting = false;
  let responded = false;
  const bodies: unknown[] = [];
  await page.route("**/api/jobs/search?*", (route) => {
    const query = new URL(route.request().url()).searchParams.get("q");
    return route.fulfill({ json: crmEnvelope([query === jobA.jobNumber ? crmA : crmB]) });
  });
  await page.route("**/api/jobs/resolve", async (route) => {
    bodies.push(route.request().postDataJSON());
    waiting = true;
    await pending.promise;
    await route.fulfill({ json: { job: resolvedJob(crmA), stage: crmA.stage } }).catch(() => undefined);
    responded = true;
  });
  try {
    await openManual(page);
    await find(page);
    await crmAction(page, crmA).click();
    await expect.poll(() => waiting).toBe(true);
    await expect(page.getByText("Selecting CRM job…", { exact: true })).toBeVisible();
    await find(page, jobB.jobNumber);
    await expect(crmAction(page, crmB)).toBeVisible();
    pending.release();
    await expect.poll(() => responded).toBe(true);
    await expect(page).toHaveURL(/\/bills\/manual$/);
    await expect(queryInput(page)).toHaveValue(jobB.jobNumber);
    await expect(jobLink(page, jobB)).toBeVisible();
    expect(bodies).toEqual([resolveBody(crmA)]);
  } finally { pending.release(); }
});

test("an unavailable CRM grant offers the explicit authorization link and leaves saved lookup usable", async ({ page }) => {
  const warning = "Fictional CRM authorization is required for this company.";
  const posts: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/") && request.method() === "POST") posts.push(request.url());
  });
  await page.route("**/api/jobs/search?*", (route) => route.fulfill({ json: crmEnvelope([], warning) }));
  await openManual(page);
  await find(page);
  await expect(page.getByText(warning, { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Connect Zoho CRM", exact: true })).toHaveAttribute("href", "/account/crm-authorization");
  await expect(jobLink(page, jobA)).toBeVisible();
  await expect(crmAction(page, crmA)).toHaveCount(0);
  expect(posts).toEqual([]);
});

test("a forbidden CRM resolution stays on lookup and retries only after an explicit action", async ({ page }) => {
  let attempts = 0;
  await page.route("**/api/jobs/search?*", (route) => route.fulfill({ json: crmEnvelope([crmA]) }));
  await page.route("**/api/jobs/resolve", (route) => ++attempts === 1
    ? route.fulfill({ status: 403, json: { error: "Fictional CRM selection permission denied." } })
    : route.fulfill({ json: { job: resolvedJob(crmA), stage: crmA.stage } }));
  await openManual(page);
  await find(page);
  await crmAction(page, crmA).click();
  await expect(page.getByText("Fictional CRM selection permission denied.", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/bills\/manual$/);
  expect(attempts).toBe(1);
  await page.getByRole("button", { name: "Retry CRM selection", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/jobs/${jobA.id}$`));
  expect(attempts).toBe(2);
});

test("CRM loading, empty results and failures retry independently of saved job results", async ({ page }) => {
  const pending = deferred();
  let phase = "loading";
  let waiting = false;
  const warning = "Fictional CRM provider is temporarily unavailable.";
  await page.route("**/api/jobs/search?*", async (route) => {
    if (phase === "loading") {
      waiting = true;
      await pending.promise;
      return route.fulfill({ json: crmEnvelope() });
    }
    if (phase === "error") return route.fulfill({ status: 503, json: { error: "Fictional CRM search failed." } });
    return route.fulfill({ json: phase === "warning" ? crmEnvelope([], warning) : crmEnvelope([crmA]) });
  });
  try {
    await openManual(page);
    await find(page);
    await expect.poll(() => waiting).toBe(true);
    const region = page.getByRole("region", { name: "Zoho CRM job search", exact: true });
    await expect(region.getByText("Searching Zoho CRM jobs…", { exact: true })).toBeVisible();
    await expect(jobLink(page, jobA)).toBeVisible();
    await expect(crmAction(page, crmA)).toHaveCount(0);
    pending.release();
    await expect(region.getByRole("heading", { name: "No matching CRM job", exact: true })).toBeVisible();
    phase = "error";
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(region.getByText("Fictional CRM search failed.", { exact: true })).toBeVisible();
    await expect(region.getByRole("heading", { name: "No matching CRM job", exact: true })).toHaveCount(0);
    phase = "warning";
    await region.getByRole("button", { name: "Retry CRM search", exact: true }).click();
    await expect(region.getByText(warning, { exact: true })).toBeVisible();
    await expect(region.getByRole("heading", { name: "No matching CRM job", exact: true })).toHaveCount(0);
    phase = "ready";
    await region.getByRole("button", { name: "Retry CRM search", exact: true }).click();
    await expect(crmAction(page, crmA)).toBeVisible();
    await expect(jobLink(page, jobA)).toBeVisible();
  } finally { pending.release(); }
});

test("CRM resolution rejects mismatched company or external ID despite a successful HTTP response", async ({ page }) => {
  let attempts = 0;
  const invalidJobs = [resolvedJob(crmB), { ...resolvedJob(crmA), externalCrmId: "980000000099" }];
  await page.route("**/api/jobs/search?*", (route) => route.fulfill({ json: crmEnvelope([crmA]) }));
  await page.route("**/api/jobs/resolve", (route) => route.fulfill({ json: { job: invalidJobs[attempts++], stage: crmA.stage } }));
  await openManual(page);
  await find(page);
  await crmAction(page, crmA).click();
  const error = page.getByText("The selected CRM job could not be verified. Search again before continuing.", { exact: true });
  await expect(error).toBeVisible();
  await expect(page).toHaveURL(/\/bills\/manual$/);
  await page.getByRole("button", { name: "Retry CRM selection", exact: true }).click();
  await expect.poll(() => attempts).toBe(2);
  await expect(error).toBeVisible();
  await expect(page).toHaveURL(/\/bills\/manual$/);
  await expect(page.getByRole("heading", { name: jobA.name, exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: jobB.name, exact: true })).toHaveCount(0);
});

test("wrong-company CRM responses are blocked while the authorized saved result remains usable", async ({ page }) => {
  let attempts = 0;
  await page.route("**/api/jobs/search?*", (route) => route.fulfill({ json: ++attempts === 1
    ? { ...crmEnvelope([crmB]), companyId: companyB } : crmEnvelope([crmA, { ...crmB, companyId: "unauthorized-company" }]) }));
  await openManual(page);
  await find(page);
  const region = page.getByRole("region", { name: "Zoho CRM job search", exact: true });
  const error = region.getByText("CRM results could not be verified for your companies. Retry the search.", { exact: true });
  await expect(error).toBeVisible();
  await expect(region.getByRole("table")).toHaveCount(0);
  await expect(jobLink(page, jobA)).toBeVisible();
  await region.getByRole("button", { name: "Retry CRM search", exact: true }).click();
  await expect.poll(() => attempts).toBe(2);
  await expect(error).toBeVisible();
  await expect(region.getByRole("table")).toHaveCount(0);
  await expect(jobLink(page, jobA)).toBeVisible();
});
