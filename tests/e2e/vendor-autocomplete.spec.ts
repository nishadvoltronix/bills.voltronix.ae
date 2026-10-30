import { expect, test, type Page, type Route } from "@playwright/test";
import type { Bill, Job, Vendor } from "../../src/components/types";

// Supplier, Books, bill and OCR responses are fictional browser fixtures.
// Only authentication uses the existing local seed. No provider or financial writes occur.
const companyA = "autocomplete-company-a";
const companyB = "autocomplete-company-b";
const organizationA = "910000000001";
const organizationB = "910000000002";
const vendorA: Vendor = { id: "autocomplete-vendor-a", companyId: companyA,
  name: "Fictional Alpha Supplier", currency: "USD", trn: "100000000000001", email: "alpha@example.invalid" };
const vendorB: Vendor = { id: "autocomplete-vendor-b", companyId: companyB,
  name: "Fictional Beta Supplier", currency: "AED", trn: "100000000000002", email: "beta@example.invalid" };
type Suggestion = Omit<Vendor, "id"> & { id: string | null; externalVendorId?: string;
  organizationId?: string; dataCenter?: string; environment?: "production" | "sandbox" };
const remoteA: Suggestion = { ...vendorA, id: null, externalVendorId: "920000000001",
  organizationId: organizationA, dataCenter: "US", environment: "production" };
const remoteB: Suggestion = { ...vendorB, id: null, externalVendorId: "920000000002",
  organizationId: organizationB, dataCenter: "US", environment: "production" };
const jobs: Job[] = [vendorA, vendorB].map((vendor, index) => ({
  id: `autocomplete-job-${index ? "b" : "a"}`, companyId: vendor.companyId,
  jobNumber: `FICTIONAL-${index + 1}`, name: "Fictional supplier test job", customer: "Fictional customer",
  currency: vendor.currency, contractValue: "1000.00", approvedVariations: "0.00",
}));
const supplierInput = (page: Page) => page.getByRole("combobox", { name: "Vendor Name", exact: true });
const companyInput = (page: Page) => page.getByRole("combobox", { name: "Company", exact: true });
const vendorDetails = (page: Page) => page.getByRole("region", { name: "Vendor details" });

