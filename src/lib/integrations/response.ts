import "server-only";
import { IntegrationError } from "./config";
/** Limit provider bytes while streaming, before allocating the full body. */
export async function boundedBytes(
  response: Response,
  limit: number,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw new IntegrationError(
      "RESPONSE_TOO_LARGE",
      "The external response exceeds the safe size limit.",
      "BLOCKED",
    );
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new IntegrationError(
          "RESPONSE_TOO_LARGE",
          "The external response exceeds the safe size limit.",
          "BLOCKED",
        );
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
export async function boundedJson(
  response: Response,
  limit = 2 * 1024 * 1024,
  allowEmpty = false,
): Promise<unknown> {
  const bytes = await boundedBytes(response, limit);
  if (allowEmpty && bytes.length === 0) return null;
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
