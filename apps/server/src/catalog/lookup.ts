import type { Product } from '@caddie/shared';
import { env } from '../env.js';
import { parseRange } from './audience.js';
import { parseColours } from './colour.js';
import { allProducts, catalogueReady } from './sync.js';
import { GARMENT_WORDS } from './taxonomy.js';

/**
 * Does Druids sell a product by that name?
 *
 * Search cannot answer this. It returns its nearest guesses, so asking for the
 * "Tour Championship Jacket" comes back with six jackets, and the Caddie
 * either presented one of them as it or - told never to do that - said "we do
 * not stock that" about things search simply ranked badly. Neither was
 * checked.
 *
 * The mirror is the whole catalogue, so a name can be checked against every
 * title in it: that is authoritative in a way a search result never is. When
 * the mirror is not loaded (the throttled fallback is answering), nothing is
 * claimed either way.
 */

export type Existence =
  | { status: 'exact'; products: Product[] }
  | { status: 'not-stocked'; name: string; closest: Product[] }
  | { status: 'unknown'; name: string };

const FILLER = new Set([
  'the', 'a', 'an', 'my', 'your', 'this', 'that', 'of', 'in', 'and', 'or', 'for', 'with', 'druid', 'druids', 'golf', 'new',
  'mens', 'men', 'ladies', 'womens', 'women', 'kids', 'junior', 'plain', 'size', 'colour', 'color',
]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((word) => word.length > 1 && !FILLER.has(word));
}

function singular(word: string): string {
  return word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word;
}

/** Sizes are never part of a name: "player polo XL" is the Player polo, in XL. */
const SIZE_WORD = /^(xxs|xs|s|m|l|xl|xxl|xxxl|[2-5]xl|small|medium|large|\d{1,3}(\/\d{1,2})?)$/;

/** The words that make a name a name: not the garment, colour, range or size. */
export function distinctiveWords(name: string): string[] {
  const { rest } = parseColours(parseRange(name).rest);
  return words(rest).filter((word) => !GARMENT_WORDS.has(word) && !GARMENT_WORDS.has(singular(word)) && !SIZE_WORD.test(word));
}

function brandProducts(): Product[] {
  const tag = env.shopify.brandTag?.toLowerCase();
  const all = allProducts();
  return tag ? all.filter((product) => product.tags.some((value) => value.toLowerCase() === tag)) : all;
}

/**
 * A name in the search words the model did not flag as one.
 *
 * Asked for the "Tour Championship Jacket", the model sometimes searched
 * "Tour Championship Jacket" without saying it was a name - and then asked
 * the customer to confirm what it was called. A word that appears nowhere in
 * the catalogue, in no title and no description, cannot be a description of
 * a kind of garment we sell: it is a name we do not have. Ordinary words
 * ("comfortable", "smart") appear in descriptions, so they never trigger it.
 */
export function unknownNameIn(query: string): Existence | null {
  const wanted = distinctiveWords(query);
  if (!catalogueReady()) return null;
  /*
   * Only something shaped like a product name is checked: two or more
   * distinctive words, at least one of which Druids use in their product
   * names ("Tour", "Vento"). "Tour Championship jacket" searched without
   * productName was never checked, and the Caddie asked the customer to
   * confirm the name.
   *
   * The rule this replaces - any word found nowhere in the catalogue makes it
   * a name - called "a lightweight polo for Spain" and "something for a
   * wedding" products we do not stock. A description has no name words, so
   * it is never mistaken for one.
   */
  if (wanted.length < 2) return null;
  const titleWords = new Set(brandProducts().flatMap((product) => words(product.title).map(singular)));
  if (!wanted.some((word) => titleWords.has(singular(word)))) return null;
  return lookupProductName(query);
}

export function lookupProductName(name: string): Existence | null {
  const wanted = distinctiveWords(name);
  // "A navy polo" names a kind of thing, not a product. Nothing to check.
  if (wanted.length === 0) return null;
  if (!catalogueReady()) return { status: 'unknown', name };

  const products = brandProducts();
  const titleWords = (product: Product) => new Set(words(product.title).map(singular));
  const exact = products.filter((product) => {
    const title = titleWords(product);
    return wanted.every((word) => title.has(singular(word)));
  });
  if (exact.length) return { status: 'exact', products: exact };

  // The nearest names, so the Caddie can offer them - never as the thing asked for.
  // Same kind of garment first: asked for a jacket, a "Tour" belt is not close.
  const garments = words(name).map(singular).filter((word) => GARMENT_WORDS.has(word) && !['golf', 'druids', 'kit'].includes(word));
  const closest = products
    .map((product) => {
      const title = titleWords(product);
      const hits = wanted.filter((word) => title.has(singular(word))).length;
      const sameKind = garments.some((garment) => title.has(garment)) ? 1 : 0;
      return { product, hits, sameKind };
    })
    .filter((entry) => entry.hits > 0)
    .sort((a, b) => b.sameKind - a.sameKind || b.hits - a.hits)
    .slice(0, 3)
    .map((entry) => entry.product);
  return { status: 'not-stocked', name, closest };
}
