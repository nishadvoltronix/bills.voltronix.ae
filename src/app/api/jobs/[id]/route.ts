import { requireUser } from "@/lib/auth";
import { handle, json } from "@/lib/http";
import { getJob } from "@/lib/services/catalog";
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return handle(async () =>
    json(await getJob(await requireUser(), (await context.params).id)),
  );
}
