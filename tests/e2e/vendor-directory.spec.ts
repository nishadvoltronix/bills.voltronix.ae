import { expect, test, type Page } from "@playwright/test";

// Fictional directory responses only. Authentication uses the existing local seed;
// all supplier mutations are intercepted, so these tests cannot import or create records.
const companyA = "directory-company-alpha";
const companyB = "directory-company-beta";
const organizationA = "930000000001";
const organizationB = "930000000002";
type Row = { id: string | null; companyId: string; name: string; currency: string; email: string | null;
  trn: string | null; status: "active" | "inactive" | "local"; externalVendorId?: string;
  organizationId?: string; dataCenter?: string; environment?: "production" | "sandbox" };
type Directory = { companyId: string; organizationId: string | null; dataCenter: string | null;
  environment: "production" | "sandbox" | null; source: "books" | "local"; vendors: Row[];
  page: number; perPage: number; hasMore: boolean; warning: string | null };
const alpha: Row = { id: null, companyId: companyA, name: "Fictional Alpha Components", currency: "AED",
  email: "alpha-directory@example.invalid", trn: "100000000000031", status: "active", externalVendorId: "940000000001",
  organizationId: organizationA, dataCenter: "US", environment: "production" };
const alphaInactive: Row = { ...alpha, name: "Fictional Alpha Archived Supplier", currency: "JPY", status: "inactive",
  email: "archived-directory@example.invalid", externalVendorId: "940000000003" };
const beta: Row = { ...alpha, companyId: companyB, name: "Fictional Beta Electrical", currency: "USD",
  email: "beta-directory@example.invalid", trn: "100000000000032", organizationId: organizationB, externalVendorId: "940000000002" };
const companySelector = (page: Page) => page.locator("#vendor-directory-company");
const search = (page: Page) => page.getByRole("textbox", { name: "Search vendors", exact: true });
const rowFor = (page: Page, name: string) => page.getByRole("row").filter({ hasText: name });
function envelope(companyId: string, vendors: Row[] = [], extra: Partial<Directory> = {}): Directory {
  return { companyId, organizationId: companyId === companyA ? organizationA : organizationB,
    dataCenter: "US", environment: "production", source: "books", vendors, page: 1, perPage: 100,
    hasMore: false, warning: null, ...extra };
}
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
async function openDirectory(page: Page, companyId?: string) {
  await page.goto("/vendors");
  await expect(page.getByRole("heading", { name: "Vendors", exact: true })).toBeVisible();
  if (companyId) await companySelector(page).selectOption(companyId);
}

test.beforeEach(async ({ page, baseURL }) => {
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password || !baseURL) throw new Error("Local fictional seed credentials and browser origin are required.");
  expect((await page.request.post(`${baseURL}/api/auth/login`, { headers: { Origin: baseURL }, data: { email, password } })).status()).toBe(200);
  await page.route("**/api/companies", (route) => route.fulfill({ json: { companies: [
    { id: companyA, name: "Fictional Company Alpha" }, { id: companyB, name: "Fictional Company Beta" },
  ] } }));
  await page.route(/\/api\/vendors(?:\/[^?]*)?(?:\?.*)?$/, (route) => route.fulfill({ status: 500,
    json: { error: "Unexpected supplier request; no data was changed." } }));
  await page.route("**/api/vendors/directory?*", (route) => {
    const params = new URL(route.request().url()).searchParams;
    const companyId = params.get("companyId")!;
    const query = params.get("q")?.toLowerCase() ?? "";
    const rows = companyId === companyA ? [alpha, alphaInactive] : companyId === companyB ? [beta] : [];
    return route.fulfill({ json: envelope(companyId, rows.filter((vendor) => vendor.name.toLowerCase().includes(query)),
      { page: Number(params.get("page") ?? "1") }) });
  });
});
test.afterEach(async ({ page, baseURL }) => {
  if (baseURL) await page.request.post(`${baseURL}/api/auth/logout`, { headers: { Origin: baseURL } });
});

