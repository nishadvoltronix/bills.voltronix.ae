import { OcrReviewPage } from "@/components/ocr-workspace";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <OcrReviewPage id={id} />;
}
