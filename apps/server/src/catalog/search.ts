import type { Product } from '@caddie/shared';
import { inRange, parseRange, rangeOf } from './audience.js';
import { colourMatch, parseColours } from './colour.js';
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

/**
 * Words that describe the whole shop rather than any product in it.
 *
 * Everything here is golf, and Druids, and clothing: "golf polo" means a polo,
 * and counting "golf" filled the results with hoodies and a pack. Dropped from
 * queries only - they stay in the index, so a product called GOLF TEE POLO is
 * still found by its name.
 */
const SHOP_WORDS = new Set(['golf', 'druids', 'clothes', 'clothing', 'kit', 'gear', 'apparel', 'stuff', 'items', 'products', 'range', 'wear']);

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

function tokenise(text: string, dropStopWords = true, expandWords = true): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 1 && (!dropStopWords || !STOP_WORDS.has(word)));

  if (!expandWords) return [...new Set(words)];
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
  /**
   * The range the customer is known to be shopping, from earlier in the
   * conversation. A range named in the query itself always wins.
   */
  known?: 'men' | 'women';
}

/** A colour match is worth more than any one word. Only that colour beats that colour in a mix. */
const COLOUR_WEIGHT: Record<number, number> = { 3: 25, 2: 20, 1: 10 };

export function searchLocal(opts: LocalSearchOptions): Product[] {
  ensureIndex();

  /*
   * Colour is taken out of the words and applied as its own test - see
   * colour.ts. Left in, "blue" matched a campaign tag on an orange polo, and
   * a product failing the colour still came back on "polo".
   */
  const { colours, rest: uncoloured, plain } = parseColours(opts.query);
  // Mens, ladies or kids: taken out of the words like colour, and applied as a filter.
  const { range: asked, rest } = parseRange(uncoloured);
  /*
   * Scored per word the customer said, not per spelling of it. Counting
   * "polos", "polo", "trousers", "trouser", "pant" and "pants" as six words
   * meant a polo matched "two of six" and lost to a rainsuit pack whose
   * description happened to mention both - "polos and trousers" came back
   * with no polos in it. Each word now counts once, at its best spelling.
   */
  const said = tokenise(rest, true, false);
  const specific = said.filter((word) => !SHOP_WORDS.has(word));
  /*
   * "Show me some golf clothes" names nothing in particular: a browse of the
   * whole shop, never "we do not stock that" - which is what an empty result
   * becomes by the time the model says it.
   */
  const browsing = specific.length === 0 && said.length > 0;
  const words = specific.map((word) => {
    const spellings = new Set<string>();
    expand(word, spellings);
    return [...spellings];
  });
  const limit = opts.limit ?? 10;
  if (words.length === 0 && colours.length === 0 && !browsing && !plain) return [];

  // Only products carrying at least one of the words are ever looked at.
  const scores = new Map<number, { score: number; matched: number; lead: number; leadWeight: number }>();

  // "Something navy" names no garment: every product is a candidate, and the
  // colour decides.
  if (words.length === 0) {
    indexed.forEach((_, position) => scores.set(position, { score: 0, matched: 0, lead: -1, leadWeight: 0 }));
  }

  for (const [wordIndex, spellings] of words.entries()) {
    // This word's best field in each product, across its spellings.
    const best = new Map<number, number>();
    for (const spelling of spellings) {
      for (const [position, weight] of index.get(spelling) ?? []) {
        if (weight > (best.get(position) ?? 0)) best.set(position, weight);
      }
    }
    /*
     * A passing mention is not a match when real ones exist. A belt whose
     * description says "wear it with the Tech Trouser" is not a trouser, and
     * with it counted, "polos and trousers" showed a belt, a rainsuit and a
     * pack. A word only ever found in descriptions ("waterproof") still is.
     */
    const named = [...best.values()].some((weight) => weight > FIELD_WEIGHT.description);
    for (const [position, weight] of best) {
      if (named && weight <= FIELD_WEIGHT.description) continue;
      const current = scores.get(position);
      if (current) {
        current.score += weight;
        current.matched += 1;
        if (weight > current.leadWeight) {
          current.lead = wordIndex;
          current.leadWeight = weight;
        }
      } else {
        scores.set(position, { score: weight, matched: 1, lead: wordIndex, leadWeight: weight });
      }
    }
  }
  const tokens = words;

  const hits: Array<{ product: Product; score: number; matched: number; lead: number }> = [];

  for (const [position, { score, matched, lead }] of scores) {
    const product = indexed[position];
    if (!product) continue;

    if (opts.maxPrice !== undefined && product.price.amount > opts.maxPrice) continue;
    if (opts.minPrice !== undefined && product.price.amount < opts.minPrice) continue;
    if (opts.available !== false && !product.variants.some((variant) => variant.available)) continue;

    // Never a child's polo for an adult, never the other range once we know theirs.
    if (!inRange(product, asked, opts.known)) continue;

    // Not the colour asked for is not a result, however well the rest matches.
    const colour = colourMatch(product, colours, opts.available !== false, plain);
    if (colour === 0) continue;
    const colourScore = colours.length === 0 && !plain ? 0 : (COLOUR_WEIGHT[colour] ?? 0);

    // Matching more of what they said beats matching one word loudly: "navy
    // polo" should put a navy polo above every other polo.
    const wordScore = tokens.length ? score * (matched / tokens.length) : 0;
    hits.push({ product, score: wordScore + colourScore, matched, lead });
  }

  /*
   * Equal matches: what they can actually buy first. Cheapest-first was the
   * tie-break, and on the live store the cheapest is clearance with one size
   * left - an outfit came back a £5 polo in S only and a £2 cap. So: stocked
   * in more sizes, then the main range when no range was asked for (the
   * ladies joggers were cheaper and filled "trousers"), and price last.
   */
  // Worked out once per hit, not once per comparison.
  const keyed = hits.map((hit) => ({
    ...hit,
    stock: Math.min(hit.product.variants.filter((variant) => variant.available).length, 4),
    main: asked || opts.known ? 0 : rangeOf(hit.product) === 'men' ? 0 : 1,
  }));
  keyed.sort(
    (a, b) =>
      b.score - a.score || b.stock - a.stock || a.main - b.main || a.product.price.amount - b.product.price.amount,
  );
  return takeTurns(keyed).slice(0, limit).map((hit) => hit.product);
}

/**
 * Several garments named, results take turns.
 *
 * "Polos and trousers" is two requests. Ranked straight, eight polos filled
 * the screen and the trousers never appeared. Products that match more of
 * what was said still come first; among those that match equally, they
 * alternate by which word they matched best - polo, trouser, polo, trouser.
 */
function takeTurns<T extends { matched: number; lead: number }>(hits: T[]): T[] {
  const out: T[] = [];
  const tiers = [...new Set(hits.map((hit) => hit.matched))].sort((a, b) => b - a);
  for (const tier of tiers) {
    const groups = new Map<number, T[]>();
    for (const hit of hits) {
      if (hit.matched !== tier) continue;
      const group = groups.get(hit.lead) ?? [];
      group.push(hit);
      groups.set(hit.lead, group);
    }
    const queues = [...groups.values()];
    while (queues.some((queue) => queue.length)) {
      for (const queue of queues) {
        const next = queue.shift();
        if (next) out.push(next);
      }
    }
  }
  return out;
}

/** Exposed for the tests, which check the ranking rather than the plumbing. */
export const __internals = { tokenise };
