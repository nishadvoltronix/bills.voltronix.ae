import { requireUser } from "@/lib/auth";
import { integrationHandle, integrationTarget } from "@/lib/integrations/http";
import { callbackUrl, completeOAuth } from "@/lib/integrations/oauth";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ target: string }> },
) {
  return integrationHandle(async () => {
    const actor = await requireUser(["ADMIN"]);
    const target = integrationTarget((await params).target);
    await completeOAuth(actor, target, new URL(request.url).searchParams);
    return new Response(null, {
      status: 303,
      headers: {
        Location: new URL(
          target === "ZOHO" ? "/account/books-authorization" : "/account/crm-authorization",
          callbackUrl(target),
        ).toString(),
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  });
}
