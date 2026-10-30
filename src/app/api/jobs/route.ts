import { requireUser } from "@/lib/auth";
import { handle, json, readJson, sameOrigin } from "@/lib/http";
import { createJob, listJobs } from "@/lib/services/catalog";
export async function GET(request: Request) {
  return handle(async () =>
    json({
      jobs: await listJobs(
        await requireUser(),
        new URL(request.url).searchParams.get("q") ?? "",
        new URL(request.url).searchParams.get("companyId") || undefined,
      ),
    }),
  );
}
export async function POST(request: Request) {
  return handle(async () => {
    sameOrigin(request);
    return json(
      {
        job: await createJob(
          await requireUser(),
          await readJson(request, 8192),
        ),
      },
      201,
    );
  });
}
