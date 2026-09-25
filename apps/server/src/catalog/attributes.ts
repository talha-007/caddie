import type { Product } from '@caddie/shared';

/**
 * What a product is verifiably like, read from Shopify's own words.
 *
 * The live store has no structured merchandising fields - no metafields for
 * fit, fabric or weather - but the descriptions say a great deal: of 144
 * products sampled, 82 mention stretch, 73 breathable, 71 moisture-wicking and
 * 17 waterproof. Selling on those is selling on what Druids wrote. Selling on
 * anything else - "this polo is perfect for rain" because it is navy - is the
 * Caddie making up product facts, so nothing here is inferred from a colour,
 * an image, a price or a neighbouring product.
 *
 * Deliberately narrow patterns. "Rain" alone is not waterproof ("rain or
 * shine"), "warm" alone is not warm ("keeps you cool on warm days"), and a
 * "not waterproof" in the text is the opposite of what the word says.
 */

export type Feature =
  | 'waterproof'
  | 'water-resistant'
  | 'windproof'
  | 'breathable'
  | 'moisture-wicking'
  | 'quick-dry'
  | 'stretch'
  | 'lightweight'
  | 'warm'
  | 'uv-protection'
  | 'hooded'
  | 'quarter-zip'
  | 'full-zip';

export type ProductFit = 'athletic' | 'slim' | 'tailored' | 'regular' | 'relaxed';

export interface ProductAttributes {
  features: Feature[];
  fit?: ProductFit;
  /** "90% polyester", as written. */
  materials: string[];
}

/** What a customer hears: "waterproof", "moisture-wicking". */
export const FEATURE_LABEL: Record<Feature, string> = {
  waterproof: 'waterproof',
  'water-resistant': 'water-resistant',
  windproof: 'windproof',
  breathable: 'breathable',
  'moisture-wicking': 'moisture-wicking',
  'quick-dry': 'quick-drying',
  stretch: 'stretchy',
  lightweight: 'lightweight',
  warm: 'warm',
  'uv-protection': 'UV protection',
  hooded: 'hooded',
  'quarter-zip': 'quarter-zip',
  'full-zip': 'full-zip',
};

const PRODUCT_PATTERNS: Array<[Feature, RegExp]> = [
  // The word itself only. A "RAINSUIT" whose description never says
  // waterproof is not called waterproof: that would be reading it off the name.
  ['waterproof', /\bwater ?proof(ed|ing)?\b/],
  ['water-resistant', /\bwater[- ]?(resistant|repellent|repellant)\b|\bshower ?proof\b|\bdwr\b/],
  ['windproof', /\bwind ?proof\b|\bwind[- ]?(resistant|resistance|cheating|blocking)\b/],
  ['breathable', /\bbreathab(le|ility)\b/],
  ['moisture-wicking', /\bmoisture[- ]?(wicking|management|managing)\b|\bwicks? (away )?(moisture|sweat)\b|\bsweat[- ]?wicking\b/],
  ['quick-dry', /\bquick[- ]?dry(ing)?\b|\bfast[- ]?dry(ing)?\b/],
  ['stretch', /\bstretch(y|able)?\b|\belastane\b|\bspandex\b/],
  ['lightweight', /\blight ?weight\b|\bfeather ?light\b/],
  ['warm', /\bthermal\b|\binsulat(ed|ion|ing)\b|\bfleece\b|\bpadded\b|\bkeeps? you warm\b|\bwarmth\b|\bbrushed (back|lining|inner)\b/],
  ['uv-protection', /\bupf ?\d*\b|\buv[- ]?(protection|protective|resistant)\b|\bsun protection\b/],
  ['hooded', /\bhooded\b|\b(detachable|adjustable|removable|packaway|stowaway|peaked|integrated) hood\b|\bwith (a |an )?hood\b/],
  ['quarter-zip', /\bquarter[- ]zip\b|\b1\/4[- ]?zip\b|\bhalf[- ]zip\b|\b1\/2[- ]?zip\b/],
  ['full-zip', /\bfull[- ]zip\b/],
];

const FIT_PATTERNS: Array<[ProductFit, RegExp]> = [
  ['athletic', /\bathletic (fit|cut)\b/],
  ['slim', /\bslim[- ]?(fit|cut)\b/],
  ['tailored', /\btailored (fit|cut)\b/],
  ['relaxed', /\b(relaxed|loose|generous|roomy) (fit|cut)\b/],
  ['regular', /\b(regular|classic|standard) (fit|cut)\b/],
];

