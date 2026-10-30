import { requireUser } from "@/lib/auth";
import { handle, json } from "@/lib/http";
import { getOcrDocument } from "@/lib/services/ocr";
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return handle(async () =>
    json({
      document: await getOcrDocument(
        await requireUser(),
        (await context.params).id,
      ),
    }),
  );
}
