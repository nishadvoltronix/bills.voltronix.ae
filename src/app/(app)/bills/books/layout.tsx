import { redirect } from "next/navigation";
import { requirePageUser } from "@/lib/auth";

export default async function BooksBillsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const actor = await requirePageUser();
  if (actor.role === "DATA_ENTRY") redirect("/bills");
  return children;
}
