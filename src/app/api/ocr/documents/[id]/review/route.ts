import { requireUser } from "@/lib/auth";
import { handle, json, readJson, sameOrigin } from "@/lib/http";
import { reviewOcrDocument } from "@/lib/services/ocr";
import { scheduleBillSyncAfterResponse } from "@/lib/integrations/immediate-bill-sync";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return handle(async () => {
    sameOrigin(request);
    const actor = await requireUser();
    const bill = await reviewOcrDocument(actor, (await context.params).id, await readJson(request));
    scheduleBillSyncAfterResponse(actor, bill);
    return json({ bill });
  });
}
