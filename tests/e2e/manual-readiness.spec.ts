import { expect, test, type Page } from "@playwright/test";

const companyA = "readiness-company-a";
const companyB = "readiness-company-b";

async function openManualForm(page: Page) {
  await page.route("**/api/companies", (route) => route.fulfill({
    json: { companies: [{ id: companyA, name: "Fictional company A" }, { id: companyB, name: "Fictional company B" }] },
  }));
  await page.route("**/api/vendors/search?*", (route) => {
    const companyId = new URL(route.request().url()).searchParams.get("companyId");
    return route.fulfill({ json: { companyId, organizationId: null,
      vendors: companyId === companyA ? [{ id: "vendor-usd", companyId: companyA, name: "Fictional USD supplier", currency: "USD" }] : [],
      selectedVendor: null, warning: null, hasMore: false } });
  });
  await page.route("**/api/jobs", (route) => route.fulfill({
    json: { jobs: [{ id: "job-aed", companyId: companyA, jobNumber: "FICTIONAL-1", name: "Fictional AED job", customer: "Fictional customer", currency: "AED" }] },
  }));
  await page.goto("/bills/new");
  await expect(page.getByRole("heading", { name: "New Bill", exact: true })).toBeVisible();
}

test.beforeEach(async ({ page, baseURL }) => {
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password || !baseURL) throw new Error("Local seed credentials and browser origin are required.");
  const login = await page.request.post(`${baseURL}/api/auth/login`, {
    headers: { Origin: baseURL }, data: { email, password },
  });
  expect(login.status()).toBe(200);
});

test.afterEach(async ({ page, baseURL }) => {
  if (baseURL) await page.request.post(`${baseURL}/api/auth/logout`, { headers: { Origin: baseURL } });
});

