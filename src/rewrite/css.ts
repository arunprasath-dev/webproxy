import { rewriteUrl } from "./url.js";

/**
 * Rewrite url(...) and @import in CSS.
 * Handles quoted, unquoted, and data:/fragment forms via rewriteUrl.
 */
export function rewriteCss(css: string, baseUrl: string, proxyOrigin: string): string {
  return css
    .replace(/@import\s+(?:url\(\s*)?(['"]?)([^'")]+)\1\s*\)?\s*;/g, (_m, quote: string, url: string) => {
      return `@import ${quote}${rewriteUrl(url, baseUrl, proxyOrigin)}${quote};`;
    })
    .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/g, (_m, quote: string, url: string) => {
      return `url(${quote}${rewriteUrl(url, baseUrl, proxyOrigin)}${quote})`;
    });
}
