import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
import { getConfig } from "@/lib/integrations/config";
import { ZohoTransport, type Fetch } from "@/lib/integrations/transport";
import { importBooksSuppliers } from "@/lib/services/books-supplier-setup";

const store = vi.hoisted(() => ({
  user: { findFirst: vi.fn() },
  company: { findUnique: vi.fn() },
  companyIntegrationDestination: { findFirst: vi.fn() },
  vendor: { findFirst: vi.fn(), create: vi.fn() },
  vendorBooksMapping: { findUnique: vi.fn(), create: vi.fn() },
  auditLog: { create: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: store }));
vi.mock("@/lib/integrations/oauth", () => ({
  accessToken: vi.fn(async () => "fictional-token"),
}));

const actor: Actor = {
  id: "operator",
  name: "Fictional operator",
  email: "operator@example.invalid",
  role: "ADMIN",
};
const input = {
  companyId: "operating-company",
  organizationId: "1001",
  externalVendorIds: ["2001"],
  reference: "SUPPLIER-REVIEW-2026-10-29",
};
const environment: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  APP_ENV: "production",
  APP_URL: "https://billing.example.invalid",
  DATABASE_URL:
    "mysql://billing_runtime:fictional@database.example.invalid:3306/billing_operational",
  INTEGRATION_TEST_MODE: "false",
  INTEGRATION_NETWORK_ENABLED: "true",
  ZOHO_BOOKS_NETWORK_ENABLED: "true",
  ZOHO_BOOKS_WRITE_ENABLED: "false",
  ZOHO_BOOKS_LIVE_ENABLED: "false",
  ALLOW_PRODUCTION_ACCOUNTING_WRITES: "false",
  ALLOW_BOOKS_SUPPLIER_SETUP: "true",
  ZOHO_BOOKS_DC: "US",
  ZOHO_BOOKS_ENVIRONMENT: "production",
  ZOHO_BOOKS_CLIENT_ID: "fictional-client",
  ZOHO_BOOKS_CLIENT_SECRET: "fictional-secret",
  ZOHO_BOOKS_ORGANIZATIONS_JSON: JSON.stringify([
    {
      organizationId: "1001",
      name: "Fictional operating company",
      mapping: {
        verified: true,
        baseCurrency: "AED",
        currencies: { AED: { id: "101" } },
        taxes: { "5.00": { id: "102", percentage: "5" } },
        categories: { MATERIALS: { accountId: "103" } },
      },
    },
  ]),
};
const company = { id: input.companyId, active: true, isDemo: false };
type Vendor = {
  id: string;
  companyId: string;
  name: string;
  currency: string;
  isDemo: boolean;
  externalZohoId: string | null;
};
type Mapping = {
  id: string;
  vendorId: string;
  organizationId: string;
  dataCenter: string;
  environment: string;
  externalVendorId: string;
};
let vendors: Vendor[];
let mappings: Mapping[];
let events: unknown[];
let transactionActive: boolean;

function contact(id = "2001") {
  return {
    code: 0,
    contact: {
      contact_id: id,
      contact_name: "Fictional supplier",
      contact_type: "vendor",
      status: "active",
      currency_id: "101",
      currency_code: "AED",
      email: "private-supplier@example.invalid",
      outstanding_payable_amount: "123.45",
    },
  };
}
function connection(
  rows: Record<string, unknown> = { "2001": contact() },
  onRead?: () => void,
) {
  const fetcher = vi.fn<Fetch>(async (url, options) => {
    expect(options?.method).toBe("GET");
    const address = new URL(url);
    expect(address.searchParams.get("organization_id")).toBe(
      input.organizationId,
    );
    expect(address.pathname).toMatch(/^\/books\/v3\/contacts\/\d+$/);
    const id = address.pathname.split("/").at(-1)!;
    if (!(id in rows)) throw new Error("Unexpected supplier lookup");
    onRead?.();
    return new Response(JSON.stringify(rows[id]), { status: 200 });
  });
  return {
    transport: new ZohoTransport(
      getConfig("ZOHO", process.env, input.organizationId),
      async () => "fictional-token",
      fetcher,
    ),
    fetcher,
  };
}
function existing(
  overrides: Partial<Vendor> = {},
  mappingOverrides: Partial<Mapping> = {},
) {
  const vendor = {
    id: "existing-vendor",
    companyId: input.companyId,
    name: "Locally reviewed supplier name",
    currency: "AED",
    isDemo: false,
    externalZohoId: null,
    ...overrides,
  };
  vendors.push(vendor);
  mappings.push({
    id: "existing-mapping",
    vendorId: vendor.id,
    organizationId: input.organizationId,
    dataCenter: "US",
    environment: "production",
    externalVendorId: "2001",
    ...mappingOverrides,
  });
  return vendor;
}

