import { Suspense } from "react";
import { BillsList } from "@/components/bills-list";
import { LoadingPanel } from "@/components/ui";
import { requirePageUser } from "@/lib/auth";
export default async function Page() {
  await requirePageUser();
  return (
    <Suspense fallback={<LoadingPanel />}>
      <BillsList approvals />
    </Suspense>
  );
}
