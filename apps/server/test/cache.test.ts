import { describe, expect, it, beforeEach } from 'vitest';
import { cached, CATALOG_TTL_MS, cacheStats, clearCatalogCache, resetCacheStats } from '../src/shopify/cache.js';

/**
 * Shopify's limit on the catalogue endpoint is measured in hours - trip it and
 * the reply is "retry after 3253 seconds". Not asking twice is the defence.
 */

describe('catalogue cache', () => {
  beforeEach(() => resetCacheStats());

  it('asks Shopify once for an identical search', async () => {
    let calls = 0;
    const load = async () => {
      calls += 1;
      return { products: ['polo'] };
    };

    await cached('search:navy polo', CATALOG_TTL_MS, load);
    await cached('search:navy polo', CATALOG_TTL_MS, load);
    await cached('search:navy polo', CATALOG_TTL_MS, load);

    expect(calls).toBe(1);
    expect(cacheStats().hits).toBe(2);
  });

  it('keeps different searches apart', async () => {
    let calls = 0;
    const load = async () => {
      calls += 1;
      return calls;
    };

    expect(await cached('a', CATALOG_TTL_MS, load)).toBe(1);
    expect(await cached('b', CATALOG_TTL_MS, load)).toBe(2);
    expect(await cached('a', CATALOG_TTL_MS, load)).toBe(1);
    expect(calls).toBe(2);
  });

  it('asks again once the entry is stale', async () => {
    let calls = 0;
    const load = async () => {
      calls += 1;
      return calls;
    };

    await cached('c', 1, load);
    await new Promise((r) => setTimeout(r, 5));
    await cached('c', 1, load);
    expect(calls).toBe(2);
  });

  it('drops everything when a cart changes, since stock may have moved', async () => {
    let calls = 0;
    const load = async () => {
      calls += 1;
      return calls;
    };

    await cached('d', CATALOG_TTL_MS, load);
    clearCatalogCache();
    await cached('d', CATALOG_TTL_MS, load);
    expect(calls).toBe(2);
  });
});
