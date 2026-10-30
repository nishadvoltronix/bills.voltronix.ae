import { requireUser } from "@/lib/auth";
import { handle, json, readJson, sameOrigin } from "@/lib/http";
import { retryOcrDocument } from "@/lib/services/ocr";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return handle(async () => {
    sameOrigin(request);
    return json({
      document: await retryOcrDocument(
        await requireUser(),
        (await context.params).id,
        await readJson(request),
      ),
    });
  });
}
