import { AuditPage } from "@/components/audit";
import { requirePageUser } from "@/lib/auth";
export default async function Page() {
  await requirePageUser();
  return <AuditPage />;
}
