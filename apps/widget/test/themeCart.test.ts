import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CartAction } from '@caddie/shared';
import { FakeShopifyCart, installStorefront } from './support/fakeShopifyCart.js';
import { CART_REQUEST_MS, cartPath, observe, runOperation } from '../src/lib/themeCart.js';

/**
 * The widget's part of a basket change, against a Shopify Ajax cart with
 * contents of its own (support/fakeShopifyCart.ts). Every assertion is on
 * the fixture's actual before and after, never on the widget's own word
 * for what it did.
 */

const POLO_M = { variantId: 611, productId: 61, title: 'ELITE POLO - NAVY', variantTitle: 'M', price: 2000 };
const POLO_L = { variantId: 612, productId: 61, title: 'ELITE POLO - NAVY', variantTitle: 'L', price: 2000 };
const POLO_L_OUT = { variantId: 642, productId: 64, title: 'CLUB POLO - WHITE', variantTitle: 'L', price: 2000, available: false };
const JACKET_M = { variantId: 631, productId: 63, title: 'STORM JACKET - BLACK', variantTitle: 'M', price: 6000 };

let cart: FakeShopifyCart;
beforeEach(() => {
  cart = new FakeShopifyCart([POLO_M, POLO_L, POLO_L_OUT, JACKET_M]);
  installStorefront(cart);
});

const add = (variantId: number, quantity = 1, extra: Partial<Extract<CartAction, { type: 'add' }>> = {}): Extract<CartAction, { type: 'add' }> => ({
  type: 'add',
  operationId: 'op-1',
  lines: [{ variantId: String(variantId), quantity }],
  expect: { add: [{ variantId: String(variantId), quantity }] },
  ...extra,
});
const qty = (report: { after: { lines: Array<{ variantId: string; quantity: number }> } | null }, variantId: number) => report.after?.lines.filter((line) => line.variantId.endsWith(`/${variantId}`)).reduce((sum, line) => sum + line.quantity, 0) ?? -1;

describe('1. an add the cart accepts', () => {
  it('reports the cart before and after, with the variant risen by the quantity', async () => {
    cart.seed([{ variantId: JACKET_M.variantId, quantity: 1 }]);
    const report = await runOperation(add(611));
    expect(report).toMatchObject({ operationId: 'op-1', status: 'applied', evidence: 'ajax-cart-read' });
    expect(qty({ after: report.before }, 611)).toBe(0);
    expect(qty(report, 611)).toBe(1);
    expect(cart.quantities()).toEqual({ 631: 1, 611: 1 });
    expect(cart.calls.map((call) => call.endpoint)).toEqual(['read', 'add', 'read']);
  });

  it('6. the variant already there: the report shows the rise, not just the presence', async () => {
    cart.seed([{ variantId: 611, quantity: 1 }]);
    const report = await runOperation(add(611));
    expect(qty({ after: report.before }, 611)).toBe(1);
    expect(qty(report, 611)).toBe(2);
  });
});

describe('2. an add the cart refuses', () => {
  it('is reported failed with the store\'s words and an unchanged cart', async () => {
    cart.seed([{ variantId: 611, quantity: 1 }]);
    const report = await runOperation(add(642));
    expect(report.status).toBe('failed');
    expect(report.error).toMatch(/already sold out/);
    expect(cart.quantities()).toEqual({ 611: 1 });
    expect(qty(report, 642)).toBe(0);
  });
});

