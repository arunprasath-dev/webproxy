import { encodeTarget } from "../proxy/scheme.js";

/**
 * Resolve a (possibly relative) URL against a document/base URL, and if it is
 * http(s), return the proxy-routed form. Non-http schemes (mailto:, tel:,
 * data:, javascript:, #fragment) are returned unchanged.
 */
export function rewriteUrl(raw: string, baseUrl: string, proxyOrigin: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return raw;

  // Fragment-only links navigate the same document — never proxy them.
  if (trimmed.startsWith("#")) return raw;

  // Skip schemes we must never proxy.
  if (/^(data|javascript|mailto|tel|about|blob|vbscript):/i.test(trimmed)) return raw;
  // Fragment-only and protocol-relative handled below via URL resolution.

  let resolved: URL;
  try {
    resolved = new URL(trimmed, baseUrl);
  } catch {
    return raw;
  }

  if (resolved.protocol === "http:" || resolved.protocol === "https:") {
    const base = proxyOrigin.replace(/\/+$/, "");
    // Already routed through the proxy — leave it, so we never double-proxy.
    if (resolved.origin === base) return trimmed;
    return `${base}/${encodeTarget(resolved.toString())}`;
  }
  return raw;
}

/** Rewrite each candidate in a srcset attribute, preserving descriptors. */
export function rewriteSrcset(srcset: string, baseUrl: string, proxyOrigin: string): string {
  return srcset
    .split(",")
    .map((entry) => {
      const parts = entry.trim().split(/\s+/);
      const url = parts[0];
      if (!url) return entry;
      const rewritten = rewriteUrl(url, baseUrl, proxyOrigin);
      return [rewritten, ...parts.slice(1)].join(" ");
    })
    .join(", ");
}
