import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import type { Dashboard, DashboardSearchResult, ImportedBillSummary } from "../../src/components/types";

// Authentication uses the local fixture account. All source records, files and
// business requests are fictional browser fixtures; financial writes are blocked.
const companies = [{ id: "legacy-fixture-alpha", name: "Fictional History Alpha" }, { id: "legacy-fixture-beta", name: "Fictional History Beta" }];
const sharedName = "Fictional shared villa renovation";
const legacyId = "legacy-fixture-crm-snapshot";
const canonicalId = "legacy-fixture-new-job";
const dealReference = "VTNX-0572";
const newJobReference = "JOB-5290";
const imported: ImportedBillSummary = { id: "legacy-fixture-bill", billNumber: "FICTIONAL-LEGACY-572",
  companyId: companies[0].id, companyName: companies[0].name, vendorName: "Fictional legacy supplier", currency: "AED",
  total: "525.00", status: "paid", billDate: "2022-03-14", jobId: null, jobNumber: null, href: "/bills/books/legacy-fixture-bill",
  relationEvidence: "Verified Books project, Zoho Projects and CRM deal identities", allocationKnown: false,
  attachmentStatus: "COMPLETE", attachmentCount: 1, downloadedAttachmentCount: 1, documents: [
    { id: "legacy-source-document", name: "Fictional legacy original.pdf", attachmentId: "legacy-stored-original", downloaded: true,
      status: "AVAILABLE", fileName: "Fictional legacy original.pdf", mimeType: "application/pdf", byteSize: 55, downloadedAt: "2026-10-30T08:00:00Z" },
  ] };
const legacy: DashboardSearchResult["jobs"][number] = { id: legacyId, canonicalJobId: null, jobNumber: null,
  displayReference: dealReference, referenceKind: "CRM_DEAL", name: sharedName, companyId: null, companyName: "Unassigned company",
  customer: "Fictional customer", currency: "AED", canCreateBill: false, href: `/jobs/crm/${legacyId}`, historyCompanies: [companies[0]] };
const current: DashboardSearchResult["jobs"][number] = { id: canonicalId, canonicalJobId: canonicalId, jobNumber: newJobReference,
  referenceKind: "JOB", name: sharedName, companyId: companies[0].id, companyName: companies[0].name,
  customer: "Fictional customer", currency: "AED", canCreateBill: true, href: `/jobs/${canonicalId}` };
const searchResult = (query: string): DashboardSearchResult => ({ query, jobs: [legacy, current], hasMore: false,
  bills: [{ ...imported, source: "BOOKS", relatedJobs: [{ id: legacyId, canonicalJobId: null, href: legacy.href,
    jobNumber: null, displayReference: dealReference, name: sharedName, companyId: companies[0].id, companyName: companies[0].name }] }] });
const profile = { id: legacyId, companyId: null, companyName: null, externalCrmId: "99000000572", jobNumber: null,
  displayReference: dealReference, name: sharedName, customerName: "Fictional customer", currencyCode: "AED", amount: "12000.00",
  approvedVariations: null, stage: "Closed Won", canonicalJobId: null, linkStatus: "UNASSIGNED_COMPANY", sourceModifiedAt: null,
  lastSeenAt: "2026-10-30T08:00:00Z", isStale: false, historyCompanies: [companies[0]], booksBills: [imported],
  historyWarnings: ["This legacy deal has no billing job reference. New bills require a separately verified billing job."] };
const dashboard: Dashboard = { metrics: { jobValue: null, recognizedExpenses: null, paidExpenses: null, outstanding: null,
  estimatedProfit: null, overBudgetCount: 0, pendingCount: 0, readyCount: 0, draftCount: 0 }, jobs: [], recentBills: [],
  monthlyExpenses: [], vendorExpenses: [], currency: "AED" };

async function find(page: Page, query: string) {
  await page.getByRole("textbox", { name: "Job ID, bill number or job name", exact: true }).fill(query);
  await page.getByRole("button", { name: "Search", exact: true }).click();
}
const sourceLinkName = `View CRM deal history ${dealReference} for Unassigned company`;
const billLinkName = `View CRM deal history ${dealReference} for bill ${imported.billNumber} in ${companies[0].name}`;

test.beforeAll(async () => { await mkdir(".local/screenshots", { recursive: true }); });
test.beforeEach(async ({ page, baseURL }) => {
  const email = process.env.SEED_ADMIN_EMAIL, password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password || !baseURL) throw new Error("Local fixture authentication and origin are required.");
  expect((await page.request.post(`${baseURL}/api/auth/login`, { headers: { Origin: baseURL }, data: { email, password } })).status()).toBe(200);
  await page.route("**/api/**", route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (request.method() !== "GET") return route.fulfill({ status: 422, json: { error: "Financial writes are blocked in this fixture." } });
    if (path === "/api/companies") return route.fulfill({ json: { companies } });
    if (path === "/api/dashboard") return route.fulfill({ json: dashboard });
    if (path === "/api/dashboard/search") return route.fulfill({ json: searchResult(url.searchParams.get("q") || "") });
    if (path === `/api/jobs/crm/${legacyId}`) return route.fulfill({ json: { job: profile } });
    if (path === "/api/jobs/search") return route.fulfill({ json: { companyId: null, jobs: [], warning: null, hasMore: false } });
    if (path === "/api/integrations/incoming-status") return route.fulfill({ json: { generatedAt: "2026-10-30T08:00:00Z",
      enabled: false, workerAlive: false, lastHeartbeatAt: null, pollIntervalSeconds: 5, sources: [] } });
    if (path === "/api/operations") return route.fulfill({ json: { ocrReview: 0, ocrFailed: 0, ocrQueued: 0,
      syncFailures: 0, syncUnknown: 0, duplicateWarnings: 0, duplicateScanTruncated: false } });
    return route.fulfill({ status: 404, json: { error: "Unexpected fictional request." } });
  });
});
test.afterEach(async ({ page, baseURL }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  if (baseURL) await page.request.post(`${baseURL}/api/auth/logout`, { headers: { Origin: baseURL } });
});

