import { expect, test, type Page } from "@playwright/test";
import type { Bill } from "../../src/components/types";

// Only authentication uses the existing LOCAL seed. Bill data and every
// business endpoint are fictional fixtures; no provider or financial writes.
const company = { id: "latest-order-company", name: "Fictional latest-order company" };
const vendor = { id: "latest-order-vendor", companyId: company.id, name: "Fictional supplier", currency: "AED" };
const job = { id: "latest-order-job", companyId: company.id, jobNumber: "JOB-FICTIONAL", name: "Fictional project",
  customer: "Fictional customer", currency: "AED", contractValue: null, approvedVariations: null };
function bill(id: string, invoiceNumber: string, invoiceDate: string, updatedAt: string, total: string): Bill & { updatedAt: string } {
  return { id, companyId: company.id, vendorId: vendor.id, jobId: job.id, invoiceNumber, invoiceDate, updatedAt,
    createdAt: updatedAt, status: "READY", paymentStatus: "UNPAID", currency: "AED", category: "MATERIALS",
    subtotal: total, total, paidAmount: "0.00", discount: "0.00", vatRate: "0.00", vatAmount: "0.00", version: 1,
    vendor, job, createdBy: { id: "fictional-author", name: "Fictional author" }, lines: [], documents: [], payments: [], syncRecords: [] };
}
const recentlyUpdated = bill("latest-order-updated", "FICTIONAL-RECENT-UPDATE", "2020-01-01", "2026-11-05T12:35:00Z", "100.00");
const newestInvoice = bill("latest-order-newest-invoice", "FICTIONAL-NEW-INVOICE-DATE", "2026-11-05", "2026-11-04T10:00:00Z", "300.00");
const olderEntry = bill("latest-order-older-entry", "FICTIONAL-OLDER-ENTRY", "2025-01-01", "2026-10-01T10:00:00Z", "200.00");
type Read = { page: number; sort: string | null; q: string | null; status: string | null };

async function fixture(page: Page) {
  const reads: Read[] = [], writes: string[] = [], unexpected: string[] = [];
  await page.route("**/api/**", route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname.startsWith("/api/auth/")) return route.continue();
    if (request.method() !== "GET") {
      writes.push(request.method() + " " + url.pathname);
      return route.fulfill({ status: 422, json: { error: "No business writes in the list-order fixture." } });
    }
    if (url.pathname === "/api/companies") return route.fulfill({ json: { companies: [company] } });
    if (url.pathname === "/api/jobs") return route.fulfill({ json: { jobs: [job] } });
    if (url.pathname === "/api/vendors") return route.fulfill({ json: { vendors: [vendor] } });
    if (url.pathname === "/api/bills") {
      const current = { page: Number(url.searchParams.get("page")), sort: url.searchParams.get("sort"),
        q: url.searchParams.get("q"), status: url.searchParams.get("status") };
      reads.push(current);
      const rows = current.status === "PENDING_APPROVAL" ? [] : current.sort === "updated_desc"
        ? [recentlyUpdated, newestInvoice, olderEntry] : current.sort === "date_asc" || current.sort === "total_asc"
          ? [recentlyUpdated, olderEntry, newestInvoice] : [newestInvoice, olderEntry, recentlyUpdated];
      return route.fulfill({ json: { bills: rows.slice((current.page - 1) * 2, current.page * 2),
        total: rows.length, page: current.page, pageSize: 2 } });
    }
    unexpected.push(url.pathname);
    return route.fulfill({ status: 404, json: { error: "Unexpected fictional list lookup." } });
  });
  return { reads, writes, unexpected };
}
test.beforeEach(async ({ page, baseURL }) => {
  const email = process.env.SEED_ADMIN_EMAIL, password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password || !baseURL) throw new Error("Existing LOCAL Admin fixture credentials are required.");
  expect((await page.request.post(baseURL + "/api/auth/login", { headers: { Origin: baseURL }, data: { email, password } })).status()).toBe(200);
});
test.afterEach(async ({ page, baseURL }) => {
  if (baseURL) await page.request.post(baseURL + "/api/auth/logout", { headers: { Origin: baseURL } });
});

test("Admin bills start with latest updates, keep that order on Next, and reset paging when the sort changes", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/bills");
  await expect(page.getByRole("heading", { name: "Bills & expenses", exact: true })).toBeVisible();
  const sort = page.getByRole("combobox", { name: "Sort bills", exact: true });
  await expect(sort).toHaveValue("updated_desc");
  await expect(sort.locator("option")).toHaveText([
    "Latest updated", "Invoice date: newest", "Invoice date: oldest", "Highest amount", "Lowest amount",
  ]);
  await expect(page.locator("tbody .table-primary")).toHaveText([recentlyUpdated.invoiceNumber, newestInvoice.invoiceNumber]);
  await expect.poll(() => state.reads.at(-1)).toMatchObject({ page: 1, sort: "updated_desc" });
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByText("Page 2", { exact: true })).toBeVisible();
  await expect(page.locator("tbody .table-primary")).toHaveText([olderEntry.invoiceNumber]);
  await expect.poll(() => state.reads.at(-1)).toMatchObject({ page: 2, sort: "updated_desc" });
  await sort.selectOption("date_desc");
  await expect(page.getByText("Page 1", { exact: true })).toBeVisible();
  await expect(page.locator("tbody .table-primary")).toHaveText([newestInvoice.invoiceNumber, olderEntry.invoiceNumber]);
  await expect.poll(() => state.reads.at(-1)).toMatchObject({ page: 1, sort: "date_desc" });
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByText("Page 2", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Search bills", exact: true }).fill("FICTIONAL");
  await expect(page.getByText("Page 1", { exact: true })).toBeVisible();
  await expect.poll(() => state.reads.at(-1)).toMatchObject({ page: 1, sort: "date_desc", q: "FICTIONAL" });
  await expect(page.locator("tbody .table-primary")).toHaveText([newestInvoice.invoiceNumber, olderEntry.invoiceNumber]);
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export current page", exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe("voltronix-bills-page-1.csv");
  const stream = await download.createReadStream();
  if (!stream) throw new Error("Fictional export stream unavailable.");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const csv = Buffer.concat(chunks).toString("utf8");
  expect(csv).toContain(newestInvoice.invoiceNumber);
  expect(csv).toContain(olderEntry.invoiceNumber);
  expect(csv).not.toContain(recentlyUpdated.invoiceNumber);
  expect(state.writes).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("Admin approvals retain the invoice-date default and pending filter", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/approvals");
  await expect(page.getByRole("heading", { name: "Bills awaiting final save", exact: true })).toBeVisible();
  const sort = page.getByRole("combobox", { name: "Sort bills", exact: true });
  await expect(sort).toHaveValue("date_desc");
  await expect.poll(() => state.reads.at(-1)).toMatchObject({ page: 1, sort: "date_desc", status: "PENDING_APPROVAL" });
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
  await sort.selectOption("updated_desc");
  await expect.poll(() => state.reads.at(-1)).toMatchObject({ page: 1, sort: "updated_desc", status: "PENDING_APPROVAL" });
  expect(state.writes).toEqual([]); expect(state.unexpected).toEqual([]);
});
