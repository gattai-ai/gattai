import type { Context, Env, MiddlewareHandler } from "hono";
import { env } from "../env";
import { errorBody } from "../lib/http";
import type { AppEnv } from "../types";

/**
 * Rate limiting in-memory (fixed window) untuk perlindungan penyalahgunaan.
 * Bukan kuota bisnis yang presisi: single-instance (cocok dengan desain sesi
 * dan bus event yang juga in-memory), batas murah hati, gagal-terbuka bila
 * dimatikan via max <= 0.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions<E extends Env = Env> {
  /** Panjang jendela dalam ms. */
  windowMs: number;
  /** Maksimum request per jendela per kunci. <= 0 menonaktifkan. */
  max: number;
  /** Kunci bucket (mis. per IP atau per project). */
  key: (c: Context<E>) => string;
  /** Pesan error 429. */
  message?: string;
}

const MAX_BUCKETS = 10000;

export function createRateLimiter<E extends Env = Env>(
  options: RateLimitOptions<E>,
): MiddlewareHandler<E> {
  const buckets = new Map<string, Bucket>();

  return async (c, next) => {
    if (options.max <= 0 || c.req.method === "OPTIONS") {
      await next();
      return;
    }

    const now = Date.now();
    const bucketKey = options.key(c);
    let bucket = buckets.get(bucketKey);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + options.windowMs };
      buckets.set(bucketKey, bucket);
      if (buckets.size > MAX_BUCKETS) {
        for (const [key, value] of buckets) {
          if (value.resetAt <= now) buckets.delete(key);
          if (buckets.size <= MAX_BUCKETS / 2) break;
        }
      }
    }

    bucket.count += 1;
    if (bucket.count > options.max) {
      const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      return c.json(
        errorBody(
          "RATE_LIMITED",
          options.message ?? "Too many requests. Try again shortly.",
          { retry_after_ms: retryAfterSec * 1000 },
        ),
        429,
        { "Retry-After": String(retryAfterSec) },
      );
    }

    await next();
  };
}

/**
 * Kunci per IP klien dari `X-Forwarded-For`.
 *
 * Entri diambil dari **kanan** (`TRUSTED_PROXY_HOPS`, default 1), bukan paling
 * kiri: proxy terpercaya menambahkan alamat peer yang benar-benar terhubung,
 * sedangkan entri paling kiri bisa dikirim klien (`X-Forwarded-For: <palsu>`)
 * dan dipakai memutar batas rate limit. `X-Real-IP` dipakai sebagai cadangan.
 */
export function ipKey(c: Context): string {
  const hops = env.trustedProxyHops;
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    const parts = forwarded
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    const candidate = parts[parts.length - hops] ?? parts[parts.length - 1];
    if (candidate) return `ip:${candidate}`;
  }
  const realIp = c.req.header("x-real-ip")?.trim();
  return `ip:${realIp && realIp.length > 0 ? realIp : "direct"}`;
}

/** Limiter pembuatan run per project (setelah `requireProject`). */
export function projectRunsLimiter(windowMs: number, max: number): MiddlewareHandler<AppEnv> {
  return createRateLimiter<AppEnv>({
    windowMs,
    max,
    key: (c) => `project:${c.get("project").id}`,
    message: "Too many run creations. Try again shortly.",
  });
}
