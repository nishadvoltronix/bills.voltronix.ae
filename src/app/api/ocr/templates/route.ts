import { requireUser } from "@/lib/auth";
import { handle, json, readJson, sameOrigin } from "@/lib/http";
import { createOcrTemplate, listOcrTemplates } from "@/lib/services/ocr";
export async function GET() {
  return handle(async () =>
    json({ templates: await listOcrTemplates(await requireUser()) }),
  );
}
export async function POST(request: Request) {
  return handle(async () => {
    sameOrigin(request);
    return json(
      {
        template: await createOcrTemplate(
          await requireUser(),
          await readJson(request),
        ),
      },
      201,
    );
  });
}
