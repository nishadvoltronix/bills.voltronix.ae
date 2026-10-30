import { requireUser } from "@/lib/auth";
import { handle, HttpError, json } from "@/lib/http";
import { getIncomingSyncStatus } from "@/lib/services/incoming-sync-status";

export async function GET(request: Request) {
  return handle(async () => {
    const actor = await requireUser(["ADMIN", "ACCOUNTS", "MANAGEMENT"]);
    const params = new URL(request.url).searchParams;
    const companyId = params.get("companyId") ?? undefined;
    if ([...params.keys()].some(key => key !== "companyId") ||
      params.getAll("companyId").length > 1 ||
      (companyId !== undefined && (!companyId.trim() || companyId.length > 100)))
      throw new HttpError(422, "Choose one company to view incoming synchronization status.");
    return json(await getIncomingSyncStatus(actor, companyId));
  });
}
