import type { Product, ProductVariant } from '@caddie/shared';

/**
 * Helpers for choosing a real variant.
 *
 * RULE 4: nothing goes in the basket unless the customer has picked every
 * option (size, colour...) and that exact variant exists and is in stock.
 * These helpers never fall back to "the first available one".
 */

export type Selection = Record<string, string>;

/** One row of the picker. `kind` only decides how it is drawn. */
export interface PickerOption {
  name: string;
  values: string[];
  kind: 'colour' | 'size' | 'other';
}

const COLOUR = /colou?r/i;
const SIZE = /size|waist|leg|length|fit/i;

/**
 * The choices to show.
 *
 * `product.options` is the truth: a detail lookup returns every option but only
 * the variant matching what has been chosen, so building the picker from
 * variants alone would show a single size. Variants are the fallback for
 * anything cached before the server sent options.
 */
export function productOptions(product: Product): PickerOption[] {
  const byName = new Map<string, string[]>();
  for (const option of product.options ?? []) {
    if (option.values.length > 0) byName.set(option.name, [...option.values]);
  }
  if (byName.size === 0) {
    for (const variant of product.variants) {
      for (const [name, value] of Object.entries(variant.options)) {
        const values = byName.get(name) ?? [];
        if (!values.includes(value)) values.push(value);
        byName.set(name, values);
      }
    }
  }
  return (
    [...byName.entries()]
      // Shopify's placeholder for a product with no options: "Title: Default Title" is not a choice.
      .filter(([name, values]) => !(values.length === 1 && /^default title$/i.test(values[0] ?? '')))
      .map(([name, values]) => ({
        name,
        values,
        kind: COLOUR.test(name) ? 'colour' : SIZE.test(name) ? 'size' : 'other',
      }))
  );
}

/** True when the product offers no real choice - one colour, one size, or none at all. */
export function nothingToChoose(product: Product): boolean {
  return productOptions(product).every((option) => option.values.length <= 1);
}

/**
 * The variant that matches every chosen option.
 *
 * Shopify hands back a default variant even when nothing has been chosen, so a
 * lone variant is never proof of a choice - it has to match the selection
 * option for option (RULE 4).
 */
export function matchVariant(product: Product, selection: Selection): ProductVariant | null {
  const options = productOptions(product);
  if (nothingToChoose(product)) return product.variants[0] ?? null;
  if (options.some((option) => !selection[option.name])) return null;
  return (
    product.variants.find((variant) =>
      options.every((option) => variant.options[option.name] === selection[option.name]),
    ) ?? null
  );
}

/** Do we hold every combination, or just the one the server matched? */
function hasEveryVariant(product: Product): boolean {
  const combinations = productOptions(product).reduce((total, option) => total * Math.max(option.values.length, 1), 1);
  return product.variants.length >= combinations;
}

/**
 * Is this value possible given what else is already chosen? Used to grey out
 * sold-out sizes - but only when we actually hold every variant. With just the
 * matched one, stock is unknown until the variant is resolved, and greying
 * everything out would be a lie.
 */
export function isValueAvailable(product: Product, selection: Selection, name: string, value: string): boolean {
  if (!hasEveryVariant(product)) return true;
  return product.variants.some(
    (variant) =>
      variant.available &&
      variant.options[name] === value &&
      Object.entries(selection).every(([key, chosen]) => key === name || variant.options[key] === chosen),
  );
}

/**
 * The starting selection: options with only one value are chosen for the
 * customer (there is nothing to decide), plus any hints we genuinely have -
 * the size the Caddie recommended, the colour named in the title, or the
 * variant open on the product page. Every one is visible before they tap Add.
 */
/** "Medium", "med", "M" are one size; "8/10" and "8-10" too. */
function sizeKey(value: string): string {
  const clean = value.trim().toLowerCase().replace(/[-\s]+/g, '/');
  const words: Record<string, string> = { small: 's', medium: 'm', med: 'm', large: 'l', 'x/large': 'xl', 'extra/large': 'xl', xxl: '2xl', xxxl: '3xl' };
  return words[clean] ?? clean;
}

