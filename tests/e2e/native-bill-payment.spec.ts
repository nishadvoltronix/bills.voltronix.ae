import { expect, test, type Page } from "@playwright/test";
import type { Bill } from "../../src/components/types";

// Only LOCAL authentication reaches the app. Every bill and payment response is
// fictional and intercepted; no financial or provider mutation is sent through.
const billId = "fictional-payment-page";
const fixture = (): Bill => ({
  id: billId, companyId: "fictional-company", invoiceNumber: "FICTIONAL-PAYMENT-001", vendorId: "supplier", jobId: "job",
  invoiceDate: "2026-11-03", category: "MATERIALS", currency: "AED", status: "READY", paymentStatus: "UNPAID", total: "105.00",
  subtotal: "100.00", vatAmount: "5.00", paidAmount: "0.00", outstanding: "105.00", discount: "0.00", vatRate: "5.00",
  version: 1, createdAt: "2026-11-03T08:00:00.000Z", createdBy: { id: "fictional-author", name: "Fictional author" },
  vendor: { id: "supplier", companyId: "fictional-company", name: "Fictional supplier", currency: "AED" },
  job: { id: "job", companyId: "fictional-company", jobNumber: "JOB-FICTIONAL", name: "Fictional project", customer: "Fictional customer", currency: "AED",
    contractValue: null, approvedVariations: null },
  payments: [], lines: [], documents: [], syncRecords: [],
});
type Action = (body: Record<string, unknown>) => Promise<{ status?: number; json: unknown }>;
async function setup(page: Page, initial = fixture(), fromEntry = false) {
  const state = { bill: initial, unexpected: [] as string[], actions: [] as Record<string, unknown>[],
    action: (async () => ({ status: 409, json: { error: "Fictional payment response not configured." } })) as Action };
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname !== "127.0.0.1") { state.unexpected.push("External API request"); return route.abort(); }
    if (url.pathname.startsWith("/api/auth/")) return route.continue();
    if (url.pathname === `/api/bills/${billId}` && request.method() === "GET") return route.fulfill({ json: { bill: state.bill } });
    if (url.pathname === `/api/bills/${billId}/actions` && request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>; state.actions.push(body);
      return route.fulfill(await state.action(body));
    }
    if (url.pathname === "/api/companies" && request.method() === "GET") return route.fulfill({ json: { companies: [{ id: "fictional-company", name: "Fictional company" }] } });
    if (url.pathname === "/api/bills/autofill" && request.method() === "GET") return route.fulfill({ json: { enabled: false, configured: false, message: "Fictional manual entry fixture." } });
    if (url.pathname === "/api/jobs" && request.method() === "GET") return route.fulfill({ json: { jobs: [state.bill.job] } });
    if (url.pathname === "/api/jobs/job" && request.method() === "GET") return route.fulfill({ json: { job: state.bill.job, bills: [] } });
    if (url.pathname === "/api/bills/options" && request.method() === "GET") return route.fulfill({ json: {
      companyId: "fictional-company", organizationId: null, dataCenter: null, environment: null, accounts: [], taxes: [], customers: [], hasMoreCustomers: false, warning: null,
    } });
    if (url.pathname === "/api/integrations" && request.method() === "GET") return route.fulfill({ json: {
      zoho: { organizations: [] }, crm: { status: "NOT_CONFIGURED", message: "Fictional connection" },
    } });
    state.unexpected.push(`${request.method()} ${url.pathname}`);
    return route.fulfill({ status: 409, json: { error: "Fictional screen check: this operation is blocked." } });
  });
  const email = process.env.SEED_ADMIN_EMAIL, password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password) throw new Error("The existing LOCAL Admin test credentials are required.");
  await page.goto(`/login?${new URLSearchParams({ next: `/bills/${billId}/payment` })}`);
  await page.getByLabel("Work email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: /Login.*Sign in to workspace/ }).click();
  await expect(page).toHaveURL(new RegExp(`/bills/${billId}/payment$`));
  if (fromEntry) await page.goto(`/bills/${billId}/payment?entry=1&saved=1&jobId=untrusted-job&companyId=untrusted-company`);
  return state;
}
const ribbon = (page: Page) => page.getByRole("img", { name: "Paid in full", exact: true });

