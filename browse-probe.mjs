import { chromium } from "@playwright/test";

const PROXY = "http://localhost:3000";
const TARGET = process.argv[2] || "https://en.wikipedia.org/wiki/Web_proxy";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

const consoleErrors = [];
const failed = [];
let subresourceOk = 0;

page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 300));
});
page.on("requestfailed", (req) => failed.push(`${req.method()} ${req.url().slice(0, 140)} :: ${req.failure()?.errorText}`));
page.on("response", (res) => {
  if (res.status() >= 400) failed.push(`HTTP ${res.status()} ${res.url().slice(0, 140)}`);
  else subresourceOk++;
});

async function snapshot(label) {
  const stats = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll("a[href]"));
    const proxied = anchors.filter((a) => a.href.startsWith(location.origin + "/") && /^[A-Za-z0-9_-]{10,}$/.test(new URL(a.href).pathname.slice(1))).length;
    const assets = Array.from(document.querySelectorAll("link[href],script[src],img[src]"));
    const assetsProxied = assets.filter((a) => (a.href || a.src).startsWith(location.origin + "/")).length;
    return { anchors: anchors.length, anchorsProxied: proxied, assets: assets.length, assetsProxied };
  });
  console.log(`\n[${label}] url=${page.url().slice(0, 90)}`);
  console.log(`  anchors: ${stats.anchorsProxied}/${stats.anchors} proxied | assets: ${stats.assetsProxied}/${stats.assets} proxied`);
  console.log(`  title: ${(await page.title()).slice(0, 60)}`);
  console.log(`  subresource ok responses: ${subresourceOk}`);
  console.log(`  console errors: ${consoleErrors.length}`);
  console.log(`  failed requests (${failed.length}):`);
  failed.slice(0, 10).forEach((f) => console.log("    - " + f));
}

// 1. Homepage -> submit URL
await page.goto(PROXY + "/", { waitUntil: "domcontentloaded" });
await page.fill("#url", TARGET);
await page.click("button[type=submit]");
await page.waitForURL(/\/[A-Za-z0-9_-]{10,}/, { timeout: 20000 });
await page.waitForLoadState("domcontentloaded").catch(() => {});
await page.waitForTimeout(4000);
await snapshot("article loaded");

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
  await snapshot("after click");
}

await browser.close();
process.exit(0);
