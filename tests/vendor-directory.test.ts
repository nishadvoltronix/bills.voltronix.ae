import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
import { getConfig } from "@/lib/integrations/config";
import { connectionFingerprint } from "@/lib/integrations/connection-fingerprint";
import { ZohoTransport, type Fetch } from "@/lib/integrations/transport";
import { listCompanyVendorDirectory, resolveBillVendor, searchBillVendors } from "@/lib/services/bill-vendor-lookup";

const store = vi.hoisted(() => ({
  user: { findFirst: vi.fn() }, company: { findUnique: vi.fn() },
  companyIntegrationDestination: { findMany: vi.fn() }, integrationCredential: { findUnique: vi.fn() },
  vendor: { findMany: vi.fn(), create: vi.fn() }, vendorBooksMapping: { findMany: vi.fn(), create: vi.fn() },
  auditLog: { create: vi.fn() }, $transaction: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: store }));
vi.mock("@/lib/integrations/oauth", () => ({ accessToken: vi.fn(async () => "fictional-token"), LEGACY_UNSCOPED_ORGANIZATION: "__legacy_unscoped__" }));
const actor: Actor = { id: "reader", name: "Reader", email: "reader@example.invalid", role: "MANAGEMENT" };
const destination = { organizationId: "1001", dataCenter: "US", environment: "production" as const };
const env: NodeJS.ProcessEnv = {
  NODE_ENV: "development", APP_ENV: "development", APP_URL: "http://127.0.0.1:3000",
  INTEGRATION_NETWORK_ENABLED: "true", ZOHO_BOOKS_NETWORK_ENABLED: "true", ZOHO_BOOKS_WRITE_ENABLED: "false",
  ZOHO_BOOKS_LIVE_ENABLED: "false", ALLOW_PRODUCTION_ACCOUNTING_WRITES: "false", INTEGRATION_TEST_MODE: "false",
  ZOHO_BOOKS_DC: "US", ZOHO_BOOKS_ENVIRONMENT: "production", ZOHO_BOOKS_CLIENT_ID: "fictional-client", ZOHO_BOOKS_CLIENT_SECRET: "fictional-secret",
  ZOHO_BOOKS_REFRESH_TOKEN: "", ZOHO_BOOKS_ORGANIZATION_ID: "",
  ZOHO_BOOKS_ORGANIZATIONS_JSON: JSON.stringify([{ organizationId: "1001", name: "Fictional A" }, { organizationId: "1002", name: "Fictional B" }]),
};
type Local = { id: string; companyId: string; name: string; currency: string; email: string | null; trn: string | null };
type Destination = { companyId: string; organizationId: string; dataCenter: string; environment: "production" | "sandbox" };
type Mapping = Omit<Destination, "companyId"> & { externalVendorId: string; vendor: Local };
let locals: Local[], destinations: Destination[], mappings: Mapping[];
let authorized: boolean, companyActive: boolean, companyDemo: boolean, grantActive: boolean, grantPresent: boolean, grantFingerprint: string | null;
let currentRole: Actor["role"];
function local(companyId = "company-a", name = "Saved supplier"): Local {
  const row = { id: `local-${locals.length + 1}`, companyId, name, currency: "AED", email: null, trn: null };
  locals.push(row); return row;
}
function contact(overrides: Record<string, unknown> = {}) {
  return { contact_id: "2001", contact_name: "Books supplier", contact_type: "vendor", status: "active", currency_code: "AED",
    email: "supplier@example.invalid", tax_reg_no: "100000000000001", billing_address: { street: "PRIVATE ADDRESS" }, ...overrides };
}
const page = (contacts: unknown[], pageNumber = 1, hasMore = false) => ({ code: 0, contacts, page_context: { page: pageNumber, per_page: 100, has_more_page: hasMore } });
function connection(body: unknown, organizationId = "1001", onRead?: () => void) {
  const fetcher = vi.fn<Fetch>(async (url, options) => {
    expect(options?.method).toBe("GET");
    expect(new URL(url).pathname).toBe("/books/v3/contacts");
    expect(new URL(url).searchParams.get("organization_id")).toBe(organizationId);
    onRead?.();
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return { transport: new ZohoTransport(getConfig("ZOHO", process.env, organizationId), async () => "fictional-token", fetcher), fetcher };
}
beforeEach(() => {
  vi.resetAllMocks();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  locals = []; mappings = []; authorized = true; companyActive = true; companyDemo = true;
  grantActive = true; grantPresent = true; grantFingerprint = null; currentRole = "MANAGEMENT";
  destinations = [{ companyId: "company-a", ...destination }, { companyId: "company-b", ...destination, organizationId: "1002" }];
  store.user.findFirst.mockImplementation(async ({ where }: { where: { role: { in: Actor["role"][] } } }) => authorized && companyActive && where.role.in.includes(currentRole) ? { id: actor.id } : null);
  store.company.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id, active: companyActive, isDemo: companyDemo }));
  store.companyIntegrationDestination.findMany.mockImplementation(async ({ where }: { where: { companyId: string } }) => destinations.filter(item => item.companyId === where.companyId).map(({ organizationId, dataCenter, environment }) => ({ organizationId, dataCenter, environment })));
  store.integrationCredential.findUnique.mockImplementation(async ({ where }: { where: { target_organizationId: { organizationId: string } } }) => {
    const org = where.target_organizationId.organizationId;
    return !grantPresent || org === "__legacy_unscoped__" ? null : { revokedAt: grantActive ? null : new Date(), connectionFingerprint: grantFingerprint ?? connectionFingerprint(getConfig("ZOHO", process.env, org)) };
  });
  store.vendor.findMany.mockImplementation(async ({ where, skip, take }: { where: { companyId: string; name?: { contains: string } }; skip: number; take: number }) => {
    const q = where.name?.contains.replace(/\\([\\%_])/g, "$1").toLowerCase();
    return locals.filter(row => row.companyId === where.companyId && (!q || row.name.toLowerCase().includes(q)))
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)).slice(skip, skip + take);
  });
  store.vendorBooksMapping.findMany.mockImplementation(async ({ where }: { where: Omit<Mapping, "externalVendorId" | "vendor"> & { externalVendorId: { in: string[] }; vendor: { companyId: string } } }) =>
    mappings.filter(row => row.organizationId === where.organizationId && row.dataCenter === where.dataCenter && row.environment === where.environment &&
      where.externalVendorId.in.includes(row.externalVendorId) && row.vendor.companyId === where.vendor.companyId));
});
afterEach(() => {
  expect(store.vendor.create).not.toHaveBeenCalled(); expect(store.vendorBooksMapping.create).not.toHaveBeenCalled();
  expect(store.auditLog.create).not.toHaveBeenCalled(); expect(store.$transaction).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
});

