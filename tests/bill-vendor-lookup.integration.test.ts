import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { getConfig } from "@/lib/integrations/config";
import { ZohoTransport } from "@/lib/integrations/transport";
import { searchBillVendors, resolveBillVendor } from "@/lib/services/bill-vendor-lookup";
import { assertMySqlTestDatabase, bindTestDestination, createTestCompany } from "./company-fixtures";

const tag = randomUUID().slice(0, 8);
const organizationA = `98${Date.now()}1`;
const organizationB = `98${Date.now()}2`;
let actor: Actor;
let companyA: string;
let companyB: string;
let localCompany: string;
let existingA: string;
let existingB: string;

function contact(id: string, name = `Fictional Books supplier ${tag}`) {
  return { contact_id: id, contact_name: name, contact_type: "vendor", status: "active",
    currency_id: "301", currency_code: "AED", email: "supplier@example.invalid", tax_reg_no: `100000000${id.padStart(6, "0")}` };
}
function transport(organizationId: string, row = contact("101"), onRead?: () => Promise<void>) {
  return new ZohoTransport(getConfig("ZOHO", process.env, organizationId), async () => "fictional-token", async (url, init) => {
    expect(init?.method).toBe("GET");
    expect(new URL(url).searchParams.get("organization_id")).toBe(organizationId);
    await onRead?.();
    return new Response(JSON.stringify({ code: 0, contact: row }), { headers: { "Content-Type": "application/json" } });
  });
}
function selection(companyId = companyA, organizationId = organizationA, externalVendorId = "101") {
  return { companyId, organizationId, externalVendorId, dataCenter: "US", environment: "production" };
}

beforeAll(async () => {
  assertMySqlTestDatabase();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Live providers are forbidden in this test."); }));
  for (const [key, value] of Object.entries({
    ZOHO_BOOKS_DC: "US", ZOHO_BOOKS_ENVIRONMENT: "production",
    ZOHO_BOOKS_CLIENT_ID: "fictional-client", ZOHO_BOOKS_CLIENT_SECRET: "fictional-secret",
    INTEGRATION_NETWORK_ENABLED: "true", ZOHO_BOOKS_NETWORK_ENABLED: "true",
    ZOHO_BOOKS_WRITE_ENABLED: "false", ZOHO_BOOKS_LIVE_ENABLED: "false",
    ALLOW_PRODUCTION_ACCOUNTING_WRITES: "false", INTEGRATION_TEST_MODE: "false",
    ZOHO_BOOKS_ORGANIZATIONS_JSON: JSON.stringify([
      { organizationId: organizationA, name: "Fictional Books A" },
      { organizationId: organizationB, name: "Fictional Books B" },
    ]),
  })) vi.stubEnv(key, value);
  actor = await db.user.create({ data: { email: `vendor-lookup-${tag}@example.invalid`, name: "Fictional entry writer", role: "DATA_ENTRY", passwordHash: "unused-fixture-password" } });
  companyA = (await createTestCompany(`vendor lookup A ${tag}`, [actor])).id;
  companyB = (await createTestCompany(`vendor lookup B ${tag}`, [actor])).id;
  localCompany = (await createTestCompany(`local vendors ${tag}`, [actor])).id;
  await db.company.update({ where: { id: companyA }, data: { isDemo: true } });
  await bindTestDestination(companyA, { target: "ZOHO", organizationId: organizationA, environment: "production" });
  await bindTestDestination(companyB, { target: "ZOHO", organizationId: organizationB, environment: "production" });
  existingA = (await db.vendor.create({ data: { companyId: companyA, name: `Existing A ${tag}`, email: "existing-a@example.invalid", trn: "123456789012345", currency: "AED", isDemo: true } })).id;
  existingB = (await db.vendor.create({ data: { companyId: companyB, name: `Existing B ${tag}`, currency: "AED" } })).id;
  await db.vendor.createMany({ data: [
    { companyId: localCompany, name: `Literal 5%_ Supplier ${tag}`, currency: "AED" },
    { companyId: localCompany, name: `Literal 500 Supplier ${tag}`, currency: "AED" },
    { companyId: companyB, name: `Literal 5%_ Supplier ${tag}`, currency: "AED" },
  ] });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await db.$disconnect();
});

