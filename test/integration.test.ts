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
    // Raw-body parser so the mock can assert the exact bytes the proxy forwards.
    mock.removeAllContentTypeParsers();
    mock.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
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
    mock.get("/events", async (_req: FastifyRequest, reply: FastifyReply) => {
      // Finite SSE stream: data lines carry URLs that must be proxied.
      const { Readable } = await import("node:stream");
      return reply
        .type("text/event-stream")
        .header("cache-control", "no-cache")
        .send(
          Readable.from([
            "retry: 1000\n",
            'event: one\ndata: {"url":"https://cdn.site.example/a.png"}\n\n',
            "data: https://site.example/next\n\n",
            "event: end\ndata: bye\n\n",
          ]),
        );
    });
    mock.all("/echo", async (req: FastifyRequest, reply: FastifyReply) => {
      const buf = req.body as Buffer | undefined;
      return reply.send({
        method: req.method,
        contentType: req.headers["content-type"] ?? "",
        bodyLength: buf ? buf.length : 0,
        body: buf ? buf.toString("utf8") : null,
      });
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

  it("forwards POST bodies verbatim and preserves content-type", async () => {
    const payload = JSON.stringify({ name: "proxy", n: 42 });
    const res = await app.inject({
      method: "POST",
      url: proxyPath(mockOrigin + "/echo"),
      headers: { "content-type": "application/json" },
      payload,
    });
    expect(res.statusCode).toBe(200);
    const echoed = res.json();
    expect(echoed.method).toBe("POST");
    expect(echoed.contentType).toContain("application/json");
    expect(echoed.bodyLength).toBe(payload.length);
    expect(echoed.body).toBe(payload);
  });

  it("forwards form-urlencoded, PUT, and DELETE requests", async () => {
    const form = "a=1&b=two";
    const formRes = await app.inject({
      method: "POST",
      url: proxyPath(mockOrigin + "/echo"),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: form,
    });
    expect(formRes.json().body).toBe(form);

    const putRes = await app.inject({
      method: "PUT",
      url: proxyPath(mockOrigin + "/echo"),
      headers: { "content-type": "text/plain" },
      payload: "update me",
    });
    expect(putRes.json().method).toBe("PUT");
    expect(putRes.json().body).toBe("update me");

    const delRes = await app.inject({ method: "DELETE", url: proxyPath(mockOrigin + "/echo") });
    expect(delRes.json().method).toBe("DELETE");
  });

  it("streams SSE through, rewriting data URLs, with no content-length", async () => {
    const res = await app.inject({ method: "GET", url: proxyPath(mockOrigin + "/events") });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-length"]).toBeUndefined();
    expect(res.body).toContain("retry: 1000");
    expect(res.body).toContain("event: one");
    expect(res.body).toContain("event: end");
    expect(res.body).not.toContain("https://cdn.site.example/a.png");
    expect(res.body).not.toContain("https://site.example/next");
    const tokens = [...res.body.matchAll(/proxy\.test\/([A-Za-z0-9_-]+)/g)].map((m) =>
      Buffer.from(m[1]!, "base64url").toString(),
    );
    expect(tokens).toContain("https://cdn.site.example/a.png");
    expect(tokens).toContain("https://site.example/next");
  });

  it("GET with ?q= still redirects, but POST with ?q= never redirects", async () => {
    const getRes = await app.inject({ method: "GET", url: "/?q=" + encodeURIComponent(mockOrigin + "/") });
    expect(getRes.statusCode).toBe(302);

    // A POST to the root path has no target token — it must not be swallowed by
    // the ?q= redirect (which would lose the method/body); it errors instead.
    const postRes = await app.inject({ method: "POST", url: "/?q=" + encodeURIComponent(mockOrigin + "/") });
    expect(postRes.statusCode).not.toBe(302);
    expect(postRes.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("serves a healthcheck", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
  });
});
