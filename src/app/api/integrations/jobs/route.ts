import { requireUser } from "@/lib/auth";
import { json } from "@/lib/http";
import { integrationHandle } from "@/lib/integrations/http";
import { listIntegrationJobs } from "@/lib/integrations/queue";
export async function GET(request?: Request) {
  return integrationHandle(async () =>
    json(
      await listIntegrationJobs(
        await requireUser(["ADMIN", "ACCOUNTS", "MANAGEMENT"]),
        request
          ? (new URL(request.url).searchParams.get("organizationId") ??
              undefined)
          : undefined,
      ),
    ),
  );
}
