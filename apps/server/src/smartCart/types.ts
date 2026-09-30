/**
 * Smart Cart, read-only (phase 3): how far the real cart has got towards each
 * offer SupaEasy prices at checkout. Progress only - never a price, never a
 * claim that a discount has been applied.
 */

export type SmartCartOfferId = 'any-3-polos' | 'any-2-mens-trousers' | 'any-2-shorts';

import type { SmartCartProgressStatus } from '@caddie/shared';

export type { SmartCartProgressStatus };

export interface SmartCartOfferConfig {
  id: SmartCartOfferId;
  name: string;
  /** The line property SupaEasy reads. Written by the theme; never renamed here. */
  triggerKey: string;
  /** Units needed for one set. */
  threshold: number;
  /** The value stamped with the trigger on the Caddie's own adds - what the theme's own add writes. SupaEasy reads only that it is not empty. */
  triggerValue: string;
  /**
   * Which products the Caddie stamps: the same rule the theme's add path
   * uses - a product tag (polos), or membership of the collections the
   * copied theme's deal pages pick from (trousers, shorts).
   */
  qualifies: { tag: string } | { collections: string[] };
  /**
   * The UK deal price in GBP. Used for one thing only: whether a nudge is
   * worth showing, because SupaEasy discounts nothing when the items already
   * cost the deal price or less. Never shown, never used to work out a
   * saving - the saving is SupaEasy's, read from the cart.
   */
  gatePrice: { amount: number; currency: 'GBP' };
  /** Display-only wording ("3 for £59.99", "polos", "Polo deal"). Never parsed, never used in arithmetic. */
  display?: { deal: string; units: string; one: string; many: string; title: string };
}

export interface SmartCartOfferState {
  offerId: SmartCartOfferId;
  triggerKey: string;
  status: SmartCartProgressStatus;
  /** Units on triggered lines - not capped at the threshold. */
  qualifyingUnits: number;
  requiredUnits: number;
  remainingUnits: number;
  /** Cart line keys carrying the trigger, in cart order. */
  matchedLineKeys: string[];
  /** Their numeric variant ids, deduplicated, when the line reported one. */
  matchedVariantIds: string[];
}

export interface SmartCartState {
  offers: SmartCartOfferState[];
  /** When it was worked out - the basket read it came from may be older than now. */
  evaluatedAt: number;
}

/** What the evaluator reads of a cart line: exactly what BasketSync carries. */
export interface SmartCartLine {
  key: string;
  variantId?: string;
  quantity: number;
  properties?: Record<string, unknown> | null;
}
