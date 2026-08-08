import { describe, expect, it } from "vitest";
import { OriginGate } from "../src/proxy/upstream.js";

/**
 * Per-origin outbound concurrency gate: caps simultaneous requests per origin
 * (browser-like ~6 connections/host) so bursty page loads don't trip upstream
 * rate limits. Extra requests queue FIFO; idle gates are dropped so the origin
 * map can't grow unboundedly.
 */

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("OriginGate", () => {
  it("runs at most `limit` work items concurrently, queuing the rest FIFO", async () => {
    const parent = new Map<string, OriginGate>();
    const gate = new OriginGate(parent, "https://example.com", 2);

    const inFlight: string[] = [];
    const started: string[] = [];
    const release: Array<() => void> = [];

    const mk = (name: string) => () => {
      started.push(name);
      inFlight.push(name);
      const d = deferred();
      release.push(() => {
        inFlight.splice(inFlight.indexOf(name), 1);
        d.resolve();
      });
      return d.promise;
    };

    const a = gate.run(mk("a"));
    const b = gate.run(mk("b"));
    const c = gate.run(mk("c"));
    const d = gate.run(mk("d"));

    // a and b started immediately; c and d queued.
    expect(started).toEqual(["a", "b"]);
    expect(inFlight.length).toBe(2);

    // Release b -> c is admitted next (FIFO), not d.
    release[1]!();
    await b;
    expect(started).toEqual(["a", "b", "c"]);

    release[0]!();
    release[2]!();
    await Promise.all([a, c]);
    expect(inFlight.length).toBe(1);
    expect(started).toEqual(["a", "b", "c", "d"]);

    release[3]!();
    await d;
    expect(inFlight.length).toBe(0);
  });

  it("propagates rejections and still releases the slot", async () => {
    const gate = new OriginGate(new Map(), "origin", 1);
    await expect(
      gate.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // Slot released: a second run succeeds.
    await expect(gate.run(async () => 42)).resolves.toBe(42);
  });

  it("drops idle gates from the parent map so it can't grow unboundedly", async () => {
    const parent = new Map<string, OriginGate>();
    const gate = new OriginGate(parent, "https://a.example", 2);
    parent.set("https://a.example", gate); // UpstreamClient.fetch does this
    await gate.run(async () => 1);
    await gate.run(async () => 2);
    await gate.run(async () => 3); // queued behind the first two, then drained
    // All three completed; queue empty and active === 0 -> gate removed.
    expect(parent.size).toBe(0);
    // A fresh run on the same origin re-creates it and it cleans up again.
    const gate2 = new OriginGate(parent, "https://a.example", 2);
    parent.set("https://a.example", gate2);
    expect(parent.size).toBe(1);
    await gate2.run(async () => 4);
    expect(parent.size).toBe(0);
  });
});
