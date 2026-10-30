import { requireUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { downloadOcrDocument } from "@/lib/services/ocr";
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return handle(async () => {
    const file = await downloadOcrDocument(
      await requireUser(),
      (await context.params).id,
    );
    return new Response(new Uint8Array(file.bytes), {
      headers: {
        "Content-Type": file.mimeType,
        "Content-Length": String(file.bytes.length),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'",
      },
    });
  });
}
