import { requireUser } from "@/lib/auth";
import { handle, json } from "@/lib/http";
import { getCrmJobSnapshot } from "@/lib/services/crm-job-import";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return handle(async () =>
    json({
      job: await getCrmJobSnapshot(
        await requireUser(),
        (await context.params).id,
      ),
    }),
  );
}
