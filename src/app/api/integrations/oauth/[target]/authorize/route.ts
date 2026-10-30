import { requireUser } from "@/lib/auth";
import { json, readJson, sameOrigin } from "@/lib/http";
import { z } from "zod";
import { integrationHandle, integrationTarget } from "@/lib/integrations/http";
import { beginOAuth } from "@/lib/integrations/oauth";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ target: string }> },
) {
  return integrationHandle(async () => {
    sameOrigin(request);
    const actor = await requireUser(["ADMIN"]);
    const input = z
      .object({
        organizationId: z
          .string()
          .regex(/^\d{1,30}$/)
          .optional(),
      })
      .strict()
      .parse(await readJson(request, 2048));
    return json(
      await beginOAuth(
        actor,
        integrationTarget((await params).target),
        input.organizationId,
      ),
    );
  });
}
