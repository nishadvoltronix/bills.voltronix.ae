import "server-only";
import { isManualEntryOnly } from "@/lib/application-mode";
import { normalizeAzureInvoice, type OcrEvidence } from "@/lib/ocr-extraction";

export class OcrProviderError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable = false,
    public retryAfterSeconds = 10,
  ) {
    super(message);
  }
}
export interface DurableOcrProvider {
  start(
    bytes: Uint8Array,
  ): Promise<{ requestId: string; retryAfterSeconds: number }>;
  poll(
    requestId: string,
  ): Promise<
    | { status: "running"; retryAfterSeconds: number }
    | { status: "succeeded"; extraction: OcrEvidence }
  >;
}
const API_VERSION = "2024-11-30";
const MAX_PAGES = 20;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const retryDelay = (response: Response) =>
  Math.min(120, Math.max(2, Number(response.headers.get("retry-after")) || 5));

function configuration() {
  if (isManualEntryOnly())
    throw new OcrProviderError("NOT_CONFIGURED", "OCR is disabled for this manual entry deployment.");
  const configuredEndpoint =
    process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT?.trim();
  const key = process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY?.trim();
  if (
    process.env.OCR_PROVIDER !== "azure_document_intelligence" ||
    !configuredEndpoint ||
    !key
  )
    throw new OcrProviderError(
      "NOT_CONFIGURED",
      "Azure invoice OCR is not configured. Ask an administrator to enable Azure Document Intelligence and provide its resource endpoint and API key. You can enter the bill manually while setup is completed.",
    );
  if (/\s|[\u0000-\u001f\u007f]/.test(key) || /\s/.test(configuredEndpoint))
    throw new OcrProviderError(
      "INVALID_CONFIGURATION",
      "The Azure endpoint or API key contains invalid whitespace. An administrator must correct the OCR configuration; manual bill entry remains available.",
    );
  let endpoint: URL;
  try {
    endpoint = new URL(configuredEndpoint);
  } catch {
    throw new OcrProviderError(
      "INVALID_CONFIGURATION",
      "The OCR endpoint configuration is invalid.",
    );
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.port ||
    endpoint.pathname !== "/" ||
    !/^([a-z0-9-]+\.)+(cognitiveservices\.azure\.com|api\.cognitive\.microsoft\.com)$/.test(
      endpoint.hostname,
    )
  )
    throw new OcrProviderError(
      "INVALID_CONFIGURATION",
      "OCR requires an HTTPS Azure Document Intelligence resource endpoint.",
    );
  return {
    endpoint: endpoint.origin,
    key,
  };
}
export function ocrProviderStatus() {
  try {
    configuration();
    return {
      status: "CONFIGURED_UNVERIFIED",
      configured: true,
      connected: false,
      message:
        "Azure credentials are configured. Connection and extraction quality require an authorized provider test. Uploads require human review.",
    };
  } catch (error) {
    return {
      status: "NOT_CONFIGURED",
      configured: false,
      connected: false,
      message:
        error instanceof OcrProviderError
          ? error.message
          : "OCR setup is unavailable.",
    };
  }
}
async function request(url: string, key: string, init: RequestInit = {}) {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
      headers: { "Ocp-Apim-Subscription-Key": key, ...init.headers },
    });
  } catch {
    throw new OcrProviderError(
      "NETWORK_ERROR",
      "The OCR provider could not be reached. Processing will retry within its bounded retry policy.",
      true,
    );
  }
  if (!response.ok) {
    const retryable =
      response.status === 408 ||
      response.status === 429 ||
      response.status >= 500;
    const code =
      response.status === 401 || response.status === 403
        ? "AUTHORIZATION_FAILED"
        : response.status === 408
          ? "NETWORK_ERROR"
          : response.status === 429
            ? "RATE_LIMITED"
            : "PROVIDER_REJECTED";
    // Error bodies may contain invoice or provider details. Discard them without
    // logging or parsing them, and release the connection before a bounded retry.
    try {
      await response.body?.cancel();
    } catch {
      /* Keep the safe HTTP classification. */
    }
    throw new OcrProviderError(
      code,
      `OCR provider returned HTTP ${response.status}. Check configuration or the original document.`,
      retryable,
      retryDelay(response),
    );
  }
  return response;
}
async function boundedJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES)
    throw new OcrProviderError(
      "RESULT_TOO_LARGE",
      "The OCR result exceeds the supported size. Split this document.",
    );
  const reader = response.body?.getReader();
  if (!reader)
    throw new OcrProviderError(
      "INVALID_RESULT",
      "The OCR provider returned an empty result.",
    );
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new OcrProviderError(
          "RESULT_TOO_LARGE",
          "The OCR result exceeds the supported size. Split this document.",
        );
      }
      chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof OcrProviderError) throw error;
    throw new OcrProviderError(
      "NETWORK_ERROR",
      "The OCR response was interrupted. Polling the saved operation will retry within its bounded policy.",
      true,
    );
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new OcrProviderError(
      "INVALID_RESULT",
      "The OCR provider returned an invalid result.",
    );
  }
}
export const azureOcrProvider: DurableOcrProvider = {
  async start(bytes) {
    const { endpoint, key } = configuration();
    let response: Response;
    try {
      response = await request(
        `${endpoint}/documentintelligence/documentModels/prebuilt-invoice:analyze?api-version=${API_VERSION}&pages=1-${MAX_PAGES}`,
        key,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            base64Source: Buffer.from(bytes).toString("base64"),
          }),
        },
      );
    } catch (error) {
      if (
        error instanceof OcrProviderError &&
        (error.code === "NETWORK_ERROR" ||
          (error.code === "PROVIDER_REJECTED" && error.retryable))
      )
        throw new OcrProviderError(
          "SUBMISSION_UNKNOWN",
          "The OCR submission outcome is unknown. Inspect provider operations before retrying; a new submission may incur another analysis charge.",
        );
      throw error;
    }
    const location = response.headers.get("operation-location");
    let operation: URL;
    try {
      operation = new URL(location ?? "");
    } catch {
      throw new OcrProviderError(
        "SUBMISSION_UNKNOWN",
        "The OCR provider did not return a processing reference. Inspect provider operations before submitting again.",
      );
    }
    const match = operation.pathname.match(
      /^\/documentintelligence\/documentModels\/prebuilt-invoice\/analyzeResults\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i,
    );
    if (
      response.status !== 202 ||
      operation.origin !== endpoint ||
      operation.username ||
      operation.password ||
      !match
    )
      throw new OcrProviderError(
        "SUBMISSION_UNKNOWN",
        "The OCR provider returned an unexpected processing reference. Inspect provider operations before submitting again.",
      );
    return { requestId: match[1], retryAfterSeconds: retryDelay(response) };
  },
  async poll(requestId) {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        requestId,
      )
    )
      throw new OcrProviderError(
        "INVALID_RESULT",
        "The saved OCR processing reference is invalid.",
      );
    const { endpoint, key } = configuration();
    const response = await request(
      `${endpoint}/documentintelligence/documentModels/prebuilt-invoice/analyzeResults/${requestId}?api-version=${API_VERSION}`,
      key,
    );
    const payload = await boundedJson(response);
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new OcrProviderError(
        "INVALID_RESULT",
        "The OCR provider returned an invalid operation status.",
      );
    const data = payload as {
      status?: string;
      analyzeResult?: unknown;
    };
    if (["running", "notStarted"].includes(data.status ?? ""))
      return { status: "running", retryAfterSeconds: retryDelay(response) };
    if (data.status === "failed")
      throw new OcrProviderError(
        "EXTRACTION_FAILED",
        "The OCR provider could not analyze this document. Inspect the original before retrying.",
      );
    if (data.status !== "succeeded")
      throw new OcrProviderError(
        "INVALID_RESULT",
        "The OCR provider returned an unknown operation status.",
      );
    try {
      return {
        status: "succeeded",
        extraction: normalizeAzureInvoice(data.analyzeResult, MAX_PAGES),
      };
    } catch (error) {
      throw new OcrProviderError(
        "INVALID_EXTRACTION",
        error instanceof Error
          ? error.message
          : "The OCR extraction is invalid.",
      );
    }
  },
};
