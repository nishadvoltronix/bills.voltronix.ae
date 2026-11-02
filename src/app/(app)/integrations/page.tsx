import { redirect } from "next/navigation";
import { requirePageUser } from "@/lib/auth";
export default async function Page() {
  await requirePageUser();
  redirect("/bills");
}
