import type { Config } from "../config/config.js";
import { NullCache, RedisCache, type Cache } from "./cache.js";

/**
 * Build a cache. Uses Redis when `REDIS_CACHE` is truthy; otherwise a no-op
 * cache so the proxy works without Redis. RedisCache degrades to cache-misses
 * (and never throws) if Redis is unreachable.
 */
export function buildCache(cfg: Config): Cache {
  if (!process.env.REDIS_CACHE) return new NullCache();
  return new RedisCache(cfg.REDIS_URL);
}
