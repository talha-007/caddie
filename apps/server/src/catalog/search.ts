import type { Product } from '@caddie/shared';
import { allProducts } from './sync.js';

/**
 * Search over the local catalogue mirror.
 *
 * This replaces Shopify's semantic catalogue search, which we cannot call
 * thousands of times an hour. Semantic search was doing two things for us:
 * matching words to products, and being vague enough to always return
 * something. Only the first is worth keeping - the second is what had the
 * Caddie offering jackets to someone asking for a product we do not sell.
 *
 * So this is a plain relevance score over the words a customer actually uses:
 * the product name, its type, its tags. When nothing matches, nothing comes
 * back, and the Caddie asks what they mean instead of guessing.
 */

/** Words that say nothing about which product is wanted. */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'some', 'any', 'me', 'my', 'i', 'im', 'is', 'are', 'for', 'of', 'in', 'on', 'to',
  'with', 'and', 'or', 'show', 'find', 'get', 'want', 'need', 'looking', 'look', 'please', 'have',
  'has', 'do', 'you', 'got', 'like', 'something', 'anything', 'give', 'can', 'could', 'would',
  'about', 'under', 'over', 'that', 'this', 'it', 'be', 'at', 'new', 'good', 'best', 'nice',
]);

/** Plural and spelling variations we should not miss over. */
const SYNONYMS: Record<string, string[]> = {
  tshirt: ['t-shirt', 'tee'],
  tee: ['t-shirt', 'tshirt'],
  trousers: ['trouser', 'pant', 'pants'],
  pants: ['trouser', 'trousers'],
  joggers: ['jogger', 'trouser'],
  shorts: ['short'],
  socks: ['sock'],
  hoodies: ['hoodie'],
  polos: ['polo'],
  jackets: ['jacket'],
  gilets: ['gilet'],
  midlayers: ['midlayer', 'mid-layer'],
  grey: ['gray'],
  gray: ['grey'],
  colour: ['color'],
};

function tokenise(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));

  const expanded = new Set<string>();
  for (const word of words) {
    expanded.add(word);
    // Strip a trailing plural so "polos" finds "POLO".
    if (word.length > 3 && word.endsWith('s')) expanded.add(word.slice(0, -1));
    for (const synonym of SYNONYMS[word] ?? []) expanded.add(synonym);
  }
  return [...expanded];
}

/**
 * Where a word is found matters more than how often. A word in the name is
 * what the product is; a word in the description is a passing mention.
 */
const FIELD_WEIGHT = { title: 10, type: 6, tag: 4, description: 1 } as const;

function scoreProduct(product: Product, tokens: string[]): number {
  if (tokens.length === 0) return 0;

  const title = product.title.toLowerCase();
  const type = (product.productType ?? '').toLowerCase();
  const tags = product.tags.map((tag) => tag.toLowerCase());
  const description = (product.description ?? '').toLowerCase().slice(0, 600);

  let score = 0;
  let matched = 0;

  for (const token of tokens) {
    let best = 0;
    if (title.includes(token)) best = FIELD_WEIGHT.title;
    else if (type.includes(token)) best = FIELD_WEIGHT.type;
    else if (tags.some((tag) => tag === token || tag.includes(token))) best = FIELD_WEIGHT.tag;
    else if (description.includes(token)) best = FIELD_WEIGHT.description;

    if (best > 0) {
      matched += 1;
      score += best;
    }
  }

  if (matched === 0) return 0;

  // Matching more of what they said beats matching one word loudly: "navy
  // polo" should put a navy polo above every other polo.
  return score * (matched / tokens.length);
}

export interface LocalSearchOptions {
  query: string;
  limit?: number;
  /** Major units, as a customer says it. */
  maxPrice?: number;
  minPrice?: number;
  available?: boolean;
}

export function searchLocal(opts: LocalSearchOptions): Product[] {
  const tokens = tokenise(opts.query);
  const limit = opts.limit ?? 10;

  const scored: Array<{ product: Product; score: number }> = [];

  for (const product of allProducts()) {
    if (opts.maxPrice !== undefined && product.price.amount > opts.maxPrice) continue;
    if (opts.minPrice !== undefined && product.price.amount < opts.minPrice) continue;
    if (opts.available !== false && !product.variants.some((variant) => variant.available)) continue;

    const score = scoreProduct(product, tokens);
    if (score > 0) scored.push({ product, score });
  }

  scored.sort((a, b) => b.score - a.score || a.product.price.amount - b.product.price.amount);
  return scored.slice(0, limit).map((entry) => entry.product);
}

/** Exposed for the tests, which check the ranking rather than the plumbing. */
export const __internals = { tokenise, scoreProduct };
