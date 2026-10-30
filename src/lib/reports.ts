import { z } from "zod";
import { billStatusSchema, categorySchema, currencySchema } from "./validation";

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return (
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value &&
      value >= "1900-01-01" &&
      value <= "2199-12-31"
    );
  }, "Use a valid calendar date.");
export const reportFilterSchema = z
  .object({
    companyId: z.string().min(1).max(100).optional(),
    currency: currencySchema.default("AED"),
    jobId: z.string().min(1).max(100).optional(),
    vendorId: z.string().min(1).max(100).optional(),
    category: categorySchema.optional(),
    status: billStatusSchema.optional(),
    from: date.optional(),
    to: date.optional(),
  })
  .strict()
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: "Start date must not follow end date.",
    path: ["to"],
  });
export function parseReportFilters(params: URLSearchParams) {
  return reportFilterSchema.parse(
    Object.fromEntries([...params].filter(([, value]) => value !== "")),
  );
}
export function csvCell(value: unknown) {
  let text = String(value ?? "");
  // Excel/LibreOffice interpret formulas even when a cell is quoted.
  if (/^[\s\u0000-\u001f]*[=+@-]/u.test(text) || /^[\t\r\n]/u.test(text))
    text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function csv(rows: unknown[][]) {
  return "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}
