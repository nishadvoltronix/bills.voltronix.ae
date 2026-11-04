import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
import type { Prisma } from "@prisma/client";
import { BOOKS_NO_VAT, BOOKS_NO_VAT_NAME } from "@/lib/books-selection";
import { getConfig } from "@/lib/integrations/config";
import { connectionFingerprint } from "@/lib/integrations/connection-fingerprint";
import { ZohoTransport } from "@/lib/integrations/transport";
import { booksVendorVatMetadata } from "@/lib/integrations/books-vendor-tax";
import { prepareBillVendorVatVerification, assertBillVendorVatVerification, type BillVendorVatSource } from "@/lib/services/bill-vendor-vat";

const store = vi.hoisted(() => ({ user: { findFirst: vi.fn() }, company: { findUnique: vi.fn() }, vendor: { findFirst: vi.fn() },
  companyIntegrationDestination: { findMany: vi.fn() }, vendorBooksMapping: { findUnique: vi.fn() }, integrationCredential: { findUnique: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db: store }));
vi.mock("@/lib/integrations/oauth", () => ({ accessToken: vi.fn(async () => "fictional-token"), LEGACY_UNSCOPED_ORGANIZATION: "__legacy_unscoped__" }));
const actor: Actor = { id: "entry", role: "ACCOUNTS", email: "entry@example.invalid", name: "Fictional entry" };
const destination = { organizationId: "1001", dataCenter: "US", environment: "production" };
const selection = (taxId = "401", taxRate = "5.00") => ({ ...destination, accountId: "301", accountName: "Materials",
  taxId, taxName: taxId === BOOKS_NO_VAT ? BOOKS_NO_VAT_NAME : "VAT", taxRate, customerId: null, customerName: null });
const source = (taxId = "401", taxRate = "5.00"): BillVendorVatSource => ({ vendorId: "supplier", currency: "AED", vatRate: taxRate,
  billId: "draft-bill", version: 3, lines: [{ booksSelection: selection(taxId, taxRate) }] });
let authorized: boolean, revoked: boolean, externalVendorId: string, currentRole: Actor["role"];
function transport(overrides: Record<string, unknown> = {}, onRead?: () => void) {
  const fetcher = vi.fn(async (_input: string | URL, init?: RequestInit) => {
    expect(init?.method).toBe("GET"); onRead?.();
    return Response.json({ code: 0, contact: { contact_id: "2001", contact_type: "vendor", status: "active", currency_code: "AED",
      tax_treatment: "vat_registered", tax_reg_no: "", ...overrides } });
  });
  return { fetcher, connection: new ZohoTransport(getConfig("ZOHO", process.env, "1001"), async () => "fictional-token", fetcher) };
}
beforeEach(() => {
  vi.resetAllMocks(); authorized = true; revoked = false; externalVendorId = "2001"; currentRole = actor.role;
  for (const [key, value] of Object.entries({ APP_ENV: "development", NODE_ENV: "test", APP_URL: "http://127.0.0.1:3000", MANUAL_ENTRY_ONLY: "false",
    INTEGRATION_NETWORK_ENABLED: "true", INTEGRATION_TEST_MODE: "false", ZOHO_BOOKS_NETWORK_ENABLED: "true",
    ZOHO_BOOKS_WRITE_ENABLED: "false", ZOHO_BOOKS_LIVE_ENABLED: "false", ALLOW_PRODUCTION_ACCOUNTING_WRITES: "false",
    ZOHO_BOOKS_DC: "US", ZOHO_BOOKS_ENVIRONMENT: "production", ZOHO_BOOKS_CLIENT_ID: "fictional-client", ZOHO_BOOKS_CLIENT_SECRET: "fictional-secret",
    ZOHO_BOOKS_ORGANIZATIONS_JSON: JSON.stringify([{ organizationId: "1001", name: "Fictional company", mapping: {
      verified: true, baseCurrency: "AED", currencies: { AED: { id: "101" } }, taxes: { "5.00": { id: "401", percentage: "5" }, "0.00": { id: "402", percentage: "0" } }, categories: { MATERIALS: { accountId: "301" } },
    } }]),
  })) vi.stubEnv(key, value);
  store.user.findFirst.mockImplementation(async ({ where }: { where: { role: unknown } }) => authorized && where.role === currentRole ? { id: actor.id } : null);
  store.company.findUnique.mockResolvedValue({ id: "company", active: true, isDemo: false, liveAccountingEnabled: true });
  store.vendor.findFirst.mockResolvedValue({ id: "supplier", companyId: "company", currency: "AED" });
  store.companyIntegrationDestination.findMany.mockResolvedValue([destination]);
  store.vendorBooksMapping.findUnique.mockImplementation(async () => ({ id: "exact-mapping", externalVendorId }));
  store.integrationCredential.findUnique.mockImplementation(async () => ({ organizationId: "1001", dataCenter: "US", revokedAt: revoked ? new Date() : null,
    connectionFingerprint: connectionFingerprint(getConfig("ZOHO", process.env, "1001")) }));
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected provider request"); }));
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("authoritative pre-final-save supplier VAT check", () => {
  it.each([["401", "5.00"], ["402", "0.00"]])("rejects explicit provider VAT %s including zero rate without rewriting source", async (taxId, rate) => {
    const input = source(taxId, rate), before = JSON.stringify(input), remote = transport({ tax_treatment: "vat_not_registered" });
    await expect(prepareBillVendorVatVerification(actor, "company", input, remote.connection)).rejects.toMatchObject({ status: 422, code: "VENDOR_VAT_TREATMENT_MISMATCH" });
    expect(JSON.stringify(input)).toBe(before); expect(remote.fetcher).toHaveBeenCalledTimes(1);
  });
  it("checks a legacy header's exact configured zero-rate tax as VAT", async () => {
    await expect(prepareBillVendorVatVerification(actor, "company", { ...source(), vatRate: "0", lines: [{ booksSelection: null }] },
      transport({ tax_treatment: "vat_not_registered" }).connection)).rejects.toMatchObject({ code: "VENDOR_VAT_TREATMENT_MISMATCH" });
  });
  it("accepts explicit No VAT and consumes the exact proof once without another provider read", async () => {
    const input = source(BOOKS_NO_VAT, "0.00"), remote = transport({ tax_treatment: "vat_not_registered" });
    const proof = await prepareBillVendorVatVerification(actor, "company", input, remote.connection);
    await expect(assertBillVendorVatVerification(store as unknown as Prisma.TransactionClient, actor, "company", input, proof)).resolves.toBeUndefined();
    await expect(assertBillVendorVatVerification(store as unknown as Prisma.TransactionClient, actor, "company", input, proof)).rejects.toMatchObject({ code: "VENDOR_VAT_VERIFICATION_REQUIRED" });
    expect(remote.fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, "overseas", "vat_registered"])("does not infer not-registered from empty TRN or treatment %s", async tax_treatment => {
    await expect(prepareBillVendorVatVerification(actor, "company", source(), transport({ tax_treatment, tax_reg_no: "" }).connection)).resolves.toMatchObject({ kind: "verified-bill-vendor-vat" });
  });
  it.each([{ contact_id: "wrong" }, { contact_type: "customer" }, { status: "inactive" }, { currency_code: "USD" }])("rejects an unverified supplier identity %j", async changed => {
    await expect(prepareBillVendorVatVerification(actor, "company", source(), transport(changed).connection)).rejects.toMatchObject({ code: "VENDOR_VAT_LOOKUP_UNAVAILABLE" });
  });
  it("preserves the draft on provider failure without leaking private diagnostics", async () => {
    const remote = transport(); remote.fetcher.mockRejectedValueOnce(new Error("PRIVATE PROVIDER DIAGNOSTIC"));
    await expect(prepareBillVendorVatVerification(actor, "company", source(), remote.connection)).rejects.toMatchObject({ status: 422, code: "VENDOR_VAT_LOOKUP_UNAVAILABLE", message: expect.stringContaining("draft") });
  });
  it("checks membership again after the slow GET", async () => {
    await expect(prepareBillVendorVatVerification(actor, "company", source(), transport({}, () => { authorized = false; }).connection)).rejects.toMatchObject({ status: 403 });
  });
  it("rechecks revoked membership before returning a provider VAT-conflict detail", async () => {
    await expect(prepareBillVendorVatVerification(actor, "company", source(), transport({ tax_treatment: "vat_not_registered" }, () => { authorized = false; }).connection))
      .rejects.toMatchObject({ status: 403, code: "VENDOR_VAT_ACCESS_CHANGED" });
  });
  it.each(["vendorId", "currency", "billId", "version"] as const)("binds proof to the exact source %s", async field => {
    const input = source(), proof = await prepareBillVendorVatVerification(actor, "company", input, transport().connection);
    const changed = { ...input, [field]: field === "version" ? 4 : "changed" };
    await expect(assertBillVendorVatVerification(store as unknown as Prisma.TransactionClient, actor, "company", changed, proof)).rejects.toThrow();
  });
  it("rejects copied, expired and changed-tax proofs", async () => {
    const input = source(), proof = await prepareBillVendorVatVerification(actor, "company", input, transport().connection);
    await expect(assertBillVendorVatVerification(store as unknown as Prisma.TransactionClient, actor, "company", input, { ...proof! })).rejects.toMatchObject({ code: "VENDOR_VAT_VERIFICATION_REQUIRED" });
    await expect(assertBillVendorVatVerification(store as unknown as Prisma.TransactionClient, actor, "company", source("402", "0.00"), proof)).rejects.toMatchObject({ code: "VENDOR_VAT_VERIFICATION_REQUIRED" });
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 61_000);
    await expect(assertBillVendorVatVerification(store as unknown as Prisma.TransactionClient, actor, "company", input, proof)).rejects.toMatchObject({ code: "VENDOR_VAT_VERIFICATION_REQUIRED" });
  });
  it("accepts server-normalized display names/rate formatting and recalculated header VAT in explicit line mode", async () => {
    const input = source(), proof = await prepareBillVendorVatVerification(actor, "company", { ...input, vatRate: "0.00" }, transport().connection);
    const normalized = { ...input, lines: [{ booksSelection: { ...selection(), accountName: "Canonical account", taxName: "Canonical VAT", taxRate: "5" } }] };
    await expect(assertBillVendorVatVerification(store as unknown as Prisma.TransactionClient, actor, "company", normalized, proof)).resolves.toBeUndefined();
  });
  it.each(["mapping", "grant", "membership"])("rejects changed %s in the final-save transaction", async kind => {
    const input = source(), proof = await prepareBillVendorVatVerification(actor, "company", input, transport().connection);
    if (kind === "mapping") externalVendorId = "2002"; if (kind === "grant") revoked = true; if (kind === "membership") authorized = false;
    await expect(assertBillVendorVatVerification(store as unknown as Prisma.TransactionClient, actor, "company", input, proof)).rejects.toThrow();
  });
  it("requires an exact mapping and current grant before any provider request", async () => {
    store.vendorBooksMapping.findUnique.mockResolvedValueOnce(null);
    const remote = transport(); await expect(prepareBillVendorVatVerification(actor, "company", source(), remote.connection)).rejects.toMatchObject({ code: "VENDOR_VAT_LOOKUP_UNAVAILABLE" });
    expect(remote.fetcher).not.toHaveBeenCalled();
  });
  it.each(["NODE_ENV", "APP_ENV"])("forbids injected supplier transports when %s is production even when their destination matches", async name => {
    const remote = transport(); vi.stubEnv(name, "production");
    await expect(prepareBillVendorVatVerification(actor, "company", source(), remote.connection)).rejects.toMatchObject({ code: "VENDOR_VAT_TEST_TRANSPORT_FORBIDDEN" });
    expect(remote.fetcher).not.toHaveBeenCalled();
  });
  it("invalidates an administrator proof after the current user role changes to Accounts", async () => {
    const admin = { ...actor, role: "ADMIN" as const }; currentRole = "ADMIN";
    const proof = await prepareBillVendorVatVerification(admin, "company", source(), transport().connection);
    currentRole = "ACCOUNTS";
    await expect(assertBillVendorVatVerification(store as unknown as Prisma.TransactionClient, admin, "company", source(), proof)).rejects.toMatchObject({ status: 403, code: "VENDOR_VAT_ACCESS_CHANGED" });
  });
  it("leaves manual-only final saves independent of Books metadata", async () => {
    vi.stubEnv("MANUAL_ENTRY_ONLY", "true");
    expect(await prepareBillVendorVatVerification(actor, "company", source())).toBeUndefined();
    await expect(assertBillVendorVatVerification(store as unknown as Prisma.TransactionClient, actor, "company", source())).resolves.toBeUndefined();
    expect(store.user.findFirst).toHaveBeenCalled();
    expect(store.vendor.findFirst).not.toHaveBeenCalled();
  });
  it.each([{ isDemo: true, liveAccountingEnabled: true }, { isDemo: false, liveAccountingEnabled: false }])("preserves non-operational setup behavior %j without provider access", async policy => {
    store.company.findUnique.mockResolvedValue({ id: "company", active: true, ...policy });
    expect(await prepareBillVendorVatVerification(actor, "company", source())).toBeUndefined();
    await expect(assertBillVendorVatVerification(store as unknown as Prisma.TransactionClient, actor, "company", source())).resolves.toBeUndefined();
    expect(store.vendor.findFirst).not.toHaveBeenCalled();
  });
  it("does not downgrade an enabled real company when its configuration or grant disappears", async () => {
    store.companyIntegrationDestination.findMany.mockResolvedValue([]);
    await expect(prepareBillVendorVatVerification(actor, "company", source())).rejects.toMatchObject({ code: "VENDOR_VAT_LOOKUP_UNAVAILABLE" });
    await expect(assertBillVendorVatVerification(store as unknown as Prisma.TransactionClient, actor, "company", source())).rejects.toMatchObject({ code: "VENDOR_VAT_VERIFICATION_REQUIRED" });
  });
});

it("keeps unknown metadata distinct from explicit not-registered and never exports raw contact details", () => {
  expect(booksVendorVatMetadata({ tax_reg_no: "" }).taxTreatment).toBe("unknown");
  expect(booksVendorVatMetadata({ tax_treatment: "VAT_NOT_REGISTERED" })).toMatchObject({ status: "verified", taxTreatment: "vat_not_registered", warning: expect.stringContaining("original invoice") });
  expect(Object.keys(booksVendorVatMetadata({ tax_treatment: "vat_registered", tax_reg_no: "PRIVATE TRN" }))).not.toContain("tax_reg_no");
});
