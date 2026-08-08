import { createHash } from "node:crypto";

/**
 * Cookie proxying.
 *
 * All cookies live on the proxy domain. Names are namespaced per target host so
 * browsing multiple sites through one proxy domain never collides or leaks:
 *
 *   original name  ->  c_<hosthash>_<name>
 *
 * On response: rewrite every `Set-Cookie` to scope to the proxy origin
 * (no Domain, Path=/, Secure, SameSite=None) and namespace the name.
 * On request: filter the inbound `Cookie` header to the current host and strip
 * the namespace prefix before forwarding upstream.
 */

const PREFIX = "c_";

function hostHash(host: string): string {
  return createHash("sha256").update(host).digest("hex").slice(0, 10);
}

function namespace(name: string, hash: string): string {
  return `${PREFIX}${hash}_${name}`;
}

function isNamespaced(name: string, hash: string): boolean {
  return name.startsWith(`${PREFIX}${hash}_`);
}

function stripNamespace(name: string, hash: string): string {
  return name.slice(`${PREFIX}${hash}_`.length);
}

/** Rewrite a single Set-Cookie string for the proxy origin. */
export function rewriteSetCookie(raw: string, host: string): string {
  const hash = hostHash(host);
  const parts = raw.split(";").map((p) => p.trim());
  const nameEq = parts[0]!.indexOf("=");
  const name = parts[0]!.slice(0, nameEq > 0 ? nameEq : parts[0]!.length);
  const value = parts[0]!.slice(nameEq + 1);
  parts[0] = `${namespace(name, hash)}=${value}`;

  // Rebuild attributes: force proxy-safe scoping, drop domain.
  const kept: string[] = [parts[0]!];
  const seen = new Set<string>();
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]!;
    const key = part.split("=")[0]!.trim().toLowerCase();
    if (["domain", "expires", "max-age", "samesite", "secure", "httponly", "path"].includes(key)) {
      seen.add(key);
    }
  }
  kept.push("Path=/");
  kept.push("Secure");
  kept.push("SameSite=None");
  if (!seen.has("httponly")) kept.push("HttpOnly");
  // Preserve Max-Age if present (translate to Max-Age, dropping Expires).
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]!;
    const key = part.split("=")[0]!.trim().toLowerCase();
    if (key === "max-age") kept.push(part);
  }
  return kept.join("; ");
}

/** Rewrite a Cookie request header: keep only this host's cookies, un-namespaced. */
export function rewriteCookieHeader(header: string, host: string): string {
  const hash = hostHash(host);
  const pairs = header.split(";").map((p) => p.trim()).filter(Boolean);
  const kept: string[] = [];
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    const name = eq > 0 ? pair.slice(0, eq) : pair;
    const value = eq > 0 ? pair.slice(eq + 1) : "";
    if (!isNamespaced(name, hash)) continue;
    kept.push(`${stripNamespace(name, hash)}=${value}`);
  }
  return kept.join("; ");
}

/** Namespace a fresh cookie name for a host (used by the redirect follower). */
export function namespaceName(name: string, host: string): string {
  return namespace(name, hostHash(host));
}
