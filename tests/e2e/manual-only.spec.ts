import { expect, test, type Page } from "@playwright/test";
import type { Bill, Company } from "../../src/components/types";

// Run with MANUAL_ENTRY_ONLY=true and playwright.isolated.config.ts. Authentication,
// bill writes, attachments and payments all use the guarded local MySQL database.
test.skip(process.env.MANUAL_ENTRY_ONLY !== "true", "Requires the manual-only server configuration.");

test.beforeEach(async ({ page, baseURL }) => {
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password || !baseURL) throw new Error("Local fixture credentials are required.");
  expect((await page.request.post("/api/auth/login", {
    headers: { Origin: baseURL }, data: { email, password },
  })).status()).toBe(200);
  const response = await page.request.get("/api/companies");
  expect(response.ok()).toBe(true);
  const body = await response.json() as { companies: Company[] };
  // Only labels are adapted: the production selector intentionally hides DEMO names.
  await page.route("**/api/companies", route => route.fulfill({ json: {
    ...body, companies: body.companies.map(company => ({ ...company,
      name: company.id === "demo-company-voltronix" ? "Fictional manual acceptance company" : company.name,
    })),
  } }));
});

test.afterEach(async ({ page, baseURL }) => {
  if (baseURL) await page.request.post("/api/auth/logout", { headers: { Origin: baseURL } });
});

async function fillBill(page: Page, invoice: string) {
  await page.goto("/bills/new");
  await page.getByRole("combobox", { name: "Company", exact: true }).selectOption("demo-company-voltronix");
  await page.getByRole("combobox", { name: "Vendor Name" }).fill("Meridian");
  await page.getByRole("option", { name: /^\[DEMO\] Meridian Materials/ }).click();
  await page.getByLabel("Bill#").fill(invoice);
  await page.getByLabel("Bill Date").fill("2026-10-29");
  await page.getByLabel("Payment Terms").selectOption("NET_30");
  await page.getByLabel(/^Job \/ project/).selectOption("demo-job-marina");
  await page.getByLabel("Line 1 description").fill("Fictional manual acceptance materials");
  await page.getByLabel("Line 1 quantity").fill("2");
  await page.getByLabel("Line 1 unit price").fill("12.50");
  await expect(page.getByRole("button", { name: "Save bill", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save and sync", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Books synchronization readiness")).toHaveCount(0);
}

function expectNoSynchronization(bill: Bill) {
  // Every bill retains two destination placeholders; neither is a queued operation.
  expect(bill.syncRecords).toHaveLength(2);
  for (const record of bill.syncRecords!) {
    expect(record).toMatchObject({ status: "NOT_CONFIGURED", attempts: 0,
      externalId: null, lastError: null, organizationId: null });
  }
}

test("manual release persists draft, edit, original and payment without provider setup", async ({ page }) => {
  const invoice = `DEMO-MANUAL-RELEASE-${Date.now()}`;
  const original = Buffer.from("%PDF-1.4\n% Fictional manual release attachment\n%%EOF");
  await fillBill(page, invoice);
  await page.getByLabel("Invoice attachment").setInputFiles({
    name: "DEMO-manual-original.pdf", mimeType: "application/pdf", buffer: original,
  });
  await page.getByRole("button", { name: "Save as draft", exact: true }).click();
  await expect(page).toHaveURL(/\/bills\/[a-z0-9]+\?saved=1$/);
  const billPath = new URL(page.url()).pathname;
  await page.reload();
  await expect(page.getByRole("heading", { name: invoice, exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Edit bill", exact: true }).click();
  await expect(page.getByLabel("Due Date", { exact: true })).toHaveValue("2026-11-28");
  await page.getByLabel("Line 1 unit price").fill("20.00");
  await page.getByRole("button", { name: "Save bill", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${billPath}\\?saved=1$`));
  await expect(page.getByText("Bill saved successfully.", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Synchronization", exact: true })).toHaveCount(0);
  const { bill } = await (await page.request.get(`/api${billPath}`)).json() as { bill: Bill };
  expect(bill.status).toBe("READY");
  expect(bill.total).toBe("42.00");
  expect(bill.paidAmount).toBe("0.00");
  expect(bill.payments).toHaveLength(0);
  expectNoSynchronization(bill);
  expect(bill.documents).toHaveLength(1);
  const document = await page.request.get(`/api/documents/${bill.documents![0].id}`);
  expect(document.ok()).toBe(true);
  expect(await document.body()).toEqual(original);
  await page.reload();
  await page.getByRole("button", { name: "Record payment", exact: true }).click();
  await page.getByLabel("Payment reference").fill(`${invoice}-PAYMENT`);
  await page.getByRole("button", { name: "Confirm payment", exact: true }).click();
  await expect(page.getByText("Payment recorded successfully.", { exact: true })).toBeVisible();
  const { bill: paid } = await (await page.request.get(`/api${billPath}`)).json() as { bill: Bill };
  expect(paid.paymentStatus).toBe("PAID");
  expect(paid.paidAmount).toBe("42.00");
  expect(paid.payments).toHaveLength(1);
  expectNoSynchronization(paid);
  await page.goto("/bills");
  await page.getByLabel("Search bills").fill(invoice);
  await expect(page.getByRole("link", { name: invoice, exact: true })).toBeVisible();
  const report = await page.request.get("/api/reports/bills?currency=AED&companyId=demo-company-voltronix&format=csv");
  expect(report.ok()).toBe(true);
  expect(await report.text()).toContain(invoice);
});

test("manual save retries a failed attachment on the same draft before finalizing", async ({ page }) => {
  let creates = 0;
  let uploads = 0;
  let billId = "";
  await page.route("**/api/bills", async route => {
    if (route.request().method() !== "POST") return route.continue();
    creates++;
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    const { bill } = await response.json() as { bill: Bill };
    billId = bill.id;
    expect(bill.status).toBe("DRAFT");
    await route.fulfill({ response });
  });
  await page.route(/\/api\/bills\/[^/]+\/attachment$/, async route => {
    uploads++;
    if (uploads === 1) return route.fulfill({ status: 503, json: { error: "Fictional interrupted upload." } });
    await route.continue();
  });
  await fillBill(page, `DEMO-MANUAL-RETRY-${Date.now()}`);
  await page.getByLabel("Invoice attachment").setInputFiles({ name: "DEMO-manual-retry.pdf",
    mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n% Fictional retry original\n%%EOF"),
  });
  await page.getByRole("button", { name: "Save bill", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry attachment", exact: true })).toBeVisible();
  const { bill: draft } = await (await page.request.get(`/api/bills/${billId}`)).json() as { bill: Bill };
  expect(draft.status).toBe("DRAFT");
  expect(draft.documents).toHaveLength(0);
  expectNoSynchronization(draft);
  await page.getByRole("button", { name: "Retry attachment", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/bills/${billId}\\?saved=1$`));
  await expect(page.getByText("Bill saved successfully.", { exact: true })).toBeVisible();
  const { bill } = await (await page.request.get(`/api/bills/${billId}`)).json() as { bill: Bill };
  expect(bill.status).toBe("READY");
  expect(bill.documents).toHaveLength(1);
  expectNoSynchronization(bill);
  expect(creates).toBe(1);
  expect(uploads).toBe(2);
});
