import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Role } from "@prisma/client";

const state = vi.hoisted(() => ({
  cookie: undefined as string | undefined,
  session: null as null | {
    expiresAt: Date;
    user: {
      id: string;
      name: string;
      email: string;
      role: Role;
      active: boolean;
    };
  },
  sessionRead: vi.fn(),
  userRead: vi.fn(),
  billRead: vi.fn(),
  documentRead: vi.fn(),
  ocrDocumentRead: vi.fn(),
  ocrBatchRead: vi.fn(),
  membershipsRead: vi.fn(),
  cookieDelete: vi.fn(),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (state.cookie ? { value: state.cookie } : undefined),
    delete: state.cookieDelete,
  }),
}));
vi.mock("@/lib/db", () => {
  const db = {
    session: { findUnique: state.sessionRead },
    user: { findUnique: state.userRead },
    bill: { findUnique: state.billRead },
    document: { findUnique: state.documentRead },
    ocrDocument: { findFirst: state.ocrDocumentRead },
    ocrBatch: { findFirst: state.ocrBatchRead },
    userCompanyMembership: { findMany: state.membershipsRead },
    $transaction: async (work: unknown): Promise<unknown> => {
      if (typeof work === "function") return work(db);
      throw new Error("Unexpected data operation in access-control test");
    },
  };
  return { db };
});

import { getCurrentUser, requireUser } from "@/lib/auth";
import { readJson, sameOrigin } from "@/lib/http";

