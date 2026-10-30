import { requireUser, signOut } from "@/lib/auth";
import { handle, json, sameOrigin } from "@/lib/http";
export async function POST(request: Request) {
  return handle(async () => {
    sameOrigin(request);
    await requireUser();
    await signOut();
    return json({ success: true });
  });
}
