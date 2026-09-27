import type { Money, Product, ProductOption, ProductVariant } from '@caddie/shared';
import { categoryForProduct } from '../recommend/size.js';
import { normaliseSize, optionValueMatches } from '../recommend/sizeWords.js';
import { attributesOf, shapesOf, strongerOf, type Feature, type ProductFit } from './attributes.js';
import { rangeOf, type Range } from './audience.js';
import { colourWordsOf, matchesColourText } from './colour.js';
import { colourwayName, garmentName, otherColourways } from './colourways.js';
import { categoriesOf, sizeStatus, type Category, type SizeStatus } from './constraints.js';
import { productById } from './sync.js';

/**
 * Commerce truth: what a catalogue product is, answered once.
 *
 * Search, product questions, sizing, packs, outfits, the basket and the reply
 * checker each used to read the same Shopify fields their own way - kinds
 * from their own word lists, "one size" from their own option counts, the
 * variant bought from their own matching, a price from whichever variant
 * came first. They disagreed at the edges, and the edges are where a
 * customer is told something untrue. Each factual question now has one
 * answer here, built on the readers that were already right:
 *
 *   identity    designTitle, designName, colourwayOf, colourwaysOf
 *   kind        productKinds, primaryKind, kindGroup   (constraints.ts)
 *   range       productRange                            (audience.ts)
 *   colour      productColourWords, matchesColour       (colour.ts)
 *   attributes  featureState, commerceAttributes        (attributes.ts)
 *   sizes       sizeScale, availableSizes, supportsSize, nothingToChoose
 *   variant     resolveVariant
 *   stock       variantAvailable, isBuyable
 *   price       variantPrice, formatMoney               (recommend/pricing.ts
 *               keeps priceFor/priceRange/totalFor, the policy for a
 *               product whose variant is not pinned yet)
 *
 * Catalogue truth only. What the customer meant - "the navy one", "a jumper"
 * - is the intent resolvers' (catalog/productIdentity.ts, categoriesAsked);
 * whether a product suits their weather is the ranking's (recommend/rank.ts,
 * WEATHER_NEEDS). Nothing here reads the model.
 */

/* ---------------- identity ---------------- */

export function commerceProduct(id: string): Product | null {
  return productById(id);
}

/** "CLIMA JACKET 3.0 - NAVY" -> "CLIMA JACKET 3.0": the design, as Druids write it. */
export function designTitle(title: string): string {
  const dash = title.lastIndexOf(' - ');
  return (dash >= 0 ? title.slice(0, dash) : title).trim();
}

/** The design as a key: lower case, single spaces - how colourways are grouped. */
export function designName(product: Product | string): string {
  return garmentName(typeof product === 'string' ? product : product.title);
}

/** Whether two products are one design (colourways of each other, or the same product). */
export function sameDesign(a: Product, b: Product): boolean {
  return a.id === b.id || (designName(a) === designName(b) && rangeOf(a) === rangeOf(b));
}

/** "NAVY / WHITE" - the colourway in the title. */
export function colourwayOf(product: Product): string {
  return colourwayName(product.title);
}

/** This product and its other colourways that can be bought, same range. */
export function colourwaysOf(product: Product): Product[] {
  return [product, ...otherColourways(product)];
}

/* ---------------- kind ---------------- */

/** The kinds a product is, from its product type first and its title only as a fallback (constraints.ts). */
export function productKinds(product: Product): Category[] {
  return [...categoriesOf(product)];
}

/** The narrowest kind: a hoodie typed MIDLAYERS is a hoodie, a visor typed CAPS a visor. */
const NARROWER: Category[] = ['hoodie', 'visor', 'skort', 'gilet'];
export function primaryKind(product: Product): Category | undefined {
  const kinds = productKinds(product);
  return kinds.find((kind) => NARROWER.includes(kind)) ?? kinds[0];
}

