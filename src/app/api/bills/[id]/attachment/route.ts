import { requireUser } from "@/lib/auth";
import { handle, HttpError, json, sameOrigin } from "@/lib/http";
import { attachDocument, readUpload } from "@/lib/services/documents";
export const runtime = "nodejs";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return handle(async () => {
    sameOrigin(request);
    // Reject read-only roles before buffering a potentially large upload.
    const actor = await requireUser(["ADMIN", "ACCOUNTS", "DATA_ENTRY"]);
    const versionHeader = request.headers.get("x-bill-version");
    const expectedVersion =
      versionHeader === null ? undefined : Number(versionHeader);
    if (
      versionHeader !== null &&
      (!/^[1-9]\d{0,14}$/.test(versionHeader) ||
        !Number.isSafeInteger(expectedVersion))
    )
      throw new HttpError(
        422,
        "Use the version of the saved bill when uploading its attachment.",
      );
    return json(
      {
        document: await attachDocument(
          actor,
          (await context.params).id,
          await readUpload(request),
          expectedVersion,
        ),
      },
      201,
    );
  });
}