test("requires a company before requesting vendors and keeps browsing read-only", async ({ page }) => {
  const requests: { method: string; url: string }[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/vendors")) requests.push({ method: request.method(), url: request.url() });
  });
  await openDirectory(page);
  await expect(companySelector(page)).toHaveValue("");
  await expect(page.getByText("Select a company to view its vendors", { exact: true })).toBeVisible();
  await expect(search(page)).toBeDisabled();
  await expect(page.getByRole("table")).toHaveCount(0);
  expect(requests).toEqual([]);
  await companySelector(page).selectOption(companyA);
  await expect(rowFor(page, alpha.name)).toBeVisible();
  await expect(rowFor(page, alpha.name)).toContainText(alpha.email!);
  await expect(rowFor(page, alpha.name)).toContainText(alpha.trn!);
  await expect(rowFor(page, alphaInactive.name)).toContainText("JPY");
  await expect(rowFor(page, alphaInactive.name)).toContainText(/inactive/i);
  await companySelector(page).selectOption(companyB);
  await expect(rowFor(page, beta.name)).toContainText("USD");
  await expect(rowFor(page, alpha.name)).toHaveCount(0);
  await companySelector(page).selectOption("");
  await expect(search(page)).toBeDisabled();
  await expect(rowFor(page, beta.name)).toHaveCount(0);
  expect(requests.length).toBeGreaterThanOrEqual(2);
  expect(requests.every((request) => request.method === "GET" && new URL(request.url).pathname === "/api/vendors/directory")).toBe(true);
  expect(requests.every((request) => [companyA, companyB].includes(new URL(request.url).searchParams.get("companyId")!))).toBe(true);
});

test("keeps search and paging scoped to the company and resets page when the query changes", async ({ page }) => {
  const requests: URLSearchParams[] = [];
  const nextPage: Row = { ...alpha, name: "Fictional Alpha Page Two", externalVendorId: "940000000004" };
  const firstPage = Array.from({ length: 100 }, (_, index): Row => index === 0 ? alpha : {
    ...alpha, name: `Fictional Alpha Supplier ${String(index).padStart(3, "0")}`, externalVendorId: String(950000000000 + index),
  });
  await page.route("**/api/vendors/directory?*", (route) => {
    const params = new URL(route.request().url()).searchParams;
    requests.push(params);
    const pageNumber = Number(params.get("page") ?? "1");
    const hasQuery = Boolean(params.get("q"));
    return route.fulfill({ json: envelope(companyA, hasQuery ? [alphaInactive] : pageNumber === 2 ? [nextPage] : firstPage,
      { page: pageNumber, hasMore: !hasQuery && pageNumber === 1 }) });
  });
  await openDirectory(page, companyA);
  await expect(rowFor(page, alpha.name)).toBeVisible();
  await expect(page.getByRole("row")).toHaveCount(101);
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(rowFor(page, nextPage.name)).toBeVisible();
  await expect(rowFor(page, alpha.name)).toHaveCount(0);
  await page.getByRole("button", { name: "Previous page", exact: true }).click();
  await expect(rowFor(page, alpha.name)).toBeVisible();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(rowFor(page, nextPage.name)).toBeVisible();
  await search(page).fill("Archived");
  await expect(rowFor(page, alphaInactive.name)).toBeVisible();
  expect(requests.at(-1)?.get("page")).toBe("1");
  expect(requests.at(-1)?.get("q")).toBe("Archived");
  expect(requests.every((params) => params.get("companyId") === companyA)).toBe(true);
  await expect(page.getByRole("button", { name: "Previous page", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeDisabled();
});

test("switching company clears search and rejects a delayed old-company page", async ({ page }) => {
  const pending = deferred();
  let waiting = false;
  let responded = false;
  await page.route("**/api/vendors/directory?*", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get("companyId") !== companyA || params.get("q") !== "slow") return route.fallback();
    waiting = true;
    await pending.promise;
    await route.fulfill({ json: envelope(companyA, [alpha]) }).catch(() => undefined);
    responded = true;
  });
  try {
    await openDirectory(page, companyA);
    await expect(rowFor(page, alpha.name)).toBeVisible();
    await search(page).fill("slow");
    await expect.poll(() => waiting).toBe(true);
    await companySelector(page).selectOption(companyB);
    await expect(search(page)).toHaveValue("");
    await expect(rowFor(page, beta.name)).toBeVisible();
    pending.release();
    await expect.poll(() => responded).toBe(true);
    await expect(rowFor(page, alpha.name)).toHaveCount(0);
    await expect(rowFor(page, beta.name)).toBeVisible();
  } finally { pending.release(); }
});

test("ignores a delayed earlier search after a newer query has completed", async ({ page }) => {
  const pending = deferred();
  let waiting = false;
  let responded = false;
  await page.route("**/api/vendors/directory?*", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get("q") !== "old") return route.fallback();
    waiting = true;
    await pending.promise;
    await route.fulfill({ json: envelope(companyA, [alpha]) }).catch(() => undefined);
    responded = true;
  });
  try {
    await openDirectory(page, companyA);
    await search(page).fill("old");
    await expect.poll(() => waiting).toBe(true);
    await search(page).fill("Archived");
    await expect(rowFor(page, alphaInactive.name)).toBeVisible();
    pending.release();
    await expect.poll(() => responded).toBe(true);
    await expect(rowFor(page, alpha.name)).toHaveCount(0);
    await expect(rowFor(page, alphaInactive.name)).toBeVisible();
  } finally { pending.release(); }
});

