import { redirect } from "next/navigation";
import { requirePageUser } from "@/lib/auth";
import { NativeBillPayment } from "@/components/native-bill-payment";

export default async function Page({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ entry?: string; saved?: string }>;
}) {
  const actor = await requirePageUser();
  if (actor.role !== "ADMIN" && actor.role !== "ACCOUNTS") redirect("/bills");
  const [{ id }, query] = await Promise.all([params, searchParams]);
  return <NativeBillPayment id={id} fromEntry={query.entry === "1"} saved={query.saved === "1"} />;
}
