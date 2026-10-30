import "server-only";
import {
  IntegrationError,
  assertNetwork,
  assertWrite,
  type ZohoConfig,
} from "./config";
import { boundedBytes, boundedJson } from "./response";
import { z } from "zod";
import type { LocalLiveTestWriteCapability } from "./local-live-test";

export type Fetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;
export type AccessToken = () => Promise<string>;
export type ProductionWriteRequest = { path: string; body?: unknown; form?: FormData };
export type ProductionWriteGuard = (request: ProductionWriteRequest) => Promise<void>;
export function retryAfterSeconds(value: string | null, now = Date.now()) {
  if (!value) return 60;
  const seconds = /^\d+$/.test(value)
    ? Number(value)
    : (Date.parse(value) - now) / 1000;
  return Number.isFinite(seconds)
    ? Math.min(86_400, Math.max(1, Math.ceil(seconds)))
    : 60;
}
export class ZohoTransport {
  private localQuota: { remaining: number | null } | null = null;
  constructor(
    readonly config: ZohoConfig,
    private readonly token: AccessToken,
    private readonly fetcher: Fetch = fetch,
    private readonly productionWriteGuard?: ProductionWriteGuard,
    private readonly localLiveTestCapability?: LocalLiveTestWriteCapability,
  ) {}
  /** Only the trusted exact-job capability can select the local one-bill test path. */
  async assertWritePermission(request?: ProductionWriteRequest) {
    if (this.localLiveTestCapability !== undefined) {
      const { assertLocalLiveTestWriteCapability } = await import("./local-live-test");
      await assertLocalLiveTestWriteCapability(this.localLiveTestCapability, this.config, request);
    }
    else assertWrite(this.config);
  }
  private observeLocalQuota(response: Response) {
    if (this.localLiveTestCapability === undefined || this.config.target !== "ZOHO" || !response.ok) return;
    const raw = response.headers.get("x-rate-limit-remaining")?.trim();
    const remaining = raw && /^[+-]?\d+$/.test(raw) ? Number(raw) : NaN;
    this.localQuota = { remaining: Number.isSafeInteger(remaining) ? remaining : null };
  }
  private assertLocalWriteQuota(requireObservation: boolean) {
    if (this.localLiveTestCapability === undefined) return;
    if (!this.localQuota && !requireObservation) return;
    // Leave capacity for the POST, exact outcome confirmation, and concurrent incoming readers.
    if (!this.localQuota || this.localQuota.remaining === null || this.localQuota.remaining < 10)
      throw new IntegrationError("LOCAL_TEST_QUOTA_REQUIRED",
        "Books must confirm sufficient remaining API quota before this one-bill test can write. No financial request was sent.", "BLOCKED");
  }
  async request(
    path: string,
    options: {
      method?: "GET" | "POST";
      body?: unknown;
      form?: FormData;
      binary?: boolean;
      query?: Record<string, string>;
    } = {},
  ): Promise<unknown> {
    assertNetwork(this.config);
    if (
      !path.startsWith(
        this.config.target === "ZOHO" ? "/books/v3/" : "/crm/v8/",
      ) ||
      !/^\/[A-Za-z0-9_/-]+$/.test(path) ||
      path.includes("..")
    )
      throw new IntegrationError(
        "INVALID_ENDPOINT",
        "An integration endpoint is not permitted.",
        "BLOCKED",
      );
    const url = new URL(path, this.config.apiOrigin);
    if (
      url.origin !== this.config.apiOrigin ||
      url.pathname !== path ||
      Object.hasOwn(options.query ?? {}, "organization_id")
    )
      throw new IntegrationError(
        "INVALID_ENDPOINT",
        "An integration destination override is not permitted.",
        "BLOCKED",
      );
    for (const [key, value] of Object.entries(options.query ?? {}))
      url.searchParams.set(key, value);
    if (this.config.target === "ZOHO")
      url.searchParams.set("organization_id", this.config.organizationId);
    const method = options.method ?? "GET";
    if (method === "POST") {
      await this.assertWritePermission({ path, body: options.body, form: options.form });
      if (this.config.environment === "production" && !this.productionWriteGuard)
        throw new IntegrationError("LIVE_PERMISSION_REQUIRED", "Current source and access checks are required for this Books operation.", "BLOCKED");
      if (this.productionWriteGuard) await this.productionWriteGuard({ path, body: options.body, form: options.form });
      this.assertLocalWriteQuota(false);
      if (
        this.config.target !== "ZOHO" ||
        !/^\/books\/v3\/bills(?:\/\d+\/attachment)?$/.test(path)
      )
        throw new IntegrationError(
          "INVALID_WRITE_ENDPOINT",
          "Only reviewed supplier-bill and attachment operations are permitted.",
          "BLOCKED",
        );
      const organization = await this.request(
        `/books/v3/organizations/${this.config.organizationId}`,
      );
      const parsed = z
        .object({
          code: z.literal(0),
          organization: z.object({
            organization_id: z.string(),
            is_org_active: z.literal(true),
            currency_code: z.string(),
            currency_id: z.string(),
          }),
        })
        .safeParse(organization);
      const mapping = this.config.booksMapping;
      if (
        !parsed.success ||
        !mapping ||
        parsed.data.organization.organization_id !==
          this.config.organizationId ||
        parsed.data.organization.currency_code !== mapping.baseCurrency ||
        parsed.data.organization.currency_id !==
          mapping.currencies[mapping.baseCurrency]?.id
      )
        throw new IntegrationError(
          "BOOKS_ORGANIZATION_MISMATCH",
          "The Books organization is inactive or its identity/base currency differs from the reviewed configuration. No write was sent.",
          "BLOCKED",
        );
      this.assertLocalWriteQuota(true);
    }
    const token = await this.token();
    // Authorization may expire during organization verification or token refresh.
    if (method === "POST") await this.assertWritePermission({ path, body: options.body, form: options.form });
    if (method === "POST" && this.productionWriteGuard) {
      await this.productionWriteGuard({ path, body: options.body, form: options.form });
    }
    if (method === "POST") this.assertLocalWriteQuota(true);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method,
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          ...(options.body ? { "Content-Type": "application/json" } : {}),
        },
        body:
          options.form ??
          (options.body ? JSON.stringify(options.body) : undefined),
        signal: AbortSignal.timeout(25_000),
        redirect: "error",
        cache: "no-store",
      });
    } catch {
      throw new IntegrationError(
        "REQUEST_INTERRUPTED",
        method === "POST"
          ? "The external request outcome is unknown. Reconcile before attempting creation again."
          : "The external service could not be reached.",
        method === "POST" ? "UNKNOWN" : "RETRY",
      );
    }
    // Retain successful response bodies even at zero quota: an outcome already
    // returned by Books must remain reconcilable. Only a subsequent POST is blocked.
    this.observeLocalQuota(response);
    const retryAfter = retryAfterSeconds(response.headers.get("retry-after"));
    if (response.status === 429)
      throw new IntegrationError(
        "RATE_LIMITED",
        "The external API rate limit was reached.",
        "RETRY",
        retryAfter,
      );
    if (response.status === 401 || response.status === 403)
      throw new IntegrationError(
        "AUTHORIZATION_REQUIRED",
        "Zoho authorization is expired, revoked, or lacks required permissions.",
        "BLOCKED",
      );
    if (response.status === 408 || response.status >= 500)
      throw new IntegrationError(
        "REMOTE_UNAVAILABLE",
        method === "POST"
          ? "The external server failed after submission; creation must be reconciled."
          : "The external service is temporarily unavailable.",
        method === "POST" ? "UNKNOWN" : "RETRY",
      );
    if (response.status === 404)
      throw new IntegrationError(
        "REMOTE_NOT_FOUND",
        "The referenced external record was not found.",
        "FAILED",
      );
    if (!response.ok)
      throw new IntegrationError(
        "REMOTE_REJECTED",
        "Zoho rejected the request. Verify mappings, mandatory fields, and organization settings.",
        "FAILED",
      );
    // CRM search documents 204 as no matches. Other endpoints still require JSON.
    if (response.status === 204 && method === "GET" && this.config.target === "CRM" &&
      /^\/crm\/v8\/[A-Za-z0-9_]+\/search$/.test(path)) return null;
    let body: unknown;
    try {
      body = options.binary
        ? await boundedBytes(response, 10 * 1024 * 1024)
        : await boundedJson(response, 2 * 1024 * 1024, Boolean(options.form));
    } catch (error) {
      if (method !== "POST" && error instanceof IntegrationError) throw error;
      throw new IntegrationError(
        "INVALID_RESPONSE",
        "Zoho returned an unreadable response; review the external outcome.",
        method === "POST" ? "UNKNOWN" : "RETRY",
      );
    }
    if (
      !options.binary &&
      body &&
      typeof body === "object" &&
      "code" in body &&
      body.code !== 0
    )
      throw new IntegrationError(
        "REMOTE_REJECTED",
        "Zoho did not confirm success. Review the destination configuration.",
        "FAILED",
      );
    return body;
  }
}
