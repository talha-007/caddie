import type { Product } from '@caddie/shared';
import { collectionProducts } from '../catalog/bundles.js';
import { allProducts, productById } from '../catalog/sync.js';
import { log } from '../lib/logger.js';
import { SMART_CART_OFFERS } from './config.js';
import type { SmartCartOfferConfig } from './types.js';

/**
 * Which offer a product belongs to, by the rule the theme's own add path uses
 * - never by its name. SupaEasy checks nothing about the product: the trigger
 * on the line is the whole test, so whatever the Caddie stamps is discounted.
 * This rule is therefore the only guard, and it is the theme's.
 *
 * Collection membership is read from the Admin API and held here; until it
 * has loaded, a collection offer matches nothing - an unstamped add is full
 * price, which is today's behaviour, never a wrong discount.
 */

const members = new Map<string, Set<string>>();
let loadedAt = 0;

export async function loadSmartCartCollections(offers: readonly SmartCartOfferConfig[] = SMART_CART_OFFERS): Promise<number> {
  const handles = [...new Set(offers.flatMap((offer) => ('collections' in offer.qualifies ? [...offer.qualifies.collections, ...(offer.qualifies.exceptCollections ?? [])] : [])))];
  for (const handle of handles) {
    const ids = await collectionProducts(handle);
    // An empty read (a renamed collection, a failed page) keeps what was held rather than dropping every product from the offer.
    if (ids.size || !members.has(handle)) members.set(handle, ids);
    if (!ids.size) log.warn('smart_cart.collection_empty', { handle });
  }
  loadedAt = Date.now();
  log.info('smart_cart.collections_loaded', { collections: handles.map((handle) => `${handle}:${members.get(handle)?.size ?? 0}`) });
  return handles.length;
}

export function smartCartCollectionsState(): { loadedAt: number; collections: Record<string, number> } {
  return { loadedAt, collections: Object.fromEntries([...members].map(([handle, ids]) => [handle, ids.size])) };
}

export function setSmartCartCollectionsForTests(next: Record<string, string[]>): void {
  members.clear();
  for (const [handle, ids] of Object.entries(next)) members.set(handle, new Set(ids));
  loadedAt = Date.now();
}

export function qualifiesFor(product: Pick<Product, 'id' | 'tags'>, offer: SmartCartOfferConfig): boolean {
  if ('tag' in offer.qualifies) {
    const tag = offer.qualifies.tag.toLowerCase();
    return (product.tags ?? []).some((own) => own.toLowerCase() === tag);
  }
  const inAny = (handles: readonly string[]) => handles.some((handle) => members.get(handle)?.has(product.id) ?? false);
  return inAny(offer.qualifies.collections) && !inAny(offer.qualifies.exceptCollections ?? []);
}

/** The one offer a product is stamped for, if any. A product matching two would be ambiguous: it gets none, and is logged. */
export function offerForProduct(product: Pick<Product, 'id' | 'tags'>, offers: readonly SmartCartOfferConfig[] = SMART_CART_OFFERS): SmartCartOfferConfig | null {
  const matched = offers.filter((offer) => qualifiesFor(product, offer));
  if (matched.length > 1) {
    log.warn('smart_cart.ambiguous_product', { productId: product.id, offers: matched.map((offer) => offer.id) });
    return null;
  }
  return matched[0] ?? null;
}

/** The line properties a Caddie add carries for this product: its offer's trigger, or none. */
export function triggerPropertiesFor(productId: string, offers: readonly SmartCartOfferConfig[] = SMART_CART_OFFERS): Record<string, string> | undefined {
  const product = productById(productId);
  const offer = product ? offerForProduct(product, offers) : null;
  return offer ? { [offer.triggerKey]: offer.triggerValue } : undefined;
}

/** Every product in the mirror that qualifies for the offer. */
export function qualifyingProducts(offer: SmartCartOfferConfig): Product[] {
  return allProducts().filter((product) => qualifiesFor(product, offer));
}
