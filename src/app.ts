import Fastify, { type FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { loadConfig, type Config } from "./config/config.js";
import { ProxyHandler } from "./proxy/handler.js";
import { buildCache } from "./cache/index.js";
import { RateLimiter } from "./security/rateLimit.js";
import { BOOTSTRAP_PATH } from "./web/constants.js";

const bootstrapSource = readFileSync(new URL("./web/bootstrap.js", import.meta.url), "utf8");
const homePage = readFileSync(new URL("./web/home.html", import.meta.url), "utf8");

/** Build and wire the Fastify application (no listening). */
export function buildApp(cfg?: Config): FastifyInstance {
  const config = cfg ?? loadConfig();
  // trustProxy: read the real client IP from X-Forwarded-For so per-IP rate
  // limiting works behind the Caddy/Docker reverse proxy (see Caddyfile).
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    bodyLimit: 1024 * 1024,
    trustProxy: true,
  });
  const proxy = new ProxyHandler(config, buildCache(config));
  app.addHook("onClose", () => proxy.close());

  // Rate limiting (per client IP).
  const limiter = new RateLimiter(config.RATE_LIMIT_WINDOW_MS, config.RATE_LIMIT_MAX_REQUESTS);
  const sweepTimer = setInterval(() => limiter.sweep(), Math.min(config.RATE_LIMIT_WINDOW_MS, 60_000));
  sweepTimer.unref?.();
  app.addHook("onRequest", async (req, reply) => {
    if (limiter.allow(req.ip)) return;
    return reply
      .code(429)
      .header("retry-after", Math.ceil(config.RATE_LIMIT_WINDOW_MS / 1000).toString())
      .type("text/plain")
      .send("Too Many Requests");
  });

  app.get("/health", async () => ({ status: "ok", ts: Date.now() }));

  // Client bootstrap script (must be registered before the proxy catch-all).
  app.get(BOOTSTRAP_PATH, async (_req, reply) =>
    reply.type("application/javascript").header("cache-control", "public, max-age=3600").send(bootstrapSource),
  );

  // Homepage frontend. Handles /?q=<url> submissions by redirecting to the
  // encoded proxy path.
  app.get("/", async (req, reply) => {
    const q = (req.query as Record<string, string> | undefined)?.q;
    if (q) {
      const { normalizeTarget, encodeTarget } = await import("./proxy/scheme.js");
      const target = normalizeTarget(q);
      if (target) return reply.redirect(`/${encodeTarget(target)}`);
      return reply.type("text/html").send(proxy.errorPage("Invalid URL"));
    }
    return reply.type("text/html").header("cache-control", "public, max-age=3600").send(homePage);
  });

  // Proxy catch-all. Query form (e.g. /?q=https://...) also handled here.
  app.get("/*", async (req, reply) => {
    const q = (req.query as Record<string, string> | undefined)?.q;
    if (q) {
      const { normalizeTarget } = await import("./proxy/scheme.js");
      const target = normalizeTarget(q);
      if (target) {
        const { encodeTarget } = await import("./proxy/scheme.js");
        return reply.redirect(`/${encodeTarget(target)}`);
      }
    }
    return proxy.handle(req, reply);
  });

  return app;
}
