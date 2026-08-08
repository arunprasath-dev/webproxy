import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { WebSocketServer } from "ws";

/**
 * Controlled "modern site" fixture used by the Playwright E2E suite.
 *
 * Deliberately JS-heavy so the proxy's server-side rewriting and client
 * bootstrap are both exercised: ES modules (import + dynamic import +
 * `new URL(..., import.meta.url)`), a classic worker with importScripts and
 * worker-scope fetch, dynamic fetch GET/POST, EventSource (SSE), WebSocket,
 * pushState SPA navigation, sendBeacon, Range/206 audio+video streaming,
 * and JS-created images (setter path + srcset).
 *
 * The page needs its own real origin (the browser only ever talks to the
 * proxy). It is exposed to the page via `data-fixture-origin` on <body>, which
 * the HTML rewriter leaves untouched (data-* is not in URL_ATTRS).
 */
export async function startFixture(): Promise<{ origin: string; close: () => Promise<void> }> {
  const app: FastifyInstance = Fastify({ logger: false });

  // ---- static assets ------------------------------------------------------
  const PNG_1x1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );

  const WAV = synthWav(2, 8000);
  const VIDEO_BLOB = deterministicBlob(512 * 1024); // not a real codec; Range/206 is what we prove

  app.get("/style.css", async (_req, reply) =>
    reply.type("text/css").header("cache-control", "public, max-age=3600").send("body{font-family:sans-serif}.out{color:#333}"),
  );

  app.get("/app.js", async (_req, reply) =>
    reply.type("application/javascript").header("cache-control", "public, max-age=3600").send(appScript),
  );
  app.get("/module.js", async (_req, reply) =>
    reply.type("application/javascript").send(`import { libMsg } from "./lib.js";\nconst dynamic = await import("./dynamic.js");\nconst assetUrl = new URL("./asset.png", import.meta.url).href;\ndocument.getElementById("module-out").textContent = libMsg + "|" + dynamic.dynMsg + "|" + assetUrl;\nfetch("/api/module-data").then(r => r.json()).then(d => { document.getElementById("module-out").textContent += "|data:" + d.ok; });`),
  );
  app.get("/lib.js", async (_req, reply) => reply.type("application/javascript").send('export const libMsg = "lib-ok";'));
  app.get("/dynamic.js", async (_req, reply) => reply.type("application/javascript").send('export const dynMsg = "dyn-ok";'));
  app.get("/worker.js", async (_req, reply) =>
    reply.type("application/javascript").send('importScripts("/worker-dep.js");\nself.onmessage = function (ev) { fetch("/api/worker-echo").then(function (r) { if (!r.ok) { throw new Error("HTTP " + r.status); } return r.json(); }).then(function (d) { postMessage(d.echo + "-" + self.__dep); }).catch(function (e) { postMessage("worker-fail:" + (e && e.message)); }); };'),
  );
  app.get("/worker-dep.js", async (_req, reply) => reply.type("application/javascript").send('self.__dep = "dep-ok";'));

  const png = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.type("image/png").header("cache-control", "public, max-age=3600").send(PNG_1x1);
  app.get("/img/a.png", png);
  app.get("/img/b.png", png);
  app.get("/static/banner.png", png);
  app.get("/static/sse.png", png);
  app.get("/asset.png", png);

  // ---- API endpoints ------------------------------------------------------
  app.get("/api/json", async (req, reply) => {
    const origin = `${req.protocol}://${req.host}`;
    return reply.type("application/json").header("cache-control", "no-store").send({
      ok: true,
      banner: `${origin}/static/banner.png`,
    });
  });
  app.get("/api/module-data", async (_req, reply) => reply.type("application/json").send({ ok: "module-data-ok" }));
  app.get("/api/worker-echo", async (_req, reply) => reply.type("application/json").send({ echo: "worker-echo-ok" }));
  app.post("/api/submit", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    return reply.type("application/json").send({ method: req.method, echo: body });
  });

  const beacons: string[] = [];
  app.post("/api/beacon", async (req, reply) => {
    beacons.push(String(req.body ?? ""));
    return reply.type("application/json").send({ ok: true });
  });
  app.get("/api/beacon-count", async () => ({ count: beacons.length }));

  // GET form target (server-rendered; navigation happens through the proxy).
  app.get("/search", async (req, reply) =>
    reply.type("text/html").send(`<html><head><title>Search</title></head><body>results for ${String((req.query as Record<string, string>)?.q ?? "")}</body></html>`),
  );
  // SPA route (reached by pushState, not a navigation).
  app.get("/route", async (_req, reply) => reply.type("text/html").send("<html><head><title>Route</title></head><body>route page</body></html>"));

  // ---- SSE ----------------------------------------------------------------
  app.get("/events", async (req, reply) => {
    const origin = `${req.protocol}://${req.host}`;
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    let i = 0;
    const iv = setInterval(() => {
      i += 1;
      reply.raw.write(`id: ${i}\n`);
      // No `event:` field -> default "message" type -> the page's es.onmessage fires.
      reply.raw.write(`data: ${origin}/static/sse.png\n\n`);
      if (i >= 3) {
        clearInterval(iv);
        reply.raw.end();
      }
    }, 50);
  });

  // ---- media (Range / 206) ------------------------------------------------
  const serveRange =
    (file: Buffer, contentType: string) => async (req: FastifyRequest, reply: FastifyReply) => {
      const size = file.length;
      reply.header("accept-ranges", "bytes");
      const range = req.headers.range as string | undefined;
      if (!range) {
        return reply
          .code(200)
          .type(contentType)
          .header("content-length", size)
          .send(file);
      }
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (!m) {
        return reply.code(416).header("content-range", `bytes */${size}`).send();
      }
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : size - 1;
      if (Number.isNaN(start)) start = 0;
      if (Number.isNaN(end)) end = size - 1;
      end = Math.min(end, size - 1);
      if (start > end || start >= size) {
        return reply.code(416).header("content-range", `bytes */${size}`).send();
      }
      return reply
        .code(206)
        .type(contentType)
        .header("content-range", `bytes ${start}-${end}/${size}`)
        .header("content-length", end - start + 1)
        .send(file.subarray(start, end + 1));
    };
  app.get("/media/audio.wav", serveRange(WAV, "audio/wav"));
  app.get("/media/video.mp4", serveRange(VIDEO_BLOB, "video/mp4"));

  app.get("/favicon.ico", async (_req, reply) => reply.code(204).send());

  // ---- home page ----------------------------------------------------------
  app.get("/", async (req, reply) => {
    const origin = `${req.protocol}://${req.host}`;
    return reply
      .type("text/html")
      .header("cache-control", "no-store")
      .send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Modern Site</title>
<link rel="stylesheet" href="/style.css">
</head>
<body data-fixture-origin="${origin}">
<h1>Modern Site</h1>
<pre id="status"></pre>
<div id="banner"></div>
<div id="srcset"></div>
<div id="module-out" class="out"></div>
<div id="worker-out" class="out"></div>
<div id="sse-out" class="out"></div>
<audio id="audio" preload="metadata"></audio>
<video id="video" preload="metadata"></video>
<form id="submit-form" action="/api/submit" method="post">
  <input type="hidden" name="name" value="fixture">
  <button type="submit">Submit</button>
</form>
<script src="/app.js"></script>
<script type="module" src="/module.js"></script>
</body>
</html>`);
  });

  // ---- WebSocket echo (preserves opcode) ----------------------------------
  const wss = new WebSocketServer({ noServer: true });
  app.server.on("upgrade", (req, socket, head) => {
    if ((req.url ?? "").split("?")[0] !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (data, isBinary) => ws.send(data, { binary: isBinary }));
    });
  });

  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as { port: number }).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await app.close();
    },
  };
}

/** Synthesize a valid 16-bit mono PCM WAV (440 Hz sine) — decodable by Chromium. */
function synthWav(durationSec: number, sampleRate: number): Buffer {
  const numSamples = Math.floor(durationSec * sampleRate);
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12000);
    buf.writeInt16LE(sample, 44 + i * 2);
  }
  return buf;
}

/** Deterministic opaque blob used to prove Range/206 streaming for "video". */
function deterministicBlob(size: number): Buffer {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = (i * 31 + 7) & 0xff;
  return buf;
}

/** The classic page script. Relative URLs are resolved at runtime by the client
 *  bootstrap against the upstream document base. */
const appScript = `
(function () {
  "use strict";
  var fixtureOrigin = document.body.getAttribute("data-fixture-origin") || "";
  function $(id) { return document.getElementById(id); }
  function log(msg) { var el = $("status"); if (el) el.textContent += msg + "\\n"; }

  // 1. Dynamic fetch GET — the JSON carries an upstream-absolute banner URL
  //    that we assign to img.src (exercises the synchronous setter patch).
  fetch("/api/json").then(function (r) { return r.json(); }).then(function (data) {
    log("json-ok");
    var holder = document.getElementById("banner");
    var img = document.createElement("img");
    img.id = "banner-img";
    img.src = data.banner;
    holder.appendChild(img);
  }).catch(function () { log("json-fail"); });

  // 2. Dynamic fetch POST.
  fetch("/api/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hello: "world" })
  }).then(function (r) { return r.json(); }).then(function (data) {
    log("post-" + data.method + "-" + data.echo.hello);
  }).catch(function () { log("post-fail"); });

  // 3. Detached JS-created image with srcset (synchronous setter path).
  var det = new Image();
  det.id = "srcset-img";
  det.srcset = fixtureOrigin + "/img/a.png 1x, " + fixtureOrigin + "/img/b.png 2x";
  det.src = fixtureOrigin + "/img/a.png";
  document.getElementById("srcset").appendChild(det);

  // 4. Classic worker (blob-loader path).
  var worker = new Worker(fixtureOrigin + "/worker.js");
  worker.onmessage = function (ev) { document.getElementById("worker-out").textContent = ev.data; };
  worker.postMessage("go");

  // 5. EventSource (SSE). The fixture emits default "message" events (no
  //    event: field), so this onmessage handler receives them.
  var es = new EventSource(fixtureOrigin + "/events");
  var sseCount = 0;
  var sseOut = document.getElementById("sse-out");
  es.onmessage = function (ev) {
    sseCount += 1;
    sseOut.textContent += ev.data + ";";
    if (sseCount >= 3) es.close();
  };

  // 6. WebSocket (text + binary round-trip). The browser default binaryType is
  //    "blob"; set "arraybuffer" so ev.data.byteLength is stable.
  var ws = new WebSocket(fixtureOrigin.replace(/^http/, "ws") + "/ws");
  ws.binaryType = "arraybuffer";
  ws.onopen = function () {
    ws.send("ping");
    ws.send(new Uint8Array([1, 2, 3]).buffer);
  };
  ws.onmessage = function (ev) {
    if (typeof ev.data === "string") log("ws-text:" + ev.data);
    else log("ws-bin:" + ev.data.byteLength);
  };

  // 7. pushState SPA navigation (relative URL must be left alone).
  var navBtn = document.createElement("button");
  navBtn.id = "nav-btn";
  navBtn.textContent = "go route";
  navBtn.onclick = function () {
    history.pushState({}, "", "/route");
    document.getElementById("route-out") && (document.getElementById("route-out").textContent = "routed");
  };
  document.body.appendChild(navBtn);
  var routeOut = document.createElement("div");
  routeOut.id = "route-out";
  document.body.appendChild(routeOut);

  // 8. sendBeacon.
  try { navigator.sendBeacon(fixtureOrigin + "/api/beacon", "page-loaded"); } catch (e) {}

  // 9. Audio is a real WAV (decodable). Video is a large byte stream with a
  //    Range request — proves 206 streaming through the proxy without needing
  //    a video codec (and without a media-decode console error).
  document.getElementById("audio").src = fixtureOrigin + "/media/audio.wav";
  fetch(fixtureOrigin + "/media/video.mp4", { headers: { Range: "bytes=0-99" } })
    .then(function (r) { log("video-206:" + (r.status === 206 ? r.headers.get("content-range") : "no-206")); })
    .catch(function () { log("video-fail"); });
})();
`;
