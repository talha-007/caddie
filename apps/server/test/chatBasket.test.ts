import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BasketSync, Product } from '@caddie/shared';

/**
 * Smart Cart phase 1 - basket freshness, the server's side. A chat message
 * may carry the cart as the widget read it just before sending; the route
 * applies it before the conversation runs, so the turn is about the basket
 * as it is. A message without one keeps the copy the server had - never an
 * empty basket in its place.
 */

/** What the conversation saw when it ran: the basket at that moment. */
const seen: Array<{ lines: string[]; cartToken?: string }> = [];

vi.mock('../src/ai/openai.js', async (original) => {
  const real = await original<typeof import('../src/ai/openai.js')>();
  const { sessions } = await import('../src/session/store.js');
  return {
    ...real,
    openaiEnabled: () => true,
    converse: vi.fn(async (sessionId: string) => {
      const session = await sessions.getOrCreate(sessionId);
      seen.push({ lines: (session.basket ?? []).map((line) => `${line.lineId}:${line.quantity}`), ...(session.cartToken ? { cartToken: session.cartToken } : {}) });
      return { text: 'ok' };
    }),
  };
});

const { env } = await import('../src/env.js');
const { resetLimits } = await import('../src/lib/rateLimit.js');
const { chatRouter } = await import('../src/routes/chat.js');
const { claimSession } = await import('../src/session/ownership.js');
const { sessions } = await import('../src/session/store.js');
const { setCatalogueForTests } = await import('../src/catalog/sync.js');

const POLO: Product = {
  id: 'gid://shopify/Product/5600',
  title: 'ELITE POLO - NAVY',
  url: '',
  imageUrl: null,
  vendor: 'Druids',
  productType: null,
  tags: [env.shopify.brandTag].filter(Boolean) as string[],
  price: { amount: 20, currency: 'GBP' },
  options: [{ name: 'Size', values: ['M', 'L'] }],
  variants: ['M', 'L'].map((size, i) => ({ id: `gid://shopify/ProductVariant/560${i}`, title: size, available: true, price: { amount: 20, currency: 'GBP' }, options: { Size: size } })),
  description: null,
};

let base = '';
let server: ReturnType<ReturnType<typeof express>['listen']>;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/chat', chatRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

let id = '';
let token = '';
beforeEach(async () => {
  setCatalogueForTests([POLO]);
  resetLimits();
  seen.length = 0;
  id = `chat-basket-${Math.random()}`;
  const claimed = await claimSession(id);
  if (!claimed.ok) throw new Error('claim failed');
  token = claimed.sessionToken;
  // What the server last heard: one polo in M.
  await sessions.patch(id, { cartMode: 'theme', widgetContract: 'cart-ops/1', cartToken: 'cart-old', basket: [{ lineId: 'old-line', productId: POLO.id, title: POLO.title, variantTitle: 'M', quantity: 1 }] });
});

async function chat(body: Record<string, unknown>) {
  return fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-caddie-session-token': token, 'x-caddie-cart': 'theme', 'x-caddie-widget': 'cart-ops/1' },
    body: JSON.stringify({ sessionId: id, ...body }),
  });
}

describe('/api/chat and the basket that comes with the message', () => {
  it('2. applies the supplied basket before the conversation runs', async () => {
    const basket: BasketSync = {
      cartToken: 'cart-now',
      lines: [
        { key: 'fresh-1', productId: POLO.id, variantId: 'gid://shopify/ProductVariant/5601', title: POLO.title, variantTitle: 'L', quantity: 2 },
      ],
    };
    const res = await chat({ text: 'what is in my basket?', basket });
    expect(res.status).toBe(200);
    // The conversation saw the fresh basket, not the old copy.
    expect(seen).toEqual([{ lines: ['fresh-1:2'], cartToken: 'cart-now' }]);
    const after = await sessions.getOrCreate(id);
    expect(after.basket?.map((line) => line.lineId)).toEqual(['fresh-1']);
    // Titles come from the catalogue, never the request (basketFromSync).
    expect(after.basket?.[0]?.title).toBe(POLO.title);
  });

  it('an empty basket that was really read is applied: the customer emptied their cart', async () => {
    const res = await chat({ text: 'anything in my basket?', basket: { cartToken: 'cart-now', lines: [] } });
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ lines: [], cartToken: 'cart-now' }]);
  });

  it('a message with no basket (the widget could not read it) keeps the copy the server had', async () => {
    const res = await chat({ text: 'hello' });
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ lines: ['old-line:1'], cartToken: 'cart-old' }]);
  });

  it('a malformed basket is refused with the request, not half-applied', async () => {
    const res = await chat({ text: 'hello', basket: { lines: [{ key: '', quantity: -1 }] } });
    expect(res.status).toBe(400);
    expect(seen).toEqual([]);
    expect((await sessions.getOrCreate(id)).basket?.map((line) => line.lineId)).toEqual(['old-line']);
  });

  it('outside the theme cart (the dev harness), a basket in the message is ignored', async () => {
    await sessions.patch(id, { cartMode: 'storefront' });
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-caddie-session-token': token, 'x-caddie-cart': 'storefront', 'x-caddie-widget': 'cart-ops/1' },
      body: JSON.stringify({ sessionId: id, text: 'hello', basket: { lines: [] } }),
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ lines: ['old-line:1'], cartToken: 'cart-old' }]);
  });
});
