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

  it("rejects stale automatic identity before changing any actual local table", async () => {
    const row = contact("810", `Fresh automatic supplier ${tag}`);
    const before = await Promise.all([db.vendor.findMany({ orderBy: { id: "asc" } }), db.vendorBooksMapping.findMany({ orderBy: { id: "asc" } }),
      db.auditLog.count(), db.bill.count(), db.payment.count(), db.document.count()]);
    for (const expectedIdentity of [
      { vendorName: `Stale invoice supplier ${tag}`, vendorTrn: row.tax_reg_no, currency: "AED" },
      { vendorName: row.contact_name, vendorTrn: "999999999999999", currency: "AED" },
      { vendorName: row.contact_name, vendorTrn: row.tax_reg_no, currency: "USD" },
    ]) await expect(resolveBillVendor(actor, { ...selection(companyA, organizationA, "810"), expectedIdentity }, transport(organizationA, row)))
      .rejects.toMatchObject({ status: 409 });
    expect(await Promise.all([db.vendor.findMany({ orderBy: { id: "asc" } }), db.vendorBooksMapping.findMany({ orderBy: { id: "asc" } }),
      db.auditLog.count(), db.bill.count(), db.payment.count(), db.document.count()])).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("creates and reuses only one actual local mapping for a fresh exact automatic identity", async () => {
    const row = contact("811", `Fictional Auto Supplier L.L.C. ${tag}`);
    const expectedIdentity = { vendorName: `FICTIONAL AUTO SUPPLIER LLC ${tag}`, vendorTrn: row.tax_reg_no, currency: "AED" };
    const payload = { ...selection(companyA, organizationA, "811"), expectedIdentity };
    const financialBefore = await Promise.all([db.bill.count(), db.billLine.count(), db.payment.count(), db.document.count()]);
    const countsBefore = await Promise.all([db.vendor.count(), db.vendorBooksMapping.count(), db.auditLog.count()]);
    const onRead = vi.fn(async () => {});
    const first = await resolveBillVendor(actor, payload, transport(organizationA, row, onRead));
    const second = await resolveBillVendor(actor, payload, transport(organizationA, row, onRead));
    expect(second.id).toBe(first.id); expect(onRead).toHaveBeenCalledTimes(2);
    expect(await db.vendorBooksMapping.findMany({ where: { organizationId: organizationA, externalVendorId: "811" } })).toMatchObject([
      { vendorId: first.id, organizationId: organizationA, externalVendorId: "811", dataCenter: "US", environment: "production" },
    ]);
    expect(await Promise.all([db.vendor.count(), db.vendorBooksMapping.count(), db.auditLog.count()])).toEqual(countsBefore.map(value => value + 1));
    expect(await Promise.all([db.bill.count(), db.billLine.count(), db.payment.count(), db.document.count()])).toEqual(financialBefore);
    expect(fetch).not.toHaveBeenCalled();
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

  it("keeps separate mapped Books contacts sharing a TRN without altering the peer's paid bill or payment", async () => {
    const row = contact("777", `Selected shared-tax supplier ${tag}`);
    const peer = await db.vendor.create({ data: { companyId: companyA, name: `Different mapped supplier ${tag}`,
      currency: "AED", trn: row.tax_reg_no, email: "preserved-peer@example.invalid", isDemo: true } });
    await db.vendorBooksMapping.create({ data: { vendorId: peer.id, organizationId: organizationA,
      dataCenter: "US", environment: "production", externalVendorId: "778" } });
    const job = await db.job.create({ data: { companyId: companyA, jobNumber: `TRN-${tag}`, name: "Fixture shared-tax job", customer: "Fixture customer", isDemo: true } });
    await db.bill.create({ data: { companyId: companyA, vendorId: peer.id, jobId: job.id, createdById: actor.id,
      invoiceNumber: `PEER-${tag}`, normalizedInvoiceNumber: `peer-${tag}`, invoiceDate: new Date("2026-11-01"), category: "OTHER",
      currency: "AED", status: "READY", subtotal: "10", vatAmount: "0", total: "10", paidAmount: "5",
      lines: { create: { description: "Preserved original line", quantity: "1", unitPrice: "10", lineTotal: "10" } },
      payments: { create: { amount: "5", reference: `preserved-payment-${tag}`, createdById: actor.id } } } });
    const original = await db.vendor.findUniqueOrThrow({ where: { id: peer.id },
      include: { booksMappings: true, booksSyncs: true, bills: { include: { lines: true, payments: true } } } });
    const counts = { bills: await db.bill.count(), payments: await db.payment.count(), documents: await db.document.count() };
    const onRead = vi.fn(async () => {});
    const selected = await resolveBillVendor(actor, selection(companyA, organizationA, row.contact_id), transport(organizationA, row, onRead));
    const again = await resolveBillVendor(actor, selection(companyA, organizationA, row.contact_id), transport(organizationA, row, onRead));
    expect(selected.id).not.toBe(peer.id); expect(again.id).toBe(selected.id);
    expect(selected).toMatchObject({ name: row.contact_name, trn: row.tax_reg_no, externalVendorId: row.contact_id });
    expect(await db.vendor.findUniqueOrThrow({ where: { id: peer.id },
      include: { booksMappings: true, booksSyncs: true, bills: { include: { lines: true, payments: true } } } })).toEqual(original);
    expect(await db.vendor.count({ where: { companyId: companyA, trn: row.tax_reg_no } })).toBe(2);
    expect(await db.vendorBooksMapping.count({ where: { organizationId: organizationA, externalVendorId: row.contact_id } })).toBe(1);
    expect(await db.auditLog.count({ where: { entityType: "Vendor", entityId: selected.id, action: "BOOKS_VENDOR_SELECTED" } })).toBe(1);
    expect({ bills: await db.bill.count(), payments: await db.payment.count(), documents: await db.document.count() }).toEqual(counts);
    expect(onRead).toHaveBeenCalledTimes(2);
  });

  it("preserves database-collation name conflicts even for a distinct mapped supplier sharing the TRN", async () => {
    const row = contact("779", `Case matched supplier ${tag}`);
    const peer = await db.vendor.create({ data: { companyId: companyA, name: row.contact_name.toUpperCase(), currency: "AED", trn: row.tax_reg_no } });
    await db.vendorBooksMapping.create({ data: { vendorId: peer.id, organizationId: organizationA,
      dataCenter: "US", environment: "production", externalVendorId: "780" } });
    expect(await db.vendor.findFirst({ where: { companyId: companyA, name: row.contact_name } })).toMatchObject({ id: peer.id });
    const before = await db.vendor.count({ where: { companyId: companyA } });
    await expect(resolveBillVendor(actor, selection(companyA, organizationA, row.contact_id), transport(organizationA, row))).rejects.toMatchObject({ status: 409 });
    expect(await db.vendor.count({ where: { companyId: companyA } })).toBe(before);
    expect(await db.vendorBooksMapping.count({ where: { organizationId: organizationA, externalVendorId: row.contact_id } })).toBe(0);
  });

  it.each(["organization", "data-center", "environment"])("rejects a shared-TRN mapping with a different %s", async mode => {
    const row = contact(String(781 + ["organization", "data-center", "environment"].indexOf(mode)), `Scope-specific selected supplier ${mode} ${tag}`);
    const peer = await db.vendor.create({ data: { companyId: companyA, name: `Foreign-scope shared tax ${mode} ${tag}`, currency: "AED", trn: row.tax_reg_no } });
    await db.vendorBooksMapping.create({ data: { vendorId: peer.id, organizationId: mode === "organization" ? organizationB : organizationA,
      dataCenter: mode === "data-center" ? "AE" : "US", environment: mode === "environment" ? "sandbox" : "production", externalVendorId: `8${row.contact_id}` } });
    const before = await db.vendor.count({ where: { companyId: companyA } });
    const audits = await db.auditLog.count({ where: { companyId: companyA, action: "BOOKS_VENDOR_SELECTED" } });
    await expect(resolveBillVendor(actor, selection(companyA, organizationA, row.contact_id), transport(organizationA, row))).rejects.toMatchObject({ status: 409 });
    expect(await db.vendor.count({ where: { companyId: companyA } })).toBe(before);
    expect(await db.auditLog.count({ where: { companyId: companyA, action: "BOOKS_VENDOR_SELECTED" } })).toBe(audits);
  });

  it("refuses a mapped shared-TRN peer with an uncertain supplier-creation result", async () => {
    const row = contact("784", `Selected with uncertain peer ${tag}`);
    const peer = await db.vendor.create({ data: { companyId: companyA, name: `Uncertain supplier ${tag}`, currency: "AED", trn: row.tax_reg_no } });
    await db.vendorBooksMapping.create({ data: { vendorId: peer.id, organizationId: organizationA,
      dataCenter: "US", environment: "production", externalVendorId: "1784" } });
    const operation = await db.vendorBooksSync.create({ data: { companyId: companyA, vendorId: peer.id, initiatedById: actor.id,
      organizationId: organizationA, dataCenter: "US", environment: "production", status: "UNKNOWN", externalVendorId: "1784",
      sourceHash: "0".repeat(64), snapshot: {}, submittedAt: new Date() } });
    const before = await db.vendor.count({ where: { companyId: companyA } });
    await expect(resolveBillVendor(actor, selection(companyA, organizationA, row.contact_id), transport(organizationA, row))).rejects.toMatchObject({ status: 409 });
    expect(await db.vendor.count({ where: { companyId: companyA } })).toBe(before);
    expect(await db.vendorBooksSync.findUniqueOrThrow({ where: { id: operation.id } })).toEqual(operation);
    expect(await db.vendorBooksMapping.count({ where: { organizationId: organizationA, externalVendorId: row.contact_id } })).toBe(0);
  });

  it("allows matching completed peer history while preserving its snapshot and original identity", async () => {
    const row = contact("785", `Selected with completed peer ${tag}`);
    const peer = await db.vendor.create({ data: { companyId: companyA, name: `Completed supplier ${tag}`, currency: "AED", trn: row.tax_reg_no, externalZohoId: "1785" } });
    await db.vendorBooksMapping.create({ data: { vendorId: peer.id, organizationId: organizationA,
      dataCenter: "US", environment: "production", externalVendorId: "1785" } });
    const operation = await db.vendorBooksSync.create({ data: { companyId: companyA, vendorId: peer.id, initiatedById: actor.id,
      organizationId: organizationA, dataCenter: "US", environment: "production", status: "SYNCED", externalVendorId: "1785",
      sourceHash: "0".repeat(64), snapshot: { preserved: "historical fixture" }, submittedAt: new Date(Date.now() - 2000), completedAt: new Date(Date.now() - 1000) } });
    const selected = await resolveBillVendor(actor, selection(companyA, organizationA, row.contact_id), transport(organizationA, row));
    expect(selected.id).not.toBe(peer.id);
    expect(await db.vendor.findUniqueOrThrow({ where: { id: peer.id } })).toEqual(peer);
    expect(await db.vendorBooksSync.findUniqueOrThrow({ where: { id: operation.id } })).toEqual(operation);
  });

  it("does not ignore a second unproven TRN collision just because the first contact is mapped", async () => {
    const row = contact("786", `Selected with multiple shared-tax peers ${tag}`);
    const mapped = await db.vendor.create({ data: { companyId: companyA, name: `Mapped shared-tax peer ${tag}`, currency: "AED", trn: row.tax_reg_no } });
    await db.vendorBooksMapping.create({ data: { vendorId: mapped.id, organizationId: organizationA,
      dataCenter: "US", environment: "production", externalVendorId: "1786" } });
    await db.vendor.create({ data: { companyId: companyA, name: `Unmapped shared-tax peer ${tag}`, currency: "AED", trn: row.tax_reg_no } });
    const before = await db.vendor.count({ where: { companyId: companyA } });
    await expect(resolveBillVendor(actor, selection(companyA, organizationA, row.contact_id), transport(organizationA, row))).rejects.toMatchObject({ status: 409 });
    expect(await db.vendor.count({ where: { companyId: companyA } })).toBe(before);
    expect(await db.vendorBooksMapping.count({ where: { organizationId: organizationA, externalVendorId: row.contact_id } })).toBe(0);
  });

  it("serializes competing selections into one new handle without changing the distinct shared-TRN peer", async () => {
    const row = contact("787", `Concurrent selected supplier ${tag}`);
    const peer = await db.vendor.create({ data: { companyId: companyA, name: `Concurrent existing peer ${tag}`, currency: "AED", trn: row.tax_reg_no } });
    await db.vendorBooksMapping.create({ data: { vendorId: peer.id, organizationId: organizationA,
      dataCenter: "US", environment: "production", externalVendorId: "1787" } });
    const results = await Promise.allSettled([1, 2].map(() => resolveBillVendor(actor,
      selection(companyA, organizationA, row.contact_id), transport(organizationA, row))));
    expect(results.some(result => result.status === "fulfilled")).toBe(true);
    for (const result of results) if (result.status === "rejected") expect(result.reason).toMatchObject({ status: 409 });
    const selected = await resolveBillVendor(actor, selection(companyA, organizationA, row.contact_id), transport(organizationA, row));
    expect(selected.id).not.toBe(peer.id);
    expect(await db.vendor.count({ where: { companyId: companyA, name: row.contact_name } })).toBe(1);
    expect(await db.vendorBooksMapping.count({ where: { organizationId: organizationA, externalVendorId: row.contact_id } })).toBe(1);
    expect(await db.auditLog.count({ where: { entityId: selected.id, action: "BOOKS_VENDOR_SELECTED" } })).toBe(1);
    expect(await db.vendor.findUniqueOrThrow({ where: { id: peer.id } })).toEqual(peer);
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
