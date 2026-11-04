import { requireUser } from "@/lib/auth";
import { handle, json, sameOrigin } from "@/lib/http";
import { manualBillAutofillCapability, previewManualBillAutofill, readManualBillAutofillUpload } from "@/lib/services/manual-bill-autofill";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return handle(async () => {
    const actor = await requireUser(["ADMIN", "ACCOUNTS", "DATA_ENTRY"]);
    const query = new URL(request.url).searchParams;
    return json(await manualBillAutofillCapability(actor, { companyId: query.get("companyId"), jobId: query.get("jobId") }));
  });
}

export async function POST(request: Request) {
  return handle(async () => {
    sameOrigin(request);
    const actor = await requireUser(["ADMIN", "ACCOUNTS", "DATA_ENTRY"]);
    return json(await previewManualBillAutofill(actor, await readManualBillAutofillUpload(request)));
  });
}
