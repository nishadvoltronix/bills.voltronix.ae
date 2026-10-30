import { expect, test, type Page } from "@playwright/test";
import type { Bill, BillBooksOptions, Job, Vendor, VendorSuggestion } from "../../src/components/types";
import type { BooksSelection } from "../../src/lib/books-selection";

// Only authentication uses the local test account. Every business API request,
// including job/vendor resolution and attachment upload, is intercepted below.
const companies = [
  { id: "manual-complete-alpha", name: "Fictional Complete Alpha", query: "5383", booksId: "990100001", suffix: "Alpha", prefix: "81", sync: "PENDING" },
  { id: "manual-complete-beta", name: "Fictional Complete Beta", query: "5384", booksId: "990100002", suffix: "Beta", prefix: "82", sync: "FAILED" },
] as const;
const crmOrganizationId = "990300001";
const metric = (page: Page, label: string) => page.locator(".metric-card")
  .filter({ has: page.getByText(label, { exact: true }) }).locator(".metric-value");

async function chooseLineOption(page: Page, kind: string, name: string) {
  await page.getByRole("combobox", { name: `Line 1 ${kind}`, exact: true }).fill(name);
  await page.getByRole("option", { name: new RegExp(`^${name}`) }).click();
}

test.beforeEach(async ({ page, baseURL }) => {
  const email = process.env.SEED_ADMIN_EMAIL, password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password || !baseURL) throw new Error("The local fictional test account and origin are required.");
  expect((await page.request.post(`${baseURL}/api/auth/login`, {
    headers: { Origin: baseURL }, data: { email, password },
  })).status()).toBe(200);
});

test.afterEach(async ({ page, baseURL }) => {
  if (baseURL) await page.request.post(`${baseURL}/api/auth/logout`, { headers: { Origin: baseURL } });
});