function envelope(companyId: string, vendors: Suggestion[] = [], selectedVendor: Vendor | null = null) {
  return { companyId, organizationId: companyId === companyA ? organizationA : organizationB,
    vendors, selectedVendor, warning: null as string | null, hasMore: false };
}
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
async function setup(page: Page) {
  await page.route("**/api/companies", (route) => route.fulfill({ json: { companies: [
    { id: companyA, name: "Fictional Company Alpha" }, { id: companyB, name: "Fictional Company Beta" },
  ] } }));
  await page.route("**/api/jobs", (route) => route.fulfill({ json: { jobs } }));
  await page.route("**/api/integrations", (route) => route.fulfill({ json: { zoho: { organizations: [
    { companyId: companyA, organizationId: organizationA, name: "Fictional Books Alpha", writeEnabled: false },
    { companyId: companyB, organizationId: organizationB, name: "Fictional Books Beta", writeEnabled: false },
  ] } } }));
  // Fail closed if the form regresses to downloading every accessible vendor.
  await page.route(/\/api\/vendors(?:\?.*)?$/, (route) => route.fulfill({
    status: 500, json: { error: "The company-specific autocomplete must use the search endpoint." },
  }));
  await page.route("**/api/vendors/search?*", (route) => {
    const params = new URL(route.request().url()).searchParams;
    const companyId = params.get("companyId")!;
    const vendor = companyId === companyA ? vendorA : vendorB;
    return route.fulfill({ json: envelope(companyId, params.has("vendorId") ? [] : [companyId === companyA ? remoteA : remoteB],
      params.get("vendorId") === vendor.id ? vendor : null) });
  });
  await page.route("**/api/vendors/resolve", (route) => {
    const body = route.request().postDataJSON();
    const vendor = body.companyId === companyA ? vendorA : vendorB;
    const remote = body.companyId === companyA ? remoteA : remoteB;
    expect(body).toEqual({ companyId: vendor.companyId, organizationId: remote.organizationId,
      externalVendorId: remote.externalVendorId, dataCenter: "US", environment: "production" });
    return route.fulfill({ json: { vendor } });
  });
}
async function openForm(page: Page, companyId?: string) {
  await page.goto("/bills/new");
  await expect(page.getByRole("heading", { name: "New Bill", exact: true })).toBeVisible();
  if (companyId) await companyInput(page).selectOption(companyId);
}
async function selectSupplier(page: Page, vendor: Vendor) {
  await supplierInput(page).fill(vendor.name);
  await page.getByRole("option", { name: new RegExp(`^${vendor.name}`) }).click();
  await expect(supplierInput(page)).toHaveValue(vendor.name);
  await expect(vendorDetails(page)).toContainText(vendor.email!);
}
async function fillBill(page: Page, companyId: string) {
  await page.getByLabel(/^Job \/ project/).selectOption(companyId === companyA ? jobs[0].id : jobs[1].id);
  await page.getByLabel("Bill#").fill("FICTIONAL-AUTOCOMPLETE-1");
  await page.getByLabel("Bill Date").fill("2026-10-29");
  await page.getByLabel("Line 1 description").fill("Fictional supplier browser test");
  await page.getByLabel("Line 1 unit price").fill("10.00");
}
function fixtureBill(): Bill {
  return { id: "autocomplete-existing-bill", companyId: companyA, vendorId: vendorA.id,
    jobId: jobs[0].id, invoiceNumber: "FICTIONAL-EXISTING-1", invoiceDate: "2026-10-29",
    category: "MATERIALS", currency: "USD", status: "DRAFT", version: 7,
    discount: "0.00", vatRate: "5.00", subtotal: "10.00", vatAmount: "0.50", total: "10.50",
    paidAmount: "0.00", createdAt: "2026-10-29T08:00:00Z", vendor: vendorA, job: jobs[0],
    lines: [{ description: "Fictional existing material", quantity: "1", unitPrice: "10.00" }],
    documents: [{ id: "autocomplete-original", fileName: "FICTIONAL-original.pdf" }], payments: [], syncRecords: [] };
}

test.beforeEach(async ({ page, baseURL }) => {
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password || !baseURL) throw new Error("Local fictional seed credentials and browser origin are required.");
  const result = await page.request.post(`${baseURL}/api/auth/login`, { headers: { Origin: baseURL }, data: { email, password } });
  expect(result.status()).toBe(200);
  await setup(page);
});
test.afterEach(async ({ page, baseURL }) => {
  if (baseURL) await page.request.post(`${baseURL}/api/auth/logout`, { headers: { Origin: baseURL } });
});

for (const vendor of [vendorA, vendorB]) {
  test(`selects the exact Books supplier for ${vendor.companyId} and saves its local ID`, async ({ page }) => {
    const lookups: string[] = [];
    const saves: Record<string, unknown>[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/vendors/search") lookups.push(request.url());
    });
    await page.route("**/api/bills", (route) => {
      saves.push(route.request().postDataJSON());
      return route.fulfill({ status: 422, json: { error: "Fictional save inspected; no bill created." } });
    });
    await openForm(page);
    await expect(supplierInput(page)).toBeDisabled();
    expect(lookups).toEqual([]);
    await companyInput(page).selectOption(vendor.companyId);
    await fillBill(page, vendor.companyId);
    await supplierInput(page).fill("Fictional");
    await expect(page.getByRole("option", { name: new RegExp(`^${vendor.name}`) })).toBeVisible();
    // Enter chooses the highlighted supplier; it must not submit the surrounding bill.
    await supplierInput(page).press("ArrowDown");
    await supplierInput(page).press("Enter");
    await expect(vendorDetails(page)).toContainText(vendor.email!);
    await expect(vendorDetails(page)).toContainText(vendor.trn!);
    await expect(page.getByLabel("Currency", { exact: true })).toHaveValue(vendor.currency);
    expect(saves).toEqual([]);
    expect(lookups.every((url) => new URL(url).searchParams.get("companyId") === vendor.companyId)).toBe(true);
    await page.getByRole("button", { name: "Save as draft", exact: true }).click();
    await expect(page.getByText("Fictional save inspected; no bill created.", { exact: true })).toBeVisible();
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ companyId: vendor.companyId, vendorId: vendor.id, currency: vendor.currency, submit: false });
    expect(saves[0]).not.toHaveProperty("externalVendorId");
  });
}

