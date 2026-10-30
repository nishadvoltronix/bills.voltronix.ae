import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");
if (
  process.env.APP_ENV !== "development" ||
  process.env.APP_URL !== "http://127.0.0.1:3000"
) {
  throw new Error(
    "Browser checks only run against the local development app at http://127.0.0.1:3000.",
  );
}
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  expect: { timeout: 15000 },
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: process.env.APP_URL,
    channel: process.env.E2E_BROWSER_CHANNEL || "msedge",
    trace: "off",
  },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:3000/login",
    reuseExistingServer: true,
    timeout: 120000,
  },
});
