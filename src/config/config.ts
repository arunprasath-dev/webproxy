import { z } from "zod";

/**
 * Environment-driven configuration for the proxy.
 * All values have safe defaults; override via environment variables.
 */
const envSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3000),
  /** Comma-separated allowed origin hostnames. Empty = allow any public host. */
  ALLOWED_HOSTS: z
    .string()
    .default("")
    .transform((s) => s.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean)),
  ALLOWED_PROTOCOLS: z
    .string()
    .default("http,https")
    .transform((s) => s.split(",").map((p) => p.trim()).filter(Boolean)),
  /** Permit loopback/private targets (testing only — keep false in production). */
  ALLOW_PRIVATE_IPS: z.coerce.boolean().default(false),

  UPSTREAM_CONNECT_TIMEOUT: z.coerce.number().int().positive().default(10000),
  UPSTREAM_REQUEST_TIMEOUT: z.coerce.number().int().positive().default(60000),
  MAX_REWRITE_BODY_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),
  /** Max inbound request body bytes forwarded upstream (Fastify bodyLimit). */
  MAX_BODY_BYTES: z.coerce.number().int().positive().default(1024 * 1024),
  /** JS bodies up to this size are buffered+rewritten; larger stream untouched. */
  MAX_JS_REWRITE_BYTES: z.coerce.number().int().positive().default(16 * 1024 * 1024),
  /** Max entries in the in-memory JS rewrite cache. */
  JS_REWRITE_CACHE_SIZE: z.coerce.number().int().positive().default(128),
  KEEP_ALIVE_MAX: z.coerce.number().int().positive().default(64),
  /** Max simultaneous outbound connections per upstream origin. Mimics a
   *  browser's ~6 connections/host so bursty page loads don't trip upstream
   *  rate limits (e.g. Wikimedia 429s); extra requests queue per origin. */
  UPSTREAM_MAX_CONCURRENCY_PER_ORIGIN: z.coerce.number().int().positive().default(6),
  /** Upstream IP family: auto (happy-eyeballs) | ipv4 | ipv6. Use ipv4 in
   *  environments with broken IPv6 egress (undici can otherwise stall on AAAA). */
  UPSTREAM_IP_FAMILY: z.enum(["auto", "ipv4", "ipv6"]).default("auto"),

  REDIS_URL: z.string().default("redis://127.0.0.1:6379"),
  CACHE_TTL_SECONDS: z.coerce.number().int().nonnegative().default(300),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(120),

  PROXY_PUBLIC_ORIGIN: z.string().default("http://localhost:3000"),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.message}`);
  }
  return parsed.data;
}
