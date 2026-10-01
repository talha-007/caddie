import { SMART_CART_OFFERS } from './config.js';
import type { SmartCartLine, SmartCartOfferConfig, SmartCartOfferState, SmartCartProgressStatus, SmartCartState } from './types.js';

/**
 * Whether a line carries an offer's trigger, exactly as SupaEasy tests it:
 * `attribute && attribute.value !== null && attribute.value !== ""`.
 * No trim - a whitespace-only value is not empty to SupaEasy, so it is not
 * empty here, or we would call "not yet" a set checkout has discounted. The
 * theme never writes one. Only a string is a value: BasketSync carries the
 * theme's properties as strings, and anything else did not come from a cart.
 */
export function hasTrigger(line: SmartCartLine, triggerKey: string, matchValue?: string): boolean {
  const value = line.properties?.[triggerKey];
  if (typeof value !== 'string' || value === '') return false;
  // An offer read by its value as well (Ladies & Kids Any 2 Shorts): SupaEasy trims, then compares exactly.
  return matchValue === undefined || value.trim() === matchValue;
}

function unitsOf(line: SmartCartLine): number {
  const quantity = Math.floor(Number(line.quantity));
  return Number.isFinite(quantity) && quantity > 0 ? quantity : 0;
}

export function progressStatus(units: number, threshold: number): SmartCartProgressStatus {
  if (units <= 0) return 'INACTIVE';
  if (units >= threshold) return 'QUALIFIED';
  if (units === threshold - 1) return 'ONE_AWAY';
  return 'IN_PROGRESS';
}

/**
 * Progress towards each offer from the real cart's lines. Quantity is units,
 * whichever lines they sit on. A pack line counts when it carries the trigger
 * - the live any-2 trousers and shorts pages write it on their v4 pack lines -
 * and not otherwise. Each offer reads only its own key: a line with two
 * triggers counts for both, as the separate SupaEasy discounts would.
 * Nothing about the product - name, type, tag, collection - is looked at.
 */
export function evaluateSmartCart(lines: readonly SmartCartLine[], offers: readonly SmartCartOfferConfig[] = SMART_CART_OFFERS, now = Date.now()): SmartCartState {
  return {
    offers: offers.map((offer): SmartCartOfferState => {
      const matched = lines.filter((line) => hasTrigger(line, offer.triggerKey, offer.matchValue) && unitsOf(line) > 0);
      const qualifyingUnits = matched.reduce((sum, line) => sum + unitsOf(line), 0);
      // The saving SupaEasy applied, as the cart reports it under this deal's title - read, never worked out.
      const reported = lines.some((line) => Array.isArray(line.discounts));
      const appliedMinor = reported
        ? matched.reduce((sum, line) => sum + (line.discounts ?? []).filter((d) => d.title === offer.discountTitle).reduce((s, d) => s + (Number.isFinite(d.amount) && d.amount > 0 ? d.amount : 0), 0), 0)
        : null;
      // What the deal's lines cost before it, for the saving as a percentage - only when every line said.
      const beforeMinor = matched.length && matched.every((line) => Number.isFinite(line.originalLinePrice)) ? matched.reduce((sum, line) => sum + (line.originalLinePrice ?? 0), 0) : null;
      return {
        offerId: offer.id,
        triggerKey: offer.triggerKey,
        status: progressStatus(qualifyingUnits, offer.threshold),
        qualifyingUnits,
        requiredUnits: offer.threshold,
        remainingUnits: Math.max(offer.threshold - qualifyingUnits, 0),
        matchedLineKeys: matched.map((line) => line.key),
        matchedVariantIds: [...new Set(matched.map((line) => line.variantId).filter((id): id is string => !!id))],
        appliedMinor,
        beforeMinor,
      };
    }),
    evaluatedAt: now,
  };
}
