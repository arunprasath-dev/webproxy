import { describe, expect, it } from "vitest";
import { rewriteJs } from "../src/rewrite/js.js";
import { JsRewriteCache } from "../src/rewrite/js-cache.js";

const PROXY = "http://proxy.test";
const BASE = "https://site.com/app/mod.js";
const decode = (token: string) => Buffer.from(token, "base64url").toString("utf8");
// The first base64url-looking token in the output, decoded.
const firstToken = (out: string): string => {
  const m = /([A-Za-z0-9_-]{10,})/.exec(out);
  return m ? decode(m[1]!) : "";
};

describe("rewriteJs", () => {
  it("rewrites an absolute http(s) string literal", () => {
    const out = rewriteJs('const a = "https://cdn.com/x.js";', BASE, PROXY);
    expect(out).not.toContain("https://cdn.com/x.js");
    expect(firstToken(out)).toBe("https://cdn.com/x.js");
    expect(out).toContain(PROXY + "/");
  });

  it("leaves relative string literals (and non-URL strings) alone", () => {
    const src = 'const a = "/api"; const name = "john"; const b = "foo.png";';
    expect(rewriteJs(src, BASE, PROXY)).toBe(src);
  });

  it("rewrites a plain single-quasi template literal absolute URL", () => {
    const out = rewriteJs("const u = `https://cdn.com/x.js`;", BASE, PROXY);
    expect(out).not.toContain("https://cdn.com/x.js");
    expect(out).toContain(PROXY + "/");
  });

  it("never touches a template literal with expressions", () => {
    const src = "const a = `https://x/${y}`;";
    expect(rewriteJs(src, BASE, PROXY)).toBe(src);
  });

  it("rewrites relative module import specifiers against the file URL", () => {
    const out = rewriteJs('import { helper } from "./lib.js";', BASE, PROXY);
    expect(out).not.toContain("./lib.js");
    expect(firstToken(out)).toBe("https://site.com/app/lib.js");
  });

  it("rewrites side-effect imports and export-from specifiers", () => {
    const out = rewriteJs(
      `import "./side.js";\nexport { a } from "./z.js";\nexport * from "./w.js";`,
      BASE,
      PROXY,
    );
    for (const orig of ["./side.js", "./z.js", "./w.js"]) {
      expect(out).not.toContain(orig);
    }
    const tokens = [...out.matchAll(/([A-Za-z0-9_-]{10,})/g)].map((m) => decode(m[1]!));
    expect(tokens).toContain("https://site.com/app/side.js");
    expect(tokens).toContain("https://site.com/app/z.js");
    expect(tokens).toContain("https://site.com/app/w.js");
  });

  it("rewrites dynamic import() arguments", () => {
    const out = rewriteJs("const p = import('./dyn.js');", BASE, PROXY);
    expect(out).not.toContain("./dyn.js");
    expect(firstToken(out)).toBe("https://site.com/app/dyn.js");
  });

  it("rewrites importScripts args (worker scripts)", () => {
    const classic = rewriteJs('importScripts("dep.js");', BASE, PROXY);
    expect(classic).not.toContain("dep.js");
    const selfForm = rewriteJs('self.importScripts("/a.js", "/b.js");', BASE, PROXY);
    const tokens = [...selfForm.matchAll(/([A-Za-z0-9_-]{10,})/g)].map((m) => decode(m[1]!));
    expect(tokens).toContain("https://site.com/a.js");
    expect(tokens).toContain("https://site.com/b.js");
  });

  it("rewrites the first arg of new URL(rel, import.meta.url) and keeps the base", () => {
    const out = rewriteJs("const u = new URL('./a.png', import.meta.url);", BASE, PROXY);
    expect(out).toContain("import.meta.url"); // base preserved
    expect(out).not.toContain("./a.png");
    expect(firstToken(out)).toBe("https://site.com/app/a.png");
  });

  it("rewrites the first arg of new URL(rel, absBase) against the given base", () => {
    const out = rewriteJs("const u = new URL('../img/x.png', 'https://cdn.com/assets/');", BASE, PROXY);
    expect(firstToken(out)).toBe("https://cdn.com/img/x.png");
  });

  it("replaces standalone import.meta.url with the file URL", () => {
    const out = rewriteJs("const u = import.meta.url;", BASE, PROXY);
    expect(out).toContain(JSON.stringify(BASE));
    expect(out).not.toContain("import.meta.url");
  });

  it("proxies a single-argument new URL('https://abs')", () => {
    const out = rewriteJs("const u = new URL('https://cdn.com/abs/x.js');", BASE, PROXY);
    expect(firstToken(out)).toBe("https://cdn.com/abs/x.js");
  });

  it("does not rewrite data:/javascript:/blob:/already-proxied URLs", () => {
    const src = [
      "const a = 'data:image/png;base64,AAA';",
      "const b = 'javascript:void(0)';",
      "const c = 'blob:null/uuid';",
      `const d = '${PROXY}/aHR0cHM6Ly9zaXRlLmNvbS8';`,
    ].join("\n");
    expect(rewriteJs(src, BASE, PROXY)).toBe(src);
  });

  it("preserves comments when rewriting", () => {
    const src = "// header license\nexport { a } from './z.js'; // keep me";
    const out = rewriteJs(src, BASE, PROXY);
    expect(out).toContain("// header license");
    expect(out).toContain("// keep me");
  });

  it("strips sourceMappingURL comments from rewritten output", () => {
    const out = rewriteJs("export { a } from './z.js';\n//# sourceMappingURL=mod.js.map", BASE, PROXY);
    expect(out).not.toContain("sourceMappingURL");
  });

  it("returns unparseable code unchanged", () => {
    const src = "function broken( { this is not js";
    expect(rewriteJs(src, BASE, PROXY)).toBe(src);
  });

  it("fast-path returns the same reference when nothing to rewrite", () => {
    const src = "const x = 1; console.log(x);";
    expect(rewriteJs(src, BASE, PROXY)).toBe(src);
  });

  it("hits the cache on repeated rewrites of identical input", () => {
    const cache = new JsRewriteCache(10);
    const src = "export { a } from './z.js';";
    const first = rewriteJs(src, BASE, PROXY, { cache });
    const second = rewriteJs(src, BASE, PROXY, { cache });
    expect(second).toBe(first);
    expect(second).toContain(PROXY + "/");
  });
});
