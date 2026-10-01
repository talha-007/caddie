import type { SmartCartOfferView, SmartCartView } from '@caddie/shared';
import { formatMoney } from './format.js';

/**
 * Smart Cart preview wording, from the progress the server worked out. The
 * widget never counts triggers or reads product names itself, and never says
 * a discount has been applied or unlocked, or what anything saves: QUALIFIED
 * means only that enough triggered units are in the cart, and the price is
 * SupaEasy's, at checkout (Smart Cart phase 4).
 *
 * Written for a customer: a deal to finish, how far along they are, and one
 * sentence saying what is left - never a status code.
 */

export interface SmartCartLine {
  offerId: string;
  status: SmartCartOfferView['status'];
  /** "Any 3 Polos" - the deal's own name */
  title: string;
  /** "3 for £59.99" */
  deal: string;
  /** "Choose any 2 more polos to complete the deal" - any qualifying item counts, which is the point of the deal */
  message: string;
  /** Under a qualified basket: where the price is decided. */
  note?: string;
  /** Units held and needed, for the dots. Held never passes needed. */
  filled: number;
  total: number;
  /** One away: the moment worth the stronger look. */
  close: boolean;
  /** "Show me polos" - offered when a qualifying product would make the deal worthwhile. */
  suggestLabel?: string;
}

export const QUALIFIED_NOTE = 'The deal price is worked out at checkout.';

function wording(offer: SmartCartOfferView) {
  return {
    title: offer.display?.title ?? offer.name,
    deal: offer.display?.deal ?? '',
    units: offer.display?.units ?? 'items',
    one: offer.display?.one ?? 'item',
    many: offer.display?.many ?? 'items',
  };
}

/**
 * The deals worth showing, in the server's order; none is picked as the main
 * one. An inactive deal shows nothing - and nor does one the server found
 * would not lower the price (worthwhile: false): most Druids stock is already
 * reduced, and two £20 joggers against "2 for £49" save nothing, so "add 1
 * more" would promise what the checkout will not do. Where it could not tell
 * (null), the neutral wording stands.
 */
export function smartCartLines(view: SmartCartView | null | undefined): SmartCartLine[] {
  if (!view) return [];
  return view.offers
    // A saving the cart shows is always worth showing, whatever the price check thought.
    .filter((offer) => offer.status !== 'INACTIVE' && offer.qualifyingUnits > 0 && (offer.worthwhile !== false || !!offer.saving))
    .map((offer) => {
      const words = wording(offer);
      const left = offer.remainingUnits;
      const qualified = offer.status === 'QUALIFIED';
      const close = offer.status === 'ONE_AWAY';
      // Applied: the saving the cart shows SupaEasy took off, never one worked out here.
      const applied = qualified && offer.saving && offer.saving.amount > 0 ? offer.saving : null;
      const message = applied
        ? `Deal applied · you save ${formatMoney(applied)}`
        : qualified
          ? `Your ${words.many} qualify for ${words.deal || 'this deal'}`
          : `Choose any ${left} more ${left === 1 ? words.one : words.many} to complete the deal`;
      return {
        offerId: offer.offerId,
        status: offer.status,
        title: words.title,
        deal: words.deal,
        message,
        ...(qualified && !applied ? { note: QUALIFIED_NOTE } : {}),
        filled: Math.min(offer.qualifyingUnits, offer.requiredUnits),
        total: offer.requiredUnits,
        close,
        ...(!qualified && offer.canSuggest ? { suggestLabel: `Show me ${words.units}` } : {}),
      };
    });
}

/**
 * The state to keep when a basket sync answers. Sync replies can arrive out
 * of order (a theme change and a turn both sync), so an older evaluation
 * never replaces a newer one; no answer - a failed sync - keeps what we had.
 */
export function newerSmartCart(current: SmartCartView | null, next: SmartCartView | null | undefined): SmartCartView | null {
  if (!next) return current;
  if (current && next.evaluatedAt < current.evaluatedAt) return current;
  return next;
}

/** A tester's line (data-smart-cart-debug only): status, triggered units, the price check - never a key or an id. */
export function smartCartDebug(offer: SmartCartOfferView): string {
  const worth = offer.worthwhile === null ? 'unknown' : offer.worthwhile ? 'yes' : 'no - hidden';
  return `${offer.name}: ${offer.status} · Triggered ${offer.qualifyingUnits} / ${offer.requiredUnits} · Lowers price: ${worth}`;
}

/** Offers the debug section lists: every one with a triggered unit, shown or hidden - so a hidden nudge can be told from a missing one. */
export function smartCartDebugOffers(view: SmartCartView | null | undefined): SmartCartOfferView[] {
  return (view?.offers ?? []).filter((offer) => offer.qualifyingUnits > 0);
}

export function evaluatedTime(view: SmartCartView, locale?: string): string {
  return new Date(view.evaluatedAt).toLocaleTimeString(locale ?? 'en-GB', { hour12: false });
}
