import { requireUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { ocrErrorsCsv } from "@/lib/services/ocr";
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return handle(
    async () =>
      new Response(
        await ocrErrorsCsv(await requireUser(), (await context.params).id),
        {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition":
              'attachment; filename="ocr-processing-errors.csv"',
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
          },
        },
      ),
  );
}