test("rejects wrong-company or wrong-destination rows before rendering any directory data", async ({ page }) => {
  const wrongOrganization: Row = { ...alpha, name: "Fictional Wrong Organization", organizationId: organizationB, externalVendorId: "940000000005" };
  const wrongDataCenter: Row = { ...alpha, name: "Fictional Wrong Data Center", dataCenter: "EU", externalVendorId: "940000000006" };
  const wrongEnvironment: Row = { ...alpha, name: "Fictional Wrong Environment", environment: "sandbox", externalVendorId: "940000000007" };
  const invalidRows = [beta, wrongOrganization, wrongDataCenter, wrongEnvironment];
  let attempt = 0;
  await page.route("**/api/vendors/directory?*", (route) => route.fulfill({ json: envelope(companyA,
    attempt < invalidRows.length ? [alpha, invalidRows[attempt++]] : [alpha]) }));
  await openDirectory(page, companyA);
  for (const [index, invalid] of invalidRows.entries()) {
    await expect.poll(() => attempt).toBe(index + 1);
    await expect(page.getByRole("button", { name: "Retry vendor directory", exact: true })).toBeVisible();
    await expect(rowFor(page, invalid.name)).toHaveCount(0);
    await expect(rowFor(page, alpha.name)).toHaveCount(0);
    await page.getByRole("button", { name: "Retry vendor directory", exact: true }).click();
  }
  await expect(rowFor(page, alpha.name)).toBeVisible();
  expect(attempt).toBe(invalidRows.length);
});

for (const scenario of ["company", "page"] as const) {
  test(`rejects a directory envelope for a different ${scenario}`, async ({ page }) => {
    await page.route("**/api/vendors/directory?*", (route) => route.fulfill({ json: scenario === "company"
      ? envelope(companyB, [beta]) : envelope(companyA, [alpha], { page: 2 }) }));
    await openDirectory(page, companyA);
    await expect(page.getByRole("button", { name: "Retry vendor directory", exact: true })).toBeVisible();
    await expect(page.getByRole("table")).toHaveCount(0);
    await expect(rowFor(page, alpha.name)).toHaveCount(0);
    await expect(rowFor(page, beta.name)).toHaveCount(0);
  });
}

