import { requireUser } from "@/lib/auth";
import { handle, json } from "@/lib/http";
export async function GET() {
  return handle(async () => json({ user: await requireUser() }));
}