const MATERIAL = /\b(\d{1,3})\s?%\s?(recycled polyester|polyester|spandex|elastane|nylon|polyamide|cotton|wool|merino|acrylic|viscose|bamboo)\b/g;

/** A match that is preceded by a negation says the opposite. */
function negated(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 14), index);
  return /\b(not|non|no|isn't|is not|never)[\s-]*$/.test(before);
}

function found(text: string, pattern: RegExp): boolean {
  const global = new RegExp(pattern.source, 'g');
  for (const match of text.matchAll(global)) {
    if (!negated(text, match.index ?? 0)) return true;
  }
  return false;
}

/** Cached per product object; a changed product is a new object. */
const cache = new WeakMap<Product, ProductAttributes>();

export function attributesOf(product: Product): ProductAttributes {
  const hit = cache.get(product);
  if (hit) return hit;

  const text = `${product.title} ${product.productType ?? ''} ${product.description ?? ''}`.toLowerCase();
  const features = PRODUCT_PATTERNS.filter(([, pattern]) => found(text, pattern)).map(([feature]) => feature);
  // Waterproof says more than water-resistant; both listed reads as a hedge.
  const clean = features.includes('waterproof') ? features.filter((f) => f !== 'water-resistant') : features;
  const fit = FIT_PATTERNS.find(([, pattern]) => found(text, pattern))?.[0];
  const materials = [...new Set([...text.matchAll(MATERIAL)].map((m) => `${m[1]}% ${m[2]}`))];

  const attributes: ProductAttributes = { features: clean, materials, ...(fit ? { fit } : {}) };
  cache.set(product, attributes);
  return attributes;
}

/**
 * Features a customer asked for, in their own words.
 *
 * Separate from the product patterns: a customer says "something for the
 * rain" or "keeps me cool", which no description would be matched on.
 */
const ASKED_PATTERNS: Array<[Feature, RegExp]> = [
  ['waterproof', /\bwater ?proofs?\b|\brain ?(top|coat|jacket|suit|gear|wear|trousers|pants)\b|\bfor (the )?rain\b|\bkeeps? (me |you )?dry\b|\bwet (weather|rounds?|days?|conditions)\b/],
  ['water-resistant', /\bwater[- ]?(resistant|repellent)\b|\bshower ?proof\b/],
  ['windproof', /\bwind ?proof\b|\bwind[- ]?(resistant|cheater|breaker)\b|\bfor (the )?wind\b|\bwindy\b/],
  ['breathable', /\bbreathab(le|ility)\b|\bkeeps? (me |you )?cool\b/],
  ['moisture-wicking', /\bwick(ing|s)?\b|\bsweat\b/],
  ['quick-dry', /\bquick[- ]?dry(ing)?\b/],
  ['stretch', /\bstretch(y)?\b|\bfreedom of movement\b|\bmove (easily|freely)\b/],
  ['lightweight', /\blight ?weight\b|\blight\b(?! (blue|grey|gray|green|pink))/],
  ['warm', /\bwarm\b(?! (weather|days?|climate))|\bthermal\b|\binsulated\b|\bcosy\b|\bcozy\b/],
  ['uv-protection', /\buv\b|\bupf\b|\bsun protection\b/],
  ['hooded', /\bhood(ed)?\b/],
  ['quarter-zip', /\bquarter[- ]zip\b|\b1\/4[- ]?zip\b|\bhalf[- ]zip\b/],
  ['full-zip', /\bfull[- ]zip\b/],
];

export function featuresAsked(text: string): Feature[] {
  const lower = text.toLowerCase();
  return ASKED_PATTERNS.filter(([, pattern]) => pattern.test(lower)).map(([feature]) => feature);
}

/**
 * What a kind of weather needs, as features a product can be checked for.
 * Any one of them counts: a gilet that is windproof is a good cold-day piece.
 */
export type Weather = 'wet' | 'cold' | 'hot' | 'windy';

export const WEATHER_NEEDS: Record<Weather, Feature[]> = {
  wet: ['waterproof', 'water-resistant'],
  cold: ['warm', 'windproof'],
  hot: ['lightweight', 'breathable', 'moisture-wicking', 'uv-protection'],
  windy: ['windproof'],
};

/** True when the product satisfies a feature - waterproof also covers water-resistant. */
export function hasFeature(product: Product, feature: Feature): boolean {
  const { features } = attributesOf(product);
  if (features.includes(feature)) return true;
  return feature === 'water-resistant' && features.includes('waterproof');
}
