import { beforeEach, describe, expect, it } from 'vitest';
import type { CartAction } from '@caddie/shared';
import { CART_OPS_CONTRACT } from '@caddie/shared';
import { UNSUPPORTED_SERVER, sortActions } from '../src/lib/operations.js';
import { reportCartOutcome, serverSupportsOperations, syncBasket } from '../src/lib/api.js';
import { FakeShopifyCart, installStorefront } from './support/fakeShopifyCart.js';
import { basketSync, readCart } from '../src/lib/themeCart.js';

/**
 * A widget and a server that do not speak the same basket-change contract
 * never start a change one of them cannot finish: this widget runs only
 * stamped operations, tells the server what it is on every request, and
 * learns from the claim what the server is.
 */

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => sessionStorage.clear());

describe('actions this widget will run', () => {
  const stamped: CartAction = { type: 'add', operationId: 'op-1', lines: [{ variantId: '611', quantity: 1 }], expect: { add: [{ variantId: '611', quantity: 1 }] } };
  const unstamped: CartAction = { type: 'add', lines: [{ variantId: '611', quantity: 1 }] };
  const bundle = { type: 'add-bundle', bundle: { handle: 'x' }, pieces: [] } as unknown as CartAction;

  it('an old server\'s unstamped add or change is not run, and is named as unsupported', () => {
    const sorted = sortActions([unstamped, { type: 'change', lineKey: 'k', quantity: 0 }]);
    expect(sorted.operations).toEqual([]);
    expect(sorted.unsupported).toHaveLength(2);
    expect(UNSUPPORTED_SERVER).toMatch(/refresh/);
  });

  it('a matched server\'s stamped actions are operations; pack actions stay on their own path', () => {
    const sorted = sortActions([stamped, bundle]);
    expect(sorted.operations).toEqual([stamped]);
    expect(sorted.legacy).toEqual([bundle]);
    expect(sorted.unsupported).toEqual([]);
  });
});

describe('the contract on the wire', () => {
  it('every session request carries x-caddie-widget, and the claim\'s contract is remembered', async () => {
    const headers: Array<Record<string, string>> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/claim')) return json(200, { sessionId: 's2', sessionToken: 'tok', contract: CART_OPS_CONTRACT });
      headers.push((init?.headers as Record<string, string>) ?? {});
      return json(200, { ok: true, lines: 0 });
    }) as typeof fetch;
    await syncBasket('s2', { lines: [] });
    expect(headers[0]?.['x-caddie-widget']).toBe(CART_OPS_CONTRACT);
    expect(serverSupportsOperations('s2')).toBe(true);
  });

  it('an old server (no contract on the claim) is known as such before any change is attempted', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/claim')) return json(200, { sessionId: 's3', sessionToken: 'tok' });
      return json(200, { ok: true, lines: 0 });
    }) as typeof fetch;
    await syncBasket('s3', { lines: [] });
    expect(serverSupportsOperations('s3')).toBe(false);
  });

  it('an old server answering the outcome route with 404 is reported as unknown, not retried', async () => {
    let posts = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/claim')) return json(200, { sessionId: 's4', sessionToken: 'tok' });
      posts += 1;
      return json(404, { error: 'not_found' });
    }) as typeof fetch;
    expect(await reportCartOutcome('s4', { operationId: 'op-1', status: 'applied', before: null, after: null, evidence: 'ajax-cart-read' })).toEqual({ status: 'unknown' });
    expect(posts).toBe(1);
  });
});

describe('what the sync carries for reconciliation', () => {
  it('the cart token, each line\'s properties and its selling plan', async () => {
    const cart = new FakeShopifyCart([{ variantId: 611, productId: 61, title: 'ELITE POLO - NAVY', variantTitle: 'M', price: 2000 }]);
    installStorefront(cart);
    cart.seed([{ variantId: 611, quantity: 1, properties: { _gift: 'yes' } }]);
    (cart.items[0] as unknown as { selling_plan_allocation: unknown }).selling_plan_allocation = { selling_plan: { id: 987 } };
    await readCart();
    const sync = basketSync();
    expect(sync.cartToken).toBe('fake-cart');
    expect(sync.lines[0]).toMatchObject({ variantId: 'gid://shopify/ProductVariant/611', properties: { _gift: 'yes' }, sellingPlanId: '987', quantity: 1 });
  });
});
