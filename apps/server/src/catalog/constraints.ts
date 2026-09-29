import type { Product, ProductOption } from '@caddie/shared';
import { foldNonAscii, normaliseSize } from '../recommend/sizeWords.js';
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
  const lower = ` ${foldNonAscii(text.toLowerCase().replace(/[’']/g, ''))} `;
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

/**
 * The size choices a product really has. Druids sizes tops by letter
 * (S-4XL), bottoms by waist and leg, ladies by UK number, belts in combined
 * letters (S/M, L/XL), kids by age, and socks and caps in one size. They
 * are separate scales: an M says nothing about a 34 waist, and a product
 * whose only size is ONE SIZE has no size to choose.
 */
export type SizeScaleKind = 'letter' | 'combined' | 'waist' | 'leg' | 'number' | 'age' | 'other';

export interface SizeDimension {
  option: string;
  scale: SizeScaleKind;
  values: string[];
}

export interface SizeScale {
  /** No size choice at all: one size, or nothing sized. */
  oneSize: boolean;
  dimensions: SizeDimension[];
}

const COLOUR_OPTION = /^(colou?r|colourway|colorway|shade)$/i;
const ONE_SIZE_VALUE = /^(one size( fits (all|most))?|os|osfa|default title)$/i;

/** The scale one option is measured on - null for a colour, or an option that is no size at all. */
export function optionScale(option: ProductOption): SizeScaleKind | null {
  return scaleOfOption(option);
}

function scaleOfOption(option: ProductOption): SizeScaleKind | null {
  if (COLOUR_OPTION.test(option.name)) return null;
  if (/leg|length|inseam/i.test(option.name)) return 'leg';
  const values = option.values.map((value) => value.trim());
  if (/waist/i.test(option.name) || values.every((value) => /^\d{2}$/.test(value) && Number(value) >= 26 && Number(value) <= 48)) return 'waist';
  if (values.every((value) => /^\d{1,2}\s*[/-]\s*\d{1,2}$|^\d{1,2}\s*(yrs?|years?)$/i.test(value))) return 'age';
  if (values.some((value) => /^[a-z0-9]+\s*\/\s*[a-z0-9]+$/i.test(value) && value.split('/').every((half) => normaliseSize(half.trim())))) return 'combined';
  if (values.every((value) => normaliseSize(value) && !/^\d+$/.test(value))) return 'letter';
  if (values.every((value) => /^\d{1,2}$/.test(value))) return 'number';
  return /size/i.test(option.name) ? 'other' : null;
}

const scaleCache = new WeakMap<Product, SizeScale>();

export function sizeScale(product: Product): SizeScale {
  let cached = scaleCache.get(product);
  if (!cached) {
    const dimensions: SizeDimension[] = [];
    for (const option of product.options) {
      const real = option.values.filter((value) => !ONE_SIZE_VALUE.test(value.trim()));
      if (real.length <= 1) continue;
      const scale = scaleOfOption(option);
      if (scale) dimensions.push({ option: option.name, scale, values: option.values });
    }
    cached = { oneSize: dimensions.length === 0, dimensions };
    scaleCache.set(product, cached);
  }
  return cached;
}

/**
 * Whether a product can be bought in a size:
 *
 *   in-stock        made in it, and some variant in it can be bought
 *   sold-out        made in it, none can be bought now
 *   not-made        sized on that scale, but not in that size (3XL of S-2XL)
 *   other-scale     a top size against a top sized another way - an XL
 *                   against a ladies polo in 8-18: not an XL polo
 *   not-applicable  no size of that kind: a cap in one size, a 32 waist
 *                   against a polo, a top size against a belt in M/L
 *
 * Read from the product's size dimensions (sizeScale) only. The values of
 * every option used to be read - colour names and ONE SIZE counted as
 * lettered sizes - so a one-size cap was "not made in M" for a customer
 * whose usual size is M, and hidden from them (preview store).
 */
export type SizeStatus = 'in-stock' | 'sold-out' | 'not-made' | 'other-scale' | 'not-applicable';

/** Sizes worn on the body's top half, on different scales: a letter, a UK number, an age. */
const TOP_SCALES = new Set<SizeScaleKind>(['letter', 'number', 'age']);

export function sizeStatus(product: Product, size: string): SizeStatus {
  const wanted = normaliseSize(size) ?? size.trim();
  const kind = scaleOfSize(wanted);
  const dimensions = sizedDimensions(product);
  if (!kind || !dimensions.length) return 'not-applicable';
  const same = dimensions.filter((dimension) => dimension.scale === kind || (dimension.scale === 'other' && dimension.values.some((value) => sizeKey(value) === sizeKey(wanted))));
  if (same.length) {
    const option = same.find((dimension) => dimension.values.some((value) => sizeKey(value) === sizeKey(wanted)));
    if (!option) return 'not-made';
    return product.variants.some((variant) => variant.available && sizeKey(variant.options[option.option] ?? '') === sizeKey(wanted)) ? 'in-stock' : 'sold-out';
  }
  if (TOP_SCALES.has(kind) && dimensions.some((dimension) => TOP_SCALES.has(dimension.scale))) return 'other-scale';
  return 'not-applicable';
}

const sizeKey = (value: string) => (normaliseSize(value.trim()) ?? value.trim()).toUpperCase();

/** The scale a size is written on: "M" lettered, "32" a waist, "12" a UK number, "7/8" an age, "M/L" combined. */
export function scaleOfSize(size: string): SizeScaleKind | null {
  const text = size.trim();
  if (/^\d{1,2}\s*[/-]\s*\d{1,2}$|^\d{1,2}\s*(yrs?|years?)$/i.test(text)) return 'age';
  if (/^[a-z0-9]+\s*\/\s*[a-z0-9]+$/i.test(text)) return 'combined';
  if (/^\d{2}$/.test(text) && Number(text) >= 26 && Number(text) <= 48) return 'waist';
  if (/^\d{1,2}$/.test(text)) return 'number';
  // A lettered size beyond any we sell ("5XL") is still a lettered size - one it is not made in.
  return normaliseSize(text) || /^(\d?x{0,5}[sl]|m|\dxl)$/i.test(text) ? 'letter' : null;
}

/**
 * The options that are sizes, with their values - the product's own
 * dimensions, and a size it is made in only one of (a polo left in M) as
 * well: that is still an M, where a cap's ONE SIZE is no size at all. Built
 * from the variants when the options are missing (a test's bare variants).
 */
const dimensionCache = new WeakMap<object, SizeDimension[]>();

function sizedDimensions(product: Product): SizeDimension[] {
  let cached = dimensionCache.get(product);
  if (!cached) {
    const options = product.options?.length ? product.options : optionsFromVariants(product.variants ?? []);
    cached = [];
    for (const option of options) {
      const real = option.values.filter((value) => !ONE_SIZE_VALUE.test(value.trim()));
      if (!real.length) continue;
      const scale = scaleOfOption({ name: option.name, values: real });
      if (scale) cached.push({ option: option.name, scale, values: real });
    }
    dimensionCache.set(product, cached);
  }
  return cached;
}

function optionsFromVariants(variants: Array<{ options: Record<string, string> }>): ProductOption[] {
  const byName = new Map<string, string[]>();
  for (const variant of variants) for (const [name, value] of Object.entries(variant.options)) {
    const values = byName.get(name) ?? [];
    if (!values.includes(value)) values.push(value);
    byName.set(name, values);
  }
  return [...byName].map(([name, values]) => ({ name, values }));
}
