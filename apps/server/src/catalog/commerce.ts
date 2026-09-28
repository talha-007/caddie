import type { Money, Product, ProductOption, ProductVariant } from '@caddie/shared';
import { categoryForProduct } from '../recommend/size.js';
import { normaliseSize, optionValueMatches } from '../recommend/sizeWords.js';
import { attributesOf, shapesOf, strongerOf, type Feature, type ProductFit } from './attributes.js';
import { rangeOf, type Range } from './audience.js';
import { colourWordsOf, matchesColourText } from './colour.js';
import { colourwayName, garmentName, otherColourways } from './colourways.js';
import { categoriesOf, scaleOfSize, sizeScale, sizeStatus, type Category, type SizeScaleKind, type SizeStatus } from './constraints.js';
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

// The size scales and the one size check live beside the size reader (constraints.ts); this is where every caller finds them.
export { optionScale, sizeScale, type SizeDimension, type SizeScale, type SizeScaleKind } from './constraints.js';

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

/** Whether it can be bought in this size: in stock, sold out, not made, sized on another scale, or no such size applies (constraints.ts). */
export function supportsSize(product: Product, size: string): SizeStatus {
  return sizeStatus(product, size);
}

/** Whether a size says anything about this product - it does unless no size of that kind applies to it. */
export function sizeApplies(product: Product, size: string): boolean {
  const status = sizeStatus(product, size);
  return status === 'in-stock' || status === 'sold-out' || status === 'not-made';
}

/* ---------------- offerability ---------------- */

/**
 * Whether a product may be put in front of the customer as something to buy
 * - the one card eligibility decision, for every card, recommendation, pack
 * piece, replacement, outfit piece and cross-sell (V1 hardening task 1).
 *
 *   eligible            a size of theirs applies and that exact variant can
 *                       be bought; or none applies and some variant can
 *   not-eligible        the size of theirs that applies is sold out or not
 *                       made; or nothing can be bought at all
 *   informational-only  not eligible, but they named it themselves: it may
 *                       be talked about ("sold out in S"), never offered
 *
 * Their sizes come in priority order (tools/eligibility.ts buyingSizes). Each
 * applies only on the product's own scale: an M says nothing about a cap in
 * one size, a 32 waist nothing about a polo, and a top size nothing about a
 * belt made in M/L and L/XL. The first size that applies to a dimension is
 * the one it is judged in.
 */
export type Offerability = 'eligible' | 'not-eligible' | 'informational-only';

export interface OfferDecision {
  offer: Offerability;
  /** The sizes it was judged in, by option - empty when none of theirs applies. */
  sizes: Record<string, string>;
  /** Why it is not eligible: "sold out", "sold out in S", "not made in 3XL". */
  reason?: string;
  /**
   * Which: nothing buyable at all, their size sold out, or their size not
   * made. A pack asks about a size its pieces are not made in ("the trousers
   * don't come in a 36 leg - 30, 32 or 34?") rather than dropping the piece;
   * a sold-out one it never shows.
   */
  why?: 'unavailable' | 'sold-out' | 'not-made';
}

/**
 * One of the customer's sizes, and the dimension it was given for when that
 * is known: a 34 given as a leg is never judged as a 34 waist.
 */
export interface BuyingSize {
  size: string;
  as?: 'top' | 'waist' | 'leg';
}

export function offerability(product: Product, given: Array<string | BuyingSize> = [], opts: { named?: boolean } = {}): OfferDecision {
  const sizes = given.map((entry) => (typeof entry === 'string' ? { size: entry } : entry));
  const notEligible = (reason: string, judged: Record<string, string>, why: OfferDecision['why']): OfferDecision => ({ offer: opts.named ? 'informational-only' : 'not-eligible', sizes: judged, reason, why });
  if (!isBuyable(product)) return notEligible('sold out', {}, 'unavailable');
  // One value per size dimension - the first of theirs that is on that dimension's scale.
  const judged: Record<string, string> = {};
  for (const dimension of sizeScale(product).dimensions) {
    const own = sizes.find((entry) => dimensionTakes(dimension, entry));
    if (own) judged[dimension.option] = dimension.values.find((value) => sameSizeValue(value, own.size)) ?? own.size;
  }
  const entries = Object.entries(judged);
  if (!entries.length) return { offer: 'eligible', sizes: {} };
  const said = entries.map(([, value]) => value).join(' / ');
  // Every judged value must be one the product is made in.
  const made = entries.every(([name]) => sizeScale(product).dimensions.find((dimension) => dimension.option === name)!.values.some((value) => sameSizeValue(value, judged[name]!)));
  if (!made) return notEligible(`not made in ${said}`, judged, 'not-made');
  const exact = product.variants.some((variant) => variant.available && entries.every(([name, value]) => sameSizeValue(variant.options[name] ?? '', value)));
  return exact ? { offer: 'eligible', sizes: judged } : notEligible(`sold out in ${said}`, judged, 'sold-out');
}

/** Whether a size is on this dimension's scale: an M on a lettered dimension, a 32 on a waist - never an M on a belt's M/L. */
function dimensionTakes(dimension: { scale: string; values: string[] }, { size, as }: BuyingSize): boolean {
  if (as === 'leg') return dimension.scale === 'leg';
  if (dimension.scale === 'leg') return false;
  if (as === 'waist') return dimension.scale === 'waist';
  const kind = sizeKindOf(size);
  if (!kind || (as === 'top' && kind === 'waist')) return false;
  if (dimension.scale === 'combined') return kind === 'combined' && dimension.values.some((value) => sameSizeValue(value, size));
  if (dimension.scale === 'other') return dimension.values.some((value) => sameSizeValue(value, size));
  return dimension.scale === kind;
}

/** The scale a customer's size is on - the one reader, beside the size check (constraints.ts). */
export function sizeKindOf(size: string): SizeScaleKind | null {
  return scaleOfSize(normaliseSize(size) ?? size.trim());
}

/** One size value as another - "M" and "Medium", "2XL" and "XXL" - exactly: a combined "M/L" is never an M here. */
function sameSizeValue(a: string, b: string): boolean {
  const key = (value: string) => (normaliseSize(value.trim()) ?? value.trim()).toUpperCase();
  return key(a) === key(b);
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
