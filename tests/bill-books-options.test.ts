import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
import { getConfig } from "@/lib/integrations/config";
import { connectionFingerprint } from "@/lib/integrations/connection-fingerprint";
import { ZohoTransport, type Fetch } from "@/lib/integrations/transport";
import { BOOKS_NO_VAT, BOOKS_NO_VAT_NAME } from "@/lib/books-selection";

const store = vi.hoisted(() => ({ user: { findFirst: vi.fn() }, companyIntegrationDestination: { findMany: vi.fn() }, integrationCredential: { findUnique: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db: store }));
vi.mock("@/lib/integrations/oauth", () => ({ accessToken: vi.fn(async () => "fictional-token"), LEGACY_UNSCOPED_ORGANIZATION: "__legacy_unscoped__" }));
const actor: Actor = { id: "entry-user", role: "DATA_ENTRY", email: "entry@example.invalid", name: "Entry user" };
const destination = { organizationId: "1001", dataCenter: "US", environment: "production" };
let getOptions: typeof import("@/lib/services/bill-books-options").getBillBooksOptions;
let verifySelections: typeof import("@/lib/services/bill-books-options").verifyBillBooksSelections;
let authorized: boolean;
let grantRevoked: boolean;
let grantPresent: boolean;
let grantWrong: boolean;
let grantDate: Date;
let destinations: ({ companyId: string } & typeof destination)[];
const account = (overrides: Record<string, unknown> = {}) => ({ account_id: "301", account_name: "Materials purchase", account_type: "expense", is_active: true, balance: 987654321, ...overrides });
const tax = (overrides: Record<string, unknown> = {}) => ({ tax_id: "401", tax_name: "VAT", tax_type: "tax", tax_percentage: 5, is_active: true, ...overrides });
const customer = (overrides: Record<string, unknown> = {}) => ({ contact_id: "501", contact_name: "Customer A", contact_type: "customer", status: "active", currency_code: "AED", email: "private@example.invalid", ...overrides });
const pageContext = { page: 1, has_more_page: false };
const noVatOption = { id: BOOKS_NO_VAT, name: BOOKS_NO_VAT_NAME, rate: "0.00", selectable: true };
function connection(options: { organizationId?: string; accounts?: unknown[]; taxes?: unknown[]; customers?: unknown[]; detail?: unknown; intercept?: (url: URL) => unknown; onRead?: (url: URL) => void } = {}) {
  const organizationId = options.organizationId ?? "1001";
  const fetcher = vi.fn<Fetch>(async (input, init) => {
    const url = new URL(input);
    expect(init?.method).toBe("GET");
    expect(url.searchParams.get("organization_id")).toBe(organizationId);
    options.onRead?.(url);
    const overridden = await options.intercept?.(url);
    const body = overridden ?? (url.pathname.includes("/organizations/") ? { code: 0, organization: { organization_id: organizationId, is_org_active: true } }
      : url.pathname.endsWith("/chartofaccounts") ? { code: 0, chartofaccounts: options.accounts ?? [account()], page_context: pageContext }
      : url.pathname.endsWith("/taxes") ? { code: 0, taxes: options.taxes ?? [tax()], page_context: pageContext }
      : /\/chartofaccounts\/\d+$/.test(url.pathname) ? { code: 0, chart_of_account: (options.accounts ?? [account()])[0] }
      : /\/taxes\/\d+$/.test(url.pathname) ? { code: 0, tax: (options.taxes ?? [tax()])[0] }
      : url.pathname.endsWith("/contacts") ? { code: 0, contacts: options.customers ?? [customer()], page_context: pageContext }
      : { code: 0, contact: options.detail ?? customer() });
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  });
  return { fetcher, transport: new ZohoTransport(getConfig("ZOHO", process.env, organizationId), async () => "fictional-token", fetcher) };
}

beforeEach(async () => {
  vi.resetAllMocks(); vi.resetModules();
  for (const [key, value] of Object.entries({
    APP_ENV: "development", NODE_ENV: "development", APP_URL: "http://127.0.0.1:3000",
    INTEGRATION_NETWORK_ENABLED: "true", ZOHO_BOOKS_NETWORK_ENABLED: "true", ZOHO_BOOKS_WRITE_ENABLED: "false", ZOHO_BOOKS_LIVE_ENABLED: "false",
    ALLOW_PRODUCTION_ACCOUNTING_WRITES: "false", INTEGRATION_TEST_MODE: "false", ZOHO_BOOKS_DC: "US", ZOHO_BOOKS_ENVIRONMENT: "production",
    ZOHO_BOOKS_CLIENT_ID: "fictional-client", ZOHO_BOOKS_CLIENT_SECRET: "fictional-secret",
    ZOHO_BOOKS_ORGANIZATIONS_JSON: JSON.stringify([{ organizationId: "1001", name: "Fictional A" }, { organizationId: "1002", name: "Fictional B" }]),
  })) vi.stubEnv(key, value);
  authorized = true; grantRevoked = false; grantPresent = true; grantWrong = false; grantDate = new Date("2026-10-01T00:00:00Z");
  destinations = [{ companyId: "company-a", ...destination }, { companyId: "company-b", ...destination, organizationId: "1002" }];
  store.user.findFirst.mockImplementation(async () => authorized ? { id: actor.id } : null);
  store.companyIntegrationDestination.findMany.mockImplementation(async ({ where }: { where: { companyId: string } }) =>
    destinations.filter(row => row.companyId === where.companyId).map(({ organizationId, dataCenter, environment }) => ({ organizationId, dataCenter, environment })));
  store.integrationCredential.findUnique.mockImplementation(async ({ where }: { where: { target_organizationId: { organizationId: string } } }) => {
    const id = where.target_organizationId.organizationId;
    return grantPresent && id !== "__legacy_unscoped__" ? { organizationId: id, revokedAt: grantRevoked ? grantDate : null,
      connectionFingerprint: grantWrong ? "wrong-fingerprint" : connectionFingerprint(getConfig("ZOHO", process.env, id)), updatedAt: grantDate } : null;
  });
  ({ getBillBooksOptions: getOptions, verifyBillBooksSelections: verifySelections } = await import("@/lib/services/bill-books-options"));
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("company Books dropdown options", () => {
  it.each(["development", "production"] as const)("returns exact-company account/tax/customer options without category mappings in %s", async (runtime) => {
    vi.stubEnv("APP_ENV", runtime);
    vi.stubEnv("NODE_ENV", runtime);
    vi.stubEnv("APP_URL", runtime === "production" ? "https://bills.example.invalid" : "http://127.0.0.1:3000");
    const { transport, fetcher } = connection({ accounts: [account(), account({ account_id: "302", account_name: "Equipment", account_type: "fixed_asset" }), account({ account_id: "303", account_type: "other_current_asset" })] });
    const result = await getOptions(actor, { companyId: "company-a" }, transport);
    expect(result).toMatchObject({ companyId: "company-a", ...destination, warning: null, hasMoreCustomers: false });
    expect(result.accounts.every(row => row.selectable)).toBe(true);
    expect(result.taxes).toEqual([noVatOption, { id: "401", name: "VAT", rate: "5", selectable: true }]);
    expect(result.customers).toEqual([{ id: "501", name: "Customer A", currency: "AED" }]);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(result)).not.toContain("987654321"); expect(JSON.stringify(result)).not.toContain("private@example.invalid");
  });

  it("marks inactive/control accounts and compound or unsupported-precision taxes unselectable", async () => {
    const result = await getOptions(actor, { companyId: "company-a" }, connection({
      accounts: [account({ is_active: false }), account({ account_id: "302", account_type: "accounts_payable" })],
      taxes: [tax({ tax_type: "tax_group" }), tax({ tax_id: "402", tax_percentage: "5.125" }), tax({ tax_id: "403", is_active: false })],
    }).transport);
    expect(result.accounts.every(row => !row.selectable)).toBe(true);
    expect(result.taxes[0]).toEqual(noVatOption);
    expect(result.taxes.filter(row => row.id !== BOOKS_NO_VAT).every(row => !row.selectable)).toBe(true);
  });

  it("marks an inactive tax status unselectable when is_active is absent", async () => {
    const result = await getOptions(actor, { companyId: "company-a" }, connection({ taxes: [tax({ is_active: undefined, status: "Inactive" })] }).transport);
    expect(result.taxes).toEqual([noVatOption, { id: "401", name: "VAT", rate: "5", selectable: false }]);
  });

  it("accepts the provider's capitalized Active status without is_active", async () => {
    const result = await getOptions(actor, { companyId: "company-a" }, connection({ taxes: [tax({ is_active: undefined, status: "Active" })] }).transport);
    expect(result.warning).toBeNull();
    expect(result.taxes).toEqual([noVatOption, { id: "401", name: "VAT", rate: "5", selectable: true }]);
  });

  it("offers explicit No VAT separately from every numeric zero-rate tax", async () => {
    const result = await getOptions(actor, { companyId: "company-a" }, connection({
      taxes: [tax({ tax_id: "402", tax_name: "Zero Rate", tax_percentage: 0 })],
    }).transport);
    expect(result.taxes).toEqual([noVatOption, { id: "402", name: "Zero Rate", rate: "0", selectable: true }]);
  });

  it("filters active customers by supported currency and literal normalized search without mixing vendors", async () => {
    const { transport, fetcher } = connection({ customers: [customer({ contact_name: "Customer 5%_" }), customer({ contact_id: "502", contact_type: "vendor" }),
      customer({ contact_id: "503", status: "inactive" }), customer({ contact_id: "504", currency_code: "JPY" }), customer({ contact_id: "505", contact_name: "Other Customer" })] });
    const result = await getOptions(actor, { companyId: "company-a", customerQuery: "5%_" }, transport);
    expect(result.customers.map(row => row.name)).toEqual(["Customer 5%_"]);
    const query = new URL(fetcher.mock.calls.at(-1)![0]).searchParams;
    expect(query.get("contact_type")).toBe("customer"); expect(query.get("contact_name_contains")).toBe("5%_"); expect(query.has("filter_by")).toBe(false);
  });

  it("hydrates only the exact active customer ID", async () => {
    const { transport, fetcher } = connection();
    const result = await getOptions(actor, { companyId: "company-a", customerId: "501" }, transport);
    expect(result.customers).toEqual([{ id: "501", name: "Customer A", currency: "AED" }]);
    expect(new URL(fetcher.mock.calls.at(-1)![0]).pathname).toBe("/books/v3/contacts/501");
    const bad = await getOptions(actor, { companyId: "company-a", customerId: "502" }, connection().transport);
    expect(bad.customers).toEqual([]); expect(bad.warning).toBeTruthy();
  });

  it("isolates the company cache and rejects an injected connection for another organization", async () => {
    await getOptions(actor, { companyId: "company-a" }, connection().transport);
    const b = connection({ organizationId: "1002", accounts: [account({ account_name: "Company B account" })] });
    const result = await getOptions(actor, { companyId: "company-b" }, b.transport);
    expect(result.organizationId).toBe("1002"); expect(result.accounts[0].name).toBe("Company B account"); expect(b.fetcher).toHaveBeenCalledTimes(4);
    const wrong = connection();
    await expect(getOptions(actor, { companyId: "company-b" }, wrong.transport)).rejects.toThrow(); expect(wrong.fetcher).not.toHaveBeenCalled();
  });

  it("caches catalogs briefly while customers and current access remain fresh", async () => {
    vi.useFakeTimers();
    const { transport, fetcher } = connection();
    const first = await getOptions(actor, { companyId: "company-a" }, transport);
    first.accounts[0].name = "Client mutation";
    const second = await getOptions(actor, { companyId: "company-a" }, transport);
    expect(second.accounts[0].name).toBe("Materials purchase"); expect(fetcher).toHaveBeenCalledTimes(5);
    vi.advanceTimersByTime(60_001);
    await getOptions(actor, { companyId: "company-a" }, transport); expect(fetcher).toHaveBeenCalledTimes(9);
    authorized = false;
    await expect(getOptions(actor, { companyId: "company-a" }, transport)).rejects.toMatchObject({ status: 403 }); expect(fetcher).toHaveBeenCalledTimes(9);
  });

  it("does not reuse catalogs after grant rotation or revocation", async () => {
    const { transport, fetcher } = connection();
    await getOptions(actor, { companyId: "company-a" }, transport);
    grantDate = new Date(grantDate.getTime() + 1_000);
    await getOptions(actor, { companyId: "company-a" }, transport); expect(fetcher).toHaveBeenCalledTimes(8);
    grantRevoked = true;
    const result = await getOptions(actor, { companyId: "company-a" }, transport);
    expect(result.accounts).toEqual([]); expect(result.warning).toContain("authorization"); expect(fetcher).toHaveBeenCalledTimes(8);
  });

  it("accepts ordinary token refresh but does not cache old reads under the new grant revision", async () => {
    const { transport, fetcher } = connection({ onRead: url => {
      if (url.pathname.includes("/organizations/")) grantDate = new Date(grantDate.getTime() + 1_000);
    } });
    expect((await getOptions(actor, { companyId: "company-a" }, transport)).warning).toBeNull();
    expect((await getOptions(actor, { companyId: "company-a" }, transport)).warning).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(8);
  });

  it.each(["no-destination", "multiple", "missing-profile", "disabled", "missing-grant", "wrong-grant"])("returns controlled empty options for %s without provider calls", async mode => {
    const { transport, fetcher } = connection();
    if (mode === "no-destination") destinations = [];
    if (mode === "multiple") destinations.push({ companyId: "company-a", ...destination, organizationId: "1002" });
    if (mode === "missing-profile") destinations[0].organizationId = "7777";
    if (mode === "disabled") vi.stubEnv("ZOHO_BOOKS_NETWORK_ENABLED", "false");
    if (mode === "missing-grant") grantPresent = false;
    if (mode === "wrong-grant") grantWrong = true;
    const result = await getOptions(actor, { companyId: "company-a" }, transport);
    expect(result.accounts).toEqual([]); expect(result.customers).toEqual([]); expect(result.warning).toBeTruthy(); expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["actor", "destination", "config", "grant"])("rejects %s changed during provider reads", async mode => {
    const { transport } = connection({ onRead: url => {
      if (!url.pathname.endsWith("/contacts")) return;
      if (mode === "actor") authorized = false;
      if (mode === "destination") destinations[0].organizationId = "1002";
      if (mode === "config") vi.stubEnv("ZOHO_BOOKS_CLIENT_SECRET", "changed-fixture-secret");
      if (mode === "grant") grantRevoked = true;
    } });
    await expect(getOptions(actor, { companyId: "company-a" }, transport)).rejects.toThrow();
  });

  it("rejects invalid inputs before queries and current non-writer actors before provider reads", async () => {
    await expect(getOptions(actor, { companyId: "company-a", customerQuery: "x".repeat(101) })).rejects.toThrow();
    await expect(getOptions(actor, { companyId: "company-a", organizationId: "1002" })).rejects.toThrow();
    await expect(getOptions(actor, { companyId: "company-a", customerId: "bad/id" })).rejects.toThrow();
    expect(store.user.findFirst).not.toHaveBeenCalled();
    await expect(getOptions({ ...actor, role: "MANAGEMENT" }, { companyId: "company-a" })).rejects.toMatchObject({ status: 403 });
  });

  it("rejects malformed/duplicate catalogs without leaking provider records", async () => {
    const result = await getOptions(actor, { companyId: "company-a" }, connection({ accounts: [account(), account()], intercept: url =>
      url.pathname.endsWith("/contacts") ? { code: 0, contacts: "PRIVATE PROVIDER DATA" } : undefined }).transport);
    expect(result.accounts).toEqual([]); expect(result.customers).toEqual([]); expect(result.warning).toBeTruthy();
    expect(JSON.stringify(result)).not.toContain("PRIVATE PROVIDER DATA");
  });

  it("reads every catalog page and rejects repeated IDs across pages", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => account({ account_id: String(3000 + index) }));
    const createConnection = (duplicate: boolean) => connection({ intercept: url => {
      if (!url.pathname.endsWith("/chartofaccounts")) return undefined;
      const page = Number(url.searchParams.get("page"));
      return { code: 0, chartofaccounts: page === 1 ? firstPage : [account({ account_id: duplicate ? "3000" : "3100" })], page_context: { page, has_more_page: page === 1 } };
    } });
    const valid = await getOptions(actor, { companyId: "company-a" }, createConnection(false).transport);
    expect(valid.accounts).toHaveLength(101);
    // Save verification must read fresh pages even when options were cached.
    await expect(verifySelections(actor, "company-a", Array.from({ length: 13 }, (_, index) => ({ ...selection, accountId: String(3000 + index) })), createConnection(true).transport))
      .rejects.toThrow("duplicate accounting options");
  });

  it("stops an oversized catalog without returning partial account options", async () => {
    const { transport, fetcher } = connection({ intercept: url => {
      if (!url.pathname.endsWith("/chartofaccounts")) return undefined;
      const page = Number(url.searchParams.get("page"));
      return { code: 0, chartofaccounts: Array.from({ length: 100 }, (_, index) => account({ account_id: String(page * 100 + index) })), page_context: { page, has_more_page: true } };
    } });
    const result = await getOptions(actor, { companyId: "company-a" }, transport);
    expect(result.accounts).toEqual([]); expect(result.warning).toBeTruthy();
    expect(fetcher.mock.calls.filter(([url]) => new URL(url).pathname.endsWith("/chartofaccounts"))).toHaveLength(10);
  });

  it("bounds customer results and reports more pages", async () => {
    const result = await getOptions(actor, { companyId: "company-a" }, connection({ customers: Array.from({ length: 26 }, (_, index) => customer({ contact_id: String(500 + index) })) }).transport);
    expect(result.customers).toHaveLength(25); expect(result.hasMoreCustomers).toBe(true);
  });
});

const selection = { ...destination, accountId: "301", accountName: "Client account label", taxId: "401", taxName: "Client tax label", taxRate: "5", customerId: "501", customerName: "Client customer label" };
describe("fresh bill Books selection verification", () => {
  it("reads only the exact unique selected records and leaves the submitted accounting intent unchanged", async () => {
    const input = [Object.freeze({ ...selection }), Object.freeze({ ...selection })];
    const before = JSON.stringify(input), { transport, fetcher } = connection();
    const result = await verifySelections(actor, "company-a", input, transport);
    expect(fetcher.mock.calls.map(([url]) => new URL(url).pathname).sort()).toEqual([
      "/books/v3/chartofaccounts/301", "/books/v3/contacts/501", "/books/v3/organizations/1001", "/books/v3/settings/taxes/401",
    ]);
    expect(JSON.stringify(input)).toBe(before);
    expect(result.map(row => ({ accountId: row?.accountId, taxId: row?.taxId, taxRate: row?.taxRate, customerId: row?.customerId })))
      .toEqual(input.map(row => ({ accountId: row.accountId, taxId: row.taxId, taxRate: "5.00", customerId: row.customerId })));
  });

  it("overlaps fresh reads while bounding organization, account, tax and customer requests together at four", async () => {
    let release!: () => void, active = 0, maximum = 0, reads = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { transport, fetcher } = connection({ intercept: async url => {
      reads++; active++; maximum = Math.max(maximum, active);
      await gate; active--;
      const id = url.pathname.split("/").at(-1)!;
      if (url.pathname.includes("/chartofaccounts/")) return { code: 0, ...account({ account_id: id }) };
      if (url.pathname.includes("/taxes/")) return { code: 0, tax: [tax({ tax_id: id })] };
      if (url.pathname.includes("/contacts/")) return { code: 0, contact: customer({ contact_id: id }) };
    } });
    const input = Array.from({ length: 5 }, (_, index) => ({ ...selection, accountId: String(301 + index % 3),
      taxId: String(401 + index % 2), customerId: String(501 + index) }));
    const pending = verifySelections(actor, "company-a", input, transport);
    await vi.waitFor(() => expect(reads).toBe(4));
    expect(active).toBe(4);
    // All four independent operations started before any response was released.
    expect(fetcher.mock.calls.some(([url]) => new URL(url).pathname.includes("/chartofaccounts/"))).toBe(true);
    release();
    expect(await pending).toHaveLength(5);
    expect(reads).toBe(11); expect(active).toBe(0); expect(maximum).toBe(4);
  });

  it.each(["flat", "nested"])("accepts an authoritative exact account detail in the %s envelope", async mode => {
    const { transport } = connection({ intercept: url => url.pathname.endsWith("/chartofaccounts/301")
      ? mode === "flat" ? { code: 0, ...account() } : { code: 0, chart_of_account: account() } : undefined });
    expect((await verifySelections(actor, "company-a", [selection], transport))[0]?.accountName).toBe("Materials purchase");
  });

  it.each([null, [], "PRIVATE PROVIDER DATA", { account_id: "999" }])("rejects a present malformed nested account without borrowing valid flat fields: %o", async nested => {
    const { transport } = connection({ intercept: url => url.pathname.endsWith("/chartofaccounts/301")
      ? { code: 0, ...account(), chart_of_account: nested } : undefined });
    await expect(verifySelections(actor, "company-a", [selection], transport)).rejects.toMatchObject({ status: 422, message: expect.stringContaining("account is unavailable") });
  });

  it.each(["301", "999"])("rejects dual account carriers that could hide conflicting activity or identity: %s", async flatId => {
    const { transport } = connection({ intercept: url => url.pathname.endsWith("/chartofaccounts/301")
      ? { code: 0, ...account({ account_id: flatId, is_active: false }), chart_of_account: account() } : undefined });
    await expect(verifySelections(actor, "company-a", [selection], transport)).rejects.toMatchObject({ status: 422, message: expect.stringContaining("account is unavailable") });
  });

  it.each(["object", "singular-array", "plural-array"])("accepts exactly one selected tax in the %s envelope", async mode => {
    const { transport } = connection({ intercept: url => url.pathname.endsWith("/taxes/401")
      ? mode === "object" ? { code: 0, tax: tax() } : mode === "singular-array" ? { code: 0, tax: [tax()] } : { code: 0, taxes: [tax()] } : undefined });
    expect((await verifySelections(actor, "company-a", [selection], transport))[0]?.taxRate).toBe("5.00");
  });

  it.each([
    { tax: [] }, { tax: [tax(), tax()] }, { tax: [tax(), tax({ tax_id: "402" })] },
    { tax: tax({ tax_id: "402" }) }, { tax: null }, { tax: tax(), taxes: [tax()] }, { taxes: tax() },
  ])("rejects ambiguous, missing or unrelated selected-tax evidence: %o", async envelope => {
    const { transport } = connection({ intercept: url => url.pathname.endsWith("/taxes/401") ? { code: 0, ...envelope } : undefined });
    await expect(verifySelections(actor, "company-a", [selection], transport)).rejects.toMatchObject({ status: 422, message: expect.stringContaining("tax is unavailable") });
  });

  it.each(["account", "tax"])("reports an exact missing %s detail as an unavailable selection", async kind => {
    const { transport } = connection();
    const original = transport.request.bind(transport);
    vi.spyOn(transport, "request").mockImplementation(async (path, options) => {
      if (path === (kind === "account" ? "/books/v3/chartofaccounts/301" : "/books/v3/settings/taxes/401"))
        throw new (await import("@/lib/integrations/config")).IntegrationError("REMOTE_NOT_FOUND", "The referenced external record was not found.", "FAILED");
      return original(path, options);
    });
    await expect(verifySelections(actor, "company-a", [selection], transport)).rejects.toMatchObject({ status: 422 });
  });

  it("settles outstanding reads before reporting a deterministic organization failure", async () => {
    let release!: () => void, completed = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { transport, fetcher } = connection({ intercept: async url => {
      if (url.pathname.includes("/organizations/")) { await gate; return { code: 0, organization: { organization_id: "999", is_org_active: true } }; }
      if (url.pathname.endsWith("/chartofaccounts/301")) return { code: 0, chart_of_account: null };
    } });
    const pending = verifySelections(actor, "company-a", [selection], transport);
    const result = pending.then(() => { completed = true; }, error => { completed = true; throw error; });
    const assertion = expect(result).rejects.toThrow("active organization");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4));
    expect(completed).toBe(false); release(); await assertion;
  });

  it("rechecks revocation after all reads even when an accounting detail is invalid", async () => {
    const { transport } = connection({ intercept: url => {
      if (url.pathname.endsWith("/chartofaccounts/301")) return { code: 0, chart_of_account: null };
    }, onRead: url => { if (url.pathname.endsWith("/401")) grantRevoked = true; } });
    await expect(verifySelections(actor, "company-a", [selection], transport)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("connection changed") });
  });

  it.each([12, 13])("uses exact details up to twelve distinct account/tax IDs, then bounded full catalogs: %i", async count => {
    const accounts = Array.from({ length: count - 1 }, (_, index) => account({ account_id: String(301 + index) }));
    const input = accounts.map(row => ({ ...selection, accountId: String(row.account_id), customerId: null, customerName: null }));
    const { transport, fetcher } = connection({ accounts, intercept: url => url.pathname.includes("/chartofaccounts/")
      ? { code: 0, ...account({ account_id: url.pathname.split("/").at(-1) }) } : undefined });
    expect(await verifySelections(actor, "company-a", input, transport)).toHaveLength(count - 1);
    const paths = fetcher.mock.calls.map(([url]) => new URL(url).pathname);
    if (count === 12) {
      expect(paths).toHaveLength(13); expect(paths).not.toContain("/books/v3/chartofaccounts"); expect(paths).not.toContain("/books/v3/settings/taxes");
    } else {
      expect(paths.sort()).toEqual(["/books/v3/chartofaccounts", "/books/v3/organizations/1001", "/books/v3/settings/taxes"]);
    }
  });

  it("does not read any tax endpoint for an entirely No VAT bill even in the diverse-account fallback", async () => {
    const accounts = Array.from({ length: 13 }, (_, index) => account({ account_id: String(301 + index) }));
    const input = accounts.map(row => ({ ...selection, accountId: row.account_id, taxId: BOOKS_NO_VAT,
      taxName: BOOKS_NO_VAT_NAME, taxRate: "0.00", customerId: null, customerName: null }));
    const { transport, fetcher } = connection({ accounts });
    expect(await verifySelections(actor, "company-a", input, transport)).toHaveLength(13);
    expect(fetcher.mock.calls.map(([url]) => new URL(url).pathname).sort())
      .toEqual(["/books/v3/chartofaccounts", "/books/v3/organizations/1001"]);
  });

  it("verifies No VAT account/customer identities without borrowing a zero-rate tax", async () => {
    const { transport, fetcher } = connection({ taxes: [tax({ tax_id: "402", tax_name: "Zero Rate", tax_percentage: 0 })] });
    const noVat = { ...selection, taxId: BOOKS_NO_VAT, taxName: BOOKS_NO_VAT_NAME, taxRate: "0.00" };
    expect(await verifySelections(actor, "company-a", [noVat], transport)).toEqual([
      { ...noVat, accountName: "Materials purchase", customerName: "Customer A" },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.every(([url, init]) => init?.method === "GET" && !new URL(url).pathname.includes(BOOKS_NO_VAT))).toBe(true);
    await expect(verifySelections(actor, "company-a", [noVat], connection({ accounts: [account({ is_active: false })] }).transport))
      .rejects.toMatchObject({ status: 422 });
  });

  it("does not bypass destination, authorization or customer checks for No VAT", async () => {
    const noVat = { ...selection, taxId: BOOKS_NO_VAT, taxName: BOOKS_NO_VAT_NAME, taxRate: "0.00" };
    const wrong = connection();
    await expect(verifySelections(actor, "company-b", [noVat], wrong.transport)).rejects.toMatchObject({ status: 409 });
    expect(wrong.fetcher).not.toHaveBeenCalled();
    await expect(verifySelections(actor, "company-a", [noVat], connection({ detail: customer({ status: "inactive" }) }).transport))
      .rejects.toThrow("could not be verified");
    const revoked = connection({ onRead: url => { if (url.pathname.endsWith("/501")) grantRevoked = true; } });
    await expect(verifySelections(actor, "company-a", [noVat], revoked.transport)).rejects.toMatchObject({ status: 409 });
  });

  it("rejects a nonzero or relabelled No VAT marker before provider reads", async () => {
    const { transport, fetcher } = connection();
    for (const override of [{ taxRate: "5.00" }, { taxName: "Zero Rate" }])
      await expect(verifySelections(actor, "company-a", [{ ...selection, taxId: BOOKS_NO_VAT,
        taxName: BOOKS_NO_VAT_NAME, taxRate: "0.00", ...override }], transport)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("normalizes provider labels/rates and deduplicates exact customer reads", async () => {
    const { transport, fetcher } = connection({ accounts: [account({ account_type: "fixed_asset" })] });
    const result = await verifySelections(actor, "company-a", [selection, { ...selection, customerId: null, customerName: null }, selection], transport);
    expect(result[0]).toEqual({ ...selection, accountName: "Materials purchase", taxName: "VAT", taxRate: "5.00", customerName: "Customer A" });
    expect(result[1]?.customerId).toBeNull(); expect(result[1]?.customerName).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("bypasses the dropdown catalog cache and detects a newly inactive selected account", async () => {
    await getOptions(actor, { companyId: "company-a" }, connection().transport);
    const changed = connection({ accounts: [account({ is_active: false })] });
    await expect(verifySelections(actor, "company-a", [selection], changed.transport)).rejects.toMatchObject({ status: 422 });
    expect(changed.fetcher).toHaveBeenCalledTimes(4);
  });

  it("rejects a changed or forged tax rate instead of silently changing reviewed totals", async () => {
    const { transport, fetcher } = connection({ taxes: [tax({ tax_percentage: 10 })] });
    await expect(verifySelections(actor, "company-a", [selection], transport)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("tax rate changed") });
    expect(fetcher).toHaveBeenCalledTimes(4);
    await expect(verifySelections(actor, "company-a", [{ ...selection, taxRate: "99.00" }], connection().transport)).rejects.toMatchObject({ status: 409 });
  });

  it("rejects inactive provider tax status on save when is_active is absent", async () => {
    await expect(verifySelections(actor, "company-a", [selection], connection({ taxes: [tax({ is_active: undefined, status: "Inactive" })] }).transport))
      .rejects.toMatchObject({ status: 422, message: expect.stringContaining("tax is unavailable") });
  });

  it.each(["organization", "company", "data-center", "environment", "mixed-destination"])("rejects %s mismatch before provider calls", async mode => {
    const payload = { ...selection };
    if (mode === "organization") payload.organizationId = "1002";
    if (mode === "data-center") payload.dataCenter = "AE";
    if (mode === "environment") payload.environment = "sandbox";
    const selected = mode === "mixed-destination" ? [payload, { ...payload, organizationId: "1002" }] : [payload];
    const { transport, fetcher } = connection();
    await expect(verifySelections(actor, mode === "company" ? "company-b" : "company-a", selected, transport)).rejects.toMatchObject({ status: 409 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["missing-account", "inactive-account", "unsupported-account", "missing-tax", "inactive-tax", "compound-tax", "precision-tax", "factor-tax", "conflicting-tax-activity"])("rejects %s", async mode => {
    const accounts = [account()]; const taxes = [tax()];
    if (mode === "missing-account") accounts[0].account_id = "999";
    if (mode === "inactive-account") accounts[0].is_active = false;
    if (mode === "unsupported-account") accounts[0].account_type = "accounts_receivable";
    if (mode === "missing-tax") taxes[0].tax_id = "999";
    if (mode === "inactive-tax") taxes[0].is_active = false;
    if (mode === "compound-tax") taxes[0].tax_type = "tax_group";
    if (mode === "precision-tax") taxes[0].tax_percentage = 5.125;
    if (mode === "factor-tax") Object.assign(taxes[0], { tax_factor: "share" });
    if (mode === "conflicting-tax-activity") Object.assign(taxes[0], { is_active: true, status: "inactive" });
    await expect(verifySelections(actor, "company-a", [selection], connection({ accounts, taxes }).transport)).rejects.toMatchObject({ status: 422 });
  });

  it.each(["inactive", "vendor", "wrong-id", "currency", "malformed"])("rejects %s customer detail", async mode => {
    const row = customer();
    if (mode === "inactive") row.status = "inactive";
    if (mode === "vendor") row.contact_type = "vendor";
    if (mode === "wrong-id") row.contact_id = "999";
    if (mode === "currency") row.currency_code = "JPY";
    await expect(verifySelections(actor, "company-a", [selection], connection({ detail: mode === "malformed" ? "PRIVATE PROVIDER BODY" : row }).transport)).rejects.toThrow("could not be verified");
  });

  it("checks input and bounds before issuing provider requests", async () => {
    await expect(verifySelections(actor, "company-a", [{ ...selection, injected: true }])).rejects.toThrow();
    await expect(verifySelections(actor, "company-a", Array.from({ length: 101 }, () => selection))).rejects.toThrow();
    expect(store.user.findFirst).not.toHaveBeenCalled();
    const { transport, fetcher } = connection();
    await expect(verifySelections(actor, "company-a", Array.from({ length: 26 }, (_, index) => ({ ...selection, customerId: String(600 + index) })), transport)).rejects.toMatchObject({ status: 422 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("requires current authorization and rechecks revocation after verification", async () => {
    const { transport, fetcher } = connection();
    authorized = false;
    await expect(verifySelections(actor, "company-a", [selection], transport)).rejects.toMatchObject({ status: 403 });
    expect(fetcher).not.toHaveBeenCalled();
    authorized = true;
    await expect(verifySelections(actor, "company-a", [selection], connection({ onRead: url => {
      if (url.pathname.endsWith("/501")) grantRevoked = true;
    } }).transport)).rejects.toMatchObject({ status: 409 });
  });

  it("retains absent legacy selections without requiring a provider configuration", async () => {
    destinations = [];
    const { transport, fetcher } = connection();
    expect(await verifySelections(actor, "company-a", [null, undefined], transport)).toEqual([null, null]);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
