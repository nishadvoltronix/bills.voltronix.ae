import { test, expect, type Page } from "@playwright/test";

async function login(
  page: Page,
  account: "ADMIN" | "ACCOUNTS" = "ADMIN",
  startPath = "/login",
  expectedPath = "/dashboard",
) {
  const email = process.env[`SEED_${account}_EMAIL`];
  const password = process.env[`SEED_${account}_PASSWORD`];
  if (!email || !password)
    throw new Error("Local seed credentials are required.");
  await page.goto(startPath);
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in to workspace" }).click();
  await expect(page).toHaveURL((url) => url.pathname === expectedPath);
}

test("direct Books link returns to authorization after sign-in, including an expired session", async ({
  page,
  context,
  baseURL,
}) => {
  await context.addCookies([
    { name: "voltronix_session", value: "0".repeat(64), url: baseURL! },
  ]);
  await page.setExtraHTTPHeaders({ "x-voltronix-return-path": "/bills" });
  await page.goto("/account/books-authorization");
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === "/login" &&
      url.searchParams.get("next") === "/account/books-authorization",
  );
  await login(page, "ADMIN", page.url(), "/account/books-authorization");
  await expect(
    page.getByRole("heading", { name: "Connect Zoho Books", exact: true }),
  ).toBeVisible();
});

test("sign-in refuses an external next destination", async ({ page }) => {
  await login(
    page,
    "ADMIN",
    `/login?next=${encodeURIComponent("//attacker.invalid")}`,
  );
  await expect(page).toHaveURL(/\/dashboard$/);
});

test("Books operator page keeps credentials server-side and fits mobile", async ({
  page,
}) => {
  await login(page);
  await page.goto("/account/books-authorization");
  await expect(
    page.getByRole("heading", { name: "Connect Zoho Books", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Refresh tokens are encrypted and kept on this server.", {
      exact: false,
    }),
  ).toBeVisible();
  const markup = await page.content();
  const privateValues = [
    process.env.ZOHO_BOOKS_CLIENT_SECRET,
    process.env.ZOHO_BOOKS_REFRESH_TOKEN,
    process.env.ZOHO_BOOKS_REFRESH_TOKENS_JSON,
    process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY,
  ].filter((value): value is string => !!value);
  expect(privateValues.some((value) => markup.includes(value))).toBe(false);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("Accounts users cannot open the operator authorization page", async ({
  page,
}) => {
  await login(page, "ACCOUNTS");
  await page.goto("/account/books-authorization");
  await expect(page).toHaveURL(/\/account$/);
  await expect(
    page.getByRole("heading", { name: "Connect Zoho Books", exact: true }),
  ).toHaveCount(0);
});

test("Books consent uses the selected company and rejects an unexpected redirect", async ({
  page,
}) => {
  test.skip(
    process.env.INTEGRATION_NETWORK_ENABLED !== "true",
    "A configured local connection is required; all consent responses below are mocked.",
  );
  await login(page);
  await page.goto("/account/books-authorization");
  const profiles = JSON.parse(
    process.env.ZOHO_BOOKS_ORGANIZATIONS_JSON || "[]",
  ) as { organizationId: string; name: string }[];
  expect(profiles.length).toBeGreaterThan(0);
  const selected = profiles[0];
  let calls = 0;
  await page.route(
    "**/api/integrations/oauth/zoho/authorize",
    async (route) => {
      calls++;
      expect(route.request().postDataJSON()).toEqual({
        organizationId: selected.organizationId,
      });
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          authorizationUrl: "https://unexpected.example.invalid/oauth/v2/auth",
        }),
      });
    },
  );
  await page
    .getByRole("button", {
      name: new RegExp(
        `^(Connect|Reconnect) ${selected.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      ),
    })
    .click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "The authorization destination is invalid." }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/account\/books-authorization$/);
  expect(calls).toBe(1);
});
