import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SMART_CART_HEADER, SMART_CART_PREVIEW } from '@caddie/shared';
import { setSmartCartPreview, syncBasket } from '../src/lib/api.js';
import { basketSync, readCart, repairLines, runOperation } from '../src/lib/themeCart.js';
import { FakeShopifyCart, installStorefront } from './support/fakeShopifyCart.js';

/**
 * Smart Cart on the widget's side: an add the server stamped goes into the
 * store cart carrying the offer trigger, exactly as sent; an add without one
 * is unchanged; the basket report says the cart's currency; and the preview
 * header travels only where the theme turned the preview on.
 */

const POLO = { variantId: 710, productId: 71, title: 'FLORAL PANEL POLO - NAVY', variantTitle: 'M', price: 2400 };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let cart: FakeShopifyCart;
let sent: Array<{ url: string; headers: Record<string, string> }>;
beforeEach(() => {
  sessionStorage.clear();
  cart = new FakeShopifyCart([POLO]);
  installStorefront(cart);
  sent = [];
  const shopify = cart.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('http://caddie.test')) {
      sent.push({ url, headers: (init?.headers as Record<string, string>) ?? {} });
      if (url.endsWith('/claim')) return json(200, { sessionId: 's1', sessionToken: 'tok', contract: 'cart-ops/1' });
      return json(200, { ok: true, lines: 0, smartCart: null });
    }
    return shopify(input, init);
  }) as typeof fetch;
});
afterEach(() => setSmartCartPreview(false));

describe('an add the server stamped', () => {
  it('goes into the store cart carrying the trigger, exactly as sent', async () => {
    const trigger = { __3_Polo_Bundle: '3_Polo_Bundle' };
    const report = await runOperation({ type: 'add', operationId: 'op-1', lines: [{ variantId: '710', quantity: 1, properties: trigger }], expect: { add: [{ variantId: '710', quantity: 1, properties: trigger }] } });
    expect(report).toMatchObject({ status: 'applied' });
    await readCart();
    expect(basketSync().lines).toEqual([expect.objectContaining({ variantId: 'gid://shopify/ProductVariant/710', quantity: 1, properties: trigger })]);
  });

  it('an add without properties is unchanged: a plain line', async () => {
    await runOperation({ type: 'add', operationId: 'op-2', lines: [{ variantId: '710', quantity: 1 }], expect: { add: [{ variantId: '710', quantity: 1 }] } });
    await readCart();
    expect(basketSync().lines[0]).not.toHaveProperty('properties');
  });
});

describe('the basket report', () => {
  it("says the cart's currency", async () => {
    await readCart();
    expect(basketSync().currency).toBe('GBP');
  });
});

describe('the preview header', () => {
  it('is not sent unless the theme turned the preview on - the live theme', async () => {
    await syncBasket('s1', { lines: [] });
    const basket = sent.find((entry) => entry.url.endsWith('/basket'))!;
    expect(basket.headers).not.toHaveProperty(SMART_CART_HEADER);
  });

  it('is sent on every request once it is on', async () => {
    setSmartCartPreview(true);
    await syncBasket('s1', { lines: [] });
    const basket = sent.find((entry) => entry.url.endsWith('/basket'))!;
    expect(basket.headers[SMART_CART_HEADER]).toBe(SMART_CART_PREVIEW);
  });
});

describe('the discounts the cart applied', () => {
  it('are passed on per line, by title and amount in minor units', () => {
    const raw = {
      token: 't', item_count: 3, total_price: 5999, currency: 'GBP',
      items: [{ key: 'k1', product_id: 71, variant_id: 710, product_title: 'POLO', variant_title: 'M', image: null, quantity: 3, final_price: 2000, final_line_price: 5999, properties: { __3_Polo_Bundle: '3_Polo_Bundle' }, line_level_discount_allocations: [{ amount: 1201, discount_application: { title: 'ANY 3 POLO BUNDLE' } }] }],
    };
    expect(basketSync(raw as never).lines[0]?.discounts).toEqual([{ title: 'ANY 3 POLO BUNDLE', amount: 1201 }]);
  });
  it('are an empty list when nothing applied - so "no discount" is told apart from "not reported"', async () => {
    await runOperation({ type: 'add', operationId: 'op-3', lines: [{ variantId: '710', quantity: 1 }], expect: { add: [{ variantId: '710', quantity: 1 }] } });
    await readCart();
    expect(basketSync().lines[0]?.discounts).toEqual([]);
  });
});

describe('a qualifying line added without its deal key', () => {
  const repairFor = (key: string, quantity = 1) => ({ lineKey: key, variantId: 'gid://shopify/ProductVariant/710', quantity, properties: { __3_Polo_Bundle: '3_Polo_Bundle' } });

  it('is given the key, at the same quantity', async () => {
    cart.seed([{ variantId: 710, quantity: 2 }]);
    expect(await repairLines([repairFor(cart.keyOf(710)!, 2)])).toBe(true);
    expect(basketSync().lines).toEqual([expect.objectContaining({ quantity: 2, properties: { __3_Polo_Bundle: '3_Polo_Bundle' } })]);
  });
  it('is left alone if the customer changed it since the server looked', async () => {
    cart.seed([{ variantId: 710, quantity: 3 }]);
    expect(await repairLines([repairFor(cart.keyOf(710)!, 2)])).toBe(false);
    await readCart();
    expect(basketSync().lines[0]).not.toHaveProperty('properties');
  });
  it('never replaces properties a line already has', async () => {
    cart.seed([{ variantId: 710, quantity: 1, properties: { __bundle_id: 'b1' } }]);
    expect(await repairLines([repairFor(cart.keyOf(710)!)])).toBe(false);
    await readCart();
    expect(basketSync().lines[0]?.properties).toEqual({ __bundle_id: 'b1' });
  });
  it('a refusal is not sent again on the next read', async () => {
    cart.seed([{ variantId: 710, quantity: 1 }]);
    const key = cart.keyOf(710)!;
    cart.failNext('change', 422, 'Cannot change');
    expect(await repairLines([repairFor(key)])).toBe(false);
    expect(await repairLines([repairFor(key)])).toBe(false);
    await readCart();
    expect(basketSync().lines[0]).not.toHaveProperty('properties');
  });
});
