import { describe, expect, it } from "vitest";
import { decodeTarget, encodeTarget, normalizeTarget, proxyUrl } from "../src/proxy/scheme.js";

describe("scheme", () => {
  it("round-trips a full URL with query and fragment", () => {
    const target = "https://example.com/path?q=hello%20world&b=2#frag";
    expect(decodeTarget(encodeTarget(target))).toBe(target);
  });

  it("normalizes a bare host to https", () => {
    expect(normalizeTarget("example.com")).toBe("https://example.com/");
  });

  it("rejects garbage", () => {
    expect(normalizeTarget("")).toBeNull();
    expect(decodeTarget("!!!not-base64url!!!")).toBeNull();
  });

  it("builds a proxy URL", () => {
    const proxy = proxyUrl("https://proxy.example/", "https://a.com/x");
    expect(proxy).toMatch(/^https:\/\/proxy\.example\/[A-Za-z0-9_-]+$/);
    // The token decodes back to the target.
    const token = proxy.split("/").pop()!;
    expect(decodeTarget(token)).toBe("https://a.com/x");
  });
});
