import type { Product } from '@caddie/shared';
import { productById } from '../catalog/sync.js';
import type { SmartCartOfferConfig, SmartCartOfferState } from './types.js';

/**
 * Whether an offer would lower this basket's price at all.
 *
 * SupaEasy prices from each line's own (sale) price: it takes the triggered
 * units dearest first, in sets, and discounts a set only by what it costs
 * above the deal price. Most Druids stock is already reduced, so a set of two
 * £20 joggers against "2 for £49" saves nothing - and "add 1 more to reach the
 * offer" would be a promise the checkout does not keep.
 *
 * This decides only whether a nudge is shown, and which products may be
 * suggested. It never produces a figure the customer sees: the saving is
 * SupaEasy's, read back from the cart. Worked in pence, from the catalogue's
 * variant prices (the price the line is charged at), UK market only.
 */

export interface OfferValue {
  /** true: the offer lowers the price (or could, with the units still missing); false: it cannot; null: not known. */
  worthwhile: boolean | null;
  /** Qualifying products exist that would make the offer worthwhile. */
  canSuggest: boolean;
  /** The price, in pence, each missing unit must exceed for the set to save anything. Server-side only. */
  floorPence: number | null;
}

export interface PricedLine {
  lineId: string;
  productId: string;
  variantId?: string;
  quantity: number;
}

const pence = (amount: number) => Math.round(amount * 100);
const numeric = (id: string) => String(id).split('/').pop() ?? String(id);

/** The unit price a basket line is charged at, in pence, from the mirror. Null when it cannot be told, or is not in GBP. */
export function unitPence(line: Pick<PricedLine, 'productId' | 'variantId'>): number | null {
  const product = productById(line.productId);
  const variant = line.variantId ? product?.variants.find((entry) => numeric(entry.id) === numeric(line.variantId!)) : undefined;
  if (!variant || variant.price.currency !== 'GBP') return null;
  return pence(variant.price.amount);
}

/** The cheapest in-stock variant of a product, in pence - what a suggestion can be bought at. */
export function cheapestAvailablePence(product: Product): number | null {
  const prices = product.variants.filter((variant) => variant.available && variant.price.currency === 'GBP').map((variant) => pence(variant.price.amount));
  return prices.length ? Math.min(...prices) : null;
}

export function offerValue(
  state: SmartCartOfferState,
  offer: SmartCartOfferConfig,
  basket: readonly PricedLine[],
  currency: string | undefined,
  candidates: readonly Product[],
): OfferValue {
  const unknown: OfferValue = { worthwhile: null, canSuggest: false, floorPence: null };
  if (state.qualifyingUnits <= 0) return { worthwhile: null, canSuggest: false, floorPence: null };
  // Another market prices from its own table; the UK figure says nothing about it.
  if ((currency && currency.toUpperCase() !== offer.gatePrice.currency) || offer.gatePrice.currency !== 'GBP') return unknown;
  const gate = pence(offer.gatePrice.amount);

  const units: number[] = [];
  for (const key of state.matchedLineKeys) {
    const line = basket.find((entry) => entry.lineId === key);
    const price = line ? unitPence(line) : null;
    if (!line || price === null) return unknown;
    for (let i = 0; i < line.quantity; i++) units.push(price);
  }
  units.sort((a, b) => b - a);

  if (units.length >= offer.threshold) {
    // SupaEasy's sets: dearest first, whole sets only. Worth it when any set costs more than the deal.
    let worthwhile = false;
    for (let start = 0; start + offer.threshold <= units.length; start += offer.threshold) {
      const set = units.slice(start, start + offer.threshold).reduce((sum, price) => sum + price, 0);
      if (set > gate) worthwhile = true;
    }
    return { worthwhile, canSuggest: false, floorPence: null };
  }

  const missing = offer.threshold - units.length;
  const held = units.reduce((sum, price) => sum + price, 0);
  // Each missing unit must be priced above this for the finished set to cost more than the deal.
  const floorPence = Math.max(0, Math.floor((gate - held) / missing));
  const best = Math.max(0, ...candidates.map((product) => highestAvailablePence(product) ?? 0));
  const worthwhile = held + best * missing > gate;
  const canSuggest = candidates.some((product) => (cheapestAvailablePence(product) ?? 0) > floorPence);
  return { worthwhile, canSuggest: worthwhile && canSuggest, floorPence };
}

function highestAvailablePence(product: Product): number | null {
  const prices = product.variants.filter((variant) => variant.available && variant.price.currency === 'GBP').map((variant) => pence(variant.price.amount));
  return prices.length ? Math.max(...prices) : null;
}
