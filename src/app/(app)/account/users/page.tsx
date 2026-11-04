import { redirect } from "next/navigation";
import { requirePageUser } from "@/lib/auth";
import { roleHomePath } from "@/lib/auth-navigation";
import { AdminUserPasswords } from "@/components/admin-user-passwords";

export default async function Page() {
  const actor = await requirePageUser();
  if (actor.role !== "ADMIN") redirect(roleHomePath(actor.role));
  return <AdminUserPasswords />;
}
