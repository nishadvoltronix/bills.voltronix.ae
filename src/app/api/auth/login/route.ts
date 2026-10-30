import { signIn } from "@/lib/auth";
import { handle, json, readJson, sameOrigin } from "@/lib/http";
import { loginSchema } from "@/lib/validation";
export const runtime = "nodejs";
export async function POST(request: Request) {
  return handle(async () => {
    sameOrigin(request);
    const input = loginSchema.parse(await readJson(request, 4096));
    return json({ user: await signIn(input.email, input.password) });
  });
}
