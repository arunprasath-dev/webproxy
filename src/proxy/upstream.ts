import { Agent, fetch, type RequestInit, type Response } from "undici";
import type { Config } from "../config/config.js";

/**
 * Outbound HTTP client.
 * Uses undici's Agent with keep-alive connection pooling per origin for
 * throughput, and explicit connect/request timeouts.
 */
export class UpstreamClient {
  private readonly agent: Agent;

  constructor(private readonly cfg: Config) {
    this.agent = new Agent({
      connect: {
        timeout: cfg.UPSTREAM_CONNECT_TIMEOUT,
        // Force a single IP family when configured (e.g. broken IPv6 egress);
        // default "auto" lets Node's happy-eyeballs pick between A and AAAA.
        ...(cfg.UPSTREAM_IP_FAMILY === "ipv4"
          ? { family: 4 }
          : cfg.UPSTREAM_IP_FAMILY === "ipv6"
            ? { family: 6 }
            : {}),
      },
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
      connections: cfg.KEEP_ALIVE_MAX,
    });
  }

  /** Perform an outbound request; caller is responsible for draining the body. */
  fetch(targetUrl: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.cfg.UPSTREAM_REQUEST_TIMEOUT);
    const headers: Record<string, string> = {};
    const src = init.headers;
    if (src) {
      if (src instanceof Headers) {
        for (const [k, v] of src) headers[k] = v;
      } else if (Array.isArray(src)) {
        for (const [k, v] of src) headers[k] = v;
      } else {
        for (const [k, v] of Object.entries(src as Record<string, string>)) {
          if (v !== undefined) headers[k] = v;
        }
      }
    }
    headers["User-Agent"] =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
    // Ask for compression to save upstream bandwidth. undici's fetch decodes
    // gzip/deflate/br transparently, so the handler rewrites already-decoded
    // text; the content-encoding header is stripped on the way out (headers.ts).
    headers["Accept-Encoding"] = "gzip, deflate, br";

    return fetch(targetUrl, {
      ...init,
      headers,
      dispatcher: this.agent,
      redirect: "manual",
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));
  }

  close(): void {
    this.agent.close();
  }
}
