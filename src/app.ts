import Fastify, { type FastifyInstance } from "fastify";
import { loadConfig, type Config } from "./config/config.js";
import { ProxyHandler } from "./proxy/handler.js";

/** Build and wire the Fastify application (no listening). */
export function buildApp(cfg?: Config): FastifyInstance {
  const config = cfg ?? loadConfig();
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  const proxy = new ProxyHandler(config);

  app.get("/health", async () => ({ status: "ok", ts: Date.now() }));

  // Homepage (Phase 6 replaces this with the real frontend).
  app.get("/", async (_req, reply) => {
    return reply
      .type("text/html")
      .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Web Proxy</title></head><body><h1>Web Proxy</h1><form method="get"><input name="q" placeholder="https://example.com" size="40" autofocus><button type="submit">Go</button></form></body></html>`);
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
