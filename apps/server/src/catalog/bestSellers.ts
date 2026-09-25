import { env } from '../env.js';
import { fetchWithTimeout } from '../lib/http.js';
import { log } from '../lib/logger.js';
import { authHeader } from '../shopify/storefrontCart.js';

/**
 * What actually sells, in Shopify's own order.
 *
 * "Show me your best picks" needs a ranking that is not ours to invent. The
 * Storefront API sorts the catalogue by BEST_SELLING, which is Shopify's
 * sales data, so best picks are the store's real best sellers - filtered to
 * the customer's range and size by the caller. Read a few pages every few
 * hours: sales rank moves slowly, and this is one query per page, not per
 * customer.
 */

const PAGES = 4; // 1,000 products - more than the active range of any one kind.
let rank = new Map<string, number>();
let loadedAt = 0;

export function bestSellerRank(productId: string): number | undefined {
  return rank.get(productId);
}

export function bestSellersState(): { count: number; loadedAt: number } {
  return { count: rank.size, loadedAt };
}

/** For tests. */
export function setBestSellersForTests(ids: string[]): void {
  rank = new Map(ids.map((id, index) => [id, index]));
  loadedAt = Date.now();
}

export async function loadBestSellers(): Promise<number> {
  if (!env.shopify.storefrontToken) return 0;
  const next = new Map<string, number>();
  let after: string | null = null;
  for (let page = 0; page < PAGES; page += 1) {
    const res = await fetchWithTimeout(`https://${env.shopify.storeDomain}/api/2025-07/graphql.json`, {
      method: 'POST',
      timeoutMs: 20_000,
      label: 'Shopify best sellers',
      headers: { ...authHeader(env.shopify.storefrontToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `query($after: String) { products(first: 250, after: $after, sortKey: BEST_SELLING) { nodes { id } pageInfo { hasNextPage endCursor } } }`,
        variables: { after },
      }),
    });
    if (!res.ok) throw new Error(`best sellers: Storefront API responded ${res.status}`);
    const body = (await res.json()) as {
      data?: { products: { nodes: Array<{ id: string }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
    };
    const products = body.data?.products;
    if (!products) break;
    for (const node of products.nodes) if (!next.has(node.id)) next.set(node.id, next.size);
    if (!products.pageInfo.hasNextPage) break;
    after = products.pageInfo.endCursor;
  }
  if (next.size) {
    rank = next;
    loadedAt = Date.now();
  }
  log.info('bestsellers.loaded', { count: next.size });
  return next.size;
}