test("discards suggestions from another company and a different Books organization", async ({ page }) => {
  await page.route("**/api/vendors/search?*", (route) => route.fulfill({ json: envelope(companyA, [remoteA, remoteB,
    { ...remoteA, name: "Fictional Wrong Organization", organizationId: organizationB, externalVendorId: "920000000003" },
  ]) }));
  await openForm(page, companyA);
  await supplierInput(page).fill("Fictional");
  await expect(page.getByRole("option", { name: /^Fictional Alpha Supplier/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /^Fictional Beta Supplier/ })).toHaveCount(0);
  await expect(page.getByRole("option", { name: /^Fictional Wrong Organization/ })).toHaveCount(0);
});

test("an offline local supplier is labelled unmapped and saves only a local draft without resolving a Books contact", async ({ page }) => {
  const mutations: { path: string; body: Record<string, unknown> }[] = [];
  await page.route("**/api/vendors/search?*", route => route.fulfill({ json: {
    ...envelope(companyA), warning: "Books vendor search is unavailable. Local suppliers need a Books mapping before sync.",
    vendors: [{ ...vendorA, booksMappingRequired: true }, { ...vendorB, booksMappingRequired: true }],
  } }));
  await page.route(/\/api\/(?:bills|vendors\/resolve)$/, route => {
    mutations.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    return route.fulfill({ status: 422, json: { error: "Fictional local draft inspected; no bill created." } });
  });
  await openForm(page, companyA);
  await supplierInput(page).fill(vendorA.name);
  const option = page.getByRole("option", { name: /^Fictional Alpha Supplier/ });
  await expect(option).toContainText("Local · Books mapping required");
  await expect(page.getByRole("option", { name: /^Fictional Beta Supplier/ })).toHaveCount(0);
  await option.click();
  await expect(page.getByText("Local supplier selected. Save a draft; a verified Books mapping is required before sync.", { exact: true })).toBeVisible();
  await fillBill(page, companyA);
  await page.getByRole("button", { name: "Save as draft", exact: true }).click();
  await expect(page.getByText("Fictional local draft inspected; no bill created.", { exact: true })).toBeVisible();
  expect(mutations).toHaveLength(1);
  expect(mutations[0]).toMatchObject({ path: "/api/bills", body: { companyId: companyA, vendorId: vendorA.id, submit: false } });
  expect(mutations[0].body).not.toHaveProperty("externalVendorId");
});

test("switching company clears supplier and job and ignores a late old search", async ({ page }) => {
  const pending = deferred();
  let waiting = false;
  let responded = false;
  await page.route("**/api/vendors/search?*", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get("companyId") !== companyA || params.get("q") !== "slow") return route.fallback();
    waiting = true;
    await pending.promise;
    await route.fulfill({ json: envelope(companyA, [remoteA]) }).catch(() => undefined);
    responded = true;
  });
  try {
    await openForm(page, companyA);
    await selectSupplier(page, vendorA);
    await fillBill(page, companyA);
    await supplierInput(page).fill("slow");
    await expect.poll(() => waiting).toBe(true);
    await companyInput(page).selectOption(companyB);
    await expect(supplierInput(page)).toHaveValue("");
    await expect(page.getByLabel(/^Job \/ project/)).toHaveValue("");
    pending.release();
    await selectSupplier(page, vendorB);
    await expect.poll(() => responded).toBe(true);
    await expect(vendorDetails(page)).not.toContainText(vendorA.email!);
    await expect(supplierInput(page)).toHaveValue(vendorB.name);
  } finally { pending.release(); }
});

