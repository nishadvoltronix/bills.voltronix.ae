import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/http";
import { GET as list } from "@/app/api/bills/books/route";
import { GET as detail } from "@/app/api/bills/books/[id]/route";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  listBooksBills: vi.fn(),
  getBooksBill: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/services/books-import", () => ({
  listBooksBills: mocks.listBooksBills,
  getBooksBill: mocks.getBooksBill,
}));

const actor = { id: "fictional-accounts", role: "ACCOUNTS" };
const request = (query = "") =>
  new Request(`http://localhost/api/bills/books?${query}`);
beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue(actor);
  mocks.listBooksBills.mockResolvedValue({
    bills: [],
    total: 0,
    page: 1,
    pageSize: 50,
  });
  mocks.getBooksBill.mockResolvedValue({
    id: "fictional-bill",
    total: "9007199254740993.001",
  });
});

describe("imported Books bill routes", () => {
  it("uses restricted roles, bounded pagination and native filters without caching", async () => {
    const response = await list(
      request(
        new URLSearchParams({
          companyId: "fictional-company",
          q: "A&B",
          status: "overdue",
          currencyCode: "AED",
          page: "2",
        }).toString(),
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.requireUser).toHaveBeenCalledWith([
      "ADMIN",
      "ACCOUNTS",
      "MANAGEMENT",
    ]);
    expect(mocks.listBooksBills).toHaveBeenCalledWith(actor, {
      companyId: "fictional-company",
      q: "A&B",
      status: "overdue",
      currencyCode: "AED",
      page: 2,
      pageSize: 50,
    });
  });

  it.each([
    "page=0",
    "page=1e2",
    "page=1.5",
    "page=-1",
    "page=01",
    "page=1000000",
    "page=1&page=2",
    "companyId=a&companyId=b",
    "organizationId=other",
    "pageSize=10000",
  ])("rejects ambiguous or overriding queries: %s", async (query) => {
    expect((await list(request(query))).status).toBe(422);
    expect(mocks.listBooksBills).not.toHaveBeenCalled();
  });

  it.each([401, 403])(
    "requires current authentication and allowed role before reading (%s)",
    async (status) => {
      mocks.requireUser.mockRejectedValue(
        new HttpError(status, "Access denied."),
      );
      expect((await list(request())).status).toBe(status);
      expect(
        (
          await detail(request(), {
            params: Promise.resolve({ id: "fictional-bill" }),
          })
        ).status,
      ).toBe(status);
      expect(mocks.listBooksBills).not.toHaveBeenCalled();
      expect(mocks.getBooksBill).not.toHaveBeenCalled();
    },
  );

  it("passes the authenticated actor to detail authorization and preserves money strings", async () => {
    const response = await detail(request(), {
      params: Promise.resolve({ id: "fictional-bill" }),
    });
    expect(mocks.requireUser).toHaveBeenCalledWith([
      "ADMIN",
      "ACCOUNTS",
      "MANAGEMENT",
    ]);
    expect(mocks.getBooksBill).toHaveBeenCalledWith(actor, "fictional-bill");
    expect(await response.json()).toEqual({
      bill: { id: "fictional-bill", total: "9007199254740993.001" },
    });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("preserves service denial for an inaccessible company bill", async () => {
    mocks.getBooksBill.mockRejectedValue(new HttpError(404, "Bill not found."));
    expect(
      (
        await detail(request(), {
          params: Promise.resolve({ id: "outside-company" }),
        })
      ).status,
    ).toBe(404);
  });
});
