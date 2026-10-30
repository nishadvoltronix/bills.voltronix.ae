import { requireUser } from "@/lib/auth";
import { handle, json } from "@/lib/http";
import { getBooksBill } from "@/lib/services/books-import";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handle(async () => {
    const actor = await requireUser(["ADMIN", "ACCOUNTS", "MANAGEMENT"]);
    return json({ bill: await getBooksBill(actor, (await params).id) });
  });
}
