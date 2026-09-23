import type { Money, PackInput, PackRecommendation, Product } from '@caddie/shared';
import { searchProducts } from '../shopify/catalog.js';
import { storeCurrency } from '../shopify/money.js';
import { isPack } from './packs.js';
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

function matchesColour(product: Product, colour?: string): boolean {
  if (!colour) return true;
  const needle = colour.toLowerCase();
  const haystack = [product.title, ...product.tags, product.description ?? '']
    .join(' ')
    .toLowerCase();
  if (haystack.includes(needle)) return true;
  return product.variants.some((variant) =>
    Object.values(variant.options).some((value) => value.toLowerCase().includes(needle)),
  );
}

function hasSize(product: Product, size?: string): boolean {
  return stockedInSize(product.variants, size);
}

function sum(products: Product[]): Money {
  return {
    amount: Number(products.reduce((total, p) => total + p.price.amount, 0).toFixed(2)),
    currency: products[0]?.price.currency ?? storeCurrency(),
  };
}

/**
 * Greedy fill: take the best-ranked candidates that keep us inside budget,
 * then top up with the cheapest remaining ones if we are short on items.
 */
function fillWithinBudget(candidates: Product[], itemCount: number, budget?: Money): Product[] {
  if (!budget) return candidates.slice(0, itemCount);

  const chosen: Product[] = [];
  let spend = 0;

  for (const product of candidates) {
    if (chosen.length >= itemCount) break;
    if (spend + product.price.amount <= budget.amount) {
      chosen.push(product);
      spend += product.price.amount;
    }
  }

  if (chosen.length < itemCount) {
    const cheapestFirst = candidates
      .filter((c) => !chosen.includes(c))
      .sort((a, b) => a.price.amount - b.price.amount);
    for (const product of cheapestFirst) {
      if (chosen.length >= itemCount) break;
      if (spend + product.price.amount <= budget.amount) {
        chosen.push(product);
        spend += product.price.amount;
      }
    }
  }

  return chosen;
}

export async function recommendPack(input: PackInput): Promise<PackRecommendation> {
  const itemCount = input.itemCount ?? DEFAULT_ITEM_COUNT;

  /*
   * What they asked for first, the range second. Their own words are the more
   * relevant answer when they match anything at all, so the fallback only runs
   * when the first search could not fill the pack.
   */
  const queries = [
    [input.query, input.colour].filter(Boolean).join(' '),
    [input.colour, RANGE_TERMS].filter(Boolean).join(' '),
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

    const filled = fillWithinBudget(candidates, itemCount, input.budget);
    // Keep the best attempt, so a fallback that finds less cannot lose us one
    // the customer's own wording already found.
    if (filled.length > items.length) items = filled;
    if (items.length >= itemCount) break;
  }

  const total = sum(items);
  const overBudget = Boolean(input.budget && total.amount > input.budget.amount);

  return {
    items,
    total,
    overBudget,
    reason: buildReason(items.length, itemCount, input, overBudget),
  };
}

function buildReason(found: number, wanted: number, input: PackInput, overBudget: boolean): string {
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
  if (overBudget) reason += ' This comes in slightly over budget - say the word and I will swap something out.';
  return reason;
}
