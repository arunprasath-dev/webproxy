import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
import _generate from "@babel/generator";
import * as t from "@babel/types";
import { encodeTarget } from "../proxy/scheme.js";
import type { JsRewriteCache } from "./js-cache.js";

/**
 * Server-side JavaScript rewriter.
 *
 * The browser bootstrap cannot intercept everything a modern site does — ES
 * module import/export specifiers, dynamic `import()`, `import.meta.url`, and
 * worker `importScripts()` all resolve against the *proxied* URL and would hit
 * the proxy with a bare (non-token) path. This module rewrites those
 * unambiguous URL positions in the JS source itself, plus absolute http(s)
 * string literals, so every request routes back through the proxy.
 *
 * It is deliberately conservative: relative string literals in ordinary
 * positions are left alone (they are handled at runtime by the bootstrap),
 * because proxying every relative string would corrupt non-URL code.
 */

// @babel/* are CJS packages with a "double default" ESM interop; resolve the
// callable defensively so this works under Node ESM, tsx, and esbuild alike.
type TraverseFn = (ast: t.Node, visitor: Record<string, (path: any) => void>) => void;
type GenerateFn = (ast: t.Node, opts?: object) => { code: string };

const traverse = (
  (_traverse as unknown as { default?: TraverseFn }).default ?? _traverse
) as unknown as TraverseFn;
const generate = (
  (_generate as unknown as { default?: GenerateFn }).default ?? _generate
) as unknown as GenerateFn;

export interface JsRewriteOptions {
  /** How to parse: "script" (classic inline), "module", or auto-detect. */
  sourceType?: "script" | "module" | "unambiguous";
  cache?: JsRewriteCache;
}

