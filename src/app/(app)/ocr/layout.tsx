import { requirePageUser } from "@/lib/auth";

export default async function OcrLayout({ children }: { children: React.ReactNode }) {
  await requirePageUser();
  return children;
}
