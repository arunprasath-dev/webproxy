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
});
