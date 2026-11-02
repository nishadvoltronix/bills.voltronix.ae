import { Suspense } from "react";
import { JobsPage } from "@/components/jobs";
import { LoadingPanel } from "@/components/ui";
import { requirePageUser } from "@/lib/auth";
export default async function Page() {
  await requirePageUser();
  return (
    <Suspense fallback={<LoadingPanel />}>
      <JobsPage />
    </Suspense>
  );
}
