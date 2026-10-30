import { expect, test } from "@playwright/test";

const company = {
  id: "fictional-import-company",
  name: "Fictional Imported Company",
};
const bill = {
  id: "fictional-import-bill",
  companyId: company.id,
  companyName: company.name,
  organizationId: "990001",
  externalBillId: "990002",
  billNumber: "FICTIONAL-IMPORT-1",
  vendorName: "Fictional Imported Supplier",
  vendorId: "990003",
  status: "partially_paid",
  currencyCode: "KWD",
  billDate: "2026-10-01",
  dueDate: "2026-10-31",
  subtotal: "105.125",
  taxTotal: "0.000",
  total: "105.125",
  balance: "100.125",
  paymentMade: "3.000",
  vendorCreditsApplied: "2.000",
  detailAvailable: true,
  lastSeenAt: "2026-10-29T10:00:00Z",
  importedAt: "2026-10-29T10:00:00Z",
  detailFetchedAt: "2026-10-29T10:01:00Z",
  isStale: false,
  referenceNumber: "Fictional reference",
  notes: "Fictional notes",
  terms: null,
  sourceModifiedAt: "2026-10-28T09:00:00Z",
  lines: [
    {
      id: "line",
      name: "Fictional material",
      description: null,
      quantity: "1.000",
      rate: "105.125",
      total: "105.125",
      accountName: "Fictional account",
      taxName: null,
      taxPercentage: null,
      projectName: null,
    },
  ],
  payments: [
    {
      id: "payment",
      date: "2026-10-21",
      amount: "3.000",
      referenceNumber: "Fictional payment",
      paymentMode: "Cash",
    },
  ],
  credits: [
    {
      id: "credit",
      number: "Fictional credit",
      date: "2026-10-22",
      amount: "2.000",
    },
  ],
  documents: [
    {
      id: "document",
      name: "Fictional source.pdf",
      attachmentId: null,
      downloaded: false,
      status: "PENDING",
      fileName: null,
      mimeType: null,
      byteSize: null,
      downloadedAt: null,
    },
  ],
  hasAttachment: true,
  attachmentCount: 1,
  attachmentsDownloaded: false,
  downloadedAttachmentCount: 0,
  attachmentStatus: "PENDING",
};

test.beforeEach(async ({ page, baseURL }) => {
  const email = process.env.SEED_ADMIN_EMAIL,
    password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password || !baseURL)
    throw new Error(
      "Local authentication is required for isolated browser checks.",
    );
  expect(
    (
      await page.request.post(`${baseURL}/api/auth/login`, {
        headers: { Origin: baseURL },
        data: { email, password },
      })
    ).status(),
  ).toBe(200);
});

test.afterEach(async ({ page, baseURL }) => {
  if (baseURL)
    await page.request.post(`${baseURL}/api/auth/logout`, {
      headers: { Origin: baseURL },
    });
});

