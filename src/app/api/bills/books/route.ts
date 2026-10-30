import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { handle, HttpError, json } from "@/lib/http";
import { listBooksBills } from "@/lib/services/books-import";

const querySchema = z
  .object({
    companyId: z.string().trim().min(1).max(100).optional(),
    q: z.string().trim().max(200).optional(),
    status: z.string().trim().min(1).max(100).optional(),
    currencyCode: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    page: z
      .string()
      .regex(/^[1-9]\d{0,5}$/)
      .default("1")
      .transform(Number)
      .pipe(z.number().max(100_000)),
  })
  .strict();

export async function GET(request: Request) {
  return handle(async () => {
    const actor = await requireUser(["ADMIN", "ACCOUNTS", "MANAGEMENT"]);
    const params = new URL(request.url).searchParams;
    for (const key of params.keys()) {
      if (params.getAll(key).length !== 1)
        throw new HttpError(422, "Provide each search filter only once.");
    }
    const query = querySchema.parse(Object.fromEntries(params));
    return json(await listBooksBills(actor, { ...query, pageSize: 50 }));
  });
}
