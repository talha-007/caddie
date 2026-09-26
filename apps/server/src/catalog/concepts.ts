import type { Product } from '@caddie/shared';
import type { Category } from './constraints.js';

/**
 * What each kind of garment is called, for semantic retrieval only.
 *
 * Embeddings did not connect "a sleeveless warm outer layer" to a gilet:
 * four of Druids' 102 gilets say "sleeveless" anywhere. These are names for
 * the kind of thing - a gilet is a body warmer and a sleeveless jacket - and
 * never claims about a product: no line here says a garment is warm,
 * waterproof or lightweight. Those come only from what its own description
 * states (catalog/attributes.ts). Nothing here is shown or said to a
 * customer.
 *
 * Kept small and readable on purpose: one line per kind Druids sell.
 */
export const CATEGORY_CONCEPTS: Record<Category, string> = {
  polo: 'polo shirt, golf shirt, short-sleeved golf top',
  midlayer: 'midlayer, layering top, quarter zip, pullover, jumper',
  hoodie: 'hoodie, hooded top, sweatshirt',
  jacket: 'jacket, outer layer, outerwear',
  gilet: 'gilet, body warmer, sleeveless jacket, sleeveless outer layer, vest',
  trousers: 'golf trousers, golf pants, golf bottoms, full-length trousers',
  shorts: 'golf shorts, shorts',
  skort: 'skort, golf skirt',
  dress: 'golf dress',
  baselayer: 'baselayer, base layer, under layer worn next to the skin',
  cap: 'cap, golf cap, headwear',
  visor: 'visor, golf visor, headwear',
  beanie: 'beanie, knitted hat, headwear',
  hat: 'hat, bucket hat, headwear',
  belt: 'belt, golf belt',
  socks: 'socks, golf socks',
  shoes: 'golf shoes, footwear',
};

/** Druids file rain jackets as their own product type: what that type is called. */
export const RAIN_JACKET_CONCEPT = 'rain jacket, wet-weather jacket, rain protection';

/** The concept line for a product, from its categories and type. */
export function conceptsOf(product: Product, categories: Iterable<Category>): string[] {
  const out = [...categories].map((category) => CATEGORY_CONCEPTS[category]);
  if (/\bRAIN\b/.test((product.productType ?? '').toUpperCase())) out.push(RAIN_JACKET_CONCEPT);
  return out;
}

/**
 * Words in a query that point at one of these kinds where the shop-floor
 * taxonomy (taxonomy.ts) has no mapping, and search does not need one:
 * "sleeveless" is a gilet to a salesperson, "rain" wants a rain jacket.
 */
/** A kind a query points at: a category, or Druids' rain jackets. */
export type ConceptKind = Category | 'rain-jacket';

const QUERY_TRIGGERS: Array<[RegExp, ConceptKind, string]> = [
  [/\bsleeveless\b|\bbody ?warmers?\b|\bvests?\b/i, 'gilet', CATEGORY_CONCEPTS.gilet],
  [/\brain\b|\brainy\b|\bwet\b|\bshowers?\b|\bdownpour\b/i, 'rain-jacket', RAIN_JACKET_CONCEPT],
  [/\bbase ?layers?\b|\bunder ?layers?\b|\bthermals?\b/i, 'baselayer', CATEGORY_CONCEPTS.baselayer],
];

export function conceptsInQuery(text: string): string[] {
  return QUERY_TRIGGERS.filter(([pattern]) => pattern.test(text)).map(([, , concept]) => concept);
}

/** The kinds those concept words point at - for ranking only: "sleeveless" points at gilets. */
export function conceptKindsInQuery(text: string): ConceptKind[] {
  return QUERY_TRIGGERS.filter(([pattern]) => pattern.test(text)).map(([, kind]) => kind);
}

/** Whether a product is one of those kinds. */
export function isConceptKind(product: Product, kinds: ConceptKind[], categories: Set<Category>): boolean {
  return kinds.some((kind) => (kind === 'rain-jacket' ? /\bRAIN\b/.test((product.productType ?? '').toUpperCase()) : categories.has(kind)));
}

/*
 * "Top" names no kind of garment, and what it means depends on the weather.
 * "A lightweight ladies top for warm weather" was answered with a visor, a
 * cap and four midlayers - "top" matched "layering top" and nothing else -
 * while the ladies polos and dresses sat further down. So when a request says
 * top, names no kind, and says what the day is like, the kinds worn above the
 * waist in that weather are preferred. Only preferred: a top for summer can
 * still be something else, it just never leads over what suits the heat. A
 * top with no weather stays as broad as the word.
 */
const TOP = /\btops?\b/i;
export const HOT_WEATHER_TOPS: Category[] = ['polo', 'dress'];
export const COLD_WEATHER_TOPS: Category[] = ['midlayer', 'hoodie', 'jacket'];

export type Climate = 'hot' | 'cold';

/** The kinds a "top" means in this weather, or none: never when a kind is already named. */
export function topKindsFor(text: string, climate: Climate | undefined, named: Category[]): Category[] {
  if (named.length || !climate || !TOP.test(text)) return [];
  return climate === 'hot' ? HOT_WEATHER_TOPS : COLD_WEATHER_TOPS;
}
