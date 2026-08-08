import { encodeTarget } from "../proxy/scheme.js";

/**
 * Response header policy. Strips/rewrites headers that would break proxying,
 * and keeps the ones that matter.
 */

const STRIP = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "content-length", // recomputed/chunked because we may rewrite the body
  "content-encoding", // undici decodes the body; we forward raw bytes
  "x-content-type-options", // re-added by us
  "strict-transport-security", // managed by our TLS terminator
  "alt-svc",
  "clear-site-data",
  "cross-origin-embedder-policy",
  "cross-origin-opener-policy",
  "cross-origin-resource-policy",
  "x-xss-protection",
  "keep-alive",
  "transfer-encoding", // managed by Node
  "connection",
  "upgrade",
]);

// CORS headers are neutralized: everything is same-origin at the proxy.
const CORS_NEUTRALIZE = new Set([
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-expose-headers",
  "access-control-max-age",
]);

/** Build a plain object of sanitized response headers. */
export function sanitizeResponseHeaders(
  source: Headers,
  opts: { rewritten: boolean; proxyOrigin: string },
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of source.entries()) {
    const lower = key.toLowerCase();
    if (STRIP.has(lower)) continue;
    if (CORS_NEUTRALIZE.has(lower)) continue;
    if (lower === "location" || lower === "set-cookie") {
      // Location is handled by the redirect rewriter and set-cookie by the
      // cookie rewriter; skip both here to avoid duplicate/raw emission.
      continue;
    }
    if (lower === "content-type" || lower === "cache-control" || lower === "etag") {
      out[key] = value;
      continue;
    }
    // Default: keep hop-by-hop-safe headers.
    out[key] = value;
  }

  // If we rewrote the body, we cannot claim a byte-accurate content-length.
  if (opts.rewritten) {
    delete out["content-length"];
  }

  // Our own safety headers.
  out["X-Content-Type-Options"] = "nosniff";
  return out;
}

/** Rewrite a Location header (3xx redirect) back through the proxy. */
export function rewriteLocation(location: string, targetUrl: string, proxyOrigin: string): string {
  const base = new URL(targetUrl);
  let resolved: URL;
  try {
    resolved = new URL(location, base);
  } catch {
    return location;
  }
  // Skip non-http(s) schemes (e.g. mailto:, tel:) — return as-is.
  if (!["http:", "https:"].includes(resolved.protocol)) return location;
  return `${proxyOrigin.replace(/\/+$/, "")}/${encodeTarget(resolved.toString())}`;
}
