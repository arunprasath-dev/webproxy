import { test, expect, type Page } from "@playwright/test";
import { encodeTarget } from "../../src/proxy/scheme.js";
import { startFixture } from "./fixture/server.js";

/**
 * End-to-end: a JS-heavy "modern site" proxied through the running proxy
 * (playwright.config webServer). The browser must only ever talk to the proxy
 * origin — every subresource, fetch, module, worker, SSE and WebSocket must be
 * rewritten. Any direct request to the fixture (a leaked upstream URL) fails
 * the test, as does any console error, failed request, or HTTP >= 400.
 */

let fixture: Awaited<ReturnType<typeof startFixture>>;
let proxied: string;
const PROXY_ORIGIN = "http://localhost:3000";

test.beforeAll(async () => {
  fixture = await startFixture();
  proxied = `${PROXY_ORIGIN}/${encodeTarget(fixture.origin + "/")}`;
});

test.afterAll(async () => {
  await fixture.close();
});

function attachWatchers(page: Page) {
  const watchers = {
    consoleErrors: [] as string[],
    failed: [] as string[],
    leaks: [] as string[],
    httpErrors: [] as string[],
    ranges206: [] as string[],
  };
  page.on("console", (msg) => {
    if (msg.type() === "error") watchers.consoleErrors.push(msg.text().slice(0, 240));
  });
  page.on("requestfailed", (req) => {
    const err = req.failure()?.errorText ?? "";
    if (err === "net::ERR_ABORTED") return; // e.g. EventSource.close() mid-flight
    watchers.failed.push(`${req.method()} ${req.url().slice(0, 160)} :: ${err}`);
  });
  page.on("response", (res) => {
    const url = res.url();
    if (res.status() >= 400) watchers.httpErrors.push(`HTTP ${res.status()} ${url.slice(0, 160)}`);
    if (res.status() === 206) watchers.ranges206.push(url.slice(0, 160));
  });
  page.on("request", (req) => {
    const url = req.url();
    // Any request that goes straight to the fixture instead of the proxy leaks.
    if (url.startsWith(fixture.origin)) watchers.leaks.push(url.slice(0, 160));
  });
  return watchers;
}

test("a modern JS site works end-to-end through the proxy", async ({ page }) => {
  const w = attachWatchers(page);

  await page.goto(proxied, { waitUntil: "load" });

  // The page stays on the proxy origin with a token path.
  expect(page.url()).toMatch(new RegExp(`^${PROXY_ORIGIN.replace(/[/\\.]/g, "\\$&")}/[A-Za-z0-9_-]+$`));

  // Dynamic fetch GET + POST.
  await expect(page.locator("#status")).toContainText("json-ok", { timeout: 20_000 });
  await expect(page.locator("#status")).toContainText("post-POST-world", { timeout: 20_000 });

  // Banner image assigned via JS setter from an upstream-absolute URL -> a real
  // image must load through the proxy.
  await expect(page.locator("#banner-img")).toHaveJSProperty("naturalWidth", 1, { timeout: 20_000 });

  // Detached JS-created image with srcset -> both candidates through the proxy.
  await expect(page.locator("#srcset-img")).toHaveJSProperty("naturalWidth", 1, { timeout: 20_000 });

  // ES module graph: static import + dynamic import + new URL(import.meta.url)
  // asset all resolved through the proxy.
  await expect(page.locator("#module-out")).toContainText("lib-ok|dyn-ok", { timeout: 20_000 });
  const moduleText = (await page.locator("#module-out").textContent()) ?? "";
  expect(moduleText).toContain("module-data-ok");
  expect(moduleText).toMatch(new RegExp(`${PROXY_ORIGIN.replace(/[/\\.]/g, "\\$&")}/[A-Za-z0-9_-]+`));

  // Classic worker: importScripts dep + worker-scope fetch.
  await expect(page.locator("#worker-out")).toContainText("worker-echo-ok-dep-ok", { timeout: 20_000 });

  // SSE: three data events, each carrying a rewritten (proxied) URL.
  await expect
    .poll(async () => ((await page.locator("#sse-out").textContent()) ?? "").split(";").length - 1, {
      timeout: 20_000,
    })
    .toBeGreaterThanOrEqual(3);
  const sseText = (await page.locator("#sse-out").textContent()) ?? "";
  const proxiedSseUrls = sseText.match(new RegExp(`${PROXY_ORIGIN.replace(/[/\\.]/g, "\\$&")}/[A-Za-z0-9_-]+`, "g")) ?? [];
  expect(proxiedSseUrls.length).toBeGreaterThanOrEqual(3);

  // WebSocket: text and binary round-trip (opcode preserved through the relay).
  await expect(page.locator("#status")).toContainText("ws-text:ping", { timeout: 20_000 });
  await expect(page.locator("#status")).toContainText("ws-bin:3", { timeout: 20_000 });

  // Audio is a real WAV: the media element decodes it (proves Range/206 works).
  const audioOk = await page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const a = document.getElementById("audio") as HTMLAudioElement;
        if (!a) return resolve(false);
        let done = false;
        const finish = (v: boolean) => {
          if (!done) {
            done = true;
            resolve(v);
          }
        };
        a.addEventListener("loadedmetadata", () => finish(true), { once: true });
        a.addEventListener("error", () => finish(false), { once: true });
        a.load();
        setTimeout(() => finish(false), 15_000);
      }),
  );
  expect(audioOk).toBe(true);

  // Video is a large byte stream: a Range request must come back as a 206
  // with a content-range (decode is best-effort, not asserted).
  await expect(page.locator("#status")).toContainText("video-206:bytes ", { timeout: 20_000 });
  expect(w.ranges206.length).toBeGreaterThanOrEqual(1);

  // pushState SPA navigation keeps the relative URL (no proxy path corruption).
  await page.click("#nav-btn");
  await expect(page).toHaveURL(/\/route$/);

  // sendBeacon is recorded by the fixture (proxied POST).
  await expect
    .poll(async () => {
      const res = await page.evaluate(() =>
        fetch("/api/beacon-count").then((r) => r.json()).catch(() => ({ count: 0 })),
      );
      return (res as { count: number }).count;
    }, { timeout: 20_000 })
    .toBeGreaterThanOrEqual(1);

  // The whole page must be leak-free: no console errors, no failed requests,
  // no 4xx/5xx, no direct-origin (upstream) requests.
  expect(w.consoleErrors).toEqual([]);
  expect(w.failed).toEqual([]);
  expect(w.httpErrors).toEqual([]);
  expect(w.leaks).toEqual([]);
});
