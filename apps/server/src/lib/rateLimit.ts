import { log } from './logger.js';
import { markRedisDown, redis } from './redis.js';

/**
 * Rate limiting.
 *
 * The chat endpoint is public, unauthenticated, and spends money on every
 * call. Without this, one script can run up a bill all afternoon.
 *
 * Counted in Redis when it is configured, so the limit is the limit however
 * many instances there are - per-instance counters would quietly multiply it
 * by the size of the fleet. In memory otherwise, which is correct for one.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

export interface Limit {
  /** How many requests are allowed in a window. */
  max: number;
  windowMs: number;
}

export interface LimitResult {
  ok: boolean;
  /** Seconds until this key can try again. Only set when blocked. */
  retryAfter?: number;
  remaining: number;
}

const buckets = new Map<string, Bucket>();

/** Stops the map growing without bound on a long-running process. */
function sweep(now: number): void {
  if (buckets.size < 5000) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt < now) buckets.delete(key);
  }
}

function consumeLocal(key: string, limit: Limit): LimitResult {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + limit.windowMs });
    sweep(now);
    return { ok: true, remaining: limit.max - 1 };
  }

  if (bucket.count >= limit.max) {
    return { ok: false, retryAfter: Math.ceil((bucket.resetAt - now) / 1000), remaining: 0 };
  }

  bucket.count += 1;
  return { ok: true, remaining: limit.max - bucket.count };
}

/**
 * Counts in Redis: increment, and set the window on the first one.
 *
 * A fixed window rather than a sliding one. It can let through up to twice the
 * limit across a boundary, which for "stop a script emptying the OpenAI
 * budget" is neither here nor there, and it costs one round trip instead of
 * keeping a sorted set per key.
 */
export async function consumeShared(key: string, limit: Limit): Promise<LimitResult> {
  const client = redis();
  if (!client) return consumeLocal(key, limit);

  const redisKey = `caddie:rate:${key}`;

  try {
    const replies = await client
      .multi()
      .incr(redisKey)
      // NX so an active window is never extended by later requests.
      .expire(redisKey, Math.ceil(limit.windowMs / 1000), 'NX')
      .ttl(redisKey)
      .exec();

    const count = Number(replies?.[0]?.[1] ?? 0);
    const ttl = Number(replies?.[2]?.[1] ?? 0);

    if (count > limit.max) {
      return { ok: false, retryAfter: ttl > 0 ? ttl : Math.ceil(limit.windowMs / 1000), remaining: 0 };
    }
    return { ok: true, remaining: Math.max(0, limit.max - count) };
  } catch (err) {
    // Never let the limiter become the reason a customer cannot shop.
    markRedisDown(err);
    log.warn('ratelimit.redis_failed', { err: String(err) });
    return consumeLocal(key, limit);
  }
}

/** Synchronous, in-process. Kept for tests and the single-instance path. */
export function consume(key: string, limit: Limit): LimitResult {
  return consumeLocal(key, limit);
}

/** Test seam - also keeps one test from leaking into the next. */
export function resetLimits(): void {
  buckets.clear();
}

/**
 * A conversation is maybe a dozen turns. A hundred in an hour from one session
 * is not a customer, and sixty an hour from one address is not a shop floor.
 */
export const LIMITS = {
  perSession: { max: 40, windowMs: 60 * 60 * 1000 },
  perAddress: { max: 120, windowMs: 60 * 60 * 1000 },
  /** Voice costs more per request, so it gets its own, tighter, budget. */
  voicePerSession: { max: 30, windowMs: 60 * 60 * 1000 },
} as const satisfies Record<string, Limit>;
