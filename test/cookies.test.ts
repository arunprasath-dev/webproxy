import { describe, expect, it } from "vitest";
import { rewriteCookieHeader, rewriteSetCookie } from "../src/rewrite/cookies.js";

const HOST = "shop.example";

describe("rewriteSetCookie", () => {
  it("namespaces the name and scopes to the proxy origin", () => {
    const out = rewriteSetCookie("session=abc; Domain=shop.example; Path=/; Secure", HOST);
    expect(out).toMatch(/^c_[a-f0-9]{10}_session=abc/);
    expect(out.toLowerCase()).not.toContain("domain=");
    expect(out.toLowerCase()).toContain("path=/");
    expect(out.toLowerCase()).toContain("samesite=none");
  });
});

describe("rewriteCookieHeader round-trip", () => {
  it("keeps only the current host's cookies and strips the namespace", () => {
    const set = rewriteSetCookie("session=abc; Path=/", HOST);
    const name = set.split("=")[0]!;
    const inbound = `${name}=abc; c_0000000000_other=x`;
    const out = rewriteCookieHeader(inbound, HOST);
    expect(out).toContain("session=abc");
    expect(out).not.toContain("other=x");
    expect(out).not.toContain("c_");
  });
});
