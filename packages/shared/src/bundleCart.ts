import type { BundleDeal } from './recommendation.js';

/**
 * The cart lines for a bundle deal, exactly as the Druids theme writes them.
 *
 * A deal's price is not a product price. The theme's bundle builder
 * (snippets/bundle-builder-script-v4.liquid, FINAL_CHECKOUT) puts each piece
 * in the cart with a set of hidden properties, and a checkout discount
 * function (SupaEasy) matches on those to charge the pack price. Lines that
 * differ - a missing property, a number that stringifies differently - are
 * lines the discount may not recognise, and the customer pays full price for
 * six items.
 *
 * So this is a transcription, not a reinterpretation. The arithmetic is the
 * theme's own, in the same order, including the parts that look odd (the
 * per-line "final" price is scaled to a fraction of a penny and the last line
 * takes the remainder). The property order is the theme's object-literal
 * order. Values are sent form-encoded, as jQuery sends them, so every number
 * arrives as the same string. `test/bundleCart.test.ts` checks this against a
 * copy of the theme's code.
 *
 * Only builder v4 and collection steps are handled - every deal in the
 * store's navigation. Steps with a fixed-price product take a different
 * branch and are refused rather than guessed.
 */

export interface BundlePiece {
  /** Numeric Shopify variant id, as the cart takes. */
  variantId: string;
  /** Numeric Shopify product id. */
  productId: string;
  /** Major units, e.g. 45 for £45.00. */
  price: number;
  compareAtPrice: number | null;
  /** The product's handle - the 'plus' format writes it on each line. */
  handle?: string;
}

export interface BundleContext {
  /** Cart currency, e.g. "GBP" - window.Shopify.currency.active on the store. */
  currency: string;
  /** Shopper country, e.g. "GB" - window.Shopify.country. */
  country: string;
  /** Milliseconds, for __bundle_date. */
  now: number;
  /** The theme's own format: 'bundle_' + time + '_' + nine random characters. */
  bundleId: string;
}

export interface BundleCartItem {
  id: string;
  quantity: number;
  /** In the theme's order. Values are exactly what jQuery would send. */
  properties: Array<[string, string]>;
}

/** Why a bundle cannot be added the way the theme adds it. */
export class BundleCartError extends Error {}

/** The theme's id format, e.g. bundle_1790270000000_k3j9x0a2b. */
export function newBundleId(now: number, random: () => number = Math.random): string {
  return 'bundle_' + now + '_' + random().toString(36).substr(2, 9);
}

/** Shopify money in minor units, as Liquid's `variant.price` prints it. */
function minor(amount: number): number {
  return Math.round(amount * 100);
}

/**
 * The sport-bundle builder's lines (assets/sport-quick-cart-bundle.js,
 * buildPlusBundleItems): the shopper's country, the product handle, one group
 * id shared by every line of this pack, and the pack's trigger properties -
 * nothing else. Checkout prices it per market through the discount Function,
 * which keys on the trigger. No price goes on the line: that theme's own notes
 * say a legacy script reprices anything carrying the old price properties and
 * the Function then never applies.
 */
export function buildPlusBundleItems(
  bundle: Pick<BundleDeal, 'handle' | 'trigger'>,
  pieces: BundlePiece[],
  context: Pick<BundleContext, 'country' | 'bundleId'>,
): BundleCartItem[] {
  if (pieces.length === 0) throw new BundleCartError('A bundle needs its pieces.');
  const trigger = Object.entries(bundle.trigger ?? {});
  // Without its trigger the Function never discounts: refuse rather than charge full price.
  if (trigger.length === 0) throw new BundleCartError(`${bundle.handle} has no checkout trigger, so it would not get its pack price.`);
  return pieces.map((piece) => ({
    id: piece.variantId,
    quantity: 1,
    properties: [
      ['__Localization', context.country],
      ['__Product_Url', piece.handle ?? ''],
      ['_data_bundle_id', context.bundleId],
      ...trigger,
    ] as Array<[string, string]>,
  }));
}

