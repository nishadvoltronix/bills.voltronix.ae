import { beforeEach, describe, expect, it, vi } from "vitest";
const permission = vi.hoisted(() => ({ capability: Object.freeze({ kind: "LOCAL_ONE_BILL_TEST" as const }), validate: vi.fn(), active: true }));
vi.mock("@/lib/integrations/local-live-test", () => ({ assertLocalLiveTestWriteCapability: permission.validate }));
import { assertWrite, getConfig, IntegrationError } from "@/lib/integrations/config";
import { BooksAdapter, buildBooksPayload, type BillSnapshot } from "@/lib/integrations/books";
import { ZohoTransport, type Fetch, type ProductionWriteRequest } from "@/lib/integrations/transport";

const config = () => getConfig("ZOHO", { NODE_ENV: "development", APP_ENV: "development", APP_URL: "http://127.0.0.1:3000",
  DATABASE_URL: "mysql://fictional:unusable@127.0.0.1:3308/voltronix_billing_dev", INTEGRATION_NETWORK_ENABLED: "true",
  ZOHO_BOOKS_WRITE_ENABLED: "false", ZOHO_BOOKS_LIVE_ENABLED: "false", ALLOW_PRODUCTION_ACCOUNTING_WRITES: "false",
  INTEGRATION_TEST_MODE: "false", ZOHO_BOOKS_DC: "US", ZOHO_BOOKS_ENVIRONMENT: "production", ZOHO_BOOKS_ORGANIZATION_ID: "100",
  ZOHO_BOOKS_CLIENT_ID: "fictional", ZOHO_BOOKS_CLIENT_SECRET: "fictional",
  ZOHO_BOOKS_MAPPING_JSON: JSON.stringify({ verified: true, baseCurrency: "AED", currencies: { AED: { id: "101" } },
    taxes: { "0.00": { id: "102", percentage: "0" } }, categories: { MATERIALS: { accountId: "103" } } }) });
const snapshot: BillSnapshot = { internalBillId: "fictional-local-bill", companyId: "fictional-company", sourceVersion: 2,
  destination: { dataCenter: "US", environment: "production", liveAuthorizationId: "fictional-permission", authorizationReference: `LOCAL_ONE_BILL_TEST:${"a".repeat(64)}` },
  invoiceNumber: "FICTIONAL-LOCAL-ONE", invoiceDate: "2026-10-30", dueDate: null, orderNumber: null, paymentTerms: "DUE_ON_RECEIPT",
  category: "MATERIALS", currency: "AED", discount: "0.00", vatRate: "0.00", subtotal: "1.00", vatAmount: "0.00", total: "1.00",
  vendorId: "fictional-vendor", externalVendorId: "104", jobId: "fictional-job", jobNumber: "JOB-FICTIONAL", externalCrmJobId: "200",
  lines: [{ description: "FICTIONAL TEST DATA", quantity: "1", unitPrice: "1.00" }], documents: [] };
const body = () => buildBooksPayload(snapshot, config());
const organization = { organization_id: "100", is_org_active: true, currency_code: "AED", currency_id: "101" };
const json = (value: unknown, quota?: string, status = 200) => Response.json(value, { status,
  headers: quota === undefined ? {} : { "x-rate-limit-remaining": quota } });
const rejected = () => new IntegrationError("LOCAL_TEST_PERMISSION_REQUIRED", "Fictional exact lease/permission rejected.", "BLOCKED");
beforeEach(() => {
  permission.active = true;
  permission.validate.mockReset().mockImplementation(async (capability, settings, request?: ProductionWriteRequest) => {
    if (capability !== permission.capability || !permission.active || settings.organizationId !== "100" || settings.environment !== "production") throw rejected();
    if (request && (request.path !== "/books/v3/bills" || request.form || JSON.stringify(request.body) !== JSON.stringify(body()))) throw rejected();
  });
});

