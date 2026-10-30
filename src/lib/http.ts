import { Prisma } from "@prisma/client";
import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function sameOrigin(request: Request): void {
  const configured = process.env.APP_URL;
  if (!configured)
    throw new HttpError(503, "Application origin is not configured.");
  let origin: string;
  try {
    origin = new URL(configured).origin;
  } catch {
    throw new HttpError(503, "Application origin is not configured correctly.");
  }
  if (request.headers.get("origin") !== origin)
    throw new HttpError(
      403,
      "This request did not originate from this application.",
    );
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && !["same-origin", "none"].includes(fetchSite))
    throw new HttpError(403, "Cross-site requests are not permitted.");
}

export async function readJson(
  request: Request,
  maximumBytes = 128 * 1024,
): Promise<unknown> {
  const mediaType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (mediaType !== "application/json")
    throw new HttpError(415, "Use an application/json request body.");
  const declaredSize = Number(request.headers.get("content-length") ?? 0);
  if (declaredSize > maximumBytes)
    throw new HttpError(413, "The request is too large.");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "A request body is required.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel();
      throw new HttpError(413, "The request is too large.");
    }
    chunks.push(part.value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "The request body is not valid JSON.");
  }
}

export function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function handle(
  action: () => Promise<Response>,
): Promise<Response> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof HttpError)
      return json({ error: error.message }, error.status);
    if (error instanceof ZodError)
      return json(
        {
          error: error.issues
            .map(
              (issue) => `${issue.path.join(".") || "Input"}: ${issue.message}`,
            )
            .slice(0, 5)
            .join("; "),
        },
        422,
      );
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2002")
        return json(
          {
            error:
              "This invoice or reference already exists. Review the existing record before continuing.",
          },
          409,
        );
      if (error.code === "P2025")
        return json(
          {
            error:
              "The record was not found or has changed. Refresh and try again.",
          },
          409,
        );
      if (error.code === "P2034")
        return json(
          {
            error:
              "The record changed during your request. Refresh and try again.",
          },
          409,
        );
    }
    // Never return or log credential-bearing database errors or invoice content.
    console.error(
      "Request failed",
      error instanceof Error ? error.constructor.name : "UnknownError",
    );
    return json(
      {
        error:
          "The request could not be completed. Your saved records have been preserved. Try again or contact an administrator.",
      },
      500,
    );
  }
}