/** Where a kind sits in a look - the one grouping best picks and outfits both use. */
export type KindGroup = 'top' | 'bottom' | 'layer' | 'headwear' | 'belt' | 'socks' | 'shoes' | 'dress';
const GROUP: Record<Category, KindGroup> = {
  polo: 'top',
  baselayer: 'top',
  midlayer: 'layer',
  hoodie: 'layer',
  jacket: 'layer',
  gilet: 'layer',
  trousers: 'bottom',
  shorts: 'bottom',
  skort: 'bottom',
  dress: 'dress',
  cap: 'headwear',
  visor: 'headwear',
  beanie: 'headwear',
  hat: 'headwear',
  belt: 'belt',
  socks: 'socks',
  shoes: 'shoes',
};
export function kindGroup(kind: Category): KindGroup {
  return GROUP[kind];
}
export function productGroups(product: Product): KindGroup[] {
  return [...new Set(productKinds(product).map(kindGroup))];
}

/* ---------------- range ---------------- */

/** The product's own range - never the range the customer is shopping (shopper/facts.ts has that). */
export function productRange(product: Product): Range {
  return rangeOf(product);
}

/* ---------------- colour ---------------- */

/** The colour words of a product's colourways - title and Colour option, in stock only unless asked. */
export function productColourWords(product: Product, inStockOnly = true): string[] {
  return colourWordsOf(product, inStockOnly);
}

/** Whether the product answers a colour asked for, as free text ("navy", "plain white"). */
export function matchesColour(product: Product, colour: string | undefined): boolean {
  return matchesColourText(product, colour) > 0;
}

/* ---------------- attributes ---------------- */

/**
 * What its own text says of a feature: stated, explicitly denied ("not
 * waterproof"), or not stated. Silence is never "no" - "I can't confirm
 * that" is the honest answer, and it is a different one.
 */
export type FactState = 'yes' | 'no' | 'unknown';

export function featureState(product: Product, feature: Feature): FactState {
  const { features, denied } = attributesOf(product);
  if (features.includes(feature)) return 'yes';
  // Waterproof covers water-resistant; water-resistant says nothing of waterproof.
  if (feature === 'water-resistant' && features.includes('waterproof')) return 'yes';
  return denied.includes(feature) ? 'no' : 'unknown';
}

export interface CommerceAttributes {
  /** Stated features only. Anything else is not stated - see featureState. */
  features: Feature[];
  /** Explicitly denied. */
  denied: Feature[];
  /** The cut, only when its own text states one. */
  fit?: ProductFit;
  /** Shapes its own title, type or description support: sleeveless, hooded, quarter zip... */
  shapes: string[];
  /** Words that say more than warm, stated: insulated, thermal, padded... */
  stronger: string[];
  materials: string[];
}

export function commerceAttributes(product: Product): CommerceAttributes {
  const own = attributesOf(product);
  return {
    features: own.features,
    denied: own.denied,
    ...(own.fit ? { fit: own.fit } : {}),
    shapes: shapesOf(product),
    stronger: strongerOf(product),
    materials: own.materials,
  };
}

/* ---------------- sizes ---------------- */

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

/** Nothing to choose at all - no option with more than one value. A colourway product with one size is this. */
export function nothingToChoose(product: Product): boolean {
  return product.options.every((option) => option.values.length <= 1);
}

/** The sizes of its main size dimension that can be bought now. */
export function availableSizes(product: Product): string[] {
  const main = sizeScale(product).dimensions.find((dimension) => dimension.scale !== 'leg');
  if (!main) return [];
  return main.values.filter((value) => product.variants.some((variant) => variant.available && variant.options[main.option] === value));
}

/** Whether it can be bought in this size: in stock, sold out, not made, or sized on another scale (constraints.ts). */
export function supportsSize(product: Product, size: string): SizeStatus {
  return sizeStatus(product, size);
}

/* ---------------- variant ---------------- */

export type VariantResolution =
  | { status: 'exact'; variant: ProductVariant }
  /** An option with a choice was not chosen. */
  | { status: 'incomplete'; missing: ProductOption[] }
  /** Everything chosen, and still more than one variant fits ("L" on a belt made in M/L and L/XL). */
  | { status: 'ambiguous'; variants: ProductVariant[] }
  /** The choices name no variant this product is made in. */
  | { status: 'invalid' };

/**
 * The one variant the customer's choices name - or why there is not one.
 * Never the first variant: Shopify returns a default whether or not anything
 * was chosen. Option names are matched without regard to case; values as
 * the catalogue writes them, "medium" for M, and a combined size ("M/L")
 * for either of its halves - the catalogue's own value says it is both.
 */
