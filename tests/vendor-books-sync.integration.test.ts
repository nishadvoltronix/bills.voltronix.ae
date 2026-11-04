import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZohoConfig } from "@/lib/integrations/config";
import { db } from "@/lib/db";
import { assertMySqlTestDatabase } from "./company-fixtures";

const settings = vi.hoisted(() => ({ configs: new Map<string, ZohoConfig>() }));
vi.mock("@/lib/integrations/config", async original => ({
  ...(await original<typeof import("@/lib/integrations/config")>()),
  getConfig: (_target: string, _environment: unknown, organizationId: string) => {
    const value = settings.configs.get(organizationId);
    if (!value) throw new Error("Unknown fictional provider destination");
    return value;
  },
}));
import { booksConfigurationHash } from "@/lib/integrations/config";
import { connectionFingerprint } from "@/lib/integrations/connection-fingerprint";
import { ZohoTransport, type Fetch } from "@/lib/integrations/transport";
import { createVendorAndSync, synchronizeVendor, type VendorTransportFactory } from "@/lib/services/vendor-books-sync";

const tag = randomUUID().slice(0, 8);
let sequence = 0;
type Contact = { contact_id: string; contact_name: string; contact_type: "vendor"; currency_code: string; status: string;
  notes: string; tax_treatment: string; tax_reg_no?: string; email?: string; contact_persons?: { email: string }[] };
async function fixture() {
  const index = ++sequence, organizationId = `98${BigInt(`0x${tag}`).toString()}${index}`;
  const actor = await db.user.create({ data: { email: `vendor-sync-${tag}-${index}@example.invalid`, name: "Fictional supplier manager", role: "ACCOUNTS", passwordHash: "unusable-fixture" } });
  const company = await db.company.create({ data: { name: `Fictional supplier company ${tag}-${index}`, active: true, isDemo: false,
    liveAccountingEnabled: true, memberships: { create: { userId: actor.id } } } });
  // Only provider configuration is mocked. The guarded disposable database URL,
  // APP_ENV, server UUID and real company/source/lease checks are retained.
  const config: ZohoConfig = { target: "ZOHO", organizationId, dataCenter: "US", environment: "production", liveRuntime: true,
    clientId: "fictional-client", clientSecret: "fictional-secret", accountsOrigin: "https://accounts.zoho.com", apiOrigin: "https://www.zohoapis.com",
    networkEnabled: true, writeEnabled: true, booksMapping: { verified: true, baseCurrency: "AED", currencies: { AED: { id: "101" } }, taxes: {}, categories: {} } };
  settings.configs.set(organizationId, config);
  await db.companyIntegrationDestination.create({ data: { companyId: company.id, target: "ZOHO", organizationId, dataCenter: "US", environment: "production",
    liveEnabled: true, verifiedAt: new Date(Date.now() - 1000), verificationReference: "Fictional reviewed destination", verifiedConfigurationHash: booksConfigurationHash(config) } });
  await db.integrationCredential.create({ data: { target: "ZOHO", organizationId, dataCenter: "US", connectionFingerprint: connectionFingerprint(config), refreshTokenEncrypted: "never-decrypted-fixture" } });
  const input = { companyId: company.id, name: `Fictional supplier ${tag}-${index}`, currency: "AED", email: `supplier-${index}@example.invalid`, trn: "" };
  return { actor, company, config, input };
}
function provider(config: ZohoConfig, existing: Contact[] = []) {
  const contacts = new Map(existing.map(contact => [contact.contact_id, contact]));
  const control = { losePostResponse: false, rejectMarker: false, rejectDetail: false, ignoreNameFilters: false, currencyCode: "AED", onSearch: undefined as (() => Promise<void>) | undefined };
  const fetcher = vi.fn<Fetch>(async (url, options) => {
    const parsed = new URL(url), path = parsed.pathname;
    expect(parsed.searchParams.get("organization_id")).toBe(config.organizationId);
    if (path === `/books/v3/organizations/${config.organizationId}`) return Response.json({ code: 0, organization: {
      organization_id: config.organizationId, is_org_active: true, currency_code: "AED", currency_id: "101" } });
    if (path === "/books/v3/settings/currencies") return Response.json({ code: 0, currencies: [{ currency_id: "101", currency_code: control.currencyCode, is_enabled: true }] });
    if (path === "/books/v3/contacts" && options?.method === "POST") {
      const body = JSON.parse(options.body as string);
      const contact: Contact = { ...body, contact_id: String(900000 + contacts.size + 1), currency_code: "AED", status: "active" };
      contacts.set(contact.contact_id, contact);
      if (control.losePostResponse) throw new Error("Fictional lost response after provider acceptance");
      return Response.json({ code: 0, contact });
    }
    if (path === "/books/v3/contacts") {
      if (control.onSearch) await control.onSearch();
      if (control.rejectMarker && parsed.searchParams.get("search_text")?.startsWith("VX-VENDOR-")) return Response.json({ code: 57, message: "Fictional authorization rejection" }, { status: 401 });
      if (control.ignoreNameFilters && (parsed.searchParams.has("contact_name_contains") || parsed.searchParams.has("contact_name"))) {
        return Response.json({ code: 0, contacts: Array.from({ length: 200 }, (_, index) => ({ contact_id: String(700000 + index) })),
          page_context: { page: Number(parsed.searchParams.get("page")), has_more_page: true } });
      }
      const query = parsed.searchParams.get("search_text") ?? parsed.searchParams.get("contact_name_contains") ?? "";
      const rows = [...contacts.values()].filter(contact => contact.contact_name.includes(query) || (parsed.searchParams.has("search_text") && contact.notes.includes(query)));
      return Response.json({ code: 0, contacts: rows.map(({ contact_id }) => ({ contact_id })), page_context: { page: 1, has_more_page: false } });
    }
    const contact = contacts.get(path.split("/").at(-1)!);
    if (contact && path.startsWith("/books/v3/contacts/")) return control.rejectDetail
      ? Response.json({ code: 57, message: "Fictional detail authorization rejection" }, { status: 401 }) : Response.json({ code: 0, contact });
    throw new Error("Unexpected fictional provider request");
  });
  const factory: VendorTransportFactory = (selected, capability) => new ZohoTransport(selected, async () => "fictional-access-token", fetcher, undefined, undefined, capability);
  return { factory, fetcher, contacts, control, posts: () => fetcher.mock.calls.filter(([, options]) => options?.method === "POST") };
}
const existingContact = (name: string, email: string, extra: Partial<Contact> = {}): Contact => ({ contact_id: "880001", contact_name: name,
  contact_type: "vendor", currency_code: "AED", status: "active", notes: "Existing fictional supplier", tax_treatment: "vat_not_registered", email, ...extra });

