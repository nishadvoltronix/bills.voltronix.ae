import { requireUser } from "@/lib/auth";
import { json, readJson, sameOrigin } from "@/lib/http";
import { integrationHandle } from "@/lib/integrations/http";
import { scheduleIntegrationJob } from "@/lib/integrations/queue";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return integrationHandle(async () => {
    sameOrigin(request);
    const actor = await requireUser(["ADMIN", "ACCOUNTS"]);
    return json(
      await scheduleIntegrationJob(
        actor,
        (await params).id,
        await readJson(request),
      ),
    );
  });
}
