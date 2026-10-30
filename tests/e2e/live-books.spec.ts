import { test, expect, type Page } from "@playwright/test";
import type { Bill } from "../../src/components/types";

// Every Books response is mocked. These tests never call a provider or enable live writes.
const billId = "mock-live-approved-bill";
const companyId = "mock-live-company";
const firstOrganization = "820000000001";
const secondOrganization = "820000000002";
const json = (value: unknown) => ({
  contentType: "application/json",
  body: JSON.stringify(value),
});

function fixtureBill(): Bill & { syncRecords: NonNullable<Bill["syncRecords"]> } {
  return {
    id: billId,
    companyId,
    invoiceNumber: "DEMO-LIVE-PREVIEW",
    invoiceDate: "2026-10-28",
    dueDate: "2026-11-27",
    paymentTerms: "NET_30",
    vendorId: "mock-live-vendor",
    jobId: "mock-live-job",
    category: "MATERIALS",
    currency: "AED",
    status: "READY",
    paymentStatus: "UNPAID",
    version: 4,
    subtotal: "100.00",
    discount: "0.00",
    vatRate: "5.00",
    vatAmount: "5.00",
    total: "105.00",
    paidAmount: "0.00",
    outstanding: "105.00",
    createdAt: "2026-10-28T06:00:00Z",
    createdBy: {
      id: "mock-independent-author",
      name: "Fictional Author",
      email: "fictional@example.invalid",
      role: "DATA_ENTRY",
    },
    vendor: {
      id: "mock-live-vendor",
      companyId,
      name: "Fictional Preview Supplier",
      currency: "AED",
    },
    job: {
      id: "mock-live-job",
      companyId,
      jobNumber: "DEMO-LIVE-JOB",
      name: "Fictional Job",
      customer: "Fictional Customer",
      contractValue: "1000.00",
      approvedVariations: "0.00",
      currency: "AED",
    },
    lines: [
      {
        id: "mock-live-line",
        description: "Fictional materials",
        quantity: "1",
        unitPrice: "100.00",
        lineTotal: "100.00",
      },
    ],
    documents: [{ id: "mock-live-original", fileName: "DEMO-original.pdf" }],
    payments: [],
    auditLogs: [],
    syncRecords: [
      {
        id: "mock-live-sync",
        target: "ZOHO",
        status: "NOT_CONFIGURED",
        organizationId: null as string | null,
      },
    ],
  };
}

async function setup(page: Page) {
  if (!process.env.SEED_ADMIN_EMAIL || !process.env.SEED_ADMIN_PASSWORD)
    throw new Error("Local fictional admin seed credentials are required.");
  await page.goto("/login");
  await page.getByLabel("Work email").fill(process.env.SEED_ADMIN_EMAIL);
  await page
    .getByLabel("Password", { exact: true })
    .fill(process.env.SEED_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in to workspace" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.route("**/api/integrations", (route) =>
    route.fulfill(
      json({
        zoho: {
          status: "CONFIGURED_UNVERIFIED",
          connected: false,
          message:
            "Fictional live readiness; all accounting responses are mocked.",
          organizations: [firstOrganization, secondOrganization].map(
            (organizationId) => ({
              organizationId,
              companyId,
              name:
                organizationId === firstOrganization
                  ? "Fictional Live Alpha"
                  : "Fictional Live Beta",
              dataCenter: "EU",
              environment: "production",
              status: "CONFIGURED_UNVERIFIED",
              connected: false,
              writeEnabled: true,
              message:
                "Mock readiness only. The configured company and operational write gates are still enforced.",
            }),
          ),
        },
        crm: { status: "NOT_CONFIGURED", message: "Mocked CRM setup." },
      }),
    ),
  );
  const bill = fixtureBill();
  await page.route(`**/api/bills/${billId}`, (route) =>
    route.fulfill(json({ bill })),
  );
  return bill;
}