beforeAll(() => assertMySqlTestDatabase());
beforeEach(() => { vi.stubEnv("MANUAL_ENTRY_ONLY", "false"); vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Actual provider networking is forbidden in vendor sync fixtures"); })); });
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
afterAll(async () => { settings.configs.clear(); await db.$disconnect(); });

describe("durable supplier synchronization on disposable MySQL and mocked providers", () => {
  it("commits the local vendor and intent before one guarded contact creation and exact mapping confirmation", async () => {
    const f = await fixture(), remote = provider(f.config);
    remote.control.onSearch = async () => {
      const saved = await db.vendor.findFirstOrThrow({ where: { companyId: f.company.id, name: f.input.name } });
      expect(await db.vendorBooksSync.count({ where: { vendorId: saved.id } })).toBe(1);
    };
    const result = await createVendorAndSync(f.actor, f.input, remote.factory);
    expect(result.sync.status).toBe("SYNCED"); expect(remote.posts()).toHaveLength(1);
    const job = await db.vendorBooksSync.findFirstOrThrow({ where: { vendorId: result.vendor.id } });
    expect(job).toMatchObject({ status: "SYNCED", attempts: 1, leaseToken: null, leaseUntil: null }); expect(job.submittedAt).not.toBeNull();
    expect(await db.vendorBooksMapping.findFirst({ where: { vendorId: result.vendor.id, organizationId: f.config.organizationId } })).toMatchObject({ externalVendorId: result.sync.externalVendorId });
    expect(JSON.parse(remote.posts()[0][1]!.body as string)).toMatchObject({ contact_type: "vendor", currency_id: "101", is_portal_enabled: false, tax_treatment: "vat_not_registered" });
    expect(await db.auditLog.count({ where: { entityId: result.vendor.id, action: "VENDOR_BOOKS_SYNC_CONFIRMED" } })).toBe(1);
  });
  it("reuses an exact active supplier without creating another provider contact", async () => {
    const f = await fixture(), remote = provider(f.config, [existingContact(f.input.name, f.input.email)]);
    const result = await createVendorAndSync(f.actor, f.input, remote.factory);
    expect(result.sync).toMatchObject({ status: "SYNCED", externalVendorId: "880001" }); expect(remote.posts()).toHaveLength(0);
  });
  it("searches the full supplier name using search_text when the provider ignores name-specific filters", async () => {
    const f = await fixture(), remote = provider(f.config);
    remote.control.ignoreNameFilters = true;
    const result = await createVendorAndSync(f.actor, f.input, remote.factory);
    expect(result.sync.status).toBe("SYNCED"); expect(remote.posts()).toHaveLength(1);
    const searches = remote.fetcher.mock.calls.filter(([url, options]) => new URL(url).pathname === "/books/v3/contacts" && options?.method !== "POST")
      .map(([url]) => new URL(url));
    expect(searches).toHaveLength(1);
    expect(searches[0].searchParams.get("search_text")).toBe(f.input.name);
    expect(searches[0].searchParams.get("contact_type")).toBe("vendor");
    expect(searches[0].searchParams.get("per_page")).toBe("200");
    expect(searches[0].searchParams.has("contact_name_contains")).toBe(false);
    expect(searches[0].searchParams.has("contact_name")).toBe(false);
  });
  it("does not reuse a differently named supplier returned because its notes contain the searched name", async () => {
    const f = await fixture();
    const unrelated = existingContact("Different fictional supplier", f.input.email, { notes: `Historical reference to ${f.input.name}` });
    const remote = provider(f.config, [unrelated]);
    const result = await createVendorAndSync(f.actor, f.input, remote.factory);
    expect(result.sync.status).toBe("SYNCED"); expect(remote.posts()).toHaveLength(1);
    expect(result.sync.externalVendorId).not.toBe(unrelated.contact_id);
    expect(remote.fetcher.mock.calls.some(([url]) => new URL(url).pathname === `/books/v3/contacts/${unrelated.contact_id}`)).toBe(true);
    expect(await db.vendorBooksMapping.findFirst({ where: { vendorId: result.vendor.id } })).toMatchObject({ externalVendorId: result.sync.externalVendorId });
    expect(remote.contacts.get(unrelated.contact_id)).toEqual(unrelated);
  });
  it("keeps a lost POST result UNKNOWN then reconciles by exact marker using GETs only", async () => {
    const f = await fixture(), remote = provider(f.config); remote.control.losePostResponse = true;
    const result = await createVendorAndSync(f.actor, f.input, remote.factory);
    expect(result.sync.status).toBe("UNKNOWN"); expect(remote.posts()).toHaveLength(1);
    const first = await db.vendorBooksSync.findFirstOrThrow({ where: { vendorId: result.vendor.id } }); expect(first.submittedAt).not.toBeNull();
    remote.control.losePostResponse = false;
    expect((await synchronizeVendor(f.actor, result.vendor.id, remote.factory)).status).toBe("SYNCED"); expect(remote.posts()).toHaveLength(1);
    const searchTerms = remote.fetcher.mock.calls.map(([url]) => new URL(url).searchParams.get("search_text")).filter(Boolean);
    expect(searchTerms).toContain(f.input.name);
    expect(searchTerms.at(-1)).toBe((first.snapshot as { marker: string }).marker);
  });
  it("never erases submission evidence when a later read-only reconciliation loses authorization", async () => {
    const f = await fixture(), remote = provider(f.config); remote.control.losePostResponse = true;
    const result = await createVendorAndSync(f.actor, f.input, remote.factory);
    const first = await db.vendorBooksSync.findFirstOrThrow({ where: { vendorId: result.vendor.id } });
    remote.control.losePostResponse = false; remote.control.rejectMarker = true;
    await synchronizeVendor(f.actor, result.vendor.id, remote.factory);
    expect((await db.vendorBooksSync.findUniqueOrThrow({ where: { id: first.id } })).submittedAt).toEqual(first.submittedAt);
    remote.control.rejectMarker = false;
    expect((await synchronizeVendor(f.actor, result.vendor.id, remote.factory)).status).toBe("SYNCED"); expect(remote.posts()).toHaveLength(1);
  });
  it("preserves a submitted contact ID when the post-create confirmation GET fails", async () => {
    const f = await fixture(), remote = provider(f.config); remote.control.rejectDetail = true;
    const result = await createVendorAndSync(f.actor, f.input, remote.factory);
    expect(result.sync.status).toBe("UNKNOWN"); expect(remote.posts()).toHaveLength(1);
    const saved = await db.vendorBooksSync.findFirstOrThrow({ where: { vendorId: result.vendor.id } });
    expect(saved.submittedAt).not.toBeNull(); expect(saved.externalVendorId).not.toBeNull();
    remote.control.rejectDetail = false;
    expect((await synchronizeVendor(f.actor, result.vendor.id, remote.factory)).status).toBe("SYNCED"); expect(remote.posts()).toHaveLength(1);
  });
  it("pins worker reconciliation to its original destination and never creates a replacement job after rebinding", async () => {
    const f = await fixture(), remote = provider(f.config); remote.control.losePostResponse = true;
    const result = await createVendorAndSync(f.actor, f.input, remote.factory);
    const original = await db.vendorBooksSync.findFirstOrThrow({ where: { vendorId: result.vendor.id } });
    expect(original.submittedAt).not.toBeNull();
    const rebound: ZohoConfig = { ...f.config, organizationId: `97${f.config.organizationId}` };
    settings.configs.set(rebound.organizationId, rebound);
    await db.integrationCredential.create({ data: { target: "ZOHO", organizationId: rebound.organizationId, dataCenter: "US",
      connectionFingerprint: connectionFingerprint(rebound), refreshTokenEncrypted: "never-decrypted-rebound-fixture" } });
    await db.companyIntegrationDestination.updateMany({ where: { companyId: f.company.id, target: "ZOHO" },
      data: { organizationId: rebound.organizationId, verifiedConfigurationHash: booksConfigurationHash(rebound) } });
    const callsBefore = remote.fetcher.mock.calls.length;
    expect((await synchronizeVendor(f.actor, result.vendor.id, remote.factory, original.id)).status).toBe("BLOCKED");
    expect((await synchronizeVendor(f.actor, result.vendor.id, remote.factory)).status).toBe("BLOCKED");
    expect(remote.fetcher).toHaveBeenCalledTimes(callsBefore); expect(remote.posts()).toHaveLength(1);
    expect(await db.vendorBooksSync.count({ where: { vendorId: result.vendor.id } })).toBe(1);
    expect(await db.vendorBooksSync.findUniqueOrThrow({ where: { id: original.id } })).toMatchObject({
      organizationId: f.config.organizationId, sourceHash: original.sourceHash, submittedAt: original.submittedAt, status: "BLOCKED" });
  });
  it.each([{ status: "inactive" }, { tax_treatment: "vat_registered", tax_reg_no: "100000000000001" }])("does not reuse a conflicting supplier profile %j", async conflict => {
    const f = await fixture(), remote = provider(f.config, [existingContact(f.input.name, f.input.email, conflict)]);
    const result = await createVendorAndSync(f.actor, f.input, remote.factory);
    expect(result.sync.status).toBe("BLOCKED"); expect(remote.posts()).toHaveLength(0);
    expect(await db.vendorBooksMapping.count({ where: { vendorId: result.vendor.id } })).toBe(0);
  });
  it.each(["actor", "source", "currency"])("denies %s drift before the contact POST", async kind => {
    const f = await fixture(), remote = provider(f.config);
    if (kind === "currency") remote.control.currencyCode = "USD";
    else remote.control.onSearch = async () => {
      if (kind === "actor") await db.user.update({ where: { id: f.actor.id }, data: { active: false } });
      else await db.vendor.updateMany({ where: { companyId: f.company.id }, data: { name: "Changed fictional source" } });
    };
    const result = await createVendorAndSync(f.actor, f.input, remote.factory);
    expect(result.sync.status).toBe("BLOCKED"); expect(remote.posts()).toHaveLength(0);
    expect(await db.vendorBooksMapping.count({ where: { vendorId: result.vendor.id } })).toBe(0);
  });
  it("rejects another company before creating a local vendor or contacting the provider", async () => {
    const f = await fixture(), other = await fixture(), remote = provider(other.config);
    await expect(createVendorAndSync(f.actor, other.input, remote.factory)).rejects.toMatchObject({ status: 404 });
    expect(await db.vendor.count({ where: { companyId: other.company.id } })).toBe(0); expect(remote.fetcher).not.toHaveBeenCalled();
  });
  it("does not steal a provider contact already mapped to another local supplier", async () => {
    const f = await fixture(), remote = provider(f.config, [existingContact(f.input.name, f.input.email)]);
    const existing = await db.vendor.create({ data: { companyId: f.company.id, name: "Other fictional local supplier", currency: "AED" } });
    await db.vendorBooksMapping.create({ data: { vendorId: existing.id, organizationId: f.config.organizationId, dataCenter: "US", environment: "production", externalVendorId: "880001" } });
    const result = await createVendorAndSync(f.actor, f.input, remote.factory);
    expect(result.sync.status).toBe("BLOCKED"); expect(remote.posts()).toHaveLength(0);
    expect(await db.vendorBooksMapping.count({ where: { vendorId: result.vendor.id } })).toBe(0);
    expect(await db.vendorBooksMapping.count({ where: { vendorId: existing.id, externalVendorId: "880001" } })).toBe(1);
  });
  it.each(["legacy", "other-destination"])("preserves existing %s supplier identity without creating an intent or contact", async kind => {
    const f = await fixture(), remote = provider(f.config);
    const vendor = await db.vendor.create({ data: { ...f.input, email: f.input.email, trn: null, externalZohoId: kind === "legacy" ? "770001" : null } });
    if (kind === "other-destination") await db.vendorBooksMapping.create({ data: { vendorId: vendor.id,
      organizationId: `96${f.config.organizationId}`, dataCenter: "US", environment: "production", externalVendorId: "770001" } });
    expect((await synchronizeVendor(f.actor, vendor.id, remote.factory)).status).toBe("BLOCKED");
    expect(remote.fetcher).not.toHaveBeenCalled(); expect(await db.vendorBooksSync.count({ where: { vendorId: vendor.id } })).toBe(0);
    expect((await db.vendor.findUniqueOrThrow({ where: { id: vendor.id } })).externalZohoId).toBe(kind === "legacy" ? "770001" : null);
    if (kind === "other-destination") expect(await db.vendorBooksMapping.count({ where: { vendorId: vendor.id, externalVendorId: "770001" } })).toBe(1);
  });
  it("refreshes a corrected source only on explicit retry of the same unsubmitted operation", async () => {
    const f = await fixture(), remote = provider(f.config);
    remote.control.onSearch = async () => { await db.vendor.updateMany({ where: { companyId: f.company.id }, data: { name: "Fictional reviewed corrected source" } }); };
    const result = await createVendorAndSync(f.actor, f.input, remote.factory);
    const original = await db.vendorBooksSync.findFirstOrThrow({ where: { vendorId: result.vendor.id } });
    expect(original.status).toBe("BLOCKED"); expect(original.submittedAt).toBeNull(); expect(remote.posts()).toHaveLength(0);
    remote.control.onSearch = undefined;
    expect((await synchronizeVendor(f.actor, result.vendor.id, remote.factory)).status).toBe("SYNCED");
    const refreshed = await db.vendorBooksSync.findUniqueOrThrow({ where: { id: original.id } });
    expect(refreshed.sourceHash).not.toBe(original.sourceHash); expect(refreshed.submittedAt).not.toBeNull();
    expect(await db.vendorBooksSync.count({ where: { vendorId: result.vendor.id } })).toBe(1); expect(remote.posts()).toHaveLength(1);
  });
});