export function resolveVariant(product: Product, selected: Record<string, string> = {}): VariantResolution {
  const chosen = choices(selected);
  const missing = product.options.filter((option) => option.values.length > 1 && !chosen.has(option.name.toLowerCase()));
  if (missing.length) return { status: 'incomplete', missing };
  const matching = variantsMatching(product, selected);
  if (matching.length === 0) return { status: 'invalid' };
  if (matching.length > 1) return { status: 'ambiguous', variants: matching };
  return { status: 'exact', variant: matching[0]! };
}

function choices(selected: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(selected).filter(([, value]) => value?.trim()).map(([name, value]) => [name.toLowerCase(), value]));
}

/**
 * The variants these choices allow - complete or not. One matching rule for
 * every caller: option names without regard to case, values as the catalogue
 * writes them or by size name ("medium" is M), a combined size ("M/L") for
 * either half - and where a value matches exactly, the combined values that
 * merely contain it give way.
 */
export function variantsMatching(product: Product, selected: Record<string, string> = {}): ProductVariant[] {
  const chosen = choices(selected);
  const valueOf = (variant: ProductVariant, name: string) => Object.entries(variant.options).find(([own]) => own.toLowerCase() === name)?.[1];
  const matching = product.variants.filter((variant) =>
    [...chosen].every(([name, value]) => {
      const held = valueOf(variant, name);
      return held !== undefined && optionValueMatches(held, value);
    }),
  );
  if (matching.length <= 1) return matching;
  const exact = matching.filter((variant) => [...chosen].every(([name, value]) => (valueOf(variant, name) ?? '').toLowerCase() === value.toLowerCase()));
  // Exact values that still leave several (a colour open) are the narrowing; none exact, the combined matches stand.
  return exact.length ? exact : matching;
}

/* ---------------- stock ---------------- */

/** Whether this exact variant can be bought now - the mirror can be up to a minute behind Shopify. */
export function variantAvailable(variant: ProductVariant): boolean {
  return variant.available;
}

/** Whether any variant can be bought. Not the same as the one they want being in stock. */
export function isBuyable(product: Product): boolean {
  return product.variants.some(variantAvailable);
}

/** A variant to price or check a product by when none is chosen: the first that can be bought, never a sold-out one. */
export function firstBuyableVariant(product: Product): ProductVariant | undefined {
  return product.variants.find(variantAvailable);
}

/* ---------------- price ---------------- */

/** The price of this exact variant - the one the card, the reply and the basket all quote. */
export function variantPrice(variant: ProductVariant): Money {
  return variant.price;
}

/** Shopify's "was" price, when set above the price. Loaded, never used to claim a saving on its own. */
export function variantCompareAt(variant: ProductVariant): Money | undefined {
  const was = variant.compareAtPrice;
  return was && was.amount > variant.price.amount ? was : undefined;
}

const SYMBOL: Record<string, string> = { GBP: '£', USD: '$', EUR: '€' };

export function currencySymbol(currency: string): string {
  return SYMBOL[currency] ?? `${currency} `;
}

/**
 * £42.00 - the one money format for anything a customer reads. `short`
 * drops ".00" from a whole amount (£50), for budgets said as round figures.
 */
export function formatMoney(amount: number, currency: string, opts: { short?: boolean } = {}): string {
  const shown = opts.short && Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  return `${currencySymbol(currency)}${shown}`;
}

/* ---------------- sizing chart ---------------- */

/**
 * The Druids chart a product is sized on: from its catalogue kind first (a
 * hoodie typed MIDLAYERS is a midlayer on the chart, a skort not shorts), and
 * from its type and title words only when no kind is known.
 */
export function chartCategoryOf(product: Product, audience: 'men' | 'women'): string | undefined {
  const kind = primaryKind(product);
  return (kind ? categoryForProduct(audience, kind) : undefined) ?? categoryForProduct(audience, `${product.productType ?? ''} ${product.title}`);
}

/** The option a size is chosen in - "Size", "JACKET SIZE", "WAIST SIZE" - or null when there is no size to choose. */
export function sizeOptionName(product: Product): string | null {
  return sizeScale(product).dimensions.find((dimension) => dimension.scale !== 'leg')?.option ?? null;
}
