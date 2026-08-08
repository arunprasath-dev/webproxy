import { isIP } from "node:net";

/** IPv4 -> 32-bit unsigned integer. */
function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map((p) => Number(p));
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

/** IPv4 CIDR ranges that must never be contacted (private/reserved/loopback). */
const BLOCKED_IPV4: Array<[number, number]> = [
  [0x00000000, 8], // 0.0.0.0/8
  [0x0a000000, 8], // 10.0.0.0/8
  [0x64400000, 10], // 100.64.0.0/10  CGNAT
  [0x7f000000, 8], // 127.0.0.0/8    loopback
  [0xa9fe0000, 16], // 169.254.0.0/16 link-local + cloud metadata
  [0xac100000, 12], // 172.16.0.0/12
  [0xc0000000, 24], // 192.0.0.0/24
  [0xc0000200, 24], // 192.0.2.0/24  TEST-NET-1
  [0xc0a80000, 16], // 192.168.0.0/16
  [0xc6120000, 15], // 198.18.0.0/15 benchmark
  [0xc6336400, 24], // 198.51.100.0/24 TEST-NET-2
  [0xcb007100, 24], // 203.0.113.0/24 TEST-NET-3
  [0xe0000000, 4], // 224.0.0.0/4 multicast
  [0xf0000000, 4], // 240.0.0.0/4 reserved
  [0xffffffff, 32], // 255.255.255.255
];

function isBlockedIPv4(ip: string): boolean {
  const int = ipv4ToInt(ip);
  for (const [base, prefix] of BLOCKED_IPV4) {
    const mask = ~((1 << (32 - prefix)) - 1) >>> 0;
    if ((int & mask) === (base & mask)) return true;
  }
  return false;
}

/** IPv6 blocked prefixes (as 32-bit words for the parts we compare). */
function isBlockedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true; // loopback, unspecified
  // ULA fc00::/7 -> first group begins fc/fd
  const groups = lower.split(":");
  const first = groups[0] ?? "";
  if (first.startsWith("fc") || first.startsWith("fd")) return true;
  // link-local fe80::/10 -> fe80..febf
  if (first.startsWith("fe8") || first.startsWith("fe9") || first.startsWith("fea") || first.startsWith("feb")) return true;
  return false;
}

/** Return true if the IP must never be contacted. Accepts IPv4 or IPv6. */
export function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isBlockedIPv4(ip);
  if (family === 6) return isBlockedIPv6(ip);
  // Not a parseable IP literal; caller decides (treat as needing DNS check).
  return false;
}
