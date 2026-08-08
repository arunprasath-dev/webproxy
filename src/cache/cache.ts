import Redis from "ioredis";
import type { Config } from "../config/config.js";

export interface CachedResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
}

export interface Cache {
  get(key: string): Promise<CachedResponse | null>;
  set(key: string, value: CachedResponse, ttlSeconds: number): Promise<void>;
  /** Called once at shutdown. */
  close(): Promise<void>;
}

const PREFIX = "webproxy:cache:";
const keyOf = (k: string) => PREFIX + k;

/** No-op cache used when Redis is unavailable or disabled. */
export class NullCache implements Cache {
  async get(): Promise<CachedResponse | null> {
    return null;
  }
  async set(): Promise<void> {}
  async close(): Promise<void> {}
}

/** Redis-backed shared cache for multi-node deployments. */
export class RedisCache implements Cache {
  private redis: Redis;

  constructor(url: string) {
    this.redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
    // Do not let cache failures break requests.
    this.redis.on("error", () => {});
  }

  async get(key: string): Promise<CachedResponse | null> {
    try {
      const raw = await this.redis.getBuffer(keyOf(key));
      if (!raw) return null;
      return JSON.parse(raw.toString("utf8")) as CachedResponse;
    } catch {
      return null;
    }
  }

  async set(key: string, value: CachedResponse, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.set(keyOf(key), JSON.stringify(value), "EX", Math.max(1, ttlSeconds));
    } catch {
      /* best-effort */
    }
  }

  async close(): Promise<void> {
    await this.redis.quit().catch(() => {});
  }
}
