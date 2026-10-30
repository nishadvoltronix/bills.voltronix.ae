import { BooksBillsList } from "@/components/books-bills";

export default async function Page({ searchParams }: { searchParams: Promise<{ companyId?: string | string[] }> }) {
  const { companyId } = await searchParams;
  const selectedCompany = typeof companyId === "string" && companyId.length <= 100 ? companyId : "";
  return <BooksBillsList key={selectedCompany} initialCompanyId={selectedCompany} />;
}
