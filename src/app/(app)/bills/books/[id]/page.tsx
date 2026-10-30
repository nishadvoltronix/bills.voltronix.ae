import { BooksBillDetail } from "@/components/books-bills";

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return <BooksBillDetail id={(await params).id} />;
}
