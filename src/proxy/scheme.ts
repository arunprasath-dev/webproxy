/**
 * Deterministic proxy URL scheme.
 *
 * A target URL is encoded as base64url(<scheme>://<host>/<path>?<query>#<frag>)
 * and exposed at:  <proxy-origin>/<encoded-target>
 *
 * base64url avoids the ambiguity of embedded "/", "?", "#" and is safe in
 * headers, query strings, and shells. It is reversible and injectable by the
 * client bootstrap at runtime.
 */

const b64 = (input: string): string => Buffer.from(input, "utf8").toString("base64url");
const unb64 = (input: string): string => Buffer.from(input, "base64url").toString("utf8");

/** Parse a raw user-supplied URL into a normalized absolute URL string, or null. */
export function normalizeTarget(raw: string): string | null {
  let s = raw.trim();
  if (s.length === 0) return null;
  // Default to https when no scheme is present (user-friendly input).
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) {
    s = `https://${s}`;
  }
  try {
    const u = new URL(s);
    if (!u.hostname) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** Encode a normalized absolute URL string into the base64url token. */
export function encodeTarget(targetUrl: string): string {
  return b64(targetUrl);
}

/** Decode a base64url token back into the target URL, or null on invalid input. */
export function decodeTarget(token: string): string | null {
  try {
    const s = unb64(token);
    const u = new URL(s);
    if (!u.protocol || !u.hostname) return null;
    return s;
  } catch {
    return null;
  }
}

/** Build a full proxy URL for a target, routed through the proxy origin. */
export function proxyUrl(proxyOrigin: string, targetUrl: string): string {
  const base = proxyOrigin.replace(/\/+$/, "");
  return `${base}/${encodeTarget(targetUrl)}`;
}
