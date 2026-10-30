import { requireUser } from "@/lib/auth";
import { handle, json, readJson, sameOrigin } from "@/lib/http";
import { actOnBill } from "@/lib/services/bills";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return handle(async () => {
    sameOrigin(request);
    return json({
      bill: await actOnBill(
        await requireUser(),
        (await context.params).id,
        await readJson(request, 8192),
      ),
    });
  });
}
