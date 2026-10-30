import { requireUser } from "@/lib/auth";
import { HttpError, json } from "@/lib/http";
import { integrationHandle } from "@/lib/integrations/http";
import { listCompanyVendorDirectory } from "@/lib/services/bill-vendor-lookup";

export async function GET(request: Request) {
  return integrationHandle(async () => {
    const query = new URL(request.url).searchParams;
    const allowed = ["companyId", "q", "page"];
    if ([...query.keys()].some(key => !allowed.includes(key) || query.getAll(key).length !== 1) ||
      (query.has("page") && !/^[1-9]\d{0,4}$/.test(query.get("page")!)))
      throw new HttpError(422, "Use one company, search phrase and positive page number.");
    return json(await listCompanyVendorDirectory(await requireUser(["ADMIN", "ACCOUNTS", "DATA_ENTRY", "MANAGEMENT"]), {
      companyId: query.get("companyId") ?? "", q: query.get("q") ?? "", page: query.has("page") ? Number(query.get("page")) : 1,
    }));
  });
}
