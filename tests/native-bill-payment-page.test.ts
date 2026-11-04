import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requirePageUser: mocks.user }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); } }));
import Page from "@/app/(app)/bills/[id]/payment/page";

beforeEach(() => vi.clearAllMocks());
describe("native payment page permissions", () => {
  it.each(["ADMIN", "ACCOUNTS"])("allows the existing financial role %s", async role => {
    mocks.user.mockResolvedValue({ id: "fictional-user", role });
    expect(await Page({ params: Promise.resolve({ id: "fictional-bill" }), searchParams: Promise.resolve({}) })).toMatchObject({ props: { id: "fictional-bill", fromEntry: false, saved: false } });
    expect(mocks.user).toHaveBeenCalledOnce();
  });
  it.each(["DATA_ENTRY", "MANAGEMENT"])("denies direct payment entry to %s", async role => {
    mocks.user.mockResolvedValue({ id: "fictional-user", role });
    await expect(Page({ params: Promise.resolve({ id: "fictional-bill" }), searchParams: Promise.resolve({}) })).rejects.toThrow("REDIRECT:/bills");
  });
  it("passes only explicit entry/saved flags while leaving job scope to the saved bill", async () => {
    mocks.user.mockResolvedValue({ id: "fictional-user", role: "ACCOUNTS" });
    expect(await Page({ params: Promise.resolve({ id: "fictional-bill" }), searchParams: Promise.resolve({ entry: "1", saved: "1" }) }))
      .toMatchObject({ props: { id: "fictional-bill", fromEntry: true, saved: true } });
    expect(await Page({ params: Promise.resolve({ id: "fictional-bill" }), searchParams: Promise.resolve({ entry: "true", saved: "yes" }) }))
      .toMatchObject({ props: { id: "fictional-bill", fromEntry: false, saved: false } });
  });
});
