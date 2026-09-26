import type { BundleDeal, Money, PackRecommendation, Product } from '@caddie/shared';
import { WEATHER_NEEDS, hasFeature, type Weather } from '../catalog/attributes.js';
import { parseRange, type Range } from '../catalog/audience.js';
import { bestSellerRank } from '../catalog/bestSellers.js';
import { allDeals, type DealRecipe } from '../catalog/bundles.js';
import { garmentName } from '../catalog/colourways.js';
import { matchesColourText } from '../catalog/colour.js';
import { productById } from '../catalog/sync.js';
import { priceFor } from './pricing.js';
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
  // The Ambassador Pack's condition names, said without "Ambassador".
  // "mix condition pack", as it is said, as well as the store's "Mixed Conditions".
  { words: /\bambassador\b|\bwarm rounds?\b|\bmix(ed)? conditions?\b|\bcool\s*(&|and|n)?\s*wet\b/i, match: /ambassador/ },
  { words: /\bprestige\b/i, match: /prestige/ },
  { words: /\brain ?suit|waterproof|rain (jacket|trousers|pants)\b/i, match: /rainsuit|rain-suit/ },
  { words: /\bplayers?\b|\bholiday\b|\bsummer bundle\b/i, match: /players|summer/ },
];

/** Their words name one of the store's deals - "the Ambassador Pack", "mixed conditions". */
export function namesADeal(text: string): boolean {
  return KEYWORDS.some((entry) => entry.words.test(text));
}

/** A bundle asked for without naming one: "any bundles?", "what deals do you have". */
export function asksForDeals(query: string): boolean {
  return /\b(bundles?|deals?|packs?|offers?|multi ?buys?)\b/i.test(query);
}

export function findDeal(query: string, known?: Range, weather?: Weather[]): DealRecipe | null {
  const choice = chooseDeal(query, known, weather);
  return choice && 'deal' in choice ? choice.deal : null;
}

type Condition = NonNullable<DealRecipe['condition']>;

/**
 * The condition a customer's words point at.
 *
 * The pack's own name first ("the mixed conditions pack"), then the weather
 * they describe. "Cool & wet" is checked before "warm" because "not warm"
 * is still cool.
 */
export function conditionFrom(text: string, weather: Weather[] = []): Condition | undefined {
  const lower = text.toLowerCase();
  if (/\bwarm rounds?\b/.test(lower)) return 'warm';
  if (/\bmix(ed)?( conditions?)?\b/.test(lower)) return 'mixed';
  if (/\bcool\s*(&|and|n)?\s*wet\b|\bcoolwet\b/.test(lower)) return 'coolwet';
  const wet = /\b(wet|rain|rainy|showers?|cold|chilly|winter|freezing|frosty?|cool)\b/.test(lower) || weather.includes('wet') || weather.includes('cold');
  const warm = /\b(warm|hot|sun|sunny|sunshine|summer|heat|holiday)\b/.test(lower) || weather.includes('hot');
  const changeable = /\b(changeable|changing|unpredictable|spring|autumn|all[- ]year|all[- ]round|any weather|all weather|bit of everything|uk weather|british weather|windy)\b/.test(lower) || weather.includes('windy');
  if (changeable || (wet && warm)) return 'mixed';
  if (wet) return 'coolwet';
  if (warm) return 'warm';
  return undefined;
}

/**
 * Which deal a request names - or, for a deal that comes in several
 * conditions, the question to ask when nothing says which.
 *
 * The Ambassador Pack is three packs at three prices. Picking the £99.99 one
 * for everybody was the Caddie deciding a customer's weather for them.
 */
export function chooseDeal(
  query: string,
  known?: Range,
  weather?: Weather[],
): { deal: DealRecipe } | { ask: DealRecipe[] } | null {
  const deals = allDeals();
  const keyword = KEYWORDS.find((entry) => entry.words.test(query));
  if (!keyword) return null;
  const named = deals.filter((deal) => keyword.match.test(deal.handle) || keyword.match.test(deal.title.toLowerCase()));
  if (named.length === 0) return null;
  const range: Range = parseRange(query).range ?? known ?? 'men';
  const inRange = named.filter((deal) => deal.range === range);
  const pool = inRange.length ? inRange : named.filter((deal) => deal.range === 'men').length ? named.filter((deal) => deal.range === 'men') : named;

  const byCondition = pool.filter((deal) => deal.condition);
  if (byCondition.length > 1) {
    const condition = conditionFrom(query, weather);
    const match = condition ? byCondition.find((deal) => deal.condition === condition) : undefined;
    if (match) return { deal: match };
    const order: Condition[] = ['warm', 'mixed', 'coolwet'];
    return { ask: [...byCondition].sort((a, b) => order.indexOf(a.condition!) - order.indexOf(b.condition!)) };
  }
  const deal = pool[0];
  return deal ? { deal } : null;
}

export interface FillOptions {
  size?: string;
  colour?: string;
  /** Pieces staying as they are, by step index - a swap rebuilds one step. */
  keep?: Map<number, Product>;
  /** Products that must not come back. */
  exclude?: Iterable<string>;
  /**
   * The weather it is for. Pieces whose own description suits it come first -
   * a waterproof jacket and a warm midlayer for someone who plays in the rain,
   * even inside the Warm Rounds pack when that is the one that can be bought.
   */
  weather?: Weather[];
  /**
   * Designs to move away from, by garment name ("golf tee polo"). Asked to
   * "change the colour of every product", the pack came back as the same
   * polo, midlayer and trousers in white - the customer wanted different
   * pieces, and the store has plenty. Another design comes first; the same
   * one only when nothing else in the step fits.
   */
  avoidDesigns?: Set<string>;
}

