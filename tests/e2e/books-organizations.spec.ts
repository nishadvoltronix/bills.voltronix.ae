import { test, expect, type Page } from "@playwright/test";

// All organization/readiness/accounting responses are fictional browser mocks.
// Only the existing local seeded sign-in and normal application shell are real.
const alphaId = "810000000001";
const betaId = "810000000002";
const alphaName = "Fictional Books Alpha";
const betaName = "Fictional Books Beta";
const otherCompanyId = "820000000003";
const billId = "mock-organization-approved-bill";
const companyId = "mock-authorized-company";
const json = (value: unknown) => ({
  contentType: "application/json",
  body: JSON.stringify(value),
});
const authorization = {
  callbackUrl: `${process.env.APP_URL}/api/integrations/oauth/zoho/callback`,
  networkEnabled: true,
  encryptionKeyReady: true,
  missing: [],
  canAuthorize: true,
  reason: null,
};
function readiness() {
  return {
    ocr: {
      status: "NOT_CONFIGURED",
      configured: false,
      connected: false,
      message: "Mocked OCR setup state.",
    },
    zoho: {
      status: "CONFIGURED_UNVERIFIED",
      connected: false,
      configured: true,
      writeEnabled: false,
      requiresOrganizationSelection: true,
      message:
        "Select one fictional Books destination. These are browser fixtures.",
      authorization,
      missing: [],
      postingMissing: [],
      organizations: [
        {
          organizationId: otherCompanyId,
          companyId: "mock-other-company",
          name: "Fictional Other Company Books",
          writeEnabled: true,
          authorization,
        },
        {
          organizationId: alphaId,
          companyId,
          name: alphaName,
          dataCenter: "EU",
          environment: "production",
          status: "CONFIGURED_UNVERIFIED",
          configured: true,
          connected: false,
          authorized: false,
          writeEnabled: false,
          authorization,
          postingMissing: ["VERIFIED_NONPRODUCTION_TEST_AUTHORIZATION"],
          missing: [],
          message:
            "Fictional Alpha is read-only; production posting remains disabled.",
        },
        {
          organizationId: betaId,
          companyId,
          name: betaName,
          dataCenter: "EU",
          environment: "sandbox",
          status: "AUTHORIZED_UNVERIFIED",
          configured: true,
          connected: false,
          authorized: true,
          writeEnabled: true,
          authorization,
          postingMissing: [],
          missing: [],
          message:
            "Fictional Beta posting is mocked for this browser test only.",
        },
      ],
    },
    crm: {
      status: "NOT_CONFIGURED",
      configured: false,
      connected: false,
      writeEnabled: false,
      message: "Mocked CRM setup state.",
      missing: [],
      postingMissing: [],
      authorization: {
        ...authorization,
        callbackUrl:
          `${process.env.APP_URL}/api/integrations/oauth/crm/callback`,
        canAuthorize: false,
      },
    },
  };
}
async function login(page: Page) {
  if (!process.env.SEED_ADMIN_EMAIL || !process.env.SEED_ADMIN_PASSWORD)
    throw new Error("Local fictional admin seed credentials are required.");
  await page.goto("/login");
  await page.getByLabel("Work email").fill(process.env.SEED_ADMIN_EMAIL);
  await page
    .getByLabel("Password", { exact: true })
    .fill(process.env.SEED_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in to workspace" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}
async function mockReadiness(page: Page) {
  await page.route("**/api/integrations", (route) =>
    route.fulfill(json(readiness())),
  );
  await page.route("**/api/integrations/jobs", (route) =>
    route.fulfill(
      json({
        jobs: [
          {
            id: "mock-scoped-job",
            billId,
            target: "ZOHO",
            organizationId: betaId,
            organizationName: betaName,
            operation: "CREATE_BILL",
            status: "UNKNOWN",
            attempts: 1,
            nextAttemptAt: null,
            needsReconciliation: true,
            lastError: "Fictional outcome awaiting reconciliation.",
            externalId: null,
            bill: { invoiceNumber: "DEMO-MOCK-SCOPED-BILL" },
            history: [],
          },
        ],
      }),
    ),
  );
}

test("mocked Books destinations queue directly after explicit selection and stay locked", async ({
  page,
}) => {
  await login(page);
  await mockReadiness(page);
  type SyncRecord = {
    id: string;
    target: string;
    status: string;
    organizationId?: string | null;
    organizationName?: string;
    lastError?: string | null;
  };
  const bill = {
    id: billId,
    companyId,
    invoiceNumber: "DEMO-MOCK-SCOPED-BILL",
    invoiceDate: "2026-10-27",
    dueDate: "2026-11-26",
    orderNumber: "DEMO-MOCK-ORDER",
    paymentTerms: "NET_30",
    vendorId: "mock-vendor",
    jobId: "mock-job",
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
    netAmount: "100.00",
    paidAmount: "0.00",
    outstanding: "105.00",
    createdAt: "2026-10-27T06:00:00Z",
    approvedAt: "2026-10-27T07:00:00Z",
    createdBy: {
      id: "mock-independent-author",
      name: "Fictional Author",
      role: "DATA_ENTRY",
    },
    approvedBy: {
      id: "mock-independent-reviewer",
      name: "Fictional Reviewer",
      role: "ACCOUNTS",
    },
    vendor: { id: "mock-vendor", name: "Fictional Supplier", currency: "AED" },
    job: {
      id: "mock-job",
      jobNumber: "DEMO-MOCK-JOB",
      name: "Fictional Job",
      customer: "Fictional Customer",
      currency: "AED",
    },
    lines: [
      {
        id: "mock-line",
        description: "Fictional materials",
        quantity: "1",
        unitPrice: "100.00",
        lineTotal: "100.00",
      },
    ],
    documents: [],
    payments: [],
    auditLogs: [],
    syncRecords: [
      {
        id: "mock-books-sync",
        target: "ZOHO",
        status: "NOT_CONFIGURED",
        organizationId: null,
      },
      { id: "mock-crm-sync", target: "CRM", status: "NOT_CONFIGURED" },
    ] as SyncRecord[],
  };
  const queued: unknown[] = [];
  await page.route(`**/api/bills/${billId}`, (route) =>
    route.fulfill(json({ bill })),
  );
  await page.route(`**/api/bills/${billId}/sync`, async (route) => {
    expect(route.request().method()).toBe("POST");
    const payload = route.request().postDataJSON();
    queued.push(payload);
    expect(payload).toEqual({ target: "ZOHO", organizationId: betaId });
    bill.syncRecords[0] = {
      id: "mock-books-sync",
      target: "ZOHO",
      status: "PENDING",
      organizationId: betaId,
      organizationName: betaName,
    };
    await route.fulfill({
      status: 202,
      ...json({
        job: {
          id: "mock-queued-job",
          status: "QUEUED",
          target: "ZOHO",
          organizationId: betaId,
        },
      }),
    });
  });
  await page.goto(`/bills/${billId}`);
  const selector = page.getByLabel("Books organization", { exact: true });
  const queueButton = page.getByRole("button", {
    name: "Queue Zoho Books sync",
    exact: true,
  });
  await expect(selector).toBeVisible();
  await expect(selector).toHaveValue("");
  await expect(selector.locator("option")).toHaveCount(3);
  await expect(selector.locator(`option[value="${otherCompanyId}"]`)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Integrations", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Integration readiness", exact: false })).toHaveCount(0);
  await expect(queueButton).toBeDisabled();
  expect(queued).toHaveLength(0);
  await selector.selectOption(alphaId);
  await expect(queueButton).toBeDisabled();
  await expect(page.getByText("Books synchronization is unavailable for this destination. Contact your administrator.")).toBeVisible();
  await expect(page.getByText("Fictional Alpha is read-only; production posting remains disabled.")).toHaveCount(0);
  await selector.selectOption(betaId);
  await expect(queueButton).toBeEnabled();
  await queueButton.click();
  await expect(page.getByRole("region", { name: "Books synchronization preview" })).toHaveCount(0);
  await expect(selector).toHaveValue(betaId);
  await expect(selector).toBeDisabled();
  await expect.poll(() => queued.length).toBe(1);
  await page.reload();
  await expect(selector).toHaveValue(betaId);
  await expect(selector).toBeDisabled();
  expect(queued).toEqual([{ target: "ZOHO", organizationId: betaId }]);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(selector).toHaveValue(betaId);
  await expect(selector).toBeDisabled();
  await expect(selector.locator(`option[value="${otherCompanyId}"]`)).toHaveCount(0);
  await expect(page.locator('a[href="/integrations"]')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("integration setup is absent and its legacy route redirects on desktop and mobile", async ({ page }) => {
  await login(page);
  const setupMutations: string[] = [];
  await page.route(/\/api\/integrations\/(oauth\/[^/]+\/authorize|vendor-mapping|crm\/import-job)$/, async (route) => {
    setupMutations.push(route.request().url());
    await route.fulfill({ status: 403, ...json({ error: "Setup is not a frontend action." }) });
  });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto("/integrations?oauth=connected");
    await expect(page).toHaveURL(/\/bills$/);
    await expect(page.getByRole("heading", { name: "Bills & expenses", exact: true })).toBeVisible();
    await expect(page.locator('a[href="/integrations"]')).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Integrations", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Authorize Zoho|Verify and save mapping|Copy .* callback/ })).toHaveCount(0);
    await expect(page.getByLabel(/callback URL|Zoho Books vendor ID|Books organization for vendor mapping/)).toHaveCount(0);
    await expect(page.getByText(/Needed before account authorization|Needed before accounting writes/)).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  expect(setupMutations).toEqual([]);
});
