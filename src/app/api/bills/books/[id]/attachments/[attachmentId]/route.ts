import { requireUser } from "@/lib/auth";
import { handle, HttpError } from "@/lib/http";
import { downloadBooksBillAttachment } from "@/lib/services/books-attachments";

export const runtime = "nodejs";

const previewTypes = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; attachmentId: string }> },
) {
  return handle(async () => {
    const actor = await requireUser(["ADMIN", "ACCOUNTS", "MANAGEMENT"]);
    const query = new URL(request.url).searchParams;
    if (
      [...query.keys()].some((key) => key !== "download") ||
      query.getAll("download").length > 1 ||
      (query.has("download") && query.get("download") !== "1")
    ) {
      throw new HttpError(422, "Use download=1 to download the original file.");
    }
    const { id, attachmentId } = await params;
    const file = await downloadBooksBillAttachment(actor, id, attachmentId);
    const fileName =
      file.fileName
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .replace(/[\\/]/g, "_")
        .toWellFormed() || "Zoho attachment";
    const fallback = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const encodedName = encodeURIComponent(fileName).replace(
      /['()*]/g,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    const disposition =
      query.has("download") || !previewTypes.has(file.mimeType)
        ? "attachment"
        : "inline";
    return new Response(new Uint8Array(file.bytes), {
      headers: {
        "Content-Type": file.mimeType,
        "Content-Length": String(file.bytes.byteLength),
        "Content-Disposition": `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodedName}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'",
        "Referrer-Policy": "no-referrer",
      },
    });
  });
}
