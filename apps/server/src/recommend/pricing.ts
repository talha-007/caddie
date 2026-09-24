import type { Money, Product } from '@caddie/shared';
import { sameSize } from './sizeWords.js';

/**
 * What a garment will actually cost this customer.
 *
 * `product.price` is Shopify's `minVariantPrice` - the cheapest variant, which
 * on a product priced by size is not the one most people buy. Packs and
 * outfits added those minimums up and presented the result as a total, so a
 * customer shopping at 2XL was quoted a number they could not check out at.
 *
 * The mirror carries every variant with its own price, so where the size is
 * known the real figure is right there. Where it is not, the minimum is still
 * the honest thing to rank and filter on - it is just a *from* price, and
 * `exact: false` is how the caller knows to say so rather than quoting it as
 * settled.
 */

export interface EffectivePrice {
  amount: number;
  currency: string;
  /** False when this is a "from" price because the variant is not pinned yet. */
  exact: boolean;
}

/** Every distinct price across the variants we can actually sell. */
function sellablePrices(product: Product): number[] {
  const live = product.variants.filter((variant) => variant.available);
  const pool = live.length > 0 ? live : product.variants;
  return [...new Set(pool.map((variant) => variant.price.amount))];
}

export function priceFor(product: Product, size?: string): EffectivePrice {
  const currency = product.price.currency;

  // A search result may carry no variants, so the product price is all we have.
  if (product.variants.length === 0) {
    return { amount: product.price.amount, currency, exact: false };
  }

  if (size) {
    const matching = product.variants.filter(
      (variant) =>
        variant.available && Object.values(variant.options).some((value) => sameSize(value, size)),
    );
    const prices = [...new Set(matching.map((variant) => variant.price.amount))];
    // One price for that size is the price. Several means the size alone did
    // not pin the garment - a colour is still open - so it stays a from price.
    if (prices.length === 1) return { amount: prices[0]!, currency, exact: true };
    if (prices.length > 1) return { amount: Math.min(...prices), currency, exact: false };
  }

  const distinct = sellablePrices(product);
  if (distinct.length === 1) return { amount: distinct[0]!, currency, exact: true };

  return { amount: Math.min(...distinct, product.price.amount), currency, exact: false };
}

/**
 * The span of prices a customer could actually pay for this garment.
 *
 * A single "from" figure is still quotable as *the* price, and the model
 * quoted it - "how much is the Tour Polo in 2XL" came back "£42" on a polo
 * that costs £52 in 2XL. A range cannot be flattened the same way: there is
 * no honest reading of "£42 to £52" that is "£42".
 */
export function priceRange(product: Product): { min: number; max: number; currency: string } {
  const currency = product.price.currency;
  const distinct = product.variants.length > 0 ? sellablePrices(product) : [product.price.amount];
  return { min: Math.min(...distinct), max: Math.max(...distinct), currency };
}

export interface Total extends Money {
  /** False when any piece was priced from a range rather than a variant. */
  exact: boolean;
}

/** Adds garments up, carrying through whether the answer is a real figure. */
export function totalFor(products: Product[], size: string | undefined, fallback: string): Total {
  const priced = products.map((product) => priceFor(product, size));
  return {
    amount: Number(priced.reduce((sum, price) => sum + price.amount, 0).toFixed(2)),
    currency: priced[0]?.currency ?? fallback,
    exact: priced.every((price) => price.exact),
  };
}
