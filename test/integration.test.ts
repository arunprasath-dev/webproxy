import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/config.js";
import { encodeTarget } from "../src/proxy/scheme.js";

const PROXY_ORIGIN = "http://proxy.test";

describe("integration: proxy pipeline", () => {
  let mock: FastifyInstance;
  let mockOrigin: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.ALLOW_PRIVATE_IPS = "true";
    process.env.PROXY_PUBLIC_ORIGIN = PROXY_ORIGIN;

    mock = Fastify();
    mock.get("/", async (_req: FastifyRequest, reply: FastifyReply) =>
      reply.type("text/html").send(
        `<html><head><link rel="stylesheet" href="/style.css"></head><body><a href="/about">About</a></body></html>`,
      ),
    );
    mock.get("/style.css", async (_req: FastifyRequest, reply: FastifyReply) =>
      reply.type("text/css").send(".a{background:url(/x.png)}"),
    );
    mock.get("/json", async (_req: FastifyRequest, reply: FastifyReply) =>
      reply.type("application/json").send({ ok: true }),
    );
    mock.get("/redirect", async (_req: FastifyRequest, reply: FastifyReply) => reply.redirect("/final"));
    mock.get("/final", async () => "FINAL");
    mock.get("/gzip", async (_req: FastifyRequest, reply: FastifyReply) => {
      const html = `<html><body><a href="/next">Next</a></body></html>`;
      return reply
        .type("text/html")
        .header("content-encoding", "gzip")
        .header("content-length", gzipSync(Buffer.from(html)).length)
        .send(gzipSync(Buffer.from(html)));
    });
    mock.get("/set-cookie", async (_req: FastifyRequest, reply: FastifyReply) => {
      return reply
        .type("text/html")
        .header("set-cookie", "session=abc; Domain=127.0.0.1; Path=/")
        .send("<html><body>c</body></html>");
    });
    await mock.listen({ port: 0, host: "127.0.0.1" });
    mockOrigin = `http://127.0.0.1:${(mock.server.address() as { port: number }).port}`;

    app = buildApp(loadConfig());
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await mock.close();
  });

  const proxyPath = (url: string) => `/${encodeTarget(url)}`;

  it("rewrites an HTML page so assets and links route through the proxy", async () => {
    const res = await app.inject({ method: "GET", url: proxyPath(mockOrigin + "/") });
    expect(res.statusCode).toBe(200);
    const body = res.body;
    expect(body).toContain(PROXY_ORIGIN + "/");
    expect(body).not.toContain("/style.css");
  });

  it("streams binary/JSON through untouched", async () => {
    const res = await app.inject({ method: "GET", url: proxyPath(mockOrigin + "/json") });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it("decodes gzip HTML and rewrites it (no double-decompress)", async () => {
    const res = await app.inject({ method: "GET", url: proxyPath(mockOrigin + "/gzip") });
    expect(res.statusCode).toBe(200);
    // undici decodes the body, so we forward raw bytes without content-encoding.
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.body).toContain(PROXY_ORIGIN + "/");
    expect(res.body).not.toContain("/next");
  });

  it("rewrites Location on redirects", async () => {
    const res = await app.inject({ method: "GET", url: proxyPath(mockOrigin + "/redirect") });
    expect(res.statusCode).toBe(302);
    const loc = res.headers["location"];
    expect(loc).toContain(PROXY_ORIGIN + "/");
  });

  it("namespaces Set-Cookie from upstream", async () => {
    const res = await app.inject({ method: "GET", url: proxyPath(mockOrigin + "/set-cookie") });
    const sc = String(res.headers["set-cookie"]);
    expect(sc).toMatch(/^c_[a-f0-9]{10}_session=abc/);
    expect(sc.toLowerCase()).toContain("path=/");
    expect(sc.toLowerCase()).toContain("samesite=none");
    expect(sc.toLowerCase()).not.toContain("domain=");
  });

  it("serves a healthcheck", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
  });
});
