import type { SmartCartView } from '@caddie/shared';
import { fromMinorUnits } from '../shopify/money.js';
import { MIN_SAVING_PERCENT, SMART_CART_OFFERS } from './config.js';
import { qualifyingProducts } from './eligibility.js';
import type { SmartCartOfferConfig, SmartCartState } from './types.js';
import { offerValue, type PricedLine } from './value.js';

/**
 * What the widget is sent of the session's Smart Cart state: the progress,
 * whether the offer would lower the price at all, and the offer's display
 * wording - no line keys, variant ids, trigger keys or prices. Null when
 * there is no state yet, never an empty one.
 */
/**
 * The display wording, without the UK deal price when the bag is in another
 * currency: SupaEasy charges each market its own price, so "3 for £59.99" is
 * only true in a GBP bag. The rest of the wording stands.
 */
function displayFor(config: SmartCartOfferConfig, currency: string | undefined): NonNullable<SmartCartOfferConfig['display']> {
  const display = { ...config.display! };
  if (currency && currency.toUpperCase() !== config.gatePrice.currency) display.deal = '';
  return display;
}

export function smartCartView(
  state: SmartCartState | undefined,
  basket: { lines?: readonly PricedLine[]; currency?: string } = {},
  offers: readonly SmartCartOfferConfig[] = SMART_CART_OFFERS,
): SmartCartView | null {
  if (!state) return null;
  return {
    evaluatedAt: state.evaluatedAt,
    offers: state.offers.map((offer) => {
      const config = offers.find((entry) => entry.id === offer.offerId);
      const value = config
        ? offerValue(offer, config, basket.lines ?? [], basket.currency, offer.qualifyingUnits > 0 && offer.status !== 'QUALIFIED' ? qualifyingProducts(config) : [])
        : { worthwhile: null, canSuggest: false };
      // The saving the cart shows, as a percentage of what the lines cost before it - read, never estimated.
      const percent = offer.appliedMinor && offer.beforeMinor ? Math.floor((offer.appliedMinor * 100) / offer.beforeMinor) : null;
      // Once SupaEasy has priced the set, its own figure decides whether it is a deal worth naming, not our estimate.
      const worthwhile = percent !== null ? (offer.appliedMinor! * 100 >= offer.beforeMinor! * MIN_SAVING_PERCENT) : value.worthwhile;
      return {
        offerId: offer.offerId,
        name: config?.name ?? offer.offerId,
        status: offer.status,
        qualifyingUnits: offer.qualifyingUnits,
        requiredUnits: offer.requiredUnits,
        remainingUnits: offer.remainingUnits,
        worthwhile,
        canSuggest: value.canSuggest,
        // What SupaEasy took off, as the cart reports it - only when it took something.
        ...(offer.appliedMinor && basket.currency ? { saving: fromMinorUnits(offer.appliedMinor, basket.currency) } : {}),
        ...(percent !== null ? { savingPercent: percent } : {}),
        ...(config?.display ? { display: displayFor(config, basket.currency) } : {}),
      };
    }),
  };
}
