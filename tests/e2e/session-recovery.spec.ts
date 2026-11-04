import { expect, test, type Page } from "@playwright/test";
import type { Bill, User } from "../../src/components/types";

// Authentication reaches only the guarded LOCAL test app. All business data,
// reauthentication responses and mutation failures below are fictional mocks.
const company = { id: "fictional-session-company", name: "Fictional session company" };
const billId = "fictional-session-bill", sessionError = { error: "Please sign in to continue.", code: "AUTH_SESSION_REQUIRED" };
function localOrigin() {
  const origin = new URL(String(test.info().project.use.baseURL));
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || !["3000", "3012"].includes(origin.port) ||
    origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/")
    throw new Error("Session browser checks require the isolated localhost test application.");
  return origin.origin;
}
test.afterEach(async ({ context }) => {
  // APIRequestContext bypasses page mocks, so only this test's real local
  // authentication session is removed. Business endpoints are never called.
  const response = await context.request.post("/api/auth/logout", { headers: { Origin: localOrigin() } });
  expect([200, 401]).toContain(response.status());
});
function fictionalBill(): Bill {
  return { id: billId, companyId: company.id, invoiceNumber: "FICTIONAL-SESSION-001", vendorId: "fictional-vendor", jobId: "fictional-job",
    invoiceDate: "2026-11-04", category: "MATERIALS", currency: "AED", status: "READY", paymentStatus: "UNPAID", total: "105.00",
    subtotal: "100.00", vatAmount: "5.00", paidAmount: "0.00", outstanding: "105.00", discount: "0.00", vatRate: "5.00", version: 1,
    createdAt: "2026-11-04T08:00:00Z", createdBy: { id: "fictional-author", name: "Fictional author" },
    vendor: { id: "fictional-vendor", companyId: company.id, name: "Fictional session supplier", currency: "AED" },
    job: { id: "fictional-job", companyId: company.id, jobNumber: "JOB-SESSION", name: "Fictional session job", customer: "Fictional customer", currency: "AED",
      contractValue: null, approvedVariations: null }, payments: [], documents: [], lines: [],
    syncRecords: [{ id: "fictional-sync", target: "ZOHO", status: "PENDING", externalId: null }] };
}
async function setup(page: Page, mode: "list" | "payment" = "payment", simultaneous = false) {
  const origin = localOrigin();
  const email = process.env.SEED_ADMIN_EMAIL, password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password) throw new Error("The existing LOCAL Admin test credentials are required.");
  const response = await page.request.post("/api/auth/login", { headers: { Origin: origin }, data: { email, password } });
  expect(response.status()).toBe(200);
  const { user } = await response.json() as { user: User };
  const state = { actor: user, bill: fictionalBill(), expired: simultaneous, dual: new Set<string>(), reads: 0, companyReads: 0,
    logins: 0, loginStatus: 200, loginMessage: "The email or password is incorrect.", loginUser: user,
    actions: [] as Record<string, unknown>[], mutationFailure: sessionError as { error: string; code?: string }, unexpected: [] as string[] };
  let releaseDual!: () => void;
  const dual = new Promise<void>(resolve => { releaseDual = resolve; });
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    if (url.origin !== origin) { state.unexpected.push("External request"); return route.abort(); }
    if (path === "/api/auth/login" && method === "POST") {
      state.logins++;
      if (state.loginStatus === 200) {
        state.expired = false;
        return route.fulfill({ json: { user: state.loginUser } });
      }
      return route.fulfill({ status: state.loginStatus, json: { error: state.loginMessage } });
    }
    if (path === "/api/auth/me" && method === "GET") return route.fulfill({ status: state.expired ? 401 : 200,
      json: state.expired ? sessionError : { user: state.loginUser } });
    if (method === "GET" && (path === "/api/companies" || path === "/api/bills" || path === `/api/bills/${billId}`)) {
      if (path === "/api/companies") state.companyReads++; else state.reads++;
      if (simultaneous && state.expired && ["/api/companies", "/api/bills"].includes(path)) {
        state.dual.add(path); if (state.dual.size === 2) releaseDual(); await dual;
      }
      if (state.expired) return route.fulfill({ status: 401, json: sessionError });
      if (path === "/api/companies") return route.fulfill({ json: { companies: [company] } });
      return route.fulfill({ json: path === "/api/bills" ? { bills: [state.bill], total: 1, page: 1, pageSize: 20 } : { bill: state.bill } });
    }
    if (path === `/api/bills/${billId}/actions` && method === "POST") {
      state.actions.push(request.postDataJSON() as Record<string, unknown>);
      if (state.mutationFailure.code === "AUTH_SESSION_REQUIRED") state.expired = true;
      return route.fulfill({ status: 401, json: state.mutationFailure });
    }
    if (method === "GET" && path === "/api/jobs") return route.fulfill({ json: { jobs: [state.bill.job] } });
    if (method === "GET" && path === "/api/vendors") return route.fulfill({ json: { vendors: [state.bill.vendor] } });
    state.unexpected.push(`${method} ${path}`);
    return route.fulfill({ status: 409, json: { error: "Fictional session check: this operation is blocked." } });
  });
  await page.goto(mode === "list" ? "/bills" : `/bills/${billId}/payment?entry=1&saved=1`);
  return state;
}
const dialog = (page: Page) => page.getByRole("dialog", { name: "Sign in to continue", exact: true });
async function reauthenticate(page: Page) {
  await dialog(page).getByLabel("Password", { exact: true }).fill("fictional-reauthentication-password");
  await dialog(page).getByRole("button", { name: "Sign in again", exact: true }).click();
}
async function enterPayment(page: Page) {
  await page.getByLabel("Payment amount (AED)", { exact: true }).fill("25.00");
  await page.getByLabel("Payment reference", { exact: true }).fill("KEEP-SESSION-PAYMENT");
}
async function expectPaymentPreserved(page: Page) {
  await expect(page.getByLabel("Payment amount (AED)", { exact: true })).toHaveValue("25.00");
  await expect(page.getByLabel("Payment reference", { exact: true })).toHaveValue("KEEP-SESSION-PAYMENT");
}