test("unpaid bill links to its own payment page with saved identity, balance and no extra payment fields", async ({ page }) => {
  const state = await setup(page);
  await expect(page.getByRole("heading", { name: "Record payment", exact: true })).toBeVisible();
  await expect(page.getByLabel("Payment amount (AED)", { exact: true })).toHaveValue("105.00");
  await expect(page.getByText("Fictional supplier", { exact: true })).toBeVisible();
  await expect(page.getByText("JOB-FICTIONAL", { exact: false })).toBeVisible();
  await expect(page.getByText("This records a local payment. It does not transfer funds or update Zoho Books.", { exact: true })).toBeVisible();
  await expect(ribbon(page)).toHaveCount(0);
  await expect(page.locator('input[type="date"]')).toHaveCount(0);
  await page.getByRole("link", { name: "Back to bill", exact: true }).click();
  await expect(page.getByRole("link", { name: "Record payment", exact: true })).toHaveAttribute("href", `/bills/${billId}/payment`);
  expect(state.actions).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("confirmed partial then full payment refreshes history and Paid state, with no optimistic ribbon or inflight cancellation", async ({ page }) => {
  const state = await setup(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  state.action = async body => {
    expect(body).toEqual({ action: "payment", version: 1, amount: "25.00", reference: "FICTIONAL-PARTIAL" });
    await held;
    state.bill = { ...state.bill, version: 2, paidAmount: "25.00", outstanding: "80.00", paymentStatus: "PARTIALLY_PAID",
      payments: [{ id: "fictional-payment-1", amount: "25.00", reference: "FICTIONAL-PARTIAL", createdAt: "2026-11-03T08:30:00.000Z" }] };
    return { json: { bill: state.bill } };
  };
  await page.getByLabel("Payment amount (AED)", { exact: true }).fill("25.00");
  await page.getByLabel("Payment reference", { exact: true }).fill("FICTIONAL-PARTIAL");
  await page.getByRole("button", { name: "Confirm payment", exact: true }).click();
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
  await expect(page.getByRole("link", { name: "Cancel", exact: true })).toHaveCount(0);
  await expect(ribbon(page)).toHaveCount(0);
  release();
  await expect(page.getByText("Payment recorded successfully.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Payment amount (AED)", { exact: true })).toHaveValue("80.00");
  await expect(page.getByLabel("Payment reference", { exact: true })).toHaveValue("");
  await expect(page.getByText("partially paid", { exact: true })).toBeVisible();
  await expect(ribbon(page)).toHaveCount(0);
  state.action = async body => {
    expect(body).toEqual({ action: "payment", version: 2, amount: "80.00", reference: "FICTIONAL-FINAL" });
    state.bill = { ...state.bill, version: 3, paidAmount: "105.00", outstanding: "0.00", paymentStatus: "PAID",
      payments: [...state.bill.payments!, { id: "fictional-payment-2", amount: "80.00", reference: "FICTIONAL-FINAL", createdAt: "2026-11-03T09:00:00.000Z" }] };
    return { json: { bill: state.bill } };
  };
  await page.getByLabel("Payment reference", { exact: true }).fill("FICTIONAL-FINAL");
  await page.getByRole("button", { name: "Confirm payment", exact: true }).click();
  await expect(ribbon(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm payment", exact: true })).toHaveCount(0);
  await expect(page.getByRole("cell", { name: "FICTIONAL-PARTIAL", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "FICTIONAL-FINAL", exact: true })).toBeVisible();
  expect(state.actions).toHaveLength(2); expect(state.unexpected).toEqual([]);
});

for (const failure of [
  { status: 409, message: "The bill has changed. Refresh before taking action." },
  { status: 422, message: "Payment exceeds the outstanding amount." },
  { status: 409, message: "A record with these details already exists." },
]) test(`retains entered amount/reference after server rejection: ${failure.message}`, async ({ page }) => {
  const state = await setup(page);
  state.action = async () => ({ status: failure.status, json: { error: failure.message } });
  await page.getByLabel("Payment amount (AED)", { exact: true }).fill("25.00");
  await page.getByLabel("Payment reference", { exact: true }).fill("KEEP-THIS-REFERENCE");
  await page.getByRole("button", { name: "Confirm payment", exact: true }).click();
  await expect(page.getByText(failure.message, { exact: true })).toBeVisible();
  await expect(page.getByLabel("Payment amount (AED)", { exact: true })).toHaveValue("25.00");
  await expect(page.getByLabel("Payment reference", { exact: true })).toHaveValue("KEEP-THIS-REFERENCE");
  await expect(ribbon(page)).toHaveCount(0);
  expect(state.actions).toHaveLength(1); expect(state.unexpected).toEqual([]);
});

test("rejects wrong bill or nonadvancing response identity before reporting success or clearing inputs", async ({ page }) => {
  const state = await setup(page);
  state.action = async () => ({ json: { bill: { ...state.bill, id: "wrong-bill", version: 2, paymentStatus: "PAID", paidAmount: "105.00" } } });
  await page.getByLabel("Payment amount (AED)", { exact: true }).fill("25.00");
  await page.getByLabel("Payment reference", { exact: true }).fill("KEEP-UNVERIFIED");
  await page.getByRole("button", { name: "Confirm payment", exact: true }).click();
  await expect(page.getByText("The payment result could not be verified. Refresh this bill before retrying.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Payment reference", { exact: true })).toHaveValue("KEEP-UNVERIFIED");
  await expect(page.getByRole("button", { name: "Confirm payment", exact: true })).toBeDisabled();
  await expect(ribbon(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh bill", exact: true }).click();
  await expect(page.getByRole("button", { name: "Confirm payment", exact: true })).toBeEnabled();
  state.action = async () => ({ json: { bill: { ...state.bill, jobId: "wrong-job", version: 2 } } });
  await page.getByRole("button", { name: "Confirm payment", exact: true }).click();
  await expect(page.getByRole("button", { name: "Confirm payment", exact: true })).toBeDisabled();
  await expect(page.getByLabel("Payment reference", { exact: true })).toHaveValue("KEEP-UNVERIFIED");
  await page.getByRole("button", { name: "Refresh bill", exact: true }).click();
  await expect(page.getByRole("button", { name: "Confirm payment", exact: true })).toBeEnabled();
  state.action = async () => ({ json: { bill: state.bill } });
  await page.getByRole("button", { name: "Confirm payment", exact: true }).click();
  await expect(page.getByRole("button", { name: "Confirm payment", exact: true })).toBeDisabled();
  await expect(page.getByLabel("Payment reference", { exact: true })).toHaveValue("KEEP-UNVERIFIED");
  expect(state.actions).toHaveLength(3); expect(state.unexpected).toEqual([]);
});

test("fails closed when the requested bill GET returns another bill", async ({ page }) => {
  const state = await setup(page, { ...fixture(), id: "another-bill" });
  await expect(page.getByText("The returned bill does not match this payment page. Refresh the bill.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Payment reference", { exact: true })).toHaveCount(0);
  expect(state.actions).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("Paid detail and payment cards show the diagonal ribbon without mobile overflow", async ({ page }) => {
  const state = await setup(page, { ...fixture(), paymentStatus: "PAID", paidAmount: "105.00", outstanding: "0.00",
    payments: [{ id: "fictional-paid", amount: "105.00", reference: "FICTIONAL-PAID", createdAt: "2026-11-03T08:30:00.000Z" }] });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 375, height: 900 }]) {
    await page.setViewportSize(viewport);
    for (const suffix of ["/payment", ""]) {
      await page.goto(`/bills/${billId}${suffix}`);
      await expect(ribbon(page)).toBeVisible();
      const corner = await ribbon(page).boundingBox();
      const firstLabel = await ribbon(page).locator("..").locator("dt").first().boundingBox();
      expect(corner).not.toBeNull(); expect(firstLabel).not.toBeNull();
      expect(firstLabel!.y).toBeGreaterThanOrEqual(corner!.y + corner!.height);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`paid-${suffix ? "payment" : "detail"}-${viewport.width}.png`), fullPage: true });
    }
  }
  expect(state.actions).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("entry continuation skips payment and opens a blank bill for the actual saved job while ignoring allocation query strings", async ({ page }) => {
  const state = await setup(page, { ...fixture(), syncRecords: [{ id: "fictional-entry-sync", target: "ZOHO", status: "PENDING", externalId: null }] }, true);
  await expect(page.getByRole("link", { name: "Add another bill", exact: true })).toHaveAttribute("href", "/bills/new?jobId=job");
  await expect(page.getByRole("link", { name: "Back to job history", exact: true })).toHaveAttribute("href", "/jobs/job");
  await expect(page.getByRole("link", { name: "Change job", exact: true })).toHaveAttribute("href", "/bills/manual");
  await expect(page.getByRole("group", { name: "Saved bill confirmation", exact: true })).toContainText("Provider confirmation is pending");
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.getByRole("link", { name: "Skip payment", exact: true }).click();
  await expect(page).toHaveURL(/\/bills\/new\?jobId=job$/);
  await expect(page.getByRole("heading", { name: "New Bill", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Company", exact: true })).toHaveValue("fictional-company");
  await expect(page.getByRole("combobox", { name: "Company", exact: true })).toBeDisabled();
  await expect(page.getByLabel(/^Job \/ project/)).toHaveValue("job");
  await expect(page.getByLabel(/^Job \/ project/)).toBeDisabled();
  await expect(page.getByLabel("Bill#")).toHaveValue("");
  await expect(page.getByRole("list", { name: "Selected invoice attachments", exact: true })).toHaveCount(0);
  expect(state.actions).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("entry continuation records only an explicit payment and retains same-job navigation after confirmation", async ({ page }) => {
  const state = await setup(page, { ...fixture(), editEligibility: { allowed: true, reason: null, mode: "provider_update" } }, true);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  state.action = async body => {
    expect(body).toEqual({ action: "payment", version: 1, amount: "105.00", reference: "FICTIONAL-EXPLICIT-PAYMENT" });
    await pending;
    state.bill = { ...state.bill, version: 2, paidAmount: "105.00", outstanding: "0.00", paymentStatus: "PAID",
      payments: [{ id: "fictional-explicit-payment", amount: "105.00", reference: "FICTIONAL-EXPLICIT-PAYMENT", createdAt: "2026-11-04T10:00:00Z" }] };
    return { json: { bill: state.bill } };
  };
  expect(state.actions).toEqual([]);
  await expect(page.getByRole("link", { name: "Edit saved bill", exact: true })).toBeVisible();
  await page.getByLabel("Payment reference", { exact: true }).fill("FICTIONAL-EXPLICIT-PAYMENT");
  await page.getByRole("button", { name: "Confirm payment", exact: true }).click();
  for (const label of ["Add another bill", "Back to job history", "Change job", "Skip payment"])
    await expect(page.getByRole("button", { name: label, exact: true })).toBeDisabled();
  for (const label of ["View saved bill", "Edit saved bill", "View job history"]) {
    await expect(page.getByRole("link", { name: label, exact: true })).toHaveCount(0);
    await expect(page.locator('[aria-disabled="true"]').filter({ hasText: label })).toBeVisible();
  }
  await expect(page.getByRole("button", { name: "Refresh saved bill status", exact: true })).toBeDisabled();
  await expect(ribbon(page)).toHaveCount(0);
  release();
  await expect(ribbon(page)).toBeVisible();
  await expect(page.getByText("Payment recorded successfully.", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Add another bill", exact: true }).click();
  await expect(page).toHaveURL(/\/bills\/new\?jobId=job$/);
  await expect(page.getByRole("heading", { name: "New Bill", exact: true })).toBeVisible();
  expect(state.actions).toHaveLength(1); expect(state.unexpected).toEqual([]);
});