// Fast-path: skip the parser entirely for files with no URL/module markers.
const FAST_URL = /https?:\/\//i;
const NEEDS_PARSE = /\bimport\b|\bexport\b|import\.meta|importScripts\s*\(|new\s+URL\s*\(/;

/**
 * Rewrite JS source so URL positions route through the proxy.
 * @param code        The JS source.
 * @param baseUrl     The URL the script is served from (its own origin URL).
 * @param proxyOrigin Public origin of the proxy.
 */
export function rewriteJs(code: string, baseUrl: string, proxyOrigin: string, opts: JsRewriteOptions = {}): string {
  if (!FAST_URL.test(code) && !NEEDS_PARSE.test(code)) return code;
  const cache = opts.cache;
  if (cache) {
    const hit = cache.get(baseUrl, code);
    if (hit !== undefined) return hit;
  }

  let ast: t.File;
  try {
    ast = parse(code, {
      sourceType: opts.sourceType ?? "unambiguous",
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      sourceFilename: baseUrl,
      plugins: [
        "jsx",
        "typescript",
        "topLevelAwait",
        "importAttributes",
        "decorators-legacy",
        "classProperties",
        "classPrivateProperties",
        "classPrivateMethods",
        "dynamicImport",
        "optionalChaining",
        "nullishCoalescingOperator",
        "objectRestSpread",
        "numericSeparator",
        "optionalCatchBinding",
        "privateIn",
        "explicitResourceManagement",
      ],
    });
  } catch {
    // Unparseable (e.g. non-JS served as application/javascript) — pass through.
    return code;
  }

  let changed = false;
  const mark = () => {
    changed = true;
  };
  // import.meta.url replacements are applied after traversal: Babel requeues
  // replaced nodes, which would let the StringLiteral visitor re-rewrite them.
  const metaReplacements: any[] = [];

  traverse(ast, {
    StringLiteral(path: any) {
      const parent = path.parentPath.node;
      // Module specifiers and `new URL()` first args are handled by their own
      // visitors (they may be relative); the importScripts/import() args too.
      if (
        parent.type === "ImportDeclaration" ||
        parent.type === "ExportNamedDeclaration" ||
        parent.type === "ExportAllDeclaration" ||
        (parent.type === "NewExpression" && parent.callee?.name === "URL" && parent.arguments?.[0] === path.node) ||
        (parent.type === "CallExpression" && parent.callee?.type === "Import")
      ) {
        return;
      }
      // Bare string literals: only rewrite absolute http(s) URLs. Relative
      // strings are ambiguous and must be left for the runtime bootstrap.
      if (!/^https?:\/\//i.test(path.node.value)) return;
      const proxied = toProxiedUrl(path.node.value, proxyOrigin);
      if (proxied !== null) {
        setStringValue(path.node, proxied);
        mark();
      }
    },

    TemplateLiteral(path: any) {
      // Plain single-quasi template literal with an absolute URL — same rules
      // as a bare string literal (relative templates are left alone).
      const node = path.node;
      if (node.expressions.length !== 0 || node.quasis.length !== 1) return;
      const parent = path.parentPath.node;
      if (
        (parent.type === "NewExpression" && parent.callee?.name === "URL" && parent.arguments?.[0] === node) ||
        (parent.type === "CallExpression" && parent.callee?.type === "Import")
      ) {
        return;
      }
      const value = node.quasis[0]?.value.cooked ?? "";
      if (!/^https?:\/\//i.test(value)) return;
      const proxied = toProxiedUrl(value, proxyOrigin);
      if (proxied !== null) {
        setStringValue(node, proxied);
        mark();
      }
    },

    CallExpression(path: any) {
      const callee = path.node.callee;
      // Dynamic import('./x.js')
      if (callee.type === "Import") {
        const arg = path.node.arguments[0];
        if (arg && isPlainString(arg)) {
          const proxied = resolveProxy(plainValue(arg), baseUrl, proxyOrigin);
          if (proxied !== null) {
            setStringValue(arg, proxied);
            mark();
          }
        }
        return;
      }
      // importScripts(...) in workers
      if (isImportScriptsCall(callee)) {
        for (const arg of path.node.arguments) {
          if (isPlainString(arg)) {
            const proxied = resolveProxy(plainValue(arg), baseUrl, proxyOrigin);
            if (proxied !== null) {
              setStringValue(arg, proxied);
              mark();
            }
          }
        }
      }
    },

    NewExpression(path: any) {
      const callee = path.node.callee;
      if (callee.type !== "Identifier" || callee.name !== "URL") return;
      const args = path.node.arguments;
      const first = args[0];
      if (!first || !isPlainString(first)) return;
      const base = urlEffectiveBase(args[1], baseUrl);
      const proxied = resolveProxy(plainValue(first), base, proxyOrigin);
      if (proxied !== null) {
        setStringValue(first, proxied);
        mark();
      }
    },

    // import.meta.url -> the file's real (unproxied) URL, so relative
    // resolutions and fetches keep pointing at the true upstream origin.
    MemberExpression(path: any) {
      const node = path.node;
      const obj = node.object;
      if (
        obj.type === "MetaProperty" &&
        obj.meta.name === "import" &&
        obj.property.name === "meta" &&
        node.property.type === "Identifier" &&
        node.property.name === "url"
      ) {
        // When it is the base of `new URL(rel, import.meta.url)`, leave it —
        // the first arg is rewritten to an absolute proxied URL anyway.
        const parent = path.parentPath.node;
        if (
          parent.type === "NewExpression" &&
          parent.callee?.name === "URL" &&
          parent.arguments?.[1] === node
        ) {
          return;
        }
        metaReplacements.push(path);
        mark();
      }
    },

    ImportDeclaration(path: any) {
      rewriteModuleSource(path.node.source);
    },
    ExportNamedDeclaration(path: any) {
      if (path.node.source) rewriteModuleSource(path.node.source);
    },
    ExportAllDeclaration(path: any) {
      rewriteModuleSource(path.node.source);
    },
  });

  // Apply deferred import.meta.url -> file-URL replacements.
  for (const p of metaReplacements) p.replaceWith(t.stringLiteral(baseUrl));

  if (!changed) return code;

  const out = generate(ast, { comments: true, jsescOption: { minimal: true } }).code;
  // Rewriting shifts line numbers; drop stale source map pointers so the
  // browser does not 404 fetching a map that no longer matches.
  const cleaned = out
    .replace(/\/\/[#@]\s*sourceMappingURL=.*$/gm, "")
    .replace(/\/\*[#@]\s*sourceMappingURL=.*?\*\//g, "");

  cache?.set(baseUrl, code, cleaned);
  return cleaned;

  function rewriteModuleSource(source: t.Node): void {
    if (!isPlainString(source)) return;
    const proxied = resolveProxy(plainValue(source), baseUrl, proxyOrigin);
    if (proxied !== null) {
      setStringValue(source, proxied);
      mark();
    }
  }
}

/** Rewrite an inline script fragment (classic or module) against the document base. */
export function rewriteJsFragment(
  text: string,
  baseUrl: string,
  proxyOrigin: string,
  opts: { sourceType?: "script" | "module" | "unambiguous" } = {},
): string {
  return rewriteJs(text, baseUrl, proxyOrigin, { sourceType: opts.sourceType ?? "unambiguous" });
}

// --- helpers ----------------------------------------------------------------

type PlainString = t.StringLiteral | t.TemplateLiteral;

function isPlainString(node: t.Node | null | undefined): node is PlainString {
  if (!node) return false;
  if (node.type === "StringLiteral") return true;
  return node.type === "TemplateLiteral" && node.expressions.length === 0 && node.quasis.length === 1;
}

function plainValue(node: PlainString): string {
  if (node.type === "StringLiteral") return node.value;
  const quasi = node.quasis[0];
  return quasi ? (quasi.value.cooked ?? "") : "";
}

function setStringValue(node: PlainString, value: string): void {
  if (node.type === "StringLiteral") {
    node.value = value;
    // Regenerate with the new literal; keep any original extra metadata.
    node.extra = { ...node.extra, raw: JSON.stringify(value) };
    return;
  }
  const quasi = node.quasis[0];
  if (quasi) {
    quasi.value.raw = value;
    quasi.value.cooked = value;
  }
}

function isImportScriptsCall(callee: t.Node): boolean {
  if (callee.type === "Identifier") return callee.name === "importScripts";
  if (callee.type === "MemberExpression" && !callee.computed) {
    const obj = callee.object;
    const prop = callee.property;
    if (prop.type !== "Identifier" || prop.name !== "importScripts") return false;
    return (obj.type === "Identifier" && obj.name === "self") || obj.type === "ThisExpression";
  }
  return false;
}

function toProxiedUrl(value: string, proxyOrigin: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^(data|javascript|mailto|tel|about|blob|vbscript):/i.test(trimmed)) return null;
  if (trimmed.startsWith("#")) return null;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  return proxyTo(url, proxyOrigin);
}

/** Resolve a (possibly relative) URL against baseUrl and proxy it if http(s). */
function resolveProxy(value: string, baseUrl: string, proxyOrigin: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^(data|javascript|mailto|tel|about|blob|vbscript):/i.test(trimmed)) return null;
  if (trimmed.startsWith("#")) return null;
  let url: URL;
  try {
    url = new URL(trimmed, baseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return proxyTo(url, proxyOrigin);
}

function proxyTo(url: URL, proxyOrigin: string): string | null {
  const base = proxyOrigin.replace(/\/+$/, "");
  // Already routed through the proxy — never double-encode.
  if (url.origin === base) return null;
  return `${base}/${encodeTarget(url.toString())}`;
}

function urlEffectiveBase(baseArg: t.Node | null | undefined, baseUrl: string): string {
  if (baseArg && isPlainString(baseArg)) {
    const base = plainValue(baseArg);
    try {
      return new URL(base, baseUrl).toString();
    } catch {
      return baseUrl;
    }
  }
  return baseUrl;
}