function inStock(product: Product): number {
  return product.variants.filter((variant) => variant.available).length;
}

/** One piece per step, or null where nothing in stock fits. */
export function fillDeal(deal: DealRecipe, options: FillOptions = {}): Array<Product | null> {
  const used = new Set<string>([...(options.exclude ?? []), ...[...(options.keep?.values() ?? [])].map((p) => p.id)]);
  const colourScore = (product: Product) => (options.colour ? matchesColourText(product, options.colour) : 0);
  const needs = (options.weather ?? []).flatMap((kind) => WEATHER_NEEDS[kind]);
  /*
   * Suited to the weather: the features its description states, and the cut
   * of it. Shorts are no use in the cold and wet - a Cool & Wet pack went out
   * with shorts in it - and long trousers are the second choice in the heat.
   */
  const cold = (options.weather ?? []).some((kind) => kind === 'cold' || kind === 'wet');
  const hot = (options.weather ?? []).includes('hot');
  const weatherScore = (product: Product) => {
    const title = product.title.toLowerCase();
    const cut = cold && /\b(shorts?|skorts?)\b/.test(title) ? -2 : hot && /\b(trousers?|joggers?)\b/.test(title) ? -1 : 0;
    return needs.filter((feature) => hasFeature(product, feature)).length + cut;
  };
  const fresh = (product: Product) => (options.avoidDesigns?.has(garmentName(product.title)) ? 0 : 1);
  const price = (product: Product) => priceFor(product, options.size).amount;

  // Every step's candidates, best first; kept steps have none - they do not move.
  const lists = deal.steps.map((step, index) => {
    if (options.keep?.get(index)) return [] as Product[];
    return [...step.productIds]
      .map((id) => productById(id))
      .filter((product): product is Product => !!product && inStock(product) > 0 && !used.has(product.id))
      .filter((product) => stockedInSize(product.variants, options.size))
      .sort(
        (a, b) =>
          colourScore(b) - colourScore(a) ||
          fresh(b) - fresh(a) ||
          weatherScore(b) - weatherScore(a) ||
          // What actually sells first - Shopify's own sales rank - not the dearest piece with the most sizes.
          (bestSellerRank(a.id) ?? Number.MAX_SAFE_INTEGER) - (bestSellerRank(b.id) ?? Number.MAX_SAFE_INTEGER) ||
          Math.min(inStock(b), 5) - Math.min(inStock(a), 5) ||
          price(b) - price(a),
      );
  });

  const taken = new Set(used);
  const picks: Array<Product | null> = deal.steps.map((_, index) => {
    const kept = options.keep?.get(index);
    if (kept) return kept;
    const pick = lists[index]!.find((product) => !taken.has(product.id)) ?? null;
    if (pick) taken.add(pick.id);
    return pick;
  });

  /*
   * A pack is a saving: its pieces should be worth more than its price. Led by
   * best sellers alone, Mixed Conditions came to £116 against a £129.99 pack
   * price - no saving, and a harder sell. So, while it is worth less than its
   * price, trade a piece up to a dearer one that is just as good a match -
   * same colour, same freshness, same suitability - the biggest step first.
   * Never a kept piece, never a worse match, and where the store has nothing
   * dearer that fits, it stays as it is.
   */
  const target = deal.prices.GBP ?? 0;
  const worth = () => picks.reduce((sum, piece) => sum + (piece ? price(piece) : 0), 0);
  for (let round = 0; round < deal.steps.length * 3 && target && worth() < target; round += 1) {
    let best: { index: number; product: Product; gain: number } | null = null;
    picks.forEach((current, index) => {
      if (!current || options.keep?.get(index)) return;
      for (const candidate of lists[index]!) {
        if (candidate.id === current.id || taken.has(candidate.id)) continue;
        const asGood =
          colourScore(candidate) >= colourScore(current) &&
          fresh(candidate) >= fresh(current) &&
          weatherScore(candidate) >= weatherScore(current);
        const gain = price(candidate) - price(current);
        if (asGood && gain > 0 && (!best || gain > best.gain)) best = { index, product: candidate, gain };
      }
    });
    if (!best) break;
    const { index, product } = best as { index: number; product: Product; gain: number };
    taken.delete(picks[index]!.id);
    taken.add(product.id);
    picks[index] = product;
  }
  return picks;
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
    ...(deal.format ? { format: deal.format } : {}),
    ...(deal.trigger ? { trigger: deal.trigger } : {}),
    ...(deal.condition ? { condition: deal.condition } : {}),
    ...(deal.conditionTitle ? { conditionTitle: deal.conditionTitle } : {}),
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
      ? // Not "nothing in stock": the store's jackets were in stock, the step pointed at a collection that did not exist.
        `The ${deal.title} is ${deal.steps.length} pieces for £${price.amount}. I couldn't pick a ${missing.join(' or ')} for it just now.${deal.url ? ' That one can be chosen on the pack page.' : ''}`
      : `The ${deal.title} is ${deal.steps.length} pieces for £${price.amount}, one from each step - I have picked one of each for you.${saving}`,
    bundle: toBundleDeal(deal, pieces),
  };
}
