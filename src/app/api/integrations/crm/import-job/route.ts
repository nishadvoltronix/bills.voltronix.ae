import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { json, readJson, sameOrigin } from "@/lib/http";
import { integrationHandle } from "@/lib/integrations/http";
import { importCrmJob } from "@/lib/integrations/crm";
export async function POST(request: Request) {
  return integrationHandle(async () => {
    sameOrigin(request);
    const actor = await requireUser(["ADMIN"]);
    const input = z
      .object({ externalId: z.string().regex(/^\d{1,30}$/) })
      .strict()
      .parse(await readJson(request));
    return json({ job: await importCrmJob(actor, input.externalId) });
  });
}
