import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requirePageUser: mocks.user }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); } }));
import Page from "@/app/(app)/bills/[id]/payment/page";

beforeEach(() => vi.clearAllMocks());
describe("native payment page permissions", () => {
  it.each(["ADMIN", "ACCOUNTS"])("allows the existing financial role %s", async role => {
    mocks.user.mockResolvedValue({ id: "fictional-user", role });
    expect(await Page({ params: Promise.resolve({ id: "fictional-bill" }) })).toMatchObject({ props: { id: "fictional-bill" } });
    expect(mocks.user).toHaveBeenCalledOnce();
  });
  it.each(["DATA_ENTRY", "MANAGEMENT"])("denies direct payment entry to %s", async role => {
    mocks.user.mockResolvedValue({ id: "fictional-user", role });
    await expect(Page({ params: Promise.resolve({ id: "fictional-bill" }) })).rejects.toThrow("REDIRECT:/bills");
  });
});
