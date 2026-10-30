import { requireUser } from "@/lib/auth";
import { handle, HttpError } from "@/lib/http";
import { downloadDocument } from "@/lib/services/documents";
export const runtime = "nodejs";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return handle(async () => {
    const actor = await requireUser();
    const params = new URL(request.url).searchParams;
    if (
      [...params.keys()].some((key) => key !== "preview") ||
      params.getAll("preview").length > 1 ||
      (params.has("preview") && params.get("preview") !== "1")
    )
      throw new HttpError(422, "Use preview=1 to open the document.");
    const document = await downloadDocument(actor, (await context.params).id);
    const fallback = document.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const encodedName = encodeURIComponent(document.fileName).replace(
      /['()*]/g,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    const preview =
      params.has("preview") &&
      ["application/pdf", "image/png", "image/jpeg"].includes(
        document.mimeType,
      );
    return new Response(new Uint8Array(document.bytes), {
      headers: {
        "Content-Type": document.mimeType,
        "Content-Length": String(document.bytes.byteLength),
        "Content-Disposition": `${preview ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encodedName}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'",
        "Referrer-Policy": "no-referrer",
      },
    });
  });
}
