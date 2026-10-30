import { CrmJobProfile } from "@/components/crm-job-profile";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CrmJobProfile id={id} />;
}
