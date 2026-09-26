import type { Product } from '@caddie/shared';
import { normaliseSize } from '../recommend/sizeWords.js';
import { normaliseQuery } from './taxonomy.js';

/**
 * What a customer asked for that is a rule, not a preference: the kind of
 * garment, and the size they need in stock.
 *
 * Search matched words. "Body warmer" became "body warmer gilet", and polos
 * whose descriptions happened to say "body" came back beside the gilets.
 * "Navy polo in XL" came back as navy polos sold out in XL, each marked an
 * exact match. Both are facts about the product that the catalogue states
 * plainly - its type, its variants - so they are checked, not scored.
 */

export type Category =
  | 'polo' | 'midlayer' | 'hoodie' | 'jacket' | 'gilet' | 'trousers' | 'shorts' | 'skort' | 'dress'
  | 'baselayer' | 'cap' | 'visor' | 'beanie' | 'hat' | 'belt' | 'socks' | 'shoes';

/**
 * Druids' product types, and a few garment words, to categories. The product
 * type is Shopify's own classification - "LADIES RAIN JACKETS", "KIDS GILETS",
 * "GOLF HOODIES" - so it decides. The title only adds a narrower kind Druids
 * file under a broader type: hoodies typed MIDLAYERS, visors typed CAPS.
 */
const RULES: Array<[Category, RegExp]> = [
  ['polo', /\bPOLOS?\b/],
  ['midlayer', /\bMIDLAYERS?\b/],
  ['hoodie', /\bHOODIES?\b/],
  ['jacket', /\bJACKETS?\b/],
  ['gilet', /\bGILETS?\b/],
  ['trousers', /\bTROUSERS?\b|\bJOGGERS?\b/],
  ['shorts', /\bSHORTS\b/],
  ['skort', /\bSKORTS?\b/],
  ['dress', /\bDRESS(ES)?\b/],
  ['baselayer', /\bBASELAYERS?\b/],
  ['cap', /\bCAPS?\b/],
  ['visor', /\bVISORS?\b/],
  ['beanie', /\bBEANIES?\b/],
  ['hat', /\bHATS?\b/],
  ['belt', /\bBELTS?\b/],
  ['socks', /\bSOCKS?\b/],
  ['shoes', /\bSHOES?\b/],
];
/** Narrower kinds a title may add to its type. */
const FROM_TITLE: Category[] = ['hoodie', 'visor', 'skort'];

const categories = new WeakMap<Product, Set<Category>>();

export function categoriesOf(product: Product): Set<Category> {
  let found = categories.get(product);
  if (!found) {
    const type = (product.productType ?? '').toUpperCase();
    const title = product.title.toUpperCase().split(' - ')[0]!;
    found = new Set(RULES.filter(([, pattern]) => pattern.test(type)).map(([category]) => category));
    // No product type: the title is all there is.
    if (found.size === 0) for (const [category, pattern] of RULES) if (pattern.test(title)) found.add(category);
    for (const [category, pattern] of RULES) if (FROM_TITLE.includes(category) && pattern.test(title)) found.add(category);
    categories.set(product, found);
  }
  return found;
}

/** Customer (and catalogue) garment words to categories. */
const ASKED: Array<[RegExp, Category[]]> = [
  [/\bpolos?\b/, ['polo']],
  [/\bmid-?layers?\b|\bquarter zips?\b|\b1\/4 zips?\b/, ['midlayer']],
  [/\bhoodies?\b/, ['hoodie']],
  [/\bjackets?\b/, ['jacket']],
  [/\bgilets?\b/, ['gilet']],
  [/\btrousers?\b|\bjoggers?\b|\bpants\b/, ['trousers']],
  [/\bshorts\b/, ['shorts']],
  [/\bskorts?\b/, ['skort']],
  [/\bdress(es)?\b/, ['dress']],
  [/\bbase ?layers?\b/, ['baselayer']],
  [/\bcaps?\b/, ['cap']],
  [/\bvisors?\b/, ['visor']],
  [/\bbeanies?\b/, ['beanie']],
  [/\bhats?\b/, ['hat']],
  [/\bbelts?\b/, ['belt']],
  [/\bsocks?\b/, ['socks']],
  [/\bshoes?\b/, ['shoes']],
];

