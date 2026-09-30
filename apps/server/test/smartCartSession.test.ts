import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BasketSync, Product } from '@caddie/shared';
import type { SmartCartState } from '../src/smartCart/index.js';

/**
 * Smart Cart phase 3 - the session holds progress worked out from every
 * fresh cart read: the chat message's basket, the basket route, and a
 * settled cart outcome. A message whose read failed changes nothing - the
 * last state stays, never one computed from an invented empty basket - and a
 * cart really read as empty clears it.
 */

/** Smart Cart as the conversation found it when it ran. */
const seen: Array<SmartCartState | undefined> = [];

vi.mock('../src/ai/openai.js', async (original) => {
  const real = await original<typeof import('../src/ai/openai.js')>();
  const { sessions } = await import('../src/session/store.js');
  return {
    ...real,
    openaiEnabled: () => true,
    converse: vi.fn(async (sessionId: string) => {
      seen.push((await sessions.getOrCreate(sessionId)).smartCart);
      return { text: 'ok' };
    }),
  };
});

const { ownerHeaders } = await import('./support/ownership.js');
const { env } = await import('../src/env.js');
const { resetLimits } = await import('../src/lib/rateLimit.js');
const { chatRouter } = await import('../src/routes/chat.js');
const { sessionRouter } = await import('../src/routes/session.js');
const { sessions } = await import('../src/session/store.js');
const { setCatalogueForTests } = await import('../src/catalog/sync.js');
const { setDealsForTests } = await import('../src/catalog/bundles.js');
const { executeCommerceAction } = await import('../src/tools/actionGateway.js');
const { CART_OPS_CONTRACT } = await import('@caddie/shared');

const BRAND = [env.shopify.brandTag].filter(Boolean) as string[];
const product = (id: string, title: string, type: string, sizes: string[]): Product => ({
  id: `gid://shopify/Product/${id}`,
  title,
  url: '',
  imageUrl: null,
  vendor: 'Druids',
  productType: type,
  tags: BRAND,
  price: { amount: 20, currency: 'GBP' },
  options: [{ name: 'Size', values: sizes }],
  variants: sizes.map((size, i) => ({ id: `gid://shopify/ProductVariant/${id}${i}`, title: size, available: true, price: { amount: 20, currency: 'GBP' }, options: { Size: size } })),
  description: null,
});
const POLO = product('61', 'ELITE POLO - NAVY', 'POLOS', ['S', 'M', 'L']); // 610 S, 611 M, 612 L
const TROUSERS = product('65', 'TECH TROUSERS - NAVY', 'TROUSERS', ['30', '32']); // 650, 651

const TRIGGERED_POLO = { __data_three_polo: '3_Polo_Bundle', __3_Polo_Bundle: '3_Polo_Bundle' };
type Line = BasketSync['lines'][number];
const line = (key: string, p: Product, variant: string, quantity: number, properties?: Record<string, string>): Line => ({
  key, productId: p.id, variantId: `gid://shopify/ProductVariant/${variant}`, title: '', variantTitle: '', quantity, ...(properties ? { properties } : {}),
});

