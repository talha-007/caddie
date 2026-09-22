import type { Product, ProductVariant } from '@caddie/shared';

/**
 * Helpers for choosing a real variant.
 *
 * RULE 4: nothing goes in the basket unless the customer has picked every
 * option (size, colour...) and that exact variant exists and is in stock.
 * These helpers never fall back to "the first available one".
 */

export type Selection = Record<string, string>;

export interface ProductOption {
  name: string;
  values: string[];
  kind: 'colour' | 'size' | 'other';
}

const COLOUR = /colou?r/i;
const SIZE = /size|waist|leg|length|fit/i;

export function productOptions(product: Product): ProductOption[] {
  const byName = new Map<string, string[]>();
  for (const variant of product.variants) {
    for (const [name, value] of Object.entries(variant.options)) {
      const values = byName.get(name) ?? [];
      if (!values.includes(value)) values.push(value);
      byName.set(name, values);
    }
  }
  return [...byName.entries()].map(([name, values]) => ({
    name,
    values,
    kind: COLOUR.test(name) ? 'colour' : SIZE.test(name) ? 'size' : 'other',
  }));
}

/** The variant matching every chosen option, or null while anything is unchosen. */
export function matchVariant(product: Product, selection: Selection): ProductVariant | null {
  if (product.variants.length === 1) return product.variants[0] ?? null;
  const options = productOptions(product);
  if (options.some((option) => !selection[option.name])) return null;
  return (
    product.variants.find((variant) =>
      options.every((option) => variant.options[option.name] === selection[option.name]),
    ) ?? null
  );
}

/** Is this value possible given what else is already chosen? Used to grey out sold-out sizes. */
export function isValueAvailable(product: Product, selection: Selection, name: string, value: string): boolean {
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
export function initialSelection(
  product: Product,
  hints: { size?: string | null; variantId?: string | null } = {},
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
    if (option.kind === 'size' && hints.size && !pageVariant) {
      const match = option.values.find((value) => value.toLowerCase() === hints.size?.toLowerCase());
      if (match) selection[option.name] = match;
    }
  }

  // The page variant's size is what they were looking at, but the recommended size wins.
  if (pageVariant && hints.size) {
    const sizeOption = options.find((option) => option.kind === 'size');
    const match = sizeOption?.values.find((value) => value.toLowerCase() === hints.size?.toLowerCase());
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
