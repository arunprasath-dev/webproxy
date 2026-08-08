import { describe, expect, it } from "vitest";
import { decideCache } from "../src/cache/cacheability.js";

const h = (pairs: [string, string][]) => new Headers(pairs);

describe("decideCache", () => {
  it("caches cacheable GET 200 with default TTL", () => {
    const d = decideCache("GET", 200, h([["content-type", "text/html"]]), "https://a.com/x", 300);
    expect(d.cacheable).toBe(true);
    expect(d.ttlSeconds).toBe(300);
  });

  it("respects s-maxage over max-age and default", () => {
    const d = decideCache("GET", 200, h([["cache-control", "max-age=60, s-maxage=900"]]), "https://a.com/x", 300);
    expect(d.ttlSeconds).toBe(900);
  });

  it("does not cache no-store, Set-Cookie, or non-GET", () => {
    expect(decideCache("GET", 200, h([["cache-control", "no-store"]]), "u", 300).cacheable).toBe(false);
    expect(decideCache("GET", 200, h([["set-cookie", "a=1"]]), "u", 300).cacheable).toBe(false);
    expect(decideCache("POST", 200, h([]), "u", 300).cacheable).toBe(false);
  });

  it("never caches event streams (infinite body would hang buffering)", () => {
    expect(decideCache("GET", 200, h([["content-type", "text/event-stream"]]), "u", 300).cacheable).toBe(false);
    expect(decideCache("GET", 200, h([["content-type", "Text/Event-Stream; charset=utf-8"]]), "u", 300).cacheable).toBe(false);
  });
});