let base = '';
let server: ReturnType<ReturnType<typeof express>['listen']>;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/chat', chatRouter);
  app.use('/api/session', sessionRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

let id = '';
beforeEach(async () => {
  setCatalogueForTests([POLO, TROUSERS]);
  setDealsForTests([]);
  resetLimits();
  seen.length = 0;
  id = `smart-cart-${Math.random()}`;
  await sessions.getOrCreate(id);
  await sessions.patch(id, { cartMode: 'theme', widgetContract: CART_OPS_CONTRACT });
});

const headers = async () => ({ 'Content-Type': 'application/json', 'x-caddie-cart': 'theme', 'x-caddie-widget': CART_OPS_CONTRACT, ...(await ownerHeaders(id)) });
const chat = async (body: Record<string, unknown>) => fetch(`${base}/api/chat`, { method: 'POST', headers: await headers(), body: JSON.stringify({ sessionId: id, ...body }) });
const syncBasket = async (lines: Line[]) => fetch(`${base}/api/session/${id}/basket`, { method: 'POST', headers: await headers(), body: JSON.stringify({ cartToken: 'c1', lines }) });
/** The men's three, which these checks were written for; the ladies and kids deals are covered in smartCart.test.ts. */
const MEN = new Set<string>(['any-3-polos', 'any-2-mens-trousers', 'any-2-shorts']);
const progress = (state: SmartCartState | undefined) => state?.offers.filter((o) => MEN.has(o.offerId)).map((o) => `${o.offerId}:${o.status}:${o.qualifyingUnits}`);
const stored = async () => (await sessions.getOrCreate(id)).smartCart;

describe('Smart Cart on the session, from each fresh cart read', () => {
  it('a /api/chat basket is evaluated before converse() runs', async () => {
    const res = await chat({ text: 'what is in my basket?', basket: { cartToken: 'c1', lines: [line('p1', POLO, '611', 2, TRIGGERED_POLO), line('t1', TROUSERS, '650', 1, { '__any-2-trousers': 'any-2-trousers' })] } });
    expect(res.status).toBe(200);
    expect(progress(seen[0])).toEqual(['any-3-polos:ONE_AWAY:2', 'any-2-mens-trousers:ONE_AWAY:1', 'any-2-shorts:INACTIVE:0']);
    expect(seen[0]?.offers[0]?.matchedLineKeys).toEqual(['p1']);
    expect(seen[0]?.offers[0]?.matchedVariantIds).toEqual(['611']);
  });

  it('the basket route re-evaluates', async () => {
    expect((await syncBasket([line('p1', POLO, '611', 1, TRIGGERED_POLO)])).status).toBe(200);
    expect(progress(await stored())).toEqual(['any-3-polos:IN_PROGRESS:1', 'any-2-mens-trousers:INACTIVE:0', 'any-2-shorts:INACTIVE:0']);
    await syncBasket([line('p1', POLO, '611', 3, TRIGGERED_POLO)]);
    expect(progress(await stored())?.[0]).toBe('any-3-polos:QUALIFIED:3');
  });

  it('the basket route answers with the state it just evaluated, for the widget preview - progress and wording only', async () => {
    const res = await syncBasket([line('p1', POLO, '611', 2, TRIGGERED_POLO), line('t1', TROUSERS, '650', 1, { '__any-2-trousers': 'any-2-trousers' })]);
    const body = (await res.json()) as { ok: boolean; lines: number; smartCart: { evaluatedAt: number; offers: Array<Record<string, unknown>> } | null };
    expect(body.ok).toBe(true);
    expect(body.lines).toBe(2);
    expect(body.smartCart?.evaluatedAt).toBe((await stored())?.evaluatedAt);
    expect(body.smartCart?.offers).toHaveLength(8);
    expect(body.smartCart?.offers.slice(0, 3)).toEqual([
      // Two £20 polos, and no qualifying polo in this catalogue to finish the set above £59.99: the offer cannot lower the price.
      { offerId: 'any-3-polos', name: 'Any 3 Polos', status: 'ONE_AWAY', qualifyingUnits: 2, requiredUnits: 3, remainingUnits: 1, worthwhile: false, canSuggest: false, display: { deal: '3 for £59.99', units: 'polos', one: 'polo', many: 'polos', title: 'Any 3 Polos' } },
      { offerId: 'any-2-mens-trousers', name: "Any 2 Men's Trousers", status: 'ONE_AWAY', qualifyingUnits: 1, requiredUnits: 2, remainingUnits: 1, worthwhile: false, canSuggest: false, display: { deal: '2 for £49', units: 'trousers', one: 'pair of trousers', many: 'pairs of trousers', title: 'Any 2 Trousers' } },
      { offerId: 'any-2-shorts', name: 'Any 2 Shorts', status: 'INACTIVE', qualifyingUnits: 0, requiredUnits: 2, remainingUnits: 2, worthwhile: null, canSuggest: false, display: { deal: '2 for £45', units: 'shorts', one: 'pair of shorts', many: 'pairs of shorts', title: 'Any 2 Shorts' } },
    ]);
    // Nothing of the cart's internals goes back: no line keys, variant ids or trigger keys.
    const sent = JSON.stringify(body);
    for (const secret of ['p1', 't1', '611', '650', '__3_Polo_Bundle', '__any-2-trousers', 'matchedLineKeys', 'matchedVariantIds', 'triggerKey']) expect(sent).not.toContain(secret);
  });

  it('an empty basket on the basket route answers with every offer inactive, not null', async () => {
    const body = (await (await syncBasket([])).json()) as { smartCart: { offers: Array<{ status: string }> } | null };
    expect(body.smartCart?.offers.length).toBe(8);
    expect(body.smartCart?.offers.every((o) => o.status === 'INACTIVE')).toBe(true);
  });

  it('untriggered lines on the basket route leave every offer inactive', async () => {
    await syncBasket([line('p1', POLO, '611', 3), line('t1', TROUSERS, '650', 2)]);
    expect((await stored())?.offers.every((o) => o.status === 'INACTIVE')).toBe(true);
    expect((await sessions.getOrCreate(id)).basket).toHaveLength(2);
  });

  it('a settled cart outcome re-evaluates from the cart it reports', async () => {
    await syncBasket([line('p1', POLO, '610', 2, TRIGGERED_POLO)]);
    expect(progress(await stored())?.[0]).toBe('any-3-polos:ONE_AWAY:2');
    await sessions.append(id, [{ id: 'u1', role: 'user', text: 'Add the Elite Polo in M', createdAt: new Date().toISOString() }]);
    const out = await executeCommerceAction({ session: await sessions.getOrCreate(id), utterance: 'Add the Elite Polo in M' }, { type: 'add-product', productId: POLO.id, options: { Size: 'M' } });
    expect(out.dispatched).toBe(true);
    // Caddie's add lands as a plain line - it writes no properties (phase 2) - while the theme's drawer took the triggered line to 3 meanwhile.
    const before = { cartToken: 'c1', lines: [line('p1', POLO, '610', 2, TRIGGERED_POLO)] };
    const after = { cartToken: 'c1', lines: [line('p1', POLO, '610', 3, TRIGGERED_POLO), line('p2', POLO, '611', 1)] };
    const res = await fetch(`${base}/api/session/${id}/cart-outcome`, { method: 'POST', headers: await headers(), body: JSON.stringify({ operationId: out.operationId, status: 'applied', before, after, evidence: 'ajax-cart-read' }) });
    expect(((await res.json()) as { status: string }).status).toBe('applied');
    const state = await stored();
    expect(progress(state)?.[0]).toBe('any-3-polos:QUALIFIED:3');
    // The polo Caddie added does not count: no trigger.
    expect(state?.offers[0]?.matchedLineKeys).toEqual(['p1']);
    expect((await sessions.getOrCreate(id)).basket?.map((l) => l.lineId)).toEqual(['p1', 'p2']);
  });

  it('a cart really read as empty clears every offer', async () => {
    await syncBasket([line('p1', POLO, '611', 3, TRIGGERED_POLO)]);
    expect(progress(await stored())?.[0]).toBe('any-3-polos:QUALIFIED:3');
    await chat({ text: 'anything in my basket?', basket: { cartToken: 'c1', lines: [] } });
    expect(progress(seen[0])).toEqual(['any-3-polos:INACTIVE:0', 'any-2-mens-trousers:INACTIVE:0', 'any-2-shorts:INACTIVE:0']);
    await syncBasket([line('p1', POLO, '611', 3, TRIGGERED_POLO)]);
    await syncBasket([]);
    expect((await stored())?.offers.every((o) => o.status === 'INACTIVE' && o.qualifyingUnits === 0)).toBe(true);
  });

  it('a message with no basket (the read failed) keeps the last state, untouched', async () => {
    await syncBasket([line('p1', POLO, '611', 2, TRIGGERED_POLO)]);
    const before = await stored();
    const res = await chat({ text: 'hello' });
    expect(res.status).toBe(200);
    expect(seen[0]).toEqual(before);
    expect(await stored()).toEqual(before);
  });

  it('with no read ever made, there is no state - not an empty one', async () => {
    await chat({ text: 'hello' });
    expect(seen[0]).toBeUndefined();
  });

  it('an outcome for an older operation does not overwrite a newer one\'s state', async () => {
    await sessions.append(id, [{ id: 'u1', role: 'user', text: 'Add the Elite Polo in M', createdAt: new Date().toISOString() }]);
    const first = await executeCommerceAction({ session: await sessions.getOrCreate(id), utterance: 'Add the Elite Polo in M' }, { type: 'add-product', productId: POLO.id, options: { Size: 'M' } });
    // A newer operation exists: the older report settles but does not set the basket, nor Smart Cart.
    const session = await sessions.getOrCreate(id);
    const record = session.cartOperations![first.operationId!]!;
    await sessions.patch(id, { cartOperations: { ...session.cartOperations, newer: { ...record, id: 'newer', createdAt: record.createdAt + 1000, status: 'applied' } } });
    await syncBasket([line('p1', POLO, '611', 1, TRIGGERED_POLO)]);
    const kept = await stored();
    await fetch(`${base}/api/session/${id}/cart-outcome`, { method: 'POST', headers: await headers(), body: JSON.stringify({ operationId: first.operationId, status: 'applied', before: { lines: [] }, after: { lines: [line('p9', POLO, '611', 3, TRIGGERED_POLO)] }, evidence: 'ajax-cart-read' }) });
    expect(await stored()).toEqual(kept);
  });
});
