import { Transform, type TransformCallback } from "node:stream";
import { rewriteUrl } from "./url.js";

/**
 * Streaming SSE rewriter.
 *
 * Rewrites only the `data:` payload lines of an event-stream, proxying any
 * http(s) URL token inside them back through the proxy. The stream is never
 * buffered as a whole — lines are transformed as they arrive and flushed — so
 * an infinite event stream flows through without ever being held up (and
 * without the cache layer ever trying to buffer it; see cacheability.ts).
 *
 * Lines are re-emitted verbatim except for the URL tokens they contain: `id:`,
 * `event:`, `retry:`, comments (`: ...`) and blank separators pass through
 * untouched, and the CRLF of each line is preserved (we split on `\n` only,
 * leaving any trailing `\r` inside the line).
 */
export class SseRewriteTransform extends Transform {
  private pending = "";
  private readonly baseUrl: string;
  private readonly proxyOrigin: string;

  constructor(baseUrl: string, proxyOrigin: string) {
    super();
    this.baseUrl = baseUrl;
    this.proxyOrigin = proxyOrigin;
  }

  override _transform(chunk: Buffer, _enc: string, cb: TransformCallback): void {
    this.pending += chunk.toString("utf8");
    const lines = this.pending.split("\n");
    // The last element is a partial line; keep it until the next chunk.
    this.pending = lines.pop() ?? "";
    for (const line of lines) this.push(this.rewriteLine(line) + "\n");
    cb();
  }

  override _flush(cb: TransformCallback): void {
    if (this.pending.length) this.push(this.rewriteLine(this.pending));
    cb();
  }

  private rewriteLine(line: string): string {
    // Only `data:` lines carry payload. id/event/retry/comments are metadata.
    if (!/^data\b/.test(line)) return line;
    // Rewrite each absolute http(s) URL token (stop at whitespace, quotes,
    // angle brackets — the JSON/plain-text delimiters an SSE payload uses).
    // rewriteUrl also guards already-proxied tokens so re-encoding is impossible.
    return line.replace(/(https?:\/\/[^\s"'<>\]]+)/g, (tok) =>
      rewriteUrl(tok, this.baseUrl, this.proxyOrigin),
    );
  }
}
