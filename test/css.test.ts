import { describe, expect, it } from "vitest";
import { rewriteCss } from "../src/rewrite/css.js";

const ORIGIN = "https://proxy.example";
const TARGET = "https://site.example/assets/app.css";

describe("rewriteCss", () => {
  it("rewrites url() with quotes and relative paths", () => {
    const css = `.a{background:url("../img/bg.png")}`;
    const out = rewriteCss(css, TARGET, ORIGIN);
    expect(out).toContain("https://proxy.example/");
  });

  it("rewrites unquoted url() and @import", () => {
    const css = `@import "fonts.css";.b{background:url(/x.png)}`;
    const out = rewriteCss(css, TARGET, ORIGIN);
    expect(out).toContain("https://proxy.example/");
    // Both rewritten tokens decode to the URLs resolved under https://site.example/
    const decoded = [...out.matchAll(/proxy\.example\/([A-Za-z0-9_-]+)/g)].map((m) =>
      Buffer.from(m[1]!, "base64url").toString(),
    );
    expect(decoded).toContain("https://site.example/assets/fonts.css");
    expect(decoded).toContain("https://site.example/x.png");
  });

  it("leaves data: URIs alone", () => {
    const css = `.a{background:url(data:image/svg+xml;base64,AAA)}`;
    const out = rewriteCss(css, TARGET, ORIGIN);
    expect(out).toContain("data:image/svg+xml;base64,AAA");
  });
});