test("a supplier resolution completing after a company switch cannot select the old supplier", async ({ page }) => {
  const pending = deferred();
  let waiting = false;
  let responded = false;
  await page.route("**/api/vendors/resolve", async (route) => {
    if (route.request().postDataJSON().companyId !== companyA) return route.fallback();
    waiting = true;
    await pending.promise;
    await route.fulfill({ json: { vendor: vendorA } }).catch(() => undefined);
    responded = true;
  });
  try {
    await openForm(page, companyA);
    await supplierInput(page).fill(vendorA.name);
    await page.getByRole("option", { name: /^Fictional Alpha Supplier/ }).click();
    await expect.poll(() => waiting).toBe(true);
    await expect(page.getByRole("button", { name: "Save as draft", exact: true })).toBeDisabled();
    await companyInput(page).selectOption(companyB);
    await selectSupplier(page, vendorB);
    pending.release();
    await expect.poll(() => responded).toBe(true);
    await expect(supplierInput(page)).toHaveValue(vendorB.name);
    await expect(page.getByLabel("Currency", { exact: true })).toHaveValue("AED");
    await expect(vendorDetails(page)).not.toContainText(vendorA.email!);
  } finally { pending.release(); }
});

test("a job selected during supplier resolution keeps its currency when the late supplier differs", async ({ page }) => {
  const pending = deferred();
  let waiting = false;
  let responded = false;
  const aedJob: Job = { ...jobs[0], id: "autocomplete-aed-job", jobNumber: "FICTIONAL-AED", currency: "AED" };
  await page.route("**/api/jobs", (route) => route.fulfill({ json: { jobs: [...jobs, aedJob] } }));
  await page.route("**/api/vendors/resolve", async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({ companyId: companyA, externalVendorId: remoteA.externalVendorId });
    waiting = true;
    await pending.promise;
    await route.fulfill({ json: { vendor: vendorA } }).catch(() => undefined);
    responded = true;
  });
  try {
    await openForm(page, companyA);
    await expect(page.getByLabel(/^Job \/ project/)).toHaveValue("");
    await supplierInput(page).fill(vendorA.name);
    await page.getByRole("option", { name: /^Fictional Alpha Supplier/ }).click();
    await expect.poll(() => waiting).toBe(true);
    await page.getByLabel(/^Job \/ project/).selectOption(aedJob.id);
    await expect(page.getByLabel("Currency", { exact: true })).toHaveValue("AED");
    pending.release();
    await expect.poll(() => responded).toBe(true);
    await expect(vendorDetails(page)).toContainText(vendorA.email!);
    await expect(page.getByLabel(/^Job \/ project/)).toHaveValue(aedJob.id);
    await expect(page.getByLabel("Currency", { exact: true })).toHaveValue("AED");
    await expect(page.getByText("The selected vendor uses USD.", { exact: false })).toBeVisible();
  } finally { pending.release(); }
});

test("typing after selection clears the saved identity and cannot create a supplier from free text", async ({ page }) => {
  const writes: string[] = [];
  await page.route(/\/api\/(?:bills|vendors)$/, (route) => {
    writes.push(route.request().url());
    return route.fulfill({ status: 422, json: { error: "Unexpected fixture mutation." } });
  });
  await openForm(page, companyA);
  await selectSupplier(page, vendorA);
  await fillBill(page, companyA);
  await supplierInput(page).fill("Unselected free-text supplier");
  await expect(vendorDetails(page)).not.toContainText(vendorA.email!);
  // Dispatch bypasses native required validation to exercise the save handler's identity check.
  await page.locator("form.books-bill-form").dispatchEvent("submit");
  expect(writes).toEqual([]);
  await expect(supplierInput(page)).toHaveValue("Unselected free-text supplier");
});

