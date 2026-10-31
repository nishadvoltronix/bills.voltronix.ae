import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
import { getConfig } from "@/lib/integrations/config";
import { importCrmJob } from "@/lib/integrations/crm";
import * as oauth from "@/lib/integrations/oauth";

const mockDb = vi.hoisted(() => ({
  integrationCredential: { findUnique: vi.fn() },
  job: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  auditLog: { create: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

const actor: Actor = {
  id: "fictional-crm-admin",
  name: "Fictional CRM Admin",
  email: "crm-admin@example.invalid",
  role: "ADMIN",
};
const crmReadScopes = [
  "ZohoCRM.modules.deals.READ",
  "ZohoCRM.modules.custom.READ",
  "ZohoSearch.securesearch.READ",
  "ZohoCRM.modules.vendors.READ",
  "ZohoCRM.settings.modules.READ",
  "ZohoCRM.settings.fields.READ",
  "ZohoCRM.settings.related_lists.READ",
  "ZohoCRM.org.READ",
  "ZohoProjects.portals.READ",
  "ZohoProjects.clients.READ",
];

beforeEach(() => {
  vi.resetAllMocks();
  for (const [name, value] of Object.entries({
    APP_ENV: "development",
    APP_URL: "http://127.0.0.1:3000",
    INTEGRATION_NETWORK_ENABLED: "true",
    INTEGRATION_TOKEN_ENCRYPTION_KEY: "a".repeat(64),
    ZOHO_BOOKS_DC: "US",
    ZOHO_BOOKS_ENVIRONMENT: "production",
    ZOHO_BOOKS_ORGANIZATION_ID: "100",
    ZOHO_BOOKS_ORGANIZATIONS_JSON: "",
    ZOHO_BOOKS_CLIENT_ID: "fictional-shared-client",
    ZOHO_BOOKS_CLIENT_SECRET: "fictional-shared-secret",
    ZOHO_CRM_DC: "US",
    ZOHO_CRM_ENVIRONMENT: "production",
    // Deliberately collide numeric IDs to prove product identity is also checked.
    ZOHO_CRM_ORGANIZATION_ID: "100",
    ZOHO_CRM_CLIENT_ID: "fictional-shared-client",
    ZOHO_CRM_CLIENT_SECRET: "fictional-shared-secret",
  }))
    vi.stubEnv(name, value);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected provider request in CRM setup test");
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("CRM connection setup boundaries", () => {
  it.each(["development", "test"])(
    "blocks production CRM import in %s before credentials, provider requests or database work",
    async (environment) => {
      vi.stubEnv("APP_ENV", environment);
      const tokenLookup = vi.spyOn(oauth, "accessToken");

      await expect(importCrmJob(actor, "123456789")).rejects.toMatchObject({
        status: 409,
        message:
          "Production CRM financial records cannot be imported into this development database. Use a sandbox organization.",
      });

      expect(tokenLookup).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(mockDb.integrationCredential.findUnique).not.toHaveBeenCalled();
      expect(mockDb.$transaction).not.toHaveBeenCalled();
      for (const operation of Object.values(mockDb.job))
        expect(operation).not.toHaveBeenCalled();
      expect(mockDb.auditLog.create).not.toHaveBeenCalled();
    },
  );

  it("requests CRM custom-job and related-list reads alongside Projects association reads with its own offline consent", () => {
    const crm = new URL(
      oauth.authorizationUrl(getConfig("CRM"), "fictional-crm-state"),
    );
    const books = new URL(
      oauth.authorizationUrl(getConfig("ZOHO"), "fictional-books-state"),
    );

    expect(crm.origin).toBe("https://accounts.zoho.com");
    expect(crm.searchParams.get("scope")?.split(",")).toEqual(crmReadScopes);
    expect(crmReadScopes.every((scope) => scope.endsWith(".READ"))).toBe(true);
    expect(crm.searchParams.get("scope")?.split(",").filter(scope => scope.startsWith("ZohoProjects."))).toEqual([
      "ZohoProjects.portals.READ", "ZohoProjects.clients.READ",
    ]);
    expect(crm.searchParams.get("scope")?.split(",")).toContain("ZohoCRM.modules.custom.READ");
    expect(crm.searchParams.get("scope")?.split(",")).toContain("ZohoCRM.settings.related_lists.READ");
    expect(crm.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:3000/api/integrations/oauth/crm/callback",
    );
    expect(books.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:3000/api/integrations/oauth/zoho/callback",
    );
    expect(crm.searchParams.get("client_id")).toBe(
      books.searchParams.get("client_id"),
    );
    expect(crm.searchParams.get("access_type")).toBe("offline");
    expect(crm.searchParams.get("prompt")).toBe("consent");
    expect(crm.searchParams.get("response_type")).toBe("code");
    expect(getConfig("CRM").writeEnabled).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps credential keys and tokens distinct when client, DC and numeric organization ID match", async () => {
    const books = getConfig("ZOHO");
    const crm = getConfig("CRM");
    expect(books.clientId).toBe(crm.clientId);
    expect(books.clientSecret).toBe(crm.clientSecret);
    expect(books.organizationId).toBe(crm.organizationId);
    expect(oauth.connectionFingerprint(books)).not.toBe(
      oauth.connectionFingerprint(crm),
    );
    mockDb.integrationCredential.findUnique.mockImplementation(
      async ({
        where,
      }: {
        where: {
          target_organizationId: {
            target: "ZOHO" | "CRM";
            organizationId: string;
          };
        };
      }) => {
        const target = where.target_organizationId.target;
        return {
          revokedAt: null,
          connectionFingerprint: oauth.connectionFingerprint(
            target === "ZOHO" ? books : crm,
          ),
          accessTokenEncrypted: oauth.encryptToken(
            `fictional-${target}-access`,
          ),
          accessExpiresAt: new Date(Date.now() + 3600000),
        };
      },
    );

    await expect(oauth.accessToken(books)).resolves.toBe(
      "fictional-ZOHO-access",
    );
    await expect(oauth.accessToken(crm)).resolves.toBe("fictional-CRM-access");
    expect(mockDb.integrationCredential.findUnique).toHaveBeenNthCalledWith(1, {
      where: {
        target_organizationId: { target: "ZOHO", organizationId: "100" },
      },
    });
    expect(mockDb.integrationCredential.findUnique).toHaveBeenNthCalledWith(2, {
      where: {
        target_organizationId: { target: "CRM", organizationId: "100" },
      },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a Books credential fingerprint returned for a CRM lookup before decrypting or refreshing", async () => {
    mockDb.integrationCredential.findUnique.mockResolvedValue({
      revokedAt: null,
      connectionFingerprint: oauth.connectionFingerprint(getConfig("ZOHO")),
      accessTokenEncrypted: "not-a-valid-token-envelope",
      accessExpiresAt: new Date(Date.now() + 3600000),
    });

    await expect(oauth.accessToken(getConfig("CRM"))).rejects.toMatchObject({
      code: "OAUTH_REAUTHORIZE",
      kind: "BLOCKED",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
