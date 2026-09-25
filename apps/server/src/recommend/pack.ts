import type { Money, PackInput, PackRecommendation, Product } from '@caddie/shared';
import { parseRange } from '../catalog/audience.js';
import { matchesColourText } from '../catalog/colour.js';
import { searchProducts } from '../shopify/catalog.js';
import { storeCurrency } from '../shopify/money.js';
import { isPack } from './packs.js';
import { priceFor, totalFor } from './pricing.js';
import { stockedInSize } from './sizeWords.js';

/**
 * Day 5 - Ambassador Pack.
 *
 * We ask Shopify MCP for candidates, then WE choose which ones make the pack
 * and what the total is. The AI never assembles the list or adds up prices.
 */

const DEFAULT_ITEM_COUNT = 3;

/**
 * What to search when the customer's own words find nothing.
 *
 * The catalogue index matches literal words, so "a pack of basic clothing"
 * came back with nothing at all - no product has "basic" in its name - and the
 * customer was told we had nothing under their budget when we had plenty. It
 * was intermittent because it depended on which words the model picked out of
 * the conversation: "golf kit" found six products, "basic clothing" none.
 *
 * A pack does not actually need the phrasing to match. It needs garments
 * inside a budget, and the query is a refinement rather than a requirement.
 * These are the Druids range as stocked, the same list the outfit slots in
 * `outfit.ts` are built from - re-check both when the real store lands.
 */
const RANGE_TERMS = 'polo shirt tee hoodie midlayer gilet jacket shorts trousers';

/*
 * Through colour.ts, which reads the title and Colour option only. This used
 * to search tags and descriptions, where the store's "blue" campaign tag sits
 * on orange polos and descriptions name other garments' colours.
 */
function matchesColour(product: Product, colour?: string): boolean {
  return matchesColourText(product, colour) > 0;
}

function hasSize(product: Product, size?: string): boolean {
  return stockedInSize(product.variants, size);
}

/**
 * Priced at the size the customer is actually buying, not at the cheapest
 * variant. `product.price` is Shopify's minimum, and adding minimums up gave
 * a total that could not be checked out at.
 */
function sum(products: Product[], size?: string): Money & { exact: boolean } {
  return totalFor(products, size, storeCurrency());
}

/**
 * Greedy fill: take the best-ranked candidates that keep us inside budget,
 * then top up with the cheapest remaining ones if we are short on items.
 */
function fillWithinBudget(
  candidates: Product[],
  itemCount: number,
  budget?: Money,
  size?: string,
): Product[] {
  // What this customer pays, at their size where we know it.
  const cost = (product: Product) => priceFor(product, size).amount;

  if (!budget) return candidates.slice(0, itemCount);

  const chosen: Product[] = [];
  let spend = 0;

  for (const product of candidates) {
    if (chosen.length >= itemCount) break;
    if (spend + cost(product) <= budget.amount) {
      chosen.push(product);
      spend += cost(product);
    }
  }

  if (chosen.length < itemCount) {
    const cheapestFirst = candidates
      .filter((c) => !chosen.includes(c))
      .sort((a, b) => cost(a) - cost(b));
    for (const product of cheapestFirst) {
      if (chosen.length >= itemCount) break;
      if (spend + cost(product) <= budget.amount) {
        chosen.push(product);
        spend += cost(product);
      }
    }
  }

  return chosen;
}

export async function recommendPack(input: PackInput, known?: 'men' | 'women'): Promise<PackRecommendation> {
  const itemCount = input.itemCount ?? DEFAULT_ITEM_COUNT;
  // One range for the whole pack, as for outfits - never kids unless asked.
  const range = parseRange(input.query).range ?? known ?? 'men';
  const rangeWord = range === 'women' ? 'ladies' : range === 'kids' ? 'kids' : 'mens';

  /*
   * What they asked for first, the range second. Their own words are the more
   * relevant answer when they match anything at all, so the fallback only runs
   * when the first search could not fill the pack.
   */
  const queries = [
    [rangeWord, input.query, input.colour].filter(Boolean).join(' '),
    [rangeWord, input.colour, RANGE_TERMS].filter(Boolean).join(' '),
  ]
    .map((query) => query.trim())
    .filter((query, index, all) => query && all.indexOf(query) === index);

  let items: Product[] = [];

  for (const query of queries) {
    const results = await searchProducts({
      query,
      limit: Math.max(itemCount * 4, 12),
      // Nothing in the pack can cost more than the whole budget.
      ...(input.budget ? { maxPrice: input.budget.amount, currency: input.budget.currency } : {}),
    });

    // A pack is a product too, and must not end up inside another pack.
    const available = results.filter((p) => p.price.amount > 0 && !isPack(p));
    const preferred = available.filter((p) => matchesColour(p, input.colour) && hasSize(p, input.size));
    const candidates = preferred.length >= itemCount ? preferred : available;

    const filled = fillWithinBudget(candidates, itemCount, input.budget, input.size);
    // Keep the best attempt, so a fallback that finds less cannot lose us one
    // the customer's own wording already found.
    if (filled.length > items.length) items = filled;
    if (items.length >= itemCount) break;
  }

  const total = sum(items, input.size);
  const overBudget = Boolean(input.budget && total.amount > input.budget.amount);

  return {
    items,
    total: { amount: total.amount, currency: total.currency },
    overBudget,
    reason: buildReason(items.length, itemCount, input, overBudget, total.exact),
  };
}

function buildReason(
  found: number,
  wanted: number,
  input: PackInput,
  overBudget: boolean,
  exact = true,
): string {
  if (found === 0) {
    return input.budget
      ? `I could not find anything matching that under ${input.budget.amount} ${input.budget.currency}.`
      : 'I could not find anything matching that in the store right now.';
  }
  const bits = [`Here is a ${found} piece pack`];
  if (input.colour) bits.push(`in ${input.colour}`);
  if (input.budget && !overBudget) bits.push(`inside your ${input.budget.amount} ${input.budget.currency} budget`);
  let reason = `${bits.join(' ')}.`;
  if (found < wanted) reason += ` I could only fit ${found} of the ${wanted} you asked for at that budget.`;
  // Said out loud, because a total built from "from" prices is not a total.
  if (!exact) reason += ' That is a starting price - the final one depends on the sizes chosen.';
  if (overBudget) reason += ' This comes in slightly over budget - say the word and I will swap something out.';
  return reason;
}
