/** Decide whether an upstream response is safe to cache, and for how long. */

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface CacheDecision {
  cacheable: boolean;
  ttlSeconds: number;
  cacheKey: string;
}

/**
 * A GET response is cacheable when it has no Set-Cookie and its Cache-Control
 * does not forbid caching. TTL is taken from s-maxage > max-age, else the
 * provided default.
 */
export function decideCache(
  method: string,
  status: number,
  headers: Headers,
  targetUrl: string,
  defaultTtl: number,
): CacheDecision {
  if (method !== "GET") return notCacheable();
  if (status !== 200) return notCacheable();
  if (headers.get("set-cookie")) return notCacheable();
  if (headers.get("content-encoding")) return notCacheable(); // would need re-encoding on serve
  // Event streams are infinite; buffering them would hang the response forever
  // (headers never reach the client). Never cache, never buffer.
  if ((headers.get("content-type") ?? "").toLowerCase().startsWith("text/event-stream")) {
    return notCacheable();
  }

  const cc = (headers.get("cache-control") ?? "").toLowerCase();
  if (/\bno-store\b|\bno-cache\b/.test(cc)) return notCacheable();

  let ttl = defaultTtl;
  const sMax = /s-maxage=(\d+)/.exec(cc);
  const max = /max-age=(\d+)/.exec(cc);
  if (sMax) ttl = Number(sMax[1]);
  else if (max) ttl = Number(max[1]);
  if (ttl <= 0) return notCacheable();

  // Key by canonical target URL (strips fragment).
  return { cacheable: true, ttlSeconds: ttl, cacheKey: targetUrl };
}

function notCacheable(): CacheDecision {
  return { cacheable: false, ttlSeconds: 0, cacheKey: "" };
}

/** Strip hop-by-hop headers before storing/serving a cached response. */
export function filterStorableHeaders(source: Headers): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of source.entries()) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}
