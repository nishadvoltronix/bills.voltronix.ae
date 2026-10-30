import { redirect } from "next/navigation";
import { requirePageUser } from "@/lib/auth";
import { getConfig } from "@/lib/integrations/config";
import { integrationStatus } from "@/lib/services/integrations";
import { BooksAuthorization } from "@/components/books-authorization";

export default async function Page() {
  const actor = await requirePageUser();
  if (actor.role !== "ADMIN") redirect("/account");
  const status = await integrationStatus(actor);
  const organizations = status.zoho.organizations.map((organization) => ({
    id: organization.organizationId,
    name: organization.name,
    authorized: organization.status === "AUTHORIZED_UNVERIFIED",
    canAuthorize: organization.authorization.canAuthorize,
    callbackUrl: organization.authorization.callbackUrl,
    reason: organization.authorization.reason,
    accountsOrigin: organization.authorization.canAuthorize
      ? getConfig("ZOHO", process.env, organization.organizationId)
          .accountsOrigin
      : null,
  }));
  return <BooksAuthorization organizations={organizations} />;
}
