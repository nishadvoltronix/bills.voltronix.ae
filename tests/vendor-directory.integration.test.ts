import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { getConfig } from "@/lib/integrations/config";
import { connectionFingerprint } from "@/lib/integrations/connection-fingerprint";
import { ZohoTransport } from "@/lib/integrations/transport";
import { listCompanyVendorDirectory, searchBillVendors } from "@/lib/services/bill-vendor-lookup";
import { assertMySqlTestDatabase, bindTestDestination, createTestCompany } from "./company-fixtures";

const tag = randomUUID().slice(0, 8);
const organizationA = `96${Date.now()}1`;
const organizationB = `96${Date.now()}2`;
let actor: Actor;
let companyA: string;
let companyB: string;
let localCompany: string;

function transport(organizationId: string, name: string, onRead?: () => Promise<void>) {
  return new ZohoTransport(getConfig("ZOHO", process.env, organizationId), async () => "fictional-token", async (url, init) => {
    expect(init?.method).toBe("GET");
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/books/v3/contacts");
    expect(parsed.searchParams.get("organization_id")).toBe(organizationId);
    expect(parsed.searchParams.get("contact_type")).toBe("vendor");
    expect(parsed.searchParams.has("filter_by")).toBe(false);
    await onRead?.();
    return new Response(JSON.stringify({ code: 0,
      contacts: [{ contact_id: "101", contact_name: name, contact_type: "vendor", status: "inactive", currency_code: "JPY" }],
      page_context: { page: Number(parsed.searchParams.get("page")), per_page: 100, has_more_page: false },
    }), { headers: { "Content-Type": "application/json" } });
  });
}

beforeAll(async () => {
  assertMySqlTestDatabase();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Live provider requests are forbidden in this fixture."); }));
  for (const [key, value] of Object.entries({
    ZOHO_BOOKS_DC: "US", ZOHO_BOOKS_ENVIRONMENT: "production",
    ZOHO_BOOKS_CLIENT_ID: "fictional-client", ZOHO_BOOKS_CLIENT_SECRET: "fictional-secret",
    INTEGRATION_NETWORK_ENABLED: "true", ZOHO_BOOKS_NETWORK_ENABLED: "true",
    ZOHO_BOOKS_WRITE_ENABLED: "false", ZOHO_BOOKS_LIVE_ENABLED: "false",
    ALLOW_PRODUCTION_ACCOUNTING_WRITES: "false", INTEGRATION_TEST_MODE: "false",
    ZOHO_BOOKS_ORGANIZATIONS_JSON: JSON.stringify([
      { organizationId: organizationA, name: "Fictional directory A" },
      { organizationId: organizationB, name: "Fictional directory B" },
    ]),
  })) vi.stubEnv(key, value);
  actor = await db.user.create({ data: { email: `vendor-directory-${tag}@example.invalid`, name: "Fictional management reader", role: "MANAGEMENT", passwordHash: "unused-fixture-password" } });
  companyA = (await createTestCompany(`directory A ${tag}`, [actor])).id;
  companyB = (await createTestCompany(`directory B ${tag}`, [actor])).id;
  localCompany = (await createTestCompany(`local directory ${tag}`, [actor])).id;
  for (const [companyId, organizationId] of [[companyA, organizationA], [companyB, organizationB]]) {
    await bindTestDestination(companyId, { target: "ZOHO", organizationId, environment: "production" });
    await db.integrationCredential.create({ data: { target: "ZOHO", organizationId, dataCenter: "US",
      connectionFingerprint: connectionFingerprint(getConfig("ZOHO", process.env, organizationId)), refreshTokenEncrypted: "never-decrypted-fixture" } });
  }
  await db.vendor.createMany({ data: Array.from({ length: 101 }, (_, i) => ({
    companyId: localCompany, name: `Fictional local ${String(i).padStart(3, "0")}${i === 100 ? " 5%_" : ""} ${tag}`, currency: "AED",
  })) });
  await db.vendor.create({ data: { companyId: companyB, name: `Fictional unrelated 5%_ ${tag}`, currency: "AED" } });
});

afterAll(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await db.$disconnect();
});

describe("company vendor directory on disposable MySQL", () => {
  it("pages all local suppliers for an authorized Management reader", async () => {
    const first = await listCompanyVendorDirectory(actor, { companyId: localCompany, page: 1 });
    const second = await listCompanyVendorDirectory(actor, { companyId: localCompany, page: 2 });
    expect(first).toMatchObject({ source: "local", page: 1, perPage: 100, hasMore: true });
    expect(second).toMatchObject({ source: "local", page: 2, hasMore: false });
    expect(first.vendors).toHaveLength(100);
    expect(second.vendors).toHaveLength(1);
    const all = [...first.vendors, ...second.vendors];
    expect(new Set(all.map((row) => row.id)).size).toBe(101);
    expect(all.every((row) => row.companyId === localCompany)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("treats SQL wildcards literally and never includes another company's local record", async () => {
    const result = await listCompanyVendorDirectory(actor, { companyId: localCompany, q: "5%_" });
    expect(result.vendors).toHaveLength(1);
    expect(result.vendors[0].companyId).toBe(localCompany);
  });

  it("reads the two exact Books organizations without importing vendors or writing bills", async () => {
    const before = await Promise.all([db.vendor.count(), db.vendorBooksMapping.count(), db.bill.count()]);
    for (const [companyId, organizationId, name] of [[companyA, organizationA, "Fictional directory supplier A"], [companyB, organizationB, "Fictional directory supplier B"]]) {
      const result = await listCompanyVendorDirectory(actor, { companyId }, transport(organizationId, name));
      expect(result).toMatchObject({ source: "books", companyId, organizationId, hasMore: false, warning: null });
      expect(result.vendors).toHaveLength(1);
      expect(result.vendors[0]).toMatchObject({ companyId, organizationId, name, externalVendorId: "101", status: "inactive", currency: "JPY" });
    }
    expect(await Promise.all([db.vendor.count(), db.vendorBooksMapping.count(), db.bill.count()])).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps Management unable to use the bill-entry writer lookup", async () => {
    await expect(searchBillVendors(actor, { companyId: companyA })).rejects.toMatchObject({ status: 403 });
  });

  it("rejects a company outside current memberships", async () => {
    const outside = await createTestCompany(`directory outside ${tag}`);
    await expect(listCompanyVendorDirectory(actor, { companyId: outside.id })).rejects.toMatchObject({ status: 403 });
  });

  it("discards a provider result when company membership is revoked during the read", async () => {
    const where = { userId_companyId: { userId: actor.id, companyId: companyA } };
    try {
      await expect(listCompanyVendorDirectory(actor, { companyId: companyA }, transport(organizationA, "Must stay private", async () => {
        await db.userCompanyMembership.update({ where, data: { active: false } });
      }))).rejects.toMatchObject({ status: 403 });
    } finally {
      await db.userCompanyMembership.update({ where, data: { active: true } });
    }
  });

  it("discards a provider result when another company destination appears during the read", async () => {
    const otherOrganization = `96${Date.now()}3`;
    try {
      await expect(listCompanyVendorDirectory(actor, { companyId: companyA }, transport(organizationA, "Must stay scoped", async () => {
        await bindTestDestination(companyA, { target: "ZOHO", organizationId: otherOrganization, environment: "production" });
      }))).rejects.toMatchObject({ status: 409 });
    } finally {
      await db.companyIntegrationDestination.deleteMany({ where: { companyId: companyA, organizationId: otherOrganization } });
    }
  });
});
