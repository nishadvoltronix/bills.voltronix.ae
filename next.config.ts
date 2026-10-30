import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["@prisma/client"],
  logging: {
    incomingRequests: {
      // OAuth callback query strings carry one-use codes and state values.
      ignore: [/^\/api\/integrations\/oauth\/[^/?#]+\/callback\/?(?:[?#]|$)/],
    },
  },
  // Runtime uploads, local database files and secrets are never release artifacts.
  outputFileTracingExcludes: {
    "/*": [
      "./.local/**/*",
      "./.env",
      "./.env.*",
      "./test-results/**/*",
      "./playwright-report/**/*",
      "./coverage/**/*",
      "./tests/**/*",
    ],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          ...(process.env.APP_ENV === "production" &&
          process.env.APP_URL?.startsWith("https://")
            ? [{ key: "Strict-Transport-Security", value: "max-age=15552000" }]
            : []),
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "same-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(self), microphone=(), geolocation=()",
          },
          {
            key: "Content-Security-Policy",
            value:
              "default-src 'self'; script-src 'self' 'unsafe-inline'" +
              (process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "") +
              "; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
          },
        ],
      },
      // The final matching rule wins. Originals must not inherit the app's
      // script policy when Next combines configured and route response headers.
      ...[
        "/api/bills/books/:id/attachments/:attachmentId",
        "/api/documents/:id",
      ].map((source) => ({
        source,
        headers: [
          {
            key: "Content-Security-Policy",
            value: "sandbox; default-src 'none'",
          },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      })),
    ];
  },
};
export default nextConfig;
