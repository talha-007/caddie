import { describe, expect, it } from 'vitest';
import { buildBundleCartItems, formEncodeCartItems, newBundleId, type BundlePiece } from '@caddie/shared';

/**
 * The Caddie adds a deal to the cart exactly as the Druids theme's bundle
 * builder does, or the checkout discount may not recognise it and the
 * customer pays full price. The reference below is the theme's own code
 * (snippets/bundle-builder-script-v4.liquid, PRICE_UPDATE and FINAL_CHECKOUT)
 * with the jQuery reads replaced by plain inputs and nothing else changed.
 */
function themeReference(
  cards: Array<{ vt_id: string; product_id: string; sale_price: number; com_price: number; data_url: string }>,
  starting_price: number,
  dynamic_prices: boolean,
  user_country: string,
  user_currency: string,
  now: number,
  uniqueBundleId: string,
) {
  const START_PRICE = parseFloat(String(starting_price));
  let BUNDLE_PRICE = parseFloat(String(starting_price));
  let OLD_SALE_PRICE = 0;
  let OLD_COM_PRICE = 0;
  let EXTRA_PRICE = 0;
  const BUNDLES = cards.map((card) => ({
    vt_id: card.vt_id,
    product_id: card.product_id,
    sale_price: parseInt(String(card.sale_price)),
    com_price: parseInt(String(card.com_price)),
    extra: parseInt('0'),
    fixed_price: parseInt('0'),
    qty: 1,
    data_url: card.data_url,
  }));
  // PRICE_UPDATE
  BUNDLE_PRICE = START_PRICE;
  OLD_SALE_PRICE = 0;
  OLD_COM_PRICE = 0;
  EXTRA_PRICE = 0;
  for (let index = 0; index < BUNDLES.length; index++) {
    const item = BUNDLES[index]!;
    OLD_COM_PRICE += item.com_price;
    OLD_SALE_PRICE += item.sale_price;
    BUNDLE_PRICE += item.extra;
  }
  // FINAL_CHECKOUT
  const QTY_ARRAY = BUNDLES.map(() => 1);
  const CART_ITEMS: Array<{ id: string; quantity: number; properties: Record<string, unknown> }> = [];
  const BUNDLE_PROPERTY = ((BUNDLE_PRICE * 100) / OLD_SALE_PRICE).toFixed(10);
  for (let index = 0; index < BUNDLES.length; index++) {
    const b = BUNDLES[index]!;
    const ITEM = {
      id: b['vt_id'],
      quantity: QTY_ARRAY[index]!,
      properties: {
        __bundle_count: BUNDLES.length,
        __bundle_version: 'true',
        __golf_bundle: 'true',
        // @ts-ignore -- the theme's literal really does set this key twice
        __bundle_version_2: 'true',
        __bundle_date: now,
        __bundle_number: index,
        __bundle_discount: BUNDLE_PROPERTY,
        __fixed_price: BUNDLE_PRICE * 100,
        __extra_price: EXTRA_PRICE * 100,
        __original_price: OLD_SALE_PRICE,
        __sale_price: b['sale_price'],
        __b_version: '4',
        __Bundle_Name: b['data_url'],
        [`__${b['data_url']}`]: b['data_url'],
        __venn_bundle_id: uniqueBundleId,
        __user_country: user_country,
        __user_currency: user_currency,
        // eslint-disable-next-line no-dupe-keys -- the theme's own duplicate
        ...{ __bundle_version_2: b['data_url'] },
        __bundle_id: uniqueBundleId,
        __bundle_currency: user_currency,
        __bundle_price: BUNDLE_PRICE,
        __product_id: b['product_id'],
      } as Record<string, unknown>,
    };
    CART_ITEMS.push(ITEM);
  }
  if (!dynamic_prices) {
    let temp_price = 0;
    for (let index = 0; index < CART_ITEMS.length; index++) {
      const ITEM = CART_ITEMS[index]!;
      if (index === CART_ITEMS.length - 1) {
        const last_sale_price = parseInt(String(ITEM.properties['__fixed_price'])) - temp_price;
        ITEM.properties['__final_sale_price_2'] = Math.max(last_sale_price, 0);
      } else {
        const raw_price = (parseFloat(String(ITEM.properties['__sale_price'])) * parseFloat(BUNDLE_PROPERTY)) / 100;
        const fractionalPart = raw_price - Math.floor(raw_price);
        let sale_price;
        if (fractionalPart > 0.999) sale_price = Math.ceil(raw_price);
        else if (fractionalPart < 0.001) sale_price = Math.floor(raw_price);
        else sale_price = Math.round(raw_price);
        ITEM.properties['__final_sale_price_2'] = sale_price * 100;
        temp_price += sale_price * 100;
      }
    }
  }
  return CART_ITEMS;
}

