import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
import { getConfig } from "@/lib/integrations/config";
import { ZohoTransport, type Fetch } from "@/lib/integrations/transport";
import { assertBooksVerificationEnvironment, verifyOperationalBooksDestination } from "@/lib/services/books-operational-setup";

const store = vi.hoisted(() => ({
  user: { findFirst: vi.fn() },
  company: { findUnique: vi.fn(), update: vi.fn() },
  companyIntegrationDestination: { findFirst: vi.fn(), update: vi.fn() },
  integrationJob: { count: vi.fn() },
  auditLog: { create: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: store }));
vi.mock("@/lib/integrations/oauth", () => ({ accessToken: vi.fn(async () => "fictional-token") }));

const actor: Actor = { id: "operator", role: "ADMIN", email: "operator@example.invalid", name: "Fictional operator" };
const input = { companyId: "operating-company", organizationId: "1001", organizationName: "Fictional Operating Company", reference: "REVIEW-2026-10-29" };
const mapping = {
  verified: true, baseCurrency: "AED", currencies: { AED: { id: "101" } },
  taxes: { "5.00": { id: "102", percentage: "5" } }, categories: { MATERIALS: { accountId: "103" } },
};
const environment: NodeJS.ProcessEnv = {
  NODE_ENV: "production", APP_ENV: "production", APP_URL: "https://billing.example.invalid",
  DATABASE_URL: "mysql://billing_runtime:fictional@database.example.invalid:3306/billing_operational",
  INTEGRATION_TEST_MODE: "false", INTEGRATION_NETWORK_ENABLED: "true", ZOHO_BOOKS_NETWORK_ENABLED: "true",
  ZOHO_BOOKS_WRITE_ENABLED: "false", ZOHO_BOOKS_LIVE_ENABLED: "false", ALLOW_PRODUCTION_ACCOUNTING_WRITES: "false",
  ZOHO_BOOKS_DC: "US", ZOHO_BOOKS_ENVIRONMENT: "production",
  ZOHO_BOOKS_CLIENT_ID: "fictional-client", ZOHO_BOOKS_CLIENT_SECRET: "fictional-secret",
  ZOHO_BOOKS_ORGANIZATIONS_JSON: JSON.stringify([{ organizationId: input.organizationId, name: input.organizationName, mapping }]),
};
const company = { id: input.companyId, name: input.organizationName, active: true, isDemo: false, liveAccountingEnabled: false };
const destination = { companyId: input.companyId, target: "ZOHO", organizationId: "1001", dataCenter: "US", environment: "production",
  liveEnabled: false, verifiedAt: null, verificationReference: null, verifiedConfigurationHash: null };
const metadata = () => ({
  "/books/v3/organizations/1001": { code: 0, organization: { organization_id: "1001", name: input.organizationName,
    is_org_active: true, currency_code: "AED", currency_id: "101", price_precision: 2 } },
  "/books/v3/settings/currencies/101": { code: 0, currency: { currency_id: "101", currency_code: "AED", is_base_currency: true, price_precision: 2 } },
  "/books/v3/chartofaccounts/103": { code: 0, account_id: "103", is_active: true, account_type: "expense" },
  "/books/v3/settings/taxes/102": { code: 0, tax: [{ tax_id: "102", tax_percentage: 5, tax_type: "tax" }] },
});
function connection(rows: Record<string, unknown> = metadata(), onRead?: (path: string) => void) {
  const fetcher = vi.fn<Fetch>(async (url, options) => {
    expect(options?.method).toBe("GET");
    expect(new URL(url).searchParams.get("organization_id")).toBe(input.organizationId);
    const path = new URL(url).pathname;
    onRead?.(path);
    if (!(path in rows)) throw new Error("Unexpected metadata endpoint");
    return new Response(JSON.stringify(rows[path]), { status: 200 });
  });
  return { transport: new ZohoTransport(getConfig("ZOHO", process.env, input.organizationId), async () => "fictional-token", fetcher), fetcher };
}
beforeEach(() => {
  vi.resetAllMocks();
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value);
  store.user.findFirst.mockResolvedValue({ id: actor.id });
  store.company.findUnique.mockResolvedValue(company);
  store.companyIntegrationDestination.findFirst.mockResolvedValue(destination);
  store.integrationJob.count.mockResolvedValue(0);
  store.$transaction.mockImplementation(async (operation) => operation(store));
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unmocked network denied"); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("operational Books company verification", () => {
  it("verifies the exact organization and currency for required line selections without inventing defaults", async () => {
    vi.stubEnv("ZOHO_BOOKS_ORGANIZATIONS_JSON", JSON.stringify([{ organizationId: input.organizationId, name: input.organizationName,
      mapping: { ...mapping, categories: {}, taxes: {}, lineSelectionRequired: true } }]));
    const { transport, fetcher } = connection();
    await expect(verifyOperationalBooksDestination(actor, input, transport)).resolves.toMatchObject({
      destinationVerified: true, providerReads: 2, currencyCount: 1, accountCount: 0, taxCount: 0, providerFinancialWrites: 0,
    });
    expect(fetcher.mock.calls.map(call => new URL(call[0]).pathname)).toEqual([
      "/books/v3/organizations/1001", "/books/v3/settings/currencies/101",
    ]);
  });
  it("keeps legacy empty defaults ineligible for operational verification", async () => {
    vi.stubEnv("ZOHO_BOOKS_ORGANIZATIONS_JSON", JSON.stringify([{ organizationId: input.organizationId, name: input.organizationName,
      mapping: { ...mapping, categories: {}, taxes: {} } }]));
    const { transport, fetcher } = connection();
    await expect(verifyOperationalBooksDestination(actor, input, transport)).rejects.toMatchObject({ code: "ACCOUNTING_MAPPING_REQUIRED" });
    expect(fetcher).not.toHaveBeenCalled(); expect(store.$transaction).not.toHaveBeenCalled();
  });
  it.each(["organization", "currency"])("still rejects mismatched %s metadata in required line mode", async kind => {
    vi.stubEnv("ZOHO_BOOKS_ORGANIZATIONS_JSON", JSON.stringify([{ organizationId: input.organizationId, name: input.organizationName,
      mapping: { ...mapping, categories: {}, taxes: {}, lineSelectionRequired: true } }]));
    const rows = metadata();
    if (kind === "organization") rows["/books/v3/organizations/1001"].organization.currency_id = "999";
    else rows["/books/v3/settings/currencies/101"].currency.is_base_currency = false;
    const { transport } = connection(rows);
    await expect(verifyOperationalBooksDestination(actor, input, transport)).rejects.toMatchObject({ kind: "BLOCKED" });
    expect(store.$transaction).not.toHaveBeenCalled();
  });
  it("verifies provider identity and mapped records by GET before recording audited destination proof", async () => {
    const { transport, fetcher } = connection();
    const receipt = await verifyOperationalBooksDestination(actor, input, transport);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(receipt).toMatchObject({ companyId: input.companyId, organizationId: "1001", providerReads: 4,
      destinationVerified: true, providerFinancialWrites: 0, financialWriteFlagsEnabled: false });
    expect(store.companyIntegrationDestination.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ liveEnabled: true, verificationReference: input.reference, verifiedConfigurationHash: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    }));
    expect(store.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      action: "BOOKS_OPERATIONAL_DESTINATION_VERIFIED", companyId: input.companyId,
      details: expect.objectContaining({ providerFinancialWrites: 0, providerReads: 4 }),
    }) }));
    expect(process.env.ZOHO_BOOKS_WRITE_ENABLED).toBe("false");
    expect(process.env.ZOHO_BOOKS_LIVE_ENABLED).toBe("false");
    expect(JSON.stringify(receipt)).not.toContain("fictional-token");
  });

  it.each(["expense", "cost_of_goods_sold", "other_expense"])("accepts the nested active %s account response", async (accountType) => {
    const rows: Record<string, unknown> = metadata();
    rows["/books/v3/chartofaccounts/103"] = { code: 0,
      chart_of_account: { account_id: "103", is_active: true, account_type: accountType } };
    const { transport, fetcher } = connection(rows);
    await expect(verifyOperationalBooksDestination(actor, input, transport)).resolves.toMatchObject({
      destinationVerified: true, providerReads: 4, providerFinancialWrites: 0,
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(store.companyIntegrationDestination.update).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["inactive", { account_id: "103", is_active: false, account_type: "expense" }],
    ["different ID", { account_id: "999", is_active: true, account_type: "expense" }],
    ["unsupported type", { account_id: "103", is_active: true, account_type: "income" }],
    ["missing active state", { account_id: "103", account_type: "expense" }],
    ["null nested value", null],
    ["array nested value", [{ account_id: "103", is_active: true, account_type: "expense" }]],
    ["malformed nested value", "invalid"],
  ])("rejects %s nested metadata even with valid top-level account fields", async (_caseName, nested) => {
    const rows: Record<string, unknown> = metadata();
    rows["/books/v3/chartofaccounts/103"] = { ...metadata()["/books/v3/chartofaccounts/103"], chart_of_account: nested };
    await expect(verifyOperationalBooksDestination(actor, input, connection(rows).transport)).rejects.toMatchObject({
      code: "BOOKS_ACCOUNT_MISMATCH", kind: "BLOCKED",
    });
    expect(store.$transaction).not.toHaveBeenCalled();
    expect(store.company.update).not.toHaveBeenCalled();
    expect(store.companyIntegrationDestination.update).not.toHaveBeenCalled();
    expect(store.auditLog.create).not.toHaveBeenCalled();
  });

  it("requires a successful provider envelope around valid nested account fields", async () => {
    const rows: Record<string, unknown> = metadata();
    rows["/books/v3/chartofaccounts/103"] = {
      chart_of_account: { account_id: "103", is_active: true, account_type: "expense" },
    };
    await expect(verifyOperationalBooksDestination(actor, input, connection(rows).transport)).rejects.toMatchObject({
      code: "BOOKS_ACCOUNT_MISMATCH", kind: "BLOCKED",
    });
    expect(store.$transaction).not.toHaveBeenCalled();
  });

  it.each(["ZOHO_BOOKS_WRITE_ENABLED", "ZOHO_BOOKS_LIVE_ENABLED", "ALLOW_PRODUCTION_ACCOUNTING_WRITES"])("refuses setup with %s enabled before any provider request", async (flag) => {
    const { transport, fetcher } = connection();
    vi.stubEnv(flag, "true");
    await expect(verifyOperationalBooksDestination(actor, input, transport)).rejects.toMatchObject({code:"SETUP_WRITES_MUST_BE_DISABLED"});
    expect(fetcher).not.toHaveBeenCalled();
    expect(store.$transaction).not.toHaveBeenCalled();
  });

  it("refuses development databases without trying metadata or database writes", () => {
    vi.stubEnv("DATABASE_URL", "mysql://billing_runtime:fictional@127.0.0.1:3308/voltronix_billing_dev");
    expect(assertBooksVerificationEnvironment).toThrow("production runtime");
    expect(store.$transaction).not.toHaveBeenCalled();
  });

  it.each(["role", "membership", "demo", "wrong-company", "outstanding"])("blocks %s before any provider request", async (caseName) => {
    const { transport, fetcher } = connection();
    if (caseName === "membership") store.user.findFirst.mockResolvedValue(null);
    if (caseName === "demo") store.company.findUnique.mockResolvedValue({ ...company, isDemo: true });
    if (caseName === "wrong-company") store.companyIntegrationDestination.findFirst.mockResolvedValue({ ...destination, companyId: "another-company" });
    if (caseName === "outstanding") store.integrationJob.count.mockResolvedValue(1);
    await expect(verifyOperationalBooksDestination(caseName === "role" ? {...actor,role:"ACCOUNTS"} : actor, input, transport)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(store.company.update).not.toHaveBeenCalled();
  });

  it.each(["organization", "name", "currency", "account", "tax", "compound"])("does not authorize when provider %s metadata disagrees", async (caseName) => {
    const rows = metadata();
    if (caseName === "organization") rows["/books/v3/organizations/1001"].organization.organization_id = "9999";
    if (caseName === "name") rows["/books/v3/organizations/1001"].organization.name = "Another Company";
    if (caseName === "currency") rows["/books/v3/settings/currencies/101"].currency.currency_code = "USD";
    if (caseName === "account") rows["/books/v3/chartofaccounts/103"].is_active = false;
    if (caseName === "tax") rows["/books/v3/settings/taxes/102"].tax[0].tax_percentage = 10;
    if (caseName === "compound") rows["/books/v3/settings/taxes/102"].tax[0].tax_type = "compound_tax";
    const { transport } = connection(rows);
    await expect(verifyOperationalBooksDestination(actor, input, transport)).rejects.toMatchObject({ kind: "BLOCKED" });
    expect(store.company.update).not.toHaveBeenCalled();
    expect(store.companyIntegrationDestination.update).not.toHaveBeenCalled();
    expect(store.auditLog.create).not.toHaveBeenCalled();
  });

  it("rejects duplicate tax matches and preserves local authorization", async () => {
    const rows = metadata();
    rows["/books/v3/settings/taxes/102"].tax.push({ ...rows["/books/v3/settings/taxes/102"].tax[0] });
    await expect(verifyOperationalBooksDestination(actor, input, connection(rows).transport)).rejects.toMatchObject({code:"BOOKS_TAX_MISMATCH"});
    expect(store.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    { status: "Active" },
    { status: "active" },
    { status: "Active", is_active: true },
    { is_active: true },
    {},
  ])("accepts active tax metadata and existing omitted-indicator compatibility: %j", async (activity) => {
    const rows: Record<string, unknown> = metadata();
    rows["/books/v3/settings/taxes/102"] = { code: 0,
      tax: { ...metadata()["/books/v3/settings/taxes/102"].tax[0], ...activity } };
    await expect(verifyOperationalBooksDestination(actor, input, connection(rows).transport)).resolves.toMatchObject({
      destinationVerified: true, providerReads: 4, providerFinancialWrites: 0,
    });
    expect(store.companyIntegrationDestination.update).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: "Inactive" },
    { status: "inactive" },
    { is_active: false },
    { status: "Inactive", is_active: true },
    { status: "Active", is_active: false },
    { status: "unknown" },
    { status: null },
    { status: true },
    { is_active: "true" },
  ])("rejects inactive, contradictory or malformed tax activity: %j", async (activity) => {
    const rows: Record<string, unknown> = metadata();
    rows["/books/v3/settings/taxes/102"] = { code: 0,
      tax: [{ ...metadata()["/books/v3/settings/taxes/102"].tax[0], ...activity }] };
    await expect(verifyOperationalBooksDestination(actor, input, connection(rows).transport)).rejects.toMatchObject({
      code: "BOOKS_TAX_MISMATCH", kind: "BLOCKED",
    });
    expect(store.$transaction).not.toHaveBeenCalled();
    expect(store.company.update).not.toHaveBeenCalled();
    expect(store.companyIntegrationDestination.update).not.toHaveBeenCalled();
    expect(store.auditLog.create).not.toHaveBeenCalled();
  });

  it("rechecks company membership after metadata reads", async () => {
    store.user.findFirst.mockResolvedValueOnce({ id: actor.id }).mockResolvedValueOnce(null);
    await expect(verifyOperationalBooksDestination(actor, input, connection().transport)).rejects.toMatchObject({status:403});
    expect(store.company.update).not.toHaveBeenCalled();
  });

  it("rejects a destination changed during provider verification", async () => {
    store.companyIntegrationDestination.findFirst.mockResolvedValueOnce(destination).mockResolvedValueOnce({...destination, verificationReference:"concurrent-change"});
    await expect(verifyOperationalBooksDestination(actor, input, connection().transport)).rejects.toMatchObject({status:409});
    expect(store.companyIntegrationDestination.update).not.toHaveBeenCalled();
  });

  it("does not certify configuration changed during provider verification", async () => {
    const { transport } = connection(metadata(), () => vi.stubEnv("ZOHO_BOOKS_CLIENT_SECRET", "changed-fictional-secret"));
    await expect(verifyOperationalBooksDestination(actor, input, transport)).rejects.toMatchObject({code:"CONFIGURATION_CHANGED"});
    expect(store.$transaction).not.toHaveBeenCalled();
  });

  it("rejects unknown or unsupported mapping fields before certifying provider evidence", async () => {
    vi.stubEnv("ZOHO_BOOKS_ORGANIZATIONS_JSON", JSON.stringify([{organizationId:input.organizationId,name:input.organizationName,mapping:{...mapping,jobCustomFieldIndex:1}}]));
    const { transport, fetcher } = connection();
    await expect(verifyOperationalBooksDestination(actor, input, transport)).rejects.toMatchObject({code:"MAPPING_VERIFICATION_UNSUPPORTED"});
    expect(fetcher).not.toHaveBeenCalled();
  });
});
