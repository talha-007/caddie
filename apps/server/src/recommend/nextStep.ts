import type { Product } from '@caddie/shared';
import { hasFeature } from '../catalog/attributes.js';
import { rangeOf } from '../catalog/audience.js';
import { allDeals } from '../catalog/bundles.js';
import { productById } from '../catalog/sync.js';
import { searchProducts } from '../shopify/catalog.js';
import type { ShopperProfile } from '../shopper/profile.js';
import { DEFAULT_SLOTS, fitsSlot } from './outfit.js';
import { isPack } from './packs.js';
import { priceFor } from './pricing.js';

/**
 * The one next thing worth offering, decided here rather than improvised.
 *
 * Left to the model, cross-selling was either absent or mechanical - socks
 * led straight to a whole outfit, and "just the jacket" was followed by the
 * trousers anyway. A good salesperson offers the piece that completes what
 * the customer came for, or a saving that is real, and stops when told.
 *
 * So: nothing at all once they have drawn a line ("just the jacket"). A deal
 * only when the pieces they have really are in it, with both prices from
 * Shopify. Otherwise the natural partner of what they are looking at - the
 * waterproof trousers for a waterproof jacket, a bottom for a top - found in
 * stock, in their range, and never something they turned down.
 */

export interface NextStep {
  /** For the model's facts: what to offer, once, and why. */
  line: string;
  productId?: string;
}

function slotOf(product: Product): string | undefined {
  return DEFAULT_SLOTS.find((slot) => fitsSlot(product, slot))?.slot;
}

/** The deal their pieces already go most of the way towards, with verified prices. */
function dealNudge(pieces: Product[]): NextStep | null {
  for (const deal of allDeals()) {
    const covered = deal.steps
      .map((step) => pieces.find((piece) => step.productIds.has(piece.id)))
      .filter((piece): piece is Product => !!piece);
    const distinct = [...new Set(covered)];
    if (distinct.length < 3) continue;
    const price = deal.prices.GBP;
    if (!price) continue;
    const separate = distinct.reduce((sum, piece) => sum + priceFor(piece).amount, 0);
    // Only a saving when the pieces they already want cost more than the whole pack.
    if (separate <= price) continue;
    return {
      line: `Verified saving: ${distinct.length} of these pieces count towards the ${deal.title}, ${deal.steps.length} pieces for £${price}. Bought separately these ${distinct.length} come to £${separate.toFixed(2)}. Mention it once; build it with recommend_pack "${deal.title}".`,
    };
  }
  return null;
}

export async function nextStep(
  focus: Product[],
  context: { profile?: ShopperProfile; basketProductIds?: string[] },
): Promise<NextStep | null> {
  const profile = context.profile ?? {};
  if (profile.justThis) return null;

  const basket = (context.basketProductIds ?? []).map((id) => productById(id)).filter((p): p is Product => !!p);
  const pieces = [...new Map([...basket, ...focus].map((product) => [product.id, product])).values()].filter((p) => !isPack(p));

  const deal = dealNudge(pieces);
  if (deal) return deal;

  const lead = focus[0];
  if (!lead || isPack(lead)) return null;
  const slot = slotOf(lead);
  const range = rangeOf(lead);
  const rangeWord = range === 'women' ? 'ladies' : range === 'kids' ? 'kids' : 'mens';
  const hot = profile.weather?.includes('hot');

  let query: string | null = null;
  let why = '';
  let needs: ((product: Product) => boolean) | null = null;
  if (slot === 'layer' && hasFeature(lead, 'waterproof')) {
    query = `${rangeWord} waterproof trousers`;
    why = 'waterproof trousers to go with a waterproof jacket';
    needs = (product) => hasFeature(product, 'waterproof') && /trouser|pant/i.test(product.title);
  } else if (slot === 'top') {
    query = `${rangeWord} ${hot ? 'shorts' : 'trousers'}`;
    why = `${hot ? 'shorts' : 'trousers'} to go with the top`;
    needs = (product) => slotOf(product) === 'bottom';
  } else if (slot === 'bottom') {
    query = `${rangeWord} polo`;
    why = 'a polo to go with them';
    needs = (product) => slotOf(product) === 'top';
  } else if (slot === 'layer') {
    query = `${rangeWord} polo`;
    why = 'a polo to wear underneath';
    needs = (product) => slotOf(product) === 'top';
  }
  if (!query || !needs) return null;

  const colour = profile.colours?.words.length ? ` ${profile.colours.words[0]}` : '';
  const results = await searchProducts({ query: `${query}${colour}`, limit: 12 });
  const fallback = colour ? await searchProducts({ query, limit: 12 }) : [];
  const exclude = new Set([...pieces.map((p) => p.id), ...(profile.rejected ?? [])]);
  const pick = [...results, ...fallback].find(
    (product) => needs!(product) && !exclude.has(product.id) && rangeOf(product) === range && !isPack(product),
  );
  if (!pick) return null;
  return {
    line: `Natural next piece (offer once, only if it helps what they came for): ${pick.title} [${pick.id}] - ${why}. Do not push it if they have said that is all.`,
    productId: pick.id,
  };
}
