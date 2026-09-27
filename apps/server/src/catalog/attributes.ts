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
  /**
   * Features its own text explicitly denies - "not waterproof". The only way
   * a feature is "no": a description that says nothing about it is "not
   * stated", never "no" (catalog/commerce.ts featureState).
   */
  denied: Feature[];
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

/** Said, and every time it is said it is negated: "not waterproof". */
function deniedIn(text: string, pattern: RegExp): boolean {
  const global = new RegExp(pattern.source, 'g');
  const matches = [...text.matchAll(global)];
  return matches.length > 0 && matches.every((match) => negated(text, match.index ?? 0));
}

function found(text: string, pattern: RegExp): boolean {
  const global = new RegExp(pattern.source, 'g');
  for (const match of text.matchAll(global)) {
    if (!negated(text, match.index ?? 0)) return true;
  }
  return false;
}

/**
 * The features and fit a piece of text states, read with the same patterns
 * and the same negation rule as a product description - so a reply is held
 * to exactly the vocabulary its facts were written in.
 */
export function featuresStatedIn(text: string): Feature[] {
  const lower = text.toLowerCase();
  return PRODUCT_PATTERNS.filter(([, pattern]) => found(lower, pattern)).map(([feature]) => feature);
}

export function fitStatedIn(text: string): ProductFit | undefined {
  const lower = text.toLowerCase().replace(/-/g, ' ');
  return FIT_PATTERNS.find(([, pattern]) => found(lower, pattern))?.[0];
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

  const denied = PRODUCT_PATTERNS.filter(([feature, pattern]) => !features.includes(feature) && deniedIn(text, pattern)).map(([feature]) => feature);
  const attributes: ProductAttributes = { features: clean, denied, materials, ...(fit ? { fit } : {}) };
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

/* ---------------- shapes, and words that say more than warm ----------------
 *
 * Moved here from the reply verifier (Phase 4). They are facts about a
 * product read from its own text, so they belong with the other readers of
 * it - and the product-info answer and the verifier now read them from one
 * place instead of the answer importing them from the checker.
 */

/** How reply and product text are compared: lower case, no apostrophes, words only. */
export const normalise = (text: string) => ` ${text.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()} `;

/**
 * Words that say more than "warm": each needs to appear in the product's own
 * text. "Warmly insulated" was said of a gilet whose data states warm and
 * windproof - warm is not insulated, and a salesperson who says so is wrong.
 */
export const STRONGER: Array<[string, RegExp]> = [
  ['insulated', /\binsulat(ed|ion|ing)\b/],
  ['thermal', /\bthermal\b/],
  ['padded', /\bpadd(ed|ing)\b/],
  ['fleece', /\bfleece(d| lined)?\b/],
  ['quilted', /\bquilt(ed|ing)\b/],
  ['packable', /\bpack(able|s away| away)\b/],
];


/*
 * What a garment is shaped like. "The Pure Midlayer in black is warm and
 * sleeveless" - a midlayer with sleeves, offered to someone who asked for
 * something sleeveless. The customer's word is not the product's: each shape
 * needs the product's own title, type or description, read after the same
 * normalising as the reply ("quarter-zip", "1/4 zip" and "quarter zip" are
 * one thing). Nothing is inferred: a zip is not a full zip, a layer is not
 * sleeveless, a collar is not a v-neck, and a polo is not short-sleeved until
 * its data says so.
 */
export interface Shape {
  label: string;
  /** How a reply says it, in normalised text. */
  said: RegExp;
  /** What in the product's own normalised text supports it. `named` is title and type only. */
  shown: (text: { all: string; named: string }) => boolean;
}

export const SHAPES: Shape[] = [
  {
    label: 'sleeveless',
    said: /\bsleeveless\b/,
    // A gilet, vest or body warmer by its own name; "sleeveless" anywhere it describes itself.
    shown: ({ all, named }) => /\bsleeveless\b/.test(all) || /\b(gilets?|vests?|body ?warmers?)\b/.test(named),
  },
  { label: 'long sleeve', said: /\blong sleeve(s|d)?\b/, shown: ({ all }) => /\blong sleeve(s|d)?\b/.test(all) },
  { label: 'short sleeve', said: /\bshort sleeve(s|d)?\b/, shown: ({ all }) => /\bshort sleeve(s|d)?\b/.test(all) },
  {
    label: 'hooded',
    said: /\bhooded\b|\b(has|have|with|comes with|features?|featuring|and) (a |an )?(\w+ )?hood\b/,
    shown: ({ all }) => /\bhood(s|ed|ie|ies)?\b/.test(all),
  },
  { label: 'quarter zip', said: /\bquarter zip(s|ped)?\b|\b1 4 zip\b/, shown: ({ all }) => /\bquarter zip(s|ped)?\b|\b1 4 zip\b/.test(all) },
  { label: 'half zip', said: /\bhalf zip(s|ped)?\b|\b1 2 zip\b/, shown: ({ all }) => /\bhalf zip(s|ped)?\b|\b1 2 zip\b/.test(all) },
  { label: 'full zip', said: /\bfull zip(s|ped)?\b|\bfull length zip(per)?\b/, shown: ({ all }) => /\bfull (length )?zip(s|ped|per)?\b/.test(all) },
  { label: 'zip neck', said: /\bzip neck(ed)?\b/, shown: ({ all }) => /\bzip neck(ed)?\b/.test(all) },
  { label: 'crew neck', said: /\bcrew neck(ed)?\b/, shown: ({ all }) => /\bcrew( neck(ed)?)?\b/.test(all) },
  { label: 'v-neck', said: /\bv neck(ed)?\b/, shown: ({ all }) => /\bv neck(ed)?\b/.test(all) },
];

/** "No sleeves" and "without sleeves" are sleeveless, said another way - and not a negation. */
export const sayShape = (text: string) => text.replace(/\b(no|without) sleeves\b/g, 'sleeveless');

/** The shapes a piece of reply text claims, by label. */
export function shapesSaid(text: string): string[] {
  const said = sayShape(normalise(text));
  return SHAPES.filter((shape) => shape.said.test(said)).map((shape) => shape.label);
}

/** Features whose wording is judged as a shape instead, so a hoodie's title counts. */
export const SHAPE_FEATURES = new Set<string>(['hooded', 'quarter-zip', 'full-zip']);

/** The shapes a product's own data supports - the rule replies are checked against. */
export function shapesOf(product: Product): string[] {
  return SHAPES.filter((shape) => shape.shown(shapeText(product))).map((shape) => shape.label);
}

/** "Insulated", "thermal", "padded"... - the words that say more than warm, as a question or reply uses them. */
export function strongerSaid(text: string): string[] {
  const said = normalise(text);
  return STRONGER.filter(([, pattern]) => pattern.test(said)).map(([word]) => word);
}

/** Which of those a product's own text states. */
export function strongerOf(product: Product): string[] {
  const own = `${product.title} ${product.productType ?? ''} ${product.description ?? ''}`.toLowerCase();
  return STRONGER.filter(([, pattern]) => pattern.test(own)).map(([word]) => word);
}

export function shapeText(product: Product): { all: string; named: string } {
  const named = normalise(`${product.title} ${product.productType ?? ''}`);
  return { all: normalise(`${named} ${product.description ?? ''}`), named };
}

