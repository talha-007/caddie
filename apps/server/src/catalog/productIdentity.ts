import { isPlaceholder } from './sellable.js';
import type { Product } from '@caddie/shared';
import { env } from '../env.js';
import { parseRange, rangeOf, type Range } from './audience.js';
import { matchesColourText, parseColours } from './colour.js';
import { garmentName } from './colourways.js';
import { SPELLING_VARIANTS, singular, wordSimilarity } from './identity.js';
import { namingWords } from './lookup.js';
import { allProducts, catalogueVersion } from './sync.js';
import { GARMENT_WORDS } from './taxonomy.js';

/**
 * Which product the customer named - read from their words, and only theirs.
 *
 * "Add the One Pair Tour Ankle Socks to my basket" went in as LADIES TOUR
 * ANKLE SOCKS. The model searched "tour ankle socks"; the name lookup read
 * the model's words, dropped "one" as filler, and picked the design whose
 * name had exactly two words left. Every product-taking tool had its own way
 * of deciding what a name meant, and none of them read the customer.
 *
 * This is the one reader. A design is named when every word of its name is
 * in what they said - title words kept as they are, "one", "pair", "golf"
 * and "plain" included. Colour picks the colourway, never the design. The
 * main range (mens) needs no word of its own; LADIES and JUNIOR do, so
 * "tour ankle socks" never quietly means the ladies pair. Fewer words than a
 * full name can still name one design when only one fits; when several fit,
 * it is ambiguous, and nothing is chosen for them.
 *
 * The model's words may help find products. They never decide which product
 * the customer meant.
 */

export type IdentitySource = 'customer-words' | 'offer';

export interface NamedDesign {
  /** "ONE PAIR TOUR ANKLE SOCKS" - the title before the colourway. */
  design: string;
  range: Range;
  /** Its colourways, in catalogue order. */
  products: Product[];
}

export type CustomerIdentity =
  | { status: 'exact'; product: Product; design: string; source: IdentitySource; how: 'full name' | 'only match' }
  | {
      status: 'family';
      design: string;
      products: Product[];
      colour?: string;
      /** They asked for a colour this design is not made in ("a black Apex polo" - the Apex is blush). */
      colourMissing?: boolean;
      source: IdentitySource;
      how: 'full name' | 'only match';
    }
  | { status: 'ambiguous'; designs: NamedDesign[]; source: IdentitySource }
  | { status: 'none' };

interface Design extends NamedDesign {
  /** Every word that must be said for a full match (version numbers and the main-range word are optional). */
  required: string[];
  /** Every word of the design's name, normalised. */
  tokens: Set<string>;
  /** Words that make it a name - a design with none ("GOLF POLO") is never named, only described. */
  naming: string[];
  garments: Set<string>;
}

/** Range words, read as one: "women's", "womens" and "ladies" are the same word here. */
const RANGE_WORD: Record<string, string> = {
  ladies: 'ladies', lady: 'ladies', women: 'ladies', womens: 'ladies', woman: 'ladies', womans: 'ladies',
  men: 'mens', mens: 'mens', man: 'mens',
  kids: 'kids', kid: 'kids', junior: 'kids', juniors: 'kids', boys: 'kids', boy: 'kids', girls: 'kids', girl: 'kids', youth: 'kids', childrens: 'kids', children: 'kids',
};
/** The main range: a mens design needs no range word to be named. */
const MAIN_RANGE_WORD = 'mens';
/** A version number in a name ("CLIMA JACKET 3.0"): said or not, it is the same design. */
const VERSION = /^\d+(\.\d+)?$/;
/**
 * Words too common to name a product on their own, when fewer than the full
 * name is said. "Add a pair of socks" is not the One Pair Tour Ankle Socks.
 * Never dropped from a full name - only not enough, alone, to pick one.
 */
const WEAK = new Set(['pair', 'pairs', 'set', 'pack', 'one', 'two', 'three', 'new', 'plain', 'golf', 'classic', 'original', 'druid', 'druids']);

