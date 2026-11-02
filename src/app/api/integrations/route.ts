import { requireUser } from "@/lib/auth";
import { handle, json } from "@/lib/http";
import { integrationStatus } from "@/lib/services/integrations";
export async function GET() {
  return handle(async () => {
    const actor = await requireUser(["ADMIN", "ACCOUNTS", "MANAGEMENT", "DATA_ENTRY"]);
    const status = await integrationStatus(actor);
    return json(actor.role === "ACCOUNTS" ? { zoho: status.zoho } : status);
  });
}
