import { redirect } from "next/navigation";
import { requirePageUser } from "@/lib/auth";
import { CrmAuthorization } from "@/components/crm-authorization";

export default async function Page() {
  const actor = await requirePageUser();
  if (actor.role !== "ADMIN") redirect("/account");
  return <CrmAuthorization />;
}
