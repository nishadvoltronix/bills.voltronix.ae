import { requireUser } from "@/lib/auth";
import { handle, json } from "@/lib/http";
import { getPaymentAccounts } from "@/lib/services/payment-books-sync";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return handle(async () => json(await getPaymentAccounts(await requireUser(["ADMIN", "ACCOUNTS"]), (await context.params).id)));
}
