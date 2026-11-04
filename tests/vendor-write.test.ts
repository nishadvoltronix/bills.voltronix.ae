import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ZohoConfig } from "@/lib/integrations/config";
import type { LocalLiveTestWriteCapability } from "@/lib/integrations/local-live-test";
const state = vi.hoisted(() => ({ config: null as ZohoConfig | null, job: {} as Record<string, unknown>, vendor: {} as Record<string, unknown>,
  actor: true, revoked: false, validLease: true, fingerprint: "", mappings: [] as { organizationId: string; dataCenter: string; environment: string }[] }));
vi.mock("@/lib/integrations/config", async original => ({ ...(await original<typeof import("@/lib/integrations/config")>()), getConfig: () => state.config }));
vi.mock("@/lib/db", () => ({ db: {
  vendorBooksSync: { findUnique: async () => state.job, findFirst: async () => state.validLease ? { id: "job" } : null },
  user: { findFirst: async () => state.actor ? { id: "actor" } : null }, vendor: { findUnique: async () => state.vendor },
  company: { findUnique: async () => ({ active: true, isDemo: false, liveAccountingEnabled: true }) },
  companyIntegrationDestination: { findFirst: async () => ({ liveEnabled: true, verifiedAt: new Date(0), verificationReference: "Fictional verified destination", verifiedConfigurationHash: booksConfigurationHash(state.config!) }) },
  integrationCredential: { findUnique: async () => ({ revokedAt: state.revoked ? new Date() : null, connectionFingerprint: state.fingerprint }) },
  vendorBooksMapping: { findMany: async () => state.mappings },
} }));
import { booksConfigurationHash } from "@/lib/integrations/config";
import { connectionFingerprint } from "@/lib/integrations/connection-fingerprint";
import { ZohoTransport, type Fetch } from "@/lib/integrations/transport";
import { vendorContactCapability, vendorSnapshotHash, type VendorContactWriteCapability } from "@/lib/integrations/vendor-write";

const payload = { contact_name: "Fictional supplier", contact_type: "vendor", currency_id: "101", tax_treatment: "vat_not_registered", is_portal_enabled: false,
  notes: `Created from fictional fixture. Reference: VX-VENDOR-${"a".repeat(40)}` };
beforeEach(() => {
  state.config = { target: "ZOHO", organizationId: "100", dataCenter: "US", environment: "production", liveRuntime: true,
    clientId: "fictional-client", clientSecret: "fictional-secret", apiOrigin: "https://www.zohoapis.com", accountsOrigin: "https://accounts.zoho.com",
    networkEnabled: true, writeEnabled: true, booksMapping: { verified: true, baseCurrency: "AED", currencies: { AED: { id: "101" } }, taxes: {}, categories: {} } };
  state.fingerprint = connectionFingerprint(state.config); state.actor = true; state.revoked = false; state.validLease = true; state.mappings = [];
  state.vendor = { id: "vendor", companyId: "company", name: "Fictional supplier", currency: "AED", email: null, trn: null, isDemo: false, externalZohoId: null };
  const snapshot = { vendor: state.vendor, destination: { organizationId: "100", dataCenter: "US", environment: "production",
    connectionFingerprint: state.fingerprint, configurationHash: booksConfigurationHash(state.config) }, marker: `VX-VENDOR-${"a".repeat(40)}`, payload };
  state.job = { id: "job", vendorId: "vendor", companyId: "company", organizationId: "100", dataCenter: "US", environment: "production", initiatedById: "actor",
    status: "PROCESSING", leaseToken: "lease", leaseUntil: new Date(Date.now() + 60_000), submittedAt: new Date(), externalVendorId: null,
    sourceHash: vendorSnapshotHash(snapshot), snapshot };
});
function transport(capability?: VendorContactWriteCapability, token = async () => "fictional-token", loseResponse = false) {
  const fetcher = vi.fn<Fetch>(async (url, options) => {
    if (options?.method === "POST") {
      expect(new URL(url).pathname).toBe("/books/v3/contacts");
      if (loseResponse) throw new Error("Fictional provider interruption");
      return Response.json({ code: 0 });
    }
    return Response.json({ code: 0, organization: { organization_id: "100", is_org_active: true, currency_code: "AED", currency_id: "101" } });
  });
  return { fetcher, client: new ZohoTransport(state.config!, token, fetcher, async () => undefined, undefined, capability) };
}

