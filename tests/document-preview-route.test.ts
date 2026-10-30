import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/documents/[id]/route";
import { HttpError } from "@/lib/http";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  downloadDocument: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/services/documents", () => ({
  downloadDocument: mocks.downloadDocument,
}));
const actor = { id: "fictional-authorized-reader", role: "ACCOUNTS" };
const bytes = Buffer.from("%PDF-1.7\nOriginal fictional invoice\n%%EOF");
const context = { params: Promise.resolve({ id: "fictional-document" }) };
const request = (query = "") =>
  new Request(`http://localhost/api/documents/fictional-document${query}`);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue(actor);
  mocks.downloadDocument.mockResolvedValue({
    bytes,
    mimeType: "application/pdf",
    fileName: "Supplier's invoice.pdf",
  });
});

describe("workspace original document preview", () => {
  it("opens the authorized original with protected inline headers and exact bytes", async () => {
    const response = await GET(request("?preview=1"), context);
    expect(response.status).toBe(200);
    expect(mocks.downloadDocument).toHaveBeenCalledWith(
      actor,
      "fictional-document",
    );
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("Content-Disposition")).toBe(
      "inline; filename=\"Supplier_s_invoice.pdf\"; filename*=UTF-8''Supplier%27s%20invoice.pdf",
    );
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Content-Length")).toBe(String(bytes.length));
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "sandbox; default-src 'none'",
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  });
  it("preserves attachment disposition for existing download links", async () => {
    const response = await GET(request(), context);
    expect(response.headers.get("Content-Disposition")).toMatch(/^attachment;/);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  });
  it("does not render an unsupported MIME type inline", async () => {
    mocks.downloadDocument.mockResolvedValue({
      bytes,
      mimeType: "text/html",
      fileName: "unsupported.html",
    });
    expect(
      (await GET(request("?preview=1"), context)).headers.get(
        "Content-Disposition",
      ),
    ).toMatch(/^attachment;/);
  });
  it.each([
    "preview=0",
    "preview=true",
    "preview=",
    "preview=1&preview=1",
    "companyId=other",
    "url=https://example.invalid",
  ])("rejects ambiguous query %s before file access", async (query) => {
    expect((await GET(request(`?${query}`), context)).status).toBe(422);
    expect(mocks.downloadDocument).not.toHaveBeenCalled();
  });
  it("checks authentication before opening a file", async () => {
    mocks.requireUser.mockRejectedValue(new HttpError(401, "Sign in."));
    expect((await GET(request("?preview=1"), context)).status).toBe(401);
    expect(mocks.downloadDocument).not.toHaveBeenCalled();
  });
  it.each([403, 404, 409])(
    "preserves document permission and integrity denials (%s)",
    async (status) => {
      mocks.downloadDocument.mockRejectedValue(
        new HttpError(status, "Document unavailable."),
      );
      const response = await GET(request("?preview=1"), context);
      expect(response.status).toBe(status);
      expect(response.headers.get("Content-Disposition")).toBeNull();
      expect(await response.json()).toEqual({ error: "Document unavailable." });
    },
  );
});