test("disabled OCR leaves typed entry and Books synchronization available", async ({ page }) => {
  test.skip(process.env.MANUAL_ENTRY_ONLY === "true" || process.env.OCR_PROVIDER !== "disabled" ||
    process.env.SCANNER_IMPORT_ENABLED === "true", "Requires typed entry with OCR and scanner disabled.");
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Finance overview", exact: true })).toBeVisible();
  await expect(page.locator('a[href="/ocr"], a[href="/ocr/batch"]')).toHaveCount(0);
  await expect(page.getByText("OCR awaiting review", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Synchronization attention", exact: true })).toBeVisible();
  await expect(page.getByText("Synchronization failures", { exact: true })).toBeVisible();
  await page.route("**/api/integrations", route => route.fulfill({ json: { zoho: { organizations: [] } } }));
  await openManualForm(page);
  await page.getByRole("combobox", { name: "Company", exact: true }).selectOption(companyA);
  await expect(page.getByRole("button", { name: "Save and sync", exact: true })).toBeEnabled();
  await expect(page.getByLabel("Books synchronization readiness")).toBeVisible();
});

test("manual form scopes Books readiness to company and preserves local saving", async ({ page }) => {
  await page.route("**/api/integrations", (route) => route.fulfill({
    json: { zoho: { organizations: [
      { organizationId: "101", companyId: companyA, name: "Fictional Books A", status: "AUTHORIZED_UNVERIFIED", connected: false, writeEnabled: false, postingMissing: ["LIVE_OPERATIONAL_ENVIRONMENT", "LIVE_COMPANY_VERIFICATION"] },
      { organizationId: "102", companyId: companyB, name: "Fictional Books B", status: "AUTHORIZED_UNVERIFIED", connected: false, writeEnabled: true },
    ] } },
  }));
  await openManualForm(page);
  const company = page.getByRole("combobox", { name: "Company", exact: true });
  const readiness = page.getByLabel("Books synchronization readiness");
  await company.selectOption(companyA);
  await expect(readiness).toContainText("Books sync is unavailable for Fictional Books A");
  await expect(readiness).toContainText("configure this deployment for live Books synchronization");
  await expect(readiness).not.toContainText("Fictional Books B");
  await expect(page.getByRole("button", { name: "Save as draft", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Save and sync", exact: true })).toBeEnabled();
  await company.selectOption(companyB);
  await expect(readiness).toContainText("Posting is enabled for Fictional Books B");
  await expect(readiness).toContainText("attempt to queue the completed bill");
  await expect(readiness).toContainText("only after Zoho Books confirms it");
  await expect(readiness).not.toContainText("Fictional Books A");
  await page.getByLabel("Discount amount").fill("2.50");
  await expect(page.getByText("Discounted bills can be saved locally", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save as draft", exact: true })).toBeEnabled();
});

test("unassigned and ambiguous Books destinations explain the next step", async ({ page }) => {
  await page.route("**/api/integrations", (route) => route.fulfill({
    json: { zoho: { organizations: [
      { organizationId: "101", companyId: companyB, name: "Fictional Books B1", writeEnabled: true },
      { organizationId: "102", companyId: companyB, name: "Fictional Books B2", writeEnabled: true },
    ] } },
  }));
  await openManualForm(page);
  const company = page.getByRole("combobox", { name: "Company", exact: true });
  await company.selectOption(companyA);
  await expect(page.getByLabel("Books synchronization readiness")).toContainText("assign its Books destination");
  await company.selectOption(companyB);
  await expect(page.getByLabel("Books synchronization readiness")).toContainText("select the intended Books organization on the saved bill");
});

test("Books setup lookup can retry without blocking a local draft", async ({ page }) => {
  let checks = 0;
  let recovered = false;
  await page.route("**/api/integrations", (route) => {
    checks++;
    return !recovered
      ? route.fulfill({ status: 503, json: { error: "Fictional setup lookup failure." } })
      : route.fulfill({ json: { zoho: { organizations: [] } } });
  });
  await openManualForm(page);
  await page.getByRole("combobox", { name: "Company", exact: true }).selectOption(companyA);
  await expect(page.getByLabel("Books synchronization readiness")).toContainText("Books setup could not be checked");
  await expect(page.getByRole("button", { name: "Save as draft", exact: true })).toBeEnabled();
  const initialChecks = checks;
  recovered = true;
  await page.getByRole("button", { name: "Retry Books setup check" }).click();
  await expect(page.getByLabel("Books synchronization readiness")).toContainText("assign its Books destination");
  expect(checks).toBeGreaterThan(initialChecks);
});

test("company lookup retry preserves the job's company and entered invoice values", async ({ page }) => {
  // Authentication is real; all business responses are fictional and no writes
  // can reach the application while this form-recovery behavior is exercised.
  await page.route("**/api/**", (route) => route.fulfill({ status: 422, json: { error: "Unexpected fixture request; no data changed." } }));
  const job = { id: "readiness-prefilled-job", companyId: companyB, jobNumber: "FICTIONAL-PREFILLED",
    name: "Fictional prefilled job", customer: "Fictional customer", currency: "USD", contractValue: "1000.00", approvedVariations: "0.00" };
  let companyReads = 0;
  let recovered = false;
  await page.route("**/api/companies", (route) => {
    companyReads++;
    return recovered
      ? route.fulfill({ json: { companies: [
        { id: companyA, name: "Fictional company A" },
        { id: companyB, name: "[CONNECTION CHECK] Fictional company B" },
        { id: "readiness-hidden-demo", name: "[DEMO] Hidden fictional company" },
      ] } })
      : route.fulfill({ status: 503, json: { error: "Fictional company lookup failure." } });
  });
  await page.route(`**/api/jobs/${job.id}`, (route) => route.fulfill({ json: { job } }));
  await page.route("**/api/jobs", (route) => route.fulfill({ json: { jobs: [] } }));
  await page.route("**/api/integrations", (route) => route.fulfill({ json: { zoho: { organizations: [] } } }));
  await page.route("**/api/vendors/search?*", (route) => route.fulfill({ json: {
    companyId: companyB, organizationId: null, vendors: [], selectedVendor: null, warning: null, hasMore: false,
  } }));
  await page.route("**/api/bills/options?*", (route) => route.fulfill({ json: {
    companyId: companyB, organizationId: null, dataCenter: null, environment: null,
    accounts: [], taxes: [], customers: [], warning: null, hasMoreCustomers: false,
  } }));
  await page.goto(`/bills/new?jobId=${job.id}`);
  await expect(page.getByText("Fictional company lookup failure.", { exact: true })).toBeVisible();
  await expect(page.getByLabel(/^Job \/ project/)).toHaveValue(job.id);
  await expect(page.getByLabel("Currency", { exact: true })).toHaveValue("USD");
  await page.getByLabel("Bill#").fill("FICTIONAL-RETRY-COMPANIES");
  await page.getByLabel("Bill Date").fill("2026-10-29");
  await page.getByLabel("Line 1 description").fill("Preserve this fictional invoice line");
  await page.getByLabel("Line 1 unit price").fill("37.50");
  const initialReads = companyReads;
  recovered = true;
  const retry = page.getByRole("button", { name: "Retry companies", exact: true });
  await expect(retry).toHaveAttribute("type", "button");
  await retry.click();
  const company = page.getByRole("combobox", { name: "Company", exact: true });
  await expect(company).toHaveValue(companyB);
  await expect(company.locator("option:checked")).toHaveText("Fictional company B");
  await expect(company.locator('option[value="readiness-hidden-demo"]')).toHaveCount(0);
  await expect(page.getByText("Fictional company lookup failure.", { exact: true })).toHaveCount(0);
  await expect(retry).toHaveCount(0);
  await expect(page.getByLabel(/^Job \/ project/)).toHaveValue(job.id);
  await expect(page.getByLabel("Currency", { exact: true })).toHaveValue("USD");
  await expect(page.getByLabel("Bill#")).toHaveValue("FICTIONAL-RETRY-COMPANIES");
  await expect(page.getByLabel("Bill Date")).toHaveValue("2026-10-29");
  await expect(page.getByLabel("Line 1 description")).toHaveValue("Preserve this fictional invoice line");
  await expect(page.getByLabel("Line 1 unit price")).toHaveValue("37.50");
  expect(companyReads).toBeGreaterThan(initialReads);
});

test("vendor currency mismatch is caught before creating a bill", async ({ page }) => {
  await page.route("**/api/integrations", (route) => route.fulfill({ json: { zoho: { organizations: [] } } }));
  let creates = 0;
  await page.route("**/api/bills", (route) => {
    if (route.request().method() === "POST") creates++;
    return route.fulfill({ status: 422, json: { error: "No test bill should be created." } });
  });
  await openManualForm(page);
  await page.getByRole("combobox", { name: "Company", exact: true }).selectOption(companyA);
  await page.getByRole("combobox", { name: "Vendor Name" }).fill("Fictional USD");
  await page.getByRole("option", { name: /^Fictional USD supplier/ }).click();
  await page.getByLabel(/^Job \/ project/).selectOption("job-aed");
  await expect(page.getByText("The selected vendor uses USD.", { exact: false })).toBeVisible();
  await page.getByLabel("Bill#").fill("FICTIONAL-NOT-SAVED");
  await page.getByLabel("Bill Date").fill("2026-10-29");
  await page.getByLabel("Line 1 description").fill("Fictional validation only");
  await page.getByLabel("Line 1 unit price").fill("10.00");
  await page.getByRole("button", { name: "Save as draft", exact: true }).click();
  await expect(page.getByText("Bill, vendor and job currencies must match. Currency conversion is not configured.", { exact: true })).toBeVisible();
  expect(creates).toBe(0);
});