export function buildBundleCartItems(
  bundle: Pick<BundleDeal, 'handle' | 'prices' | 'dynamicPrices'> & Partial<Pick<BundleDeal, 'format' | 'trigger'>>,
  pieces: BundlePiece[],
  context: BundleContext,
): BundleCartItem[] {
  if (bundle.format === 'plus') return buildPlusBundleItems(bundle, pieces, context);
  // The theme's own override: Ireland has its own price whatever the currency
  // (stored as EUR_IE when the deals are read).
  const start =
    context.country === 'IE' && bundle.prices.EUR_IE !== undefined ? bundle.prices.EUR_IE : bundle.prices[context.currency];
  if (start === undefined) {
    // The theme converts from EUR for currencies it has no price for, using
    // rates we cannot see. Refused, not approximated: a wrong pack price is
    // a wrong charge.
    throw new BundleCartError(`No ${bundle.handle} price for ${context.currency}.`);
  }
  if (pieces.length === 0) throw new BundleCartError('A bundle needs its pieces.');

  // The card attributes the theme reads (bundle-card-v4.liquid).
  const BUNDLES = pieces.map((piece) => {
    const sale = minor(piece.price);
    const compare = piece.compareAtPrice !== null ? minor(piece.compareAtPrice) : null;
    return {
      vt_id: piece.variantId,
      product_id: piece.productId,
      sale_price: sale,
      com_price: compare !== null && compare > sale ? compare : sale,
      // show_supplement reads `item.tags`, and `item` is not defined inside
      // that render - the supplement is always 0 on the live theme.
      extra: 0,
      // Collection steps render the card without a fixed_price.
      fixed_price: 0,
      data_url: bundle.handle,
    };
  });

  // PRICE_UPDATE()
  let BUNDLE_PRICE: number = start;
  let OLD_SALE_PRICE = 0;
  const EXTRA_PRICE = 0;
  for (const item of BUNDLES) {
    OLD_SALE_PRICE += item.sale_price;
    BUNDLE_PRICE += item.extra;
  }

  // FINAL_CHECKOUT()
  const user_country = context.country;
  const user_currency = context.currency;
  const uniqueBundleId = context.bundleId;
  const BUNDLE_PROPERTY = ((BUNDLE_PRICE * 100) / OLD_SALE_PRICE).toFixed(10);

  const CART_ITEMS = BUNDLES.map((item, index) => {
    // The theme's object literal, in order. "__bundle_version_2" appears
    // twice there; the later value wins but the key keeps its first place.
    const properties = new Map<string, unknown>([
      ['__bundle_count', BUNDLES.length],
      ['__bundle_version', 'true'],
      ['__golf_bundle', 'true'],
      ['__bundle_version_2', item.data_url],
      ['__bundle_date', context.now],
      ['__bundle_number', index],
      ['__bundle_discount', BUNDLE_PROPERTY],
      ['__fixed_price', BUNDLE_PRICE * 100],
      ['__extra_price', EXTRA_PRICE * 100],
      ['__original_price', OLD_SALE_PRICE],
      ['__sale_price', item.sale_price],
      ['__b_version', '4'],
      ['__Bundle_Name', item.data_url],
      [`__${item.data_url}`, item.data_url],
      ['__venn_bundle_id', uniqueBundleId],
      ['__user_country', user_country],
      ['__user_currency', user_currency],
      ['__bundle_id', uniqueBundleId],
      ['__bundle_currency', user_currency],
      ['__bundle_price', BUNDLE_PRICE],
      ['__product_id', item.product_id],
    ]);
    return { id: item.vt_id, quantity: 1, properties };
  });

  if (!bundle.dynamicPrices) {
    let temp_price = 0;
    for (let index = 0; index < CART_ITEMS.length; index++) {
      const ITEM = CART_ITEMS[index]!;
      if (index === CART_ITEMS.length - 1) {
        const last_sale_price = parseInt(String(ITEM.properties.get('__fixed_price'))) - temp_price;
        ITEM.properties.set('__final_sale_price_2', Math.max(last_sale_price, 0));
      } else {
        const raw_price = (parseFloat(String(ITEM.properties.get('__sale_price'))) * parseFloat(BUNDLE_PROPERTY)) / 100;
        const fractionalPart = raw_price - Math.floor(raw_price);
        let sale_price: number;
        if (fractionalPart > 0.999) sale_price = Math.ceil(raw_price);
        else if (fractionalPart < 0.001) sale_price = Math.floor(raw_price);
        else sale_price = Math.round(raw_price);
        ITEM.properties.set('__final_sale_price_2', sale_price * 100);
        temp_price += sale_price * 100;
      }
    }
  }

  return CART_ITEMS.map((item) => ({
    id: item.id,
    quantity: item.quantity,
    properties: [...item.properties].map(([key, value]) => [key, String(value)] as [string, string]),
  }));
}

/** The body jQuery's $.ajax sends for `data: { items }` - what /cart/add.js receives from the theme. */
export function formEncodeCartItems(items: BundleCartItem[]): string {
  const body = new URLSearchParams();
  items.forEach((item, index) => {
    body.append(`items[${index}][id]`, item.id);
    body.append(`items[${index}][quantity]`, String(item.quantity));
    for (const [key, value] of item.properties) body.append(`items[${index}][properties][${key}]`, value);
  });
  return body.toString();
}
