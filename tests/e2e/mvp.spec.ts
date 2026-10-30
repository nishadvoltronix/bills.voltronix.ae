import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import type { Bill, Company, Job, Vendor } from "../../src/components/types";

async function login(page: Page, role: "ADMIN" | "ACCOUNTS" = "ADMIN") {
  const email = process.env[`SEED_${role}_EMAIL`];
  const password = process.env[`SEED_${role}_PASSWORD`];
  if (!email || !password)
    throw new Error(
      "The local fictional seed credentials are required for browser tests.",
    );
  await page.goto("/login");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in to workspace" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(
    page.getByRole("heading", { name: "Finance overview" }),
  ).toBeVisible();
  await expect(
    page
      .locator(".metric-card")
      .getByText("Recognized expenses", { exact: true }),
  ).toBeVisible();
  // Presentation fixture only: read the authorized company IDs after real login,
  // then serve static display labels without requests during browser teardown.
  const response = await page.request.get("/api/companies");
  expect(response.ok()).toBe(true);
  const body = await response.json() as { companies: Company[] };
  const labels: Record<string, string> = {
    "demo-company-voltronix": "Fictional test company A",
    "demo-company-secondary": "Fictional test company B",
  };
  const companyFixture = { ...body, companies: body.companies.map((company) => ({
    ...company, name: labels[company.id] ?? company.name,
  })) };
  await page.route("**/api/companies", (route) => route.fulfill({ json: companyFixture }));
}

test("protected API routes reject anonymous and cross-origin requests", async ({
  request,
}) => {
  for (const route of [
    "/api/bills",
    "/api/jobs",
    "/api/vendors",
    "/api/dashboard",
    "/api/audit",
    "/api/integrations",
    "/api/documents/not-a-document",
    "/api/ocr",
    "/api/ocr/templates",
    "/api/operations",
    "/api/reports/bills",
    "/api/integrations/jobs",
  ]) {
    expect((await request.get(route)).status()).toBe(401);
  }
  const loginAttempt = await request.post("/api/auth/login", {
    headers: { Origin: "https://untrusted.invalid" },
    data: { email: "nobody@example.invalid", password: "invalid" },
  });
  expect(loginAttempt.status()).toBe(403);
});

