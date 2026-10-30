import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BooksAdapter,
  buildBooksPayload,
  snapshotHash,
  type BillSnapshot,
} from "@/lib/integrations/books";
import {
  getConfig,
  IntegrationError,
  retryAt,
  booksTestConfigurationHash,
  type ZohoConfig,
} from "@/lib/integrations/config";
import { ZohoTransport, retryAfterSeconds } from "@/lib/integrations/transport";
import { boundedBytes } from "@/lib/integrations/response";
import {
  accessToken,
  authorizationUrl,
  connectionFingerprint,
  decryptToken,
  encryptToken,
  exchangeToken,
  callbackUrl,
} from "@/lib/integrations/oauth";
import { failureState } from "@/lib/integrations/queue";
import { mapCrmJob, VERIFIED_CRM_JOB_MAPPING } from "@/lib/integrations/crm";

const mockDb = vi.hoisted(() => ({
  integrationCredential: {
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    createMany: vi.fn(),
  },
  auditLog: { create: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
beforeEach(() => vi.stubEnv("ZOHO_BOOKS_ORGANIZATIONS_JSON", ""));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});
function config(overrides: Partial<ZohoConfig> = {}): ZohoConfig {
  const result: ZohoConfig = {
    target: "ZOHO",
    dataCenter: "US",
    accountsOrigin: "https://accounts.zoho.com",
    apiOrigin: "https://www.zohoapis.com",
    organizationId: "100",
    clientId: "fictional-client",
    clientSecret: "fictional-secret",
    environment: "sandbox",
    networkEnabled: true,
    writeEnabled: true,
    booksMapping: {
      verified: true,
      baseCurrency: "AED",
      currencies: { AED: { id: "101" } },
      taxes: { "5.00": { id: "102", percentage: "5" } },
      categories: { MATERIALS: { accountId: "103" } },
    },
    ...overrides,
  };
  result.testAuthorization = {
    mode: "nonproduction",
    organizationId: result.organizationId,
    dataCenter: result.dataCenter,
    configurationHash: booksTestConfigurationHash(result),
    approvedBy: "fictional-test-operator",
    approvalReference: "fixture-approval-100",
    isolationEvidenceReference: "fixture-isolation-100",
    verifiedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  };
  return result;
}
const snapshot: BillSnapshot = {
  internalBillId: "fictional-bill-1",
  sourceVersion: 2,
  invoiceNumber: "FIXTURE-1",
  invoiceDate: "2026-10-01",
  dueDate: null,
  orderNumber: "PO-1",
  paymentTerms: "NET_30",
  category: "MATERIALS",
  currency: "AED",
  discount: "0.00",
  vatRate: "5.00",
  subtotal: "100.00",
  vatAmount: "5.00",
  total: "105.00",
  vendorId: "local-vendor",
  externalVendorId: "104",
  jobId: "local-job",
  jobNumber: "DEMO-JOB",
  externalCrmJobId: "105",
  lines: [
    { description: "Fictional material", quantity: "2", unitPrice: "50.00" },
  ],
  documents: [],
};
function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
const remote = {
  bill_id: "999",
  vendor_id: "104",
  reference_number: "VX-BILL-fictional-bill-1",
  bill_number: "FIXTURE-1",
  currency_code: "AED",
  total: 105,
  tax_total: 5,
};
const organization = {
  organization_id: "100",
  is_org_active: true,
  currency_code: "AED",
  currency_id: "101",
};
function adapter(fetcher: typeof fetch) {
  return new BooksAdapter(
    new ZohoTransport(
      config(),
      async () => "fictional-access-token",
      (url, init) =>
        new URL(url).pathname === "/books/v3/organizations/100"
          ? Promise.resolve(response({ code: 0, organization }))
          : fetcher(url, init),
    ),
  );
}

describe("supplier bill accounting contract", () => {
  it("hashes JSONB key reordering consistently and preserves original legacy snapshot hashes", () => {
    const original = createHash("sha256")
      .update(JSON.stringify(snapshot))
      .digest("hex");
    expect(snapshotHash(snapshot)).toBe(original);
    const withDestination = {
      ...snapshot,
      destination: {
        dataCenter: "US",
        environment: "sandbox" as const,
        mappingHash: "a".repeat(64),
        authorizationReference: "fixture-approval",
      },
    };
    const reordered = Object.fromEntries(
      Object.entries(withDestination).reverse(),
    );
    expect(snapshotHash(reordered as BillSnapshot)).toBe(
      snapshotHash(withDestination),
    );
    expect(snapshotHash({ ...withDestination, total: "999.00" })).not.toBe(
      snapshotHash(withDestination),
    );
  });
  it("maps the supplier bill, source reference, correct account and tax without a customer invoice", () => {
    const payload = buildBooksPayload(snapshot, config());
    expect(payload).toMatchObject({
      vendor_id: "104",
      bill_number: "FIXTURE-1",
      reference_number: "VX-BILL-fictional-bill-1",
      currency_id: "101",
      is_inclusive_tax: false,
      is_item_level_tax_calc: false,
      payment_terms: 30,
      line_items: [{ account_id: "103", tax_id: "102", quantity: 2, rate: 50 }],
    });
    expect(payload).not.toHaveProperty("customer_id");
  });
  it("blocks unverified discounts, missing tax mappings, currency and vendor mappings before POST", () => {
    expect(() =>
      buildBooksPayload({ ...snapshot, discount: "1.00" }, config()),
    ).toThrow(/Discounted/);
    expect(() =>
      buildBooksPayload({ ...snapshot, vatRate: "0" }, config()),
    ).toThrow(/mapping/);
    expect(() =>
      buildBooksPayload({ ...snapshot, externalVendorId: null }, config()),
    ).toThrow(/vendor/);
    expect(() =>
      buildBooksPayload({ ...snapshot, currency: "USD" }, config()),
    ).toThrow(/mapping/);
  });
  it("refuses unmapped LABOUR without substituting a materials or other expense account", () => {
    const selected = config();
    selected.booksMapping!.categories.OTHER = { accountId: "106" };
    expect(() => buildBooksPayload({ ...snapshot, category: "LABOUR" }, selected))
      .toThrowError(expect.objectContaining({ code: "MAPPING_REQUIRED", kind: "BLOCKED" }));
    expect(selected.booksMapping!.categories.LABOUR).toBeUndefined();
  });
  it("reuses a matching remote reference without creating again", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          code: 0,
          bills: [
            { bill_id: "999", reference_number: remote.reference_number },
          ],
          page_context: { has_more_page: false },
        }),
      )
      .mockResolvedValueOnce(response({ code: 0, bill: remote }));
    expect((await adapter(fetcher).create(snapshot)).externalId).toBe("999");
    expect(fetcher.mock.calls.every((call) => call[1].method === "GET")).toBe(
      true,
    );
  });
  it("confirms a new bill by reading the external ID and matching totals", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          code: 0,
          bills: [],
          page_context: { has_more_page: false },
        }),
      )
      .mockResolvedValueOnce(
        response({
          code: 0,
          contact: {
            contact_id: "104",
            contact_type: "vendor",
            currency_code: "AED",
            status: "active",
          },
        }),
      )
      .mockResolvedValueOnce(response({ code: 0, bill: { bill_id: "999" } }))
      .mockResolvedValueOnce(response({ code: 0, bill: remote }));
    expect((await adapter(fetcher).create(snapshot)).externalId).toBe("999");
    expect(
      fetcher.mock.calls.filter((call) => call[1].method === "POST"),
    ).toHaveLength(1);
  });
  it("marks lost post-create confirmation as UNKNOWN, never retryable creation", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          code: 0,
          bills: [],
          page_context: { has_more_page: false },
        }),
      )
      .mockResolvedValueOnce(
        response({
          code: 0,
          contact: {
            contact_id: "104",
            contact_type: "vendor",
            currency_code: "AED",
            status: "active",
          },
        }),
      )
      .mockResolvedValueOnce(response({ code: 0, bill: { bill_id: "999" } }))
      .mockRejectedValueOnce(
        new Error("timeout containing no real credential"),
      );
    await expect(adapter(fetcher).create(snapshot)).rejects.toMatchObject({
      kind: "UNKNOWN",
    });
  });
  it("refuses duplicate references and changed remote amounts", async () => {
    const duplicate = vi.fn().mockResolvedValue(
      response({
        code: 0,
        bills: [
          { bill_id: "999", reference_number: remote.reference_number },
          { bill_id: "998", reference_number: remote.reference_number },
        ],
        page_context: { has_more_page: false },
      }),
    );
    await expect(adapter(duplicate).reconcile(snapshot)).rejects.toMatchObject({
      code: "DUPLICATE_REMOTE_REFERENCE",
    });
    const mismatch = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          code: 0,
          bills: [
            { bill_id: "999", reference_number: remote.reference_number },
          ],
          page_context: { has_more_page: false },
        }),
      )
      .mockResolvedValueOnce(
        response({ code: 0, bill: { ...remote, total: 106 } }),
      );
    await expect(adapter(mismatch).reconcile(snapshot)).rejects.toMatchObject({
      code: "REMOTE_MISMATCH",
      kind: "UNKNOWN",
    });
  });
  it("confirms identical attachment bytes and refuses overwriting different bytes", async () => {
    const bytes = new TextEncoder().encode("fictional PDF bytes");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const same = vi.fn().mockImplementation(async () => new Response(bytes));
    expect(
      await adapter(same).attach("999", {
        bytes,
        fileName: "test.pdf",
        mimeType: "application/pdf",
        sha256,
      }),
    ).toMatchObject({ externalId: "999" });
    expect(same).toHaveBeenCalledTimes(1);
    const different = vi
      .fn()
      .mockImplementation(async () => new Response("different document"));
    await expect(
      adapter(different).attach("999", {
        bytes,
        fileName: "test.pdf",
        mimeType: "application/pdf",
        sha256,
      }),
    ).rejects.toMatchObject({ code: "REMOTE_ATTACHMENT_DIFFERS" });
    expect(different).toHaveBeenCalledTimes(1);
  });
  it("accepts an empty attachment201 only after verifying the stored bytes", async () => {
    const bytes = new TextEncoder().encode("fictional original document");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response({}, 404))
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
      .mockResolvedValueOnce(new Response(bytes));
    expect(
      await adapter(fetcher).attach("999", {
        bytes,
        fileName: "source.pdf",
        mimeType: "application/pdf",
        sha256,
      }),
    ).toMatchObject({ externalId: "999" });
    expect(fetcher.mock.calls.map((call) => call[1].method)).toEqual([
      "GET",
      "POST",
      "GET",
    ]);
  });
});

