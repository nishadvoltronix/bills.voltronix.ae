import { requireUser } from "@/lib/auth";
import { handle, json } from "@/lib/http";
import { listManagedUsers } from "@/lib/services/accounts";

export async function GET() {
  return handle(async () => json({ users: await listManagedUsers(await requireUser(["ADMIN"])) }));
}
