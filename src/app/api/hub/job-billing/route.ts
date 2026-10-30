import { HttpError, json } from "@/lib/http";
import { verifyHubRequest } from "@/lib/hub-bridge/verify";
import { readHubJobBilling } from "@/lib/hub-bridge/service";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try { return json(await readHubJobBilling(verifyHubRequest(request))); }
  catch (error) {
    return json({ state: "unavailable" }, error instanceof HttpError ? error.status : 503);
  }
}
