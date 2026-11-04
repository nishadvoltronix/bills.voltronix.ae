import "server-only";
import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { MAX_INVOICE_ATTACHMENTS, MAX_INVOICE_BUNDLE_BYTES, MAX_INVOICE_BUNDLE_PAGES,
  MAX_INVOICE_FILE_BYTES, MAX_INVOICE_TOTAL_BYTES } from "@/lib/invoice-attachments";
import { HttpError } from "@/lib/http";

export type InvoiceAttachmentInput = {
  fileName: string; mimeType: string; sha256: string; bytes: Uint8Array;
};
export type PreparedInvoiceAttachment = InvoiceAttachmentInput & { bundled: boolean; sourceCount: number };
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Originals stay immutable. A deterministic PDF represents multiple originals in Books. */
export async function buildInvoiceAttachment(files: readonly InvoiceAttachmentInput[], enforceNewUploadLimits = true): Promise<PreparedInvoiceAttachment> {
  if (!files.length || files.length > MAX_INVOICE_ATTACHMENTS)
    throw new HttpError(422, `Attach between 1 and ${MAX_INVOICE_ATTACHMENTS} invoice files.`);
  const total = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  if ((enforceNewUploadLimits || files.length > 1) &&
    (total > MAX_INVOICE_TOTAL_BYTES || files.some(file => file.bytes.byteLength > MAX_INVOICE_FILE_BYTES)))
    throw new HttpError(413, "Invoice attachments must total 5 MB or less. Choose smaller files before saving.");
  for (const file of files) {
    if (file.bytes.byteLength < 8 || sha(file.bytes) !== file.sha256)
      throw new HttpError(409, "An original invoice attachment failed its integrity check.");
    if (!["application/pdf", "image/jpeg", "image/png"].includes(file.mimeType))
      throw new HttpError(415, "Only PDF, JPEG and PNG invoice files are supported.");
  }
  if (files.length === 1) return { ...files[0], bundled: false, sourceCount: 1 };
  const manifest = createHash("sha256").update(JSON.stringify(files.map(({ fileName, mimeType, sha256 }) => ({ fileName, mimeType, sha256 })))).digest("hex");
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.setTitle("Invoice attachments");
  pdf.setAuthor("VOLTRONIX");
  pdf.setCreator("VOLTRONIX Bills");
  pdf.setProducer("VOLTRONIX Bills attachment bundle v1");
  pdf.setSubject(`Original attachment manifest ${manifest}`);
  pdf.setCreationDate(new Date("2000-01-01T00:00:00.000Z"));
  pdf.setModificationDate(new Date("2000-01-01T00:00:00.000Z"));
  let imagePixels = 0;
  try {
    for (const file of files) {
      if (file.mimeType === "application/pdf") {
        const source = await PDFDocument.load(file.bytes, { updateMetadata: false, throwOnInvalidObject: true });
        if (!source.getPageCount() || pdf.getPageCount() + source.getPageCount() > MAX_INVOICE_BUNDLE_PAGES)
          throw new HttpError(422, `An invoice may contain at most ${MAX_INVOICE_BUNDLE_PAGES} attachment pages.`);
        const pages = await pdf.copyPages(source, source.getPageIndices());
        for (const page of pages) pdf.addPage(page);
      } else {
        // A small compressed PNG can otherwise expand to an unbounded pixel buffer.
        if (file.mimeType === "image/png") {
          const bytes = Buffer.from(file.bytes);
          if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
            bytes.subarray(12, 16).toString("ascii") !== "IHDR") throw new HttpError(422, "An invoice image is invalid.");
          const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
          imagePixels += width * height;
          if (!width || !height || width > 16000 || height > 16000 || imagePixels > 40_000_000)
            throw new HttpError(422, "Invoice images are too large to combine. Choose smaller images.");
        }
        const image = file.mimeType === "image/png" ? await pdf.embedPng(file.bytes) : await pdf.embedJpg(file.bytes);
        if (!Number.isFinite(image.width) || !Number.isFinite(image.height) || image.width <= 0 || image.height <= 0)
          throw new HttpError(422, "An invoice image has invalid dimensions.");
        const landscape = image.width > image.height;
        const [width, height] = landscape ? [841.89, 595.28] : [595.28, 841.89];
        const dimensions = image.scaleToFit(width - 24, height - 24);
        const page = pdf.addPage([width, height]);
        page.drawImage(image, { x: (width - dimensions.width) / 2, y: (height - dimensions.height) / 2, ...dimensions });
      }
      if (pdf.getPageCount() > MAX_INVOICE_BUNDLE_PAGES)
        throw new HttpError(422, `An invoice may contain at most ${MAX_INVOICE_BUNDLE_PAGES} attachment pages.`);
    }
    const bytes = await pdf.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false });
    if (bytes.byteLength > MAX_INVOICE_BUNDLE_BYTES)
      throw new HttpError(413, "The combined invoice PDF exceeds 5 MB. Choose smaller attachments before saving.");
    return { bytes, fileName: `invoice-attachments-${manifest.slice(0, 16)}.pdf`, mimeType: "application/pdf",
      sha256: sha(bytes), bundled: true, sourceCount: files.length };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(422, "An attachment could not be combined. Use a readable, unencrypted PDF, JPEG or PNG.");
  }
}
