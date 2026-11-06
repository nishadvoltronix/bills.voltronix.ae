import { expect, test, type Page } from "@playwright/test";
import type { Bill } from "../../src/components/types";

// Only LOCAL authentication reaches the app. Every bill and payment response is
// fictional and intercepted; no financial or provider mutation is sent through.
const billId = "fictional-payment-page";
const paymentFacts = { paymentDate: "2026-11-06", paymentMode: "Bank Transfer", paidThroughAccountId: "fictional-bank" };
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
    reads: 0,
    holdRead: null as Promise<void> | null,
    accounts: { companyId: "fictional-company", accounts: [
      { id: "fictional-bank", name: "Fictional operating bank", type: "bank", currency: "AED" },
      { id: "fictional-cash", name: "Fictional petty cash", type: "cash", currency: "AED" },
      { id: "foreign-currency", name: "Fictional USD account", type: "bank", currency: "USD" },
    ], warning: null as string | null },
    accountsError: null as { status: number; error: string } | null,
    action: (async () => ({ status: 409, json: { error: "Fictional payment response not configured." } })) as Action };
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname !== "127.0.0.1") { state.unexpected.push("External API request"); return route.abort(); }
    if (url.pathname.startsWith("/api/auth/")) return route.continue();
    if (url.pathname === `/api/bills/${billId}` && request.method() === "GET") {
      state.reads++; if (state.holdRead) await state.holdRead;
      return route.fulfill({ json: { bill: state.bill } });
    }
    if (url.pathname === "/api/companies/fictional-company/payment-accounts" && request.method() === "GET")
      return state.accountsError ? route.fulfill({ status: state.accountsError.status, json: { error: state.accountsError.error } })
        : route.fulfill({ json: state.accounts });
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
async function fillPaymentDetails(page: Page) {
  await page.getByLabel("Payment date", { exact: true }).fill(paymentFacts.paymentDate);
  await page.getByLabel("Payment method", { exact: true }).selectOption(paymentFacts.paymentMode);
  await page.getByLabel("Paid through account", { exact: true }).selectOption(paymentFacts.paidThroughAccountId);
}

