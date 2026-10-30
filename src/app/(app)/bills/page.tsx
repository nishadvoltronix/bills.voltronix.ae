import { Suspense } from "react";
import { BillsList } from "@/components/bills-list";
import { LoadingPanel } from "@/components/ui";
export default function Page() {
  return (
    <Suspense fallback={<LoadingPanel />}>
      <BillsList />
    </Suspense>
  );
}
