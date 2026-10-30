import { requireUser } from "@/lib/auth";
import { json, readJson, sameOrigin } from "@/lib/http";
import { integrationHandle } from "@/lib/integrations/http";
import {
  mapBooksVendor,
  listBooksVendorMappings,
} from "@/lib/integrations/vendor-mapping";
export async function GET(request: Request) {
  return integrationHandle(async () =>
    json(
      await listBooksVendorMappings(
        await requireUser(["ADMIN", "ACCOUNTS", "MANAGEMENT"]),
        new URL(request.url).searchParams.get("organizationId") ?? undefined,
      ),
    ),
  );
}
export async function POST(request: Request) {
  return integrationHandle(async () => {
    sameOrigin(request);
    const actor = await requireUser(["ADMIN"]);
    return json(await mapBooksVendor(actor, await readJson(request)));
  });
}