test("unpaid bill requires actual payment details without assuming a method or paid-through account", async ({ page }) => {
  const state = await setup(page);
  await expect(page.getByRole("heading", { name: "Record payment", exact: true })).toBeVisible();
  await expect(page.getByLabel("Payment amount (AED)", { exact: true })).toHaveValue("105.00");
  await expect(page.getByText("Fictional supplier", { exact: true })).toBeVisible();
  await expect(page.getByText("JOB-FICTIONAL", { exact: false })).toBeVisible();
  await expect(page.getByText("Record a payment you have already made. This queues its record for Zoho Books; it does not transfer money.", { exact: true })).toBeVisible();
  await expect(ribbon(page)).toHaveCount(0);
  await expect(page.getByLabel("Payment date", { exact: true })).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  await expect(page.getByLabel("Payment method", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Paid through account", { exact: true })).toHaveValue("");
  await expect(page.getByRole("option", { name: "Fictional USD account (USD)", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Confirm payment", exact: true })).toBeDisabled();
  await page.getByRole("link", { name: "Back to bill", exact: true }).click();
  await expect(page.getByRole("link", { name: "Record payment", exact: true })).toHaveAttribute("href", `/bills/${billId}/payment`);
  expect(state.actions).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("confirmed partial then full payment refreshes history and Paid state, with no optimistic ribbon or inflight cancellation", async ({ page }) => {
  const state = await setup(page);
  await fillPaymentDetails(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  state.action = async body => {
    expect(body).toEqual({ action: "payment", version: 1, amount: "25.00", reference: "FICTIONAL-PARTIAL", ...paymentFacts });
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
  await expect(page.getByText("Payment recorded. Check its Zoho Books status in the payment history below.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Payment amount (AED)", { exact: true })).toHaveValue("80.00");
  await expect(page.getByLabel("Payment reference", { exact: true })).toHaveValue("");
  await expect(page.getByText("partially paid", { exact: true })).toBeVisible();
  await expect(ribbon(page)).toHaveCount(0);
  state.action = async body => {
    expect(body).toEqual({ action: "payment", version: 2, amount: "80.00", reference: "FICTIONAL-FINAL", ...paymentFacts });
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

test("the shared receipt accepts a same-version status refresh after a confirmed payment without losing payment data", async ({ page }) => {
  const initial = fixture(); initial.syncRecords = [{ id: "same-version-sync", target: "ZOHO", status: "PENDING", externalId: null }];
  const state = await setup(page, initial, true);
  await fillPaymentDetails(page);
  const outcome = page.getByRole("group", { name: "Saved bill confirmation", exact: true });
  await expect(outcome).toContainText("Provider confirmation is pending");
  state.action = async body => {
    expect(body).toEqual({ action: "payment", version: 1, amount: "25.00", reference: "FICTIONAL-SAME-VERSION", ...paymentFacts });
    state.bill = { ...state.bill, version: 2, paidAmount: "25.00", outstanding: "80.00", paymentStatus: "PARTIALLY_PAID",
      payments: [{ id: "same-version-payment", amount: "25.00", reference: "FICTIONAL-SAME-VERSION", createdAt: "2026-11-04T12:00:00Z" }] };
    return { json: { bill: state.bill } };
  };
  await page.getByLabel("Payment amount (AED)", { exact: true }).fill("25.00");
  await page.getByLabel("Payment reference", { exact: true }).fill("FICTIONAL-SAME-VERSION");
  await page.getByRole("button", { name: "Confirm payment", exact: true }).click();
  await expect(page.getByText("Payment recorded. Check its Zoho Books status in the payment history below.", { exact: true })).toBeVisible();
  await expect(outcome.getByRole("button", { name: "Refresh saved bill status", exact: true })).toBeEnabled();
  state.bill = { ...state.bill, syncRecords: [{ id: "same-version-sync", target: "ZOHO", status: "SYNCED", externalId: "fictional-external-bill" }] };
  await page.getByLabel("Payment reference", { exact: true }).fill("KEEP-NEXT-PAYMENT");
  await outcome.getByRole("button", { name: "Refresh saved bill status", exact: true }).click();
  await expect(outcome).toContainText("Bill saved and synchronized with Zoho Books.");
  await expect(page.getByLabel("Payment amount (AED)", { exact: true })).toHaveValue("80.00");
  await expect(page.getByLabel("Payment reference", { exact: true })).toHaveValue("KEEP-NEXT-PAYMENT");
  await expect(page.getByRole("cell", { name: "FICTIONAL-SAME-VERSION", exact: true })).toBeVisible();
  expect(state.bill.version).toBe(2); expect(state.actions).toHaveLength(1); expect(state.unexpected).toEqual([]);
});

for (const failure of [
  { status: 409, message: "The bill has changed. Refresh before taking action." },
  { status: 422, message: "Payment exceeds the outstanding amount." },
  { status: 409, message: "A record with these details already exists." },
]) test(`retains entered amount/reference after server rejection: ${failure.message}`, async ({ page }) => {
  const state = await setup(page);
  await fillPaymentDetails(page);
  state.action = async () => ({ status: failure.status, json: { error: failure.message } });
  await page.getByLabel("Payment amount (AED)", { exact: true }).fill("25.00");
  await page.getByLabel("Payment reference", { exact: true }).fill("KEEP-THIS-REFERENCE");
  await page.getByRole("button", { name: "Confirm payment", exact: true }).click();
  await expect(page.getByText(failure.message, { exact: true })).toBeVisible();
  await expect(page.getByLabel("Payment amount (AED)", { exact: true })).toHaveValue("25.00");
  await expect(page.getByLabel("Payment reference", { exact: true })).toHaveValue("KEEP-THIS-REFERENCE");
  await expect(page.getByLabel("Payment date", { exact: true })).toHaveValue(paymentFacts.paymentDate);
  await expect(page.getByLabel("Payment method", { exact: true })).toHaveValue(paymentFacts.paymentMode);
  await expect(page.getByLabel("Paid through account", { exact: true })).toHaveValue(paymentFacts.paidThroughAccountId);
  await expect(ribbon(page)).toHaveCount(0);
  expect(state.actions).toHaveLength(1); expect(state.unexpected).toEqual([]);
});

test("rejects wrong bill or nonadvancing response identity before reporting success or clearing inputs", async ({ page }) => {
  const state = await setup(page);
  await fillPaymentDetails(page);
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
      if (suffix) await expect(page.getByText("Not sent to Zoho Books: payment details are missing.", { exact: true })).toBeVisible();
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
  await fillPaymentDetails(page);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  state.action = async body => {
    expect(body).toEqual({ action: "payment", version: 1, amount: "105.00", reference: "FICTIONAL-EXPLICIT-PAYMENT", ...paymentFacts });
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
  await expect(page.getByText("Payment recorded. Check its Zoho Books status in the payment history below.", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Add another bill", exact: true }).click();
  await expect(page).toHaveURL(/\/bills\/new\?jobId=job$/);
  await expect(page.getByRole("heading", { name: "New Bill", exact: true })).toBeVisible();
  expect(state.actions).toHaveLength(1); expect(state.unexpected).toEqual([]);
});

test("account lookup failure or a foreign company response blocks recording without clearing payment facts", async ({ page }) => {
  const state = await setup(page);
  await fillPaymentDetails(page);
  await page.getByLabel("Payment amount (AED)", { exact: true }).fill("20.00");
  await page.getByLabel("Payment reference", { exact: true }).fill("KEEP-ACTUAL-FACTS");
  state.accountsError = { status: 503, error: "Fictional payment account permission is unavailable." };
  await page.getByRole("button", { name: "Refresh payment accounts", exact: true }).click();
  await expect(page.getByText(state.accountsError.error, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm payment", exact: true })).toBeDisabled();
  state.accountsError = null;
  state.accounts.companyId = "another-company";
  await page.getByRole("button", { name: "Refresh payment accounts", exact: true }).click();
  await expect(page.getByText("Payment accounts could not be verified for this company.", { exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "Fictional operating bank (AED)", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Confirm payment", exact: true })).toBeDisabled();
  state.accounts.companyId = "fictional-company";
  await page.getByRole("button", { name: "Refresh payment accounts", exact: true }).click();
  await expect(page.getByRole("button", { name: "Confirm payment", exact: true })).toBeEnabled();
  await expect(page.getByLabel("Payment amount (AED)", { exact: true })).toHaveValue("20.00");
  await expect(page.getByLabel("Payment reference", { exact: true })).toHaveValue("KEEP-ACTUAL-FACTS");
  await expect(page.getByLabel("Payment date", { exact: true })).toHaveValue(paymentFacts.paymentDate);
  await expect(page.getByLabel("Payment method", { exact: true })).toHaveValue(paymentFacts.paymentMode);
  await expect(page.getByLabel("Paid through account", { exact: true })).toHaveValue(paymentFacts.paidThroughAccountId);
  expect(state.actions).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("local payment stays distinct from Books confirmation and bounded polling preserves the next payment facts", async ({ page }) => {
  await page.clock.install();
  const initial = { ...fixture(), paidAmount: "25.00", paymentStatus: "PARTIALLY_PAID", outstanding: "80.00",
    syncRecords: [{ id: "fictional-synced-bill", target: "ZOHO", status: "SYNCED", externalId: "fictional-books-bill" }],
    payments: [{ id: "queued-payment", amount: "25.00", reference: "FICTIONAL-QUEUED", createdAt: "2026-11-06T08:00:00Z", ...paymentFacts,
      booksSync: { status: "QUEUED" as const, externalPaymentId: null, errorCode: null } }] };
  const state = await setup(page, initial);
  await expect(page.getByText("Queued for Zoho Books.", { exact: true })).toBeVisible();
  await expect(page.getByText("Payment confirmed in Zoho Books.", { exact: true })).toHaveCount(0);
  await fillPaymentDetails(page);
  await page.getByLabel("Payment amount (AED)", { exact: true }).fill("12.00");
  await page.getByLabel("Payment reference", { exact: true }).fill("NEXT-PAYMENT-FACTS");
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const initialReads = state.reads;
  await page.clock.fastForward(12_000);
  expect(state.reads).toBe(initialReads);
  let release!: () => void;
  state.holdRead = new Promise<void>(resolve => { release = resolve; });
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.fastForward(3_100);
  await expect.poll(() => state.reads).toBe(initialReads + 1);
  await page.clock.fastForward(12_000);
  expect(state.reads).toBe(initialReads + 1);
  state.bill = { ...state.bill, payments: [{ ...state.bill.payments![0], booksSync: {
    status: "FAILED", externalPaymentId: null, errorCode: "FICTIONAL_ACCOUNT_REJECTED",
  } }] };
  state.holdRead = null; release();
  await expect(page.getByText("Zoho Books payment failed.", { exact: true })).toBeVisible();
  await page.clock.fastForward(12_000);
  expect(state.reads).toBe(initialReads + 1);
  state.bill = { ...state.bill, payments: [{ ...state.bill.payments![0], booksSync: {
    status: "SYNCED", externalPaymentId: "fictional-confirmed-payment", errorCode: null,
  } }] };
  await page.getByRole("button", { name: "Refresh bill", exact: true }).click();
  await expect(page.getByText("Payment confirmed in Zoho Books.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Payment amount (AED)", { exact: true })).toHaveValue("12.00");
  await expect(page.getByLabel("Payment reference", { exact: true })).toHaveValue("NEXT-PAYMENT-FACTS");
  await expect(page.getByLabel("Payment date", { exact: true })).toHaveValue(paymentFacts.paymentDate);
  await expect(page.getByLabel("Payment method", { exact: true })).toHaveValue(paymentFacts.paymentMode);
  await expect(page.getByLabel("Paid through account", { exact: true })).toHaveValue(paymentFacts.paidThroughAccountId);
  expect(state.actions).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("a confirmed local payment reports its queued Books record without claiming remote Paid", async ({ page }) => {
  const state = await setup(page);
  await fillPaymentDetails(page);
  state.action = async body => {
    expect(body).toEqual({ action: "payment", version: 1, amount: "105.00", reference: "FICTIONAL-LOCAL-PAID", ...paymentFacts });
    state.bill = { ...state.bill, version: 2, paidAmount: "105.00", outstanding: "0.00", paymentStatus: "PAID",
      payments: [{ id: "new-payment", amount: "105.00", reference: "FICTIONAL-LOCAL-PAID", createdAt: "2026-11-06T08:00:00Z", ...paymentFacts,
        booksSync: { status: "QUEUED", externalPaymentId: null, errorCode: null } }] };
    return { json: { bill: state.bill } };
  };
  await page.getByLabel("Payment reference", { exact: true }).fill("FICTIONAL-LOCAL-PAID");
  expect(state.actions).toEqual([]);
  await page.getByRole("button", { name: "Confirm payment", exact: true }).click();
  await expect(ribbon(page)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Local payment summary", exact: true })).toBeVisible();
  await expect(page.getByText("Queued for Zoho Books.", { exact: true })).toBeVisible();
  await expect(page.getByText("Payment confirmed in Zoho Books.", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("cell", { name: "06 Nov 2026", exact: true })).toBeVisible();
  expect(state.actions).toHaveLength(1); expect(state.unexpected).toEqual([]);
});