test("shows a clean empty result without leaking the previous company's vendors", async ({ page }) => {
  await openDirectory(page, companyA);
  await expect(rowFor(page, alpha.name)).toBeVisible();
  await page.route("**/api/vendors/directory?*", (route) => route.fulfill({ json: envelope(companyB) }));
  await companySelector(page).selectOption(companyB);
  await expect(page.getByText("No vendors found", { exact: true })).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  await expect(rowFor(page, alpha.name)).toHaveCount(0);
});

test("retries a provider warning without claiming a clean empty directory", async ({ page }) => {
  let attempts = 0;
  const warning = "Fictional Books directory temporarily unavailable. Retry to load suppliers.";
  await page.route("**/api/vendors/directory?*", (route) => route.fulfill({
    json: ++attempts === 1 ? envelope(companyA, [], { warning }) : envelope(companyA, [alpha]),
  }));
  await openDirectory(page, companyA);
  await expect(page.getByText(warning, { exact: true })).toBeVisible();
  await expect(page.getByText("No vendors found", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Retry vendor directory", exact: true }).click();
  await expect(rowFor(page, alpha.name)).toBeVisible();
  await expect(page.getByText(warning, { exact: true })).toHaveCount(0);
  expect(attempts).toBe(2);
});

test("retries an HTTP error and displays scoped local fallback records", async ({ page }) => {
  let attempts = 0;
  const local: Row = { id: "directory-local-beta", companyId: companyB, name: "Fictional Local Beta Supplier",
    currency: "AED", email: null, trn: null, status: "local" };
  await page.route("**/api/vendors/directory?*", (route) => ++attempts === 1
    ? route.fulfill({ status: 503, json: { error: "Fictional directory request failed." } })
    : route.fulfill({ json: envelope(companyB, [local],
      { organizationId: null, dataCenter: null, environment: null, source: "local" }) }));
  await openDirectory(page, companyB);
  await expect(page.getByText("Fictional directory request failed.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retry vendor directory", exact: true }).click();
  await expect(rowFor(page, local.name)).toBeVisible();
  await expect(rowFor(page, alpha.name)).toHaveCount(0);
  expect(attempts).toBe(2);
});

test("prefills Add vendor with the selected company and preserves the explicit create flow", async ({ page }) => {
  const saved: Record<string, unknown>[] = [];
  await page.route(/\/api\/vendors$/, (route) => {
    expect(route.request().method()).toBe("POST");
    saved.push(route.request().postDataJSON());
    return route.fulfill({ status: 201, json: { vendor: { id: "fictional-created-vendor", ...saved[0] } } });
  });
  await openDirectory(page, companyB);
  await expect(rowFor(page, beta.name)).toBeVisible();
  await page.getByRole("button", { name: "Add vendor", exact: true }).click();
  await expect(page.locator("#new-vendor-company")).toHaveValue(companyB);
  await page.getByRole("textbox", { name: "Vendor name", exact: true }).fill("Fictional New Beta Supplier");
  await page.getByRole("textbox", { name: "Email address", exact: true }).fill("new-directory@example.invalid");
  await page.getByRole("textbox", { name: "Tax registration number", exact: true }).fill("100000000000039");
  await page.getByRole("combobox", { name: "Default currency", exact: true }).selectOption("AED");
  expect(saved).toEqual([]);
  await page.getByRole("button", { name: "Create vendor", exact: true }).click();
  await expect(page.getByText("Vendor created in this workspace.", { exact: true })).toBeVisible();
  expect(saved).toEqual([{ companyId: companyB, name: "Fictional New Beta Supplier", email: "new-directory@example.invalid",
    trn: "100000000000039", currency: "AED" }]);
  await expect(companySelector(page)).toHaveValue(companyB);
  await expect(page.getByRole("heading", { name: "Add a workspace vendor", exact: true })).toHaveCount(0);
});
