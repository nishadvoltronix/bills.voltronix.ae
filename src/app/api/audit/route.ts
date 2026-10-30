import { requireUser } from "@/lib/auth";
import { handle, json } from "@/lib/http";
import { auditEvents } from "@/lib/services/catalog";
export async function GET() {
  return handle(async () =>
    json({ events: await auditEvents(await requireUser()) }),
  );
}
