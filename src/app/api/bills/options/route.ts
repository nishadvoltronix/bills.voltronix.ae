import { requireUser } from "@/lib/auth";
import { HttpError, json } from "@/lib/http";
import { integrationHandle } from "@/lib/integrations/http";
import { getBillBooksOptions } from "@/lib/services/bill-books-options";

export async function GET(request: Request) {
  return integrationHandle(async () => {
    const query = new URL(request.url).searchParams;
    const allowed = ["companyId", "customerQuery", "customerId"];
    if ([...query.keys()].some(key => !allowed.includes(key) || query.getAll(key).length !== 1))
      throw new HttpError(422, "Use one company, customer search phrase and optional customer ID.");
    return json(await getBillBooksOptions(await requireUser(["ADMIN", "ACCOUNTS", "DATA_ENTRY"]), {
      companyId: query.get("companyId") ?? "",
      customerQuery: query.get("customerQuery") ?? "",
      ...(query.has("customerId") ? { customerId: query.get("customerId") } : {}),
    }));
  });
}
