import { requireUser } from "@/lib/auth";
import { handle, json } from "@/lib/http";
import { operationSummary } from "@/lib/services/reports";
export async function GET() {
  return handle(async () => json(await operationSummary(await requireUser())));
}
