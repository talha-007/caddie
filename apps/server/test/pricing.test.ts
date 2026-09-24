import { describe, expect, it } from 'vitest';
import type { Product, ProductVariant } from '@caddie/shared';
import { priceFor, priceRange, totalFor } from '../src/recommend/pricing.js';

function variant(size: string, amount: number, available = true): ProductVariant {
  return {
    id: `gid://shopify/ProductVariant/${size}-${amount}`,
    title: size,
    available,
    price: { amount, currency: 'GBP' },
    options: { Size: size },
  };
}

/** `price` is Shopify's minVariantPrice, which is the trap this guards. */
function product(min: number, variants: ProductVariant[]): Product {
  return {
    id: 'gid://shopify/Product/1',
    title: 'TECH TROUSER',
    url: '',
    imageUrl: null,
    vendor: 'Druids',
    productType: 'TROUSERS',
    tags: [],
    price: { amount: min, currency: 'GBP' },
    options: [{ name: 'Size', values: variants.map((v) => v.title) }],
    variants,
    description: null,
  };
}

/**
 * Packs and outfits added up `product.price` and called the result a total.
 * That is Shopify's cheapest variant, so a customer buying at 2XL was quoted
 * a number they could not check out at - and the budget filter let garments
 * in that they could not actually afford.
 */
describe('what a garment actually costs this customer', () => {
  const sized = product(42, [variant('S', 42), variant('M', 42), variant('2XL', 58)]);

  it('uses the price of the size they are buying, not the cheapest one', () => {
    expect(priceFor(sized, '2XL')).toEqual({ amount: 58, currency: 'GBP', exact: true });
    expect(priceFor(sized, 'M')).toEqual({ amount: 42, currency: 'GBP', exact: true });
  });

  it('reads a word size the same as the code', () => {
    expect(priceFor(sized, 'Medium').amount).toBe(42);
  });

  /* Without a size it is a "from" price, and the caller has to say so. */
  it('falls back to the lowest price and marks it inexact', () => {
    expect(priceFor(sized)).toEqual({ amount: 42, currency: 'GBP', exact: false });
  });

  it('is exact without a size when every variant costs the same', () => {
    const flat = product(42, [variant('S', 42), variant('M', 42)]);
    expect(priceFor(flat)).toEqual({ amount: 42, currency: 'GBP', exact: true });
  });

  it('ignores sold-out variants when working out the price', () => {
    const cheapGone = product(42, [variant('S', 42, false), variant('M', 58), variant('L', 58)]);
    expect(priceFor(cheapGone)).toEqual({ amount: 58, currency: 'GBP', exact: true });
  });

  /* A search result carries no variants, so the minimum is all there is. */
  it('marks a product with no variants inexact', () => {
    expect(priceFor(product(42, []))).toEqual({ amount: 42, currency: 'GBP', exact: false });
  });

  it('stays a from price when the size alone does not pin one garment', () => {
    const twoColours: Product = {
      ...sized,
      variants: [
        { ...variant('M', 42), options: { Size: 'M', Colour: 'Navy' } },
        { ...variant('M', 55), id: 'x', options: { Size: 'M', Colour: 'Sage' } },
      ],
    };
    expect(priceFor(twoColours, 'M')).toEqual({ amount: 42, currency: 'GBP', exact: false });
  });
});

describe('adding a pack or an outfit up', () => {
  const a = product(42, [variant('S', 42), variant('2XL', 58)]);
  const b = product(20, [variant('S', 20), variant('2XL', 30)]);

  it('totals at the size being bought', () => {
    expect(totalFor([a, b], '2XL', 'GBP')).toEqual({ amount: 88, currency: 'GBP', exact: true });
  });

  it('is a from total when any piece is not pinned', () => {
    const total = totalFor([a, b], undefined, 'GBP');
    expect(total.amount).toBe(62);
    expect(total.exact).toBe(false);
  });

  it('survives an empty pack', () => {
    expect(totalFor([], 'M', 'GBP')).toEqual({ amount: 0, currency: 'GBP', exact: true });
  });
});

/**
 * A "from" price is still quotable as *the* price, and the model quoted it:
 * "how much is the Tour Polo in 2XL" came back "£42" on a polo that costs
 * £52 in 2XL. Giving the facts a range instead removed the flat reading -
 * there is no honest way to render "£42 to £52" as "£42" - and the model
 * started fetching the variant when a size was on the table.
 */
describe('the span a customer could pay', () => {
  it('reports both ends when the price moves with the size', () => {
    const sized = product(42, [variant('S', 42), variant('XL', 48), variant('2XL', 52)]);
    expect(priceRange(sized)).toEqual({ min: 42, max: 52, currency: 'GBP' });
  });

  it('collapses to one figure when every variant costs the same', () => {
    const flat = product(8, [variant('S', 8), variant('M', 8)]);
    const span = priceRange(flat);
    expect(span.min).toBe(span.max);
  });

  it('ignores sold-out variants, so we never advertise a price nobody can buy', () => {
    const cheapGone = product(42, [variant('S', 42, false), variant('M', 58), variant('L', 58)]);
    expect(priceRange(cheapGone)).toEqual({ min: 58, max: 58, currency: 'GBP' });
  });

  it('falls back to the product price when there are no variants yet', () => {
    expect(priceRange(product(42, []))).toEqual({ min: 42, max: 42, currency: 'GBP' });
  });
});