test("imported bills support scoped filters, paging and read-only native details", async ({
  page,
}) => {
  const queries: URLSearchParams[] = [];
  const writes: string[] = [];
  await page.route("**/api/companies", (route) =>
    route.fulfill({ json: { companies: [company] } }),
  );
  await page.route("**/api/bills/books**", async (route) => {
    if (route.request().method() !== "GET")
      writes.push(route.request().method());
    const url = new URL(route.request().url());
    if (url.pathname.endsWith(`/${bill.id}`))
      return route.fulfill({ json: { bill } });
    queries.push(url.searchParams);
    return route.fulfill({
      json: {
        bills: [bill],
        total: 51,
        page: Number(url.searchParams.get("page") ?? "1"),
        pageSize: 50,
        filters: {
          statuses: ["partially_paid", "overdue"],
          currencies: ["KWD", "AED"],
        },
        runs: [],
      },
    });
  });
  await page.goto("/bills/books");
  await expect(
    page.getByRole("heading", { name: "Zoho Books bills", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("KWD 105.125", { exact: true })).toBeVisible();
  await page.getByLabel("Company", { exact: true }).selectOption(company.id);
  await page.getByLabel("Search Zoho Books bills").fill("Fictional");
  await page
    .getByLabel("Zoho status", { exact: true })
    .selectOption("partially_paid");
  await page.getByLabel("Currency", { exact: true }).selectOption("KWD");
  await expect(
    page.getByRole("link", { name: bill.billNumber, exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.getByText("Page 2 of 2", { exact: true })).toBeVisible();
  const lastQuery = queries.at(-1)!;
  expect(Object.fromEntries(lastQuery)).toEqual({
    page: "2",
    companyId: company.id,
    q: "Fictional",
    status: "partially_paid",
    currencyCode: "KWD",
  });
  await page.getByRole("link", { name: bill.billNumber, exact: true }).click();
  await expect(
    page.getByRole("heading", { name: bill.billNumber, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Fictional material", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Fictional credit", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Original files have not been downloaded", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /save|sync|pay/i }),
  ).toHaveCount(0);
  expect(writes).toEqual([]);
});

test("summary-only bills communicate incomplete download on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route(`**/api/bills/books/${bill.id}`, (route) =>
    route.fulfill({
      json: {
        bill: {
          ...bill,
          detailAvailable: false,
          detailFetchedAt: null,
          lines: [],
          payments: [],
          credits: [],
          documents: [],
          paymentMade: null,
          vendorCreditsApplied: null,
        },
      },
    }),
  );
  await page.goto(`/bills/books/${bill.id}`);
  await expect(
    page.getByText("Only the bill summary has been downloaded", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Payments have not been downloaded.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Attachment details have not been downloaded.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("original attachments expose scoped open and download links on mobile with partial coverage", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fileName =
    "Fictional original supplier invoice with a long filename 2026.pdf";
  const attachmentUrl = `/api/bills/books/${bill.id}/attachments/fictional-original`;
  await page.route(`**/api/bills/books/${bill.id}`, (route) =>
    route.fulfill({
      json: {
        bill: {
          ...bill,
          attachmentCount: 2,
          downloadedAttachmentCount: 1,
          attachmentStatus: "PARTIAL",
          documents: [
            {
              id: "available-document",
              name: fileName,
              attachmentId: "fictional-original",
              downloaded: true,
              status: "AVAILABLE",
              fileName,
              mimeType: "application/pdf",
              byteSize: 2048,
              downloadedAt: "2026-10-29T12:00:00Z",
            },
            bill.documents[0],
          ],
        },
      },
    }),
  );
  await page.goto(`/bills/books/${bill.id}`);
  await expect(
    page.getByText("1 of 2 original files downloaded from Zoho Books.", {
      exact: false,
    }),
  ).toBeVisible();
  const open = page.getByRole("link", {
    name: `Open ${fileName}`,
    exact: true,
  });
  await expect(open).toHaveAttribute("href", attachmentUrl);
  await expect(open).toHaveAttribute("target", "_blank");
  const download = page.getByRole("link", {
    name: `Download ${fileName}`,
    exact: true,
  });
  await expect(download).toHaveAttribute("href", `${attachmentUrl}?download=1`);
  await expect(
    page.getByText("Not downloaded yet", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open Fictional source.pdf", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("original file policies survive Next header matching without changing the app policy", async ({
  page,
}) => {
  // These real requests reach the optimized server. Route-function mocks cannot
  // detect global next.config headers overwriting a private file response.
  for (const pathname of [
    "/api/bills/books/fictional-missing-bill/attachments/fictional-missing-original",
    "/api/documents/fictional-missing-original",
  ]) {
    const response = await page.request.get(pathname);
    expect(response.status()).toBe(404);
    expect(response.headers()["content-security-policy"]).toBe(
      "sandbox; default-src 'none'",
    );
    expect(response.headers()["referrer-policy"]).toBe("no-referrer");
    expect(response.headers()["cache-control"]).toBe("private, no-store");
    expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  }
  const app = await page.request.get("/login", { maxRedirects: 0 });
  expect(app.headers()["content-security-policy"]).toContain(
    "default-src 'self'",
  );
  expect(app.headers()["content-security-policy"]).not.toContain("sandbox");
  expect(app.headers()["referrer-policy"]).toBe("same-origin");
});
