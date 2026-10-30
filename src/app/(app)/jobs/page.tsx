import { Suspense } from "react";
import { JobsPage } from "@/components/jobs";
import { LoadingPanel } from "@/components/ui";
export default function Page() {
  return (
    <Suspense fallback={<LoadingPanel />}>
      <JobsPage />
    </Suspense>
  );
}
