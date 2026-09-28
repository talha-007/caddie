import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CartAction } from '@caddie/shared';
import { FakeShopifyCart, installStorefront } from './support/fakeShopifyCart.js';
import { CART_REQUEST_MS, runOperation } from '../src/lib/themeCart.js';

/**
 * How a failed cart request is classed for the report: only a refusal the
 * store sent is a failure whose outcome is known; a request that got no
 * answer, or that the widget stopped waiting for, is uncertain.
 */
const POLO_M = { variantId: 611, productId: 61, title: 'ELITE POLO - NAVY', variantTitle: 'M', price: 2000 };
const POLO_OUT = { variantId: 642, productId: 64, title: 'CLUB POLO - WHITE', variantTitle: 'L', price: 2000, available: false };
let cart: FakeShopifyCart;
beforeEach(() => {
  cart = new FakeShopifyCart([POLO_M, POLO_OUT]);
  installStorefront(cart);
});
const add = (variantId: number): Extract<CartAction, { type: 'add' }> => ({ type: 'add', operationId: 'op-1', lines: [{ variantId: String(variantId), quantity: 1 }], expect: { add: [{ variantId: String(variantId), quantity: 1 }] } });

describe('classifying a failed request', () => {
  it('blocked before it could be sent (the browser refuses the request): uncertain, network', async () => {
    const real = cart.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/cart/add.js')) throw new TypeError('Failed to fetch');
      return real(input, init);
    }) as typeof fetch;
    const report = await runOperation(add(611));
    expect(report).toMatchObject({ status: 'uncertain', failure: 'network', error: 'Failed to fetch' });
    expect(cart.quantities()).toEqual({});
  });

  it('the answer lost after the store may have acted: uncertain, timeout, and the read shows what landed', async () => {
    vi.useFakeTimers();
    try {
      cart.hang('add');
      const pending = runOperation(add(611));
      // The store did the work; its answer never came back.
      await Promise.resolve();
      cart.seed([{ variantId: 611, quantity: 1 }]);
      await vi.advanceTimersByTimeAsync(CART_REQUEST_MS + 10);
      cart.unhang('add');
      const report = await pending;
      expect(report).toMatchObject({ status: 'uncertain', failure: 'timeout' });
      expect(report.after?.lines[0]?.quantity).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the store refused it: failed, rejected, in its words', async () => {
    const report = await runOperation(add(642));
    expect(report).toMatchObject({ status: 'failed', failure: 'rejected' });
    expect(report.error).toMatch(/already sold out/);
  });

  it('a replacement whose removal the store refused: partial, rejected, both lines present', async () => {
    cart.seed([{ variantId: 611, quantity: 1 }]);
    const key = cart.keyOf(611)!;
    cart.variants.push({ variantId: 612, productId: 61, title: 'ELITE POLO - NAVY', variantTitle: 'L', price: 2000 });
    cart.failNext('change', 422, 'Cart Error');
    const report = await runOperation({ ...add(612), removeKeys: [key], expect: { add: [{ variantId: '612', quantity: 1 }], remove: [{ key, variantId: '611', quantity: 1 }] } });
    expect(report).toMatchObject({ status: 'partial', failure: 'rejected' });
    expect(cart.quantities()).toEqual({ 612: 1, 611: 1 });
  });
});