const routes = [
  ["companies", () => import("@/app/api/companies/route"), ["GET"]],
  ["auth/me", () => import("@/app/api/auth/me/route"), ["GET"]],
  ["auth/password", () => import("@/app/api/auth/password/route"), ["POST"]],
  ["audit", () => import("@/app/api/audit/route"), ["GET"]],
  ["bills", () => import("@/app/api/bills/route"), ["GET", "POST"]],
  ["bills/id", () => import("@/app/api/bills/[id]/route"), ["GET", "PATCH"]],
  [
    "bills/id/actions",
    () => import("@/app/api/bills/[id]/actions/route"),
    ["POST"],
  ],
  [
    "bills/id/attachment",
    () => import("@/app/api/bills/[id]/attachment/route"),
    ["POST"],
  ],
  ["bills/id/sync", () => import("@/app/api/bills/[id]/sync/route"), ["POST"]],
  [
    "bills/id/sync/preview",
    () => import("@/app/api/bills/[id]/sync/preview/route"),
    ["POST"],
  ],
  ["documents/id", () => import("@/app/api/documents/[id]/route"), ["GET"]],
  ["dashboard", () => import("@/app/api/dashboard/route"), ["GET"]],
  ["jobs", () => import("@/app/api/jobs/route"), ["GET", "POST"]],
  ["jobs/id", () => import("@/app/api/jobs/[id]/route"), ["GET"]],
  ["vendors", () => import("@/app/api/vendors/route"), ["GET", "POST"]],
  ["operations", () => import("@/app/api/operations/route"), ["GET"]],
  ["reports/bills", () => import("@/app/api/reports/bills/route"), ["GET"]],
  ["integrations", () => import("@/app/api/integrations/route"), ["GET"]],
  [
    "integrations/jobs",
    () => import("@/app/api/integrations/jobs/route"),
    ["GET"],
  ],
  [
    "integrations/jobs/id",
    () => import("@/app/api/integrations/jobs/[id]/route"),
    ["POST"],
  ],
  [
    "integrations/vendor-mapping",
    () => import("@/app/api/integrations/vendor-mapping/route"),
    ["POST"],
  ],
  [
    "integrations/crm/import-job",
    () => import("@/app/api/integrations/crm/import-job/route"),
    ["POST"],
  ],
  [
    "integrations/oauth/zoho/authorize",
    () => import("@/app/api/integrations/oauth/[target]/authorize/route"),
    ["POST"],
  ],
  [
    "integrations/oauth/zoho/callback",
    () => import("@/app/api/integrations/oauth/[target]/callback/route"),
    ["GET"],
  ],
  [
    "crm/jobs/id/expenses",
    () => import("@/app/api/crm/jobs/[id]/expenses/route"),
    ["GET"],
  ],
  ["ocr", () => import("@/app/api/ocr/route"), ["GET", "POST"]],
  [
    "ocr/templates",
    () => import("@/app/api/ocr/templates/route"),
    ["GET", "POST"],
  ],
  ["ocr/batches/id", () => import("@/app/api/ocr/batches/[id]/route"), ["GET"]],
  [
    "ocr/batches/id/approve",
    () => import("@/app/api/ocr/batches/[id]/approve/route"),
    ["POST"],
  ],
  [
    "ocr/batches/id/errors",
    () => import("@/app/api/ocr/batches/[id]/errors/route"),
    ["GET"],
  ],
  [
    "ocr/documents/id",
    () => import("@/app/api/ocr/documents/[id]/route"),
    ["GET"],
  ],
  [
    "ocr/documents/id/file",
    () => import("@/app/api/ocr/documents/[id]/file/route"),
    ["GET"],
  ],
  [
    "ocr/documents/id/retry",
    () => import("@/app/api/ocr/documents/[id]/retry/route"),
    ["POST"],
  ],
  [
    "ocr/documents/id/review",
    () => import("@/app/api/ocr/documents/[id]/review/route"),
    ["POST"],
  ],
] as const;
type Handler = (
  request: Request,
  context: { params: Promise<{ id: string; target: string }> },
) => Promise<Response>;
const origin = "http://127.0.0.1:3000";
const calls = routes.flatMap(([route, load, methods]) =>
  methods.map((method) => ({ route, load, method })),
);
async function call(route: string, method = "GET", body: unknown = {}) {
  const entry = calls.find(
    (item) => item.route === route && item.method === method,
  )!;
  const routeModule = await entry.load();
  const handler = (routeModule as unknown as Record<string, Handler>)[method];
  return handler(
    new Request(`${origin}/api/${route}`, {
      method,
      headers: { origin, "content-type": "application/json" },
      ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve({ id: "other-record", target: "zoho" }) },
  );
}
function login(role: Role) {
  state.cookie = "a".repeat(64);
  state.session = {
    expiresAt: new Date(Date.now() + 60_000),
    user: {
      id: `fixture-${role}`,
      name: "Fictional User",
      email: "fictional@example.invalid",
      role,
      active: true,
    },
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("APP_URL", origin);
  vi.stubEnv("APP_ENV", "test");
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Network is forbidden in access-control tests");
    }),
  );
  state.cookie = undefined;
  state.session = null;
  state.sessionRead.mockImplementation(async () => state.session);
  state.userRead.mockImplementation(async ({ where }: { where: { id: string } }) =>
    state.session?.user.id === where.id ? state.session.user : null,
  );
  state.membershipsRead.mockResolvedValue([{ companyId: "fixture-company" }]);
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("protected endpoint authentication", () => {
  it.each(calls)(
    "denies anonymous $method /api/$route",
    async ({ route, method }) => {
      const response = await call(route, method);
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual({
        error: "Please sign in to continue.",
      });
      expect(state.sessionRead).not.toHaveBeenCalled();
      expect(state.documentRead).not.toHaveBeenCalled();
      expect(state.ocrDocumentRead).not.toHaveBeenCalled();
      expect(state.billRead).not.toHaveBeenCalled();
    },
  );
  it("rejects malformed, expired, deactivated and revoked sessions", async () => {
    state.cookie = "forged-admin-cookie";
    expect(await getCurrentUser()).toBeNull();
    expect(state.sessionRead).not.toHaveBeenCalled();
    login("ADMIN");
    state.session!.expiresAt = new Date(0);
    expect(await getCurrentUser()).toBeNull();
    state.session!.expiresAt = new Date(Date.now() + 60_000);
    state.session!.user.active = false;
    expect(await getCurrentUser()).toBeNull();
    state.session = null;
    await expect(requireUser()).rejects.toMatchObject({ status: 401 });
  });
  it("reads the current role every time and queries only the hashed cookie", async () => {
    login("ADMIN");
    expect((await requireUser(["ADMIN"])).role).toBe("ADMIN");
    state.session!.user.role = "DATA_ENTRY";
    await expect(requireUser(["ADMIN"])).rejects.toMatchObject({ status: 403 });
    expect(state.sessionRead).toHaveBeenCalledTimes(2);
    expect(state.sessionRead).toHaveBeenLastCalledWith({
      where: {
        tokenHash: createHash("sha256").update(state.cookie!).digest("hex"),
      },
      include: { user: true },
    });
  });
  it("fails closed for production authentication without HTTPS", async () => {
    vi.stubEnv("APP_ENV", "production");
    await expect(getCurrentUser()).rejects.toMatchObject({ status: 503 });
    expect(state.sessionRead).not.toHaveBeenCalled();
  });
});

