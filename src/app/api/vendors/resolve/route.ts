import { requireUser } from "@/lib/auth";
import { json, readJson, sameOrigin } from "@/lib/http";
import { integrationHandle } from "@/lib/integrations/http";
import { resolveBillVendor } from "@/lib/services/bill-vendor-lookup";

export async function POST(request: Request) {
  return integrationHandle(async () => {
    sameOrigin(request);
    const actor = await requireUser(["ADMIN", "ACCOUNTS", "DATA_ENTRY"]);
    const input = await readJson(request, 4096);
    return json({ vendor: await resolveBillVendor(actor, input) });
  });
}