describe("capability-scoped local Books transport with fake providers only", () => {
  it("keeps ordinary writes disabled even with an arbitrary production callback", async () => {
    const fetcher = vi.fn<Fetch>(), guard = vi.fn(async () => undefined), settings = config();
    expect(() => assertWrite(settings)).toThrowError(expect.objectContaining({ code: "WRITES_DISABLED" }));
    await expect(new ZohoTransport(settings, async () => "fictional", fetcher, guard).request("/books/v3/bills", { method: "POST", body: body() }))
      .rejects.toMatchObject({ code: "WRITES_DISABLED" });
    expect(fetcher).not.toHaveBeenCalled(); expect(guard).not.toHaveBeenCalled(); expect(permission.validate).not.toHaveBeenCalled();
  });

  it("requires the trusted capability and the normal job/lease callback together", async () => {
    const fetcher = vi.fn<Fetch>();
    await expect(new ZohoTransport(config(), async () => "fictional", fetcher, async () => undefined,
      { kind: "LOCAL_ONE_BILL_TEST" }).request("/books/v3/bills", { method: "POST", body: body() })).rejects.toMatchObject({ code: "LOCAL_TEST_PERMISSION_REQUIRED" });
    await expect(new ZohoTransport(config(), async () => "fictional", fetcher, undefined, permission.capability)
      .request("/books/v3/bills", { method: "POST", body: body() })).rejects.toMatchObject({ code: "LIVE_PERMISSION_REQUIRED" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([undefined, "-8", "-0", "0", "9", "garbage", "2.5", "1e3", "9007199254740993"])(
    "blocks a financial POST when successful organization metadata reports unsafe quota %s", async (quota) => {
      const fetcher = vi.fn<Fetch>(async (_url, init) => {
        expect(init?.method).toBe("GET");
        return json({ code: 0, organization }, quota);
      });
      const token = vi.fn(async () => "fictional-token");
      await expect(new ZohoTransport(config(), token, fetcher, async () => undefined, permission.capability)
        .request("/books/v3/bills", { method: "POST", body: body() })).rejects.toMatchObject({ code: "LOCAL_TEST_QUOTA_REQUIRED", kind: "BLOCKED" });
      expect(fetcher).toHaveBeenCalledTimes(1); expect(token).toHaveBeenCalledTimes(1);
    });

  it("uses an already observed negative quota to block before another provider preflight", async () => {
    const fetcher = vi.fn<Fetch>(async () => json({ code: 0, bills: [] }, "-8"));
    const transport = new ZohoTransport(config(), async () => "fictional", fetcher, async () => undefined, permission.capability);
    await transport.request("/books/v3/bills");
    await expect(transport.request("/books/v3/bills", { method: "POST", body: body() })).rejects.toMatchObject({ code: "LOCAL_TEST_QUOTA_REQUIRED" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rechecks capability and the lease callback after token acquisition, with flags still false", async () => {
    const settings = config();
    const fetcher = vi.fn<Fetch>(async (_url, init) => init?.method === "POST"
      ? json({ code: 0, bill: { bill_id: "900" } }, "9") : json({ code: 0, organization }, "+10"));
    const guard = vi.fn(async () => undefined), token = vi.fn(async () => "fictional-token");
    await new ZohoTransport(settings, token, fetcher, guard, permission.capability)
      .request("/books/v3/bills", { method: "POST", body: body() });
    expect(guard).toHaveBeenCalledTimes(2); expect(permission.validate).toHaveBeenCalledTimes(2);
    expect(token).toHaveBeenCalledTimes(2); expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(settings.writeEnabled).toBe(false); expect(settings.liveRuntime).toBe(false);
  });

  it.each(["capability", "lease"])("stops before POST when %s is revoked during token refresh", async (mode) => {
    const fetcher = vi.fn<Fetch>(async () => json({ code: 0, organization }, "100"));
    let tokenCalls = 0, held = true;
    const token = async () => { if (++tokenCalls === 2) { if (mode === "capability") permission.active = false; else held = false; } return "fictional"; };
    const guard = async () => { if (!held) throw rejected(); };
    await expect(new ZohoTransport(config(), token, fetcher, guard, permission.capability).request("/books/v3/bills", { method: "POST", body: body() }))
      .rejects.toMatchObject({ code: "LOCAL_TEST_PERMISSION_REQUIRED" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rechecks quota if another read exhausts it while the write token is acquired", async () => {
    const fetcher = vi.fn<Fetch>(async (url, init) => {
      expect(init?.method).toBe("GET");
      return new URL(url).pathname.includes("organizations")
        ? json({ code: 0, organization }, "100") : json({ code: 0, bills: [] }, "-8");
    });
    let tokens = 0;
    const token = async (): Promise<string> => { if (++tokens === 2) await transport.request("/books/v3/bills"); return "fictional"; };
    const transport = new ZohoTransport(config(), token, fetcher, async () => undefined, permission.capability);
    await expect(transport.request("/books/v3/bills", { method: "POST", body: body() })).rejects.toMatchObject({ code: "LOCAL_TEST_QUOTA_REQUIRED" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects payload changes during token acquisition and never authorizes another endpoint", async () => {
    const outgoing = body();
    let tokens = 0;
    const fetcher = vi.fn<Fetch>(async () => json({ code: 0, organization }, "100"));
    const token = async () => { if (++tokens === 2) outgoing.bill_number = "ALTERED"; return "fictional"; };
    const transport = new ZohoTransport(config(), token, fetcher, async () => undefined, permission.capability);
    await expect(transport.request("/books/v3/bills", { method: "POST", body: outgoing })).rejects.toMatchObject({ code: "LOCAL_TEST_PERMISSION_REQUIRED" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(transport.request("/books/v3/vendorpayments", { method: "POST", body: body() })).rejects.toMatchObject({ code: "LOCAL_TEST_PERMISSION_REQUIRED" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("creates and confirms exactly one bill, retaining zero-quota success bodies and idempotent reconciliation", async () => {
    let created = false;
    const fetcher = vi.fn<Fetch>(async (url, init) => {
      const pathname = new URL(url).pathname;
      if (init?.method === "POST") { created = true; return json({ code: 0, bill: { bill_id: "900" } }, "0"); }
      if (pathname === "/books/v3/organizations/100") return json({ code: 0, organization }, "100");
      if (pathname === "/books/v3/contacts/104") return json({ code: 0, contact: { contact_id: "104", contact_type: "vendor", currency_code: "AED", status: "active" } }, "100");
      if (pathname === "/books/v3/bills") return json({ code: 0, bills: created ? [{ bill_id: "900", reference_number: `VX-BILL-${snapshot.internalBillId}` }] : [],
        page_context: { has_more_page: false } }, created ? "0" : "100");
      if (pathname === "/books/v3/bills/900") return json({ code: 0, bill: { bill_id: "900", vendor_id: "104", reference_number: `VX-BILL-${snapshot.internalBillId}`,
        bill_number: snapshot.invoiceNumber, currency_code: "AED", total: "1", tax_total: "0" } }, "0");
      throw new Error("Unexpected fake provider request");
    });
    const adapter = new BooksAdapter(new ZohoTransport(config(), async () => "fictional", fetcher, async () => undefined, permission.capability));
    expect(await adapter.create(snapshot)).toMatchObject({ externalId: "900" });
    expect(await adapter.create(snapshot)).toMatchObject({ externalId: "900" });
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    permission.active = false;
    expect(await adapter.reconcile(snapshot)).toMatchObject({ externalId: "900" });
    await expect(adapter.create(snapshot)).rejects.toMatchObject({ code: "LOCAL_TEST_PERMISSION_REQUIRED" });
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
});