describe("bill vendor lookup on disposable MySQL", () => {
  it("searches the exact local company with literal wildcard characters", async () => {
    const result = await searchBillVendors(actor, { companyId: localCompany, q: "5%_" });
    expect(result.organizationId).toBeNull();
    expect(result.vendors).toHaveLength(1);
    expect(result.vendors[0]).toMatchObject({ companyId: localCompany, name: `Literal 5%_ Supplier ${tag}` });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves a legacy demo company's local vendors when its sandbox placeholder has no configured profile", async () => {
    const legacy = await createTestCompany(`legacy demo vendors ${tag}`, [actor]);
    await db.company.update({ where: { id: legacy.id }, data: { isDemo: true } });
    await bindTestDestination(legacy.id, { target: "ZOHO", organizationId: `97${Date.now()}3`, environment: "sandbox" });
    const vendor = await db.vendor.create({ data: { companyId: legacy.id, name: `Legacy local supplier ${tag}`, currency: "AED", isDemo: true } });
    const result = await searchBillVendors(actor, { companyId: legacy.id });
    expect(result.organizationId).toBeNull();
    expect(result.vendors).toEqual([{ id: vendor.id, companyId: legacy.id, name: vendor.name, currency: "AED", email: null, trn: null }]);
    expect(result.warning).toContain("not configured");
    expect(await db.vendorBooksMapping.count({ where: { vendorId: vendor.id } })).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("hydrates an existing vendor without Books access and rejects another company's ID", async () => {
    const result = await searchBillVendors(actor, { companyId: companyA, vendorId: existingA });
    expect(result.selectedVendor).toMatchObject({ id: existingA, companyId: companyA, email: "existing-a@example.invalid", trn: "123456789012345" });
    await expect(searchBillVendors(actor, { companyId: companyA, vendorId: existingB })).rejects.toMatchObject({ status: 404 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns only same-company unmapped local suppliers and exact-destination mappings when Books networking is disabled", async () => {
    const name = `Offline draft supplier ${tag}`;
    const unmapped = await db.vendor.create({ data: { companyId: companyA, name, currency: "AED" } });
    await db.vendor.create({ data: { companyId: companyB, name, currency: "AED" } });
    await db.vendor.create({ data: { companyId: companyA, name: `${name} legacy`, currency: "AED", externalZohoId: "991001" } });
    const foreignMapping = await db.vendor.create({ data: { companyId: companyA, name: `${name} foreign destination`, currency: "AED" } });
    await db.vendorBooksMapping.create({ data: { vendorId: foreignMapping.id, organizationId: organizationB,
      dataCenter: "US", environment: "production", externalVendorId: "991002" } });
    const linked = await db.vendor.create({ data: { companyId: companyA, name: `${name} linked`, currency: "AED" } });
    await db.vendorBooksMapping.create({ data: { vendorId: linked.id, organizationId: organizationA,
      dataCenter: "US", environment: "production", externalVendorId: "991003" } });
    vi.stubEnv("ZOHO_BOOKS_NETWORK_ENABLED", "false");
    try {
      const result = await searchBillVendors(actor, { companyId: companyA, q: name });
      expect(result.organizationId).toBe(organizationA);
      expect(result.vendors.map(vendor => vendor.id).sort()).toEqual([unmapped.id, linked.id].sort());
      expect(result.vendors.find(vendor => vendor.id === unmapped.id)).toEqual({ id: unmapped.id,
        companyId: companyA, name, currency: "AED", email: null, trn: null, booksMappingRequired: true });
      expect(result.vendors.find(vendor => vendor.id === linked.id)).toMatchObject({ organizationId: organizationA,
        dataCenter: "US", environment: "production", externalVendorId: "991003" });
      expect(result.warning).toContain("need a Books mapping before sync");
      const hydrated = await searchBillVendors(actor, { companyId: companyA, vendorId: unmapped.id });
      expect(hydrated.selectedVendor).toMatchObject({ id: unmapped.id, companyId: companyA });
      expect(await db.vendorBooksMapping.count({ where: { vendorId: unmapped.id } })).toBe(0);
      expect(await db.vendor.findUnique({ where: { id: unmapped.id } })).toMatchObject({ externalZohoId: null });
      expect(fetch).not.toHaveBeenCalled();
    } finally { vi.stubEnv("ZOHO_BOOKS_NETWORK_ENABLED", "true"); }
  });

  it("creates only a local supplier/mapping and reuses it on repeated selection", async () => {
    const bills = await db.bill.count();
    const documents = await db.document.count();
    const selected = await resolveBillVendor(actor, selection(), transport(organizationA));
    const again = await resolveBillVendor(actor, selection(), transport(organizationA));
    expect(again.id).toBe(selected.id);
    expect(selected).toMatchObject({ companyId: companyA, currency: "AED" });
    expect(await db.vendor.findUnique({ where: { id: selected.id } })).toMatchObject({ isDemo: true });
    expect(await db.vendorBooksMapping.count({ where: { organizationId: organizationA, externalVendorId: "101" } })).toBe(1);
    expect(await db.bill.count()).toBe(bills);
    expect(await db.document.count()).toBe(documents);
  });

  it("isolates identical external IDs in the two actual destination keys", async () => {
    const a = await resolveBillVendor(actor, selection(), transport(organizationA));
    const b = await resolveBillVendor(actor, selection(companyB, organizationB), transport(organizationB));
    expect(a.id).not.toBe(b.id);
    expect(b.companyId).toBe(companyB);
    const rows = await db.vendorBooksMapping.findMany({ where: { externalVendorId: "101", organizationId: { in: [organizationA, organizationB] } }, include: { vendor: true } });
    expect(rows.find(row => row.organizationId === organizationA)?.vendor.companyId).toBe(companyA);
    expect(rows.find(row => row.organizationId === organizationB)?.vendor.companyId).toBe(companyB);
  });

  it("rejects stale organization selection before issuing a provider request", async () => {
    const onRead = vi.fn(async () => {});
    await expect(resolveBillVendor(actor, selection(companyB, organizationA), transport(organizationA, contact("101"), onRead))).rejects.toThrow();
    expect(onRead).not.toHaveBeenCalled();
  });

  it("preserves existing vendors on a same-name conflict instead of creating a duplicate", async () => {
    const before = await db.vendor.findUniqueOrThrow({ where: { id: existingA } });
    const count = await db.vendor.count({ where: { companyId: companyA } });
    await expect(resolveBillVendor(actor, selection(companyA, organizationA, "999"), transport(organizationA, contact("999", before.name)))).rejects.toThrow();
    expect(await db.vendor.count({ where: { companyId: companyA } })).toBe(count);
    expect(await db.vendor.findUniqueOrThrow({ where: { id: existingA } })).toEqual(before);
    expect(await db.vendorBooksMapping.count({ where: { organizationId: organizationA, externalVendorId: "999" } })).toBe(0);
  });

  it("rechecks membership after provider verification before persisting a selection", async () => {
    const count = await db.vendor.count({ where: { companyId: companyA } });
    const where = { userId_companyId: { userId: actor.id, companyId: companyA } };
    try {
      await expect(resolveBillVendor(actor, selection(companyA, organizationA, "998"), transport(organizationA, contact("998", `Revoked selection ${tag}`), async () => {
        await db.userCompanyMembership.update({ where, data: { active: false } });
      }))).rejects.toThrow();
      expect(await db.vendor.count({ where: { companyId: companyA } })).toBe(count);
      expect(await db.vendorBooksMapping.count({ where: { organizationId: organizationA, externalVendorId: "998" } })).toBe(0);
    } finally {
      await db.userCompanyMembership.update({ where, data: { active: true } });
    }
  });
});
