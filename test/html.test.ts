import { describe, expect, it } from "vitest";
import { rewriteHtml } from "../src/rewrite/html.js";

const ORIGIN = "https://proxy.example";
const TARGET = "https://site.example/blog/post";

describe("rewriteHtml", () => {
  it("rewrites absolute links and assets to the proxy origin", () => {
    const html = `<html><head><link rel="stylesheet" href="/style.css"></head>
      <body><a href="/about">About</a><img src="https://cdn.example/i.png"></body></html>`;
    const out = rewriteHtml(html, TARGET, ORIGIN);
    expect(out).toContain("https://proxy.example/");
    expect(out).not.toContain('href="/about"');
    expect(out).not.toContain('src="https://cdn.example/i.png"');
  });

  it("leaves non-http schemes untouched", () => {
    const html = `<a href="mailto:a@b.c">mail</a><img src="data:image/png;base64,AAA"><a href="#frag">f</a>`;
    const out = rewriteHtml(html, TARGET, ORIGIN);
    expect(out).toContain("mailto:a@b.c");
    expect(out).toContain("data:image/png;base64,AAA");
    expect(out).toContain("#frag");
  });

  it("resolves relative URLs against the document URL", () => {
    const html = `<a href="post2">next</a>`;
    const out = rewriteHtml(html, TARGET, ORIGIN);
    const token = out.match(/proxy\.example\/([A-Za-z0-9_-]+)/)?.[1];
    expect(token).toBeTruthy();
    // Recover the original and confirm it resolved to https://site.example/blog/post2
    const decoded = Buffer.from(token!, "base64url").toString();
    expect(decoded).toBe("https://site.example/blog/post2");
  });

  it("injects the bootstrap shim into head", () => {
    const out = rewriteHtml(`<html><head><title>t</title></head><body></body></html>`, TARGET, ORIGIN);
    expect(out).toContain("data-proxy-bootstrap");
  });

  it("rewrites inline style attributes and style blocks", () => {
    const html = `<div style="background:url(/bg.png)"></div><style>.a{background:url(/sprite.png)}</style>`;
    const out = rewriteHtml(html, TARGET, ORIGIN);
    const decoded = [...out.matchAll(/proxy\.example\/([A-Za-z0-9_-]+)/g)].map((m) =>
      Buffer.from(m[1]!, "base64url").toString(),
    );
    // /bg.png and /sprite.png are root-relative -> resolve to the site root.
    expect(decoded).toContain("https://site.example/bg.png");
    expect(decoded).toContain("https://site.example/sprite.png");
  });

  it("rewrites <source> srcset exactly once (no double-encoding)", () => {
    const html = `<picture><source srcset="/a.png 1x, /b.png 2x"><img src="/a.png"></picture>`;
    const out = rewriteHtml(html, TARGET, ORIGIN);
    const tokens = [...out.matchAll(/proxy\.example\/([A-Za-z0-9_-]+)/g)].map((m) => m[1]!);
    // srcset has 2 candidates + the img src = 3 distinct URLs, each encoded once.
    expect(tokens).toHaveLength(3);
    const decoded = tokens.map((t) => Buffer.from(t, "base64url").toString()).sort();
    expect(decoded).toEqual([
      "https://site.example/a.png",
      "https://site.example/a.png",
      "https://site.example/b.png",
    ]);
  });

  it("leaves an already-proxied URL untouched (no re-encode)", () => {
    const already = `${ORIGIN}/aHR0cHM6Ly9zaXRlLmV4YW1wbGUvc3R5bGUuY3Nz`;
    const html = `<link rel="stylesheet" href="${already}"><a href="${already}">x</a>`;
    const out = rewriteHtml(html, TARGET, ORIGIN);
    expect(out).toContain(already);
    const tokens = [...out.matchAll(/proxy\.example\/([A-Za-z0-9_-]+)/g)].map((m) => m[1]!);
    const decoded = tokens.map((t) => Buffer.from(t, "base64url").toString());
    // No token should itself encode a proxy-origin URL (that would be a second level).
    expect(decoded.some((d) => d.includes("proxy.example"))).toBe(false);
  });
});
