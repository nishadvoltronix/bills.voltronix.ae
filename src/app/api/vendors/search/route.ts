import { requireUser } from "@/lib/auth";
import { HttpError, json } from "@/lib/http";
import { integrationHandle } from "@/lib/integrations/http";
import { searchBillVendors } from "@/lib/services/bill-vendor-lookup";

export async function GET(request: Request) {
  return integrationHandle(async () => {
    const parameters = new URL(request.url).searchParams;
    const allowed = ["companyId", "q", "vendorId"];
    if ([...parameters.keys()].some(key => !allowed.includes(key) || parameters.getAll(key).length !== 1))
      throw new HttpError(422, "Use one company, search phrase and optional saved vendor ID.");
    return json(await searchBillVendors(await requireUser(["ADMIN", "ACCOUNTS", "DATA_ENTRY"]), {
      companyId: parameters.get("companyId") ?? "",
      q: parameters.get("q") ?? "",
      ...(parameters.has("vendorId") ? { vendorId: parameters.get("vendorId") } : {}),
    }));
  });
}
