import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  completeOAuth: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/integrations/oauth", () => ({
  completeOAuth: mocks.completeOAuth,
  callbackUrl: (target: string) =>
    `https://bills.example.invalid/api/integrations/oauth/${target.toLowerCase()}/callback`,
}));

import { GET } from "@/app/api/integrations/oauth/[target]/callback/route";
import { HttpError } from "@/lib/http";

describe("OAuth callback navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUser.mockResolvedValue({ id: "operator", role: "ADMIN" });
    mocks.completeOAuth.mockResolvedValue({
      success: true,
      organizationId: "123",
    });
  });

  it.each([
    ["zoho", "/account/books-authorization"],
    ["crm", "/account/crm-authorization"],
  ])(
    "returns %s to its page after saving authorization",
    async (target, path) => {
      const response = await GET(
        new Request(
          `https://bills.example.invalid/api/integrations/oauth/${target}/callback?code=fictional-code&state=fictional-state`,
        ),
        { params: Promise.resolve({ target }) },
      );
      expect(mocks.requireUser).toHaveBeenCalledWith(["ADMIN"]);
      expect(mocks.completeOAuth).toHaveBeenCalledOnce();
      expect(response.status).toBe(303);
      expect(response.headers.get("Location")).toBe(
        `https://bills.example.invalid${path}`,
      );
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    },
  );

  it("does not show a successful return when authorization fails", async () => {
    mocks.completeOAuth.mockRejectedValue(
      new HttpError(400, "Authorization expired."),
    );
    const response = await GET(
      new Request(
        "https://bills.example.invalid/api/integrations/oauth/zoho/callback",
      ),
      { params: Promise.resolve({ target: "zoho" }) },
    );
    expect(response.status).toBe(400);
    expect(response.headers.has("Location")).toBe(false);
  });
});