test("desktop and mobile dashboards render live financial data", async ({
  page,
}) => {
  await mkdir(".local/screenshots", { recursive: true });
  await page.goto("/login");
  await page.getByLabel("Work email").fill("preview@example.invalid");
  await page.getByLabel("Work email").clear();
  await page.screenshot({
    path: ".local/screenshots/login-desktop.png",
    fullPage: true,
    caret: "initial",
    animations: "disabled",
  });
  await login(page);
  await expect(page.locator(".metric-value").first()).toContainText("AED");
  await expect(page.getByRole("link", { name: /Manual entry/ })).toBeVisible();
  await page.screenshot({
    path: ".local/screenshots/dashboard-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("heading", { name: "Finance overview" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(
    page.getByRole("link", { name: "Bills & expenses", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close menu" }).click();
  await page.screenshot({
    path: ".local/screenshots/dashboard-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
});

test("manual draft with private attachment is edited, saved ready and paid only on explicit action", async ({
  page,
}) => {
  await login(page);
  const invoiceNumber = `DEMO-E2E-${Date.now()}`;
  await page.goto("/bills/new");
  await page
    .getByRole("combobox", { name: "Company", exact: true })
    .selectOption("demo-company-voltronix");
  await page.getByRole("combobox", { name: "Vendor Name" }).fill("Meridian");
  await page.getByRole("option", { name: /^\[DEMO\] Meridian Materials/ }).click();
  await page.getByLabel("Bill#").fill(invoiceNumber);
  await page.getByLabel("Order Number").fill("DEMO-PO-BOOKS-101");
  await page
    .getByLabel("Description", { exact: true })
    .fill("[DEMO] Materials for the marina fit-out");
  await page.getByLabel("Bill Date").fill("2026-10-27");
  await page.getByLabel("Payment Terms").selectOption("NET_30");
  await expect(page.getByLabel("Due Date", { exact: true })).toHaveValue(
    "2026-11-26",
  );
  await page.getByLabel(/^Job \/ project/).selectOption("demo-job-marina");
  await page
    .getByLabel("Line 1 description")
    .fill("[DEMO] Browser workflow materials");
  await page.getByLabel("Line 1 quantity").fill("2");
  await page.getByLabel("Line 1 unit price").fill("12.50");
  await page.getByLabel("Invoice attachment").setInputFiles({
    name: "demo-invoice.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n% Fictional local test attachment\n%%EOF"),
  });
  await page.getByRole("button", { name: "Save as draft" }).click();
  await expect(page).toHaveURL(/\/bills\/[a-z0-9]+\?saved=1$/);
  const billPath = new URL(page.url()).pathname;
  await expect(
    page.getByRole("heading", { name: invoiceNumber }),
  ).toBeVisible();
  await expect(
    page.getByText("demo-invoice.pdf", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("[DEMO] Materials for the marina fit-out", { exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Edit bill", exact: true }).click();
  await expect(page.getByLabel("Order Number")).toHaveValue(
    "DEMO-PO-BOOKS-101",
  );
  await expect(page.getByLabel("Payment Terms")).toHaveValue("NET_30");
  await expect(page.getByLabel("Description", { exact: true })).toHaveValue(
    "[DEMO] Materials for the marina fit-out",
  );
  await page.getByLabel("Bill Date").fill("2026-10-28");
  await expect(page.getByLabel("Due Date", { exact: true })).toHaveValue(
    "2026-11-27",
  );
  await page.getByLabel("Due Date", { exact: true }).fill("2026-12-01");
  await expect(page.getByLabel("Payment Terms")).toHaveValue("CUSTOM");
  await page
    .getByLabel("Notes", { exact: true })
    .fill("[DEMO] Edited and verified by browser acceptance test.");
  await page.getByRole("button", { name: "Save and sync", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${billPath}\\?saved=1$`));
  await expect(page.getByText("Ready to sync", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Approve bill", exact: true }),
  ).toHaveCount(0);
  const { bill: ready } = await (await page.request.get(`/api${billPath}`)).json();
  expect(ready.status).toBe("READY");
  expect(ready.paidAmount).toBe("0.00");
  expect(ready.payments).toHaveLength(0);
  expect(ready.documents).toHaveLength(1);
  await expect(
    page.getByRole("button", { name: "Record payment", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Record payment", exact: true })
    .click();
  await page.getByLabel("Payment reference").fill(`DEMO-RECEIPT-${Date.now()}`);
  await page
    .getByRole("button", { name: "Confirm payment", exact: true })
    .click();
  await expect(page.getByText("Payment recorded successfully.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Record payment", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("bill payment", { exact: true })).toBeVisible();
  await page.goto("/bills");
  await page.getByLabel("Search bills").fill(invoiceNumber);
  await expect(
    page.getByRole("link", { name: invoiceNumber, exact: true }),
  ).toBeVisible();
});

test("Save and sync keeps a draft after attachment failure and finalizes only after retry succeeds", async ({ page }) => {
  await login(page);
  const invoiceNumber = `DEMO-ATTACHMENT-RETRY-${Date.now()}`;
  const original = Buffer.from("%PDF-1.4\n% Fictional delayed attachment\n%%EOF");
  let createdId = "";
  let creates = 0;
  let uploads = 0;
  const actions: unknown[] = [];
  await page.route("**/api/bills", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    creates++;
    expect(route.request().postDataJSON().submit).toBe(false);
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    const { bill } = await response.json();
    createdId = bill.id;
    expect(bill.status).toBe("DRAFT");
    await route.fulfill({ response });
  });
  await page.route(/\/api\/bills\/[^/]+\/attachment$/, async (route) => {
    uploads++;
    if (uploads === 1) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Fictional interrupted upload." }) });
      return;
    }
    await route.continue();
  });
  await page.route(/\/api\/bills\/[^/]+\/actions$/, async (route) => {
    const body = route.request().postDataJSON();
    actions.push(body);
    const { bill } = await (await page.request.get(`/api/bills/${createdId}`)).json();
    expect(body).toEqual({ action: "submit", version: bill.version });
    expect(bill.status).toBe("DRAFT");
    expect(bill.documents).toHaveLength(1);
    await route.continue();
  });
  await page.goto("/bills/new");
  await page.getByRole("combobox", { name: "Company", exact: true }).selectOption("demo-company-voltronix");
  await page.getByRole("combobox", { name: "Vendor Name" }).fill("Meridian");
  await page.getByRole("option", { name: /^\[DEMO\] Meridian Materials/ }).click();
  await page.getByLabel("Bill#").fill(invoiceNumber);
  await page.getByLabel("Bill Date").fill("2026-10-28");
  await page.getByLabel(/^Job \/ project/).selectOption("demo-job-marina");
  await page.getByLabel("Line 1 description").fill("Fictional upload recovery");
  await page.getByLabel("Line 1 quantity").fill("1");
  await page.getByLabel("Line 1 unit price").fill("10.00");
  await page.getByLabel("Invoice attachment").setInputFiles({ name: "DEMO-retry.pdf", mimeType: "application/pdf", buffer: original });
  await page.getByRole("button", { name: "Save and sync", exact: true }).click();
  await expect(page.getByText("Your draft was saved and has not been queued.", { exact: false })).toBeVisible();
  expect(creates).toBe(1);
  expect(actions).toEqual([]);
  const { bill: draft } = await (await page.request.get(`/api/bills/${createdId}`)).json();
  expect(draft.status).toBe("DRAFT");
  expect(draft.documents).toHaveLength(0);
  expect(draft.payments).toHaveLength(0);
  await page.getByRole("button", { name: "Retry attachment", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/bills/${createdId}\\?saved=1$`));
  await expect(page.getByText("Ready to sync", { exact: true })).toBeVisible();
  const { bill: ready } = await (await page.request.get(`/api/bills/${createdId}`)).json();
  expect(ready.status).toBe("READY");
  expect(ready.paidAmount).toBe("0.00");
  expect(ready.payments).toHaveLength(0);
  expect(ready.documents).toHaveLength(1);
  expect(creates).toBe(1);
  expect(uploads).toBe(2);
  expect(actions).toHaveLength(1);
  const downloaded = await page.request.get(`/api/documents/${ready.documents[0].id}`);
  expect(downloaded.ok()).toBe(true);
  expect(await downloaded.body()).toEqual(original);
  await expect(page.getByRole("button", { name: "Approve bill", exact: true })).toHaveCount(0);
});
test("a permanently rejected original can be replaced on the same draft before finalizing once", async ({ page }) => {
  await login(page);
  const companyId = "fictional-attachment-recovery-company";
  const vendor: Vendor = { id: "fictional-recovery-vendor", companyId, name: "Fictional recovery supplier", currency: "AED" };
  const job: Job = { id: "fictional-recovery-job", companyId, jobNumber: "FICTIONAL-RECOVERY", name: "Fictional recovery project",
    customer: "Fictional customer", currency: "AED", contractValue: "1000.00", approvedVariations: "0.00" };
  let current: Bill = { id: "fictional-replacement-bill", companyId, vendorId: vendor.id, jobId: job.id,
    invoiceNumber: "FICTIONAL-REPLACEMENT", invoiceDate: "2026-10-29", category: "MATERIALS", currency: "AED",
    status: "DRAFT", version: 1, discount: "0.00", vatRate: "5.00", subtotal: "10.00", vatAmount: "0.50", total: "10.50",
    paidAmount: "0.00", createdAt: "2026-10-29T08:00:00Z", vendor, job, documents: [], payments: [], syncRecords: [],
    lines: [{ description: "Fictional recovery line", quantity: "1", unitPrice: "10.00" }] };
  const validOriginal = "%PDF-1.4\n% Fictional replacement original\n%%EOF";
  let creates = 0, uploads = 0, secondUploadStarted = false;
  let releaseUpload!: () => void;
  const uploadGate = new Promise<void>(resolve => { releaseUpload = resolve; });
  const actions: unknown[] = [];
  const mutations: string[] = [];
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/") && request.method() !== "GET") mutations.push(path);
  });
  // All business requests below are mocked; no bill, attachment or provider is changed.
  await page.route("**/api/**", route => route.fulfill({ status: 422, json: { error: "Unexpected fictional request." } }));
  await page.route("**/api/companies", route => route.fulfill({ json: { companies: [{ id: companyId, name: "Fictional recovery company" }] } }));
  await page.route("**/api/jobs", route => route.fulfill({ json: { jobs: [job] } }));
  await page.route("**/api/integrations", route => route.fulfill({ json: { zoho: { organizations: [] } } }));
  await page.route("**/api/vendors/search?*", route => route.fulfill({ json: {
    companyId, organizationId: null, vendors: [vendor], selectedVendor: null, warning: null, hasMore: false,
  } }));
  await page.route("**/api/bills/options?*", route => route.fulfill({ json: {
    companyId, organizationId: null, dataCenter: null, environment: null, accounts: [], taxes: [], customers: [], hasMoreCustomers: false, warning: null,
  } }));
  await page.route("**/api/bills", route => {
    creates++;
    expect(route.request().postDataJSON()).toMatchObject({ companyId, vendorId: vendor.id, jobId: job.id, submit: false });
    return route.fulfill({ status: 201, json: { bill: current } });
  });
  await page.route(`**/api/bills/${current.id}`, route => route.fulfill({ json: { bill: current } }));
  await page.route(`**/api/bills/${current.id}/attachment`, async route => {
    uploads++;
    expect(route.request().headers()["x-bill-version"]).toBe("1");
    const multipart = route.request().postDataBuffer()!.toString("utf8");
    if (uploads === 1) {
      expect(multipart).toContain('filename="FICTIONAL-rejected.pdf"');
      return route.fulfill({ status: 415, json: { error: "The file content does not match its declared file type." } });
    }
    expect(multipart).toContain('filename="FICTIONAL-replacement.pdf"');
    expect(multipart).toContain(validOriginal);
    expect(multipart).not.toContain("Fictional invalid original");
    secondUploadStarted = true;
    await uploadGate;
    current = { ...current, version: 2, documents: [{ id: "fictional-replacement-document", fileName: "FICTIONAL-replacement.pdf" }] };
    return route.fulfill({ status: 201, json: { document: { billVersion: 2, alreadyAttached: false } } });
  });
  await page.route(`**/api/bills/${current.id}/actions`, route => {
    const body = route.request().postDataJSON();
    actions.push(body);
    expect(body).toEqual({ action: "submit", version: 2 });
    expect(current.status).toBe("DRAFT");
    expect(current.documents).toHaveLength(1);
    current = { ...current, status: "READY", version: 3 };
    return route.fulfill({ json: { bill: current } });
  });
  try {
    await page.goto("/bills/new");
    await page.getByRole("combobox", { name: "Company", exact: true }).selectOption(companyId);
    await page.getByRole("combobox", { name: "Vendor Name", exact: true }).fill(vendor.name);
    await page.getByRole("option", { name: /^Fictional recovery supplier/ }).click();
    await page.getByLabel("Bill#").fill(current.invoiceNumber);
    await page.getByLabel("Bill Date").fill("2026-10-29");
    await page.getByLabel(/^Job \/ project/).selectOption(job.id);
    await page.getByLabel("Line 1 description").fill("Fictional recovery line");
    await page.getByLabel("Line 1 unit price").fill("10.00");
    await page.getByLabel("Invoice attachment", { exact: true }).setInputFiles({ name: "FICTIONAL-rejected.pdf",
      mimeType: "application/pdf", buffer: Buffer.from("Fictional invalid original") });
    await page.getByRole("button", { name: "Save and sync", exact: true }).click();
    await expect(page.getByText(/Your draft was saved and has not been queued/)).toBeVisible();
    await expect(page.getByText("FICTIONAL-rejected.pdf", { exact: true })).toBeVisible();
    expect(creates).toBe(1);
    expect(actions).toEqual([]);
    const replacement = page.getByLabel("Replacement invoice attachment", { exact: true });
    await replacement.setInputFiles({ name: "FICTIONAL-replacement.pdf", mimeType: "application/pdf", buffer: Buffer.from(validOriginal) });
    await expect(page.getByText("FICTIONAL-replacement.pdf", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Retry attachment", exact: true }).click();
    await expect.poll(() => secondUploadStarted).toBe(true);
    await expect(replacement).toBeDisabled();
    expect(actions).toEqual([]);
    releaseUpload();
    await expect(page).toHaveURL(new RegExp(`/bills/${current.id}\\?saved=1$`));
    await expect(page.getByText("Ready to sync", { exact: true })).toBeVisible();
    expect(creates).toBe(1);
    expect(uploads).toBe(2);
    expect(actions).toEqual([{ action: "submit", version: 2 }]);
    expect(current).toMatchObject({ status: "READY", paidAmount: "0.00", payments: [], documents: [{ fileName: "FICTIONAL-replacement.pdf" }] });
    expect(mutations).toEqual(["/api/bills", `/api/bills/${current.id}/attachment`, `/api/bills/${current.id}/attachment`, `/api/bills/${current.id}/actions`]);
  } finally { releaseUpload(); }
});

test("New Bill layout preserves job selection and fits desktop and mobile", async ({
  page,
}) => {
  await login(page);
  await page.goto("/bills/new?jobId=demo-job-marina");
  await expect(
    page.getByRole("heading", { name: "New Bill", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel(/^Job \/ project/)).toHaveValue(
    "demo-job-marina",
  );
  await expect(page.getByLabel("Vendor Name")).toBeEnabled();
  await expect(
    page.getByRole("columnheader", { name: "Item Details" }),
  ).toBeVisible();
  await expect(
    page.getByRole("columnheader", { name: "Rate", exact: true }),
  ).toBeVisible();
  await mkdir(".local/screenshots", { recursive: true });
  await page.screenshot({
    path: ".local/screenshots/new-bill-desktop.png",
    fullPage: true,
    animations: "disabled",
    caret: "initial",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await expect(page.getByLabel("Payment Terms")).toBeVisible();
  await page
    .getByRole("button", { name: "Save as draft" })
    .scrollIntoViewIfNeeded();
  await expect(
    page.getByRole("button", { name: "Save and sync", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: ".local/screenshots/new-bill-mobile.png",
    fullPage: true,
    animations: "disabled",
    caret: "initial",
  });
});

test("management reports and account security work without integration setup UI", async ({
  page,
}) => {
  await login(page);
  await page.goto("/management");
  await expect(
    page.getByRole("heading", { name: "Expense report", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Highest expense jobs" }),
  ).toBeVisible();
  await page.getByLabel("From invoice date").fill("2026-10-01");
  await page.getByLabel("To invoice date").fill("2026-10-31");
  await page.getByLabel("Report category").selectOption("MATERIALS");
  await expect(page.getByLabel("From invoice date")).toHaveValue("2026-10-01");
  await expect(page.getByLabel("To invoice date")).toHaveValue("2026-10-31");
  await expect(
    page.getByRole("heading", { name: "Matching bills" }),
  ).toBeVisible();
  const exportUrl = await page
    .getByRole("link", { name: "Export CSV for Excel" })
    .getAttribute("href");
  const exported = await page.request.get(exportUrl!);
  expect(exportUrl).toContain("from=2026-10-01");
  expect(exportUrl).toContain("to=2026-10-31");
  expect(exported.status()).toBe(200);
  expect(exported.headers()["content-type"]).toContain("text/csv");
  expect(await exported.text()).toContain('"Recognized cost excluding VAT"');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: ".local/screenshots/management-report-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.locator(".expense-report > .form-card").screenshot({
    path: ".local/screenshots/management-report-filters-mobile.png",
  });
  await expect(page.locator('a[href="/integrations"]')).toHaveCount(0);
  await page.goto("/integrations");
  await expect(page).toHaveURL(/\/bills$/);
  await expect(page.getByRole("heading", { name: "Bills & expenses", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Authorize Zoho|Verify and save mapping/ })).toHaveCount(0);
  const readinessResponse = await page.request.get("/api/integrations");
  expect(readinessResponse.status()).toBe(200);
  const readiness = await readinessResponse.json();
  expect(readiness.zoho.writeEnabled).toBe(false);
  expect(readiness.crm.writeEnabled).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.goto("/account");
  await expect(
    page.getByLabel("Current password", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Confirm new password", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Update password and sign out" }),
  ).toBeVisible();
});