describe("company vendor directory", () => {
  it("manual mode lists saved company suppliers despite an existing provider destination", async () => {
    vi.stubEnv("MANUAL_ENTRY_ONLY", "true");
    companyDemo = false;
    const saved = local();
    local("company-b", "Another company's supplier");
    const { transport, fetcher } = connection(page([contact()]));
    const result = await listCompanyVendorDirectory(actor, { companyId: "company-a" }, transport);
    expect(result).toMatchObject({ source: "local", organizationId: null, dataCenter: null,
      environment: null, warning: null, vendors: [{ ...saved, status: "local" }] });
    expect(fetcher).not.toHaveBeenCalled();
    expect(store.companyIntegrationDestination.findMany).not.toHaveBeenCalled();
    expect(store.integrationCredential.findUnique).not.toHaveBeenCalled();
  });

  it("lets Management read active and inactive provider vendors in currencies beyond bill entry", async () => {
    const linked = local(); mappings.push({ ...destination, externalVendorId: "2001", vendor: linked });
    const { transport, fetcher } = connection(page([contact(), contact({ contact_id: "2002", status: "inactive", currency_code: "JPY" }), contact({ contact_id: "2003", contact_type: "customer" })], 2, true));
    const result = await listCompanyVendorDirectory(actor, { companyId: "company-a", page: 2 }, transport);
    expect(result).toMatchObject({ companyId: "company-a", ...destination, source: "books", page: 2, perPage: 100, hasMore: true, warning: null });
    expect(result.vendors).toMatchObject([{ id: linked.id, externalVendorId: "2001", status: "active", ...destination }, { id: null, externalVendorId: "2002", status: "inactive", currency: "JPY", ...destination }]);
    expect(Object.fromEntries(new URL(fetcher.mock.calls[0][0]).searchParams)).toEqual({ contact_type: "vendor", page: "2", per_page: "100", sort_column: "contact_name", sort_order: "A", organization_id: "1001" });
    expect(JSON.stringify(result)).not.toContain("PRIVATE ADDRESS");
    expect(store.user.findFirst.mock.calls[0][0].where.role.in).toContain("MANAGEMENT");
  });

  it("preserves bill-entry writer restrictions for Management", async () => {
    await expect(searchBillVendors(actor, { companyId: "company-a" })).rejects.toMatchObject({ status: 403 });
    await expect(resolveBillVendor(actor, { companyId: "company-a", ...destination, externalVendorId: "2001" })).rejects.toMatchObject({ status: 403 });
    expect(store.user.findFirst).not.toHaveBeenCalled();
  });

  it.each(["ADMIN", "ACCOUNTS", "DATA_ENTRY", "MANAGEMENT"] as const)("allows a current %s reader", async role => {
    currentRole = role;
    const result = await listCompanyVendorDirectory({ ...actor, role }, { companyId: "company-a" }, connection(page([contact()])).transport);
    expect(result.vendors).toHaveLength(1);
  });

  it("scopes same external IDs and mapped local IDs to the exact company and destination", async () => {
    mappings.push({ ...destination, externalVendorId: "2001", vendor: local() });
    const b = local("company-b"); mappings.push({ ...destination, organizationId: "1002", externalVendorId: "2001", vendor: b });
    const result = await listCompanyVendorDirectory(actor, { companyId: "company-b" }, connection(page([contact()]), "1002").transport);
    expect(result.vendors).toMatchObject([{ id: b.id, companyId: "company-b", organizationId: "1002" }]);
    const wrong = connection(page([contact()]));
    const mismatch = await listCompanyVendorDirectory(actor, { companyId: "company-b" }, wrong.transport);
    expect(mismatch.vendors).toEqual([]); expect(mismatch.warning).toBeTruthy(); expect(wrong.fetcher).not.toHaveBeenCalled();
  });

  it("keeps local directory pages company scoped, stable and bounded to 100 without provider configuration", async () => {
    destinations = [];
    vi.stubEnv("ZOHO_BOOKS_ORGANIZATIONS_JSON", "private-malformed-config");
    for (let i = 0; i < 101; i++) local("company-a", `Supplier ${String(i).padStart(3, "0")}`);
    local("company-b", "Another company's supplier");
    const first = await listCompanyVendorDirectory(actor, { companyId: "company-a" });
    const second = await listCompanyVendorDirectory(actor, { companyId: "company-a", page: 2 });
    expect(first).toMatchObject({ source: "local", organizationId: null, dataCenter: null, environment: null, page: 1, perPage: 100, hasMore: true, warning: null });
    expect(first.vendors).toHaveLength(100); expect(first.vendors.every(row => row.companyId === "company-a" && row.status === "local" && !row.externalVendorId)).toBe(true);
    expect(second.vendors.map(row => row.name)).toEqual(["Supplier 100"]); expect(second.hasMore).toBe(false);
    expect(store.vendor.findMany.mock.calls[1][0]).toMatchObject({ skip: 100, take: 101, orderBy: [{ name: "asc" }, { id: "asc" }] });
    expect(store.integrationCredential.findUnique).not.toHaveBeenCalled();
  });

  it("preserves literal wildcard substring searches locally and in provider results", async () => {
    destinations = [];
    local("company-a", "100%_\\ supplier"); local("company-a", "100 other supplier");
    const result = await listCompanyVendorDirectory(actor, { companyId: "company-a", q: "%_\\" });
    expect(result.vendors).toHaveLength(1);
    expect(store.vendor.findMany.mock.calls[0][0].where.name.contains).toBe("\\%\\_\\\\");
    destinations = [{ companyId: "company-a", ...destination }];
    const { transport, fetcher } = connection(page([contact({ contact_name: "100% supplier" }), contact({ contact_id: "2002", contact_name: "100 other supplier" })]));
    const remote = await listCompanyVendorDirectory(actor, { companyId: "company-a", q: "%" }, transport);
    expect(remote.vendors.map(row => row.name)).toEqual(["100% supplier"]);
    expect(new URL(fetcher.mock.calls[0][0]).searchParams.get("contact_name_contains")).toBe("%");
  });

  it("preserves the existing unconfigured demo sandbox local mode with an explicit warning", async () => {
    destinations[0] = { companyId: "company-a", ...destination, organizationId: "7777", environment: "sandbox" };
    const row = local();
    const result = await listCompanyVendorDirectory(actor, { companyId: "company-a" });
    expect(result).toMatchObject({ source: "local", organizationId: null, dataCenter: null, environment: null });
    expect(result.vendors).toEqual([{ ...row, status: "local" }]); expect(result.warning).toContain("not configured");
  });

  it.each(["missing-profile", "disabled", "missing-grant", "revoked-grant", "changed-grant", "ambiguous"])("never mixes local records into a Books page when %s", async mode => {
    mappings.push({ ...destination, externalVendorId: "2001", vendor: local() });
    const remote = connection(page([contact()]));
    if (mode === "missing-profile") vi.stubEnv("ZOHO_BOOKS_ORGANIZATIONS_JSON", JSON.stringify([{ organizationId: "1002", name: "Fictional B" }]));
    if (mode === "disabled") vi.stubEnv("ZOHO_BOOKS_NETWORK_ENABLED", "false");
    if (mode === "missing-grant") grantPresent = false;
    if (mode === "revoked-grant") grantActive = false;
    if (mode === "changed-grant") grantFingerprint = "another-connection";
    if (mode === "ambiguous") destinations.push({ companyId: "company-a", ...destination, organizationId: "1002" });
    const result = await listCompanyVendorDirectory(actor, { companyId: "company-a", page: 2 }, remote.transport);
    expect(result).toMatchObject({ source: "books", vendors: [], hasMore: false, page: 2 }); expect(result.warning).toBeTruthy();
    expect(remote.fetcher).not.toHaveBeenCalled(); expect(store.vendor.findMany).not.toHaveBeenCalled(); expect(store.vendorBooksMapping.findMany).not.toHaveBeenCalled();
  });

  it.each([
    { code: 0, contacts: [] },
    { ...page([]), page_context: { page: 2, per_page: 100, has_more_page: false } },
    { ...page([]), page_context: { page: 1, per_page: 200, has_more_page: false } },
    { ...page([]), page_context: { page: 1, per_page: 100, has_more_page: "false" } },
    page([], 1, true), page([contact(), contact()]), page([contact({ contact_type: "customer" }), contact()]),
    page(Array.from({ length: 101 }, (_, index) => contact({ contact_id: String(3000 + index) }))),
    page([contact({ contact_name: "PRIVATE\u0000INVALID" })]), page([contact({ currency_code: "PRIVATE INVALID CURRENCY" })]),
    page([contact({ status: "deleted" })]), { code: 123, message: "PRIVATE PROVIDER ERROR" },
  ])("returns an empty retryable page for malformed or ignored provider pagination", async body => {
    mappings.push({ ...destination, externalVendorId: "2001", vendor: local() });
    const result = await listCompanyVendorDirectory(actor, { companyId: "company-a" }, connection(body).transport);
    expect(result.vendors).toEqual([]); expect(result.hasMore).toBe(false); expect(result.warning).toContain("Retry");
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });

  it("keeps all 100 returned vendors and signals the next page", async () => {
    const result = await listCompanyVendorDirectory(actor, { companyId: "company-a" }, connection(page(Array.from({ length: 100 }, (_, index) => contact({ contact_id: String(3000 + index) })), 1, true)).transport);
    expect(result.vendors).toHaveLength(100); expect(result.hasMore).toBe(true); expect(result.warning).toBeNull();
  });

  it.each([{}, { companyId: "" }, { companyId: "company-a", q: "x".repeat(101) },
    { companyId: "company-a", page: 0 }, { companyId: "company-a", page: 10_001 }, { companyId: "company-a", page: 1.5 },
    { companyId: "company-a", page: "2" }, { companyId: "company-a", organizationId: "1002" }])("validates input before access or provider reads", async input => {
    await expect(listCompanyVendorDirectory(actor, input)).rejects.toHaveProperty("name", "ZodError");
    expect(store.user.findFirst).not.toHaveBeenCalled(); expect(store.integrationCredential.findUnique).not.toHaveBeenCalled();
  });

  it.each(["membership", "company", "destination", "configuration", "grant"])("rejects a late response after %s changes", async change => {
    const remote = connection(page([contact()]), "1001", () => {
      if (change === "membership") authorized = false;
      if (change === "company") companyActive = false;
      if (change === "destination") destinations[0] = { ...destinations[0], organizationId: "1002" };
      if (change === "configuration") vi.stubEnv("ZOHO_BOOKS_CLIENT_ID", "replacement-client");
      if (change === "grant") grantActive = false;
    });
    await expect(listCompanyVendorDirectory(actor, { companyId: "company-a" }, remote.transport)).rejects.toMatchObject({ status: ["membership", "company"].includes(change) ? 403 : 409 });
  });

  it("allows a normal access-token refresh that preserves the current grant identity", async () => {
    const remote = connection(page([contact()]), "1001", () => {
      store.integrationCredential.findUnique.mockResolvedValue({ revokedAt: null, connectionFingerprint: connectionFingerprint(getConfig("ZOHO", process.env, "1001")), updatedAt: new Date("2026-10-29T12:00:00Z") });
    });
    const result = await listCompanyVendorDirectory(actor, { companyId: "company-a" }, remote.transport);
    expect(result.vendors).toHaveLength(1); expect(result.warning).toBeNull();
  });

  it("rejects membership loss before local results return", async () => {
    destinations = [];
    store.vendor.findMany.mockImplementationOnce(async () => { authorized = false; return [local()]; });
    await expect(listCompanyVendorDirectory(actor, { companyId: "company-a" })).rejects.toMatchObject({ status: 403 });
  });

  it("rejects an unauthorized company before provider reads", async () => {
    authorized = false;
    const remote = connection(page([contact()]));
    await expect(listCompanyVendorDirectory(actor, { companyId: "company-a" }, remote.transport)).rejects.toMatchObject({ status: 403 });
    expect(remote.fetcher).not.toHaveBeenCalled();
  });
});