test("simultaneous company and bill session failures show one dialog and reload only reads after same-user sign-in", async ({ page }) => {
  const state = await setup(page, "list", true);
  await expect(dialog(page)).toHaveCount(1);
  await expect(dialog(page).getByLabel("Work email", { exact: true })).toHaveValue(state.actor.email);
  await expect(dialog(page).getByLabel("Work email", { exact: true })).toHaveAttribute("readonly", "");
  expect([...state.dual].sort()).toEqual(["/api/bills", "/api/companies"]);
  await reauthenticate(page);
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "FICTIONAL-SESSION-001", exact: true })).toBeVisible();
  await expect(page.locator("#bill-list-company")).toContainText(company.name);
  expect(state.reads).toBeGreaterThan(1); expect(state.companyReads).toBeGreaterThan(1);
  expect(state.actions).toEqual([]); expect(state.logins).toBe(1); expect(state.unexpected).toEqual([]);
});

test("wrong-password recovery stays in the same dialog without losing the payment entry", async ({ page }) => {
  const state = await setup(page); await enterPayment(page); state.expired = true; state.loginStatus = 401;
  await page.getByRole("button", { name: "Refresh bill", exact: true }).click();
  await expect(dialog(page)).toBeVisible(); await reauthenticate(page);
  await expect(dialog(page).getByRole("alert")).toContainText(state.loginMessage);
  await expect(dialog(page)).toHaveCount(1); await expectPaymentPreserved(page);
  state.loginStatus = 200; await reauthenticate(page); await expect(dialog(page)).toHaveCount(0);
  await expectPaymentPreserved(page); expect(state.logins).toBe(2); expect(state.actions).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("an upstream unmarked 401 remains a local payment error without opening session recovery", async ({ page }) => {
  const state = await setup(page); state.mutationFailure = { error: "Zoho authorization has expired.", code: "AUTH_FAILED" };
  await enterPayment(page); await page.getByRole("button", { name: "Confirm payment", exact: true }).click();
  await expect(page.getByText(state.mutationFailure.error, { exact: true })).toBeVisible();
  await expect(dialog(page)).toHaveCount(0); await expectPaymentPreserved(page);
  expect(state.logins).toBe(0); expect(state.actions).toHaveLength(1); expect(state.unexpected).toEqual([]);
});

test("a different reauthenticated actor cannot unlock or replay the previous account's payment", async ({ page }) => {
  const state = await setup(page); await enterPayment(page); state.expired = true;
  await page.getByRole("button", { name: "Refresh bill", exact: true }).click();
  await expect(dialog(page)).toBeVisible(); state.loginUser = { ...state.actor, id: "different-actor" };
  await reauthenticate(page);
  await expect(dialog(page).getByRole("button", { name: "Reload workspace", exact: true })).toBeVisible();
  await expect(dialog(page)).toHaveCount(1); await expectPaymentPreserved(page);
  await page.evaluate(() => document.querySelector<HTMLFormElement>("#payment-reference")?.closest("form")?.requestSubmit());
  expect(state.actions).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("a session-rejected payment is never replayed automatically after reauthentication", async ({ page }) => {
  const state = await setup(page); await enterPayment(page);
  await page.getByRole("button", { name: "Confirm payment", exact: true }).click();
  await expect(dialog(page)).toBeVisible(); expect(state.actions).toHaveLength(1); await expectPaymentPreserved(page);
  await reauthenticate(page); await expect(dialog(page)).toHaveCount(0);
  await expectPaymentPreserved(page);
  await expect(page.getByRole("button", { name: "Confirm payment", exact: true })).toBeEnabled();
  expect(state.actions).toHaveLength(1); expect(state.unexpected).toEqual([]);
});

test("polling session expiry keeps the payment form mounted and its amount and reference unchanged", async ({ page }) => {
  const state = await setup(page); await enterPayment(page); state.expired = true;
  await expect(dialog(page)).toBeVisible(); await expectPaymentPreserved(page);
  await reauthenticate(page); await expect(dialog(page)).toHaveCount(0);
  await expectPaymentPreserved(page); expect(state.actions).toEqual([]); expect(state.unexpected).toEqual([]);
});
