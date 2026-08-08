import Fastify, { type FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { loadConfig, type Config } from "./config/config.js";
import { ProxyHandler } from "./proxy/handler.js";
import { BOOTSTRAP_PATH } from "./web/constants.js";

const bootstrapSource = readFileSync(new URL("./web/bootstrap.js", import.meta.url), "utf8");
const homePage = readFileSync(new URL("./web/home.html", import.meta.url), "utf8");

/** Build and wire the Fastify application (no listening). */
export function buildApp(cfg?: Config): FastifyInstance {
  const config = cfg ?? loadConfig();
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  const proxy = new ProxyHandler(config);

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