describe("opaque supplier contact write authority", () => {
  it("keeps contacts closed on the default transport even with an arbitrary production callback", async () => {
    const f = transport();
    await expect(f.client.request("/books/v3/contacts", { method: "POST", body: payload })).rejects.toMatchObject({ code: "INVALID_WRITE_ENDPOINT" });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("rejects a serialized or fabricated capability and never broadens it to bill/customer operations", async () => {
    const fake = transport({} as VendorContactWriteCapability);
    await expect(fake.client.request("/books/v3/contacts", { method: "POST", body: payload })).rejects.toMatchObject({ code: "VENDOR_WRITE_PERMISSION_REQUIRED" });
    expect(fake.fetcher).not.toHaveBeenCalled();
    for (const request of [{ path: "/books/v3/bills", body: payload }, { path: "/books/v3/contacts", body: { ...payload, contact_type: "customer" } },
      { path: "/books/v3/contacts", body: { ...payload, unexpected: true } }]) {
      const f = transport(vendorContactCapability("job", "lease"));
      await expect(f.client.request(request.path, { method: "POST", body: request.body })).rejects.toMatchObject({ code: "VENDOR_WRITE_PERMISSION_REQUIRED" });
      expect(f.fetcher).not.toHaveBeenCalled();
    }
  });
  it.each([false, true])("consumes exactly one contact send, including interrupted outcome=%s", async interrupted => {
    const f = transport(vendorContactCapability("job", "lease"), undefined, interrupted);
    const request = () => f.client.request("/books/v3/contacts", { method: "POST", body: payload });
    if (interrupted) await expect(request()).rejects.toMatchObject({ code: "REQUEST_INTERRUPTED", kind: "UNKNOWN" });
    else await expect(request()).resolves.toEqual({ code: 0 });
    await expect(request()).rejects.toMatchObject({ code: "VENDOR_WRITE_PERMISSION_REQUIRED" });
    expect(f.fetcher.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
  });
  it.each(["actor", "source", "lease", "grant", "destination", "body", "legacy", "mapping"])("denies changed %s before any provider send", async change => {
    if (change === "actor") state.actor = false;
    if (change === "source") state.vendor = { ...state.vendor, currency: "USD" };
    if (change === "lease") state.validLease = false;
    if (change === "grant") state.revoked = true;
    if (change === "destination") state.config = { ...state.config!, environment: "sandbox" };
    if (change === "legacy") state.vendor = { ...state.vendor, externalZohoId: "880001" };
    if (change === "mapping") state.mappings = [{ organizationId: "200", dataCenter: "US", environment: "production" }];
    const f = transport(vendorContactCapability("job", "lease"));
    await expect(f.client.request("/books/v3/contacts", { method: "POST", body: change === "body" ? { ...payload, contact_name: "Changed supplier" } : payload }))
      .rejects.toMatchObject({ code: "VENDOR_WRITE_PERMISSION_REQUIRED" });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("rechecks grant revocation after token retrieval and cannot be combined with a one-bill capability", async () => {
    let calls = 0;
    const f = transport(vendorContactCapability("job", "lease"), async () => { if (++calls === 2) state.revoked = true; return "fictional"; });
    await expect(f.client.request("/books/v3/contacts", { method: "POST", body: payload })).rejects.toMatchObject({ code: "VENDOR_WRITE_PERMISSION_REQUIRED" });
    expect(f.fetcher.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(0);
    const both = new ZohoTransport(state.config!, async () => "fictional", f.fetcher, undefined,
      { kind: "LOCAL_ONE_BILL_TEST" } as LocalLiveTestWriteCapability, vendorContactCapability("job", "lease"));
    await expect(both.request("/books/v3/contacts", { method: "POST", body: payload })).rejects.toMatchObject({ code: "INVALID_WRITE_ENDPOINT" });
  });
});
