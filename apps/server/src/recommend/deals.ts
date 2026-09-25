import type { BundleDeal, Money, PackRecommendation, Product } from '@caddie/shared';
import { parseRange, type Range } from '../catalog/audience.js';
import { allDeals, type DealRecipe } from '../catalog/bundles.js';
import { matchesColourText } from '../catalog/colour.js';
import { productById } from '../catalog/sync.js';
import { stockedInSize } from './sizeWords.js';

/**
 * Filling one of the store's real bundle deals.
 *
 * A deal is a list of steps - jacket, midlayer, polo and so on - each with
 * its own collection, and one fixed price for the lot. So the Caddie's job is
 * the shopper's job on the deal page: one good piece per step. What "good"
 * means, in order: the colour they asked for, their size in stock, stocked in
 * plenty of sizes (so a swap of size is possible), and then the dearer piece -
 * the price is fixed, so a £65 jacket and a £30 one cost the same inside the
 * pack, and that is the whole point of the deal.
 */

/** Which deal a request names. Keywords, then the range, then the main range. */
const KEYWORDS: Array<{ words: RegExp; match: RegExp }> = [
  { words: /\bambassador\b/i, match: /ambassador/ },
  { words: /\bprestige\b/i, match: /prestige/ },
  { words: /\brain ?suit|waterproof|rain (jacket|trousers|pants)\b/i, match: /rainsuit|rain-suit/ },
  { words: /\bplayers?\b|\bholiday\b|\bsummer bundle\b/i, match: /players|summer/ },
];

/** A bundle asked for without naming one: "any bundles?", "what deals do you have". */
export function asksForDeals(query: string): boolean {
  return /\b(bundles?|deals?|packs?|offers?|multi ?buys?)\b/i.test(query);
}

export function findDeal(query: string, known?: 'men' | 'women'): DealRecipe | null {
  const deals = allDeals();
  const keyword = KEYWORDS.find((entry) => entry.words.test(query));
  if (!keyword) return null;
  const named = deals.filter((deal) => keyword.match.test(deal.handle) || keyword.match.test(deal.title.toLowerCase()));
  if (named.length === 0) return null;
  const range: Range = parseRange(query).range ?? known ?? 'men';
  return named.find((deal) => deal.range === range) ?? named.find((deal) => deal.range === 'men') ?? named[0] ?? null;
}

export interface FillOptions {
  size?: string;
  colour?: string;
  /** Pieces staying as they are, by step index - a swap rebuilds one step. */
  keep?: Map<number, Product>;
  /** Products that must not come back. */
  exclude?: Iterable<string>;
}

function inStock(product: Product): number {
  return product.variants.filter((variant) => variant.available).length;
}

/** One piece per step, or null where nothing in stock fits. */
export function fillDeal(deal: DealRecipe, options: FillOptions = {}): Array<Product | null> {
  const used = new Set<string>([...(options.exclude ?? []), ...[...(options.keep?.values() ?? [])].map((p) => p.id)]);
  return deal.steps.map((step, index) => {
    const kept = options.keep?.get(index);
    if (kept) return kept;
    const candidates = [...step.productIds]
      .map((id) => productById(id))
      .filter((product): product is Product => !!product && inStock(product) > 0 && !used.has(product.id))
      .filter((product) => stockedInSize(product.variants, options.size));
    const colourScore = (product: Product) => (options.colour ? matchesColourText(product, options.colour) : 0);
    candidates.sort(
      (a, b) =>
        colourScore(b) - colourScore(a) ||
        Math.min(inStock(b), 5) - Math.min(inStock(a), 5) ||
        b.price.amount - a.price.amount,
    );
    const pick = candidates[0] ?? null;
    if (pick) used.add(pick.id);
    return pick;
  });
}

export function dealPrice(deal: DealRecipe, currency: string): Money {
  return { amount: deal.prices[currency] ?? deal.prices.GBP ?? 0, currency: deal.prices[currency] ? currency : 'GBP' };
}

/** The deal as the widget and the cart need it. */
export function toBundleDeal(deal: DealRecipe, pieces: Array<Product | null>): BundleDeal {
  return {
    handle: deal.handle,
    title: deal.title,
    prices: deal.prices,
    dynamicPrices: deal.dynamicPrices,
    steps: deal.steps.map((step, index) => ({ title: step.title, productId: pieces[index]?.id ?? null })),
    url: deal.url,
  };
}

export function dealRecommendation(deal: DealRecipe, pieces: Array<Product | null>, currency: string): PackRecommendation {
  const price = dealPrice(deal, currency);
  const filled = pieces.filter((piece): piece is Product => piece !== null);
  const worth = filled.reduce((sum, piece) => sum + piece.price.amount, 0);
  const missing = deal.steps.filter((_, index) => !pieces[index]).map((step) => step.title.toLowerCase());
  const saving = worth > price.amount ? ` Bought separately these come to £${worth.toFixed(2)}.` : '';
  return {
    items: filled,
    total: price,
    overBudget: false,
    reason: missing.length
      ? `The ${deal.title} is ${deal.steps.length} pieces for £${price.amount}. Nothing in stock fits the ${missing.join(' and ')} step right now, so choose that one on the deal page.`
      : `The ${deal.title} is ${deal.steps.length} pieces for £${price.amount}, one from each step - I have picked one of each for you.${saving}`,
    bundle: toBundleDeal(deal, pieces),
  };
}
