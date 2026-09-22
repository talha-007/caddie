/**
 * Rate limiting.
 *
 * The chat endpoint is public, unauthenticated, and spends money on every
 * call. Without this, one script can run up a bill all afternoon.
 *
 * In memory, so the limits reset on restart and do not hold across instances.
 * That is honest for a pilot; put it in Redis before real traffic.
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

export function consume(key: string, limit: Limit): LimitResult {
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

/** Test seam - also used to keep one test from leaking into the next. */
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
