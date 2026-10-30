import { requireUser } from "@/lib/auth";
import { json, readJson, sameOrigin } from "@/lib/http";
import { integrationHandle } from "@/lib/integrations/http";
import { resolveCrmJob } from "@/lib/services/crm-job-lookup";

export async function POST(request: Request) {
  return integrationHandle(async () => {
    sameOrigin(request);
    return json(await resolveCrmJob(await requireUser(["ADMIN", "ACCOUNTS", "DATA_ENTRY"]), await readJson(request, 4096)));
  });
}
