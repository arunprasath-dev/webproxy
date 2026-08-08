import type { FastifyReply, FastifyRequest } from "fastify";
import { PassThrough, Readable } from "node:stream";
import { loadConfig } from "../config/config.js";
import { UpstreamClient } from "./upstream.js";
import { decodeTarget } from "./scheme.js";
import { validateTarget, SsrfError } from "../security/ssrf.js";
import { sanitizeResponseHeaders, rewriteLocation } from "../rewrite/headers.js";
import { rewriteHtml } from "../rewrite/html.js";
import { rewriteCss } from "../rewrite/css.js";
import { rewriteJs } from "../rewrite/js.js";
import { JsRewriteCache } from "../rewrite/js-cache.js";
import { SseRewriteTransform } from "../rewrite/sse.js";
import { rewriteCookieHeader, rewriteSetCookie } from "../rewrite/cookies.js";
import { decideCache } from "../cache/cacheability.js";
import { NullCache, type Cache } from "../cache/cache.js";

/**
 * Core proxy handler: decode target -> SSRF guard -> fetch upstream ->
 * per-content-type rewrite -> stream back with sanitized headers.
 */
export class ProxyHandler {
  private readonly cfg: ReturnType<typeof loadConfig>;
  private readonly upstream: UpstreamClient;
  private readonly cache: Cache;
  private readonly jsCache: JsRewriteCache;

  constructor(cfg?: Partial<ReturnType<typeof loadConfig>>, cache?: Cache) {
    this.cfg = { ...loadConfig(), ...cfg };
    this.upstream = new UpstreamClient(this.cfg);
    this.cache = cache ?? new NullCache();
    this.jsCache = new JsRewriteCache(this.cfg.JS_REWRITE_CACHE_SIZE);
  }

  async handle(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = (req.url ?? "").replace(/^\/+/, "");
    if (!token) {
      return reply.code(400).type("text/html").send(this.errorPage("No target URL supplied."));
    }

    const target = decodeTarget(token);
    if (!target) {
      return reply.code(400).type("text/html").send(this.errorPage("Invalid target URL."));
    }

    try {
      await validateTarget(target, {
        allowedProtocols: this.cfg.ALLOWED_PROTOCOLS,
        allowedHosts: this.cfg.ALLOWED_HOSTS,
        allowPrivate: this.cfg.ALLOW_PRIVATE_IPS,
      });
    } catch (err) {
      if (err instanceof SsrfError) {
        return reply.code(403).type("text/html").send(this.errorPage(`Blocked: ${err.message}`));
      }
      throw err;
    }

    let upstreamRes;
    try {
      const body = req.body as Buffer | undefined;
      const hasBody =
        req.method !== "GET" && req.method !== "HEAD" && Buffer.isBuffer(body) && body.length > 0;
      upstreamRes = await this.upstream.fetch(target, {
        method: req.method,
        headers: this.buildOutboundHeaders(req, target),
        ...(hasBody ? { body } : {}),
      });
    } catch (err: any) {
      const isTimeout = err?.name === "AbortError";
      const status = isTimeout ? 504 : 502;
      req.log.error(
        { err: { name: err?.name, message: err?.message, code: err?.code, cause: err?.cause?.message, causeCode: err?.cause?.code } },
        `upstream fetch failed for ${target}`,
      );
      return reply.code(status).type("text/html").send(this.errorPage(isTimeout ? "Upstream timed out." : "Upstream unreachable."));
    }

    // Redirects: follow ourselves, rewriting Location through the proxy.
    if (upstreamRes.status >= 300 && upstreamRes.status < 400) {
      await upstreamRes.body?.cancel();
      const location = upstreamRes.headers.get("location");
      if (location) {
        return reply.redirect(rewriteLocation(location, target, this.cfg.PROXY_PUBLIC_ORIGIN));
      }
      return reply.code(upstreamRes.status).send();
    }

    // HEAD: undici returns an empty body, but cancel it so we never stream.
    if (req.method === "HEAD") await upstreamRes.body?.cancel();

    const contentType = upstreamRes.headers.get("content-type") ?? "";
    const rewritten = this.shouldRewrite(contentType);
    const isSse = contentType.toLowerCase().startsWith("text/event-stream");
    const targetHost = new URL(target).host;

    const cacheDecision = decideCache(req.method, upstreamRes.status, upstreamRes.headers, target, this.cfg.CACHE_TTL_SECONDS);
    if (cacheDecision.cacheable) {
      const cached = await this.cache.get(cacheDecision.cacheKey);
      if (cached) {
        await upstreamRes.body?.cancel();
        reply.code(cached.status);
        for (const [k, v] of Object.entries(cached.headers)) reply.header(k, v as string);
        return reply.send(cached.body);
      }
    }

    const sanHeaders = sanitizeResponseHeaders(upstreamRes.headers, {
      rewritten,
      proxyOrigin: this.cfg.PROXY_PUBLIC_ORIGIN,
    });
    reply.code(upstreamRes.status);
    for (const [k, v] of Object.entries(sanHeaders)) {
      reply.header(k, v as string);
    }
    // Cookies: rewrite each Set-Cookie to the proxy origin, namespaced per host.
    const setCookies = upstreamRes.headers.getSetCookie?.() ?? [];
    for (const sc of setCookies) {
      if (sc) reply.header("set-cookie", rewriteSetCookie(sc, targetHost));
    }

    if (!upstreamRes.body) return reply.send();

    // SSE: stream through the line-rewriter. Must run before the cacheable path
    // (event streams are never cacheable, but be explicit) and before generic
    // buffered rewriting — a long-lived stream must never be fully buffered.
    if (isSse) {
      return reply.send(
        Readable.fromWeb(upstreamRes.body as any).pipe(
          new SseRewriteTransform(target, this.cfg.PROXY_PUBLIC_ORIGIN),
        ),
      );
    }

    if (cacheDecision.cacheable) {
      // Buffer, rewrite, and store so subsequent requests hit the cache.
      const body = await this.readBody(upstreamRes.body);
      const finalBuffer = this.applyRewrite(body, contentType, rewritten, target);
      const storedHeaders = { ...sanHeaders } as Record<string, string | string[]>;
      delete storedHeaders["content-encoding"];
      delete storedHeaders["content-length"];
      void this.cache.set(
        cacheDecision.cacheKey,
        { status: upstreamRes.status, headers: storedHeaders, body: finalBuffer },
        cacheDecision.ttlSeconds,
      );
      return reply.send(finalBuffer);
    }

    if (rewritten) {
      const out = new PassThrough();
      void this.rewriteText(target, contentType, upstreamRes.body, out)
        .then(() => out.end())
        .catch((err) => out.destroy(err as Error));
      return reply.send(out);
    }
    return reply.send(Readable.fromWeb(upstreamRes.body as any));
  }

