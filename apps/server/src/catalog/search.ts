import type { Product } from '@caddie/shared';
import { allProducts, catalogueVersion } from './sync.js';

/**
 * Search over the local catalogue mirror.
 *
 * This replaces Shopify's semantic catalogue search, which we cannot call
 * thousands of times an hour. Semantic search was doing two things for us:
 * matching words to products, and being vague enough to always return
 * something. Only the first is worth keeping - the second is what had the
 * Caddie offering jackets to someone asking for a product we do not sell.
 *
 * At the real catalogue size - roughly 2,400 active products, each with a few
 * hundred words of description and thirty-odd tags - scanning every product
 * per query took about 25ms, and an outfit fires eight searches. Node runs one
 * thread, so 200ms of scanning blocks every other customer's request behind
 * it. So the words are indexed once when the catalogue changes, and a query
 * only ever looks at products that contain one of them.
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

function expand(word: string, into: Set<string>): void {
  into.add(word);
  // Strip a trailing plural so "polos" finds "POLO".
  if (word.length > 3 && word.endsWith('s')) into.add(word.slice(0, -1));
  for (const synonym of SYNONYMS[word] ?? []) into.add(synonym);
}

function tokenise(text: string, dropStopWords = true): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 1 && (!dropStopWords || !STOP_WORDS.has(word)));

  const expanded = new Set<string>();
  for (const word of words) expand(word, expanded);
  return [...expanded];
}

/**
 * Where a word is found matters more than how often. A word in the name is
 * what the product is; a word in the description is a passing mention.
 */
const FIELD_WEIGHT = { title: 10, type: 6, tag: 4, description: 1 } as const;

/* ---------------- The index ---------------- */

/**
 * token -> product position -> the best field it appears in.
 *
 * Built once per catalogue change rather than per query, which is what takes a
 * search from tens of milliseconds to well under one.
 */
type Postings = Map<number, number>;

let index = new Map<string, Postings>();
let indexed: Product[] = [];
let indexedVersion = -1;

function addToken(token: string, position: number, weight: number): void {
  let postings = index.get(token);
  if (!postings) {
    postings = new Map();
    index.set(token, postings);
  }
  // A word in the title beats the same word in the description.
  const existing = postings.get(position) ?? 0;
  if (weight > existing) postings.set(position, weight);
}

function build(products: Product[]): void {
  index = new Map();
  indexed = products;

  products.forEach((product, position) => {
    for (const token of tokenise(product.title)) addToken(token, position, FIELD_WEIGHT.title);
    if (product.productType) {
      for (const token of tokenise(product.productType)) addToken(token, position, FIELD_WEIGHT.type);
    }
    for (const tag of product.tags) {
      for (const token of tokenise(tag)) addToken(token, position, FIELD_WEIGHT.tag);
    }
    if (product.description) {
      // The first couple of sentences carry the useful words; the rest is
      // washing instructions, and indexing it all trebles the index for
      // nothing.
      for (const token of tokenise(product.description.slice(0, 300))) {
        addToken(token, position, FIELD_WEIGHT.description);
      }
    }
  });
}

/** Rebuilds only when the catalogue has actually changed underneath us. */
function ensureIndex(): void {
  const version = catalogueVersion();
  if (version === indexedVersion) return;
  build(allProducts());
  indexedVersion = version;
}

export function indexSize(): { tokens: number; products: number } {
  ensureIndex();
  return { tokens: index.size, products: indexed.length };
}

/* ---------------- Searching ---------------- */

export interface LocalSearchOptions {
  query: string;
  limit?: number;
  /** Major units, as a customer says it. */
  maxPrice?: number;
  minPrice?: number;
  available?: boolean;
}

export function searchLocal(opts: LocalSearchOptions): Product[] {
  ensureIndex();

  const tokens = tokenise(opts.query);
  const limit = opts.limit ?? 10;
  if (tokens.length === 0) return [];

  // Only products carrying at least one of the words are ever looked at.
  const scores = new Map<number, { score: number; matched: number }>();

  for (const token of tokens) {
    const postings = index.get(token);
    if (!postings) continue;
    for (const [position, weight] of postings) {
      const current = scores.get(position);
      if (current) {
        current.score += weight;
        current.matched += 1;
      } else {
        scores.set(position, { score: weight, matched: 1 });
      }
    }
  }

  const hits: Array<{ product: Product; score: number }> = [];

  for (const [position, { score, matched }] of scores) {
    const product = indexed[position];
    if (!product) continue;

    if (opts.maxPrice !== undefined && product.price.amount > opts.maxPrice) continue;
    if (opts.minPrice !== undefined && product.price.amount < opts.minPrice) continue;
    if (opts.available !== false && !product.variants.some((variant) => variant.available)) continue;

    // Matching more of what they said beats matching one word loudly: "navy
    // polo" should put a navy polo above every other polo.
    hits.push({ product, score: score * (matched / tokens.length) });
  }

  hits.sort((a, b) => b.score - a.score || a.product.price.amount - b.product.price.amount);
  return hits.slice(0, limit).map((hit) => hit.product);
}

/** Exposed for the tests, which check the ranking rather than the plumbing. */
export const __internals = { tokenise };
