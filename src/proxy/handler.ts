import type { FastifyReply, FastifyRequest } from "fastify";
import { PassThrough, Readable, type Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { loadConfig } from "../config/config.js";
import { UpstreamClient } from "./upstream.js";
import { decodeTarget } from "./scheme.js";
import { validateTarget, SsrfError } from "../security/ssrf.js";
import { sanitizeResponseHeaders, rewriteLocation } from "../rewrite/headers.js";
import { rewriteHtml } from "../rewrite/html.js";
import { rewriteCss } from "../rewrite/css.js";
import { rewriteCookieHeader, rewriteSetCookie } from "../rewrite/cookies.js";

/**
 * Core proxy handler: decode target -> SSRF guard -> fetch upstream ->
 * per-content-type rewrite -> stream back with sanitized headers.
 */
export class ProxyHandler {
  private readonly cfg: ReturnType<typeof loadConfig>;
  private readonly upstream: UpstreamClient;

  constructor(cfg?: Partial<ReturnType<typeof loadConfig>>) {
    this.cfg = { ...loadConfig(), ...cfg };
    this.upstream = new UpstreamClient(this.cfg);
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
      upstreamRes = await this.upstream.fetch(target, {
        method: req.method,
        headers: this.buildOutboundHeaders(req, target),
      });
    } catch (err: any) {
      const isTimeout = err?.name === "AbortError";
      const status = isTimeout ? 504 : 502;
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

    const contentType = upstreamRes.headers.get("content-type") ?? "";
    const contentEncoding = (upstreamRes.headers.get("content-encoding") ?? "").toLowerCase();
    const rewritten = this.shouldRewrite(contentType);

    reply.code(upstreamRes.status);
    const targetHost = new URL(target).host;
    const sanHeaders = sanitizeResponseHeaders(upstreamRes.headers, {
      rewritten,
      proxyOrigin: this.cfg.PROXY_PUBLIC_ORIGIN,
    });
    for (const [k, v] of Object.entries(sanHeaders)) {
      reply.header(k, v as string);
    }
    // Cookies: rewrite each Set-Cookie to the proxy origin, namespaced per host.
    const setCookies = upstreamRes.headers.getSetCookie?.() ?? [];
    for (const sc of setCookies) {
      if (sc) reply.header("set-cookie", rewriteSetCookie(sc, targetHost));
    }

    if (!upstreamRes.body) return reply.send();

    if (rewritten) {
      const out = new PassThrough();
      void this.rewriteText(target, contentType, contentEncoding, upstreamRes.body, out)
        .then(() => out.end())
        .catch((err) => out.destroy(err as Error));
      return reply.send(out);
    }
    return reply.send(Readable.fromWeb(upstreamRes.body as any));
  }

  private buildOutboundHeaders(req: FastifyRequest, target: string): Record<string, string> {
    const targetHost = new URL(target).host;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lower = k.toLowerCase();
      if (
        ["host", "connection", "content-length", "accept-encoding", "transfer-encoding"].includes(lower) ||
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
    const t = contentType.toLowerCase();
    return t.includes("text/html") || t.includes("application/xhtml+xml") || t.includes("text/css");
  }

  /** Decompress, buffer up to a limit, rewrite, and emit the text. */
  private async rewriteText(
    target: string,
    contentType: string,
    contentEncoding: string,
    body: ReadableStream,
    out: PassThrough,
  ): Promise<void> {
    const isHtml = contentType.toLowerCase().includes("html");

    let node: Readable = Readable.fromWeb(body as any);
    const dec = this.decompressor(contentEncoding);
    if (dec) node = node.pipe(dec);

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of node) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buf);
      size += buf.length;
      if (size > this.cfg.MAX_REWRITE_BODY_BYTES) break;
    }
    if (size > this.cfg.MAX_REWRITE_BODY_BYTES) {
      // Too large to buffer for rewriting — fall back to streaming unchanged.
      out.end(Buffer.concat(chunks));
      return;
    }

    const full = Buffer.concat(chunks).toString("utf8");
    const rewritten = isHtml
      ? rewriteHtml(full, target, this.cfg.PROXY_PUBLIC_ORIGIN)
      : rewriteCss(full, target, this.cfg.PROXY_PUBLIC_ORIGIN);
    out.write(Buffer.from(rewritten, "utf8"));
  }

  private decompressor(encoding: string): Transform | null {
    switch (encoding) {
      case "gzip":
        return createGunzip();
      case "deflate":
        return createInflate();
      case "br":
        return createBrotliDecompress();
      default:
        return null;
    }
  }

  errorPage(message: string): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">${errorPageCss}<title>Proxy error</title></head><body><div class="card"><h1>Proxy error</h1><p>${escapeHtml(message)}</p><a class="back" href="/">← Go to proxy home</a></div></body></html>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

const errorPageCss = `<style>body{font-family:system-ui,sans-serif;background:#0f1115;color:#e6e6e6;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{max-width:480px;padding:2rem;border:1px solid #2a2d37;border-radius:12px;background:#171a21}h1{font-size:1.4rem;margin:0 0 .5rem}p{color:#9aa0aa}a{color:#6ea8fe}.back{display:inline-block;margin-top:1rem}</style>`;
