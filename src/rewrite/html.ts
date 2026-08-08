import * as cheerio from "cheerio";
import { rewriteSrcset, rewriteUrl } from "./url.js";

/** URL-bearing attributes per element type. */
const URL_ATTRS: Record<string, string[]> = {
  a: ["href"],
  area: ["href"],
  link: ["href"],
  script: ["src"],
  img: ["src", "srcset", "data-src", "data-srcset", "data-original"],
  source: ["src", "srcset", "srcset"], // picture/audio/video sources
  video: ["src", "poster"],
  audio: ["src"],
  iframe: ["src"],
  frame: ["src"],
  embed: ["src"],
  object: ["data"],
  form: ["action"],
  blockquote: ["cite"],
  q: ["cite"],
  del: ["cite"],
  ins: ["cite"],
  body: ["background"],
  input: ["src"],
  meta: [], // handled specially (http-equiv refresh + og:image etc.)
};

/**
 * Rewrite an HTML document so every resource routes through the proxy.
 * @param html   Raw HTML source.
 * @param target The absolute URL of the fetched document.
 * @param proxyOrigin Public origin of the proxy.
 */
export function rewriteHtml(html: string, target: string, proxyOrigin: string): string {
  const $ = cheerio.load(html, { scriptingEnabled: false });

  const baseUrl = resolveBaseUrl($, target);

  for (const [selector, attrs] of Object.entries(URL_ATTRS)) {
    $(selector).each((_, el) => {
      for (const attr of attrs) {
        const val = $(el).attr(attr);
        if (!val) continue;
        if (attr === "srcset") {
          $(el).attr(attr, rewriteSrcset(val, baseUrl, proxyOrigin));
        } else {
          $(el).attr(attr, rewriteUrl(val, baseUrl, proxyOrigin));
        }
      }
    });
  }

  // <meta http-equiv="refresh" content="0; url=...">
  $('meta[http-equiv]').each((_, el) => {
    const httpEquiv = ($(el).attr("http-equiv") ?? "").toLowerCase();
    if (httpEquiv !== "refresh") return;
    const content = $(el).attr("content") ?? "";
    const m = /url\s*=\s*(.+)/i.exec(content);
    if (m && m[1]) {
      const rewritten = rewriteUrl(m[1].trim().replace(/^['"]|['"]$/g, ""), baseUrl, proxyOrigin);
      $(el).attr("content", content.replace(m[1], rewritten));
    }
  });

  // OpenGraph / twitter image and url meta tags.
  $('meta[property],meta[name]').each((_, el) => {
    const prop = ($(el).attr("property") ?? $(el).attr("name") ?? "").toLowerCase();
    if (/(og:image|og:url|twitter:image|twitter:url)/.test(prop)) {
      const content = $(el).attr("content");
      if (content) $(el).attr("content", rewriteUrl(content, baseUrl, proxyOrigin));
    }
  });

  injectBootstrap($, proxyOrigin);

  return $.html();
}

/** Determine the effective base URL: <base href> wins over the document URL. */
function resolveBaseUrl($: cheerio.CheerioAPI, target: string): string {
  const baseTag = $("base[href]").first().attr("href");
  if (baseTag) {
    try {
      return new URL(baseTag, target).toString();
    } catch {
      /* fall through */
    }
  }
  return target;
}

/** Inject our client bootstrap shim into <head>. Replaced by real bootstrap in Phase 5. */
function injectBootstrap($: cheerio.CheerioAPI, proxyOrigin: string): void {
  void proxyOrigin;
  const shim = `<script data-proxy-bootstrap data-origin="${proxyOrigin.replace(/"/g, "&quot;")}"></script>`;
  if ($("head").length) {
    $("head").prepend(shim);
  } else if ($("html").length) {
    $("html").prepend(shim);
  }
}