beforeEach(() => {
  vi.resetAllMocks();
  for (const [key, value] of Object.entries(environment))
    vi.stubEnv(key, value);
  vendors = [];
  mappings = [];
  events = [];
  transactionActive = false;
  store.user.findFirst.mockResolvedValue({ id: actor.id });
  store.company.findUnique.mockResolvedValue(company);
  store.companyIntegrationDestination.findFirst.mockResolvedValue({
    companyId: input.companyId,
  });
  store.vendor.findFirst.mockImplementation(
    async ({
      where,
    }: {
      where: { companyId: string; externalZohoId?: string; name?: string };
    }) =>
      vendors.find(
        (vendor) =>
          vendor.companyId === where.companyId &&
          (where.externalZohoId !== undefined
            ? vendor.externalZohoId === where.externalZohoId
            : vendor.name.toLowerCase() === where.name?.toLowerCase()),
      ) ?? null,
  );
  store.vendorBooksMapping.findUnique.mockImplementation(
    async ({
      where,
    }: {
      where: {
        organizationId_dataCenter_environment_externalVendorId: Omit<
          Mapping,
          "id" | "vendorId"
        >;
      };
    }) => {
      const selected =
        where.organizationId_dataCenter_environment_externalVendorId;
      const mapping = mappings.find(
        (item) =>
          item.organizationId === selected.organizationId &&
          item.dataCenter === selected.dataCenter &&
          item.environment === selected.environment &&
          item.externalVendorId === selected.externalVendorId,
      );
      return mapping
        ? {
            ...mapping,
            vendor: vendors.find((vendor) => vendor.id === mapping.vendorId)!,
          }
        : null;
    },
  );
  store.vendor.create.mockImplementation(
    async ({ data }: { data: Omit<Vendor, "id" | "externalZohoId"> }) => {
      expect(transactionActive).toBe(true);
      const vendor = {
        ...data,
        id: `created-vendor-${vendors.length + 1}`,
        externalZohoId: null,
      };
      vendors.push(vendor);
      return { id: vendor.id };
    },
  );
  store.vendorBooksMapping.create.mockImplementation(
    async ({ data }: { data: Omit<Mapping, "id"> }) => {
      expect(transactionActive).toBe(true);
      const mapping = { ...data, id: `created-mapping-${mappings.length + 1}` };
      mappings.push(mapping);
      return { id: mapping.id };
    },
  );
  store.auditLog.create.mockImplementation(
    async ({ data }: { data: unknown }) => {
      expect(transactionActive).toBe(true);
      events.push(data);
      return {};
    },
  );
  store.$transaction.mockImplementation(
    async (
      action: (tx: typeof store) => Promise<unknown>,
      options: unknown,
    ) => {
      expect(options).toEqual({
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 20_000,
      });
      const before = {
        vendors: structuredClone(vendors),
        mappings: structuredClone(mappings),
        events: structuredClone(events),
      };
      transactionActive = true;
      try {
        return await action(store);
      } catch (error) {
        vendors = before.vendors;
        mappings = before.mappings;
        events = before.events;
        throw error;
      } finally {
        transactionActive = false;
      }
    },
  );
});
afterEach(() => vi.unstubAllEnvs());