/** Lower case, apostrophes out, split on anything but letters, digits and a decimal point; spelling variants; singular. */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, '')
    .split(/[^a-z0-9.]+/)
    .map((word) => word.replace(/^\.+|\.+$/g, ''))
    .filter(Boolean)
    .map((word) => SPELLING_VARIANTS[word] ?? word)
    .map((word) => RANGE_WORD[word] ?? singular(word));
}

const GARMENTS = new Set([...GARMENT_WORDS].map((word) => singular(word)));

let index: { version: number; size: number; designs: Design[]; vocabulary: Set<string> } | null = null;

/** Every design in the catalogue (brand products only), built once per catalogue change. */
function designs(): { designs: Design[]; vocabulary: Set<string> } {
  // Sellable products only: "the polo looks good" once matched the £0 placeholder "LOOK 1" (journey test, 29 Sep).
  const products = allProducts().filter((product) => !isPlaceholder(product));
  const version = catalogueVersion();
  if (index && index.version === version && index.size === products.length) return index;
  const tag = env.shopify.brandTag?.toLowerCase();
  const groups = new Map<string, Product[]>();
  for (const product of products) {
    if (tag && !product.tags.some((value) => value.toLowerCase() === tag)) continue;
    const key = `${rangeOf(product)}|${garmentName(product.title).toUpperCase()}`;
    groups.set(key, [...(groups.get(key) ?? []), product]);
  }
  const list: Design[] = [];
  const vocabulary = new Set<string>();
  for (const [key, members] of groups) {
    const design = key.slice(key.indexOf('|') + 1);
    const words = tokens(design);
    const naming = namingWords(design.toLowerCase()).map((word) => RANGE_WORD[word] ?? singular(word));
    /*
     * A name made only of ordinary words ("GOLF POLO") is a description, never
     * a name - unless it is a long one, said in full: "golf tee polo" is the
     * GOLF TEE POLO. Such a design is matched only by its full name.
     */
    if (naming.length === 0 && words.filter((word) => !VERSION.test(word)).length < 3) continue;
    words.forEach((word) => vocabulary.add(word));
    list.push({
      design,
      range: rangeOf(members[0]!),
      products: members,
      tokens: new Set(words),
      required: words.filter((word) => !VERSION.test(word) && word !== MAIN_RANGE_WORD),
      naming,
      garments: new Set(words.filter((word) => GARMENTS.has(word))),
    });
  }
  index = { version, size: products.length, designs: list, vocabulary };
  return index;
}

/**
 * Their words, with a misspelt name word read as the catalogue's - only when
 * one catalogue word is clearly meant ("galatic" is GALACTIC; "hexi" is one
 * edit from both HEXA and HEXIE, and is left alone).
 */
function saidWords(text: string, vocabulary: Set<string>): Set<string> {
  const said = new Set(tokens(text));
  for (const word of [...said]) {
    if (vocabulary.has(word) || GARMENTS.has(word) || word.length < 4 || VERSION.test(word)) continue;
    const close = [...vocabulary].filter((known) => !GARMENTS.has(known) && wordSimilarity(word, known) === 'strong');
    if (close.length === 1) said.add(close[0]!);
  }
  return said;
}

/**
 * What the customer's words name. `text` is their own message; `source` says
 * whose words they were when the same reader is used on the Caddie's offer
 * ("Shall I add the Elite Polo in navy?").
 */
