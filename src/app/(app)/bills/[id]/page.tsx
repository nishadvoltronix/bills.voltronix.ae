import { BillDetail } from "@/components/bill-detail";
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  return <BillDetail id={id} saved={query.saved === "1"} />;
}
