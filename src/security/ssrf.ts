import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { isBlockedIp } from "./ip.js";

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

export interface SsrfOptions {
  allowedProtocols: string[];
  allowedHosts: string[]; // empty = allow any public host
  /** Permit loopback/private targets (testing only). */
  allowPrivate?: boolean;
  /** DNS resolver; injectable for tests. Defaults to node:dns lookup. */
  resolve?: (hostname: string) => Promise<string[]>;
}

const defaultResolve = async (hostname: string): Promise<string[]> =>
  (await lookup(hostname, { all: true })).map((r) => r.address);

/**
 * Guard against SSRF / open-relay abuse.
 * 1. Validate the protocol against the allowlist.
 * 2. If a host allowlist is configured, enforce it.
 * 3. If the host is an IP literal, block it directly if private/reserved.
 * 4. Otherwise resolve DNS and reject if any resolved IP is blocked
 *    (mitigates DNS-rebinding only if the outbound client re-resolves; see Phase 9).
 */
export async function validateTarget(rawUrl: string, opts: SsrfOptions): Promise<void> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new SsrfError("Invalid target URL");
  }

  if (!opts.allowedProtocols.includes(u.protocol.replace(":", ""))) {
    throw new SsrfError(`Protocol not allowed: ${u.protocol}`);
  }

  const host = u.hostname.toLowerCase();
  if (opts.allowedHosts.length > 0 && !opts.allowedHosts.includes(host)) {
    throw new SsrfError(`Host not in allowlist: ${host}`);
  }

  const family = isIP(host);
  if (opts.allowPrivate) return;

  if (family !== 0) {
    // Literal IP — check directly.
    if (isBlockedIp(host)) {
      throw new SsrfError(`Target IP is blocked: ${host}`);
    }
    return;
  }

  // Hostname — resolve and validate every address.
  const resolve = opts.resolve ?? defaultResolve;
  let records: string[];
  try {
    records = await resolve(host);
  } catch {
    throw new SsrfError(`Could not resolve host: ${host}`);
  }
  if (records.length === 0) {
    throw new SsrfError(`Could not resolve host: ${host}`);
  }
  for (const addr of records) {
    if (isBlockedIp(addr)) {
      throw new SsrfError(`Resolved target IP is blocked: ${addr}`);
    }
  }
}
