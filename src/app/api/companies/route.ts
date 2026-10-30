import { requireUser } from "@/lib/auth";
import { listCompanies } from "@/lib/company";
import { handle, json } from "@/lib/http";

export async function GET() {
  return handle(async () =>
    json({ companies: await listCompanies(await requireUser()) }),
  );
}
