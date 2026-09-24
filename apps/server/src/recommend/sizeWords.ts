/**
 * Turns whatever a size gets called into the code the catalogue uses.
 *
 * Druids stocks S, M, L, XL, 2XL upwards, and numeric waists. Customers and
 * the model both say "Medium" freely, and every size check in here compared
 * strings exactly - so "Medium" never equalled "M".
 *
 * That emptied whole outfits. `hasSize` dropped every product, every slot came
 * back unfilled, and the customer was told "we do not have a match day outfit
 * in stock right now" while the entire range was available. It was
 * intermittent, because it only happened on the turns where the model chose to
 * pass a size at all.
 */

const WORDS: Record<string, string> = {
  xs: 'XS',
  xsmall: 'XS',
  'extra small': 'XS',
  s: 'S',
  small: 'S',
  m: 'M',
  med: 'M',
  medium: 'M',
  l: 'L',
  large: 'L',
  xl: 'XL',
  xlarge: 'XL',
  'x large': 'XL',
  'extra large': 'XL',
  xxl: '2XL',
  '2xl': '2XL',
  'xx large': '2XL',
  xxxl: '3XL',
  '3xl': '3XL',
  xxxxl: '4XL',
  '4xl': '4XL',
};

/**
 * The catalogue's code for a size, or null when we cannot tell.
 *
 * Null matters: it means "unrecognised", not "no match". Callers treat it as
 * no preference rather than filtering everything away, because an unparsed
 * word is a failure of ours and should not read to the customer as the store
 * being empty.
 */
export function normaliseSize(raw: string | undefined | null): string | null {
  if (!raw) return null;

  const clean = raw.trim().toLowerCase().replace(/[-_/]/g, ' ').replace(/\s+/g, ' ');
  if (!clean) return null;

  const word = WORDS[clean];
  if (word) return word;

  // A numeric waist is already exactly what the catalogue calls it.
  if (/^\d{1,3}$/.test(clean)) return clean;

  return null;
}

/** Whether a variant's option value means the same size that was asked for. */
export function sameSize(variantValue: string, wanted: string): boolean {
  const a = normaliseSize(variantValue) ?? variantValue.trim().toLowerCase();
  const b = normaliseSize(wanted) ?? wanted.trim().toLowerCase();
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Which scale a size is measured on.
 *
 * Druids sizes tops by letter and bottoms by waist, so "M" and "32" are not
 * two values of one scale - they are two scales. A customer who says M has
 * told us nothing about which trousers fit them.
 */
function scaleOf(code: string): 'letter' | 'waist' {
  return /^\d+$/.test(code) ? 'waist' : 'letter';
}

/**
 * Whether a product is stocked in this size.
 *
 * Shared by the pack and the outfit so the two cannot drift: they had
 * identical copies of this, and a fix to one would have left the other
 * emptying itself.
 *
 * A product sized on a different scale is not excluded. Asking for a medium
 * used to drop every pair of trousers in the store, because trousers carry
 * waist sizes and none of them is an "M" - so an outfit built around a size
 * came back as a top and a hoodie with nothing to wear below.
 */
export function stockedInSize(
  variants: Array<{ available: boolean; options: Record<string, string> }>,
  size?: string,
): boolean {
  if (!size) return true;
  // A search result may carry no variants, so we cannot rule it out yet.
  if (variants.length === 0) return true;

  const wanted = normaliseSize(size);
  if (!wanted) return true;

  const offered = variants
    .flatMap((variant) => Object.values(variant.options))
    .map((value) => normaliseSize(value))
    .filter((value): value is string => value !== null);

  // Sized on another scale, so the customer's size says nothing about it.
  if (!offered.some((value) => scaleOf(value) === scaleOf(wanted))) return true;

  return variants.some(
    (variant) => variant.available && Object.values(variant.options).some((value) => sameSize(value, wanted)),
  );
}
