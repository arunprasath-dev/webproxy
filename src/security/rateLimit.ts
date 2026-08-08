/**
 * In-memory fixed-window rate limiter, keyed by client IP.
 * Simple, dependency-free, per-process. For strict multi-node consistency use a
 * shared store (e.g. Redis) — noted in Phase 9 hardening.
 */
export class RateLimiter {
  private readonly window: Map<string, { windowStart: number; count: number }> = new Map();

  constructor(
    private readonly windowMs: number,
    private readonly max: number,
  ) {}

  /** Return true if the key is allowed (not over the limit). */
  allow(key: string): boolean {
    const now = Date.now();
    const cur = this.window.get(key);
    if (!cur || now - cur.windowStart >= this.windowMs) {
      this.window.set(key, { windowStart: now, count: 1 });
      return true;
    }
    cur.count += 1;
    return cur.count <= this.max;
  }

  /** Remaining capacity for the current window (for the Retry-After header). */
  remaining(key: string): number {
    const cur = this.window.get(key);
    if (!cur) return this.max;
    return Math.max(0, this.max - cur.count);
  }

  /** Drop expired entries to bound memory. Call periodically or on size check. */
  sweep(now = Date.now()): void {
    for (const [k, v] of this.window) {
      if (now - v.windowStart >= this.windowMs) this.window.delete(k);
    }
  }
}
