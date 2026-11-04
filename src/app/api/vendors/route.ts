import { requireUser } from "@/lib/auth";
import { handle, json, readJson, sameOrigin } from "@/lib/http";
import { listVendors } from "@/lib/services/catalog";
import { createVendorAndSync } from "@/lib/services/vendor-books-sync";
export async function GET(request: Request) {
  return handle(async () => {
    const actor = await requireUser();
    return json({
      vendors: await listVendors(
        actor,
        new URL(request.url).searchParams.get("q") ?? "",
        new URL(request.url).searchParams.get("companyId") || undefined,
      ),
    });
  });
}
export async function POST(request: Request) {
  return handle(async () => {
    sameOrigin(request);
    return json(
      await createVendorAndSync(await requireUser(), await readJson(request, 8192)),
      201,
    );
  });
}