describe('3 and 4. a response lost', () => {
  it('3. the add landed but its response never came: uncertain, and a later observation shows the change - no second add', async () => {
    vi.useFakeTimers();
    try {
      cart.hang('add');
      const pending = runOperation(add(611));
      await vi.advanceTimersByTimeAsync(CART_REQUEST_MS + 10);
      const report = await pending;
      expect(report.status).toBe('uncertain');
      // The store did the work after the widget stopped waiting.
      cart.unhang('add');
      cart.seed([{ variantId: 611, quantity: 1 }]);
      const later = await observe('op-1');
      expect(later.status).toBe('uncertain');
      expect(qty(later, 611)).toBe(1);
      expect(cart.calls.filter((call) => call.endpoint === 'add')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('4. the cart cannot be read after the timeout: uncertain with no after, and no retry', async () => {
    vi.useFakeTimers();
    try {
      cart.hang('add');
      cart.hang('read');
      const pending = runOperation(add(611));
      // Three requests hang in turn - the read before, the add, the read after - each ended by its own deadline.
      await vi.advanceTimersByTimeAsync(CART_REQUEST_MS * 3 + 30);
      const report = await pending;
      expect(report.status).toBe('uncertain');
      expect(report.after).toBeNull();
      expect(cart.calls.filter((call) => call.endpoint === 'add')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('14. a hung request ends within its deadline, so the caller can carry on', async () => {
    vi.useFakeTimers();
    try {
      cart.hang('read');
      let settled = false;
      const pending = runOperation({ type: 'change', operationId: 'op-2', lineKey: 'x', quantity: 0, expect: {} }).then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(CART_REQUEST_MS - 100);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(CART_REQUEST_MS * 2);
      await pending;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('8 to 13. a size replacement, M to L', () => {
  const replace = (outgoingKey: string, quantity = 1): Extract<CartAction, { type: 'add' }> =>
    add(612, quantity, { removeKeys: [outgoingKey], expect: { add: [{ variantId: '612', quantity }], remove: [{ key: outgoingKey, variantId: '611', quantity }] } });

  it('8. M x2 -> L x2, the jacket untouched: the L in first, then the M out by its re-keyed line', async () => {
    cart.seed([{ variantId: 611, quantity: 2 }, { variantId: 631, quantity: 1 }]);
    const key = cart.keyOf(611)!;
    const report = await runOperation(replace(key, 2));
    expect(report.status).toBe('applied');
    expect(cart.quantities()).toEqual({ 612: 2, 631: 1 });
    expect(qty({ after: report.before }, 611)).toBe(2);
    expect(qty(report, 611)).toBe(0);
    expect(qty(report, 612)).toBe(2);
    // add, read (re-keyed), change the M, read
    expect(cart.calls.map((call) => call.endpoint)).toEqual(['read', 'add', 'read', 'change', 'read']);
  });

  it('9. the L is unavailable: nothing added, the M still there', async () => {
    cart.seed([{ variantId: 641 as never, quantity: 0 }].filter(() => false));
    cart.variants.push({ variantId: 641, productId: 64, title: 'CLUB POLO - WHITE', variantTitle: 'M', price: 2000 });
    cart.seed([{ variantId: 641, quantity: 1 }]);
    const key = cart.keyOf(641)!;
    const report = await runOperation(add(642, 1, { removeKeys: [key], expect: { add: [{ variantId: '642', quantity: 1 }], remove: [{ key, variantId: '641', quantity: 1 }] } }));
    expect(report.status).toBe('failed');
    expect(cart.quantities()).toEqual({ 641: 1 });
    expect(cart.calls.map((call) => call.endpoint)).toEqual(['read', 'add', 'read']);
  });

  it('10. an L line already there keeps its quantity and gains the M\'s', async () => {
    cart.seed([{ variantId: 611, quantity: 1 }, { variantId: 612, quantity: 3 }]);
    const key = cart.keyOf(611)!;
    const report = await runOperation(replace(key, 1));
    expect(report.status).toBe('applied');
    expect(cart.quantities()).toEqual({ 612: 4 });
    expect(qty(report, 612)).toBe(4);
  });

  it('11. two M lines of the same variant with different properties: only the intended one goes', async () => {
    cart.seed([{ variantId: 611, quantity: 1, properties: { _gift: 'yes' } }, { variantId: 611, quantity: 1 }]);
    const plain = cart.items.find((item) => !item.properties)!.key;
    const report = await runOperation(replace(plain, 1));
    expect(report.status).toBe('applied');
    expect(cart.items.filter((item) => item.variant_id === 611)).toHaveLength(1);
    expect(cart.items.find((item) => item.variant_id === 611)?.properties).toEqual({ _gift: 'yes' });
    expect(cart.quantities()).toEqual({ 611: 1, 612: 1 });
  });

  it('12. the add re-keys every line: the M is re-found by variant, never removed by a stale key', async () => {
    cart.seed([{ variantId: 611, quantity: 1 }, { variantId: 631, quantity: 1 }]);
    const key = cart.keyOf(611)!;
    const report = await runOperation(replace(key, 1));
    expect(report.status).toBe('applied');
    const change = cart.calls.find((call) => call.endpoint === 'change')!;
    expect((change.body as { id: string }).id).not.toBe(key);
    expect(cart.quantities()).toEqual({ 612: 1, 631: 1 });
  });

  it('13. the L went in but the M would not come out: partial, both in the cart, nothing else removed', async () => {
    cart.seed([{ variantId: 611, quantity: 1 }, { variantId: 631, quantity: 1 }]);
    const key = cart.keyOf(611)!;
    cart.failNext('change', 500, 'Cart Error');
    const report = await runOperation(replace(key, 1));
    expect(report.status).toBe('partial');
    expect(report.error).toMatch(/Cart Error/);
    expect(cart.quantities()).toEqual({ 612: 1, 611: 1, 631: 1 });
    expect(qty(report, 611)).toBe(1);
    expect(qty(report, 612)).toBe(1);
  });
});

describe('the store\'s own root', () => {
  it('cart calls go under the locale root the theme uses', async () => {
    cart = new FakeShopifyCart([POLO_M], '/en-gb/');
    installStorefront(cart, '/en-gb/');
    expect(cartPath('/cart.js')).toBe('/en-gb/cart.js');
    const report = await runOperation(add(611));
    expect(report.status).toBe('applied');
    expect(cart.quantities()).toEqual({ 611: 1 });
  });
});
