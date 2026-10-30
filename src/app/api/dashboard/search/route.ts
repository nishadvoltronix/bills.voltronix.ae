import { requireUser } from "@/lib/auth";
import { handle, json } from "@/lib/http";
import { searchDashboard } from "@/lib/services/dashboard-search";

export async function GET(request: Request) {
  return handle(async () =>
    json(
      await searchDashboard(
        await requireUser(),
        new URL(request.url).searchParams,
      ),
    ),
  );
}
