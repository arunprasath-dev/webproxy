import { chromium } from "@playwright/test";

// Mirrors src/proxy/scheme.ts encodeTarget: base64url of the target URL.
const encodeTarget = (u) => Buffer.from(u, "utf8").toString("base64url");

const PROXY = "http://localhost:3000";
const TARGET = process.argv[2] || "https://en.wikipedia.org/wiki/Web_proxy";
// A real Wikimedia Commons audio file (OGG, decodable in Chromium).
const MEDIA_URL =
  "https://upload.wikimedia.org/wikipedia/commons/d/d1/United_States_Navy_Band_-_Inno_e_Marcia_Pontificale.ogg";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

const consoleErrors = [];
const failed = [];
const upstream429 = []; // Wikimedia's edge (Varnish) throttles concurrent bursts
const leaks = [];
let ranges206 = 0;

page.on("console", (msg) => {
  if (msg.type() !== "error") return;
  const text = msg.text().slice(0, 300);
  // "Failed to load resource: 429" is the browser reporting an upstream edge
  // throttle — informational, not a proxy defect.
  if (/status of 429/.test(text)) upstream429.push(text.slice(0, 120));
  else consoleErrors.push(text);
});
page.on("requestfailed", (req) => {
  // ERR_ABORTED is a navigation/inertiation abort (e.g. we navigate away from
  // the media phase, aborting the media element's in-flight buffer request) —
  // not a real failure. The E2E spec ignores it too.
  const err = req.failure()?.errorText ?? "";
  if (err === "net::ERR_ABORTED") return;
  failed.push(`${req.method()} ${req.url().slice(0, 140)} :: ${err}`);
});
page.on("response", (res) => {
  if (res.status() === 206) ranges206++;
  // A 429 with retry-after is the upstream edge throttling a burst (site loads
  // ~50 thumbnails concurrently from one IP); it is not a proxy defect. We
  // still report it, but it does not fail the probe.
  if (res.status() === 429) upstream429.push(res.url().slice(0, 120));
  else if (res.status() >= 400) failed.push(`HTTP ${res.status()} ${res.url().slice(0, 140)}`);
});
page.on("request", (req) => {
  const u = req.url();
  // Any direct (unproxied) request to an upstream host leaks.
  if ((u.startsWith("http://") || u.startsWith("https://")) && !u.startsWith(PROXY)) leaks.push(`${req.resourceType()} ${u.slice(0, 140)}`);
});

async function snapshot(label) {
  const stats = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll("a[href]"));
    const proxied = anchors.filter((a) => a.href.startsWith(location.origin + "/") && /^[A-Za-z0-9_-]{10,}$/.test(new URL(a.href).pathname.slice(1))).length;
    return { anchors: anchors.length, anchorsProxied: proxied };
  });
  console.log(`\n[${label}] url=${page.url().slice(0, 90)}`);
  console.log(`  anchors: ${stats.anchorsProxied}/${stats.anchors} proxied`);
  console.log(`  title: ${(await page.title()).slice(0, 60)}`);
  console.log(`  206 responses: ${ranges206}`);
  console.log(`  console errors: ${consoleErrors.length}`);
  console.log(`  failed requests: ${failed.length}`);
  console.log(`  upstream edge 429s (throttling, not proxy): ${upstream429.length}`);
  console.log(`  direct-origin leaks: ${leaks.length}`);
  if (leaks.length) console.log("    " + leaks.slice(0, 8).join("\n    "));
  if (failed.length) console.log("    " + failed.slice(0, 8).join("\n    "));
  return consoleErrors.length === 0 && failed.length === 0 && leaks.length === 0;
}

// 1. Wikimedia audio: Range/206 streaming + decodable media through the proxy.
// Run FIRST so the media fetch isn't in the same burst window as the article's
// ~50-thumbnail load (Wikimedia's edge throttles concurrent bursts from one IP).
const mediaSrc = `${PROXY}/${encodeTarget(MEDIA_URL)}`;
let decode = null;
for (let attempt = 1; attempt <= 3 && !(decode && decode.ok); attempt++) {
  if (attempt > 1) await page.waitForTimeout(2000);
  decode = await page.evaluate(
    (src) =>
      new Promise((resolve) => {
        const a = document.createElement("audio");
        let done = false;
        const finish = (ok, detail) => { if (!done) { done = true; resolve({ ok, detail }); } };
        a.addEventListener("loadedmetadata", () => finish(true, "loadedmetadata"), { once: true });
        a.addEventListener("error", () => finish(false, `audio error ${a.error?.code}`), { once: true });
        a.src = src;
        a.load();
        setTimeout(() => finish(false, "timeout-20s"), 20000);
      }),
    mediaSrc,
  );
  console.log(`  media attempt ${attempt}: ${decode.ok ? "OK" : decode.detail}`);
}
console.log(`\n[media decode] ${decode.ok ? "OK" : "FAIL"} (${decode.detail}) | 206 responses: ${ranges206}`);
let clean = decode.ok && ranges206 >= 1 && consoleErrors.length === 0 && failed.length === 0 && leaks.length === 0;

// 2. Homepage -> submit URL (article load; thumbnails burst here, after media)
await page.goto(PROXY + "/", { waitUntil: "domcontentloaded" });
await page.fill("#url", TARGET);
await page.click("button[type=submit]");
await page.waitForURL(/\/[A-Za-z0-9_-]{10,}/, { timeout: 20000 });
await page.waitForLoadState("domcontentloaded").catch(() => {});
await page.waitForTimeout(4000);
clean = (await snapshot("article loaded")) && clean;

// 2. Click the first proxied in-page anchor and follow it
const clicked = await page.evaluate(() => {
  const a = Array.from(document.querySelectorAll("a[href]")).find(
    (x) => x.href.startsWith(location.origin + "/") && /^[A-Za-z0-9_-]{10,}$/.test(new URL(x.href).pathname.slice(1)),
  );
  if (a) { a.click(); return a.href.slice(0, 120); }
  return null;
});
if (clicked) {
  console.log("\nclicked link:", clicked);
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(3000);
  clean = (await snapshot("after click")) && clean;
}

console.log(`[upstream 429s across all phases] ${upstream429.length} (Wikimedia edge throttling of concurrent loads)`);

console.log(`\n=== PROBE RESULT: ${clean ? "CLEAN" : "ISSUES FOUND"} ===`);
await browser.close();
process.exit(clean ? 0 : 1);
