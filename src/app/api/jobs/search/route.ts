import { requireUser } from "@/lib/auth";
import { HttpError, json } from "@/lib/http";
import { integrationHandle } from "@/lib/integrations/http";
import { searchCrmJobs } from "@/lib/services/crm-job-lookup";

export async function GET(request: Request) {
  return integrationHandle(async () => {
    const query = new URL(request.url).searchParams;
    if ([...query.keys()].some(key => !["companyId", "q"].includes(key) || query.getAll(key).length !== 1))
      throw new HttpError(422, "Use one company and one job number or CRM record ID.");
    return json(await searchCrmJobs(await requireUser(["ADMIN", "ACCOUNTS", "DATA_ENTRY"]), {
      ...(query.has("companyId") ? { companyId: query.get("companyId") } : {}), q: query.get("q") ?? "",
    }));
  });
}
