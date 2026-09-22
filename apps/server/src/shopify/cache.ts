import { log } from '../lib/logger.js';

/**
 * A short-lived cache for catalogue reads.
 *
 * Shopify rate-limits the UCP endpoint hard, and the reply when you trip it is
 * "retry after 3253 seconds" - the best part of an hour with no catalogue at
 * all. Reads are what burn the quota: one outfit fires a search per slot, and
 * a customer saying "cheaper" runs the same searches over again.
 *
 * So identical reads inside a short window are served from here. Prices and
 * stock do not move in sixty seconds, and it cuts the quota, the latency and
 * the bill at once.
 *
 * Carts are never cached. A basket has to be the live one.
 */

interface Entry {
  value: unknown;
  expiresAt: number;
}

const entries = new Map<string, Entry>();
const MAX_ENTRIES = 500;

let hits = 0;
let misses = 0;

export const CATALOG_TTL_MS = 60_000;

function sweep(now: number): void {
  for (const [key, entry] of entries) {
    if (entry.expiresAt < now) entries.delete(key);
  }
  // Still too many after expiry: drop oldest-inserted first.
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

/** Runs `load` unless an identical call was made recently. */
export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = entries.get(key);

  if (hit && hit.expiresAt > now) {
    hits += 1;
    return hit.value as T;
  }

  misses += 1;
  const value = await load();
  entries.set(key, { value, expiresAt: now + ttlMs });
  if (entries.size > MAX_ENTRIES) sweep(now);
  return value;
}

/** Called after a cart change, when what is in stock may have moved. */
export function clearCatalogCache(): void {
  entries.clear();
  log.debug('shopify.cache.cleared');
}

export function cacheStats(): { hits: number; misses: number; size: number } {
  return { hits, misses, size: entries.size };
}

export function resetCacheStats(): void {
  hits = 0;
  misses = 0;
  entries.clear();
}
