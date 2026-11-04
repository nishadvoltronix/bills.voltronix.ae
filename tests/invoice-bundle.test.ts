import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { buildInvoiceAttachment, type InvoiceAttachmentInput } from "@/lib/integrations/invoice-bundle";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKXcAAAAASUVORK5CYII=", "base64");
const file = (bytes: Uint8Array, fileName = "original.png", mimeType = "image/png"): InvoiceAttachmentInput => ({
  bytes, fileName, mimeType, sha256: createHash("sha256").update(bytes).digest("hex"),
});
async function originalPdf(pages = 2) {
  const pdf = await PDFDocument.create();
  for (let index = 0; index < pages; index++) pdf.addPage([250 + index * 10, 400 + index * 10]);
  return file(await pdf.save(), "original.pdf", "application/pdf");
}

describe("multiple original invoice attachment representation", () => {
  it("preserves a single original byte for byte, including its name and digest", async () => {
    const input = file(png), result = await buildInvoiceAttachment([input]);
    expect(result.bytes).toBe(input.bytes);
    expect(result).toMatchObject({ fileName: input.fileName, sha256: input.sha256, mimeType: "image/png", bundled: false, sourceCount: 1 });
  });

  it("combines every image and every PDF page in stable order without changing any original", async () => {
    const files = [file(png), await originalPdf(), file(png, "second-image.png")];
    const hashes = files.map(input => input.sha256);
    const result = await buildInvoiceAttachment(files);
    const loaded = await PDFDocument.load(result.bytes);
    expect(loaded.getPageCount()).toBe(4);
    expect(loaded.getPages().slice(1, 3).map(page => [page.getWidth(), page.getHeight()])).toEqual([[250, 400], [260, 410]]);
    expect(result).toMatchObject({ bundled: true, sourceCount: 3, mimeType: "application/pdf" });
    expect(files.map(input => file(input.bytes).sha256)).toEqual(hashes);
  });

  it("produces identical PDF bytes and SHA for recovery, while changed original/order gives a distinct result", async () => {
    const files = [file(png), await originalPdf(1)];
    const one = await buildInvoiceAttachment(files), again = await buildInvoiceAttachment(files);
    expect(Buffer.from(one.bytes)).toEqual(Buffer.from(again.bytes));
    expect(one.sha256).toBe(again.sha256);
    const reversed = await buildInvoiceAttachment([...files].reverse());
    expect(reversed.sha256).not.toBe(one.sha256);
    expect(reversed.fileName).not.toBe(one.fileName);
  });

  it("rejects tampered source bytes instead of deriving a misleading attachment", async () => {
    await expect(buildInvoiceAttachment([{ ...file(png), sha256: "0".repeat(64) }, await originalPdf()])).rejects.toMatchObject({ status: 409 });
  });

  it("enforces new file count and aggregate size without changing legacy single-file reads", async () => {
    await expect(buildInvoiceAttachment([])).rejects.toMatchObject({ status: 422 });
    await expect(buildInvoiceAttachment(Array.from({ length: 6 }, () => file(png)))).rejects.toMatchObject({ status: 422 });
    const large = file(Buffer.alloc(5_000_001), "legacy.pdf", "application/pdf");
    await expect(buildInvoiceAttachment([large])).rejects.toMatchObject({ status: 413 });
    expect((await buildInvoiceAttachment([large], false)).bytes).toBe(large.bytes);
  });

  it("rejects invalid or encrypted PDFs as an actionable upload error", async () => {
    await expect(buildInvoiceAttachment([file(png), file(Buffer.from("%PDF-broken original"), "broken.pdf", "application/pdf")])).rejects.toMatchObject({ status: 422 });
  });

  it("bounds PDF page expansion and compressed PNG dimensions", async () => {
    await expect(buildInvoiceAttachment([file(png), await originalPdf(100)])).rejects.toMatchObject({ status: 422 });
    const oversized = Buffer.from(png);
    oversized.writeUInt32BE(100_000, 16);
    await expect(buildInvoiceAttachment([file(oversized), await originalPdf(1)])).rejects.toMatchObject({ status: 422 });
  });
});
