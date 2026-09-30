import type { Product } from './product.js';

/**
 * Smart Cart progress as the widget receives it: worked out by the server
 * from the real cart's trigger properties (apps/server/src/smartCart), never
 * by the widget. Read-only - QUALIFIED means enough triggered units are in
 * the cart, not that SupaEasy has discounted them.
 */

export type SmartCartProgressStatus = 'INACTIVE' | 'IN_PROGRESS' | 'ONE_AWAY' | 'QUALIFIED';

export interface SmartCartOfferView {
  offerId: string;
  name: string;
  status: SmartCartProgressStatus;
  qualifyingUnits: number;
  requiredUnits: number;
  remainingUnits: number;
  /**
   * Whether the offer would lower this basket's price at all, from the lines'
   * own sale prices: true, false (the items already cost the deal price or
   * less - SupaEasy would discount nothing), or null when it could not be
   * told (a price unknown, another currency). Decides only whether a nudge is
   * shown; no figure is ever derived from it.
   */
  worthwhile: boolean | null;
  /** A qualifying product that would make the offer worthwhile can be suggested (POST .../smart-cart/suggest). */
  canSuggest: boolean;
  /** Display-only wording. Never parsed, never used in arithmetic. */
  display?: {
    /** "3 for £59.99" - empty outside a GBP bag: other markets pay their own deal price. */
    deal: string;
    /** "polos" - the short plural, for a button ("Show me polos"). */
    units: string;
    /** "polo", "pair of trousers" - one unit, in a sentence. */
    one: string;
    /** "polos", "pairs of trousers" - several units, in a sentence. */
    many: string;
    /** "Polo deal" - the card's heading. */
    title: string;
  };
}

/** No line keys, variant ids or trigger keys: only what the preview shows. */
export interface SmartCartView {
  offers: SmartCartOfferView[];
  /** When the server worked it out, epoch ms. */
  evaluatedAt: number;
}

/** POST /api/session/:id/basket. `smartCart` is null only when the server has no state for the session. */
export interface BasketSyncResponse {
  ok: boolean;
  lines: number;
  smartCart: SmartCartView | null;
}

/**
 * Sent by a widget whose theme turned the Smart Cart preview on
 * (data-smart-cart-preview): only then does the server stamp offer triggers
 * on the Caddie's own adds. Absent on the live theme.
 */
export const SMART_CART_HEADER = 'x-caddie-smart-cart';
export const SMART_CART_PREVIEW = 'preview';

/** POST /api/session/:id/smart-cart/suggest - qualifying products that would make the offer worthwhile. */
export interface SmartCartSuggestRequest {
  offerId: string;
}

export interface SmartCartSuggestResponse {
  offerId: string;
  /** In stock, qualifying, not already in the basket, and priced so the finished set costs more than the deal - cheapest first. May be empty. */
  products: Product[];
  /** One line to head the cards, e.g. "Polos that complete the 3 for £59.99 offer". No saving is ever named. */
  message: string;
}