describe("safe transport and retry boundaries", () => {
  it.each([
    { ...organization, organization_id: "999" },
    { ...organization, is_org_active: false },
    { ...organization, currency_code: "USD" },
    { ...organization, currency_id: "999" },
  ])(
    "refuses a mismatching live organization before a POST: %j",
    async (org) => {
      const fetcher = vi
        .fn()
        .mockResolvedValue(response({ code: 0, organization: org }));
      const transport = new ZohoTransport(
        config(),
        async () => "fictional",
        fetcher,
      );
      await expect(
        transport.request("/books/v3/bills", { method: "POST", body: {} }),
      ).rejects.toMatchObject({ code: "BOOKS_ORGANIZATION_MISMATCH" });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0][1].method).toBe("GET");
    },
  );
  it("rechecks authorization expiry after organization verification and never caches the organization", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
    const settings = config();
    settings.testAuthorization!.expiresAt = new Date(
      Date.now() + 1000,
    ).toISOString();
    const fetcher = vi.fn().mockImplementation(async () => {
      vi.setSystemTime(new Date(Date.now() + 2000));
      return response({ code: 0, organization });
    });
    const transport = new ZohoTransport(
      settings,
      async () => "fictional",
      fetcher,
    );
    await expect(
      transport.request("/books/v3/bills", { method: "POST", body: {} }),
    ).rejects.toMatchObject({ code: "WRITES_DISABLED" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const success = vi
      .fn()
      .mockImplementation(async (url: string | URL) =>
        response(
          new URL(url).pathname.includes("organizations")
            ? { code: 0, organization }
            : { code: 0 },
        ),
      );
    const fresh = new ZohoTransport(config(), async () => "fictional", success);
    await fresh.request("/books/v3/bills", { method: "POST", body: {} });
    await fresh.request("/books/v3/bills", { method: "POST", body: {} });
    expect(
      success.mock.calls.filter((call) => call[1].method === "GET"),
    ).toHaveLength(2);
  });
  it("honors numeric and HTTP-date throttling delays and treats POST408 as uncertain", async () => {
    const now = Date.parse("2026-10-27T12:00:00Z");
    expect(retryAfterSeconds("Tue, 27 Oct 2026 12:02:00 GMT", now)).toBe(120);
    expect(retryAfterSeconds("999999999", now)).toBe(86400);
    expect(retryAfterSeconds("bad-date", now)).toBe(60);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response({ code: 0, organization }))
      .mockResolvedValueOnce(response({}, 408));
    await expect(
      new ZohoTransport(config(), async () => "fictional", fetcher).request(
        "/books/v3/bills",
        { method: "POST", body: {} },
      ),
    ).rejects.toMatchObject({ kind: "UNKNOWN" });
  });
  it("blocks bill creation when search completeness or vendor activation is unproven", async () => {
    const incomplete = vi
      .fn()
      .mockResolvedValue(response({ code: 0, bills: [] }));
    await expect(adapter(incomplete).create(snapshot)).rejects.toMatchObject({
      code: "INVALID_RECONCILIATION",
    });
    expect(incomplete).toHaveBeenCalledTimes(1);
    const inactive = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          code: 0,
          bills: [],
          page_context: { has_more_page: false },
        }),
      )
      .mockResolvedValueOnce(
        response({
          code: 0,
          contact: {
            contact_id: "104",
            contact_type: "vendor",
            currency_code: "AED",
          },
        }),
      );
    await expect(adapter(inactive).create(snapshot)).rejects.toMatchObject({
      code: "VENDOR_MAPPING_MISMATCH",
    });
    expect(inactive.mock.calls.every((call) => call[1].method === "GET")).toBe(
      true,
    );
  });
  it("keeps every real write disabled without explicit approval even with a sandbox label", () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      ZOHO_BOOKS_DC: "US",
      ZOHO_BOOKS_ORGANIZATION_ID: "100",
      ZOHO_BOOKS_CLIENT_ID: "fictional",
      ZOHO_BOOKS_CLIENT_SECRET: "fictional",
      ZOHO_BOOKS_ENVIRONMENT: "sandbox",
      ZOHO_BOOKS_WRITE_ENABLED: "true",
      INTEGRATION_NETWORK_ENABLED: "true",
    };
    expect(getConfig("ZOHO", env).writeEnabled).toBe(false);
    expect(
      getConfig("ZOHO", { ...env, ALLOW_PRODUCTION_ACCOUNTING_WRITES: "true" })
        .writeEnabled,
    ).toBe(false);
  });
  it("rejects origin/path/organization overrides before obtaining credentials", async () => {
    const token = vi.fn();
    const transport = new ZohoTransport(config(), token, vi.fn());
    for (const path of [
      "//attacker.invalid/books/v3/bills",
      "/books/v3/../bills",
      "/books/v3/%2e%2e/bills",
      "/books/v3/bills?organization_id=999",
    ]) {
      await expect(transport.request(path)).rejects.toMatchObject({
        code: "INVALID_ENDPOINT",
      });
    }
    await expect(
      transport.request("/books/v3/bills", {
        query: { organization_id: "999" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ENDPOINT" });
    expect(token).not.toHaveBeenCalled();
  });
  it("distinguishes read timeouts, uncertain write outcomes, revocation and throttling", async () => {
    const failing = new ZohoTransport(
      config(),
      async () => "fictional",
      vi.fn().mockRejectedValue(new Error("private fake content")),
    );
    await expect(failing.request("/books/v3/bills")).rejects.toMatchObject({
      kind: "RETRY",
    });
    const postFailure = new ZohoTransport(
      config(),
      async () => "fictional",
      vi
        .fn()
        .mockResolvedValueOnce(response({ code: 0, organization }))
        .mockRejectedValueOnce(new Error("fictional timeout")),
    );
    await expect(
      postFailure.request("/books/v3/bills", { method: "POST", body: {} }),
    ).rejects.toMatchObject({ kind: "UNKNOWN" });
    const unauthorized = new ZohoTransport(
      config(),
      async () => "fictional",
      vi.fn().mockResolvedValue(response({}, 401)),
    );
    await expect(unauthorized.request("/books/v3/bills")).rejects.toMatchObject(
      { kind: "BLOCKED" },
    );
    const throttled = new ZohoTransport(
      config(),
      async () => "fictional",
      vi
        .fn()
        .mockResolvedValue(
          new Response("", { status: 429, headers: { "retry-after": "120" } }),
        ),
    );
    await expect(throttled.request("/books/v3/bills")).rejects.toMatchObject({
      kind: "RETRY",
      retryAfterSeconds: 120,
    });
  });
  it("limits chunked provider bodies before accepting oversized content", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8));
        controller.enqueue(new Uint8Array(8));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(boundedBytes(new Response(stream), 10)).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
    });
    expect(cancelled).toBe(true);
  });
  it("freezes unknown/reconciliation failures, caps retries and respects backoff", () => {
    expect(
      failureState(
        new IntegrationError("TIMEOUT", "uncertain", "UNKNOWN"),
        1,
        false,
      ),
    ).toEqual({ status: "UNKNOWN", needsReconciliation: true });
    expect(
      failureState(
        new IntegrationError("READ", "unavailable", "RETRY"),
        1,
        true,
      ),
    ).toEqual({ status: "UNKNOWN", needsReconciliation: true });
    expect(
      failureState(new IntegrationError("RATE", "throttled", "RETRY"), 5, false)
        .status,
    ).toBe("FAILED");
    expect(retryAt(1, 120, new Date(0)).getTime()).toBe(120000);
  });
});

