import type { Product } from '@caddie/shared';
import { inRange, parseRange, rangeOf, type Range } from './audience.js';
import { priceFor } from '../recommend/pricing.js';
import { isCategory, sizeStatus, type Category } from './constraints.js';
import { colourMatch, parseColours } from './colour.js';
import { SPELLING_VARIANTS, identityOf } from './identity.js';
import { bestSellerRank } from './bestSellers.js';
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
  // The customer's spelling of a catalogue word: "hoody" found nothing, "vapour" missed the VAPOR JACKET.
  const variant = SPELLING_VARIANTS[word];
  if (variant) into.add(variant);
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
/** Every design word in the catalogue ("elite", "galactic", "vapor") - the words that name a product. */
let designWords = new Set<string>();

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
  designWords = new Set(products.flatMap((product) => identityOf(product).designWords));

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
  /** Hard rules the caller has established - see catalog/constraints.ts. */
  range?: Range;
  categories?: Category[];
  /** Only products that can be bought in this size; the price limit is then that size's price. */
  size?: string;
}

/** A colour match is worth more than any one word. Only that colour beats that colour in a mix. */
const COLOUR_WEIGHT: Record<number, number> = { 3: 25, 2: 20, 1: 10 };

/**
 * Why a product ranked where it did - for tests and debugging, never shown
 * to a customer or read to the model.
 */
export interface SearchHit {
  product: Product;
  score: number;
  /** The words it matched, as the customer said them. */
  matchedWords: string[];
  /** Name words ("elite", "galactic") found in its title, out of those asked. */
  identifyingMatched: number;
  identifyingAsked: number;
  /** Matched words / meaningful words asked. */
  coverage: number;
  /** The words asked appear together, in order, in its title. */
  phrase: boolean;
  /** Its design name is exactly what was asked: "elite polo" is the Elite Polo. */
  exactDesign: boolean;
  /** A word matched in its title or product type - not only a tag or a passing mention. */
  titleOrType: boolean;
}

/**
 * A word that names a design counts for more than a word that names a kind
 * of garment. "Elite polo" is a request for the Elite Polo; every polo in the
 * shop matches "polo", and they used to fill the screen after it.
 */
const IDENTIFYING = 3;
const PHRASE_BONUS = 20;
const EXACT_DESIGN_BONUS = 30;
/** Budget wording is a price rule, handled by maxPrice - "20" matched "20 off" campaign tags. */
const BUDGET_TEXT = /[£$€]\s?\d+(?:\.\d{1,2})?|\b\d+(?:\.\d{1,2})?\s?(?:pounds?|quid|gbp|dollars?|euros?)\b|\b(?:under|below|less than|max|maximum|up to|upto|around|about)\b/gi;

export function searchLocal(opts: LocalSearchOptions): Product[] {
  return searchLocalScored(opts).map((hit) => hit.product);
}