test("mocked READY bill queues to its selected live Books destination without approval or preview", async ({ page }) => {
  const bill = await setup(page);
  const writes: { path: string; body: unknown }[] = [];
  await page.route(`**/api/bills/${billId}/sync`, async (route) => {
    const body = route.request().postDataJSON();
    writes.push({ path: new URL(route.request().url()).pathname, body });
    expect(body).toEqual({ target: "ZOHO", organizationId: firstOrganization });
    bill.syncRecords[0].status = "PENDING";
    bill.syncRecords[0].organizationId = firstOrganization;
    await route.fulfill({ status: 202, ...json({ job: { id: "mock-live-queue", status: "QUEUED", target: "ZOHO", organizationId: firstOrganization } }) });
  });
  const forbidden: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/(actions|preview|approve)$/.test(new URL(request.url()).pathname))
      forbidden.push(request.url());
  });
  await page.goto(`/bills/${billId}`);
  const selector = page.getByLabel("Books organization", { exact: true });
  const queue = page.getByRole("button", { name: "Queue Zoho Books sync", exact: true });
  await expect(selector).toHaveValue("");
  await expect(queue).toBeDisabled();
  await expect(page.getByText("Ready to sync", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Approve bill|Confirm live bill|Preview live/ })).toHaveCount(0);
  await selector.selectOption(firstOrganization);
  expect(writes).toEqual([]);
  await queue.click();
  await expect(page.getByText("Zoho Books synchronization queued.", { exact: false })).toBeVisible();
  await expect(selector).toBeDisabled();
  expect(writes).toEqual([{ path: `/api/bills/${billId}/sync`, body: { target: "ZOHO", organizationId: firstOrganization } }]);
  expect(forbidden).toEqual([]);
  expect(bill.paidAmount).toBe("0.00");
  expect(bill.payments).toEqual([]);
  await page.reload();
  await expect(selector).toHaveValue(firstOrganization);
  await expect(selector).toBeDisabled();
  expect(writes).toHaveLength(1);
});

test("mocked legacy approved bill can queue directly while retaining its historical status", async ({ page }) => {
  const bill = await setup(page);
  bill.status = "APPROVED";
  const queued: unknown[] = [];
  await page.route(`**/api/bills/${billId}/sync`, async (route) => {
    queued.push(route.request().postDataJSON());
    bill.syncRecords[0].status = "PENDING";
    bill.syncRecords[0].organizationId = secondOrganization;
    await route.fulfill({ status: 202, ...json({ job: { id: "mock-legacy-queue", status: "QUEUED", target: "ZOHO", organizationId: secondOrganization } }) });
  });
  await page.goto(`/bills/${billId}`);
  await page.getByLabel("Books organization", { exact: true }).selectOption(secondOrganization);
  await page.getByRole("button", { name: "Queue Zoho Books sync", exact: true }).click();
  await expect(page.getByText("Zoho Books synchronization queued.", { exact: false })).toBeVisible();
  expect(queued).toEqual([{ target: "ZOHO", organizationId: secondOrganization }]);
  await expect(page.getByText("Approved (legacy)", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Approve bill|Confirm live bill|Preview live/ })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(bill.payments).toEqual([]);
});

test("mocked direct Books queue preserves the saved bill and reports blocked readiness", async ({ page }) => {
  const bill = await setup(page);
  let queued = 0;
  await page.route(`**/api/bills/${billId}/sync`, (route) => {
    queued++;
    expect(route.request().postDataJSON()).toEqual({ target: "ZOHO", organizationId: firstOrganization });
    return route.fulfill({ status: 409, ...json({ error: "Live posting is disabled for this application. Complete verified company routing and production readiness first." }) });
  });
  await page.goto(`/bills/${billId}`);
  await page.getByLabel("Books organization", { exact: true }).selectOption(firstOrganization);
  await page.getByRole("button", { name: "Queue Zoho Books sync", exact: true }).click();
  await expect(page.getByText("Live posting is disabled for this application.", { exact: false })).toBeVisible();
  await expect(page.getByText("Ready to sync", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Approve bill|Confirm live bill|Preview live/ })).toHaveCount(0);
  expect(queued).toBe(1);
  expect(bill.status).toBe("READY");
  expect(bill.payments).toEqual([]);
});

