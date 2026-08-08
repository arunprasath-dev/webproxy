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
  `WebSocket`, `EventSource`, `window.open`, `location.href`) at runtime.
- **Streaming transports** — SSE, video/large files (byte-range), and WebSocket
  upgrade bridging.
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
| `MAX_REWRITE_BODY_BYTES` | `5 MiB` | Largest body buffered for rewriting |
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