describe("trusted Books supplier setup", () => {
  it("fetches only selected exact active suppliers and creates scoped local identities atomically", async () => {
    const { transport, fetcher } = connection();
    const result = await importBooksSuppliers(actor, input, transport);
    expect(result).toMatchObject({
      selected: 1,
      created: 1,
      reused: 0,
      providerReads: 1,
      providerFinancialWrites: 0,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vendors).toEqual([
      {
        id: "created-vendor-1",
        companyId: input.companyId,
        name: "Fictional supplier",
        currency: "AED",
        isDemo: false,
        externalZohoId: null,
      },
    ]);
    expect(mappings).toEqual([
      {
        id: "created-mapping-1",
        vendorId: "created-vendor-1",
        organizationId: "1001",
        dataCenter: "US",
        environment: "production",
        externalVendorId: "2001",
      },
    ]);
    expect(events).toHaveLength(1);
    const publicResult = JSON.stringify(result);
    expect(publicResult).not.toContain("Fictional supplier");
    expect(publicResult).not.toContain("private-supplier");
    expect(JSON.stringify(vendors)).not.toContain("123.45");
    expect(store.user.findFirst).toHaveBeenCalledTimes(2);
    expect(store.user.findFirst.mock.calls[1][0].where).toMatchObject({
      active: true,
      role: "ADMIN",
      memberships: { some: { companyId: input.companyId, active: true } },
    });
  });

  it("repeated import reuses the same exact mapping without rewriting local identity or adding records", async () => {
    await importBooksSuppliers(actor, input, connection().transport);
    vendors[0].name = "Reviewed local name";
    const result = await importBooksSuppliers(
      actor,
      input,
      connection().transport,
    );
    expect(result).toMatchObject({
      created: 0,
      reused: 1,
      suppliers: [
        {
          vendorId: "created-vendor-1",
          mappingId: "created-mapping-1",
          created: false,
        },
      ],
    });
    expect(vendors).toHaveLength(1);
    expect(vendors[0].name).toBe("Reviewed local name");
    expect(mappings).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it.each([
    [],
    ["2001", "2001"],
    ["../bills"],
    Array.from({ length: 26 }, (_, index) => String(index + 1)),
  ])(
    "rejects unbounded, duplicate or malformed selections before provider access: %j",
    async (externalVendorIds) => {
      const { transport, fetcher } = connection();
      await expect(
        importBooksSuppliers(actor, { ...input, externalVendorIds }, transport),
      ).rejects.toThrow();
      expect(fetcher).not.toHaveBeenCalled();
      expect(store.$transaction).not.toHaveBeenCalled();
    },
  );

  it.each([
    "role",
    "revoked-admin",
    "demo-company",
    "wrong-company",
    "missing-destination",
  ])("rejects %s context before reading supplier records", async (mode) => {
    const { transport, fetcher } = connection();
    if (mode === "revoked-admin") store.user.findFirst.mockResolvedValue(null);
    if (mode === "demo-company")
      store.company.findUnique.mockResolvedValue({ ...company, isDemo: true });
    if (mode === "wrong-company")
      store.companyIntegrationDestination.findFirst.mockResolvedValue({
        companyId: "other-company",
      });
    if (mode === "missing-destination")
      store.companyIntegrationDestination.findFirst.mockResolvedValue(null);
    await expect(
      importBooksSuppliers(
        mode === "role" ? { ...actor, role: "ACCOUNTS" } : actor,
        input,
        transport,
      ),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(vendors).toHaveLength(0);
  });

  it.each([
    "disabled-setup",
    "development",
    "write-enabled",
    "missing-write-flag",
  ])("refuses unsafe %s environment before provider access", async (mode) => {
    const { transport, fetcher } = connection();
    if (mode === "disabled-setup")
      vi.stubEnv("ALLOW_BOOKS_SUPPLIER_SETUP", "false");
    if (mode === "development") vi.stubEnv("APP_ENV", "development");
    if (mode === "write-enabled")
      vi.stubEnv("ZOHO_BOOKS_WRITE_ENABLED", "true");
    if (mode === "missing-write-flag")
      vi.stubEnv("ZOHO_BOOKS_LIVE_ENABLED", undefined);
    await expect(
      importBooksSuppliers(actor, input, transport),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(store.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    "wrong-id",
    "customer",
    "inactive",
    "malformed",
    "missing-name",
    "wrong-currency",
    "wrong-currency-id",
  ])("rejects %s provider metadata before local creation", async (mode) => {
    const response = contact();
    if (mode === "wrong-id") response.contact.contact_id = "9999";
    if (mode === "customer") response.contact.contact_type = "customer";
    if (mode === "inactive") response.contact.status = "inactive";
    if (mode === "missing-name") response.contact.contact_name = " ";
    if (mode === "wrong-currency") response.contact.currency_code = "USD";
    if (mode === "wrong-currency-id") response.contact.currency_id = "9999";
    await expect(
      importBooksSuppliers(
        actor,
        input,
        connection({ "2001": mode === "malformed" ? { code: 0 } : response })
          .transport,
      ),
    ).rejects.toThrow();
    expect(store.$transaction).not.toHaveBeenCalled();
    expect(vendors).toHaveLength(0);
  });

  it("validates every provider contact before starting the atomic batch", async () => {
    await expect(
      importBooksSuppliers(
        actor,
        { ...input, externalVendorIds: ["2001", "2002"] },
        connection({ "2001": contact(), "2002": { code: 0 } }).transport,
      ),
    ).rejects.toThrow();
    expect(store.$transaction).not.toHaveBeenCalled();
    expect(vendors).toHaveLength(0);
  });

  it.each([
    "other-company",
    "changed-currency",
    "demo-vendor",
    "conflicting-legacy-id",
  ])("preserves an existing mapping with %s conflict", async (mode) => {
    existing(
      mode === "other-company"
        ? { companyId: "other-company" }
        : mode === "changed-currency"
          ? { currency: "USD" }
          : mode === "demo-vendor"
            ? { isDemo: true }
            : { externalZohoId: "9999" },
    );
    const before = structuredClone({ vendors, mappings });
    await expect(
      importBooksSuppliers(actor, input, connection().transport),
    ).rejects.toMatchObject({ code: "SUPPLIER_IDENTITY_CONFLICT" });
    expect({ vendors, mappings }).toEqual(before);
    expect(store.vendor.create).not.toHaveBeenCalled();
  });

  it("does not adopt an unmapped legacy external ID or match a supplier by name", async () => {
    vendors.push({
      id: "legacy-vendor",
      companyId: input.companyId,
      name: "Fictional supplier",
      currency: "AED",
      isDemo: false,
      externalZohoId: "2001",
    });
    await expect(
      importBooksSuppliers(actor, input, connection().transport),
    ).rejects.toMatchObject({ code: "SUPPLIER_IDENTITY_CONFLICT" });
    expect(mappings).toHaveLength(0);
    expect(vendors).toHaveLength(1);
  });

  it("rejects an existing unmapped same-company name without duplicating or adopting the supplier", async () => {
    vendors.push({
      id: "manual-vendor",
      companyId: input.companyId,
      name: "Fictional supplier",
      currency: "AED",
      isDemo: false,
      externalZohoId: null,
    });
    const before = structuredClone(vendors);
    await expect(
      importBooksSuppliers(actor, input, connection().transport),
    ).rejects.toMatchObject({ code: "SUPPLIER_NAME_CONFLICT" });
    expect(vendors).toEqual(before);
    expect(mappings).toHaveLength(0);
    expect(events).toHaveLength(0);
    expect(store.vendor.create).not.toHaveBeenCalled();
  });

  it("rolls back the whole batch when a later supplier has the same name as its first new supplier", async () => {
    await expect(
      importBooksSuppliers(
        actor,
        { ...input, externalVendorIds: ["2001", "2002"] },
        connection({ "2001": contact(), "2002": contact("2002") }).transport,
      ),
    ).rejects.toMatchObject({ code: "SUPPLIER_NAME_CONFLICT" });
    expect(store.vendor.create).toHaveBeenCalledTimes(1);
    expect(vendors).toHaveLength(0);
    expect(mappings).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("permits the same supplier name in a different company without adopting its local record", async () => {
    vendors.push({
      id: "other-company-vendor",
      companyId: "other-company",
      name: "Fictional supplier",
      currency: "AED",
      isDemo: false,
      externalZohoId: null,
    });
    const result = await importBooksSuppliers(
      actor,
      input,
      connection().transport,
    );
    expect(result.created).toBe(1);
    expect(result.suppliers[0].vendorId).not.toBe("other-company-vendor");
    expect(vendors).toHaveLength(2);
  });

  it.each(["admin", "company", "destination", "configuration", "write-flags"])(
    "rechecks %s after provider reads and before committing",
    async (mode) => {
      const { transport } = connection(undefined, () => {
        if (mode === "admin") store.user.findFirst.mockResolvedValue(null);
        if (mode === "company")
          store.company.findUnique.mockResolvedValue({
            ...company,
            active: false,
          });
        if (mode === "destination")
          store.companyIntegrationDestination.findFirst.mockResolvedValue({
            companyId: "other-company",
          });
        if (mode === "configuration")
          vi.stubEnv("ZOHO_BOOKS_CLIENT_SECRET", "changed-fixture-secret");
        if (mode === "write-flags")
          vi.stubEnv("ZOHO_BOOKS_LIVE_ENABLED", "true");
      });
      await expect(
        importBooksSuppliers(actor, input, transport),
      ).rejects.toThrow();
      expect(vendors).toHaveLength(0);
      expect(mappings).toHaveLength(0);
      expect(events).toHaveLength(0);
    },
  );

  it("rolls back a new vendor if a concurrent unique mapping collision prevents its mapping", async () => {
    store.vendorBooksMapping.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Fictional unique collision", {
        code: "P2002",
        clientVersion: "fixture",
      }),
    );
    await expect(
      importBooksSuppliers(actor, input, connection().transport),
    ).rejects.toMatchObject({ code: "P2002" });
    expect(store.vendor.create).toHaveBeenCalledTimes(1);
    expect(vendors).toHaveLength(0);
    expect(mappings).toHaveLength(0);
    expect(events).toHaveLength(0);
  });
});
