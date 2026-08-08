import { describe, expect, it } from "vitest";
import { JsRewriteCache } from "../src/rewrite/js-cache.js";

describe("JsRewriteCache", () => {
  it("returns a stored value for the same (url, code) pair", () => {
    const cache = new JsRewriteCache(10);
    expect(cache.get("https://a.com/x.js", "code one")).toBeUndefined();
    cache.set("https://a.com/x.js", "code one", "rewritten");
    expect(cache.get("https://a.com/x.js", "code one")).toBe("rewritten");
    // Different content misses even with the same URL.
    expect(cache.get("https://a.com/x.js", "code two")).toBeUndefined();
  });

  it("keys on the file URL as well as content", () => {
    const cache = new JsRewriteCache(10);
    cache.set("https://a.com/x.js", "code", "a");
    expect(cache.get("https://b.com/x.js", "code")).toBeUndefined();
  });

  it("evicts the least-recently-used entry beyond the size bound", () => {
    const cache = new JsRewriteCache(2);
    cache.set("u1", "c1", "r1");
    cache.set("u2", "c2", "r2");
    expect(cache.get("u1", "c1")).toBe("r1"); // touches u1 -> u1 newest
    cache.set("u3", "c3", "r3"); // evicts u2 (least recently used)
    expect(cache.get("u2", "c2")).toBeUndefined();
    expect(cache.get("u1", "c1")).toBe("r1");
    expect(cache.get("u3", "c3")).toBe("r3");
  });
});
