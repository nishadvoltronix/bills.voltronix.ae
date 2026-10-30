import { requireUser } from "@/lib/auth";
import { json } from "@/lib/http";
import { integrationHandle } from "@/lib/integrations/http";
import { crmAuthorizationStatus } from "@/lib/services/crm-authorization";

export async function GET() {
  return integrationHandle(async () => json(await crmAuthorizationStatus(await requireUser(["ADMIN"]))));
}
