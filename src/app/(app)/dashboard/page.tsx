import { DashboardPage } from "@/components/dashboard";
import { requirePageUser } from "@/lib/auth";
export default async function Page() {
  await requirePageUser();
  return <DashboardPage />;
}
