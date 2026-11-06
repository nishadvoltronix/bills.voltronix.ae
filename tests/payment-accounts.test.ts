import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
import type { ZohoConfig } from "@/lib/integrations/config";
import type { ZohoTransport } from "@/lib/integrations/transport";
import { handle, json } from "@/lib/http";

const store = vi.hoisted(() => ({ user: { findFirst: vi.fn() }, userCompanyMembership: { findMany: vi.fn() }, companyIntegrationDestination: { findMany: vi.fn() } }));
const configuration = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ db: store }));
vi.mock("@/lib/integrations/config", async original => ({ ...await original<typeof import("@/lib/integrations/config")>(), getConfig: configuration }));
vi.mock("@/lib/integrations/oauth", () => ({ accessToken: vi.fn(async () => "fictional"), LEGACY_UNSCOPED_ORGANIZATION: "LEGACY" }));
import { assertPaymentAccount, getPaymentAccounts } from "@/lib/services/payment-books-sync";

const actor = { id: "actor", role: "ACCOUNTS" } as Actor;
const config: ZohoConfig = { target: "ZOHO", dataCenter: "US", organizationId: "100", environment: "production", accountsOrigin: "https://accounts.zoho.com", apiOrigin: "https://www.zohoapis.com",
  clientId: "fictional", clientSecret: "fictional", networkEnabled: true, writeEnabled: false, liveRuntime: true,
  booksMapping: { verified: true, baseCurrency: "AED", currencies: { AED: { id: "101" } }, categories: {}, taxes: {} } };
const account = { account_id: "400", account_name: "Fictional cash account", account_type: "cash", is_active: true, currency_code: "AED" };
const fetcher = vi.fn();
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal("fetch", fetcher);
  configuration.mockReturnValue(config);
  store.user.findFirst.mockResolvedValue({ id: actor.id }); store.userCompanyMembership.findMany.mockResolvedValue([{ companyId: "company" }]);
  store.companyIntegrationDestination.findMany.mockResolvedValue([{ companyId: "company", target: "ZOHO", organizationId: "100", dataCenter: "US", environment: "production" }]);
  fetcher.mockImplementation(async (input: string | URL, options?: RequestInit) => {
    expect(options?.method).toBe("GET");
    const url = new URL(input); expect(url.searchParams.get("organization_id")).toBe("100");
    if (url.pathname === "/books/v3/organizations/100") return Response.json({ code: 0, organization: { organization_id: "100", is_org_active: true, currency_code: "AED", currency_id: "101" } });
    if (url.pathname === "/books/v3/chartofaccounts") return Response.json({ code: 0, chartofaccounts: [account,
      { ...account, account_id: "401", account_type: "expense" }, { ...account, account_id: "402", is_active: false }], page_context: { page: 1, has_more_page: false } });
    if (url.pathname === "/books/v3/chartofaccounts/400") return Response.json({ code: 0, chart_of_account: account });
    throw new Error("Unexpected fictional account request.");
  });
});
afterEach(() => vi.unstubAllGlobals());
const detail = (raw: unknown) => ({ request: vi.fn(async () => raw) }) as unknown as ZohoTransport;

