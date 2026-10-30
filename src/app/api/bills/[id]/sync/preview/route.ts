import { requireUser } from "@/lib/auth";
import { json, sameOrigin } from "@/lib/http";
import { integrationHandle } from "@/lib/integrations/http";

export async function POST(request: Request) {
  return integrationHandle(async () => {
    sameOrigin(request);
    await requireUser(["ADMIN", "ACCOUNTS", "DATA_ENTRY"]);
    return json({ error: "Books synchronization starts from the final bill save. A separate confirmation is no longer required." }, 410);
  });
}
