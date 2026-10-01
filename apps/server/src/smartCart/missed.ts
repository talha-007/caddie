import type { SmartCartView } from '@caddie/shared';
import { log } from '../lib/logger.js';

/**
 * Baskets that qualify for a deal, where the deal would lower the price, but
 * the cart shows SupaEasy took nothing off - a deal missed. Every one is
 * logged (smart_cart.missed_deal) and counted, so the team hears of it
 * without a customer complaint: a discount switched off, a renamed title, a
 * market without a price, a key the discount does not read.
 *
 * Only judged when the widget reported the cart's discounts, and once per
 * session, deal and unit count, so one basket is not counted on every sync.
 */

const MAX_SEEN = 5000;
const seen = new Set<string>();
const recent: Array<{ at: number; offerId: string; units: number }> = [];
let count = 0;
const since = Date.now();

export function noteMissedDeals(sessionId: string, view: SmartCartView | null, discountsReported: boolean): void {
  if (!view || !discountsReported) return;
  for (const offer of view.offers) {
    if (offer.status !== 'QUALIFIED' || offer.worthwhile !== true || offer.saving) continue;
    const id = `${sessionId}|${offer.offerId}|${offer.qualifyingUnits}`;
    if (seen.has(id)) continue;
    if (seen.size >= MAX_SEEN) seen.clear();
    seen.add(id);
    count += 1;
    recent.unshift({ at: Date.now(), offerId: offer.offerId, units: offer.qualifyingUnits });
    recent.length = Math.min(recent.length, 20);
    log.warn('smart_cart.missed_deal', { sessionId, offerId: offer.offerId, units: offer.qualifyingUnits });
  }
}

export function missedDealsState(): { since: number; count: number; recent: typeof recent } {
  return { since, count, recent: recent.slice() };
}

export function resetMissedDealsForTests(): void {
  seen.clear();
  recent.length = 0;
  count = 0;
}
