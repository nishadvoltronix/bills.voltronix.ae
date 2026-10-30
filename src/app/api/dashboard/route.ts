import { requireUser } from "@/lib/auth";
import { handle, json } from "@/lib/http";
import { dashboard } from "@/lib/services/catalog";
export async function GET(request: Request) {
  return handle(async () =>
    json(
      await dashboard(await requireUser(), new URL(request.url).searchParams),
    ),
  );
}