/** Their size among a product's sizes, trying each of theirs in turn - a top size, then a waist. */
function matchSize(values: string[], wanted: Array<string | null | undefined>): string | undefined {
  for (const size of wanted) {
    if (!size) continue;
    const match = values.find((value) => sizeKey(value) === sizeKey(size));
    if (match) return match;
    // A combined size - the belt's "M/L" and "L/XL" - when exactly one of them holds theirs.
    const halves = values.filter((value) => /[a-z]\s*\/\s*[a-z]/i.test(value) && sizeKey(value).split('/').includes(sizeKey(size)));
    if (halves.length === 1) return halves[0];
  }
  return undefined;
}

export function initialSelection(
  product: Product,
  hints: { size?: string | null; waist?: string | null; variantId?: string | null } = {},
): Selection {
  const selection: Selection = {};
  const options = productOptions(product);

  const pageVariant = hints.variantId ? product.variants.find((v) => sameId(v.id, hints.variantId as string)) : null;
  if (pageVariant) Object.assign(selection, pageVariant.options);

  const title = product.title.toLowerCase();
  for (const option of options) {
    if (option.values.length === 1) selection[option.name] = option.values[0] as string;
    // "Tour Tech Trousers - Navy" was recommended in navy: show it that way (they still tap Add).
    if (option.kind === 'colour' && !pageVariant && !selection[option.name]) {
      const named = option.values.find((value) => new RegExp(`\\b${escapeRegExp(value.toLowerCase())}\\b`).test(title));
      if (named) selection[option.name] = named;
    }
    // Their size, already chosen - they can still tap another.
    if (option.kind === 'size' && !pageVariant) {
      const match = matchSize(option.values, [hints.size, hints.waist]);
      if (match) selection[option.name] = match;
    }
  }

  // The page variant's size is what they were looking at, but their own size wins.
  if (pageVariant && (hints.size || hints.waist)) {
    const sizeOption = options.find((option) => option.kind === 'size');
    const match = sizeOption ? matchSize(sizeOption.values, [hints.size, hints.waist]) : undefined;
    if (sizeOption && match) selection[sizeOption.name] = match;
  }

  return selection;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Shopify ids come as GIDs from MCP and as bare numbers from Liquid; compare on the number. */
export function sameId(a: string, b: string): boolean {
  const tail = (id: string) => id.split('/').pop() ?? id;
  return tail(a) === tail(b);
}

export function toProductGid(id: string): string {
  return id.startsWith('gid://') ? id : `gid://shopify/Product/${id}`;
}

export function toVariantGid(id: string): string {
  return id.startsWith('gid://') ? id : `gid://shopify/ProductVariant/${id}`;
}

/* ---------------- Colour swatches ---------------- */

/**
 * Swatch colours for the option *names* Shopify gives us. This is presentation
 * only - the name shown next to the dot always comes from the variant itself.
 * Unknown names get a neutral dot rather than a guessed colour.
 */
const SWATCHES: Array<[RegExp, string]> = [
  [/navy/, '#1f2a44'],
  [/charcoal/, '#36393f'],
  [/black/, '#111111'],
  [/white|optic/, '#ffffff'],
  [/cream|ivory|off.?white/, '#f3ecdc'],
  [/stone|sand|beige|khaki/, '#c9bda6'],
  [/slate/, '#6b86a8'],
  [/sky|light blue/, '#9cc3e6'],
  [/royal|cobalt/, '#2447a8'],
  [/blue/, '#3f6fb5'],
  [/burgundy|maroon|wine/, '#6d1f2f'],
  [/purple|plum|violet/, '#7b2c7b'],
  [/pink|rose/, '#e7a3bd'],
  [/red/, '#c8322f'],
  [/orange/, '#e57a2e'],
  [/yellow|mustard/, '#e5c04a'],
  [/olive/, '#6b6f3a'],
  [/sage|mint/, '#9fb49a'],
  [/green/, '#2f6b45'],
  [/grey|gray|silver/, '#9ca3af'],
  [/brown|tan|camel/, '#8a5a3b'],
];

export function swatchColour(name: string): string | null {
  const lower = name.toLowerCase();
  return SWATCHES.find(([pattern]) => pattern.test(lower))?.[1] ?? null;
}
