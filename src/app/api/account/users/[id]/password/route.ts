import { requireUser } from "@/lib/auth";
import { handle, json, readJson, sameOrigin } from "@/lib/http";
import { resetManagedUserPassword } from "@/lib/services/accounts";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    sameOrigin(request);
    const actor = await requireUser(["ADMIN"]);
    return json(await resetManagedUserPassword(actor, (await params).id, await readJson(request, 4096)));
  });
}
