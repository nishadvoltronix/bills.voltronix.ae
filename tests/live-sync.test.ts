import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma, type IntegrationJob } from "@prisma/client";
import { createHash } from "node:crypto";
import {
  assertWrite,
  booksConfigurationHash,
  getConfig,
  IntegrationError,
  productionBooksRuntimeReady,
  type ZohoConfig,
} from "@/lib/integrations/config";
import {
  ZohoTransport,
  type Fetch,
  type ProductionWriteGuard,
} from "@/lib/integrations/transport";
import {
  assertLiveJobWrite,
  assertLiveSource,
  assertJobReconciliationAccess,
} from "@/lib/integrations/live-sync";
import {
  approvedSnapshot,
  type BillSource,
} from "@/lib/integrations/source-snapshot";
import {
  booksMappingFingerprint,
  buildBooksPayload,
  snapshotHash,
} from "@/lib/integrations/books";

const store = vi.hoisted(() => ({
  bill: { findUnique: vi.fn() },
  integrationJob: { findUnique: vi.fn() },
  liveSyncAuthorization: { findUnique: vi.fn() },
  user: { findFirst: vi.fn() },
  companyIntegrationDestination: { findFirst: vi.fn() },
  vendorBooksMapping: { findUnique: vi.fn() },
}));
const privateRead = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ db: store }));
vi.mock("@/lib/services/documents", () => ({
  readPrivateDocument: privateRead,
}));

const now = new Date("2026-10-28T12:00:00.000Z");
const mapping = {
  verified: true,
  baseCurrency: "AED",
  currencies: { AED: { id: "101" } },
  taxes: { "5.00": { id: "102", percentage: "5" } },
  categories: { MATERIALS: { accountId: "103" } },
};
function environment(): NodeJS.ProcessEnv {
  // Fictional values are parsed only. No database or provider is contacted.
  return {
    NODE_ENV: "production",
    APP_ENV: "production",
    APP_URL: "https://billing.example.invalid",
    DATABASE_URL:
      "mysql://billing_runtime:fictional@db.example.invalid:3306/billing_operational",
    INTEGRATION_TEST_MODE: "false",
    INTEGRATION_NETWORK_ENABLED: "true",
    ZOHO_BOOKS_WRITE_ENABLED: "true",
    ZOHO_BOOKS_LIVE_ENABLED: "true",
    ALLOW_PRODUCTION_ACCOUNTING_WRITES: "false",
    ZOHO_BOOKS_DC: "US",
    ZOHO_BOOKS_ORGANIZATION_ID: "100",
    ZOHO_BOOKS_ENVIRONMENT: "production",
    ZOHO_BOOKS_CLIENT_ID: "fictional-client",
    ZOHO_BOOKS_CLIENT_SECRET: "fictional-secret",
    ZOHO_BOOKS_MAPPING_JSON: JSON.stringify(mapping),
  };
}
function configuration() {
  return getConfig("ZOHO", environment());
}
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const organization = {
  organization_id: "100",
  is_org_active: true,
  currency_code: "AED",
  currency_id: "101",
};
const body = {
  reference_number: "VX-BILL-fictional-selected-bill",
  vendor_id: "104",
  bill_number: "FICTIONAL-SELECTED-1",
};
const denial = () =>
  new IntegrationError(
    "LIVE_PERMISSION_REQUIRED",
    "Fictional permission denied.",
    "BLOCKED",
  );
