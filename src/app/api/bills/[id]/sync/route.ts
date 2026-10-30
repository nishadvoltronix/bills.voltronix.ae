import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { json, readJson, sameOrigin } from "@/lib/http";
import { integrationHandle } from "@/lib/integrations/http";
import { queueBill } from "@/lib/integrations/queue";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return integrationHandle(async () => {
    sameOrigin(request);
    const actor = await requireUser(["ADMIN", "ACCOUNTS", "DATA_ENTRY"]);
    const input = z
      .object({
        target: z.enum(["ZOHO", "CRM"]),
        organizationId: z
          .string()
          .regex(/^\d{1,30}$/)
          .optional(),
      })
      .strict()
      .parse(await readJson(request));
    const job = await queueBill(
      actor,
      (await params).id,
      input.target,
      input.organizationId,
    );
    return json(
      {
        job: {
          id: job.id,
          status: job.status,
          target: job.target,
          organizationId: job.organizationId,
        },
      },
      202,
    );
  });
}
