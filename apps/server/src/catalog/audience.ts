import type { Product } from '@caddie/shared';

/**
 * Who a product is for: mens, ladies or kids.
 *
 * The test store only stocked mens kit, so nothing needed this. The live
 * Druids store has a full kids range and a ladies range, and on the first
 * search against it "navy polo" came back four kids polos out of six, and a
 * "club match" outfit was a kids polo and a kids hoodie. Nothing about a
 * search for a polo should hand an adult a child's polo.
 *
 * Read from the title, the product type and the tags, because that is how
 * Druids names the ranges: "KIDS BAND POLO - NAVY" (type "KIDS POLOS"),
 * "LADIES ELITE POLO - WHITE". Anything not marked as kids or ladies is the
 * main range - most mens products carry no "MEN'S" in the name at all.
 */

export type Range = 'men' | 'women' | 'kids';

const KIDS = /\b(kids?|junior|juniors|boys?|girls?|youth|children|childrens|child)\b/i;
const WOMEN = /\b(ladies|lady|womens|women|woman|women's|womans)\b/i;
const MEN = /\b(mens|men|men's|man)\b/i;

/**
 * Cached per product object. Search checks every candidate, and at the live
 * catalogue size the regexes alone took a browse from 11ms to 190ms - on one
 * thread, blocking every other customer. A changed product is a new object,
 * so the cache can never serve a stale range.
 */
const ranges = new WeakMap<Product, Range>();

export function rangeOf(product: Product): Range {
  let range = ranges.get(product);
  if (!range) {
    range = computeRange(product);
    ranges.set(product, range);
  }
  return range;
}

function computeRange(product: Product): Range {
  const text = `${product.title} ${product.productType ?? ''} ${product.tags.join(' ')}`.replace(/’/g, "'");
  // The name and type decide first: tags carry campaign labels ("all", "mens")
  // on products of every range.
  const named = `${product.title} ${product.productType ?? ''}`.replace(/’/g, "'");
  if (KIDS.test(named)) return 'kids';
  if (WOMEN.test(named)) return 'women';
  if (MEN.test(named)) return 'men';
  if (KIDS.test(text)) return 'kids';
  if (WOMEN.test(text) && !MEN.test(text)) return 'women';
  return 'men';
}

/**
 * The range a query asks for, and the words left over.
 *
 * "womens polo", "a polo for my son", "kids trousers". The range words come
 * out of the query, like colours do, so they filter rather than rank.
 */
export function parseRange(query: string): { range: Range | null; rest: string } {
  const text = query.replace(/’/g, "'");
  const range: Range | null =
    KIDS.test(text) || /\b(son|daughter|grandson|granddaughter)\b/i.test(text)
      ? 'kids'
      : WOMEN.test(text)
        ? 'women'
        : MEN.test(text)
          ? 'men'
          : null;
  const rest = text
    .replace(new RegExp(KIDS.source, 'gi'), ' ')
    .replace(new RegExp(WOMEN.source, 'gi'), ' ')
    .replace(new RegExp(MEN.source, 'gi'), ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { range, rest };
}

/**
 * Whether a product may be shown for a request.
 *
 * Asked for a range: only that range. Not asked: never kids - a child's
 * polo is not a guess anyone wants - but mens and ladies both, unless we
 * already know which one they are shopping (`known`).
 */
export function inRange(product: Product, asked: Range | null, known?: 'men' | 'women'): boolean {
  const range = rangeOf(product);
  if (asked) return range === asked;
  if (range === 'kids') return false;
  if (known) return range === known;
  return true;
}