test("empty search and failed search retry preserve other bill fields without mutations", async ({ page }) => {
  let recover = false;
  let failures = 0;
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method())) mutations.push(new URL(request.url()).pathname);
  });
  await page.route("**/api/vendors/search?*", (route) => {
    const q = new URL(route.request().url()).searchParams.get("q");
    if (q === "missing") return route.fulfill({ json: envelope(companyA) });
    if (q === "retry" && !recover) {
      failures++;
      return route.fulfill({ status: 503, json: { error: "Fictional supplier lookup interrupted." } });
    }
    return route.fallback();
  });
  await openForm(page, companyA);
  await page.getByLabel("Bill#").fill("PRESERVE-ON-RETRY");
  await supplierInput(page).fill("missing");
  await expect(vendorDetails(page)).toContainText(/no .*vendor|no .*supplier|no .*match/i);
  await expect(page.getByRole("listbox", { name: "Vendor suggestions" }).getByRole("option")).toHaveCount(0);
  await supplierInput(page).fill("retry");
  await expect(page.getByText("Fictional supplier lookup interrupted.", { exact: true })).toBeVisible();
  const previousFailures = failures;
  recover = true;
  await page.getByRole("button", { name: "Retry vendor search", exact: true }).click();
  await expect(page.getByRole("option", { name: /^Fictional Alpha Supplier/ })).toBeVisible();
  expect(previousFailures).toBeGreaterThan(0);
  await expect(page.getByLabel("Bill#")).toHaveValue("PRESERVE-ON-RETRY");
  expect(mutations).toEqual([]);
});

test("HTTP 200 provider warning offers retry and shows no-match only after a clean empty result", async ({ page }) => {
  let mode: "warning" | "empty" | "ready" = "warning";
  let requests = 0;
  await page.route("**/api/vendors/search?*", (route) => {
    requests++;
    const result = envelope(companyA, mode === "ready" ? [remoteA] : []);
    if (mode === "warning") result.warning = "Fictional Books supplier lookup unavailable.";
    return route.fulfill({ json: result });
  });
  await openForm(page, companyA);
  await supplierInput(page).fill("Fictional");
  await expect(page.getByText("Fictional Books supplier lookup unavailable.", { exact: true })).toBeVisible();
  await expect(page.getByText("No matching vendors. Try another name.", { exact: true })).toHaveCount(0);
  const initialRequests = requests;
  mode = "empty";
  await page.getByRole("button", { name: "Retry vendor search", exact: true }).click();
  await expect(page.getByText("No matching vendors. Try another name.", { exact: true })).toBeVisible();
  await expect(page.getByText("Fictional Books supplier lookup unavailable.", { exact: true })).toHaveCount(0);
  expect(requests).toBeGreaterThan(initialRequests);
  mode = "ready";
  await supplierInput(page).fill("Fictional Alpha");
  await expect(page.getByRole("option", { name: /^Fictional Alpha Supplier/ })).toBeVisible();
  await expect(page.getByText("No matching vendors. Try another name.", { exact: true })).toHaveCount(0);
});

test("failed Books selection can retry the same exact destination without submitting a bill", async ({ page }) => {
  const attempts: unknown[] = [];
  let saves = 0;
  await page.route("**/api/bills", (route) => { saves++; return route.fulfill({ status: 422, json: { error: "No fixture bill allowed." } }); });
  await page.route("**/api/vendors/resolve", (route) => {
    attempts.push(route.request().postDataJSON());
    return attempts.length === 1
      ? route.fulfill({ status: 503, json: { error: "Fictional supplier selection interrupted." } })
      : route.fulfill({ json: { vendor: vendorA } });
  });
  await openForm(page, companyA);
  await supplierInput(page).fill("Fictional Alpha");
  await page.getByRole("option", { name: /^Fictional Alpha Supplier/ }).click();
  await expect(page.getByText("Fictional supplier selection interrupted.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retry vendor selection", exact: true }).click();
  await expect(vendorDetails(page)).toContainText(vendorA.email!);
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(attempts[1]).toEqual({ companyId: companyA, organizationId: organizationA,
    externalVendorId: remoteA.externalVendorId, dataCenter: "US", environment: "production" });
  expect(saves).toBe(0);
});