/** What jQuery's $.param would put on the wire for the reference's lines. */
function jqueryBody(items: ReturnType<typeof themeReference>): string {
  const body = new URLSearchParams();
  items.forEach((item, index) => {
    body.append(`items[${index}][id]`, String(item.id));
    body.append(`items[${index}][quantity]`, String(item.quantity));
    for (const [key, value] of Object.entries(item.properties)) body.append(`items[${index}][properties][${key}]`, String(value));
  });
  return body.toString();
}

const AMBASSADOR = { handle: 'golf-ambassador-pack', prices: { GBP: 99.99, EUR: 119.99 }, dynamicPrices: false };
const PRESTIGE = { handle: 'prestige-pack', prices: { GBP: 69 }, dynamicPrices: true };

/** Real clearance-style prices, awkward pence included, and one sale item. */
const PIECES: BundlePiece[] = [
  { variantId: '41000000001', productId: '7000000001', price: 45, compareAtPrice: 65 },
  { variantId: '41000000002', productId: '7000000002', price: 38.5, compareAtPrice: null },
  { variantId: '41000000003', productId: '7000000003', price: 24, compareAtPrice: 30 },
  { variantId: '41000000004', productId: '7000000004', price: 42.99, compareAtPrice: null },
  { variantId: '41000000005', productId: '7000000005', price: 14, compareAtPrice: null },
  { variantId: '41000000006', productId: '7000000006', price: 7.99, compareAtPrice: 9.99 },
];

const CONTEXT = { currency: 'GBP', country: 'GB', now: 1790270000000, bundleId: 'bundle_1790270000000_abc123xyz' };

function cardsFor(handle: string, pieces: BundlePiece[]) {
  return pieces.map((piece) => {
    const sale = Math.round(piece.price * 100);
    const compare = piece.compareAtPrice !== null ? Math.round(piece.compareAtPrice * 100) : sale;
    return { vt_id: piece.variantId, product_id: piece.productId, sale_price: sale, com_price: Math.max(compare, sale), data_url: handle };
  });
}

describe('buildBundleCartItems', () => {
  it('writes exactly the lines the theme writes - standard pricing', () => {
    const ours = buildBundleCartItems(AMBASSADOR, PIECES, CONTEXT);
    const theirs = themeReference(cardsFor(AMBASSADOR.handle, PIECES), 99.99, false, 'GB', 'GBP', CONTEXT.now, CONTEXT.bundleId);
    expect(formEncodeCartItems(ours)).toBe(jqueryBody(theirs));
  });

  it('writes exactly the lines the theme writes - dynamic pricing', () => {
    const three = PIECES.slice(0, 3);
    const ours = buildBundleCartItems(PRESTIGE, three, CONTEXT);
    const theirs = themeReference(cardsFor(PRESTIGE.handle, three), 69, true, 'GB', 'GBP', CONTEXT.now, CONTEXT.bundleId);
    expect(formEncodeCartItems(ours)).toBe(jqueryBody(theirs));
    // Dynamic pricing leaves the per-line final price off entirely.
    expect(ours.every((item) => !item.properties.some(([key]) => key === '__final_sale_price_2'))).toBe(true);
  });

  it('matches across many price mixes, where rounding bites', () => {
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let run = 0; run < 200; run++) {
      const pieces = PIECES.map((piece) => ({ ...piece, price: Math.round((2 + random() * 80) * 100) / 100 }));
      const ours = buildBundleCartItems(AMBASSADOR, pieces, CONTEXT);
      const theirs = themeReference(cardsFor(AMBASSADOR.handle, pieces), 99.99, false, 'GB', 'GBP', CONTEXT.now, CONTEXT.bundleId);
      expect(formEncodeCartItems(ours)).toBe(jqueryBody(theirs));
    }
  });

  it('keeps the theme property order, the duplicate key in its first place', () => {
    const keys = buildBundleCartItems(AMBASSADOR, PIECES, CONTEXT)[0]!.properties.map(([key]) => key);
    expect(keys.slice(0, 6)).toEqual(['__bundle_count', '__bundle_version', '__golf_bundle', '__bundle_version_2', '__bundle_date', '__bundle_number']);
    expect(keys.filter((key) => key === '__bundle_version_2')).toHaveLength(1);
    expect(buildBundleCartItems(AMBASSADOR, PIECES, CONTEXT)[0]!.properties.find(([key]) => key === '__bundle_version_2')![1]).toBe('golf-ambassador-pack');
  });

  it('refuses a currency the page has no price for, rather than guess', () => {
    expect(() => buildBundleCartItems(AMBASSADOR, PIECES, { ...CONTEXT, currency: 'USD' })).toThrow(/No golf-ambassador-pack price for USD/);
  });

  it('makes bundle ids in the theme format', () => {
    expect(newBundleId(1790270000000, () => 0.123456789)).toMatch(/^bundle_1790270000000_[a-z0-9]{1,9}$/);
  });
});
