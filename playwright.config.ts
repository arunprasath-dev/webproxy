import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: "http://localhost:3000",
    headless: true,
  },
  webServer: {
    // The proxy must reach the loopback fixture and use ipv4 egress (sandbox has
    // no working IPv6). PROXY_PUBLIC_ORIGIN is what the browser sees and what the
    // bootstrap's data-origin uses.
    command:
      "ALLOW_PRIVATE_IPS=true UPSTREAM_IP_FAMILY=ipv4 RATE_LIMIT_MAX_REQUESTS=100000 PROXY_PUBLIC_ORIGIN=http://localhost:3000 npm run dev",
    url: "http://localhost:3000/health",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