test("saved manual bill reports blocked synchronization instead of implying provider success", async ({ page }) => {
  const bill = await setup(page);
  bill.syncRecords[0].status = "FAILED";
  bill.syncRecords[0].lastError = "Connect this company's Books account before synchronization.";
  await page.goto(`/bills/${billId}?saved=1`);
  const notice = page.getByRole("alert").filter({ hasText: "Bill saved, but it has not synchronized with Zoho Books." });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(bill.syncRecords[0].lastError);
  await expect(page.getByText("Bill saved and synchronized with Zoho Books.", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Refresh sync status", exact: true })).toBeEnabled();
});

test("pending synchronization refreshes to provider confirmation without losing an open payment form", async ({ page }) => {
  const bill = await setup(page);
  bill.syncRecords[0].status = "PENDING";
  bill.syncRecords[0].organizationId = firstOrganization;
  await page.goto(`/bills/${billId}?saved=1`);
  await expect(page.getByText("Bill saved. Zoho Books synchronization queued. Provider confirmation is pending.")).toBeVisible();
  await page.getByRole("button", { name: "Record payment", exact: true }).click();
  await page.getByLabel("Payment reference").fill("UNSAVED-REFERENCE");
  bill.syncRecords[0].status = "SYNCED";
  bill.syncRecords[0].externalId = "mock-confirmed-books-bill";
  await expect(page.getByText("Bill saved and synchronized with Zoho Books.", { exact: true })).toBeVisible({ timeout: 12000 });
  await expect(page.getByText("mock-confirmed-books-bill", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Payment reference")).toHaveValue("UNSAVED-REFERENCE");
  await expect(page.getByText("Provider confirmation is pending.", { exact: false })).toHaveCount(0);
  expect(bill.payments).toEqual([]);
});

test("refresh failure keeps saved bill visible and manual refresh recovers attachment status", async ({ page }) => {
  const bill = await setup(page);
  bill.syncRecords[0].status = "FAILED";
  bill.syncRecords[0].externalId = "mock-existing-books-bill";
  bill.syncRecords[0].lastError = "Attachment delivery is incomplete.";
  await page.goto(`/bills/${billId}?saved=1`);
  await expect(page.getByText("Bill created in Zoho Books, but synchronization is incomplete.", { exact: false })).toBeVisible();
  await page.route(`**/api/bills/${billId}`, (route) => route.fulfill({ status: 503, ...json({error:"Temporary status error."}) }));
  await page.getByRole("button", { name: "Refresh sync status", exact: true }).click();
  await expect(page.getByRole("alert").filter({hasText:"Status could not be refreshed."})).toBeVisible();
  await expect(page.getByText("Bill created in Zoho Books, but synchronization is incomplete.", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: bill.invoiceNumber, exact: true })).toBeVisible();
  bill.syncRecords[0].status = "SYNCED";
  bill.syncRecords[0].lastError = null;
  await page.route(`**/api/bills/${billId}`, (route) => route.fulfill(json({bill})));
  await page.getByRole("button", { name: "Refresh sync status", exact: true }).click();
  await expect(page.getByText("Bill saved and synchronized with Zoho Books.", { exact: true })).toBeVisible();
  await expect(page.getByText("Status could not be refreshed.", { exact: false })).toHaveCount(0);
});

test("refresh clears financial details when company access has been revoked", async ({ page }) => {
  const bill = await setup(page);
  await page.goto(`/bills/${billId}`);
  await expect(page.getByRole("heading", { name: bill.invoiceNumber, exact: true })).toBeVisible();
  await page.route(`**/api/bills/${billId}`, (route) => route.fulfill({ status: 403, ...json({error:"Company access has been revoked."}) }));
  await page.getByRole("button", { name: "Refresh sync status", exact: true }).click();
  await expect(page.getByText("Company access has been revoked.", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: bill.invoiceNumber, exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Record payment", exact: true })).toHaveCount(0);
});

test("polling lets a slow status request finish before starting another", async ({ page }) => {
  const bill = await setup(page);
  bill.syncRecords[0].status = "PENDING";
  let reads = 0;
  await page.route(`**/api/bills/${billId}`, async (route) => {
    reads++;
    if (reads > 1) {
      await new Promise((resolve) => setTimeout(resolve, 6500));
      bill.syncRecords[0].status = "SYNCED";
      bill.syncRecords[0].externalId = "mock-slow-confirmation";
    }
    await route.fulfill(json({bill}));
  });
  await page.goto(`/bills/${billId}?saved=1`);
  await expect(page.getByText("Bill saved and synchronized with Zoho Books.", { exact: true })).toBeVisible({timeout:20000});
  expect(reads).toBe(2);
});

test("failed posting retries its existing operation without creating another bill", async ({ page }) => {
  const bill = await setup(page);
  bill.syncRecords[0].status = "FAILED";
  bill.syncRecords[0].organizationId = firstOrganization;
  bill.integrationJobs = [{ id: "mock-retry-operation", organizationId: firstOrganization,
    operation: "CREATE_BILL", status: "FAILED", needsReconciliation: false, attempts: 5,
    nextAttemptAt: "2026-10-30T06:00:00Z", externalId: null, lastError: "Temporary Books failure." }];
  const writes: string[] = [];
  page.on("request", (request) => { if (request.method() === "POST") writes.push(new URL(request.url()).pathname); });
  await page.route("**/api/integrations/jobs/mock-retry-operation", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ action: "retry", organizationId: firstOrganization });
    bill.integrationJobs![0].status = "QUEUED";
    bill.syncRecords[0].status = "PENDING";
    await route.fulfill(json({ job: { id: "mock-retry-operation", status: "QUEUED", needsReconciliation: false } }));
  });
  await page.goto(`/bills/${billId}`);
  await expect(page.getByRole("button", { name: "Queue Zoho Books sync", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Retry Zoho Books sync", exact: true }).click();
  await expect(page.getByText("Zoho Books retry queued for the existing operation.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry Zoho Books sync", exact: true })).toHaveCount(0);
  expect(writes).toEqual(["/api/integrations/jobs/mock-retry-operation"]);
  expect(bill.payments).toEqual([]);
});

test("unknown posting permits reconciliation only and polls its read result", async ({ page }) => {
  const bill = await setup(page);
  bill.syncRecords[0].status = "UNKNOWN";
  bill.syncRecords[0].organizationId = firstOrganization;
  bill.integrationJobs = [{ id: "mock-uncertain-operation", organizationId: firstOrganization,
    operation: "CREATE_BILL", status: "UNKNOWN", needsReconciliation: true, attempts: 1,
    nextAttemptAt: "2026-10-30T06:00:00Z", externalId: null, lastError: "The response was lost." }];
  const writes: string[] = [];
  page.on("request", (request) => { if (request.method() === "POST") writes.push(new URL(request.url()).pathname); });
  await page.route("**/api/integrations/jobs/mock-uncertain-operation", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ action: "reconcile", organizationId: firstOrganization });
    bill.integrationJobs![0].status = "QUEUED";
    await route.fulfill(json({ job: { id: "mock-uncertain-operation", status: "QUEUED", needsReconciliation: true } }));
  });
  await page.goto(`/bills/${billId}?saved=1`);
  await expect(page.getByRole("button", { name: /Retry Zoho Books sync|Queue Zoho Books sync/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Reconcile Zoho Books outcome", exact: true }).click();
  await expect(page.getByText("Zoho Books reconciliation queued.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reconcile Zoho Books outcome", exact: true })).toHaveCount(0);
  bill.integrationJobs![0].status = "SUCCEEDED";
  bill.integrationJobs![0].needsReconciliation = false;
  bill.syncRecords[0].status = "SYNCED";
  bill.syncRecords[0].externalId = "mock-reconciled-books-bill";
  await expect(page.getByText("mock-reconciled-books-bill", { exact: true })).toBeVisible({ timeout: 12000 });
  expect(writes).toEqual(["/api/integrations/jobs/mock-uncertain-operation"]);
  expect(bill.payments).toEqual([]);
});
