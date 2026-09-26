import type { Product } from '@caddie/shared';
import { parseRange, rangeOf, type Range } from './audience.js';
import { parseColours } from './colour.js';
import { colourwayName, garmentName } from './colourways.js';
import { GARMENT_WORDS } from './taxonomy.js';

/**
 * What a product is, read from its own Shopify title.
 *
 * Druids lists every colourway as its own product, so a product's identity is
 * its design plus its colour: "ELITE POLO - NAVY" is the Elite Polo design in
 * navy, and "LADIES ELITE POLO - NAVY" is a different product with the same
 * design words. Name matching compared only the distinctive words ("elite"),
 * and "Elite Polo - Navy" matched forty-four products; "black Apex polo"
 * matched the one Apex polo Druids sell - a ladies polo in blush.
 *
 * Nothing here is invented: every field comes from the title (and the handle,
 * when Shopify gave one), through the same colour and range readers search
 * uses.
 */
export interface ProductIdentity {
  /** "elite polo navy" - the whole title, lower case, punctuation gone. */
  title: string;
  /** "elite polo" - the title before its colour, range words included. */
  design: string;
  /** "elite" - the words that make the design a name: not garment, range, colour or size. */
  designWords: string[];
  /** "polo" - what it is, from the garment words in the title. */
  garments: string[];
  /** "navy" - the colourway as Druids name it, lower case; empty when the title has none. */
  colourway: string;
  range: Range;
  /** "elite-polo-navy", when the product carries its handle. */
  handle?: string;
}

/** Lower case, punctuation to spaces, one space between words. */
export function normaliseName(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Words that never make a product's name its own. */
const FILLER = new Set(['the', 'a', 'an', 'my', 'your', 'this', 'that', 'of', 'in', 'and', 'or', 'for', 'with', 'druid', 'druids', 'golf', 'new', 'plain', 'size', 'colour', 'color', 'one', 'please']);
const SIZE_WORD = /^(xxs|xs|s|m|l|xl|xxl|xxxl|[2-6]xl|small|medium|large|extra|\d{1,3}(\/\d{1,2})?)$/;

export function singular(word: string): string {
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

/**
 * Spellings that are not typos: the customer's English and the catalogue's
 * differ. Druids list VAPOR JACKET 2.0 and hoodies; customers write "vapour"
 * and "hoody". Kept to spellings seen or near-certain - a speculative list
 * would turn customers' words into products they did not name.
 */
export const SPELLING_VARIANTS: Record<string, string> = {
  vapour: 'vapor',
  hoody: 'hoodie',
  hoodys: 'hoodie',
};

function words(text: string): string[] {
  return normaliseName(text)
    .split(' ')
    .filter(Boolean)
    .map((word) => SPELLING_VARIANTS[word] ?? word);
}

/**
 * Edit distance with swapped neighbours counting as one edit (optimal string
 * alignment): "galatic" -> "galactic" is 1, "pollo" -> "polo" is 1,
 * "ruan" -> "rain" is 1, "wiht" -> "with" is 1.
 */
export function editDistance(a: string, b: string, limit = 3): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let before: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, before[j - 2]! + 1);
      current[j] = value;
      rowMin = Math.min(rowMin, value);
    }
    // Every path is already past the limit: no need to finish.
    if (rowMin > limit) return limit + 1;
    before = previous;
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * How close a customer's word is to a catalogue word.
 *
 *   strong  the same word misspelt: one edit, same first letter, both words at
 *           least four letters (two edits once both are eight or more). Good
 *           enough to name the product it belongs to.
 *   weak    two edits, or a different first letter: enough to hold back a
 *           "we do not stock it", never enough to pick a product.
 *
 * Short words are left alone: "tex" and "hex" are both Druids names, one
 * letter apart.
 */
export function wordSimilarity(said: string, known: string): 'strong' | 'weak' | null {
  if (said === known || said.length < 4 || known.length < 4) return null;
  const distance = editDistance(said, known, 2);
  if (distance > 2) return null;
  const sameStart = said[0] === known[0];
  if (sameStart && (distance === 1 || (distance === 2 && Math.min(said.length, known.length) >= 8))) return 'strong';
  return Math.max(said.length, known.length) >= 5 ? 'weak' : null;
}

/**
 * The words that name a design: "the black Apex polo in XL" -> ["apex"].
 * Colour, range, garment, size and filler come out - they are checked on
 * their own, never mistaken for the name.
 */
export function nameWords(text: string): string[] {
  const { rest } = parseColours(parseRange(text.replace(/[’']/g, "'")).rest);
  return words(rest)
    .map(singular)
    .filter((word) => word.length > 1 && !FILLER.has(word) && !GARMENT_WORDS.has(word) && !SIZE_WORD.test(word));
}

/** The garment words in a text, singular: "polos and a jacket" -> ["polo", "jacket"]. */
export function garmentWords(text: string): string[] {
  return [...new Set(words(text).map(singular).filter((word) => GARMENT_WORDS.has(word) && !['golf', 'druid', 'kit', 'pack', 'bundle'].includes(word)))];
}

const cache = new WeakMap<Product, ProductIdentity>();

export function identityOf(product: Product): ProductIdentity {
  let identity = cache.get(product);
  if (!identity) {
    const design = garmentName(product.title);
    identity = {
      title: normaliseName(product.title),
      design,
      designWords: nameWords(design),
      garments: garmentWords(design),
      colourway: colourwayName(product.title).toLowerCase(),
      range: rangeOf(product),
      ...(product.handle ? { handle: product.handle.toLowerCase() } : {}),
    };
    cache.set(product, identity);
  }
  return identity;
}