function fetcher() {
  return vi.fn<Fetch>(async (url, options) => {
    if (new URL(url).pathname === "/books/v3/organizations/100") {
      expect(options?.method).toBe("GET");
      return response({ code: 0, organization });
    }
    return response({ code: 0, bill: { bill_id: "999" } });
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers().setSystemTime(now);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error(
        "Live network access is forbidden in live-sync unit tests.",
      );
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("production runtime and capability configuration, without live access", () => {
  it("requires the explicit operational runtime before offering live write capability", () => {
    expect(productionBooksRuntimeReady(environment())).toBe(true);
    const settings = configuration();
    expect(settings).toMatchObject({
      environment: "production",
      liveRuntime: true,
      writeEnabled: true,
    });
    expect(() => assertWrite(settings)).not.toThrow();
    for (const patch of [
      { APP_ENV: "test" },
      { APP_ENV: "development" },
      { NODE_ENV: "test" },
      { NODE_ENV: "development" },
      { INTEGRATION_TEST_MODE: "true" },
      { INTEGRATION_TEST_MODE: "" },
    ]) {
      const env = { ...environment(), ...patch } as NodeJS.ProcessEnv;
      expect(productionBooksRuntimeReady(env), JSON.stringify(patch)).toBe(
        false,
      );
      expect(getConfig("ZOHO", env).writeEnabled).toBe(false);
    }
  });

  it.each([
    "http://billing.example.invalid",
    "https://localhost",
    "https://127.0.0.1",
    "https://[::1]",
    "https://billing.localhost",
    "https://operator:fictional@billing.example.invalid",
    "https://billing.example.invalid/",
    "https://billing.example.invalid/path",
    "https://billing.example.invalid?mode=live",
    "https://billing.example.invalid#live",
    "not-a-url",
  ])("refuses unsafe or noncanonical hosted origin %s", (APP_URL) => {
    expect(productionBooksRuntimeReady({ ...environment(), APP_URL })).toBe(
      false,
    );
  });

  it.each([
    "mysql://billing_runtime:fictional@127.0.0.1:3308/billing_operational",
    "mysql://billing_runtime:fictional@localhost:3308/billing_operational",
    "mysql://billing_runtime:fictional@[::1]:3308/billing_operational",
    "mysql://billing_runtime:fictional@db.example.invalid/bills_test_100",
    "mysql://billing_runtime:fictional@db.example.invalid/billing_demo",
    "mysql://billing_runtime:fictional@db.example.invalid/billing_restore",
    "mysql://billing_runtime:fictional@db.example.invalid/billing_fixture",
    "mysql://billing_runtime:fictional@db.example.invalid/billing_sandbox",
    "mysql://billing_runtime:fictional@db.example.invalid/billing_local",
    "mysql://billing_runtime:fictional@db.example.invalid/mysql",
    "mysql://root:fictional@db.example.invalid/billing_operational",
    "mysql://%72oot:fictional@db.example.invalid/billing_operational",
    "mysql://billing_runtime@db.example.invalid/billing_operational",
    "mysql://billing_runtime:fictional@db.example.invalid/billing_operational?host=127.0.0.1",
    "mysql://billing_runtime:fictional@db.example.invalid/billing_operational#test",
    "mysql://billing_runtime:fictional@db.example.invalid/billing%2Fother",
    "postgres://billing_runtime:fictional@db.example.invalid/billing_operational",
    "not-a-url",
  ])("refuses a nonoperational database configuration %s", (DATABASE_URL) => {
    expect(
      productionBooksRuntimeReady({ ...environment(), DATABASE_URL }),
    ).toBe(false);
  });

  it("keeps every enable flag and verified mapping mandatory and rejects malformed profiles", () => {
    for (const key of [
      "INTEGRATION_NETWORK_ENABLED",
      "ZOHO_BOOKS_WRITE_ENABLED",
      "ZOHO_BOOKS_LIVE_ENABLED",
    ]) {
      for (const value of ["false", "", "TRUE"]) {
        expect(
          getConfig("ZOHO", { ...environment(), [key]: value }).writeEnabled,
        ).toBe(false);
      }
    }
    expect(
      getConfig("ZOHO", {
        ...environment(),
        ALLOW_PRODUCTION_ACCOUNTING_WRITES: "true",
      }).writeEnabled,
    ).toBe(false);
    expect(
      getConfig("ZOHO", { ...environment(), ZOHO_BOOKS_MAPPING_JSON: "" })
        .writeEnabled,
    ).toBe(false);
    for (const invalid of [
      "not-json",
      JSON.stringify({ ...mapping, verified: false }),
      JSON.stringify({ ...mapping, extra: "unreviewed" }),
    ]) {
      expect(() =>
        getConfig("ZOHO", {
          ...environment(),
          ZOHO_BOOKS_MAPPING_JSON: invalid,
        }),
      ).toThrow(IntegrationError);
    }
    expect(() =>
      getConfig("ZOHO", {
        ...environment(),
        ZOHO_BOOKS_ORGANIZATIONS_JSON: "not-json",
      }),
    ).toThrow(IntegrationError);
  });

  it("requires explicit organization selection and binds configuration hashes to target and mappings", () => {
    const env = {
      ...environment(),
      ZOHO_BOOKS_ORGANIZATIONS_JSON: JSON.stringify([
        { organizationId: "100", name: "Fictional company one", mapping },
        { organizationId: "200", name: "Fictional company two", mapping },
      ]),
    };
    expect(() => getConfig("ZOHO", env)).toThrow(
      /Select one Books organization/,
    );
    const one = getConfig("ZOHO", env, "100");
    const two = getConfig("ZOHO", env, "200");
    expect(booksConfigurationHash(one)).not.toBe(booksConfigurationHash(two));
    for (const patch of [
      { organizationId: "201" },
      { dataCenter: "EU" },
      { environment: "sandbox" },
      { clientId: "rotated-client" },
      { clientSecret: "rotated-fictional-secret" },
      { booksMapping: { ...one.booksMapping!, baseCurrency: "USD" } },
    ]) {
      expect(
        booksConfigurationHash({ ...one, ...patch } as ZohoConfig),
      ).not.toBe(booksConfigurationHash(one));
    }
  });

  it("can enable Books network access while keeping CRM off, with global disable always winning", () => {
    const env: NodeJS.ProcessEnv = {
      ...environment(),
      ZOHO_CRM_DC: "US",
      ZOHO_CRM_ORGANIZATION_ID: "300",
      ZOHO_CRM_ENVIRONMENT: "production",
      ZOHO_CRM_CLIENT_ID: "fictional-crm-client",
      ZOHO_CRM_CLIENT_SECRET: "fictional-crm-secret",
      ZOHO_BOOKS_NETWORK_ENABLED: "true",
      ZOHO_CRM_NETWORK_ENABLED: "false",
    };
    expect(getConfig("ZOHO", env)).toMatchObject({
      networkEnabled: true,
      writeEnabled: true,
    });
    expect(getConfig("CRM", env)).toMatchObject({
      networkEnabled: false,
      writeEnabled: false,
    });
    expect(
      getConfig("ZOHO", { ...env, INTEGRATION_NETWORK_ENABLED: "false" }),
    ).toMatchObject({ networkEnabled: false, writeEnabled: false });
    expect(
      getConfig("CRM", {
        ...env,
        INTEGRATION_NETWORK_ENABLED: "false",
        ZOHO_CRM_NETWORK_ENABLED: "true",
      }).networkEnabled,
    ).toBe(false);
    expect(
      getConfig("ZOHO", { ...env, ZOHO_BOOKS_NETWORK_ENABLED: "false" }),
    ).toMatchObject({ networkEnabled: false, writeEnabled: false });
    expect(
      getConfig("ZOHO", { ...env, ZOHO_BOOKS_NETWORK_ENABLED: undefined })
        .networkEnabled,
    ).toBe(true);
    expect(
      getConfig("CRM", { ...env, ZOHO_CRM_NETWORK_ENABLED: undefined })
        .networkEnabled,
    ).toBe(true);
  });
});

describe("production POST requires the selected operation permission at transport", () => {
  it("blocks missing permission before reading an organization or obtaining a token", async () => {
    const network = fetcher();
    const token = vi.fn(async () => "fictional-access");
    await expect(
      new ZohoTransport(configuration(), token, network).request(
        "/books/v3/bills",
        { method: "POST", body },
      ),
    ).rejects.toMatchObject({
      code: "LIVE_PERMISSION_REQUIRED",
      kind: "BLOCKED",
    });
    expect(network).not.toHaveBeenCalled();
    expect(token).not.toHaveBeenCalled();
  });

  it("checks the exact operation twice and verifies the organization before each permitted POST", async () => {
    const network = fetcher();
    const guard = vi.fn<ProductionWriteGuard>(async (operation) => {
      if (
        operation.path !== "/books/v3/bills" ||
        JSON.stringify(operation.body) !== JSON.stringify(body) ||
        operation.form
      )
        throw denial();
    });
    const transport = new ZohoTransport(
      configuration(),
      async () => "fictional-access",
      network,
      guard,
    );
    await transport.request("/books/v3/bills", { method: "POST", body });
    expect(guard).toHaveBeenCalledTimes(2);
    expect(guard).toHaveBeenNthCalledWith(1, {
      path: "/books/v3/bills",
      body,
      form: undefined,
    });
    expect(guard).toHaveBeenNthCalledWith(2, {
      path: "/books/v3/bills",
      body,
      form: undefined,
    });
    expect(
      network.mock.calls.map(([url, options]) => [
        new URL(url).pathname,
        options?.method,
      ]),
    ).toEqual([
      ["/books/v3/organizations/100", "GET"],
      ["/books/v3/bills", "POST"],
    ]);
    const [url, options] = network.mock.calls[1];
    expect(new URL(url).searchParams.get("organization_id")).toBe("100");
    expect(options).toMatchObject({
      redirect: "error",
      cache: "no-store",
      body: JSON.stringify(body),
    });
    await transport.request("/books/v3/bills", { method: "POST", body });
    expect(
      network.mock.calls.filter(
        ([url]) => new URL(url).pathname === "/books/v3/organizations/100",
      ),
    ).toHaveLength(2);
  });

  it("denies another bill's body before any network request", async () => {
    const network = fetcher();
    const guard = vi.fn<ProductionWriteGuard>(async (operation) => {
      if (
        (operation.body as typeof body)?.reference_number !==
        body.reference_number
      )
        throw denial();
    });
    await expect(
      new ZohoTransport(
        configuration(),
        async () => "fictional",
        network,
        guard,
      ).request("/books/v3/bills", {
        method: "POST",
        body: { ...body, reference_number: "VX-BILL-another-bill" },
      }),
    ).rejects.toMatchObject({ kind: "BLOCKED" });
    expect(network).not.toHaveBeenCalled();
  });

  it("stops revocation after organization verification before sending the POST", async () => {
    const network = fetcher();
    const guard = vi
      .fn<ProductionWriteGuard>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(denial());
    await expect(
      new ZohoTransport(
        configuration(),
        async () => "fictional",
        network,
        guard,
      ).request("/books/v3/bills", { method: "POST", body }),
    ).rejects.toMatchObject({ kind: "BLOCKED" });
    expect(guard).toHaveBeenCalledTimes(2);
    expect(network.mock.calls.map(([, options]) => options?.method)).toEqual([
      "GET",
    ]);
  });

  it("rechecks permission expiry after token refresh", async () => {
    const expiry = now.getTime() + 60_000;
    const network = fetcher();
    const guard = vi.fn<ProductionWriteGuard>(async () => {
      if (Date.now() >= expiry) throw denial();
    });
    const token = vi.fn(async () => {
      if (token.mock.calls.length === 2) vi.setSystemTime(new Date(expiry));
      return "fictional-access";
    });
    await expect(
      new ZohoTransport(configuration(), token, network, guard).request(
        "/books/v3/bills",
        { method: "POST", body },
      ),
    ).rejects.toMatchObject({ kind: "BLOCKED" });
    expect(token).toHaveBeenCalledTimes(2);
    expect(
      network.mock.calls.every(([, options]) => options?.method === "GET"),
    ).toBe(true);
  });

  it.each([
    { organization_id: "200" },
    { is_org_active: false },
    { currency_code: "USD" },
    { currency_id: "201" },
  ])("blocks mismatched live organization metadata %j", async (patch) => {
    const network = vi.fn<Fetch>(async () =>
      response({ code: 0, organization: { ...organization, ...patch } }),
    );
    const guard = vi.fn<ProductionWriteGuard>(async () => undefined);
    await expect(
      new ZohoTransport(
        configuration(),
        async () => "fictional",
        network,
        guard,
      ).request("/books/v3/bills", { method: "POST", body }),
    ).rejects.toMatchObject({ code: "BOOKS_ORGANIZATION_MISMATCH" });
    expect(network.mock.calls.map(([, options]) => options?.method)).toEqual([
      "GET",
    ]);
  });

  it("binds attachment permission to the exact external bill and form", async () => {
    const network = fetcher();
    const form = new FormData();
    form.set(
      "attachment",
      new Blob(["Fictional original bytes"]),
      "fictional.pdf",
    );
    const guard = vi.fn<ProductionWriteGuard>(async (operation) => {
      if (
        operation.path !== "/books/v3/bills/999/attachment" ||
        operation.form !== form ||
        operation.body
      )
        throw denial();
    });
    const transport = new ZohoTransport(
      configuration(),
      async () => "fictional",
      network,
      guard,
    );
    await transport.request("/books/v3/bills/999/attachment", {
      method: "POST",
      form,
    });
    expect(guard).toHaveBeenCalledTimes(2);
    expect(network.mock.calls[1][1]?.body).toBe(form);
    network.mockClear();
    await expect(
      transport.request("/books/v3/bills/998/attachment", {
        method: "POST",
        form,
      }),
    ).rejects.toMatchObject({ kind: "BLOCKED" });
    expect(network).not.toHaveBeenCalled();
  });

  it("refuses destination overrides, other write endpoints and sandbox authorization bypass", async () => {
    const network = fetcher();
    const guard = vi.fn<ProductionWriteGuard>(async () => undefined);
    const transport = new ZohoTransport(
      configuration(),
      async () => "fictional",
      network,
      guard,
    );
    for (const path of [
      "https://foreign.example/bills",
      "/books/v3/bills/../invoices",
      "/books/v3/invoices",
      "/books/v3/vendorpayments",
    ]) {
      await expect(
        transport.request(path, { method: "POST", body }),
      ).rejects.toBeInstanceOf(IntegrationError);
    }
    await expect(
      transport.request("/books/v3/bills", {
        method: "POST",
        body,
        query: { organization_id: "200" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ENDPOINT" });
    const sandbox = {
      ...configuration(),
      environment: "sandbox" as const,
      writeEnabled: true,
      testAuthorization: undefined,
    };
    await expect(
      new ZohoTransport(
        sandbox,
        async () => "fictional",
        network,
        guard,
      ).request("/books/v3/bills", { method: "POST", body }),
    ).rejects.toMatchObject({ code: "WRITES_DISABLED" });
    expect(network).not.toHaveBeenCalled();
  });

  it("preserves unknown outcome semantics after an authorized POST is interrupted", async () => {
    const network = vi.fn<Fetch>(async (_url, options) => {
      if (options?.method === "GET") return response({ code: 0, organization });
      throw new Error("Fictional interrupted POST");
    });
    const guard = vi.fn<ProductionWriteGuard>(async () => undefined);
    await expect(
      new ZohoTransport(
        configuration(),
        async () => "fictional",
        network,
        guard,
      ).request("/books/v3/bills", { method: "POST", body }),
    ).rejects.toMatchObject({ code: "REQUEST_INTERRUPTED", kind: "UNKNOWN" });
    expect(
      network.mock.calls.filter(([, options]) => options?.method === "POST"),
    ).toHaveLength(1);
  });
});

function selectedOperation() {
  for (const [key, value] of Object.entries(environment()))
    vi.stubEnv(key, value);
  const config = configuration();
  const bill = {
    id: "selected-bill",
    companyId: "selected-company",
    vendorId: "selected-vendor",
    jobId: "selected-job",
    status: "APPROVED",
    version: 3,
    invoiceNumber: "FICTIONAL-SELECTED-1",
    invoiceDate: new Date("2026-10-28T00:00:00Z"),
    dueDate: null,
    orderNumber: null,
    paymentTerms: "NET_30",
    category: "MATERIALS",
    currency: "AED",
    discount: new Prisma.Decimal(0),
    vatRate: new Prisma.Decimal(5),
    subtotal: new Prisma.Decimal(100),
    vatAmount: new Prisma.Decimal(5),
    total: new Prisma.Decimal(105),
    company: {
      id: "selected-company",
      name: "Fictional real-company fixture",
      active: true,
      isDemo: false,
      liveAccountingEnabled: true,
    },
    vendor: {
      id: "selected-vendor",
      name: "Fictional real-vendor fixture",
      companyId: "selected-company",
      isDemo: false,
    },
    job: {
      id: "selected-job",
      companyId: "selected-company",
      isDemo: false,
      jobNumber: "FICTIONAL-1",
      externalCrmId: null,
    },
    lines: [
      {
        description: "Fictional approved material",
        quantity: new Prisma.Decimal(1),
        unitPrice: new Prisma.Decimal(100),
      },
    ],
    documents: [],
  } as unknown as BillSource;
  const snapshot = approvedSnapshot(bill, "104");
  snapshot.destination = {
    dataCenter: "US",
    environment: "production",
    mappingHash: booksMappingFingerprint(config),
    liveAuthorizationId: "selected-permit",
  };
  const job = {
    id: "selected-operation",
    billId: bill.id,
    target: "ZOHO",
    organizationId: "100",
    operation: "CREATE_BILL",
    idempotencyKey: `ZOHO:${bill.id}:CREATE_BILL`,
    status: "PROCESSING",
    leaseToken: "selected-worker-lease",
    leaseUntil: new Date(now.getTime() + 60_000),
    needsReconciliation: false,
    sourceVersion: bill.version,
    snapshot,
    payloadHash: snapshotHash(snapshot),
    externalId: null,
  } as unknown as IntegrationJob;
  const permit = {
    id: "selected-permit",
    purpose: "LIVE",
    localProof: null,
    localProofHash: null,
    actorId: "selected-reviewer",
    billId: bill.id,
    companyId: bill.companyId,
    organizationId: "100",
    dataCenter: "US",
    sourceVersion: bill.version,
    payloadHash: job.payloadHash,
    configurationHash: booksConfigurationHash(config),
    challengeHash: "a".repeat(64),
    createdAt: now,
    confirmedAt: now,
    revokedAt: null,
    canonicalJobId: job.id,
    expiresAt: new Date(now.getTime() + 10 * 60_000),
  };
  store.bill.findUnique.mockResolvedValue(bill);
  store.integrationJob.findUnique.mockImplementation(async ({ where }) =>
    where.id === job.id ? job : null,
  );
  store.liveSyncAuthorization.findUnique.mockResolvedValue(permit);
  store.user.findFirst.mockResolvedValue({ id: permit.actorId });
  store.companyIntegrationDestination.findFirst.mockResolvedValue({
    verificationReference: "FICTIONAL-VERIFIED-1",
  });
  store.vendorBooksMapping.findUnique.mockResolvedValue({
    externalVendorId: "104",
  });
  const operation = {
    path: "/books/v3/bills",
    body: buildBooksPayload(snapshot, config),
  };
  return { bill, config, job, permit, snapshot, operation };
}

describe("selected live operation permission with mocked persisted state", () => {
  it("requires an independent operator-verified company destination and current finance membership", async () => {
    const { bill, config, job, permit, operation } = selectedOperation();
    await expect(
      assertLiveJobWrite(job.id, job.leaseToken!, operation),
    ).resolves.toBeUndefined();
    expect(store.companyIntegrationDestination.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          companyId: bill.companyId,
          target: "ZOHO",
          organizationId: "100",
          dataCenter: "US",
          environment: "production",
          liveEnabled: true,
          verifiedConfigurationHash: booksConfigurationHash(config),
          verifiedAt: { lte: now },
        }),
      }),
    );
    expect(store.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: permit.actorId,
          active: true,
          OR: [{ role: { in: ["ADMIN", "ACCOUNTS"] } }],
          memberships: { some: { companyId: bill.companyId, active: true, company: { active: true } } },
        }),
      }),
    );
    store.companyIntegrationDestination.findFirst.mockResolvedValue(null);
    await expect(
      assertLiveJobWrite(job.id, job.leaseToken!, operation),
    ).rejects.toMatchObject({ kind: "BLOCKED" });
    store.companyIntegrationDestination.findFirst.mockResolvedValue({
      verificationReference: "FICTIONAL-VERIFIED-1",
    });
    store.user.findFirst.mockResolvedValue(null);
    await expect(
      assertLiveJobWrite(job.id, job.leaseToken!, operation),
    ).rejects.toMatchObject({ status: 403 });
  });

  it.each([
    "demo company",
    "inactive company",
    "company disabled for live",
    "demo vendor",
    "demo job",
    "wrong vendor company",
    "wrong job company",
    "pending bill",
  ])("refuses %s regardless of a valid permit", async (scenario) => {
    const { bill, config } = selectedOperation();
    if (scenario === "demo company") bill.company.isDemo = true;
    if (scenario === "inactive company") bill.company.active = false;
    if (scenario === "company disabled for live")
      bill.company.liveAccountingEnabled = false;
    if (scenario === "demo vendor") bill.vendor.isDemo = true;
    if (scenario === "demo job") bill.job.isDemo = true;
    if (scenario === "wrong vendor company")
      bill.vendor.companyId = "another-company";
    if (scenario === "wrong job company")
      bill.job.companyId = "another-company";
    if (scenario === "pending bill") bill.status = "PENDING_APPROVAL";
    await expect(
      assertLiveSource(
        store as unknown as Prisma.TransactionClient,
        bill,
        config,
        "selected-reviewer",
      ),
    ).rejects.toMatchObject({ kind: "BLOCKED" });
  });

  it.each([
    { purpose: "LOCAL_ONE_BILL_TEST" },
    { localProof: { purpose: "LOCAL_ONE_BILL_TEST" } },
    { localProofHash: "a".repeat(64) },
    { revokedAt: now },
    { confirmedAt: null },
    { confirmedAt: new Date(now.getTime() + 1) },
    { expiresAt: now },
    { expiresAt: new Date(now.getTime() + 10 * 60_000 + 1) },
    { billId: "another-bill" },
    { companyId: "another-company" },
    { organizationId: "200" },
    { dataCenter: "EU" },
    { sourceVersion: 2 },
    { payloadHash: "f".repeat(64) },
    { configurationHash: "f".repeat(64) },
    { canonicalJobId: null },
  ])("refuses invalid persisted permission %j", async (patch) => {
    const { job, permit, operation } = selectedOperation();
    store.liveSyncAuthorization.findUnique.mockResolvedValue({
      ...permit,
      ...patch,
    });
    await expect(
      assertLiveJobWrite(job.id, job.leaseToken!, operation),
    ).rejects.toMatchObject({ kind: "BLOCKED" });
  });

  it("refuses a stale writer whose lease was replaced and a different exact job", async () => {
    const { job, operation } = selectedOperation();
    await expect(
      assertLiveJobWrite(job.id, "replaced-worker-lease", operation),
    ).rejects.toMatchObject({ kind: "BLOCKED" });
    await expect(
      assertLiveJobWrite("another-operation", job.leaseToken!, operation),
    ).rejects.toMatchObject({ kind: "BLOCKED" });
    job.leaseUntil = now;
    await expect(
      assertLiveJobWrite(job.id, job.leaseToken!, operation),
    ).rejects.toMatchObject({ kind: "BLOCKED" });
  });

  it("refuses an approved source or supplier mapping that changed after confirmation", async () => {
    const { bill, job, operation } = selectedOperation();
    bill.version++;
    await expect(
      assertLiveJobWrite(job.id, job.leaseToken!, operation),
    ).rejects.toMatchObject({ kind: "BLOCKED" });
    bill.version--;
    store.vendorBooksMapping.findUnique.mockResolvedValue({
      externalVendorId: "204",
    });
    await expect(
      assertLiveJobWrite(job.id, job.leaseToken!, operation),
    ).rejects.toMatchObject({ kind: "BLOCKED" });
  });

  it("refuses outgoing amounts or references that differ from the confirmed snapshot", async () => {
    const { job, operation } = selectedOperation();
    for (const changed of [
      { ...operation.body, reference_number: "VX-BILL-other" },
      { ...operation.body, bill_number: "CHANGED" },
      { ...operation.body, line_items: [] },
    ]) {
      await expect(
        assertLiveJobWrite(job.id, job.leaseToken!, {
          ...operation,
          body: changed,
        }),
      ).rejects.toMatchObject({ kind: "BLOCKED" });
    }
  });

  it.each(["expiry", "revocation", "lease replacement"])(
    "rechecks %s after slow private-original verification",
    async (change) => {
      const { bill, config, job, permit, snapshot, operation } =
        selectedOperation();
      const bytes = Buffer.from(
        "Fictional private original for timing regression",
      );
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      bill.documents.push({
        id: "selected-document",
        fileName: "fictional.pdf",
        mimeType: "application/pdf",
        sha256,
        byteSize: bytes.length,
      } as BillSource["documents"][number]);
      const withDocument = approvedSnapshot(bill, "104");
      withDocument.destination = snapshot.destination;
      job.snapshot = withDocument as unknown as Prisma.JsonValue;
      job.payloadHash = snapshotHash(withDocument);
      permit.payloadHash = job.payloadHash;
      job.leaseUntil = new Date(permit.expiresAt.getTime() + 60_000);
      const originalLease = job.leaseToken!;
      privateRead.mockImplementation(async () => {
        if (change === "expiry") vi.setSystemTime(permit.expiresAt);
        if (change === "revocation")
          store.liveSyncAuthorization.findUnique.mockResolvedValue({
            ...permit,
            revokedAt: now,
          });
        if (change === "lease replacement")
          store.integrationJob.findUnique.mockResolvedValue({
            ...job,
            leaseToken: "replacement-lease",
          });
        return bytes;
      });
      await expect(
        assertLiveJobWrite(job.id, originalLease, {
          ...operation,
          body: buildBooksPayload(withDocument, config),
        }),
      ).rejects.toMatchObject({ kind: "BLOCKED" });
      expect(privateRead).toHaveBeenCalled();
    },
  );
});