describe("company-scoped payment bank/cash accounts", () => {
  it("returns only active verified bank/cash accounts without private bank fields or financial writes", async () => {
    expect(await getPaymentAccounts(actor, "company")).toEqual({ companyId: "company", accounts: [{ id: "400", name: account.account_name, type: "cash", currency: "AED" }], warning: null });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.every(([, options]) => options.method === "GET")).toBe(true);
  });
  it("supports documented flat and existing nested account detail envelopes", async () => {
    expect(await assertPaymentAccount(config, "400", "AED", detail({ code: 0, ...account }))).toMatchObject({ id: "400", type: "cash" });
    expect(await assertPaymentAccount(config, "400", "AED", detail({ code: 0, chart_of_account: account }))).toMatchObject({ id: "400", type: "cash" });
  });
  it.each([
    { code: 0, ...account, chart_of_account: account }, { code: 0, chart_of_account: null },
    { code: 0, chart_of_account: { ...account, account_id: "999" } },
    { code: 0, chart_of_account: { ...account, account_type: "expense" } },
    { code: 0, chart_of_account: { ...account, is_active: false } },
    { code: 0, chart_of_account: { ...account, currency_code: "USD" } },
    { code: 0, chart_of_account: { ...account, currency_id: "999" } },
    { code: 0, chart_of_account: { account_id: "400", account_name: "Unknown currency", account_type: "cash", is_active: true } },
  ])("refuses ambiguous, inactive or unverified account evidence: %j", async raw => {
    await expect(assertPaymentAccount(config, "400", "AED", detail(raw))).rejects.toThrow();
  });
  it("does not infer currency from an account's name or the organization's base currency", async () => {
    fetcher.mockImplementation(async (input: string | URL) => new URL(input).pathname.includes("organizations")
      ? Response.json({ code: 0, organization: { organization_id: "100", is_org_active: true, currency_code: "AED", currency_id: "101" } })
      : Response.json({ code: 0, chartofaccounts: [{ account_id: "400", account_name: "AED Cash", account_type: "cash", is_active: true }], page_context: { page: 1, has_more_page: false } }));
    expect(await getPaymentAccounts(actor, "company")).toMatchObject({ accounts: [], warning: expect.any(String) });
  });
  it("GET-verifies missing chart currency from the exact same active bank/cash account", async () => {
    const request = vi.fn().mockResolvedValueOnce({ code: 0, chart_of_account: { account_id: "400", account_name: "Petty Cash", account_type: "cash", is_active: true } })
      .mockResolvedValueOnce({ code: 0, bankaccount: { account_id: "400", account_name: "Petty Cash", account_type: "cash", is_active: true, currency_id: "101", currency_code: "AED" } });
    expect(await assertPaymentAccount(config, "400", "AED", { request } as unknown as ZohoTransport)).toEqual({ id: "400", name: "Petty Cash", type: "cash", currency: "AED" });
    expect(request.mock.calls.map(([path]) => path)).toEqual(["/books/v3/chartofaccounts/400", "/books/v3/bankaccounts/400"]);
  });
  it("rejects a currency fallback for a different account or type", async () => {
    for (const change of [{ account_id: "999" }, { account_type: "bank" }, { currency_code: "USD" }]) {
      const request = vi.fn().mockResolvedValueOnce({ code: 0, chart_of_account: { account_id: "400", account_name: "Petty Cash", account_type: "cash", is_active: true } })
        .mockResolvedValueOnce({ code: 0, bankaccount: { ...account, ...change } });
      await expect(assertPaymentAccount(config, "400", "AED", { request } as unknown as ZohoTransport)).rejects.toThrow();
    }
  });
  it("keeps verified accounts selectable when another exact detail cannot be verified", async () => {
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (input: string | URL, options?: RequestInit) => {
      const path = new URL(input).pathname;
      if (path === "/books/v3/chartofaccounts") return Response.json({ code: 0, chartofaccounts: [account,
        { account_id: "500", account_name: "Unknown bank currency", account_type: "bank", is_active: true }], page_context: { page: 1, has_more_page: false } });
      if (path === "/books/v3/chartofaccounts/500") return Response.json({ code: 0, chart_of_account: { account_id: "500", account_name: "Unknown bank currency", account_type: "bank", is_active: true } });
      if (path === "/books/v3/bankaccounts/500") return Response.json({ code: 1 }, { status: 400 });
      return original(input, options);
    });
    expect(await getPaymentAccounts(actor, "company")).toMatchObject({ accounts: [{ id: "400", currency: "AED" }], warning: expect.stringContaining("excluded") });
  });
  it("excludes foreign-currency accounts before payment entry instead of inferring an exchange rate", async () => {
    const original = fetcher.getMockImplementation()!;
    const foreign = { ...account, account_id: "500", account_type: "bank", currency_code: "USD" };
    fetcher.mockImplementation(async (input: string | URL, options?: RequestInit) => {
      const path = new URL(input).pathname;
      if (path === "/books/v3/chartofaccounts") return Response.json({ code: 0, chartofaccounts: [account, foreign], page_context: { page: 1, has_more_page: false } });
      if (path === "/books/v3/chartofaccounts/500") return Response.json({ code: 0, chart_of_account: foreign });
      return original(input, options);
    });
    expect(await getPaymentAccounts(actor, "company")).toMatchObject({ accounts: [{ id: "400", currency: "AED" }], warning: expect.stringContaining("base-currency") });
  });
  it("shows a clear reconnect failure when exact bank/cash currency needs new read permission", async () => {
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (input: string | URL, options?: RequestInit) => {
      const path = new URL(input).pathname;
      if (path === "/books/v3/chartofaccounts/400") return Response.json({ code: 0, chart_of_account: { account_id: "400", account_name: "Petty Cash", account_type: "cash", is_active: true } });
      if (path === "/books/v3/bankaccounts/400") return Response.json({ code: 1 }, { status: 403 });
      return original(input, options);
    });
    await expect(getPaymentAccounts(actor, "company")).rejects.toMatchObject({ status: 503, code: "PAYMENT_ACCOUNT_CURRENCY_AUTHORIZATION_REQUIRED", message: expect.stringContaining("reconnect") });
    const response = await handle(async () => json(await getPaymentAccounts(actor, "company")));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "PAYMENT_ACCOUNT_CURRENCY_AUTHORIZATION_REQUIRED", error: expect.stringContaining("reconnect") });
  });
  it("requires finance role and exact active company membership before provider reads", async () => {
    await expect(getPaymentAccounts({ ...actor, role: "DATA_ENTRY" }, "company")).rejects.toMatchObject({ status: 403 });
    store.userCompanyMembership.findMany.mockResolvedValue([]);
    await expect(getPaymentAccounts(actor, "company")).rejects.toMatchObject({ status: 404 });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("discards returned accounts after membership is revoked during detail verification", async () => {
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (...args) => {
      if (new URL(args[0]).pathname === "/books/v3/chartofaccounts/400") store.user.findFirst.mockResolvedValue(null);
      return original(...args);
    });
    await expect(getPaymentAccounts(actor, "company")).rejects.toMatchObject({ status: 403 });
  });
  it("does not accept another organization's account catalog", async () => {
    fetcher.mockResolvedValue(Response.json({ code: 0, organization: { organization_id: "999", is_org_active: true, currency_code: "AED", currency_id: "101" } }));
    await expect(getPaymentAccounts(actor, "company")).rejects.toMatchObject({ status: 503, code: "PAYMENT_ORGANIZATION_UNVERIFIED" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
