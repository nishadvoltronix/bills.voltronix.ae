import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../next.config";

async function configuredHeaders() {
  expect(nextConfig.headers).toBeTypeOf("function");
  return nextConfig.headers!();
}

function policy(value: string) {
  const directives = value.split(";").map(part => part.trim().split(/\s+/));
  expect(new Set(directives.map(([name]) => name)).size).toBe(directives.length);
  return Object.fromEntries(directives.map(([name, ...sources]) => [name, sources]));
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("APP_ENV", "production");
  vi.stubEnv("APP_URL", "https://bills.example.invalid");
});
afterEach(() => vi.unstubAllEnvs());

describe("application and original-document security headers", () => {
  it("allows only the beacon file and its versioned path while preserving the rest of the application policy", async () => {
    const rules = await configuredHeaders();
    const main = rules.find(rule => rule.source === "/:path*")!;
    const csp = main.headers.find(header => header.key === "Content-Security-Policy")!.value;
    expect(policy(csp)).toEqual({
      "default-src": ["'self'"],
      "script-src": ["'self'", "'unsafe-inline'", "https://static.cloudflareinsights.com/beacon.min.js",
        "https://static.cloudflareinsights.com/beacon.min.js/"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "img-src": ["'self'", "data:"],
      "font-src": ["'self'"],
      "connect-src": ["'self'"],
      "object-src": ["'none'"],
      "base-uri": ["'self'"],
      "form-action": ["'self'"],
      "frame-ancestors": ["'none'"],
    });
    const remoteScriptSources = policy(csp)["script-src"].filter(value => value.startsWith("https:"));
    expect(remoteScriptSources).toHaveLength(2);
    for (const source of remoteScriptSources) {
      const url = new URL(source);
      expect(url.origin).toBe("https://static.cloudflareinsights.com");
      expect(["/beacon.min.js", "/beacon.min.js/"]).toContain(url.pathname);
      expect(url.search).toBe("");
      expect(url.hash).toBe("");
    }
    expect(csp).not.toContain("*");
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it.each(["/api/bills/books/:id/attachments/:attachmentId", "/api/documents/:id"])(
    "keeps the stronger final sandbox policy for original route %s", async source => {
      const rules = await configuredHeaders();
      const mainIndex = rules.findIndex(rule => rule.source === "/:path*");
      const documentIndex = rules.findIndex(rule => rule.source === source);
      expect(documentIndex).toBeGreaterThan(mainIndex);
      const original = rules[documentIndex];
      const csp = original.headers.find(header => header.key === "Content-Security-Policy")!.value;
      expect(csp).toBe("sandbox; default-src 'none'");
      expect(policy(csp)).toEqual({ sandbox: [], "default-src": ["'none'"] });
      expect(original.headers.find(header => header.key === "Referrer-Policy")?.value).toBe("no-referrer");
      expect(csp).not.toContain("cloudflareinsights");
      expect(csp).not.toContain("unsafe-inline");
    });

  it.each(["production", "test", "development"])("does not expand any connect destination in %s", async environment => {
    vi.stubEnv("NODE_ENV", environment);
    const rules = await configuredHeaders();
    const main = rules.find(rule => rule.source === "/:path*")!;
    const csp = policy(main.headers.find(header => header.key === "Content-Security-Policy")!.value);
    expect(csp["connect-src"]).toEqual(["'self'"]);
    expect(csp["script-src"].includes("'unsafe-eval'")).toBe(environment === "development");
  });

  it("retains the application's other transport, framing, MIME and device restrictions", async () => {
    const rules = await configuredHeaders();
    const main = rules.find(rule => rule.source === "/:path*")!;
    const headers = Object.fromEntries(main.headers.map(header => [header.key, header.value]));
    expect(headers).toMatchObject({
      "Strict-Transport-Security": "max-age=15552000",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "same-origin",
      "Permissions-Policy": "camera=(self), microphone=(), geolocation=()",
    });
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});
