import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
import { getConfig } from "@/lib/integrations/config";
import { ZohoTransport, type Fetch } from "@/lib/integrations/transport";
import { resolveBillVendor, searchBillVendors } from "@/lib/services/bill-vendor-lookup";

const store = vi.hoisted(() => ({
  user: { findFirst: vi.fn() }, company: { findUnique: vi.fn() },
  companyIntegrationDestination: { findMany: vi.fn() },
  vendor: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  vendorBooksMapping: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
  auditLog: { create: vi.fn() }, $transaction: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: store }));
vi.mock("@/lib/integrations/oauth", () => ({ accessToken: vi.fn(async () => "fictional-token") }));
const actor: Actor = { id: "entry-user", name: "Entry user", email: "entry@example.invalid", role: "DATA_ENTRY" };
const destination = { organizationId: "1001", dataCenter: "US", environment: "production" as const };
const selection = { companyId: "company-a", ...destination, externalVendorId: "2001" };
const env: NodeJS.ProcessEnv = {
  NODE_ENV: "development", APP_ENV: "development", APP_URL: "http://127.0.0.1:3000",
  INTEGRATION_NETWORK_ENABLED: "true", ZOHO_BOOKS_NETWORK_ENABLED: "true", ZOHO_BOOKS_WRITE_ENABLED: "false",
  ZOHO_BOOKS_LIVE_ENABLED: "false", ALLOW_PRODUCTION_ACCOUNTING_WRITES: "false", INTEGRATION_TEST_MODE: "false",
  ZOHO_BOOKS_DC: "US", ZOHO_BOOKS_ENVIRONMENT: "production", ZOHO_BOOKS_CLIENT_ID: "fictional-client", ZOHO_BOOKS_CLIENT_SECRET: "fictional-secret",
  ZOHO_BOOKS_ORGANIZATIONS_JSON: JSON.stringify([{ organizationId: "1001", name: "Fictional A" }, { organizationId: "1002", name: "Fictional B" }]),
};
type Vendor = { id: string; companyId: string; name: string; currency: string; email: string | null; trn: string | null; isDemo: boolean; externalZohoId: string | null };
type Mapping = { id: string; vendorId: string; organizationId: string; dataCenter: string; environment: string; externalVendorId: string };
type Filter = { companyId?: string; id?: string; name?: string | { contains: string }; externalZohoId?: string | null; booksMappings?: { none: Record<string, never> }; trn?: string; OR?: Filter[] };
let vendors: Vendor[], mappings: Mapping[], audit: unknown[];
let authorized: boolean;
let companies: { id: string; active: boolean; isDemo: boolean }[];
let destinations: (Omit<typeof destination, "environment"> & { companyId: string; environment: "production" | "sandbox" })[];
const localView = (v: Vendor) => ({ id: v.id, companyId: v.companyId, name: v.name, currency: v.currency, email: v.email, trn: v.trn });
const unescapeLike = (value: string) => value.replace(/\\([\\%_])/g, "$1");
function match(vendor: Vendor, where: Filter): boolean {
  if (where.companyId && vendor.companyId !== where.companyId) return false;
  if (where.id && vendor.id !== where.id) return false;
  if ("externalZohoId" in where && vendor.externalZohoId !== where.externalZohoId) return false;
  if (where.booksMappings?.none && mappings.some(mapping => mapping.vendorId === vendor.id)) return false;
  if (where.trn && vendor.trn !== where.trn) return false;
  if (where.name && (typeof where.name === "string" ? vendor.name.toLowerCase() !== where.name.toLowerCase() : !vendor.name.toLowerCase().includes(unescapeLike(where.name.contains).toLowerCase()))) return false;
  return !where.OR || where.OR.some(filter => match(vendor, filter));
}
function local(overrides: Partial<Vendor> = {}) {
  const vendor: Vendor = { id: `vendor-${vendors.length + 1}`, companyId: "company-a", name: "Saved supplier", currency: "AED", email: null, trn: null, isDemo: true, externalZohoId: null, ...overrides };
  vendors.push(vendor); return vendor;
}
function mapped(vendor = local(), overrides: Partial<Mapping> = {}) {
  const mapping = { id: `mapping-${mappings.length + 1}`, vendorId: vendor.id, ...destination, externalVendorId: "2001", ...overrides };
  mappings.push(mapping); return mapping;
}
function contact(overrides: Record<string, unknown> = {}) {
  return { contact_id: "2001", contact_name: "Books supplier", contact_type: "vendor", status: "active", currency_code: "AED",
    email: "supplier@example.invalid", tax_reg_no: "100000000000001", billing_address: { street: "PRIVATE ADDRESS" }, ...overrides };
}
function connection(body: unknown, organizationId = "1001", onRead?: () => void) {
  const fetcher = vi.fn<Fetch>(async (url, options) => {
    expect(options?.method).toBe("GET");
    expect(new URL(url).searchParams.get("organization_id")).toBe(organizationId);
    onRead?.();
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return { transport: new ZohoTransport(getConfig("ZOHO", process.env, organizationId), async () => "fictional-token", fetcher), fetcher };
}
const page = (contacts: unknown[], hasMore = false) => ({ code: 0, contacts, page_context: { page: 1, per_page: 25, has_more_page: hasMore } });

beforeEach(() => {
  vi.resetAllMocks();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vendors = []; mappings = []; audit = []; authorized = true;
  companies = [{ id: "company-a", active: true, isDemo: true }, { id: "company-b", active: true, isDemo: true }];
  destinations = [{ companyId: "company-a", ...destination }, { companyId: "company-b", ...destination, organizationId: "1002" }];
  store.user.findFirst.mockImplementation(async () => authorized ? { id: actor.id } : null);
  store.company.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => companies.find(company => company.id === where.id) ?? null);
  store.companyIntegrationDestination.findMany.mockImplementation(async ({ where }: { where: { companyId: string } }) =>
    destinations.filter(item => item.companyId === where.companyId).map(({ organizationId, dataCenter, environment }) => ({ organizationId, dataCenter, environment })));
  store.vendor.findMany.mockImplementation(async ({ where, take }: { where: Filter; take: number }) => vendors.filter(v => match(v, where)).slice(0, take).map(localView));
  store.vendor.findFirst.mockImplementation(async ({ where }: { where: Filter }) => { const vendor = vendors.find(v => match(v, where)); return vendor ? localView(vendor) : null; });
  store.vendorBooksMapping.findMany.mockImplementation(async ({ where, take }: { where: Omit<Partial<Mapping>, "externalVendorId"> & { externalVendorId?: string | { in: string[] }; vendor: Filter }; take?: number }) => {
    return mappings.filter(mapping => {
      const vendor = vendors.find(v => v.id === mapping.vendorId)!;
      const wanted = where.externalVendorId;
      return mapping.organizationId === where.organizationId && mapping.dataCenter === where.dataCenter && mapping.environment === where.environment &&
        (!wanted || (typeof wanted === "string" ? mapping.externalVendorId === wanted : wanted.in.includes(mapping.externalVendorId))) && match(vendor, where.vendor);
    }).slice(0, take).map(mapping => ({ externalVendorId: mapping.externalVendorId, vendor: localView(vendors.find(v => v.id === mapping.vendorId)!) }));
  });
  store.vendorBooksMapping.findUnique.mockImplementation(async ({ where }: { where: { organizationId_dataCenter_environment_externalVendorId: Omit<Mapping, "id" | "vendorId"> } }) => {
    const key = where.organizationId_dataCenter_environment_externalVendorId;
    const mapping = mappings.find(item => item.organizationId === key.organizationId && item.dataCenter === key.dataCenter && item.environment === key.environment && item.externalVendorId === key.externalVendorId);
    const vendor = mapping && vendors.find(v => v.id === mapping.vendorId);
    return mapping && vendor ? { ...mapping, vendor: { ...localView(vendor), externalZohoId: vendor.externalZohoId } } : null;
  });
  store.vendor.create.mockImplementation(async ({ data }: { data: Omit<Vendor, "id" | "externalZohoId"> }) => localView(local(data)));
  store.vendorBooksMapping.create.mockImplementation(async ({ data }: { data: Omit<Mapping, "id"> }) => { const row = { ...data, id: `mapping-${mappings.length + 1}` }; mappings.push(row); return row; });
  store.auditLog.create.mockImplementation(async ({ data }: { data: unknown }) => { audit.push(data); return {}; });
  store.$transaction.mockImplementation(async (action: (tx: typeof store) => Promise<unknown>, options: unknown) => {
    expect(options).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20_000 });
    const before = structuredClone({ vendors, mappings, audit });
    try { return await action(store); } catch (error) { ({ vendors, mappings, audit } = before); throw error; }
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("company-specific bill vendor search", () => {
  it("manual mode exposes the company's saved vendors without consulting its configured Books destination", async () => {
    vi.stubEnv("MANUAL_ENTRY_ONLY", "true");
    companies[0].isDemo = false;
    const saved = local({ name: "Local manual supplier", isDemo: false });
    const linked = local({ name: "Previously linked manual supplier", isDemo: false });
    mapped(linked);
    local({ companyId: "company-b", name: "Another company's supplier" });
    const { transport, fetcher } = connection(page([contact()]));
    const result = await searchBillVendors(actor, { companyId: "company-a" }, transport);
    expect(result).toMatchObject({ organizationId: null, warning: null, vendors: [localView(saved), localView(linked)] });
    expect(result.vendors.every(vendor => !vendor.externalVendorId)).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
    expect(store.companyIntegrationDestination.findMany).not.toHaveBeenCalled();
    expect(store.vendorBooksMapping.findMany).not.toHaveBeenCalled();
    await expect(resolveBillVendor(actor, selection, transport)).rejects.toMatchObject({ status: 409 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("manual mode still checks current company membership before returning saved vendors", async () => {
    vi.stubEnv("MANUAL_ENTRY_ONLY", "true");
    authorized = false;
    await expect(searchBillVendors(actor, { companyId: "company-a" })).rejects.toMatchObject({ status: 403 });
    expect(store.vendor.findMany).not.toHaveBeenCalled();
  });

  it("uses the exact company's Books organization and excludes customer, inactive, unsupported-currency and nonmatching rows", async () => {
    local({ name: "Books unrelated local" });
    const { transport, fetcher } = connection(page([
      contact(), contact({ contact_id: "2002", contact_type: "customer" }), contact({ contact_id: "2003", status: "inactive" }),
      contact({ contact_id: "2004", currency_code: "JPY" }), contact({ contact_id: "2005", contact_name: "Unrelated supplier" }),
    ]));
    const result = await searchBillVendors(actor, { companyId: "company-a", q: "Books" }, transport);
    expect(result).toMatchObject({ companyId: "company-a", organizationId: "1001", selectedVendor: null, warning: null, hasMore: false });
    expect(result.vendors).toHaveLength(1);
    expect(result.vendors[0]).toMatchObject({ id: null, name: "Books supplier", externalVendorId: "2001", ...destination });
    const query = new URL(fetcher.mock.calls[0][0]).searchParams;
    expect(Object.fromEntries(query)).toEqual({ contact_type: "vendor", contact_name_contains: "Books", per_page: "25", page: "1", organization_id: "1001" });
    expect(query.has("filter_by")).toBe(false);
    expect(JSON.stringify(result)).not.toContain("PRIVATE ADDRESS");
    expect(store.vendor.create).not.toHaveBeenCalled();
  });

  it("company B cannot see company A suggestions or use its provider connection", async () => {
    mapped(local({ name: "A supplier" }));
    const result = await searchBillVendors(actor, { companyId: "company-b" }, connection(page([contact({ contact_name: "B supplier" })]), "1002").transport);
    expect(result.vendors).toMatchObject([{ companyId: "company-b", organizationId: "1002", name: "B supplier", id: null }]);
    const wrong = connection(page([contact()]));
    const mismatched = await searchBillVendors(actor, { companyId: "company-b" }, wrong.transport);
    expect(mismatched.vendors).toEqual([]);
    expect(mismatched.warning).toBeTruthy();
    expect(wrong.fetcher).not.toHaveBeenCalled();
  });

  it("adds explicitly local draft suppliers on provider failure without weakening mapped destination isolation", async () => {
    mapped(local({ name: "Correct linked supplier" }));
    local({ name: "Unmapped local" });
    mapped(local({ name: "Wrong destination" }), { externalVendorId: "2002", organizationId: "1002" });
    const result = await searchBillVendors(actor, { companyId: "company-a" }, connection({ error: "PRIVATE PROVIDER RESPONSE" }).transport);
    expect(result.vendors.map(item => item.name)).toEqual(["Correct linked supplier", "Unmapped local"]);
    expect(result.vendors[0]).toMatchObject(destination);
    expect(result.vendors[1]).toMatchObject({ companyId: "company-a", booksMappingRequired: true });
    expect(result.vendors[1]).not.toHaveProperty("externalVendorId");
    expect(result.vendors[1]).not.toHaveProperty("organizationId");
    expect(result.warning).toContain("need a Books mapping before sync");
    expect(JSON.stringify(result)).not.toContain("PRIVATE PROVIDER RESPONSE");
  });

  it("deduplicates exact mapped/provider identities and drops mapped vendors the provider identifies as inactive", async () => {
    const saved = local({ name: "Books supplier" }); mapped(saved);
    mapped(local({ name: "Inactive supplier" }), { externalVendorId: "2002" });
    const result = await searchBillVendors(actor, { companyId: "company-a" }, connection(page([contact(), contact({ contact_id: "2002", status: "inactive" })])).transport);
    expect(result.vendors).toHaveLength(1);
    expect(result.vendors[0].id).toBe(saved.id);
  });

  it("hydrates an exact-company existing unmapped vendor without a provider request", async () => {
    const saved = local({ name: "Historical supplier" });
    const { transport, fetcher } = connection(page([]));
    const result = await searchBillVendors(actor, { companyId: "company-a", vendorId: saved.id }, transport);
    expect(result.selectedVendor).toEqual(localView(saved));
    expect(result.vendors).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(searchBillVendors(actor, { companyId: "company-b", vendorId: saved.id }, transport)).rejects.toMatchObject({ status: 404 });
  });

  it("keeps no-destination companies on the scoped local database without requiring provider configuration", async () => {
    destinations = [];
    vi.stubEnv("ZOHO_BOOKS_ORGANIZATIONS_JSON", "invalid-private-config");
    local({ name: "A supplier" }); local({ companyId: "company-b", name: "B supplier" });
    const result = await searchBillVendors(actor, { companyId: "company-a" });
    expect(result.organizationId).toBeNull();
    expect(result.vendors.map(item => item.name)).toEqual(["A supplier"]);
    expect(result.warning).toBeNull();
    expect(result.vendors[0].externalVendorId).toBeUndefined();
  });

  it("preserves scoped local vendors for an unconfigured demo sandbox placeholder", async () => {
    destinations[0] = { companyId: "company-a", ...destination, organizationId: "7777", environment: "sandbox" };
    const saved = local({ name: "Local demo supplier" });
    local({ companyId: "company-b", name: "Another company's local supplier" });
    const { transport, fetcher } = connection(page([contact()]));
    const result = await searchBillVendors(actor, { companyId: "company-a" }, transport);
    expect(result.organizationId).toBeNull();
    expect(result.vendors).toEqual([localView(saved)]);
    expect(result.warning).toContain("not configured");
    expect(fetcher).not.toHaveBeenCalled();
    expect(store.vendorBooksMapping.findMany).not.toHaveBeenCalled();
  });

  it("supports a legacy demo sandbox company when no Books organization catalog exists", async () => {
    destinations[0].environment = "sandbox";
    vi.stubEnv("ZOHO_BOOKS_ORGANIZATIONS_JSON", "");
    vi.stubEnv("ZOHO_BOOKS_ORGANIZATION_ID", "");
    const saved = local();
    const result = await searchBillVendors(actor, { companyId: "company-a" });
    expect(result.vendors).toEqual([localView(saved)]); expect(result.organizationId).toBeNull();
  });

  it("rejects local fallback results if a matching profile is configured during the search", async () => {
    destinations[0] = { companyId: "company-a", ...destination, organizationId: "7777", environment: "sandbox" };
    const saved = local();
    store.vendor.findMany.mockImplementationOnce(async () => {
      // Global environment is still production, so getConfig remains mismatched/null.
      vi.stubEnv("ZOHO_BOOKS_ORGANIZATIONS_JSON", JSON.stringify([{ organizationId: "7777", name: "Newly configured profile" }]));
      return [localView(saved)];
    });
    await expect(searchBillVendors(actor, { companyId: "company-a" })).rejects.toMatchObject({ status: 409 });
  });

  it.each(["production", "non-demo", "configured", "invalid-catalog"])("keeps the %s destination while allowing explicitly unmapped local drafts", async mode => {
    destinations[0] = { companyId: "company-a", ...destination, organizationId: "7777", environment: "sandbox" };
    if (mode === "production") destinations[0].environment = "production";
    if (mode === "non-demo") companies[0].isDemo = false;
    if (mode === "configured") {
      destinations[0].organizationId = "1001";
      vi.stubEnv("ZOHO_BOOKS_CLIENT_SECRET", "");
    }
    if (mode === "invalid-catalog") vi.stubEnv("ZOHO_BOOKS_ORGANIZATIONS_JSON", "private-invalid-config");
    local({ name: "Unmapped local" });
    const result = await searchBillVendors(actor, { companyId: "company-a" });
    expect(result.vendors).toMatchObject([{ name: "Unmapped local", booksMappingRequired: true }]);
    expect(result.vendors[0]).not.toHaveProperty("externalVendorId");
    expect(result.organizationId).toBe(destinations[0].organizationId);
    expect(result.warning).not.toContain("not configured for this demo");
  });

  it("preserves linked-local fallback when networking is disabled and never guesses multiple destinations", async () => {
    mapped();
    vi.stubEnv("ZOHO_BOOKS_NETWORK_ENABLED", "false");
    const disabled = await searchBillVendors(actor, { companyId: "company-a" });
    expect(disabled.vendors).toHaveLength(1); expect(disabled.warning).toBeTruthy();
    destinations.push({ companyId: "company-a", ...destination, organizationId: "1002" });
    const ambiguous = await searchBillVendors(actor, { companyId: "company-a" });
    expect(ambiguous.organizationId).toBeNull(); expect(ambiguous.vendors).toEqual([]); expect(ambiguous.warning).toContain("multiple");
  });

  it("allows exact-company unmapped drafts offline, excluding foreign companies, legacy external IDs and other Books mappings", async () => {
    companies[0].isDemo = false;
    const own = local({ name: "Local TEST supplier", isDemo: false });
    local({ companyId: "company-b", name: "Local TEST foreign supplier" });
    local({ name: "Local TEST legacy ID", externalZohoId: "4001" });
    mapped(local({ name: "Local TEST other organization" }), { organizationId: "1002", externalVendorId: "4002" });
    mapped(local({ name: "Local TEST other data center" }), { dataCenter: "EU", externalVendorId: "4003" });
    mapped(local({ name: "Local TEST sandbox" }), { environment: "sandbox", externalVendorId: "4004" });
    vi.stubEnv("ZOHO_BOOKS_NETWORK_ENABLED", "false");
    const { transport, fetcher } = connection(page([contact()]));
    const result = await searchBillVendors(actor, { companyId: "company-a", q: "Local TEST" }, transport);
    expect(result.vendors).toEqual([{ ...localView(own), booksMappingRequired: true }]);
    expect(result.organizationId).toBe("1001");
    expect(fetcher).not.toHaveBeenCalled();
    expect(store.vendor.create).not.toHaveBeenCalled();
    expect(store.vendorBooksMapping.create).not.toHaveBeenCalled();
    expect(store.auditLog.create).not.toHaveBeenCalled();
    const hydrated = await searchBillVendors(actor, { companyId: "company-a", vendorId: own.id }, transport);
    expect(hydrated.selectedVendor).toEqual(localView(own));
  });

  it("bounds offline local suggestions and rechecks membership after reading them", async () => {
    vi.stubEnv("ZOHO_BOOKS_NETWORK_ENABLED", "false");
    for (let index = 0; index < 26; index++) local({ name: `Local offline ${index}` });
    const result = await searchBillVendors(actor, { companyId: "company-a", q: "Local offline" });
    expect(result.vendors).toHaveLength(25);
    expect(result.hasMore).toBe(true);
    store.vendor.findMany.mockImplementationOnce(async () => { authorized = false; return vendors.map(localView); });
    await expect(searchBillVendors(actor, { companyId: "company-a" })).rejects.toMatchObject({ status: 403 });
  });

  it("treats wildcard characters literally in SQL and filters provider results by the actual substring", async () => {
    destinations = [];
    local({ name: "100%_\\ supplier" }); local({ name: "100 other supplier" });
    const localResult = await searchBillVendors(actor, { companyId: "company-a", q: "%_\\" });
    expect(localResult.vendors).toHaveLength(1);
    expect(store.vendor.findMany.mock.calls[0][0].where.name.contains).toBe("\\%\\_\\\\");
    destinations = [{ companyId: "company-a", ...destination }];
    const providerResult = await searchBillVendors(actor, { companyId: "company-a", q: "%" }, connection(page([contact({ contact_name: "100% supplier" }), contact({ contact_id: "2002", contact_name: "100 other supplier" })])).transport);
    expect(providerResult.vendors.map(item => item.name)).toEqual(["100% supplier"]);
  });

  it("bounds results and pagination, and returns a fixed warning for unexpected provider shape", async () => {
    const result = await searchBillVendors(actor, { companyId: "company-a" }, connection(page(Array.from({ length: 26 }, (_, index) => contact({ contact_id: String(3000 + index) })))).transport);
    expect(result.vendors).toHaveLength(25); expect(result.hasMore).toBe(true);
    const bad = await searchBillVendors(actor, { companyId: "company-a" }, connection({ ...page([]), page_context: { page: 2, has_more_page: false } }).transport);
    expect(bad.vendors).toEqual([]); expect(bad.warning).toBeTruthy();
  });

  it("rejects duplicate IDs and oversized pages with a fixed warning", async () => {
    for (const contacts of [[contact(), contact()], Array.from({ length: 201 }, (_, index) => contact({ contact_id: String(3000 + index) }))]) {
      const result = await searchBillVendors(actor, { companyId: "company-a" }, connection(page(contacts)).transport);
      expect(result.vendors).toEqual([]); expect(result.warning).toBeTruthy();
    }
  });

  it("checks strict inputs, current writer access and post-request revocation", async () => {
    await expect(searchBillVendors(actor, { companyId: "company-a", q: "x".repeat(101), vendorId: "old" })).rejects.toThrow();
    await expect(searchBillVendors(actor, { companyId: "company-a", organizationId: "1002" })).rejects.toThrow();
    expect(store.user.findFirst).not.toHaveBeenCalled();
    await expect(searchBillVendors({ ...actor, role: "MANAGEMENT" }, { companyId: "company-a" })).rejects.toMatchObject({ status: 403 });
    await expect(searchBillVendors(actor, { companyId: "company-a" }, connection(page([contact()]), "1001", () => { authorized = false; }).transport)).rejects.toMatchObject({ status: 403 });
  });
});

describe("resolving an existing Books supplier for bill entry", () => {
  it("allows a current Data Entry user to select a provider vendor without promoting demo provenance or enabling writes", async () => {
    const { transport, fetcher } = connection({ code: 0, contact: contact() });
    const result = await resolveBillVendor(actor, selection, transport);
    expect(result).toMatchObject({ companyId: "company-a", name: "Books supplier", currency: "AED", email: "supplier@example.invalid", trn: "100000000000001" });
    expect(vendors[0].isDemo).toBe(true);
    expect(mappings[0]).toMatchObject({ vendorId: result.id, externalVendorId: "2001", ...destination });
    expect(audit).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(process.env.ZOHO_BOOKS_WRITE_ENABLED).toBe("false");
    expect(JSON.stringify(vendors)).not.toContain("PRIVATE ADDRESS");
  });

  it("reuses exact scoped mapping without changing saved names, email, TRN or IDs", async () => {
    const saved = local({ name: "Reviewed existing name", email: "saved@example.invalid", trn: "old-reviewed-trn" }); mapped(saved);
    const result = await resolveBillVendor(actor, selection, connection({ code: 0, contact: contact() }).transport);
    expect(result).toEqual(localView(saved));
    expect(store.vendor.create).not.toHaveBeenCalled(); expect(audit).toHaveLength(0);
  });

  it("repeated resolution creates no duplicate local identity or mapping", async () => {
    const first = await resolveBillVendor(actor, selection, connection({ code: 0, contact: contact() }).transport);
    const second = await resolveBillVendor(actor, selection, connection({ code: 0, contact: contact() }).transport);
    expect(second.id).toBe(first.id); expect(vendors).toHaveLength(1); expect(mappings).toHaveLength(1); expect(audit).toHaveLength(1);
  });

  it.each(["company", "organization", "dc", "environment", "missing-dc", "override"])("rejects mismatched or malformed %s selection before provider reads", async mode => {
    const payload: Record<string, unknown> = { ...selection };
    if (mode === "company") payload.companyId = "company-b";
    if (mode === "organization") payload.organizationId = "1002";
    if (mode === "dc") payload.dataCenter = "AE";
    if (mode === "environment") payload.environment = "sandbox";
    if (mode === "missing-dc") delete payload.dataCenter;
    if (mode === "override") payload.name = "Client-invented supplier";
    const { transport, fetcher } = connection({ code: 0, contact: contact() });
    await expect(resolveBillVendor(actor, payload, transport)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled(); expect(vendors).toHaveLength(0);
  });

  it.each(["customer", "inactive", "wrong-id", "currency", "malformed"])("refuses %s provider identity without local mutations", async mode => {
    const row = contact();
    if (mode === "customer") row.contact_type = "customer";
    if (mode === "inactive") row.status = "inactive";
    if (mode === "wrong-id") row.contact_id = "2002";
    if (mode === "currency") row.currency_code = "JPY";
    await expect(resolveBillVendor(actor, selection, connection(mode === "malformed" ? { code: 0 } : { code: 0, contact: row }).transport)).rejects.toMatchObject({ code: "BOOKS_VENDOR_INVALID" });
    expect(store.$transaction).not.toHaveBeenCalled(); expect(vendors).toHaveLength(0);
  });

  it.each(["name", "trn", "legacy-id", "cross-company-mapping", "mapping-currency"])("preserves conflicting %s records instead of merging or duplicating", async mode => {
    if (mode === "name") local({ name: "Books supplier" });
    if (mode === "trn") local({ trn: "100000000000001" });
    if (mode === "legacy-id") local({ externalZohoId: "2001" });
    if (mode === "cross-company-mapping") mapped(local({ companyId: "company-b" }));
    if (mode === "mapping-currency") mapped(local({ currency: "USD" }));
    const before = structuredClone({ vendors, mappings });
    await expect(resolveBillVendor(actor, selection, connection({ code: 0, contact: contact() }).transport)).rejects.toMatchObject({ status: 409 });
    expect({ vendors, mappings }).toEqual(before); expect(audit).toHaveLength(0);
  });

  it("drops invalid optional email/TRN metadata while retaining verified supplier identity", async () => {
    const result = await resolveBillVendor(actor, selection, connection({ code: 0, contact: contact({ email: "not-an-email", tax_reg_no: { private: true } }) }).transport);
    expect(result.email).toBeNull(); expect(result.trn).toBeNull();
  });

  it.each(["actor", "destination", "config"])("rejects %s changed during provider lookup", async mode => {
    const { transport } = connection({ code: 0, contact: contact() }, "1001", () => {
      if (mode === "actor") authorized = false;
      if (mode === "destination") destinations[0].organizationId = "1002";
      if (mode === "config") vi.stubEnv("ZOHO_BOOKS_CLIENT_SECRET", "changed-fixture-secret");
    });
    await expect(resolveBillVendor(actor, selection, transport)).rejects.toThrow();
    expect(vendors).toHaveLength(0); expect(mappings).toHaveLength(0);
  });

  it("rolls back local vendor creation when mapping insertion collides", async () => {
    store.vendorBooksMapping.create.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("fictional collision", { code: "P2002", clientVersion: "fixture" }));
    await expect(resolveBillVendor(actor, selection, connection({ code: 0, contact: contact() }).transport)).rejects.toMatchObject({ status: 409 });
    expect(vendors).toHaveLength(0); expect(mappings).toHaveLength(0); expect(audit).toHaveLength(0);
  });

  it("rechecks current access inside the transaction and rolls back if it changes before commit", async () => {
    store.auditLog.create.mockImplementationOnce(async () => { authorized = false; return {}; });
    await expect(resolveBillVendor(actor, selection, connection({ code: 0, contact: contact() }).transport)).rejects.toMatchObject({ status: 403 });
    expect(vendors).toHaveLength(0); expect(mappings).toHaveLength(0); expect(audit).toHaveLength(0);
    expect(store.user.findFirst.mock.calls[0][0].where).toMatchObject({ id: actor.id, active: true, role: { in: ["ADMIN", "ACCOUNTS", "DATA_ENTRY"] }, memberships: { some: { companyId: "company-a", active: true } } });
  });
});
