import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { calculateBill } from "../../src/lib/finance";
import type { Bill, Company, Job, User, Vendor } from "../../src/components/types";

// OCR provider responses below are explicitly mocked browser fixtures, never live extraction evidence.
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
const json = (value: unknown) => ({
  contentType: "application/json",
  body: JSON.stringify(value),
});

test("mocked scanner invoice is field-verified then saved ready without separate approval", async ({
  page,
}) => {
  await login(page);
  const { vendors } = (await (
    await page.request.get("/api/vendors")
  ).json()) as { vendors: Vendor[] };
  const { jobs } = (await (await page.request.get("/api/jobs")).json()) as {
    jobs: Job[];
  };
  const { user } = (await (await page.request.get("/api/auth/me")).json()) as {
    user: User;
  };
  const vendor = vendors.find((vendor) =>
    jobs.some(
      (job) =>
        job.currency === vendor.currency && job.companyId === vendor.companyId,
    ),
  );
  const job = jobs.find(
    (job) =>
      job.currency === vendor?.currency && job.companyId === vendor?.companyId,
  );
  if (!vendor || !job)
    throw new Error("Matching fictional vendor/job seed records are required.");
  const fields = {
    companyId: vendor.companyId,
    vendorId: vendor.id,
    jobId: job.id,
    invoiceNumber: "DEMO-MOCK-OCR-EXTRACTED",
    invoiceDate: "2026-10-27",
    dueDate: "2026-11-11",
    paymentTerms: "CUSTOM",
    orderNumber: "DEMO-MOCK-PO",
    category: "MATERIALS",
    currency: vendor.currency,
    description: "Clearly mocked OCR browser evidence",
    discount: "0",
    vatRate: "5",
    lines: [
      {
        description: "Fictional OCR materials",
        quantity: "2",
        unitPrice: "100.00",
      },
    ],
  };
  let saved: Bill | undefined;
  let submissions = 0;
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method()))
      mutations.push(new URL(request.url()).pathname);
  });
  await page.route("**/api/ocr/documents/mock-review-document", (route) =>
    route.fulfill(
      json({
        document: {
          id: "mock-review-document",
          companyId: vendor.companyId,
          batchId: "mock-batch",
          version: 3,
          status: "REVIEW_REQUIRED",
          fileName: "DEMO-MOCK-invoice.pdf",
          scannerSourceName: "Fictional office scanner",
          suggestedInput: fields,
          warnings: [
            "Fictional server-side matching warning: verify the selected job.",
          ],
          extraction: {
            fields,
            vendorName: vendor.name,
            confidence: { invoiceNumber: 0.7 },
            warnings: ["Mocked low-confidence invoice number."],
            subtotal: "200.00",
            vatAmount: "10.00",
            total: "210.00",
            text: "MOCK PROVIDER RESPONSE FOR BROWSER TEST ONLY",
          },
        },
      }),
    ),
  );
  await page.route(
    "**/api/ocr/documents/mock-review-document/review",
    async (route) => {
      submissions++;
      const payload = route.request().postDataJSON();
      expect(payload.confirmed).toBe(true);
      expect(payload.version).toBe(3);
      expect(payload.bill.submit).toBe(true);
      expect(payload.bill.invoiceNumber).toBe("DEMO-MOCK-OCR-CORRECTED");
      expect(payload.bill.lines[0].unitPrice).toBe("105.00");
      if (submissions === 1) {
        await route.fulfill({
          status: 422,
          ...json({
            error:
              "Fictional validation rejection. Keep your corrections and review the original.",
          }),
        });
        return;
      }
      const totals = calculateBill(
        payload.bill.lines,
        payload.bill.discount,
        payload.bill.vatRate,
      );
      saved = {
        ...payload.bill,
        ...totals,
        id: "ocr-mock-saved-bill",
        status: "READY",
        version: 1,
        paidAmount: "0.00",
        outstanding: "0.00",
        createdAt: "2026-10-27T09:00:00Z",
        createdBy: user,
        vendor,
        job,
        documents: [{ id: "mock-original", fileName: "DEMO-MOCK-invoice.pdf" }],
        payments: [],
        auditLogs: [],
        syncRecords: [],
      };
      await route.fulfill(json({ bill: saved }));
    },
  );
  await page.route("**/api/bills/ocr-mock-saved-bill", (route) =>
    route.fulfill(json({ bill: saved })),
  );
  await page.route("**/api/operations", (route) =>
    route.fulfill(
      json({
        ocrReview: 1,
        ocrFailed: 0,
        ocrQueued: 0,
        syncFailures: 0,
        syncUnknown: 0,
        duplicateWarnings: 0,
        duplicateScanTruncated: false,
      }),
    ),
  );
  await page.route("**/api/ocr", (route) =>
    route.fulfill(
      json({
        provider: {
          configured: true,
          status: "CONFIGURED_UNVERIFIED",
          message: "Mocked configured provider.",
        },
        batches: [
          {
            id: "mock-scanner-batch",
            createdAt: "2026-10-28T09:00:00Z",
            documents: [
              {
                id: "mock-review-document",
                status: "REVIEW_REQUIRED",
                version: 3,
                fileName: "DEMO-MOCK-invoice.pdf",
                scannerSourceName: "Fictional office scanner",
              },
            ],
          },
        ],
        nextCursor: null,
      }),
    ),
  );
  await page.goto("/dashboard");
  const reviewQueue = page.getByRole("link", { name: "OCR awaiting review 1" });
  await expect(reviewQueue).toBeVisible();
  await reviewQueue.click();
  await expect(
    page.getByText("Scanner: Fictional office scanner", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Review required", { exact: true })).toBeVisible();
  expect(mutations).toEqual([]);
  await page.getByRole("link", { name: "Review invoice", exact: true }).click();
  await expect(
    page.getByText("Imported from scanner: Fictional office scanner.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Verify extracted bill" }),
  ).toBeVisible();
  await expect(
    page.getByText("Fictional server-side matching warning", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("Invoice number: 70%", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Bill#").fill("DEMO-MOCK-OCR-CORRECTED");
  await page.getByLabel("Line 1 unit price").fill("105.00");
  await expect(page.getByLabel("Source and verified totals")).toContainText(
    "220.50",
  );
  await expect(
    page.getByText("These totals differ from the original extraction", {
      exact: false,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save and sync", exact: true }).click();
  expect(submissions).toBe(0);
  await page
    .getByRole("checkbox", {
      name: "I checked the original invoice",
      exact: false,
    })
    .check();
  await mkdir(".local/screenshots", { recursive: true });
  await page.screenshot({
    path: ".local/screenshots/ocr-review-mocked-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Save and sync", exact: true }).click();
  await expect(
    page.getByText("Fictional validation rejection.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByLabel("Bill#")).toHaveValue("DEMO-MOCK-OCR-CORRECTED");
  await expect(page.getByLabel("Line 1 unit price")).toHaveValue("105.00");
  await expect(
    page.getByRole("checkbox", {
      name: "I checked the original invoice",
      exact: false,
    }),
  ).toBeChecked();
  await page.getByRole("button", { name: "Save and sync", exact: true }).click();
  await expect(page).toHaveURL(/\/bills\/ocr-mock-saved-bill\?saved=1$/);
  await expect(
    page.getByRole("heading", { name: "DEMO-MOCK-OCR-CORRECTED" }),
  ).toBeVisible();
  expect(submissions).toBe(2);
  await expect(page.getByText("Ready to sync", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve bill", exact: true })).toHaveCount(0);
  expect(saved?.paidAmount).toBe("0.00");
  expect(saved?.payments).toEqual([]);
  expect(mutations).toEqual([
    "/api/ocr/documents/mock-review-document/review",
    "/api/ocr/documents/mock-review-document/review",
  ]);
});

test("mocked upload shows uploading, queue, processing and completed extraction requiring review", async ({
  page,
}) => {
  await login(page);
  let status = "QUEUED";
  let uploaded = false;
  let releaseUpload: (() => void) | undefined;
  const document = () => ({
    id: "mock-progress",
    status,
    version: 1,
    fileName: "DEMO-MOCK-progress.pdf",
  });
  const batch = () => ({
    id: "mock-progress-batch",
    createdAt: "2026-10-28T09:00:00Z",
    documents: [document()],
  });
  await page.route("**/api/ocr", (route) =>
    route.fulfill(
      json({
        provider: {
          configured: true,
          status: "CONFIGURED_UNVERIFIED",
          message: "Mocked configured provider.",
        },
        batches: uploaded ? [batch()] : [],
      }),
    ),
  );
  await page.route("**/api/ocr?companyId=*", async (route) => {
    expect(route.request().method()).toBe("POST");
    await new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    uploaded = true;
    await route.fulfill({ status: 201, ...json({ batch: batch() }) });
  });
  await page.goto("/ocr");
  await page
    .getByRole("combobox", { name: "Company", exact: true })
    .selectOption("demo-company-voltronix");
  await page.getByLabel("Invoice file", { exact: true }).setInputFiles({
    name: "DEMO-MOCK-progress.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n% MOCK UI ONLY\n%%EOF"),
  });
  await page.getByRole("button", { name: "Upload for extraction" }).click();
  await expect(page.getByRole("button", { name: "Uploading…" })).toBeDisabled();
  await expect.poll(() => Boolean(releaseUpload)).toBe(true);
  releaseUpload!();
  await expect(page.getByText("Queued for OCR", { exact: true })).toBeVisible();
  status = "PROCESSING";
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("OCR processing", { exact: true })).toBeVisible();
  await expect(
    page.getByText("No bill has been created.", { exact: false }),
  ).toBeVisible();
  status = "REVIEW_REQUIRED";
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByText("Extraction completed.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("Review required", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Review invoice" }),
  ).toHaveAttribute("href", "/ocr/documents/mock-progress");
  await expect(
    page.getByRole("link", { name: "Open bill", exact: true }),
  ).toHaveCount(0);
});

test("mocked missing OCR currency and tax stay unconfirmed while source tax evidence remains visible", async ({
  page,
}) => {
  await login(page);
  let saves = 0;
  await page.route("**/api/ocr/documents/mock-missing-fields", (route) =>
    route.fulfill(
      json({
        document: {
          id: "mock-missing-fields",
          companyId: "demo-company-voltronix",
          version: 1,
          status: "REVIEW_REQUIRED",
          fileName: "DEMO-MOCK-missing-fields.pdf",
          suggestedInput: {
            vendorId: "demo-vendor-materials",
            jobId: "demo-job-marina",
            invoiceNumber: "DEMO-MOCK-MISSING",
          },
          extraction: {
            fields: {},
            confidence: {
              "lines.0.taxAmount": 0.42,
              "taxDetails.0.rate": 0.55,
            },
            warnings: [
              "Fictional mixed-tax evidence: verify accounting treatment.",
            ],
            sourceLines: [
              {
                amount: "100.00",
                taxAmount: "5.00",
                taxRate: "5.00",
                currency: "AED",
              },
            ],
            taxDetails: [{ amount: "5.00", rate: "5.00", currency: "AED" }],
          },
        },
      }),
    ),
  );
  await page.route(
    "**/api/ocr/documents/mock-missing-fields/review",
    (route) => {
      saves++;
      return route.fulfill({
        status: 422,
        ...json({
          error: "Fictional server rejection; review your corrections.",
        }),
      });
    },
  );
  await page.goto("/ocr/documents/mock-missing-fields");
  await expect(
    page.getByText("Missing or unconfirmed fields:", { exact: false }),
  ).toContainText("currency, VAT rate");
  await expect(page.getByLabel("Currency", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Bill Date")).toHaveValue("");
  await expect(page.getByLabel("Line 1 quantity")).toHaveValue("");
  await expect(page.getByLabel("VAT rate (%)", { exact: true })).toHaveValue(
    "",
  );
  await expect(
    page.getByText("Line 1 tax amount: 42%", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Tax detail 1 rate: 55%", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Extracted line amounts and taxes"),
  ).toContainText("100.00");
  await expect(page.getByLabel("Extracted tax details")).toContainText("5.00%");
  await page
    .getByRole("checkbox", {
      name: "I checked the original invoice",
      exact: false,
    })
    .check();
  await page.getByRole("button", { name: "Save verified draft" }).click();
  expect(saves).toBe(0);
  await page.getByLabel("Currency", { exact: true }).selectOption("AED");
  await page.getByLabel("VAT rate (%)", { exact: true }).fill("5");
  await page.getByLabel("Bill Date").fill("2026-10-28");
  await page
    .getByLabel("Line 1 description")
    .fill("Verified fictional source line");
  await page.getByLabel("Line 1 quantity").fill("1");
  await page.getByLabel("Line 1 unit price").fill("100.00");
  await page.getByRole("button", { name: "Save verified draft" }).click();
  await expect(
    page.getByText("Fictional server rejection; review your corrections."),
  ).toBeVisible();
  expect(saves).toBe(1);
  await expect(page.getByLabel("Currency", { exact: true })).toHaveValue("AED");
  await expect(page.getByLabel("VAT rate (%)", { exact: true })).toHaveValue(
    "5",
  );
  await expect(page.getByLabel("Bill Date")).toHaveValue("2026-10-28");
  await expect(page.getByLabel("Line 1 quantity")).toHaveValue("1");
});

test("real MySQL OCR setup failure falls back to an unpaid manual draft using the stored original", async ({
  page,
}) => {
  await login(page);
  const inventory = await (await page.request.get("/api/ocr")).json();
  expect(
    inventory.provider.configured,
    "Run this check with an isolated OCR-disabled application server; no upload is sent to a configured provider.",
  ).toBe(false);
  const tag = Date.now();
  const original = Buffer.from(
    `%PDF-1.4\n% FICTIONAL MANUAL OCR FALLBACK ${tag}\n%%EOF`,
  );
  const uploaded = await page.request.post(
    "/api/ocr?companyId=demo-company-voltronix",
    {
      headers: { Origin: process.env.APP_URL! },
      multipart: {
        files: {
          name: `DEMO-OCR-FALLBACK-${tag}.pdf`,
          mimeType: "application/pdf",
          buffer: original,
        },
      },
    },
  );
  expect(uploaded.status()).toBe(201);
  const { batch } = await uploaded.json();
  const document = batch.documents[0];
  expect(document.status).toBe("FAILED");
  await page.goto(`/ocr/documents/${document.id}`);
  await page
    .getByRole("button", { name: "Enter bill manually", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Enter bill from original" }),
  ).toBeVisible();
  await expect(page.getByLabel("Currency", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("VAT rate (%)", { exact: true })).toHaveValue(
    "",
  );
  await page.getByRole("combobox", { name: "Vendor Name" }).fill("Meridian");
  await page.getByRole("option", { name: /^\[DEMO\] Meridian Materials/ }).click();
  await page.getByLabel(/^Job \/ project/).selectOption("demo-job-marina");
  await page.getByLabel("Bill#").fill(`DEMO-OCR-FALLBACK-${tag}`);
  await page.getByLabel("Bill Date").fill("2026-10-28");
  await page
    .getByLabel("Line 1 description")
    .fill("Fictional OCR fallback materials");
  await page.getByLabel("Line 1 quantity").fill("2");
  await page.getByLabel("Line 1 unit price").fill("25.00");
  await page.getByLabel("VAT rate (%)", { exact: true }).fill("0");
  await page
    .getByRole("checkbox", {
      name: "I checked the original invoice",
      exact: false,
    })
    .check();
  await page.getByRole("button", { name: "Save manual draft" }).click();
  await expect(page).toHaveURL(/\/bills\/[a-z0-9]+\?saved=1$/);
  const billId = new URL(page.url()).pathname.split("/").at(-1);
  const { bill } = await (
    await page.request.get(`/api/bills/${billId}`)
  ).json();
  expect(bill.status).toBe("DRAFT");
  expect(bill.paidAmount).toBe("0.00");
  expect(bill.total).toBe("50.00");
  expect(bill.payments).toHaveLength(0);
  expect(bill.documents).toHaveLength(1);
  expect(bill.documents[0].fileName).toBe(`DEMO-OCR-FALLBACK-${tag}.pdf`);
  const downloaded = await page.request.get(
    `/api/documents/${bill.documents[0].id}`,
  );
  expect(downloaded.status()).toBe(200);
  expect(await downloaded.body()).toEqual(original);
  const read = await (
    await page.request.get(`/api/ocr/documents/${document.id}`)
  ).json();
  expect(read.document.billId).toBe(billId);
  expect(read.document.extraction).toBeNull();
});

test("mocked OCR batch on mobile shows retry errors and saved bills without approval controls", async ({
  page,
}) => {
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  let configured = false;
  let approvalCalls = 0;
  const batches = () => [
    {
      id: "mock-mobile-batch",
      createdAt: "2026-10-27T09:00:00Z",
      documents: [
        {
          id: "mock-failed",
          status: "FAILED",
          version: 1,
          fileName: "DEMO-MOCK-failed.pdf",
          failureCode: "PROVIDER_REJECTED",
          lastError: "Fictional OCR processing error for test coverage.",
        },
        {
          id: "mock-posted",
          status: "POSTED",
          version: 4,
          fileName: "DEMO-MOCK-reviewed.pdf",
          billId: "mock-pending-bill",
          bill: {
            id: "mock-pending-bill",
            invoiceNumber: "DEMO-MOCK-PENDING",
            version: 2,
            status: "READY",
            createdById: "different-fictional-data-entry-user",
          },
        },
      ],
    },
  ];
  await page.route("**/api/ocr", (route) =>
    route.fulfill(
      json({
        provider: {
          configured,
          status: configured ? "CONFIGURED_UNVERIFIED" : "NOT_CONFIGURED",
          message: "Mocked provider setup state.",
        },
        batches: batches(),
      }),
    ),
  );
  await page.route("**/api/ocr/templates", (route) =>
    route.fulfill(json({ templates: [] })),
  );
  await page.route("**/api/ocr/documents/mock-failed/retry", (route) =>
    route.fulfill({
      status: 503,
      ...json({ error: "Fictional retry rejected: provider unavailable." }),
    }),
  );
  await page.route(
    "**/api/ocr/batches/mock-mobile-batch/approve",
    (route) => {
      approvalCalls++;
      return route.fulfill({ status: 410, ...json({ error: "Separate approval is no longer used." }) });
    },
  );
  await page.goto("/ocr/batch");
  await expect(
    page.getByText("OCR setup required.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Upload for extraction" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("heading", { name: "Scanner imports" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Export errors CSV" }),
  ).toHaveAttribute("href", "/api/ocr/batches/mock-mobile-batch/errors");
  configured = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    page.getByText("Fictional retry rejected", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Approve/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Open bill", exact: true })).toHaveAttribute("href", "/bills/mock-pending-bill");
  expect(approvalCalls).toBe(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: ".local/screenshots/ocr-batch-mocked-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
});

test("mocked scanner arrivals refresh an empty queue and older pending reviews remain reachable", async ({
  page,
}) => {
  await login(page);
  await page.clock.install();
  let arrived = false;
  const requestedCursors: (string | null)[] = [];
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method()))
      mutations.push(new URL(request.url()).pathname);
  });
  await page.route(/\/api\/ocr(?:\?.*)?$/, (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    requestedCursors.push(cursor);
    const older = cursor === "mock-scanner-last-visible";
    return route.fulfill(
      json({
        provider: {
          configured: true,
          status: "CONFIGURED_UNVERIFIED",
          message: "Mocked configured provider.",
        },
        batches: arrived
          ? [
              {
                id: older ? "mock-older-batch" : "mock-scanner-last-visible",
                createdAt: older
                  ? "2026-10-27T09:00:00Z"
                  : "2026-10-28T09:00:00Z",
                documents: [
                  {
                    id: older ? "mock-older-scan" : "mock-latest-scan",
                    status: "REVIEW_REQUIRED",
                    version: 2,
                    fileName: older ? "DEMO-older-scan.pdf" : "DEMO-new-scan.pdf",
                    scannerSourceName: "Fictional office scanner",
                  },
                ],
              },
            ]
          : [],
        nextCursor: arrived && !older ? "mock-scanner-last-visible" : null,
      }),
    );
  });
  await page.route("**/api/ocr/templates", (route) =>
    route.fulfill(json({ templates: [] })),
  );
  await page.goto("/ocr/batch");
  await expect(
    page.getByRole("heading", { name: "No OCR documents yet" }),
  ).toBeVisible();
  arrived = true;
  await page.clock.runFor(30001);
  await expect(page.getByRole("link", { name: "DEMO-new-scan.pdf" })).toBeVisible();
  await page.getByRole("button", { name: "Older invoices" }).click();
  await expect(
    page.getByRole("link", { name: "DEMO-older-scan.pdf" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Review invoice" })).toHaveAttribute(
    "href",
    "/ocr/documents/mock-older-scan",
  );
  await page.getByRole("button", { name: "Newer invoices" }).click();
  await expect(page.getByRole("link", { name: "DEMO-new-scan.pdf" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Older invoices" }).click();
  await page.getByRole("button", { name: "Newest invoices" }).click();
  await expect(page.getByRole("link", { name: "DEMO-new-scan.pdf" })).toBeVisible();
  expect(requestedCursors).toContain("mock-scanner-last-visible");
  expect(mutations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
