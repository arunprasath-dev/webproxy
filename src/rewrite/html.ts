import * as cheerio from "cheerio";
import { rewriteSrcset, rewriteUrl } from "./url.js";
import { rewriteCss } from "./css.js";
import { rewriteJsFragment } from "./js.js";
import { bootstrapSource } from "../web/bootstrap-source.js";

/** URL-bearing attributes per element type. */
const URL_ATTRS: Record<string, string[]> = {
  a: ["href"],
  area: ["href"],
  link: ["href"],
  script: ["src"],
  img: ["src", "srcset", "data-src", "data-srcset", "data-original"],
  source: ["src", "srcset"], // picture/audio/video sources
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

  // Inline `style` attributes: rewrite url(...) against the document base.
  $("[style]").each((_, el) => {
    const style = $(el).attr("style");
    if (style) $(el).attr("style", rewriteCss(style, baseUrl, proxyOrigin));
  });

  // <style> blocks: rewrite their CSS content.
  $("style").each((_, el) => {
    const css = $(el).html();
    if (css) $(el).html(rewriteCss(css, baseUrl, proxyOrigin));
  });

  // Inline <script> bodies: rewrite absolute http(s) URLs, and (for module
  // scripts) import/export specifiers resolved against the document base. This
  // is what makes dynamic import() and module graphs work through the proxy.
  $("script").each((_, el) => {
    if ($(el).attr("data-proxy-bootstrap") !== undefined) return; // our own shim
    if ($(el).attr("src")) return; // external scripts rewritten by the JS pipeline
    const type = ($(el).attr("type") ?? "").trim().toLowerCase();
    // Skip JSON/template/importmap scripts — those are not executable JS.
    if (type && type !== "module" && !type.includes("javascript") && !type.includes("ecmascript")) return;
    const text = $(el).html();
    if (!text || !text.trim()) return;
    const rewritten = rewriteJsFragment(text, baseUrl, proxyOrigin, {
      sourceType: type === "module" ? "unambiguous" : "script",
    });
    if (rewritten !== text) $(el).html(rewritten);
  });

  injectBootstrap($, proxyOrigin, target);

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

/**
 * Inject the client bootstrap as an inline, synchronous <script> prepended to
 * <head>, so it runs before any upstream script and its API overrides are in
 * place before dynamic code executes. data-base carries the real document URL
 * so the bootstrap can resolve relative URLs against the true upstream base.
 */
function injectBootstrap($: cheerio.CheerioAPI, proxyOrigin: string, target: string): void {
  const escapeAttr = (s: string) => s.replace(/"/g, "&quot;");
  const shim = `<script data-proxy-bootstrap data-origin="${escapeAttr(proxyOrigin)}" data-base="${escapeAttr(target)}">${bootstrapSource}</script>`;
  if ($("head").length) {
    $("head").prepend(shim);
  } else if ($("html").length) {
    $("html").prepend(shim);
  }
}
