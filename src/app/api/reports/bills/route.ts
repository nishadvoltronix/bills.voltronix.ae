import { requireUser } from "@/lib/auth";
import { handle, json } from "@/lib/http";
import { expenseReport, exportExpenseReport } from "@/lib/services/reports";
export async function GET(request: Request) {
  return handle(async () => {
    const actor = await requireUser(["ADMIN", "ACCOUNTS", "MANAGEMENT"]);
    const params = new URL(request.url).searchParams;
    const format = params.get("format");
    params.delete("format");
    const report = await expenseReport(actor, params);
    if (format === "csv")
      return new Response(exportExpenseReport(report), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": "attachment; filename=voltronix-expenses.csv",
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    return json({
      ...report,
      rows: report.rows.slice(0, 100),
      previewLimit: 100,
    });
  });
}
