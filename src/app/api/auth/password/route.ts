import { requireUser, clearSessionCookie } from "@/lib/auth";
import { handle, json, readJson, sameOrigin } from "@/lib/http";
import { changeOwnPassword } from "@/lib/services/accounts";

export async function POST(request: Request) {
  return handle(async () => {
    sameOrigin(request);
    const actor = await requireUser();
    const result = await changeOwnPassword(
      actor,
      await readJson(request, 4096),
    );
    await clearSessionCookie();
    return json(result);
  });
}
