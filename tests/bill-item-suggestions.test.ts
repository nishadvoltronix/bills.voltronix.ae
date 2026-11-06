import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
import { HttpError } from "@/lib/http";

const store = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  userCompanyMembership: { findMany: vi.fn() },
  job: { findFirst: vi.fn() },
  $queryRaw: vi.fn(),
}));
const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: store }));
vi.mock("@/lib/auth", () => ({ requireUser: auth.requireUser }));
import { getBillItemSuggestions } from "@/lib/services/bill-item-suggestions";
import { GET } from "@/app/api/bills/item-suggestions/route";

const actor: Actor = { id: "fictional-writer", name: "Writer", email: "writer@example.invalid", role: "ACCOUNTS" };
const query = (extra: Record<string, string> = {}) => new URLSearchParams({ companyId: "company-a", jobId: "job-a", q: " Copper ", ...extra });
const request = (params = query()) => new Request(`https://example.invalid/api/bills/item-suggestions?${params}`);

beforeEach(() => {
  vi.resetAllMocks();
  auth.requireUser.mockResolvedValue(actor);
  store.user.findUnique.mockResolvedValue({ active: true, role: actor.role });
  store.userCompanyMembership.findMany.mockResolvedValue([{ companyId: "company-a" }]);
  store.job.findFirst.mockResolvedValue({ id: "job-a" });
  store.$queryRaw.mockResolvedValue([{ description: "Copper wire", quantity: "SECRET", creatorId: "SECRET" }]);
});

describe("job item suggestions authorization and HTTP contract", () => {
  it("returns only the exact context and descriptions with a private response", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ companyId: "company-a", jobId: "job-a", suggestions: [{ description: "Copper wire" }] });
    expect(auth.requireUser).toHaveBeenCalledWith(["ADMIN", "ACCOUNTS", "DATA_ENTRY"]);
    expect(store.job.findFirst).toHaveBeenNthCalledWith(1, { where: { id: "job-a", companyId: "company-a" }, select: { id: true } });
    expect(store.job.findFirst).toHaveBeenCalledTimes(2);
    expect(store.user.findUnique).toHaveBeenCalledTimes(2);
    const sql = store.$queryRaw.mock.calls[0][0];
    expect(sql.values).toEqual(["company-a", "job-a", actor.id, "Copper"]);
    expect(sql.sql).toContain("bill.createdById = ?");
  });

  it("uses parameterized literal input rather than interpolating search or scope", async () => {
    const q = "%'_\\ OR 1=1 --";
    await getBillItemSuggestions(actor, query({ q }));
    const sql = store.$queryRaw.mock.calls[0][0];
    expect(sql.values).toContain(q);
    expect(sql.sql).not.toContain(q);
    expect(sql.sql).toContain("LOCATE(LOWER(?), LOWER(line.description))");
  });

  it("does not bind a creator filter for a currently verified Admin", async () => {
    store.user.findUnique.mockResolvedValue({ active: true, role: "ADMIN" });
    await getBillItemSuggestions({ ...actor, role: "ADMIN" }, query());
    expect(store.$queryRaw.mock.calls[0][0].values).toEqual(["company-a", "job-a", "Copper"]);
  });

  it.each([
    "companyId=company-a&jobId=job-a&q=", "companyId=company-a&jobId=job-a&q=%20%20",
    "companyId=company-a&q=Copper", "jobId=job-a&q=Copper", "companyId=company-a&jobId=job-a",
    "companyId=company-a&jobId=job-a&q=Copper&q=steel",
    "companyId=company-a&jobId=job-a&jobId=job-b&q=Copper",
    "companyId=company-a&companyId=company-b&jobId=job-a&q=Copper",
    "companyId=company-a&jobId=job-a&q=Copper&createdById=peer",
  ])("rejects incomplete or overriding queries before history reads: %s", async value => {
    expect((await GET(request(new URLSearchParams(value)))).status).toBe(422);
    expect(store.$queryRaw).not.toHaveBeenCalled();
  });

  it("allows a 500-character item phrase but rejects a longer phrase", async () => {
    const valid = await GET(request(query({ q: "a".repeat(500) })));
    expect(valid.status).toBe(200);
    store.$queryRaw.mockClear();
    const invalid = await GET(request(query({ q: "a".repeat(501) })));
    expect(invalid.status).toBe(422);
    expect(store.$queryRaw).not.toHaveBeenCalled();
  });

  it("keeps genuine session errors and never reads suggestions for anonymous requests", async () => {
    auth.requireUser.mockRejectedValue(new HttpError(401, "Please sign in to continue.", "AUTH_SESSION_REQUIRED"));
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Please sign in to continue.", code: "AUTH_SESSION_REQUIRED" });
    expect(store.$queryRaw).not.toHaveBeenCalled();
  });

  it("rejects management and stale/deactivated writer identities", async () => {
    await expect(getBillItemSuggestions({ ...actor, role: "MANAGEMENT" }, query())).rejects.toMatchObject({ status: 403 });
    store.user.findUnique.mockResolvedValue({ active: true, role: "ADMIN" });
    await expect(getBillItemSuggestions(actor, query())).rejects.toMatchObject({ status: 403 });
    store.user.findUnique.mockResolvedValue({ active: false, role: actor.role });
    await expect(getBillItemSuggestions(actor, query())).rejects.toMatchObject({ status: 403 });
    expect(store.$queryRaw).not.toHaveBeenCalled();
  });

  it("does not query history for a foreign company or mismatched job", async () => {
    await expect(getBillItemSuggestions(actor, query({ companyId: "foreign-company" }))).rejects.toMatchObject({ status: 404 });
    store.job.findFirst.mockResolvedValue(null);
    await expect(getBillItemSuggestions(actor, query())).rejects.toMatchObject({ status: 404 });
    expect(store.$queryRaw).not.toHaveBeenCalled();
  });

  it.each(["role", "membership", "job"])("discards results when %s changes during the history read", async change => {
    store.$queryRaw.mockImplementation(async () => {
      if (change === "role") store.user.findUnique.mockResolvedValue({ active: true, role: "ADMIN" });
      if (change === "membership") store.userCompanyMembership.findMany.mockResolvedValue([]);
      if (change === "job") store.job.findFirst.mockResolvedValue(null);
      return [{ description: "Private history must not escape" }];
    });
    const response = await GET(request());
    expect(response.status).toBe(change === "role" ? 403 : 404);
    expect(JSON.stringify(await response.json())).not.toContain("Private history");
  });
});
