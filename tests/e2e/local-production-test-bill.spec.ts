import { expect, test } from "@playwright/test";
import type { Bill } from "../../src/components/types";

// Only authentication uses the local fixture account. Every bill, operation and
// provider result below is a browser fixture; no financial request reaches a server.
const companyId = "fictional-one-bill-contracting";
const organizationId = "9905358001";
const draft: Bill = { id: "fictional-one-bill-draft", companyId, jobId: "fictional-job-5358", vendorId: "fictional-one-bill-vendor",
  invoiceNumber: "FICTIONAL-ONE-BILL-TEST", invoiceDate: "2026-10-30", createdAt: "2026-10-30T09:00:00Z", category: "MATERIALS",
  currency: "AED", status: "DRAFT", paymentStatus: "UNPAID", subtotal: "10.00", discount: "0.00", vatRate: "5.00",
  vatAmount: "0.50", total: "10.50", paidAmount: "0.00", outstanding: "0.00", version: 4,
  vendor: { id: "fictional-one-bill-vendor", companyId, name: "Fictional supplier", currency: "AED" },
  job: { id: "fictional-job-5358", companyId, jobNumber: "JOB-5358", name: "Fictional job 5358", customer: "Fictional customer",
    currency: "AED", contractValue: "1000.00", approvedVariations: "0.00" },
  lines: [{ description: "Fictional authorized test item", quantity: "1", unitPrice: "10.00" }],
  documents: [], payments: [], syncRecords: [] };
const connection = { zoho: { status: "CONNECTED", connected: true, message: "Fictional read-only connection", writeEnabled: false,
  organizations: [{ companyId, organizationId, name: "Fictional Contracting", status: "CONNECTED", connected: true,
    message: "Read-only source", dataCenter: "US", environment: "production", writeEnabled: false,
    postingMissing: ["WRITE_ENABLED", "LIVE_OPERATIONAL_ENVIRONMENT"] }] }, crm: { status: "CONNECTED", message: "Fictional read source" } };

test.beforeEach(async ({ page, baseURL }) => {
  const email = process.env.SEED_ADMIN_EMAIL, password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password || !baseURL) throw new Error("Local fixture authentication and origin are required.");
  expect((await page.request.post(`${baseURL}/api/auth/login`, { headers: { Origin: baseURL }, data: { email, password } })).status()).toBe(200);
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "GET" && path === "/api/integrations") return route.fulfill({ json: connection });
    return route.fulfill({ status: 422, json: { error: "Unexpected fixture request; financial requests are blocked." } });
  });
});
test.afterEach(async ({ page, baseURL }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  if (baseURL) await page.request.post(`${baseURL}/api/auth/logout`, { headers: { Origin: baseURL } });
});

test("an authorized one-bill draft queues once through Save and sync while global posting stays read-only", async ({ page }) => {
  let bill = structuredClone(draft), submissions = 0, dialogs = 0;
  const mutations: string[] = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  page.on("dialog", async dialog => { dialogs++; await dialog.dismiss(); });
  page.on("request", request => {
    if (new URL(request.url()).pathname.startsWith("/api/") && request.method() !== "GET") mutations.push(new URL(request.url()).pathname);
  });
  await page.route(`**/api/bills/${draft.id}`, route => route.fulfill({ json: { bill } }));
  await page.route(`**/api/bills/${draft.id}/actions`, async route => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({ action: "submit", version: 4 });
    submissions++;
    await pending;
    bill = { ...bill, status: "READY", version: 5, outstanding: "10.50", syncRecords: [{ id: "fictional-grant-sync",
      target: "ZOHO", organizationId, status: "PENDING", externalId: null, lastError: null }] };
    return route.fulfill({ json: { bill, operation: { id: "fictional-exact-one-bill-operation", status: "PENDING" } } });
  });
  try {
    await page.goto(`/bills/${draft.id}?saved=1`);
    await expect(page.getByText("Draft saved. It has not been sent to Zoho Books.", { exact: true })).toBeVisible();
    const save = page.getByRole("button", { name: "Save and sync", exact: true });
    await expect(save).toBeEnabled();
    await save.click();
    await expect.poll(() => submissions).toBe(1);
    await expect(save).toBeDisabled();
    await save.evaluate(element => (element as HTMLButtonElement).click());
    expect(submissions).toBe(1);
    release();
    await expect(page.getByText("Bill saved. Zoho Books synchronization queued. Provider confirmation is pending.", { exact: true })).toBeVisible();
    await expect(save).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Queue Zoho Books sync", exact: true })).toBeDisabled();
    await expect(page.getByText("Bill saved and synchronized with Zoho Books.", { exact: true })).toHaveCount(0);
    expect(bill).toMatchObject({ version: 5, status: "READY", paidAmount: "0.00", payments: [] });
    expect(connection.zoho.organizations[0].writeEnabled).toBe(false);
    expect(dialogs).toBe(0);
    expect(mutations).toEqual([`/api/bills/${draft.id}/actions`]);
    bill = { ...bill, syncRecords: [{ ...bill.syncRecords![0], status: "SYNCED", externalId: "9905358999" }] };
    await page.getByRole("button", { name: "Refresh sync status", exact: true }).click();
    await expect(page.getByText("Bill saved and synchronized with Zoho Books.", { exact: true })).toBeVisible();
    expect(submissions).toBe(1);
    expect(mutations).toEqual([`/api/bills/${draft.id}/actions`]);
  } finally { release(); }
});

for (const failure of ["DENIED", "SAVED_UNSYNCED"] as const) {
  test(`a ${failure.toLowerCase()} one-bill grant result never claims Zoho success or retries automatically`, async ({ page }) => {
    let bill = structuredClone(draft), submissions = 0;
    const rejection = "Fictional one-bill test permission is expired or does not match this bill.";
    await page.route(`**/api/bills/${draft.id}`, route => route.fulfill({ json: { bill } }));
    await page.route(`**/api/bills/${draft.id}/actions`, route => {
      expect(route.request().postDataJSON()).toEqual({ action: "submit", version: 4 });
      submissions++;
      if (failure === "DENIED") return route.fulfill({ status: 403, json: { error: rejection } });
      bill = { ...bill, status: "READY", version: 5, syncRecords: [{ id: "fictional-denied-sync", target: "ZOHO",
        organizationId, status: "FAILED", externalId: null, lastError: rejection }] };
      return route.fulfill({ json: { bill } });
    });
    await page.goto(`/bills/${draft.id}`);
    await page.getByRole("button", { name: "Save and sync", exact: true }).click();
    if (failure === "DENIED") {
      await expect(page.getByRole("alert").filter({ hasText: rejection })).toBeVisible();
      await expect(page.getByRole("button", { name: "Save and sync", exact: true })).toBeEnabled();
      expect(bill.status).toBe("DRAFT");
    } else {
      await expect(page.getByText(`Bill saved, but it has not synchronized with Zoho Books. ${rejection}`, { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Queue Zoho Books sync", exact: true })).toBeDisabled();
    }
    await expect(page.getByText("Bill saved and synchronized with Zoho Books.", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Bill saved. Zoho Books synchronization queued. Provider confirmation is pending.", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Refresh sync status", exact: true }).click();
    expect(submissions).toBe(1);
    expect(bill.paidAmount).toBe("0.00");
    expect(bill.payments).toEqual([]);
  });
}