  close(): Promise<void> {
    this.upstream.close();
    return this.cache.close();
  }

  private buildOutboundHeaders(req: FastifyRequest, target: string): Record<string, string> {
    const targetHost = new URL(target).host;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lower = k.toLowerCase();
      if (
        ["host", "connection", "content-length", "accept-encoding", "transfer-encoding", "expect"].includes(lower) ||
        v === undefined
      ) {
        continue;
      }
      if (lower === "cookie") {
        // Forward only this host's namespaced cookies, un-namespaced.
        const value = typeof v === "string" ? v : v.join("; ");
        const rewritten = rewriteCookieHeader(value, targetHost);
        if (rewritten) headers[k] = rewritten;
        continue;
      }
      headers[k] = typeof v === "string" ? v : v.join(", ");
    }
    headers["Referer"] = new URL(target).origin + "/";
    return headers;
  }

  private shouldRewrite(contentType: string): boolean {
    return this.rewriteKind(contentType) !== null;
  }

  /** Pick the rewriter for a content type; null streams bytes untouched. */
  private rewriteKind(contentType: string): "html" | "css" | "js" | null {
    const t = contentType.toLowerCase();
    if (t.includes("text/html") || t.includes("application/xhtml+xml")) return "html";
    if (t.includes("text/css")) return "css";
    if (t.includes("javascript") || t.includes("ecmascript")) return "js";
    return null;
  }

  /**
   * Buffer up to a limit, rewrite, and emit the text. undici's fetch already
   * decodes gzip/deflate/br, so `body` here is raw (decoded) bytes and we never
   * re-encode — the content-encoding header is stripped when forwarding (see
   * headers.ts). Oversized bodies stream through untouched instead of truncating.
   */
  private async rewriteText(
    target: string,
    contentType: string,
    body: ReadableStream,
    out: PassThrough,
  ): Promise<void> {
    const kind = this.rewriteKind(contentType) ?? "html";
    const limit = kind === "js" ? this.cfg.MAX_JS_REWRITE_BYTES : this.cfg.MAX_REWRITE_BODY_BYTES;
    const node: Readable = Readable.fromWeb(body as any);

    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;
    for await (const chunk of node) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (oversized) {
        out.write(buf);
        continue;
      }
      chunks.push(buf);
      size += buf.length;
      if (size > limit) oversized = true;
    }
    if (oversized) {
      out.end(Buffer.concat(chunks));
      return;
    }

    const full = Buffer.concat(chunks).toString("utf8");
    const rewritten =
      kind === "js"
        ? rewriteJs(full, target, this.cfg.PROXY_PUBLIC_ORIGIN, { cache: this.jsCache })
        : kind === "html"
          ? rewriteHtml(full, target, this.cfg.PROXY_PUBLIC_ORIGIN)
          : rewriteCss(full, target, this.cfg.PROXY_PUBLIC_ORIGIN);
    out.write(Buffer.from(rewritten, "utf8"));
  }

  /** Read a full response body (already decoded by undici) into a Buffer. */
  private async readBody(body: ReadableStream): Promise<Buffer> {
    const node: Readable = Readable.fromWeb(body as any);
    const chunks: Buffer[] = [];
    for await (const chunk of node) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  /** Apply HTML/CSS/JS rewriting to a buffered body; returns bytes to send. */
  private applyRewrite(body: Buffer, contentType: string, rewritten: boolean, target: string): Buffer {
    if (!rewritten) return body;
    const text = body.toString("utf8");
    const kind = this.rewriteKind(contentType) ?? "html";
    const out =
      kind === "js"
        ? rewriteJs(text, target, this.cfg.PROXY_PUBLIC_ORIGIN, { cache: this.jsCache })
        : kind === "html"
          ? rewriteHtml(text, target, this.cfg.PROXY_PUBLIC_ORIGIN)
          : rewriteCss(text, target, this.cfg.PROXY_PUBLIC_ORIGIN);
    return Buffer.from(out, "utf8");
  }

  errorPage(message: string): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">${errorPageCss}<title>Proxy error</title></head><body><div class="card"><h1>Proxy error</h1><p>${escapeHtml(message)}</p><a class="back" href="/">← Go to proxy home</a></div></body></html>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

const errorPageCss = `<style>body{font-family:system-ui,sans-serif;background:#0f1115;color:#e6e6e6;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{max-width:480px;padding:2rem;border:1px solid #2a2d37;border-radius:12px;background:#171a21}h1{font-size:1.4rem;margin:0 0 .5rem}p{color:#9aa0aa}a{color:#6ea8fe}.back{display:inline-block;margin-top:1rem}</style>`;