test("editing hydrates its exact saved supplier outside search results and preserves attachments on duplicate rejection", async ({ page }) => {
  const bill = fixtureBill();
  const patches: Record<string, unknown>[] = [];
  const hydrated: string[] = [];
  const unexpectedChanges: string[] = [];
  await page.route(/\/api\/bills\/autocomplete-existing-bill\/(?:attachment|actions|sync)$/, (route) => {
    unexpectedChanges.push(route.request().url());
    return route.fulfill({ status: 409, json: { error: "The rejected edit must not upload or synchronize." } });
  });
  await page.route("**/api/vendors/search?*", (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (params.has("vendorId")) hydrated.push(params.get("vendorId")!);
    return route.fulfill({ json: envelope(companyA, [], params.get("vendorId") === vendorA.id ? vendorA : null) });
  });
  await page.route(`**/api/bills/${bill.id}`, (route) => {
    if (route.request().method() === "PATCH") {
      patches.push(route.request().postDataJSON());
      return route.fulfill({ status: 409, json: { error: "Fictional duplicate invoice number." } });
    }
    return route.fulfill({ json: { bill } });
  });
  await page.goto(`/bills/${bill.id}/edit`);
  await expect(supplierInput(page)).toHaveValue(vendorA.name);
  await expect(vendorDetails(page)).toContainText(vendorA.trn!);
  await expect.poll(() => hydrated).toContain(vendorA.id);
  await expect(companyInput(page)).toBeDisabled();
  await page.getByLabel("Notes", { exact: true }).fill("Preserve my reviewed changes");
  await page.getByLabel("Invoice attachment").setInputFiles({ name: "FICTIONAL-additional.pdf", mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n% Fictional autocomplete attachment\n%%EOF") });
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText("Fictional duplicate invoice number.", { exact: true })).toBeVisible();
  expect(patches).toHaveLength(1);
  expect(patches[0]).toMatchObject({ companyId: companyA, vendorId: vendorA.id, version: 7, submit: false });
  await expect(supplierInput(page)).toHaveValue(vendorA.name);
  await expect(page.getByLabel("Notes", { exact: true })).toHaveValue("Preserve my reviewed changes");
  expect(await page.getByLabel("Invoice attachment").evaluate((element: HTMLInputElement) => element.files?.[0]?.name))
    .toBe("FICTIONAL-additional.pdf");
  expect(unexpectedChanges).toEqual([]);
});

test("OCR draft hydrates its exact company supplier without search selection or provider writes", async ({ page }) => {
  const bill = fixtureBill();
  const hydrated: string[] = [];
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method())) mutations.push(new URL(request.url()).pathname);
  });
  await page.route("**/api/vendors/search?*", (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get("companyId") === companyA && params.get("vendorId") === vendorA.id) hydrated.push(vendorA.id);
    return route.fulfill({ json: envelope(companyA, [], params.get("vendorId") === vendorA.id ? vendorA : null) });
  });
  const fields = { companyId: companyA, vendorId: vendorA.id, jobId: jobs[0].id, invoiceNumber: bill.invoiceNumber,
    invoiceDate: bill.invoiceDate, category: "MATERIALS", currency: "USD", discount: "0", vatRate: "5", lines: bill.lines };
  await page.route("**/api/ocr/documents/autocomplete-ocr", (route: Route) => route.fulfill({ json: { document: {
    id: "autocomplete-ocr", companyId: companyA, version: 3, status: "REVIEW_REQUIRED", fileName: "FICTIONAL-OCR.pdf",
    suggestedInput: fields, warnings: [], extraction: { fields, vendorName: vendorA.name, confidence: {}, warnings: [], text: "Fictional OCR fixture" },
  } } }));
  await page.goto("/ocr/documents/autocomplete-ocr");
  await expect(page.getByRole("heading", { name: "Verify extracted bill", exact: true })).toBeVisible();
  await expect(supplierInput(page)).toHaveValue(vendorA.name);
  await expect.poll(() => hydrated).toContain(vendorA.id);
  await expect(companyInput(page)).toBeDisabled();
  await expect(page.getByLabel("Bill#")).toHaveValue(bill.invoiceNumber);
  expect(mutations).toEqual([]);
});