/**
 * The kinds of garment a request names, read through the same shop-floor
 * mapping search uses: "body warmer" is a gilet, "jumper" a midlayer or a
 * hoodie, "rain top" a jacket. Several kinds ("polos and jackets") are
 * alternatives. None named, no rule.
 */
export function categoriesAsked(text: string): Category[] {
  const { query } = normaliseQuery(text);
  const found = new Set<Category>();
  for (const [pattern, kinds] of ASKED) if (pattern.test(query)) for (const kind of kinds) found.add(kind);
  // "Cap beanie" is how the taxonomy writes "hat": any of the three.
  if (found.has('cap') && found.has('beanie')) found.add('hat');
  return [...found];
}

/**
 * Types that count as a kind only by a looser name. Joggers are trousers to
 * a customer browsing - and stay in "trousers" - but a pair of trousers
 * Druids file as TROUSERS is the closer answer to "trousers".
 */
const LOOSER_TYPES: Partial<Record<Category, RegExp>> = { trousers: /\bJOGGERS?\b/ };

/** "exact" when its product type is that kind itself, "looser" by a looser name, null when it is not that kind. */
export function categoryFit(product: Product, asked: Category[]): 'exact' | 'looser' | null {
  const own = categoriesOf(product);
  const matching = asked.filter((kind) => own.has(kind));
  if (matching.length === 0) return null;
  const type = (product.productType ?? '').toUpperCase();
  const looser = matching.every((kind) => {
    const pattern = LOOSER_TYPES[kind];
    return !!pattern && pattern.test(type) && !RULES.find(([category]) => category === kind)![1].test(type.replace(pattern, ''));
  });
  return looser ? 'looser' : 'exact';
}

/** Whether a product is any of the kinds asked for. */
export function isCategory(product: Product, asked: Category[]): boolean {
  if (asked.length === 0) return true;
  const own = categoriesOf(product);
  return asked.some((kind) => own.has(kind));
}

const GARMENT_AFTER = /^(polo|polos|jacket|jackets|gilet|gilets|midlayer|midlayers|hoodie|hoodies|top|tops|trousers|shorts|joggers|one)\b/;
const LETTER = '(xxs|xs|xl|xxl|xxxl|[2-5]xl|x-?large|extra large|extra small|small|medium|large|s|m|l)';

/**
 * The size a request asks for, as the catalogue writes it: "in XL", "size
 * large", "an XL polo", "2XL", "a 34 waist", "size 12". Letters that are also
 * ordinary words (s, m, l, small, medium, large) only count where they can
 * only be a size - after "in" or "size", or right before a garment.
 */
