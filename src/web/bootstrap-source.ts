import { readFileSync } from "node:fs";

// The bundled server lives in dist/ while tsup copies the web assets to
// dist/web/, so the file is at "./bootstrap.js" in dev (this module is inside
// src/web/) but at "./web/bootstrap.js" in the built bundle. Try both.
const raw = (() => {
  for (const u of [new URL("./bootstrap.js", import.meta.url), new URL("./web/bootstrap.js", import.meta.url)]) {
    try {
      return readFileSync(u, "utf8");
    } catch {
      /* try next location */
    }
  }
  throw new Error("bootstrap.js not found next to " + import.meta.url);
})();

/**
 * The client bootstrap source, made safe to inline into an HTML `<script>`
 * tag. In text/html the parser scans for `</script` (case-insensitive) outside
 * any JS context, so any occurrence inside our own source is escaped as
 * `<\/script` (valid inside JS strings/comments/regexes). `<!--` is escaped the
 * same way so the HTML parser never enters comment data. The bootstrap is
 * authored to avoid both sequences, so this is defensive.
 */
export const bootstrapSource = raw
  .replace(/<!--/g, "<\\!--")
  .replace(/<\/script/gi, "<\\/script");