function autonomousOperation() {
  const fixture = selectedOperation();
  const { bill, config, job } = fixture;
  bill.status = "READY";
  bill.createdById = "saved-creator";
  const snapshot = approvedSnapshot(bill, "104");
  snapshot.initiatedById = bill.createdById;
  snapshot.destination = { dataCenter: "US", environment: "production", mappingHash: booksMappingFingerprint(config), configurationHash: booksConfigurationHash(config) };
  job.initiatedById = bill.createdById;
  job.snapshot = snapshot as unknown as Prisma.JsonValue;
  job.payloadHash = snapshotHash(snapshot);
  store.integrationJob.findUnique.mockImplementation(async ({ where }) =>
    where.id === job.id || where.idempotencyKey === job.idempotencyKey ? job : null);
  store.user.findFirst.mockResolvedValue({ id: bill.createdById });
  store.liveSyncAuthorization.findUnique.mockClear();
  return { ...fixture, snapshot, operation: { path: "/books/v3/bills", body: buildBooksPayload(snapshot, config) } };
}

describe("final-save autonomous source guard without per-bill approval", () => {
  it("allows scoped read-only reconciliation after mapping changes with writes off, while refusing any POST", async () => {
    const { config, job, operation } = autonomousOperation();
    job.needsReconciliation = true;
    config.writeEnabled = false;
    config.booksMapping!.categories.MATERIALS!.accountId = "999";
    await expect(assertJobReconciliationAccess(job, config)).resolves.toBeUndefined();
    await expect(assertLiveJobWrite(job.id, job.leaseToken!, operation)).rejects.toMatchObject({ kind: "BLOCKED" });
    store.user.findFirst.mockResolvedValue(null);
    await expect(assertJobReconciliationAccess(job, config)).rejects.toMatchObject({ status: 403 });
    expect(store.liveSyncAuthorization.findUnique).not.toHaveBeenCalled();
  });
  it("accepts READY and historical APPROVED using current creator ownership without reading old permissions", async () => {
    const { bill, job, operation } = autonomousOperation();
    await expect(assertLiveJobWrite(job.id, job.leaseToken!, operation)).resolves.toBeUndefined();
    expect(store.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      id: bill.createdById, OR: [{ role: { in: ["ADMIN", "ACCOUNTS"] } }, { id: bill.createdById, role: "DATA_ENTRY" }],
    }) }));
    bill.status = "APPROVED";
    await expect(assertLiveJobWrite(job.id, job.leaseToken!, operation)).resolves.toBeUndefined();
    expect(store.liveSyncAuthorization.findUnique).not.toHaveBeenCalled();
  });
  it("ignores payment-only version increments while refusing changes to exported totals and attachments", async () => {
    const { bill, job, operation } = autonomousOperation();
    bill.version += 1; bill.paidAmount = new Prisma.Decimal(20);
    await expect(assertLiveJobWrite(job.id, job.leaseToken!, operation)).resolves.toBeUndefined();
    bill.invoiceNumber = "CHANGED-AFTER-SAVE";
    await expect(assertLiveJobWrite(job.id, job.leaseToken!, operation)).rejects.toMatchObject({ kind: "BLOCKED" });
  });
  it("rejects actor-marker substitution and current creator access revocation", async () => {
    const { job, operation } = autonomousOperation();
    job.initiatedById = "different-actor";
    await expect(assertLiveJobWrite(job.id, job.leaseToken!, operation)).rejects.toMatchObject({ kind: "BLOCKED" });
    job.initiatedById = "saved-creator";
    store.user.findFirst.mockResolvedValue(null);
    await expect(assertLiveJobWrite(job.id, job.leaseToken!, operation)).rejects.toMatchObject({ status: 403 });
  });
  it("still blocks draft, demo and changed destination state without asking for approval", async () => {
    const { bill, job, operation } = autonomousOperation();
    bill.status = "DRAFT";
    await expect(assertLiveJobWrite(job.id, job.leaseToken!, operation)).rejects.toMatchObject({ kind: "BLOCKED" });
    bill.status = "READY"; bill.company.isDemo = true;
    await expect(assertLiveJobWrite(job.id, job.leaseToken!, operation)).rejects.toMatchObject({ kind: "BLOCKED" });
    bill.company.isDemo = false;
    store.companyIntegrationDestination.findFirst.mockResolvedValue(null);
    await expect(assertLiveJobWrite(job.id, job.leaseToken!, operation)).rejects.toMatchObject({ kind: "BLOCKED" });
    expect(store.liveSyncAuthorization.findUnique).not.toHaveBeenCalled();
  });
});