for (const company of companies) {
  test(`numeric job ${company.query} completes its company-scoped manual bill with honest ${company.sync.toLowerCase()} sync status`, async ({ page }) => {
    const job: Job = { id: `${company.id}-job`, companyId: company.id, jobNumber: `JOB-${company.query}`,
      name: `Fictional Complete ${company.suffix} Installation`, customer: `Fictional Job Customer ${company.suffix}`,
      currency: "AED", contractValue: "1000.00", approvedVariations: "0.00", externalCrmId: `990000000000000${company.query}` };
    const crm = { ...job, id: null, stage: "Fictional confirmed", crmOrganizationId,
      dataCenter: "US", environment: "production", booksOrganizationId: company.booksId,
      sourceId: (company.suffix === "Alpha" ? "a" : "b").repeat(64) };
    const vendor: Vendor = { id: `${company.id}-vendor`, companyId: company.id,
      name: `Fictional Complete Supplier ${company.suffix}`, currency: "AED", email: `${company.suffix.toLowerCase()}@example.invalid` };
    const remoteVendor: VendorSuggestion = { ...vendor, id: null, externalVendorId: "990800001",
      organizationId: company.booksId, dataCenter: "US", environment: "production" };
    const selection: BooksSelection = { organizationId: company.booksId, dataCenter: "US", environment: "production",
      accountId: `${company.prefix}01`, accountName: `Fictional Complete Expense ${company.suffix}`,
      taxId: `${company.prefix}11`, taxName: `Fictional Complete VAT ${company.suffix}`, taxRate: "5.00",
      customerId: `${company.prefix}21`, customerName: `Fictional Books Customer ${company.suffix}` };
    const options: BillBooksOptions = { companyId: company.id, organizationId: company.booksId, dataCenter: "US", environment: "production",
      accounts: [{ id: selection.accountId, name: selection.accountName, type: "expense", selectable: true }],
      taxes: [{ id: selection.taxId, name: selection.taxName, rate: selection.taxRate, selectable: true }],
      customers: [{ id: selection.customerId!, name: selection.customerName!, currency: "AED" }], warning: null, hasMoreCustomers: false };
    const invoiceNumber = `FICTIONAL-COMPLETE-${company.query}`;
    const fileName = `FICTIONAL-original-${company.query}.pdf`;
    const original = Buffer.from(`%PDF-1.4\n% Fictional complete-flow original ${company.query}\n%%EOF`);
    let bill: Bill = { id: `${company.id}-bill`, companyId: company.id, jobId: job.id, vendorId: vendor.id,
      invoiceNumber, invoiceDate: "2026-10-29", createdAt: "2026-10-29T08:00:00Z", category: "MATERIALS", currency: "AED",
      status: "DRAFT", paymentStatus: "UNPAID", version: 1, discount: "0.00", vatRate: "5.00", subtotal: "200.00",
      vatAmount: "10.00", total: "210.00", paidAmount: "0.00", outstanding: "210.00", vendor, job,
      lines: [{ description: `Fictional project material ${company.suffix}`, quantity: "2", unitPrice: "100.00", booksSelection: selection }],
      documents: [], payments: [], syncRecords: [] };
    const existingBill: Bill = { ...bill, id: `${company.id}-existing`, invoiceNumber: `FICTIONAL-EXISTING-${company.query}`,
      status: "READY", subtotal: "100.00", vatAmount: "5.00", total: "105.00", outstanding: "105.00",
      lines: [{ description: "Fictional existing expense", quantity: "1", unitPrice: "100.00" }] };
    let resolved = false, vendorResolved = false, created = false, uploadStarted = false, finalized = false;
    let creates = 0, uploads = 0, submits = 0;
    const writes: string[] = [], unexpected: string[] = [], sequence: string[] = [];
    const companyReads: string[] = [];
    let releaseAttachment!: () => void;
    const attachmentReady = new Promise<void>((resolve) => { releaseAttachment = resolve; });

    await page.route("**/api/**", async (route) => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
      if (method !== "GET") writes.push(path);
      if (method === "GET" && path === "/api/companies") return route.fulfill({ json: { companies } });
      if (method === "GET" && path === "/api/dashboard/search") {
        expect([...url.searchParams.entries()]).toEqual([["q", company.query]]);
        return route.fulfill({ json: { query: company.query, jobs: [], bills: [], hasMore: false } });
      }
      if (method === "GET" && path === "/api/jobs") {
        if (url.searchParams.has("q")) {
          expect(url.searchParams.get("q")).toBe(company.query);
          expect(url.searchParams.has("companyId")).toBe(false);
        }
        // Exact job hydration must supply the selected job even without a list match.
        return route.fulfill({ json: { jobs: [] } });
      }
      if (method === "GET" && path === "/api/jobs/search") {
        expect([...url.searchParams.entries()]).toEqual([["q", company.query]]);
        return route.fulfill({ json: { companyId: null, jobs: [crm], warning: null, hasMore: false } });
      }
      if (method === "POST" && path === "/api/jobs/resolve") {
        expect(request.postDataJSON()).toEqual({ companyId: company.id, externalCrmId: job.externalCrmId,
          sourceId: crm.sourceId, crmOrganizationId, dataCenter: "US", environment: "production", booksOrganizationId: company.booksId });
        resolved = true;
        return route.fulfill({ json: { job, stage: crm.stage } });
      }
      if (method === "GET" && path === `/api/jobs/${job.id}`) {
        expect(resolved).toBe(true);
        return route.fulfill({ json: { job: { ...job, summary: { adjustedValue: "1000.00", recognizedExpenses: finalized ? "300.00" : "100.00",
          paidExpenses: "0.00", outstanding: finalized ? "315.00" : "105.00", estimatedProfit: finalized ? "700.00" : "900.00",
          remainingBudget: finalized ? "700.00" : "900.00", expensePercentage: finalized ? "30.00" : "10.00", budgetStatus: "WITHIN_BUDGET" } },
          bills: finalized ? [existingBill, bill] : [existingBill] } });
      }
      if (method === "GET" && path === "/api/integrations") return route.fulfill({ json: { zoho: { organizations: companies.map((item) => ({
        companyId: item.id, organizationId: item.booksId, name: item.name, dataCenter: "US", environment: "production",
        status: "CONNECTED", connected: true, message: "Fictional connection", writeEnabled: item.sync === "PENDING",
        missing: [], postingMissing: item.sync === "PENDING" ? [] : ["LIVE_OPERATIONAL_ENVIRONMENT"],
      })) }, crm: { status: "CONNECTED", message: "Fictional CRM connection" } } });
      if (method === "GET" && (path === "/api/vendors/search" || path === "/api/bills/options")) {
        companyReads.push(url.searchParams.get("companyId") ?? "");
        expect(url.searchParams.get("companyId")).toBe(company.id);
        if (path === "/api/bills/options") return route.fulfill({ json: options });
        const hydration = url.searchParams.has("vendorId");
        if (hydration) expect(url.searchParams.get("vendorId")).toBe(vendor.id);
        return route.fulfill({ json: { companyId: company.id, organizationId: company.booksId,
          vendors: hydration ? [] : [remoteVendor], selectedVendor: hydration ? vendor : null, warning: null, hasMore: false } });
      }
      if (method === "POST" && path === "/api/vendors/resolve") {
        expect(request.postDataJSON()).toEqual({ companyId: company.id, organizationId: company.booksId,
          externalVendorId: remoteVendor.externalVendorId, dataCenter: "US", environment: "production" });
        vendorResolved = true;
        return route.fulfill({ json: { vendor } });
      }
      if (method === "POST" && path === "/api/bills") {
        expect(resolved && vendorResolved).toBe(true);
        expect(created).toBe(false);
        expect(request.postDataJSON()).toMatchObject({ companyId: company.id, jobId: job.id, vendorId: vendor.id,
          invoiceNumber, invoiceDate: "2026-10-29", currency: "AED", category: "MATERIALS", submit: false,
          lines: [{ description: bill.lines![0].description, quantity: "2", unitPrice: "100.00", booksSelection: selection }] });
        creates++;
        created = true;
        sequence.push("create-draft");
        return route.fulfill({ status: 201, json: { bill } });
      }
      if (method === "POST" && path === `/api/bills/${bill.id}/attachment`) {
        expect(created).toBe(true);
        expect(finalized).toBe(false);
        expect(request.headers()["x-bill-version"]).toBe("1");
        expect(request.headers()["content-type"]).toContain("multipart/form-data;");
        const body = request.postDataBuffer();
        expect(body?.includes(original)).toBe(true);
        expect(body?.toString().includes(`filename="${fileName}"`)).toBe(true);
        uploads++;
        uploadStarted = true;
        sequence.push("attachment-started");
        await attachmentReady;
        bill = { ...bill, version: 2, documents: [{ id: `${company.id}-original`, fileName }] };
        sequence.push("attachment-completed");
        return route.fulfill({ json: { document: { ...bill.documents![0], billVersion: 2, alreadyAttached: false } } });
      }
      if (method === "GET" && path === `/api/bills/${bill.id}`) {
        expect(created).toBe(true);
        return route.fulfill({ json: { bill } });
      }
      if (method === "POST" && path === `/api/bills/${bill.id}/actions`) {
        expect(bill.status).toBe("DRAFT");
        expect(bill.documents).toHaveLength(1);
        expect(bill.version).toBe(2);
        expect(request.postDataJSON()).toEqual({ action: "submit", version: 2 });
        expect(sequence).toEqual(["create-draft", "attachment-started", "attachment-completed"]);
        submits++;
        finalized = true;
        sequence.push("finalize");
        bill = { ...bill, status: "READY", version: 3, syncRecords: [{ id: `${company.id}-sync`, target: "ZOHO",
          organizationId: company.booksId, status: company.sync, externalId: null,
          lastError: company.sync === "FAILED" ? "Fictional live posting is not enabled." : null }] };
        return route.fulfill({ json: { bill } });
      }
      unexpected.push(`${method} ${path}`);
      return route.fulfill({ status: 422, json: { error: "Unexpected fictional fixture request; no data was changed." } });
    });

    try {
      await page.goto("/bills/manual");
      await expect(page.getByRole("combobox", { name: "Company", exact: true })).toHaveCount(0);
      await page.getByRole("textbox", { name: "Job ID, bill number or job name", exact: true }).fill(company.query);
      await page.getByRole("button", { name: "Search", exact: true }).click();
      const crmRow = page.getByRole("table", { name: "Zoho CRM matches", exact: true }).getByRole("row").filter({ hasText: job.jobNumber });
      await expect(crmRow).toContainText(company.name);
      await expect(crmRow).toContainText(crm.stage);
      await expect(crmRow).toContainText("1,000.00");
      await page.getByRole("button", { name: `Use CRM job ${job.jobNumber} for ${company.name}`, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/jobs/${job.id}$`));
      await expect(metric(page, "Recognized expenses")).toContainText("100.00");
      await expect(metric(page, "Outstanding bills")).toContainText("105.00");
      await expect(page.getByRole("row").filter({ hasText: existingBill.invoiceNumber })).toContainText("105.00");
      await page.getByRole("link", { name: "Add bill", exact: true }).click();
      await expect(page.getByRole("combobox", { name: "Company", exact: true })).toHaveValue(company.id);
      await expect(page.getByLabel(/^Job \/ project/)).toHaveValue(job.id);
      await expect(page.getByLabel("Currency", { exact: true })).toHaveValue("AED");
      await page.getByRole("combobox", { name: "Vendor Name", exact: true }).fill(vendor.name);
      await page.getByRole("option", { name: new RegExp(`^${vendor.name}`) }).click();
      await expect(page.getByRole("region", { name: "Vendor details", exact: true })).toContainText(vendor.email!);
      await chooseLineOption(page, "account", selection.accountName);
      await chooseLineOption(page, "tax", selection.taxName);
      await chooseLineOption(page, "customer", selection.customerName!);
      await page.getByLabel("Bill#").fill(invoiceNumber);
      await page.getByLabel("Bill Date").fill("2026-10-29");
      await page.getByLabel("Line 1 description").fill(bill.lines![0].description);
      await page.getByLabel("Line 1 quantity").fill("2");
      await page.getByLabel("Line 1 unit price").fill("100.00");
      await expect(page.getByText("AED 210.00", { exact: true })).toBeVisible();
      await page.getByLabel("Invoice attachment").setInputFiles({ name: fileName, mimeType: "application/pdf", buffer: original });
      await page.getByRole("button", { name: "Save and sync", exact: true }).click();
      await expect.poll(() => uploadStarted).toBe(true);
      expect(creates).toBe(1);
      expect(submits).toBe(0);
      expect(bill).toMatchObject({ status: "DRAFT", version: 1, paidAmount: "0.00", documents: [], payments: [] });
      releaseAttachment();
      await expect(page).toHaveURL(new RegExp(`/bills/${bill.id}\\?saved=1$`));
      await expect(page.getByRole("heading", { name: invoiceNumber, exact: true })).toBeVisible();
      await expect(page.getByText("Ready to sync", { exact: true })).toBeVisible();
      await expect(page.getByText(company.sync === "PENDING"
        ? "Bill saved. Zoho Books synchronization queued. Provider confirmation is pending."
        : "Bill saved, but it has not synchronized with Zoho Books. Fictional live posting is not enabled.", { exact: true })).toBeVisible();
      await expect(page.getByText("Bill saved and synchronized with Zoho Books.", { exact: true })).toHaveCount(0);
      await expect(page.getByText("Paid (including VAT)", { exact: true }).locator("..")).toContainText("0.00");
      const originalLink = page.getByRole("link").filter({ has: page.getByText(fileName, { exact: true }) });
      await expect(originalLink).toBeVisible();
      await expect(originalLink).toHaveAttribute("href", `/api/documents/${company.id}-original`);
      expect(bill).toMatchObject({ companyId: company.id, jobId: job.id, vendorId: vendor.id,
        status: "READY", version: 3, total: "210.00", paidAmount: "0.00", payments: [], lines: [{ booksSelection: selection }] });
      expect([creates, uploads, submits]).toEqual([1, 1, 1]);
      expect(writes).toEqual(["/api/jobs/resolve", "/api/vendors/resolve", "/api/bills", `/api/bills/${bill.id}/attachment`, `/api/bills/${bill.id}/actions`]);
      expect(companyReads.length).toBeGreaterThanOrEqual(2);
      expect(companyReads.every((id) => id === company.id)).toBe(true);
      await page.goto(`/jobs/${job.id}`);
      await expect(metric(page, "Recognized expenses")).toContainText("300.00");
      await expect(metric(page, "Outstanding bills")).toContainText("315.00");
      await expect(page.getByRole("row").filter({ hasText: invoiceNumber })).toContainText("210.00");
      expect(unexpected).toEqual([]);
    } finally {
      releaseAttachment();
    }
  });
}
