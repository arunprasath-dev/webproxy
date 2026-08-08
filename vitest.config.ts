import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only run unit/integration tests; Playwright specs live under tests/e2e.
    include: ["test/**/*.test.ts"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
