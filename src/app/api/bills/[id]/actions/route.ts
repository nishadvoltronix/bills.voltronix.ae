import { requireUser } from "@/lib/auth";
import { handle, json, readJson, sameOrigin } from "@/lib/http";
import { actOnBill } from "@/lib/services/bills";
import { scheduleBillSyncAfterResponse } from "@/lib/integrations/immediate-bill-sync";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return handle(async () => {
    sameOrigin(request);
    const actor = await requireUser(), payload = await readJson(request, 8192);
    const bill = await actOnBill(actor, (await context.params).id, payload);
    if (payload && typeof payload === "object" && "action" in payload && payload.action === "submit")
      scheduleBillSyncAfterResponse(actor, bill);
    return json({ bill });
  });
}
