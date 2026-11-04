import { requireUser } from "@/lib/auth";
import { handle, json, readJson, sameOrigin } from "@/lib/http";
import { getBill, updateBill } from "@/lib/services/bills";
import { scheduleBillSyncAfterResponse } from "@/lib/integrations/immediate-bill-sync";
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context) {
  return handle(async () =>
    json({
      bill: await getBill(await requireUser(), (await context.params).id),
    }),
  );
}
export async function PATCH(request: Request, context: Context) {
  return handle(async () => {
    sameOrigin(request);
    const actor = await requireUser();
    const bill = await updateBill(actor, (await context.params).id, await readJson(request));
    scheduleBillSyncAfterResponse(actor, bill);
    return json({ bill });
  });
}