for (const entry of ["/bills/manual", "/dashboard"]) {
  test(`${entry} keeps the legacy deal separate from a same-name billing job`, async ({ page }) => {
    const writes: string[] = [];
    page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/") && request.method() !== "GET") writes.push(request.url()); });
    await page.goto(entry);
    await find(page, sharedName);
    await expect(page.getByRole("link", { name: sourceLinkName, exact: true })).toHaveAttribute("href", `/jobs/crm/${legacyId}`);
    await expect(page.getByRole("link", { name: entry === "/dashboard"
      ? `View job ${newJobReference} for ${companies[0].name}` : `View job history ${newJobReference} for ${companies[0].name}`, exact: true }))
      .toHaveAttribute("href", `/jobs/${canonicalId}`);
    await expect(page.getByText("CRM deal · Read only", { exact: true })).toBeVisible();
    await expect(page.locator(`a[href="/jobs/${legacyId}"]`)).toHaveCount(0);
    await expect(page.locator(`a[href="/bills/new?jobId=${legacyId}"]`)).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`${entry}$`));
    await page.getByRole("link", { name: sourceLinkName, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/jobs/crm/${legacyId}$`));
    await expect(page.getByRole("heading", { name: sharedName, exact: true })).toBeVisible();
    await expect(page.getByText(`CRM DEAL · ${dealReference}`, { exact: true })).toBeVisible();
    await expect(page.getByText("Unassigned company", { exact: true })).toBeVisible();
    await expect(page.getByText("Bill history companies:", { exact: false })).toContainText(companies[0].name);
    await expect(page.getByRole("heading", { name: "Linked Zoho Books history", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open billing profile", exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Add bill", exact: true })).toHaveCount(0);
    expect(writes).toEqual([]);
    if (entry === "/bills/manual") {
      await page.screenshot({ path: ".local/screenshots/legacy-crm-history-fixture-desktop.png", fullPage: true, animations: "disabled" });
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: ".local/screenshots/legacy-crm-history-fixture-mobile.png", fullPage: true, animations: "disabled" });
    }
  });

  test(`${entry} bill number opens verified legacy history and original files`, async ({ page }) => {
    await page.route("**/api/dashboard/search?*", route => route.fulfill({ json: { ...searchResult(imported.billNumber), jobs: [legacy] } }));
    await page.goto(entry);
    await find(page, imported.billNumber);
    const link = page.getByRole("link", { name: billLinkName, exact: true });
    await expect(link).toHaveAttribute("href", `/jobs/crm/${legacyId}`);
    await link.click();
    const documents = page.getByLabel(`Attachments for ${imported.billNumber}`, { exact: true });
    await expect(documents.getByRole("link", { name: /^Open / })).toHaveAttribute("href",
      `/api/bills/books/${imported.id}/attachments/legacy-stored-original`);
    await expect(documents.getByRole("link", { name: /^Download / })).toHaveAttribute("href",
      `/api/bills/books/${imported.id}/attachments/legacy-stored-original?download=1`);
    await expect(page.getByRole("link", { name: "Open billing profile", exact: true })).toHaveCount(0);
    await expect(page.getByText(newJobReference, { exact: true })).toHaveCount(0);
  });

  test(`${entry} rejects a legacy history href pointing to a different source record`, async ({ page }) => {
    const response = searchResult(imported.billNumber);
    response.bills[0].relatedJobs![0].href = "/jobs/crm/foreign-source-snapshot";
    await page.route("**/api/dashboard/search?*", route => route.fulfill({ json: response }));
    await page.goto(entry);
    await find(page, imported.billNumber);
    await expect(page.getByText(entry === "/dashboard" ? "Search results did not match your selection. Search again."
      : "Search results could not be verified for your companies. Retry the search.", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: billLinkName, exact: true })).toHaveCount(0);
    await expect(page.locator('a[href="/jobs/crm/foreign-source-snapshot"]')).toHaveCount(0);
  });
}

test("dashboard company selection accepts only verified legacy history companies", async ({ page }) => {
  await page.route("**/api/dashboard/search?*", route => route.fulfill({ json: { ...searchResult(dealReference), jobs: [legacy], bills: [] } }));
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  const company = page.getByRole("combobox", { name: "Company", exact: true });
  await company.selectOption(companies[0].id);
  await find(page, dealReference);
  await expect(page.getByRole("link", { name: sourceLinkName, exact: true })).toBeVisible();
  await company.selectOption(companies[1].id);
  await find(page, dealReference);
  await expect(page.getByText("Search results did not match your selection. Search again.", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: sourceLinkName, exact: true })).toHaveCount(0);
});

test("legacy profile rejects originals outside its declared history companies", async ({ page }) => {
  await page.route(`**/api/jobs/crm/${legacyId}`, route => route.fulfill({ json: { job: { ...profile,
    booksBills: [{ ...imported, companyId: companies[1].id, companyName: companies[1].name }] } } }));
  await page.goto(`/jobs/crm/${legacyId}`);
  await expect(page.getByText("CRM history could not be verified for this record and its companies.", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Open Fictional legacy/ })).toHaveCount(0);
  await expect(page.getByText(companies[1].name, { exact: true })).toHaveCount(0);
});
