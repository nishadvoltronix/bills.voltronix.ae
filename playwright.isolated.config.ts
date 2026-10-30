import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
import { isolatedProviderEnvironment } from "./scripts/lib/test-provider-environment.mjs";

if (existsSync(".env")) process.loadEnvFile(".env");
const database = new URL(process.env.DATABASE_URL ?? "http://invalid");
if (process.env.APP_ENV !== "development" || database.protocol !== "mysql:" ||
    database.hostname !== "127.0.0.1" || database.port !== "3308" || database.pathname !== "/voltronix_billing_dev" ||
    database.search || database.hash || !existsSync(".next/BUILD_ID"))
  throw new Error("Isolated browser checks require a current build and the dedicated local MySQL development database.");

const origin = "http://127.0.0.1:3012";
const clean = isolatedProviderEnvironment(process.env);
// Empty removed credentials so Next cannot reload them from the user's .env.
for (const name of Object.keys(process.env)) if (!(name in clean)) process.env[name] = "";
Object.assign(process.env, clean, { APP_URL: origin, OCR_PROVIDER: "disabled", HUB_BRIDGE_ENABLED: "false", HUB_BRIDGE_SECRET: "" });
const serverEnvironment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));

export default defineConfig({
  testDir: "./tests/e2e", fullyParallel: false, workers: 1, timeout: 60000,
  expect: { timeout: 15000 }, reporter: "list",
  use: { ...devices["Desktop Chrome"], baseURL: origin, channel: process.env.E2E_BROWSER_CHANNEL || "msedge", trace: "off" },
  webServer: { command: "npm run start -- --port 3012", url: `${origin}/login`, reuseExistingServer: false,
    timeout: 120000, env: { ...serverEnvironment, APP_ENV: "development", NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" } },
});
