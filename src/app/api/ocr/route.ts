import { requireUser } from "@/lib/auth";
import { handle, HttpError, json, sameOrigin } from "@/lib/http";
import { canCreateBill } from "@/lib/permissions";
import {
  createOcrBatch,
  listOcrBatches,
  readOcrUploads,
} from "@/lib/services/ocr";
export async function GET(request?: Request) {
  return handle(async () =>
    json(
      await listOcrBatches(
        await requireUser(),
        request
          ? new URL(request.url).searchParams.get("cursor") || undefined
          : undefined,
      ),
    ),
  );
}
export async function POST(request: Request) {
  return handle(async () => {
    sameOrigin(request);
    const actor = await requireUser();
    if (!canCreateBill(actor))
      throw new HttpError(403, "Your role cannot upload OCR invoices.");
    return json(
      {
        batch: await createOcrBatch(
          actor,
          await readOcrUploads(request),
          new URL(request.url).searchParams.get("companyId") || undefined,
        ),
      },
      201,
    );
  });
}
