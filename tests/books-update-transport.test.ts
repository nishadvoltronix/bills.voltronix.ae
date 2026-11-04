import { describe, expect, it, vi } from "vitest";
import { IntegrationError, type ZohoConfig } from "@/lib/integrations/config";
import { ZohoTransport, type ProductionWriteGuard } from "@/lib/integrations/transport";

const config = (): ZohoConfig => ({
  target: "ZOHO", dataCenter: "US", accountsOrigin: "https://accounts.zoho.com", apiOrigin: "https://www.zohoapis.com",
  organizationId: "100", clientId: "fictional-client", clientSecret: "fictional-secret", environment: "production",
  networkEnabled: true, writeEnabled: true, liveRuntime: true,
  booksMapping: { verified: true, baseCurrency: "AED", currencies: { AED: { id: "101" } },
    categories: { MATERIALS: { accountId: "103" } }, taxes: { "5.00": { id: "102", percentage: "5" } } },
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const organization = { code: 0, organization: { organization_id: "100", is_org_active: true, currency_code: "AED", currency_id: "101" } };
const payload = { bill_number: "FICTIONAL-EDIT", line_items: [{ line_item_id: "9001", account_id: "103", quantity: 1, rate: 20 }] };
function harness(response: () => Response | Promise<Response> = () => json({ code: 0, bill: { bill_id: "999" } }), guard?: ProductionWriteGuard) {
  const settings = config(), requests: { method: string; path: string; organization: string | null; body: unknown }[] = [];
  const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input);
    requests.push({ method: init?.method ?? "GET", path: url.pathname, organization: url.searchParams.get("organization_id"), body: init?.body });
    return url.pathname === "/books/v3/organizations/100" ? json(organization) : response();
  });
  const checked = guard ?? vi.fn(async () => undefined);
  return { settings, requests, fetcher, guard: checked, transport: new ZohoTransport(settings, async () => "FICTIONAL-TOKEN-NEVER-LOG", fetcher, checked) };
}

describe("exact existing Books bill update transport", () => {
  it("sends one exact-ID PUT after organization and two fresh authority checks, without creating another bill", async () => {
    const { transport, requests, guard } = harness();
    await expect(transport.request("/books/v3/bills/999", { method: "PUT", body: payload })).resolves.toMatchObject({ code: 0 });
    expect(guard).toHaveBeenCalledTimes(2);
    expect(guard).toHaveBeenNthCalledWith(1, { path: "/books/v3/bills/999", method: "PUT", body: payload, form: undefined });
    expect(requests.map(row => [row.method, row.path, row.organization])).toEqual([
      ["GET", "/books/v3/organizations/100", "100"], ["PUT", "/books/v3/bills/999", "100"],
    ]);
    expect(JSON.parse(requests[1].body as string)).toEqual(payload);
  });

  it("requires a production source guard before any request", async () => {
    const fetcher = vi.fn();
    const transport = new ZohoTransport(config(), async () => "fictional", fetcher);
    await expect(transport.request("/books/v3/bills/999", { method: "PUT", body: payload })).rejects.toMatchObject({ code: "LIVE_PERMISSION_REQUIRED", kind: "BLOCKED" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["/books/v3/bills", "/books/v3/bills/999/attachment", "/books/v3/contacts/999", "/books/v3/vendorpayments/999"])("rejects an update outside the exact bill endpoint: %s", async endpoint => {
    const { transport, requests } = harness();
    await expect(transport.request(endpoint, { method: "PUT", body: payload })).rejects.toMatchObject({ code: "INVALID_WRITE_ENDPOINT", kind: "BLOCKED" });
    expect(requests).toEqual([]);
  });

  it("cannot override the organization or introduce a runtime DELETE method", async () => {
    const { transport, requests } = harness();
    await expect(transport.request("/books/v3/bills/999", { method: "PUT", query: { organization_id: "other" }, body: payload })).rejects.toMatchObject({ code: "INVALID_ENDPOINT" });
    await expect(transport.request("/books/v3/bills/999", { method: "DELETE" as "PUT", body: payload })).rejects.toMatchObject({ code: "INVALID_WRITE_ENDPOINT" });
    expect(requests).toEqual([]);
  });

  it("stops before PUT if authority is lost during organization/token work", async () => {
    let calls = 0;
    const { transport, requests } = harness(undefined, async () => {
      if (++calls === 2) throw new IntegrationError("STALE_EDIT_AUTHORITY", "Fictional authority changed", "BLOCKED");
    });
    await expect(transport.request("/books/v3/bills/999", { method: "PUT", body: payload })).rejects.toMatchObject({ code: "STALE_EDIT_AUTHORITY" });
    expect(requests.map(row => row.method)).toEqual(["GET"]);
  });

  it.each([408, 500, 502])("treats HTTP %s after PUT as uncertain and never retries or creates", async status => {
    const { transport, requests } = harness(() => json({ message: "PRIVATE PROVIDER PAYLOAD" }, status));
    const failure = await transport.request("/books/v3/bills/999", { method: "PUT", body: payload }).catch(error => error);
    expect(failure).toMatchObject({ code: "REMOTE_UNAVAILABLE", kind: "UNKNOWN" });
    expect(String(failure)).not.toContain("PRIVATE PROVIDER");
    expect(requests.filter(row => row.method !== "GET")).toHaveLength(1);
  });

  it.each([[400, "FAILED"], [401, "BLOCKED"], [403, "BLOCKED"], [404, "FAILED"], [429, "RETRY"]])("classifies definite HTTP %s without replay", async (status, kind) => {
    const { transport, requests } = harness(() => json({ code: 5 }, Number(status)));
    await expect(transport.request("/books/v3/bills/999", { method: "PUT", body: payload })).rejects.toMatchObject({ kind });
    expect(requests.filter(row => row.method === "PUT")).toHaveLength(1);
  });

  it("retains unknown outcome for disconnected or unreadable update responses", async () => {
    for (const response of [() => { throw new Error("secret-token-and-provider-body"); }, () => new Response("not JSON", { status: 200 })]) {
      const { transport, requests } = harness(response);
      const failure = await transport.request("/books/v3/bills/999", { method: "PUT", body: payload }).catch(error => error);
      expect(failure).toMatchObject({ kind: "UNKNOWN" });
      expect(String(failure)).not.toContain("secret-token");
      expect(requests.filter(row => row.method === "PUT")).toHaveLength(1);
    }
  });
});
