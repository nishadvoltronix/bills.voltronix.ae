import { requireUser } from "@/lib/auth";
import { handle, json } from "@/lib/http";
import { getJob } from "@/lib/services/catalog";
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handle(async () => {
    const actor = await requireUser(["ADMIN", "ACCOUNTS", "MANAGEMENT"]);
    const result = await getJob(actor, (await params).id);
    return json({
      ...result,
      period: "LIFETIME",
      accountingBasis: "VAT_EXCLUSIVE",
      profitStatus: "PROVISIONAL",
      source: "VOLTRONIX_APPROVED_BILLS",
    });
  });
}
