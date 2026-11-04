import { requireUser } from "@/lib/auth";
import { handle, json, readJson, sameOrigin } from "@/lib/http";
import { createBill, listBills } from "@/lib/services/bills";
import { scheduleBillSyncAfterResponse } from "@/lib/integrations/immediate-bill-sync";
export async function GET(request: Request) {
  return handle(async () =>
    json(
      await listBills(await requireUser(), new URL(request.url).searchParams),
    ),
  );
}
export async function POST(request: Request) {
  return handle(async () => {
    sameOrigin(request);
    const actor = await requireUser();
    const bill = await createBill(actor, await readJson(request));
    scheduleBillSyncAfterResponse(actor, bill);
    return json({ bill }, 201);
  });
}