describe("OAuth and verified CRM mapping", () => {
  it("persists rotated refresh tokens atomically with the audit and refuses an unencrypted bootstrap", async () => {
    vi.stubEnv("INTEGRATION_TOKEN_ENCRYPTION_KEY", "a".repeat(64));
    const settings = config({ refreshToken: "fictional-bootstrap-refresh" });
    const stored = {
      connectionFingerprint: connectionFingerprint(settings),
      accessTokenEncrypted: null,
      accessExpiresAt: new Date(0),
      refreshTokenEncrypted: encryptToken("fictional-original-refresh"),
      revokedAt: null,
      updatedAt: new Date(0),
    };
    mockDb.integrationCredential.findUnique.mockResolvedValue(stored);
    mockDb.integrationCredential.updateMany.mockResolvedValue({ count: 1 });
    mockDb.$transaction.mockImplementation(async (callback) =>
      callback(mockDb),
    );
    const fetcher = vi.fn().mockImplementation(async () =>
      response({
        access_token: "fictional-fresh-access",
        refresh_token: "fictional-rotated-refresh",
        expires_in: 3600,
        api_domain: settings.apiOrigin,
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    expect(await accessToken(settings)).toBe("fictional-fresh-access");
    const update = mockDb.integrationCredential.updateMany.mock.calls[0][0];
    expect(decryptToken(update.data.refreshTokenEncrypted)).toBe(
      "fictional-rotated-refresh",
    );
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "INTEGRATION_TOKEN_ROTATED" }),
      }),
    );
    mockDb.integrationCredential.findUnique.mockResolvedValue(null);
    mockDb.integrationCredential.createMany.mockResolvedValue({ count: 1 });
    expect(await accessToken(settings)).toBe("fictional-fresh-access");
    const create = mockDb.integrationCredential.createMany.mock.calls[0][0];
    expect(decryptToken(create.data.refreshTokenEncrypted)).toBe(
      "fictional-rotated-refresh",
    );
    expect(create.skipDuplicates).toBe(true);
    vi.stubEnv("INTEGRATION_TOKEN_ENCRYPTION_KEY", "");
    fetcher.mockClear();
    await expect(
      accessToken({ ...settings, refreshToken: "fictional-another-bootstrap" }),
    ).rejects.toMatchObject({ code: "TOKEN_STORAGE_UNAVAILABLE" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("refreshes expired credentials once and compares the stored revision before accepting the token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
    vi.stubEnv("INTEGRATION_TOKEN_ENCRYPTION_KEY", "a".repeat(64));
    const settings = config();
    const updatedAt = new Date(Date.now() - 10000);
    mockDb.integrationCredential.findUnique.mockResolvedValue({
      connectionFingerprint: connectionFingerprint(settings),
      accessTokenEncrypted: encryptToken("fictional-expired-access"),
      accessExpiresAt: new Date(Date.now() - 1),
      refreshTokenEncrypted: encryptToken("fictional-expired-refresh"),
      revokedAt: null,
      updatedAt,
    });
    mockDb.integrationCredential.updateMany.mockResolvedValue({ count: 1 });
    const fetcher = vi.fn().mockResolvedValue(
      response({
        access_token: "fictional-renewed-access",
        expires_in: 3600,
        api_domain: settings.apiOrigin,
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    expect(
      await Promise.all([accessToken(settings), accessToken(settings)]),
    ).toEqual(["fictional-renewed-access", "fictional-renewed-access"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(mockDb.integrationCredential.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          updatedAt,
          revokedAt: null,
          connectionFingerprint: connectionFingerprint(settings),
        }),
      }),
    );
    mockDb.integrationCredential.updateMany.mockResolvedValue({ count: 0 });
    fetcher.mockResolvedValue(
      response({
        access_token: "fictional-revoked-refresh-result",
        expires_in: 3600,
        api_domain: settings.apiOrigin,
      }),
    );
    await expect(accessToken(settings)).rejects.toMatchObject({
      code: "OAUTH_REAUTHORIZE",
    });
  });
  it("refuses expired OAuth grants and credential-bearing/non-HTTP callback origins", async () => {
    vi.stubEnv("APP_URL", "ftp://localhost:3000");
    expect(() => callbackUrl("ZOHO")).toThrow(/HTTPS/);
    vi.stubEnv("APP_URL", "https://user:secret@example.invalid");
    expect(() => callbackUrl("ZOHO")).toThrow(/HTTPS/);
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        response(
          { error: "invalid_grant", message: "fictional-provider-secret" },
          400,
        ),
      );
    await expect(
      exchangeToken(config(), { refreshToken: "fictional-refresh" }, fetcher),
    ).rejects.toMatchObject({ code: "OAUTH_REAUTHORIZE", kind: "BLOCKED" });
  });
  it("uses offline scopes and binds encrypted tokens to a dedicated server key", () => {
    vi.stubEnv("APP_URL", "http://127.0.0.1:3000");
    vi.stubEnv("INTEGRATION_TOKEN_ENCRYPTION_KEY", "a".repeat(64));
    const encrypted = encryptToken("fictional-refresh-token");
    expect(encrypted).not.toContain("fictional");
    expect(decryptToken(encrypted)).toBe("fictional-refresh-token");
    vi.stubEnv("INTEGRATION_TOKEN_ENCRYPTION_KEY", "b".repeat(64));
    expect(() => decryptToken(encrypted)).toThrow(/decrypt/);
    const url = new URL(authorizationUrl(config(), "fictional-state"));
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("scope")?.split(",")).toEqual([
      "ZohoBooks.bills.CREATE",
      "ZohoBooks.bills.READ",
      "ZohoBooks.contacts.READ",
      "ZohoBooks.settings.READ",
      "ZohoBooks.accountants.READ",
      "ZohoBooks.projects.READ",
    ]);
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:3000/api/integrations/oauth/zoho/callback",
    );
  });
  it("rejects token API data-center mismatches and hides provider secrets in errors", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      response({
        access_token: "fictional-access",
        expires_in: 3600,
        api_domain: "https://attacker.invalid",
      }),
    );
    await expect(
      exchangeToken(config(), { refreshToken: "fictional-refresh" }, fetcher),
    ).rejects.toMatchObject({ code: "OAUTH_DC_MISMATCH" });
  });
  it("checks revocation and connection rotation before reusing a stored access token", async () => {
    vi.stubEnv("INTEGRATION_TOKEN_ENCRYPTION_KEY", "a".repeat(64));
    const settings = config();
    const stored = {
      target: "ZOHO",
      dataCenter: "US",
      connectionFingerprint: connectionFingerprint(settings),
      accessTokenEncrypted: encryptToken("fictional-access"),
      accessExpiresAt: new Date(Date.now() + 3600000),
      refreshTokenEncrypted: encryptToken("fictional-refresh"),
      revokedAt: null,
      updatedAt: new Date(),
    };
    mockDb.integrationCredential.findUnique.mockResolvedValue(stored);
    expect(await accessToken(settings)).toBe("fictional-access");
    mockDb.integrationCredential.findUnique.mockResolvedValue({
      ...stored,
      revokedAt: new Date(),
    });
    await expect(accessToken(settings)).rejects.toMatchObject({
      code: "OAUTH_REAUTHORIZE",
    });
    mockDb.integrationCredential.findUnique.mockResolvedValue(stored);
    await expect(
      accessToken({ ...settings, organizationId: "999" }),
    ).rejects.toMatchObject({ code: "OAUTH_REAUTHORIZE" });
  });
  it("maps confirmed CRM job fields, preserving missing contract values", () => {
    const record = {
      id: "200",
      JobDealNumber: " vx-101 ",
      Deal_Name: "Fictional job",
      Amount: null,
      Account_Name: { id: "201", name: "Fictional customer" },
      Currency: "AED",
    };
    expect(mapCrmJob(record, VERIFIED_CRM_JOB_MAPPING)).toMatchObject({
      jobNumber: "VX-101",
      contractValue: null,
      approvedVariations: "0.00",
      externalCrmId: "200",
    });
    expect(
      mapCrmJob({ ...record, Amount: "1200.25" }, VERIFIED_CRM_JOB_MAPPING)
        .contractValue,
    ).toBe("1200.25");
    expect(() =>
      mapCrmJob(record, {
        ...VERIFIED_CRM_JOB_MAPPING,
        approvedVariationsField: "Approved_Variations",
      }),
    ).toThrow(/approved-variations/);
  });
});
