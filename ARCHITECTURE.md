# Web Proxy — Architecture

A CroxyProxy-style **rewriting web proxy** in Node.js + TypeScript. A user enters
any URL and browses that site through this service; every link, resource,
cookie, redirect, and transport is rewritten to route through the proxy domain.

## Core idea: rewriting proxy (not a pass-through reverse proxy)

A plain reverse proxy only swaps the host and pipes bytes; the browser then
fetches subresources from the real site, breaking the proxy. This service
**modifies content** so all traffic stays on the proxy origin.

## Request flow

```
Browser
  │  https://proxy.example/<base64url(target)>
  ▼
Fastify server (GET /*)
  │  1. decode base64url token → target URL
  │  2. SSRF guard: protocol allowlist, host allowlist, block private/link-local IPs
  │  3. undici outbound fetch (keep-alive Agent pool, timeouts)
  │  4. per content-type pipeline:
  │       text/html, xhtml → cheerio URL rewriting + bootstrap injection
  │       text/css         → url()/@import rewriting
  │       binary (img/video/font) → streamed untouched
  │  5. rewrite headers / cookies / Location redirects
  ▼
Stream back to browser (chunked, backpressure)
```

## URL scheme

A target is encoded as `base64url(<scheme>://<host>/<path>?<query>#<frag>)` and
exposed at `<proxy-origin>/<token>`. base64url avoids ambiguity with `/ ? #` and
is safe in headers and shells. The client bootstrap re-uses this scheme to build
URLs at runtime. See `src/proxy/scheme.ts`.

## Rewriting rules

- **HTML** (`src/rewrite/html.ts`): rewrite `href`, `src`, `srcset`, `action`,
  `poster`, `data-*`, `<form>`, `<link>`, `<iframe>`, `<source>`, meta
  `http-equiv=refresh` and `og:image|og:url|twitter:*`; resolve relatives
  against `<base href>` / document URL; inject bootstrap shim into `<head>`.
- **CSS** (`src/rewrite/css.ts`): rewrite `url(...)` and `@import`.
- **JS** (`src/proxy/handler.ts` bootstrap, Phase 5): override `fetch`, `XHR`,
  `WebSocket`, `EventSource`, `location` setters to route through the proxy.
- **Headers** (`src/rewrite/headers.ts`): strip `Content-Security-Policy*`,
  `X-Frame-Options`, neutralize CORS, drop `Content-Length` on rewritten bodies,
  set chunked, add `X-Content-Type-Options: nosniff`.
- **Cookies** (Phase 4): force `Domain` off, `Path=/`, `Secure`, `SameSite=None`,
  and namespace cookie names per target host to avoid cross-site collisions.
- **Redirects**: `Location` on 3xx re-encoded through the proxy.

## Content-encoding & streaming

`Accept-Encoding: gzip, deflate, br` is sent upstream. Rewritten text bodies are
decompressed, buffered up to `MAX_REWRITE_BODY_BYTES`, rewritten, and
re-emitted (chunked). Binary and oversized bodies stream untouched with
backpressure. WebSockets, SSE, and byte-range video streaming are handled in
Phase 7.

## Security model

- **SSRF guard** (`src/security/`): protocol + host allowlists; blocks loopback,
  private RFC1918, link-local, CGNAT, TEST-NET, multicast/reserved IPv4, and ULA
  IPv6; DNS-resolved addresses re-validated (see Phase 9 for DNS-rebinding).
- **Abuse controls** (Phase 9): Redis-backed rate limiting, request size limits,
  timeouts, header-injection / request-smuggling guards.

## Layout

```
src/config/     env-driven config (zod)
src/proxy/      core pipeline, URL scheme, upstream client, handler
src/rewrite/    html.ts, css.ts, url.ts, headers.ts, cookies.ts(4)
src/security/   ip.ts, ssrf.ts, rateLimit.ts(9)
src/transports/ ws.ts, sse.ts(7)
src/web/        frontend (Phase 6)
test/           unit + integration suites
```