export function resolveCustomerProductIdentity(text: string, source: IdentitySource = 'customer-words'): CustomerIdentity {
  const said = text.trim();
  if (!said) return { status: 'none' };
  const { designs: all, vocabulary } = designs();
  const words = saidWords(said, vocabulary);
  const saidRange = parseRange(said).range ?? undefined;
  const colours = parseColours(said).colours.map((colour) => colour.word);

  // A full name: every word of it said. The most specific name said wins ("One Pair Tour Ankle Socks" over "Tour Ankle Socks").
  const full = all.filter((design) => design.required.every((word) => words.has(word)));
  let chosen: Design[] = [];
  let how: 'full name' | 'only match' = 'full name';
  if (full.length) {
    const most = Math.max(...full.map((design) => design.required.length));
    chosen = full.filter((design) => design.required.length === most);
  } else {
    /*
     * Fewer words than a full name: every naming word they said must be in
     * the design's name, and a garment they named must be its garment. Two
     * naming words, or one with its garment, before it counts at all - "a
     * pair of socks" names nothing.
     */
    const naming = namingWords(said.toLowerCase())
      .flatMap((word) => [...saidWords(word, vocabulary)])
      .map((word) => RANGE_WORD[word] ?? word)
      .filter((word) => vocabulary.has(word) && !GARMENTS.has(word) && !Object.values(RANGE_WORD).includes(word));
    const strong = naming.filter((word) => !WEAK.has(word));
    if (strong.length === 0) return { status: 'none' };
    const garments = [...words].filter((word) => GARMENTS.has(word));
    if (naming.length < 2 && garments.length === 0) return { status: 'none' };
    how = 'only match';
    chosen = all.filter(
      (design) =>
        design.naming.length > 0 &&
        naming.every((word) => design.tokens.has(word)) &&
        (garments.length === 0 || garments.some((garment) => design.garments.has(garment))),
    );
  }
  // The range they said decides between ranges; nothing else does.
  if (saidRange && chosen.length > 1) {
    const inRange = chosen.filter((design) => design.range === saidRange);
    if (inRange.length) chosen = inRange;
  }
  if (chosen.length === 0) return { status: 'none' };
  if (chosen.length > 1) return { status: 'ambiguous', designs: chosen.map(({ design, range, products }) => ({ design, range, products })), source };

  const design = chosen[0]!;
  // Colour picks the colourway: one left is the exact product; none or several leave the design.
  const colour = colours.length ? colours.join(' or ') : undefined;
  const inColour = colour ? design.products.filter((product) => matchesColourText(product, colour) > 0) : design.products;
  if (inColour.length === 1) return { status: 'exact', product: inColour[0]!, design: design.design, source, how };
  // One colourway, and it is the colour they asked for or they asked for none: that product.
  if (design.products.length === 1 && (!colour || inColour.length === 1)) return { status: 'exact', product: design.products[0]!, design: design.design, source, how };
  return {
    status: 'family',
    design: design.design,
    products: inColour.length ? inColour : design.products,
    ...(colour ? { colour } : {}),
    ...(colour && inColour.length === 0 ? { colourMissing: true } : {}),
    source,
    how,
  };
}

/** The products an identity allows: the one, or every colourway of the design (in the colour asked, if any). */
export function identityProducts(identity: CustomerIdentity): Product[] {
  if (identity.status === 'exact') return [identity.product];
  if (identity.status === 'family') return identity.products;
  if (identity.status === 'ambiguous') return identity.designs.flatMap((design) => design.products);
  return [];
}

/** Every colourway of the design a product belongs to - "it" after naming the design allows any of them. */
export function designMembers(product: Product): Product[] {
  const { designs: all } = designs();
  const key = garmentName(product.title).toUpperCase();
  const range = rangeOf(product);
  return all.find((design) => design.design === key && design.range === range)?.products ?? [product];
}

/** For logs: "exact ONE PAIR TOUR ANKLE SOCKS - WHITE", "ambiguous: A | B". */
export function describeIdentity(identity: CustomerIdentity): string {
  switch (identity.status) {
    case 'exact':
      return `exact ${identity.product.title}`;
    case 'family':
      return `family ${identity.design}${identity.colour ? ` in ${identity.colour}` : ''}`;
    case 'ambiguous':
      return `ambiguous: ${identity.designs.map((design) => `${design.design} (${design.range})`).join(' | ')}`;
    default:
      return 'none';
  }
}
