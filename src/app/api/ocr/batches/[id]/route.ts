import { requireUser } from "@/lib/auth";
import { handle, json } from "@/lib/http";
import { getOcrBatch } from "@/lib/services/ocr";
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return handle(async () =>
    json({
      batch: await getOcrBatch(await requireUser(), (await context.params).id),
    }),
  );
}
