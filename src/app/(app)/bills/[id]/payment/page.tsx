import { redirect } from "next/navigation";
import { requirePageUser } from "@/lib/auth";
import { NativeBillPayment } from "@/components/native-bill-payment";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePageUser();
  if (actor.role !== "ADMIN" && actor.role !== "ACCOUNTS") redirect("/bills");
  const { id } = await params;
  return <NativeBillPayment id={id} />;
}