export function searchLocalScored(opts: LocalSearchOptions): SearchHit[] {
  ensureIndex();

  /*
   * Colour is taken out of the words and applied as its own test - see
   * colour.ts. Left in, "blue" matched a campaign tag on an orange polo, and
   * a product failing the colour still came back on "polo".
   */
  const { colours, rest: uncoloured, plain } = parseColours(opts.query.replace(BUDGET_TEXT, ' '));
  // Mens, ladies or kids: taken out of the words like colour, and applied as a filter.
  const { range: named, rest } = parseRange(uncoloured);
  const asked = opts.range ?? named;
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
  // Which words name a design, by the catalogue's own design words.
  const identifying = words.map((spellings) => spellings.some((spelling) => designWords.has(spelling)));
  const identifyingAsked = identifying.filter(Boolean).length;
  // The phrase as the catalogue would spell it: "vapour jacket" is "vapor jacket".
  const phrase = specific.map((word) => SPELLING_VARIANTS[word] ?? word).join(' ');
  const limit = opts.limit ?? 10;
  // A kind of garment on its own ("gilets in XL") is a browse of that kind.
  if (words.length === 0 && colours.length === 0 && !browsing && !plain && !opts.categories?.length) return [];

  // Only products carrying at least one of the words are ever looked at.
  type Tally = { score: number; matched: number; lead: number; leadWeight: number; words: number[]; identifyingInTitle: number; bestField: number };
  const scores = new Map<number, Tally>();

  // "Something navy" names no garment: every product is a candidate, and the
  // colour decides.
  if (words.length === 0) {
    indexed.forEach((_, position) => scores.set(position, { score: 0, matched: 0, lead: -1, leadWeight: 0, words: [], identifyingInTitle: 0, bestField: 0 }));
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
    const namedSomewhere = [...best.values()].some((weight) => weight > FIELD_WEIGHT.description);
    const multiplier = identifying[wordIndex] ? IDENTIFYING : 1;
    for (const [position, weight] of best) {
      if (namedSomewhere && weight <= FIELD_WEIGHT.description) continue;
      const current = scores.get(position) ?? { score: 0, matched: 0, lead: wordIndex, leadWeight: 0, words: [], identifyingInTitle: 0, bestField: 0 };
      current.score += weight * multiplier;
      current.matched += 1;
      current.words.push(wordIndex);
      if (identifying[wordIndex] && weight === FIELD_WEIGHT.title) current.identifyingInTitle += 1;
      current.bestField = Math.max(current.bestField, weight);
      if (weight > current.leadWeight) {
        current.lead = wordIndex;
        current.leadWeight = weight;
      }
      scores.set(position, current);
    }
  }

  type Keyed = SearchHit & { matched: number; lead: number; bestField: number };
  const hits: Keyed[] = [];

  for (const [position, tally] of scores) {
    const product = indexed[position];
    if (!product) continue;

    // The kind of garment and the size are facts about the product, not words to score.
    if (opts.categories?.length && !isCategory(product, opts.categories)) continue;
    if (opts.size && sizeStatus(product, opts.size) !== 'in-stock') continue;
    // In their size, the price is that size's price: a polo from £38 can be £44 in XL.
    const price = opts.size ? priceFor(product, opts.size).amount : product.price.amount;
    if (opts.maxPrice !== undefined && price > opts.maxPrice) continue;
    if (opts.minPrice !== undefined && price < opts.minPrice) continue;
    if (opts.available !== false && !product.variants.some((variant) => variant.available)) continue;

    // Never a child's polo for an adult, never the other range once we know theirs.
    if (!inRange(product, asked, opts.known)) continue;

    // Not the colour asked for is not a result, however well the rest matches.
    const colour = colourMatch(product, colours, opts.available !== false, plain);
    if (colour === 0) continue;
    const colourScore = colours.length === 0 && !plain ? 0 : (COLOUR_WEIGHT[colour] ?? 0);

    // Matching more of what they said beats matching one word loudly: "navy
    // polo" should put a navy polo above every other polo.
    const coverage = words.length ? tally.matched / words.length : 0;
    const identity = identityOf(product);
    const together = words.length > 1 && ` ${identity.title} `.includes(` ${phrase} `);
    const exactDesign = words.length > 0 && identity.design.replace(/[^a-z0-9]+/g, ' ').trim() === phrase;
    hits.push({
      product,
      score: tally.score * coverage + (together ? PHRASE_BONUS : 0) + (exactDesign ? EXACT_DESIGN_BONUS : 0) + colourScore,
      matchedWords: tally.words.map((index) => specific[index]!),
      identifyingMatched: tally.identifyingInTitle,
      identifyingAsked,
      coverage,
      phrase: together,
      exactDesign,
      titleOrType: tally.bestField >= FIELD_WEIGHT.type,
      matched: tally.matched,
      lead: tally.lead,
      bestField: tally.bestField,
    });
  }

  /*
   * A threshold, not a quota: six is the most shown, never a number to fill.
   * When some products carry the name words asked for in their titles, the
   * ones carrying fewer are not what was asked for - "elite polo" is the
   * Elite polos, not every polo. With no name words ("polo"), a product
   * matched only by a tag or a passing mention gives way to ones matched by
   * their title or type.
   */
  const mostIdentifying = Math.max(0, ...hits.map((hit) => hit.identifyingMatched));
  const byTitleOrType = hits.some((hit) => hit.bestField >= FIELD_WEIGHT.type);
  const relevant = hits.filter((hit) =>
    mostIdentifying > 0 ? hit.identifyingMatched === mostIdentifying : !byTitleOrType || hit.bestField >= FIELD_WEIGHT.type,
  );

  /*
   * Equal matches: relevance first, then what they can buy and what sells.
   * Cheapest-first was the tie-break, and on the live store the cheapest is
   * clearance with one size left - "polo" opened on a £5 polo, and an outfit
   * came back a £5 polo in S only and a £2 cap. So: the main range when no
   * range was asked for, stocked in more sizes, Shopify's own best-seller
   * order, and price only to settle what is left.
   */
  const keyed = relevant.map((hit) => ({
    hit,
    score: Math.round(hit.score * 100) / 100,
    main: asked || opts.known ? 0 : rangeOf(hit.product) === 'men' ? 0 : 1,
    stock: Math.min(hit.product.variants.filter((variant) => variant.available).length, 4),
    seller: bestSellerRank(hit.product.id) ?? Number.MAX_SAFE_INTEGER,
  }));
  keyed.sort(
    (a, b) =>
      b.score - a.score ||
      a.main - b.main ||
      b.stock - a.stock ||
      a.seller - b.seller ||
      a.hit.product.price.amount - b.hit.product.price.amount,
  );
  return takeTurns(keyed.map((entry) => entry.hit))
    .slice(0, limit)
    .map(({ matched: _matched, lead: _lead, bestField: _bestField, ...hit }) => hit);
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
