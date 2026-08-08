# WebProxy

A CroxyProxy-style **rewriting web proxy**. Enter any URL and browse that site
through this service — every link, resource, cookie, redirect, WebSocket, and
stream is rewritten to route through the proxy domain. No client configuration
required.

Built with **Node.js 22 + TypeScript**, **Fastify**, **undici**, **cheerio**,
and **ws**, designed for **scalable multi-node** deployment.

## Features

- **Server-side content rewriting** — HTML URLs (`href`, `src`, `srcset`,
  `action`, forms, meta refresh, OpenGraph), inline `style` + `<style>` blocks,
  external CSS `url()`/`@import`, redirects, and headers (CSP / X-Frame-Options
  / CORS neutralized).
- **Cookie namespacing** — cookies are scoped to the proxy origin and
  namespaced per target host so browsing multiple sites never collides or leaks.
- **Client bootstrap** — injected script rewrites dynamic JS (`fetch`, `XHR`,
  `WebSocket`, `EventSource`, `window.open`, `location.href`, `Worker`,
  `sendBeacon`, `history.pushState`) at runtime, and patches element URL setters
  + a MutationObserver so JS-created `img.src`/`srcset`/`form.action` still
  proxy.
- **Server-side JS rewriting (Babel)** — ES-module `import`/`export`, dynamic
  `import()`, `import.meta.url`, and worker `importScripts` in `text/javascript`
  responses are rewritten so modern JS-heavy sites work.
- **Streaming transports** — SSE (line-streamed `data:` URL rewrite), video/large
  files (byte-range/206), and WebSocket upgrade bridging (text/binary opcode
  preserved, subprotocol negotiation forwarded).
- **Burst-friendly upstream** — outbound connections are capped per origin
  (browser-like ~6/host) so loading image-heavy pages doesn't trip upstream edge
  rate limiters.
- **Security** — SSRF guard (blocks loopback/private/link-local/cloud-metadata
  IPs, post-DNS), per-IP rate limiting, body limits.
- **Caching & scaling** — Redis-backed cache (no-op fallback), PM2 cluster,
  keep-alive upstream pooling.
- **Ops** — Docker + docker-compose (app + Redis + Caddy TLS), GitHub Actions CI.

## Quick start (dev)

```bash
npm install
npm run dev            # http://localhost:3000
npm test               # unit + integration + WebSocket tests
npm run typecheck
```

Open `http://localhost:3000`, enter a URL, and browse.

### End-to-end testing

A Playwright suite covers the proxy itself plus a controlled local **modern JS
site fixture** (ES modules, dynamic `import()`, workers, fetch GET/POST,
EventSource/SSE, WebSocket text+binary, audio/video Range/206, pushState,
sendBeacon, JS-created images with srcset):

```bash
npx playwright test                     # fixture + smoke specs (no network)
npm run test:e2e                        # same, via package script
```

Real-site spot checks (requires outbound internet; `UPSTREAM_IP_FAMILY=ipv4`
in this sandbox):

```bash
ALLOW_PRIVATE_IPS=true UPSTREAM_IP_FAMILY=ipv4 RATE_LIMIT_MAX_REQUESTS=100000 \
  PROXY_PUBLIC_ORIGIN=http://localhost:3000 npm run dev   # in one shell
node browse-probe.mjs "https://en.wikipedia.org/wiki/Web_proxy"
```

`browse-probe.mjs` loads a real article, follows an in-page link, and plays a
Wikimedia Commons OGG audio file through the proxy, asserting: **zero** direct
upstream-origin requests (no leaks), **zero** failed requests, **zero** console
errors, a decodable media element, and ≥1 byte-range (206) response. Note: busy
CDNs (Wikimedia's Varnish edge) intermittently return HTTP 429 on the *site's
own* ~50-thumbnail burst from a single IP — this is upstream throttling
(`retry-after: 1`), not a proxy defect, and is reported separately by the probe.

## Deploy (Docker)

```bash
# Requires Caddy for TLS; set PROXY_PUBLIC_ORIGIN to your public origin
PROXY_PUBLIC_ORIGIN=https://proxy.example.com docker compose up --build
```

For multi-core scaling without Redis orchestration:

```bash
npm run build
npx pm2 start ecosystem.config.cjs   # cluster across all cores
```

## Configuration

All settings are env-driven (see `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Server bind |
| `ALLOWED_HOSTS` | *(empty)* | Comma-separated target allowlist (empty = any public host) |
| `ALLOW_PRIVATE_IPS` | `false` | Permit loopback/private targets (**testing only**) |
| `REDIS_URL`, `REDIS_CACHE` | `redis://127.0.0.1:6379`, off | Shared cache for multi-node |
| `CACHE_TTL_SECONDS` | `300` | Default cache TTL |
| `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX_REQUESTS` | `60000` / `120` | Per-IP rate limiting |
| `UPSTREAM_IP_FAMILY` | `auto` | Upstream IP family: `auto` \| `ipv4` \| `ipv6`. Set `ipv4` if outbound IPv6 is broken |
| `MAX_REWRITE_BODY_BYTES` | `5 MiB` | Largest HTML/CSS body buffered for rewriting |
| `MAX_JS_REWRITE_BYTES` | `16 MiB` | Largest JS body buffered for Babel rewriting (larger streams untouched) |
| `JS_REWRITE_CACHE_SIZE` | `128` | LRU entries in the rewritten-JS cache |
| `MAX_BODY_BYTES` | `1 MiB` | Largest request body accepted (upload limit) |
| `UPSTREAM_MAX_CONCURRENCY_PER_ORIGIN` | `6` | Max outbound connections per upstream origin (browser-like cap) |
| `PROXY_PUBLIC_ORIGIN` | `http://localhost:3000` | Public origin used when building rewritten URLs |

## Architecture

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full design: the deterministic
base64url URL scheme, the rewriting rules, the header/cookie policy, the
streaming model, and the security model.

## Layout

```
src/config/      env config (zod)         src/proxy/     core pipeline, scheme, upstream, handler
src/rewrite/     html, css, url, headers, cookies
src/security/    ip, ssrf, rateLimit      src/cache/     cache + cacheability
src/transports/  websocket proxy          src/web/       bootstrap.js, home.html
test/            unit + integration + ws  tests/e2e/     Playwright smoke
```
