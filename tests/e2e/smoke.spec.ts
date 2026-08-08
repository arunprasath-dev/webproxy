import { test, expect } from "@playwright/test";

test("homepage renders the proxy UI", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/Web Proxy/);
  await expect(page.locator("input#url")).toBeVisible();
  await expect(page.locator("form button")).toContainText("Go");
});

test("client bootstrap is served", async ({ request }) => {
  const res = await request.get("/__bootstrap.js");
  expect(res.status()).toBe(200);
  expect(await res.text()).toContain("__proxyBootstrap");
});

test("submitting a URL routes to the encoded proxy path", async ({ page }) => {
  await page.goto("/");
  await page.fill("input#url", "example.com");
  await page.click("button[type=submit]");
  // The server redirects /?q=... to /<base64url target> (padding stripped).
  await expect(page).toHaveURL(/\/aHR0cHM6Ly9leGFtcGxlLmNvbS8$/);
});

test("invalid URL shows an error page", async ({ page }) => {
  await page.goto("/?q=not a valid url at all");
  await expect(page.locator("body")).toContainText("Proxy error");
});