describe("cross-role endpoint restrictions", () => {
  it.each(["ACCOUNTS", "DATA_ENTRY", "MANAGEMENT"] as const)(
    "blocks %s from OAuth state creation and callback consumption",
    async (role) => {
      login(role);
      expect(
        (await call("integrations/oauth/zoho/authorize", "POST")).status,
      ).toBe(403);
      expect((await call("integrations/oauth/zoho/callback")).status).toBe(403);
      expect((await call("integrations/vendor-mapping", "POST")).status).toBe(
        403,
      );
      expect((await call("integrations/crm/import-job", "POST")).status).toBe(
        403,
      );
    },
  );
  it.each([
    ["bills", "POST"],
    ["bills/id", "PATCH"],
    ["bills/id/actions", "POST"],
    ["bills/id/attachment", "POST"],
    ["bills/id/sync", "POST"],
    ["bills/id/sync/preview", "POST"],
    ["vendors", "POST"],
    ["jobs", "POST"],
    ["ocr", "POST"],
    ["ocr/templates", "POST"],
    ["ocr/documents/id/retry", "POST"],
    ["ocr/documents/id/review", "POST"],
    ["ocr/batches/id/approve", "POST"],
    ["integrations/jobs/id", "POST"],
  ])("keeps Management read-only at %s", async (route, method) => {
    login("MANAGEMENT");
    expect((await call(route, method)).status).toBe(403);
    expect(state.billRead).not.toHaveBeenCalled();
    expect(state.documentRead).not.toHaveBeenCalled();
  });
  it.each([
    "audit",
    "reports/bills",
    "integrations/jobs",
    "crm/jobs/id/expenses",
  ])("denies Data Entry organization data at %s", async (route) => {
    login("DATA_ENTRY");
    expect((await call(route)).status).toBe(403);
  });
  it("validates Data Entry sync requests before checking bill ownership", async () => {
    login("DATA_ENTRY");
    expect((await call("bills/id/sync", "POST")).status).toBe(422);
    expect(
      (
        await call("bills/id/sync", "POST", {
          target: "ZOHO",
          confirmation: { challengeToken: "obsolete" },
        })
      ).status,
    ).toBe(422);
    expect(state.billRead).not.toHaveBeenCalled();
  });
  it("retires the separate live confirmation step for authenticated writers", async () => {
    login("DATA_ENTRY");
    expect((await call("bills/id/sync/preview", "POST")).status).toBe(410);
    expect(state.billRead).not.toHaveBeenCalled();
  });
  it("conceals another user's bill and private attachment before file access", async () => {
    login("DATA_ENTRY");
    state.billRead.mockResolvedValue({
      createdById: "another-user",
      companyId: "fixture-company",
    });
    state.documentRead.mockResolvedValue({
      bill: { createdById: "another-user", companyId: "fixture-company" },
      storageKey: "must-not-be-read",
    });
    expect((await call("bills/id")).status).toBe(404);
    expect((await call("documents/id")).status).toBe(404);
  });
  it("scopes OCR metadata, originals and batches to the Data Entry owner", async () => {
    login("DATA_ENTRY");
    state.ocrDocumentRead.mockResolvedValue(null);
    state.ocrBatchRead.mockResolvedValue(null);
    expect((await call("ocr/documents/id")).status).toBe(404);
    expect((await call("ocr/documents/id/file")).status).toBe(404);
    expect((await call("ocr/batches/id")).status).toBe(404);
    expect(state.ocrDocumentRead).toHaveBeenLastCalledWith({
      where: {
        id: "other-record",
        batch: {
          createdById: "fixture-DATA_ENTRY",
          companyId: { in: ["fixture-company"] },
        },
      },
      include: {
        batch: true,
        scannerImports: {
          where: { status: "IMPORTED" },
          take: 1,
          select: { source: { select: { name: true } } },
        },
      },
    });
    expect(state.ocrBatchRead.mock.calls[0][0].where).toEqual({
      id: "other-record",
      createdById: "fixture-DATA_ENTRY",
      companyId: { in: ["fixture-company"] },
    });
    expect(state.membershipsRead).toHaveBeenLastCalledWith({
      where: {
        userId: "fixture-DATA_ENTRY",
        active: true,
        user: { active: true },
        company: { active: true },
      },
      select: { companyId: true },
    });
  });
  it.each(["ADMIN", "ACCOUNTS"] as const)(
    "blocks %s from approving their own pending bill",
    async (role) => {
      login(role);
      state.billRead.mockResolvedValue({
        createdById: state.session!.user.id,
        companyId: "fixture-company",
        status: "PENDING_APPROVAL",
        version: 1,
      });
      expect(
        (
          await call("bills/id/actions", "POST", {
            action: "approve",
            version: 1,
          })
        ).status,
      ).toBe(403);
    },
  );
});

describe("origin and body boundaries", () => {
  it("rejects origin spoofing using host or forwarded headers", () => {
    expect(() =>
      sameOrigin(
        new Request(`${origin}/api/bills`, {
          headers: {
            origin: "https://attacker.invalid",
            host: "attacker.invalid",
            "x-forwarded-host": "attacker.invalid",
          },
        }),
      ),
    ).toThrow();
    expect(() =>
      sameOrigin(
        new Request(`${origin}/api/bills`, {
          headers: {
            origin,
            "sec-fetch-site": "cross-site",
          },
        }),
      ),
    ).toThrow();
  });
  it("rejects JSON-like media types and accepts standard JSON parameters", async () => {
    await expect(
      readJson(
        new Request(origin, {
          method: "POST",
          headers: { "content-type": "application/jsonp" },
          body: "{}",
        }),
      ),
    ).rejects.toMatchObject({ status: 415 });
    await expect(
      readJson(
        new Request(origin, {
          method: "POST",
          headers: { "content-type": "application/json; charset=utf-8" },
          body: "{}",
        }),
      ),
    ).resolves.toEqual({});
  });
});
