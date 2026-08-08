import { describe, expect, it } from "vitest";
import { SseRewriteTransform } from "../src/rewrite/sse.js";

const ORIGIN = "https://proxy.example";
const BASE = "https://site.example/events";

/** Pipe a string through the transform in (optionally) multiple writes. */
async function run(input: string, writes?: number): Promise<string> {
  const t = new SseRewriteTransform(BASE, ORIGIN);
  const out: Buffer[] = [];
  t.on("data", (c) => out.push(c));
  const done = new Promise<void>((resolve, reject) => {
    t.on("end", resolve);
    t.on("error", reject);
  });
  const chunks = writes
    ? Array.from({ length: writes }, (_, i) => input.slice(i, i + 1))
    : [input];
  for (const c of chunks) t.write(c);
  t.end();
  await done;
  return Buffer.concat(out).toString("utf8");
}

const decodeToken = (t: string) => Buffer.from(t, "base64url").toString();

describe("SseRewriteTransform", () => {
  it("rewrites http(s) URLs in data lines and leaves metadata lines alone", async () => {
    const input = [
      "retry: 1000",
      "event: update",
      'data: {"banner":"https://site.example/static/banner.png"}',
      "",
      ": comment",
      "id: 3",
      "data: https://site.example/next",
      "",
    ].join("\n");
    const out = await run(input);
    expect(out).toContain("retry: 1000");
    expect(out).toContain("event: update");
    expect(out).toContain(": comment");
    expect(out).toContain("id: 3");
    expect(out).not.toContain("https://site.example/static/banner.png");
    expect(out).not.toContain("https://site.example/next");
    const tokens = [...out.matchAll(/proxy\.example\/([A-Za-z0-9_-]+)/g)].map((m) => decodeToken(m[1]!));
    expect(tokens).toContain("https://site.example/static/banner.png");
    expect(tokens).toContain("https://site.example/next");
  });

  it("preserves CRLF line endings", async () => {
    const input = "data: https://site.example/a.png\r\n\r\n";
    const out = await run(input);
    expect(out.endsWith("\r\n")).toBe(true);
    expect(out).not.toContain("https://site.example/a.png");
  });

  it("flushes a partial trailing line", async () => {
    const input = 'event: update\ndata: https://site.example/partial.png'; // no trailing newline
    const out = await run(input);
    expect(out).not.toContain("https://site.example/partial.png");
    const token = out.match(/proxy\.example\/([A-Za-z0-9_-]+)/)?.[1];
    expect(decodeToken(token!)).toBe("https://site.example/partial.png");
  });

  it("handles a line split across writes", async () => {
    const input = "data: https://site.example/split.png\n";
    const out = await run(input, input.length + 3);
    const token = out.match(/proxy\.example\/([A-Za-z0-9_-]+)/)?.[1];
    expect(decodeToken(token!)).toBe("https://site.example/split.png");
  });

  it("does not double-encode already-proxied tokens", async () => {
    const already = `${ORIGIN}/aHR0cHM6Ly9zaXRlLmV4YW1wbGUvcC5wbmc`;
    const out = await run(`data: ${already}\n`);
    expect(out).toContain(already);
    const tokens = [...out.matchAll(/proxy\.example\/([A-Za-z0-9_-]+)/g)].map((m) => decodeToken(m[1]!));
    expect(tokens.some((d) => d.includes("proxy.example"))).toBe(false);
  });

  it("leaves non-http data tokens untouched", async () => {
    const out = await run("data: just some text\n");
    expect(out).toBe("data: just some text\n");
  });
});
