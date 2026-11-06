import { requireUser } from "@/lib/auth";
import { handle, json } from "@/lib/http";
import { getBillItemSuggestions } from "@/lib/services/bill-item-suggestions";

export async function GET(request: Request) {
  return handle(async () => json(await getBillItemSuggestions(
    await requireUser(["ADMIN", "ACCOUNTS", "DATA_ENTRY"]),
    new URL(request.url).searchParams,
  )));
}
