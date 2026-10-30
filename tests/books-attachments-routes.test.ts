import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/bills/books/[id]/attachments/[attachmentId]/route";
import { HttpError } from "@/lib/http";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  downloadBooksBillAttachment: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/services/books-attachments", () => ({
  downloadBooksBillAttachment: mocks.downloadBooksBillAttachment,
}));

const actor = { id: "fictional-reader", role: "ACCOUNTS" };
const bytes = Buffer.from("%PDF-1.7\nFictional original bytes\n%%EOF");
const context = {
  params: Promise.resolve({
    id: "fictional-bill",
    attachmentId: "fictional-attachment",
  }),
};
const request = (query = "") =>
  new Request(
    `http://localhost/api/bills/books/fictional-bill/attachments/fictional-attachment${query ? `?${query}` : ""}`,
  );

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue(actor);
  mocks.downloadBooksBillAttachment.mockResolvedValue({
    bytes,
    fileName: "Fictional supplier's bill.pdf",
    mimeType: "application/pdf",
    byteSize: bytes.byteLength,
  });
});

describe("original Zoho Books attachment route", () => {
  it("serves original bytes through current actor and bill authorization with private preview headers", async () => {
    const response = await GET(request(), context);
    expect(response.status).toBe(200);
    expect(mocks.requireUser).toHaveBeenCalledWith([
      "ADMIN",
      "ACCOUNTS",
      "MANAGEMENT",
    ]);
    expect(mocks.downloadBooksBillAttachment).toHaveBeenCalledWith(
      actor,
      "fictional-bill",
      "fictional-attachment",
    );
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Content-Length")).toBe(
      String(bytes.byteLength),
    );
    expect(response.headers.get("Content-Disposition")).toBe(
      "inline; filename=\"Fictional_supplier_s_bill.pdf\"; filename*=UTF-8''Fictional%20supplier%27s%20bill.pdf",
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "sandbox; default-src 'none'",
    );
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("uses attachment disposition for explicit downloads and retains the original Unicode filename safely", async () => {
    mocks.downloadBooksBillAttachment.mockResolvedValue({
      bytes,
      fileName: 'فاتورة "(1)"\r\n/scan.pdf',
      mimeType: "application/pdf",
      byteSize: bytes.byteLength,
    });
    const response = await GET(request("download=1"), context);
    const disposition = response.headers.get("Content-Disposition")!;
    expect(disposition).toMatch(/^attachment; filename="[a-zA-Z0-9._-]+";/);
    expect(disposition).toContain(
      "filename*=UTF-8''%D9%81%D8%A7%D8%AA%D9%88%D8%B1%D8%A9%20%22%281%29%22_scan.pdf",
    );
    expect(disposition).not.toContain("\r");
    expect(disposition).not.toContain("\n");
  });

  it("never renders an unrecognized file format inline", async () => {
    mocks.downloadBooksBillAttachment.mockResolvedValue({
      bytes,
      fileName: "Fictional file.bin",
      mimeType: "application/octet-stream",
      byteSize: bytes.byteLength,
    });
    const response = await GET(request(), context);
    expect(response.headers.get("Content-Disposition")).toMatch(/^attachment;/);
  });

  it.each([
    "download=0",
    "download=true",
    "download=",
    "download=1&download=1",
    "companyId=other",
    "url=https%3A%2F%2Fexample.invalid",
  ])("rejects ambiguous or overriding query parameters: %s", async (query) => {
    expect((await GET(request(query), context)).status).toBe(422);
    expect(mocks.downloadBooksBillAttachment).not.toHaveBeenCalled();
  });

  it.each([401, 403])(
    "rejects unauthorized readers before disk access (%s)",
    async (status) => {
      mocks.requireUser.mockRejectedValue(
        new HttpError(status, "Access denied."),
      );
      expect((await GET(request(), context)).status).toBe(status);
      expect(mocks.downloadBooksBillAttachment).not.toHaveBeenCalled();
    },
  );

  it("preserves inaccessible, removed or missing attachment denial without leaking file data", async () => {
    mocks.downloadBooksBillAttachment.mockRejectedValue(
      new HttpError(404, "Attachment not found."),
    );
    const response = await GET(request(), context);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Attachment not found." });
    expect(response.headers.get("Content-Disposition")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
