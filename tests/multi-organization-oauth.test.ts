import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
const mockDb = vi.hoisted(() => ({
  companyIntegrationDestination: { findFirst: vi.fn() },
  integrationCredential: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    createMany: vi.fn(),
    updateMany: vi.fn(),
  },
  integrationOAuthState: {
    create: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  auditLog: { create: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
import {
  booksTestConfigurationHash,
  getBooksOrganizations,
  getConfig,
  type BooksMapping,
} from "@/lib/integrations/config";
import {
  accessToken,
  beginOAuth,
  callbackUrl,
  completeOAuth,
  connectionFingerprint,
  decryptToken,
  encryptToken,
  LEGACY_UNSCOPED_ORGANIZATION,
} from "@/lib/integrations/oauth";
import { integrationStatus } from "@/lib/services/integrations";

const actor: Actor = {
  id: "fictional-admin",
  name: "Fixture Admin",
  email: "fixture@example.invalid",
  role: "ADMIN",
};
const profiles = [
  { organizationId: "100", name: "Fictional Company A" },
  { organizationId: "200", name: "Fictional Company B" },
];
const mapping: BooksMapping = {
  verified: true,
  baseCurrency: "AED",
  currencies: { AED: { id: "101" } },
  taxes: { "5.00": { id: "102", percentage: "5" } },
  categories: { MATERIALS: { accountId: "103" } },
};
type StateRecord = {
  tokenHash: string;
  target: string;
  organizationId: string;
  userId: string;
  dataCenter: string;
  connectionFingerprint: string;
  expiresAt: Date;
  consumedAt: Date | null;
};
const states = new Map<string, StateRecord>();
function environment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    APP_URL: "http://127.0.0.1:3000",
    INTEGRATION_TOKEN_ENCRYPTION_KEY: "a".repeat(64),
    ZOHO_BOOKS_DC: "US",
    ZOHO_BOOKS_ENVIRONMENT: "production",
    ZOHO_BOOKS_CLIENT_ID: "fictional-client",
    ZOHO_BOOKS_CLIENT_SECRET: "fictional-secret",
    ZOHO_BOOKS_ORGANIZATIONS_JSON: JSON.stringify(profiles),
    ZOHO_BOOKS_ORGANIZATION_ID: "",
    ZOHO_BOOKS_MAPPING_JSON: "",
    ZOHO_BOOKS_TEST_AUTHORIZATION_JSON: "",
    ZOHO_BOOKS_REFRESH_TOKEN: "",
    ZOHO_BOOKS_REFRESH_TOKENS_JSON: "",
    ZOHO_BOOKS_WRITE_ENABLED: "false",
    INTEGRATION_TEST_MODE: "false",
    ALLOW_PRODUCTION_ACCOUNTING_WRITES: "false",
    INTEGRATION_NETWORK_ENABLED: "true",
    ZOHO_CRM_DC: "",
    ZOHO_CRM_ORGANIZATION_ID: "",
    ZOHO_CRM_CLIENT_ID: "",
    ZOHO_CRM_CLIENT_SECRET: "",
    ZOHO_CRM_ENVIRONMENT: "",
    OCR_PROVIDER: "disabled",
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  mockDb.companyIntegrationDestination.findFirst.mockResolvedValue({ companyId: "fictional-company" });
  states.clear();
  for (const [key, value] of Object.entries(environment()))
    vi.stubEnv(key, value);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected network request");
    }),
  );
  mockDb.integrationCredential.findUnique.mockResolvedValue(null);
  mockDb.integrationCredential.upsert.mockResolvedValue({});
  mockDb.integrationOAuthState.deleteMany.mockResolvedValue({ count: 0 });
  mockDb.integrationOAuthState.create.mockImplementation(
    async ({ data }: { data: StateRecord }) => {
      states.set(data.tokenHash, { ...data, consumedAt: null });
      return data;
    },
  );
  mockDb.integrationOAuthState.findUnique.mockImplementation(
    async ({ where }: { where: { tokenHash: string } }) =>
      states.get(where.tokenHash) ?? null,
  );
  mockDb.integrationOAuthState.updateMany.mockImplementation(
    async ({
      where,
      data,
    }: {
      where: Omit<StateRecord, "expiresAt"> & { expiresAt: { gt: Date } };
      data: { consumedAt: Date };
    }) => {
      const row = states.get(where.tokenHash);
      if (
        !row ||
        row.consumedAt ||
        row.expiresAt <= where.expiresAt.gt ||
        [
          "target",
          "organizationId",
          "userId",
          "dataCenter",
          "connectionFingerprint",
        ].some(
          (key) =>
            row[key as keyof StateRecord] !== where[key as keyof typeof where],
        )
      )
        return { count: 0 };
      row.consumedAt = data.consumedAt;
      return { count: 1 };
    },
  );
  mockDb.$transaction.mockImplementation(async (work: unknown) =>
    Array.isArray(work)
      ? Promise.all(work)
      : typeof work === "function"
        ? work(mockDb)
        : undefined,
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
function mockTokenExchange() {
  vi.mocked(fetch).mockImplementation(async () =>
    Response.json({
      access_token: "fictional-new-access-token",
      refresh_token: "fictional-new-refresh-token",
      expires_in: 3600,
      api_domain: "https://www.zohoapis.com",
    }),
  );
}
async function start(organizationId: string) {
  const begun = await beginOAuth(actor, "ZOHO", organizationId);
  return new URL(begun.authorizationUrl).searchParams.get("state")!;
}

describe("explicit Books organization configuration", () => {
  it("requires selection for multiple profiles despite a legacy default and resolves only configured IDs", () => {
    const env = { ...environment(), ZOHO_BOOKS_ORGANIZATION_ID: "100" };
    expect(() => getConfig("ZOHO", env)).toThrow(/Select one/);
    expect(() => getConfig("ZOHO", env, "300")).toThrow(/not configured/);
    expect(getConfig("ZOHO", env, "200").organizationId).toBe("200");
    expect(getConfig("ZOHO", env, "100").organizationId).toBe("100");
    expect(getConfig("ZOHO", env, "100").writeEnabled).toBe(false);
  });
  it("lists safe names and IDs before credentials exist without leaking mappings or secrets", () => {
    const env = {
      ...environment(),
      ZOHO_BOOKS_CLIENT_SECRET: "",
      ZOHO_BOOKS_ORGANIZATIONS_JSON: JSON.stringify([
        { ...profiles[0], mapping },
        profiles[1],
      ]),
    };
    expect(getBooksOrganizations(env)).toEqual(profiles);
    expect(JSON.stringify(getBooksOrganizations(env))).not.toContain(
      "accountId",
    );
  });
  it.each([
    "[]",
    "{}",
    "not-json",
    JSON.stringify([profiles[0], profiles[0]]),
    JSON.stringify([{ organizationId: "invalid", name: "Bad" }]),
    JSON.stringify([{ ...profiles[0], clientSecret: "must-not-be-allowed" }]),
  ])("fails closed for malformed/duplicate profile configuration", (value) => {
    const env = {
      ...environment(),
      ZOHO_BOOKS_ORGANIZATIONS_JSON: value,
      ZOHO_BOOKS_ORGANIZATION_ID: "100",
    };
    expect(() => getConfig("ZOHO", env, "100")).toThrow(/profiles are invalid/);
  });
  it("keeps the legacy single-organization contract and refuses a mismatching explicit selection", () => {
    const env = {
      ...environment(),
      ZOHO_BOOKS_ORGANIZATIONS_JSON: "",
      ZOHO_BOOKS_ORGANIZATION_ID: "100",
      ZOHO_BOOKS_MAPPING_JSON: JSON.stringify(mapping),
    };
    expect(getConfig("ZOHO", env).booksMapping).toEqual(mapping);
    expect(() => getConfig("ZOHO", env, "200")).toThrow(/not configured/);
    expect(
      getConfig("ZOHO", {
        ...env,
        ZOHO_BOOKS_ORGANIZATIONS_JSON: JSON.stringify([profiles[1]]),
      }).organizationId,
    ).toBe("200");
  });
  it("never reuses shared mapping/attestation/refresh credentials across profile organizations", () => {
    const env = {
      ...environment(),
      ZOHO_BOOKS_MAPPING_JSON: JSON.stringify(mapping),
      ZOHO_BOOKS_TEST_AUTHORIZATION_JSON: "malformed-unused-legacy",
      ZOHO_BOOKS_REFRESH_TOKEN: "fictional-shared-refresh",
      ZOHO_BOOKS_ORGANIZATIONS_JSON: JSON.stringify([
        { ...profiles[0], mapping },
        profiles[1],
      ]),
    };
    expect(getConfig("ZOHO", env, "100").booksMapping).toEqual(mapping);
    expect(getConfig("ZOHO", env, "200").booksMapping).toBeUndefined();
    expect(getConfig("ZOHO", env, "100").refreshToken).toBeUndefined();
    expect(getConfig("ZOHO", env, "200").testAuthorization).toBeUndefined();
  });
  it("binds each nonproduction write authorization to its own organization and mappings", () => {
    const env = {
      ...environment(),
      ZOHO_BOOKS_ENVIRONMENT: "sandbox",
      ZOHO_BOOKS_WRITE_ENABLED: "true",
      INTEGRATION_TEST_MODE: "true",
      ZOHO_BOOKS_ORGANIZATIONS_JSON: JSON.stringify(
        profiles.map((p) => ({ ...p, mapping })),
      ),
    };
    const config = getConfig("ZOHO", env, "100");
    const authorization = {
      mode: "nonproduction",
      organizationId: "100",
      dataCenter: "US",
      configurationHash: booksTestConfigurationHash(config),
      approvedBy: "fictional-reviewer",
      approvalReference: "fixture-review-1",
      isolationEvidenceReference: "fixture-isolation-1",
      verifiedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    };
    env.ZOHO_BOOKS_ORGANIZATIONS_JSON = JSON.stringify(
      profiles.map((p) => ({
        ...p,
        mapping,
        testAuthorization: authorization,
      })),
    );
    expect(getConfig("ZOHO", env, "100").writeEnabled).toBe(true);
    expect(getConfig("ZOHO", env, "200").writeEnabled).toBe(false);
  });
});

describe("server-only organization refresh tokens", () => {
  const tokens = { "100": "fictional-scoped-a", "200": "fictional-scoped-b" };
  const scopedEnvironment = () => ({
    ...environment(),
    ZOHO_BOOKS_REFRESH_TOKENS_JSON: JSON.stringify(tokens),
  });
  it("selects only the exact profile token without changing network or write flags", () => {
    const env = { ...scopedEnvironment(), INTEGRATION_NETWORK_ENABLED: "false" };
    for (const organizationId of ["100", "200"] as const) {
      const config = getConfig("ZOHO", env, organizationId);
      expect(config.refreshToken).toBe(tokens[organizationId]);
      expect(config.networkEnabled).toBe(false);
      expect(config.writeEnabled).toBe(false);
    }
    expect(() => getConfig("ZOHO", env)).toThrow(/Select one/);
    expect(() => getConfig("ZOHO", env, "300")).toThrow(/not configured/);
    expect(getBooksOrganizations(env)).toEqual(profiles);
    expect(JSON.stringify(getBooksOrganizations(env))).not.toContain("fictional-scoped");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("allows partial maps without borrowing another profile's token", async () => {
    const env = { ...scopedEnvironment(), ZOHO_BOOKS_REFRESH_TOKENS_JSON: JSON.stringify({ "100": tokens["100"] }) };
    expect(getConfig("ZOHO", env, "100").refreshToken).toBe(tokens["100"]);
    const second = getConfig("ZOHO", env, "200");
    expect(second.refreshToken).toBeUndefined();
    await expect(accessToken(second)).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves scalar bootstrap only for a single profile when no map is supplied", () => {
    const env = { ...environment(), ZOHO_BOOKS_REFRESH_TOKEN: "fictional-legacy-bootstrap" };
    expect(getConfig("ZOHO", env, "100").refreshToken).toBeUndefined();
    expect(getConfig("ZOHO", { ...env, ZOHO_BOOKS_ORGANIZATIONS_JSON: JSON.stringify([profiles[0]]) }).refreshToken)
      .toBe("fictional-legacy-bootstrap");
    expect(getConfig("ZOHO", { ...env, ZOHO_BOOKS_ORGANIZATIONS_JSON: "", ZOHO_BOOKS_ORGANIZATION_ID: "100" }).refreshToken)
      .toBe("fictional-legacy-bootstrap");
  });
  it("supports a scoped map for a legacy single organization and treats escaped IDs exactly", () => {
    const env = { ...scopedEnvironment(), ZOHO_BOOKS_ORGANIZATIONS_JSON: "", ZOHO_BOOKS_ORGANIZATION_ID: "100",
      ZOHO_BOOKS_REFRESH_TOKENS_JSON: '{"\\u003100":"fictional-escaped-token"}' };
    expect(getConfig("ZOHO", env).refreshToken).toBe("fictional-escaped-token");
    expect(getConfig("ZOHO", { ...env, ZOHO_BOOKS_REFRESH_TOKENS_JSON: JSON.stringify({ "100": "x".repeat(4096) }) }).refreshToken)
      .toHaveLength(4096);
  });
  it("parses escaped token characters without mistaking them for duplicate keys", () => {
    const token = 'fictional\\token"100":"quoted-part';
    expect(getConfig("ZOHO", { ...scopedEnvironment(),
      ZOHO_BOOKS_REFRESH_TOKENS_JSON: JSON.stringify({ "100": token, "200": "fictional-second" }) }, "100").refreshToken).toBe(token);
  });
  it.each([
    ["malformed JSON", "{fictional-private-parse-error"],
    ["whitespace only", "  "],
    ["empty map", "{}"],
    ["null", "null"],
    ["array", '["fictional-private-array"]'],
    ["nested object", '{"100":{"token":"fictional-private-nested"}}'],
    ["number", '{"100":123}'],
    ["empty token", '{"100":""}'],
    ["whitespace token", '{"100":"fictional private"}'],
    ["control token", '{"100":"fictional\\u0000private"}'],
    ["oversized token", JSON.stringify({ "100": "x".repeat(4097) })],
    ["oversized input", `${" ".repeat(131072)}{"100":"fictional-private"}`],
    ["unknown ID", '{"100":"fictional-valid","300":"fictional-private-unknown"}'],
    ["prototype ID", '{"__proto__":"fictional-private-prototype"}'],
    ["duplicate ID", '{"100":"fictional-private-first","100":"fictional-private-second"}'],
    ["escaped duplicate ID", '{"100":"fictional-private-first","\\u003100":"fictional-private-second"}'],
  ])("fails closed without leaking values for %s", (_, raw) => {
    for (const organizationId of ["100", "200"]) {
      let error: unknown;
      try { getConfig("ZOHO", { ...scopedEnvironment(), ZOHO_BOOKS_REFRESH_TOKENS_JSON: raw }, organizationId); }
      catch (caught) { error = caught; }
      expect(error).toMatchObject({ code: "INVALID_REFRESH_TOKENS", kind: "BLOCKED" });
      expect(String(error)).not.toContain("fictional");
      expect(String(error)).not.toContain(raw);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects simultaneous map and scalar configuration instead of choosing a credential", () => {
    const env = { ...scopedEnvironment(), ZOHO_BOOKS_REFRESH_TOKEN: "fictional-ambiguous-scalar" };
    expect(() => getConfig("ZOHO", env, "100")).toThrow(/invalid or ambiguous/);
    expect(() => getConfig("ZOHO", { ...env, ZOHO_BOOKS_ORGANIZATIONS_JSON: JSON.stringify([profiles[0]]),
      ZOHO_BOOKS_REFRESH_TOKENS_JSON: JSON.stringify({ "100": tokens["100"] }) })).toThrow(/invalid or ambiguous/);
  });
  it("bootstraps each organization through the encrypted vault and persists rotated grants separately", async () => {
    const env = scopedEnvironment();
    mockDb.integrationCredential.createMany.mockResolvedValue({ count: 1 });
    vi.mocked(fetch).mockImplementation(async (_, init) => {
      const supplied = new URLSearchParams(String(init?.body)).get("refresh_token");
      const organizationId = supplied === tokens["100"] ? "100" : supplied === tokens["200"] ? "200" : "unexpected";
      expect(organizationId).not.toBe("unexpected");
      return Response.json({ access_token: `fictional-access-${organizationId}`, refresh_token: `fictional-rotated-${organizationId}`,
        expires_in: 3600, api_domain: "https://www.zohoapis.com" });
    });
    for (const organizationId of ["100", "200"]) {
      expect(await accessToken(getConfig("ZOHO", env, organizationId))).toBe(`fictional-access-${organizationId}`);
      const { data } = mockDb.integrationCredential.createMany.mock.lastCall![0];
      expect(data.organizationId).toBe(organizationId);
      expect(decryptToken(data.refreshTokenEncrypted)).toBe(`fictional-rotated-${organizationId}`);
      expect(decryptToken(data.accessTokenEncrypted)).toBe(`fictional-access-${organizationId}`);
      expect(data.refreshTokenEncrypted).not.toContain("fictional-rotated");
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(mockDb.auditLog.create.mock.calls)).not.toContain("fictional-scoped");
    expect(JSON.stringify(mockDb.auditLog.create.mock.calls)).not.toContain("fictional-rotated");
  });
  it.each(["revoked", "fingerprint", "legacy"])("never lets a map bypass %s vault authorization", async (variant) => {
    const config = getConfig("ZOHO", scopedEnvironment(), "100");
    mockDb.integrationCredential.findUnique.mockImplementation(async ({ where }) => {
      const id = where.target_organizationId.organizationId;
      if (variant === "legacy") return id === LEGACY_UNSCOPED_ORGANIZATION ? { organizationId: id, revokedAt: new Date() } : null;
      return { revokedAt: variant === "revoked" ? new Date() : null,
        connectionFingerprint: variant === "fingerprint" ? "other-fingerprint" : connectionFingerprint(config) };
    });
    await expect(accessToken(config)).rejects.toMatchObject({ code: "OAUTH_REAUTHORIZE" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("prefers the stored encrypted refresh token over replacement environment values", async () => {
    const config = getConfig("ZOHO", scopedEnvironment(), "100");
    mockDb.integrationCredential.findUnique.mockResolvedValue({ revokedAt: null, connectionFingerprint: connectionFingerprint(config),
      refreshTokenEncrypted: encryptToken("fictional-vault-successor"), accessExpiresAt: new Date(0), updatedAt: new Date() });
    mockDb.integrationCredential.updateMany.mockResolvedValue({ count: 1 });
    mockTokenExchange();
    await accessToken(config);
    expect(new URLSearchParams(String(vi.mocked(fetch).mock.calls[0][1]?.body)).get("refresh_token"))
      .toBe("fictional-vault-successor");
    expect(mockDb.integrationCredential.createMany).not.toHaveBeenCalled();
  });
  it("keeps both valid and malformed map values out of safe readiness responses", async () => {
    vi.stubEnv("ZOHO_BOOKS_REFRESH_TOKENS_JSON", JSON.stringify(tokens));
    const ready = await integrationStatus();
    expect(ready.zoho.organizations.every((profile) => profile.status === "AUTHORIZED_UNVERIFIED" && !profile.writeEnabled)).toBe(true);
    expect(JSON.stringify(ready)).not.toContain("fictional-scoped");
    vi.stubEnv("ZOHO_BOOKS_REFRESH_TOKENS_JSON", '{"300":"fictional-private-unknown"}');
    const invalid = await integrationStatus();
    expect(invalid.zoho.organizations.every((profile) => profile.status === "NOT_CONFIGURED")).toBe(true);
    expect(JSON.stringify(invalid)).not.toContain("fictional-private");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("organization-scoped OAuth", () => {
  it("requires an explicit selection before creating state and preserves the static callback", async () => {
    await expect(beginOAuth(actor, "ZOHO")).rejects.toMatchObject({
      code: "ORGANIZATION_REQUIRED",
    });
    expect(mockDb.integrationOAuthState.create).not.toHaveBeenCalled();
    for (const organizationId of ["100", "200"]) {
      const begun = await beginOAuth(actor, "ZOHO", organizationId);
      expect(
        new URL(begun.authorizationUrl).searchParams.get("redirect_uri"),
      ).toBe(callbackUrl("ZOHO"));
      expect(mockDb.integrationOAuthState.create).toHaveBeenLastCalledWith({
        data: expect.objectContaining({ organizationId, userId: actor.id }),
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses only stored state selection, consumes it once, and writes only the selected credential", async () => {
    const state = await start("200");
    mockTokenExchange();
    const params = new URLSearchParams({
      state,
      code: "fictional-code",
      organizationId: "100",
    });
    expect(await completeOAuth(actor, "ZOHO", params)).toEqual({
      success: true,
      organizationId: "200",
    });
    const saved = mockDb.integrationCredential.upsert.mock.calls[0][0];
    expect(saved.where).toEqual({
      target_organizationId: { target: "ZOHO", organizationId: "200" },
    });
    expect(saved.create.organizationId).toBe("200");
    expect(decryptToken(saved.create.refreshTokenEncrypted)).toBe(
      "fictional-new-refresh-token",
    );
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          details: expect.objectContaining({ organizationId: "200" }),
        }),
      }),
    );
    await expect(completeOAuth(actor, "ZOHO", params)).rejects.toMatchObject({
      status: 400,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    "wrong-user",
    "wrong-target",
    "expired",
    "legacy",
    "removed",
    "configuration-changed",
  ])("rejects %s state before exchanging a token", async (variant) => {
    const state = await start("100");
    const row = [...states.values()][0];
    if (variant === "wrong-user") row.userId = "other-admin";
    if (variant === "wrong-target") row.target = "CRM";
    if (variant === "expired") row.expiresAt = new Date(0);
    if (variant === "legacy") row.organizationId = LEGACY_UNSCOPED_ORGANIZATION;
    if (variant === "removed")
      vi.stubEnv(
        "ZOHO_BOOKS_ORGANIZATIONS_JSON",
        JSON.stringify([profiles[1]]),
      );
    if (variant === "configuration-changed")
      vi.stubEnv("ZOHO_BOOKS_CLIENT_SECRET", "fictional-rotated-secret");
    await expect(
      completeOAuth(
        actor,
        "ZOHO",
        new URLSearchParams({ state, code: "fictional-code" }),
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(fetch).not.toHaveBeenCalled();
    expect(mockDb.integrationCredential.upsert).not.toHaveBeenCalled();
  });
  it("reads and revokes one organization without borrowing the other organization's token", async () => {
    const first = getConfig("ZOHO", process.env, "100"),
      second = getConfig("ZOHO", process.env, "200");
    mockDb.integrationCredential.findUnique.mockImplementation(
      async ({ where }) => {
        const id = where.target_organizationId.organizationId;
        if (id === "100")
          return {
            revokedAt: null,
            connectionFingerprint: connectionFingerprint(first),
            accessTokenEncrypted: encryptToken("fictional-first-access"),
            accessExpiresAt: new Date(Date.now() + 3600000),
          };
        if (id === "200")
          return {
            revokedAt: new Date(),
            connectionFingerprint: connectionFingerprint(second),
          };
        return null;
      },
    );
    expect(await accessToken(first)).toBe("fictional-first-access");
    await expect(accessToken(second)).rejects.toMatchObject({
      code: "OAUTH_REAUTHORIZE",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("refuses refresh bootstrap when an unscoped legacy credential exists, even revoked", async () => {
    vi.stubEnv("ZOHO_BOOKS_ORGANIZATIONS_JSON", "");
    vi.stubEnv("ZOHO_BOOKS_ORGANIZATION_ID", "100");
    vi.stubEnv("ZOHO_BOOKS_REFRESH_TOKEN", "fictional-bootstrap-refresh");
    mockDb.integrationCredential.findUnique.mockImplementation(
      async ({ where }) =>
        where.target_organizationId.organizationId ===
        LEGACY_UNSCOPED_ORGANIZATION
          ? {
              organizationId: LEGACY_UNSCOPED_ORGANIZATION,
              revokedAt: new Date(),
            }
          : null,
    );
    await expect(accessToken(getConfig("ZOHO"))).rejects.toMatchObject({
      code: "OAUTH_REAUTHORIZE",
    });
    const { zoho } = await integrationStatus();
    expect(zoho.status).toBe("CONFIGURED_UNVERIFIED");
    expect(zoho.canAuthorize).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("returns independent safe readiness for both organizations, including before credentials exist", async () => {
    vi.stubEnv("ZOHO_BOOKS_CLIENT_SECRET", "");
    let result = await integrationStatus();
    expect(result.zoho.requiresOrganizationSelection).toBe(true);
    expect(result.zoho.canAuthorize).toBe(false);
    expect(
      result.zoho.organizations.map(({ organizationId, name }) => ({
        organizationId,
        name,
      })),
    ).toEqual(profiles);
    expect(result.zoho.organizations.every((p) => !p.canAuthorize)).toBe(true);
    vi.stubEnv("ZOHO_BOOKS_CLIENT_SECRET", "fictional-secret");
    const config = getConfig("ZOHO", process.env, "100");
    mockDb.integrationCredential.findUnique.mockImplementation(
      async ({ where }) =>
        where.target_organizationId.organizationId === "100"
          ? {
              revokedAt: null,
              connectionFingerprint: connectionFingerprint(config),
            }
          : null,
    );
    result = await integrationStatus();
    expect(result.zoho.organizations.map((p) => p.status)).toEqual([
      "AUTHORIZED_UNVERIFIED",
      "CONFIGURED_UNVERIFIED",
    ]);
    expect(
      result.zoho.organizations.every(
        (p) => p.canAuthorize && !p.writeEnabled && !p.connected,
      ),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain("fictional-secret");
    expect(JSON.stringify(result)).not.toContain("connectionFingerprint");
    expect(fetch).not.toHaveBeenCalled();
  });
});
