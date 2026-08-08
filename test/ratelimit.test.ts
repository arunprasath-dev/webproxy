import { describe, expect, it } from "vitest";
import { RateLimiter } from "../src/security/rateLimit.js";

describe("RateLimiter", () => {
  it("allows up to max requests then rejects", () => {
    const limiter = new RateLimiter(60_000, 3);
    expect(limiter.allow("1.2.3.4")).toBe(true);
    expect(limiter.allow("1.2.3.4")).toBe(true);
    expect(limiter.allow("1.2.3.4")).toBe(true);
    expect(limiter.allow("1.2.3.4")).toBe(false);
    // Different IP unaffected.
    expect(limiter.allow("5.6.7.8")).toBe(true);
  });

  it("resets after the window elapses", () => {
    const limiter = new RateLimiter(1000, 1);
    expect(limiter.allow("ip")).toBe(true);
    expect(limiter.allow("ip")).toBe(false);
    limiter.sweep(Date.now() + 2000);
    expect(limiter.allow("ip")).toBe(true);
  });
});

describe("HTTP 429 hook", () => {
  it("returns 429 when the limit is exceeded", async () => {
    process.env.RATE_LIMIT_MAX_REQUESTS = "2";
    process.env.RATE_LIMIT_WINDOW_MS = "60000";
    const { buildApp } = await import("../src/app.js");
    const { loadConfig } = await import("../src/config/config.js");
    const real = buildApp(loadConfig());
    await real.ready();
    expect((await real.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await real.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await real.inject({ method: "GET", url: "/health" })).statusCode).toBe(429);
    await real.close();
  });

  it("keys per real client IP from X-Forwarded-For (trustProxy)", async () => {
    process.env.RATE_LIMIT_MAX_REQUESTS = "1";
    process.env.RATE_LIMIT_WINDOW_MS = "60000";
    const { buildApp } = await import("../src/app.js");
    const { loadConfig } = await import("../src/config/config.js");
    const real = buildApp(loadConfig());
    await real.ready();
    // Each distinct X-Forwarded-For client gets its own bucket.
    expect((await real.inject({ method: "GET", url: "/health", headers: { "x-forwarded-for": "1.1.1.1" } })).statusCode).toBe(200);
    expect((await real.inject({ method: "GET", url: "/health", headers: { "x-forwarded-for": "2.2.2.2" } })).statusCode).toBe(200);
    expect((await real.inject({ method: "GET", url: "/health", headers: { "x-forwarded-for": "1.1.1.1" } })).statusCode).toBe(429);
    await real.close();
  });
});