export function sizeInRequest(text: string): string | undefined {
  const lower = ` ${text.toLowerCase().replace(/[’']/g, '')} `;
  const waist = /\b(\d{2})\s?(?:"|in|inch|inches)?\s?waist\b|\bwaist\s?(?:size\s?)?(?:of\s|is\s)?(\d{2})\b/.exec(lower);
  if (waist) return waist[1] ?? waist[2];
  const numbered = /\b(?:size|uk)\s+(\d{1,2})\b(?!\s?(?:cm|mm|kg|inch|in\b|"))/.exec(lower);
  if (numbered) return numbered[1];
  const pattern = new RegExp(`\\b(in size|in an?|in|size|an?)\\s+${LETTER}\\b(?!\\s?(?:cm|kg))`, 'g');
  for (const match of lower.matchAll(pattern)) {
    const [, prefix, word] = match as unknown as [string, string, string];
    const tail = lower.slice(match.index! + match[0].length).trimStart();
    // After a bare "a", an everyday word is only a size when a garment follows: "a large range" is not.
    const everyday = /^(small|medium|large|s|m|l)$/.test(word);
    if (/^an?$/.test(prefix) && everyday && !GARMENT_AFTER.test(tail)) continue;
    return normaliseSize(word.replace(/-/g, ' ')) ?? undefined;
  }
  const bare = /\b(xs|xl|xxl|xxxl|[2-5]xl|x-?large|extra large|extra small)\b/.exec(lower);
  if (bare) return normaliseSize(bare[1]!.replace(/-/g, ' ')) ?? undefined;
  const before = /\b(small|medium|large)\s+(polo|polos|jacket|jackets|gilet|gilets|midlayer|midlayers|hoodie|hoodies|top|tops)\b/.exec(lower);
  if (before) return normaliseSize(before[1]!) ?? undefined;
  return undefined;
}

/** A request with its size words taken out, so "XL" is not searched for as a word. */
export function withoutSize(text: string, size: string | undefined): string {
  if (!size) return text;
  return text
    .replace(/\b(?:in|size|in size)\s+(?:an?\s+)?(?:xxs|xs|xl|xxl|xxxl|[2-5]xl|x-?large|extra large|extra small|small|medium|large|s|m|l|\d{1,2})\b/gi, ' ')
    .replace(/\b(?:\d{2}\s?(?:"|in|inch|inches)?\s?waist|waist\s?(?:size\s?)?\d{2})\b/gi, ' ')
    .replace(/\b(?:xs|xl|xxl|xxxl|[2-5]xl|x-?large|extra large|extra small)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export type SizeStatus = 'in-stock' | 'sold-out' | 'not-made' | 'other-scale';

function scaleOf(code: string): 'letter' | 'number' {
  return /^\d/.test(code) ? 'number' : 'letter';
}

/**
 * Whether this product can be bought in this size - strictly.
 *
 * Unlike stockedInSize, which lets a product on another size scale through
 * so an outfit keeps its trousers, a customer who asked for XL is only shown
 * what they can buy in XL: a ladies polo sized 8 to 18 is not an XL polo.
 * The option name is not trusted - "Size", "SIZE", "JACKET SIZE", "WAIST
 * SIZE" all appear - only the values are read. A combined size ("L/XL") is
 * that size for either half.
 */
export function sizeStatus(product: Product, size: string): SizeStatus {
  const wanted = sizeKey(normaliseSize(size) ?? size);
  const sizes = sizesOf(product);
  const found = sizes.byKey.get(wanted);
  if (found !== undefined) return found ? 'in-stock' : 'sold-out';
  return sizes.scales.has(scaleOf(wanted)) ? 'not-made' : 'other-scale';
}

const sizeKey = (value: string) => value.trim().toUpperCase();

/**
 * Every size a product is made in, and whether any variant in it can be
 * bought - read once per product. Checking each variant's option text on
 * every search took a sized search of the polos from 5ms to 55ms, on the one
 * thread every customer shares. A changed product is a new object, so this
 * is never stale.
 */
const sizeCache = new WeakMap<Product, { byKey: Map<string, boolean>; scales: Set<'letter' | 'number'> }>();

function sizesOf(product: Product): { byKey: Map<string, boolean>; scales: Set<'letter' | 'number'> } {
  let cached = sizeCache.get(product);
  if (!cached) {
    const byKey = new Map<string, boolean>();
    const scales = new Set<'letter' | 'number'>();
    for (const variant of product.variants) {
      for (const value of Object.values(variant.options)) {
        // "L/XL" is that size for either half; "M" and "Medium" are one size.
        const keys = new Set([value, ...value.split('/')].map((part) => sizeKey(normaliseSize(part) ?? part)));
        for (const key of keys) {
          byKey.set(key, (byKey.get(key) ?? false) || variant.available);
          scales.add(scaleOf(key));
        }
      }
    }
    cached = { byKey, scales };
    sizeCache.set(product, cached);
  }
  return cached;
}
