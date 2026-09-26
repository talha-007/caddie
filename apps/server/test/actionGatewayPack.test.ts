import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CartAction, Product } from '@caddie/shared';

/**
 * Packs through the Action Gateway: from chat or from the pack card's Add
 * button, the same checks - the pack the customer sees, every piece a real
 * variant in stock, the price checkout will charge, one pack in the basket.
 * Only who authorised it differs.
 */

let checkoutPrice = 20;
vi.mock('../src/shopify/storefrontCart.js', async (original) => ({
  ...(await original<typeof import('../src/shopify/storefrontCart.js')>()),
  storefrontCartEnabled: () => true,
  checkoutTotal: vi.fn(async () => checkoutPrice),
}));

const { setCatalogueForTests } = await import('../src/catalog/sync.js');
const { setDealsForTests } = await import('../src/catalog/bundles.js');
const { resetLimits } = await import('../src/lib/rateLimit.js');
const { sessionRouter } = await import('../src/routes/session.js');
const { sessions } = await import('../src/session/store.js');
const { runTool } = await import('../src/tools/index.js');
const { env } = await import('../src/env.js');

const BRAND = [env.shopify.brandTag].filter(Boolean) as string[];
function product(id: string, title: string, sizes: string[] | null, price: number, soldOut: string[] = []): Product {
  const values = sizes ?? ['Default Title'];
  const name = sizes ? 'Size' : 'Title';
  return {
    id: `gid://shopify/Product/${id}`,
    title,
    url: `https://store/products/${id}`,
    imageUrl: null,
    vendor: 'Druids',
    productType: null,
    tags: BRAND,
    price: { amount: price, currency: 'GBP' },
    options: [{ name, values }],
    variants: values.map((value, i) => ({ id: `gid://shopify/ProductVariant/${id}${i}`, title: value, available: !soldOut.includes(value), price: { amount: price, currency: 'GBP' }, options: { [name]: value } })),
    description: null,
  };
}

const POLO = product('61', 'GOLF TEE POLO - WHITE', ['S', 'M', 'L'], 20, ['L']);
const SOCKS = product('62', 'GOLF SOCKS - BLACK', null, 6);
const OTHER = product('63', 'PRIME POLO - SAGE', ['S', 'M', 'L'], 20);
// £20 for pieces that come to £26: checkout has to be seen to charge £20.
const DEAL = {
  handle: 'ambassador-test',
  title: 'AMBASSADOR PACK - TEST',
  range: 'men' as const,
  prices: { GBP: 20 },
  dynamicPrices: false,
  url: 'https://store/pages/pack',
  format: 'plus' as const,
  trigger: { '__amb-mens-condition': 'test' },
  steps: [
    { title: 'Polo', collection: 'p', productIds: new Set([POLO.id, OTHER.id]) },
    { title: 'Socks', collection: 's', productIds: new Set([SOCKS.id]) },
  ],
};

let base = '';
let server: ReturnType<ReturnType<typeof express>['listen']>;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/session', sessionRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

let id = '';
beforeEach(async () => {
  setCatalogueForTests([POLO, SOCKS, OTHER]);
  setDealsForTests([DEAL]);
  resetLimits();
  checkoutPrice = 20;
  id = `pack-gw-${Math.random()}`;
  await sessions.getOrCreate(id);
  // The pack on screen, as showDeal leaves it.
  await sessions.patch(id, {
    cartMode: 'theme',
    lastShown: { kind: 'pack', bundle: DEAL.handle, items: [POLO, SOCKS].map((p, i) => ({ id: p.id, title: p.title, slot: DEAL.steps[i]!.title })) },
    packInFocus: DEAL.handle,
    packsShown: { [DEAL.handle]: { items: [POLO, SOCKS].map((p) => ({ id: p.id, title: p.title })) } },
  });
});

const bundles = (actions: CartAction[] | undefined) => (actions ?? []).filter((a): a is Extract<CartAction, { type: 'add-bundle' }> => a.type === 'add-bundle');
async function chat(utterance: string, args: Record<string, unknown> = {}) {
  return runTool('add_pack_to_cart', args, { session: await sessions.getOrCreate(id), utterance });
}
async function click(pieces: Array<{ productId: string; options: Record<string, string> }>) {
  const r = await fetch(`${base}/api/session/${id}/add-pack`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-caddie-cart': 'theme' }, body: JSON.stringify({ handle: DEAL.handle, pieces }) });
  return (await r.json()) as { ok: boolean; actions?: CartAction[]; message?: string };
}

describe('from chat', () => {
  it('"add the pack in M": the pack on screen, M polo, at the price checkout charges', async () => {
    const result = await chat('Add the pack in M');
    const [bundle] = bundles(result.actions);
    expect(bundle?.pieces.map((p) => p.variantId)).toEqual([`${POLO.id.split('/').pop()}1`, `${SOCKS.id.split('/').pop()}0`]);
    expect(result.speech).toMatch(/£20/);
  });

  it('a yes to "shall I add the pack?": added', async () => {
    await sessions.patch(id, { packChoices: { [DEAL.handle]: { top: 'M' } } });
    await sessions.append(id, [
      { id: 'u1', role: 'user', text: "I'm an M", createdAt: new Date(Date.now() - 2000).toISOString() },
      { id: 'a1', role: 'assistant', text: 'The pack is ready in M. Shall I add the pack to your basket?', createdAt: new Date(Date.now() - 1000).toISOString() },
    ]);
    expect(bundles((await chat('Yes')).actions)).toHaveLength(1);
  });

  it('the model adding the pack while the customer asks a question: refused', async () => {
    const result = await chat('Is the polo breathable?');
    expect(bundles(result.actions)).toHaveLength(0);
    expect(result.outcome).toMatchObject({ ok: false, reason: 'not-authorized' });
  });

  it('not ready (no size yet): nothing added, the one thing asked', async () => {
    const result = await chat('Add the pack');
    expect(bundles(result.actions)).toHaveLength(0);
    expect(result.outcome).toMatchObject({ ok: false, reason: 'not-ready' });
    expect(result.speech).toMatch(/size/i);
  });
});

describe('the pack card\'s Add button', () => {
  it('ready: the pack, in the sizes picked', async () => {
    const reply = await click([{ productId: POLO.id, options: { Size: 'S' } }, { productId: SOCKS.id, options: {} }]);
    expect(reply.ok).toBe(true);
    expect(bundles(reply.actions)[0]?.pieces[0]?.variantId).toBe(`${POLO.id.split('/').pop()}0`);
  });

  it('a size not picked: not added', async () => {
    const reply = await click([{ productId: POLO.id, options: {} }, { productId: SOCKS.id, options: {} }]);
    expect(reply.ok).toBe(false);
    expect(bundles(reply.actions)).toHaveLength(0);
  });

  it('a size sold out: not added', async () => {
    const reply = await click([{ productId: POLO.id, options: { Size: 'L' } }, { productId: SOCKS.id, options: {} }]);
    expect(reply.ok).toBe(false);
    expect(reply.message).toMatch(/sold out/i);
  });

  it('checkout would charge something else: not added', async () => {
    // A pack of its own: whether checkout applies a pack's price is remembered per pack for ten minutes.
    const priced = { ...DEAL, handle: 'ambassador-price-test' };
    setDealsForTests([priced]);
    await sessions.patch(id, {
      lastShown: { kind: 'pack', bundle: priced.handle, items: [POLO, SOCKS].map((p, i) => ({ id: p.id, title: p.title, slot: priced.steps[i]!.title })) },
      packsShown: { [priced.handle]: { items: [POLO, SOCKS].map((p) => ({ id: p.id, title: p.title })) } },
    });
    checkoutPrice = 26;
    const r = await fetch(`${base}/api/session/${id}/add-pack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-caddie-cart': 'theme' },
      body: JSON.stringify({ handle: priced.handle, pieces: [{ productId: POLO.id, options: { Size: 'S' } }, { productId: SOCKS.id, options: {} }] }),
    });
    const reply = (await r.json()) as { ok: boolean; message?: string };
    expect(reply.ok).toBe(false);
    expect(reply.message).toMatch(/can't add/i);
  });

  it('a card that no longer matches the pack shown: not added', async () => {
    const reply = await click([{ productId: OTHER.id, options: { Size: 'S' } }, { productId: SOCKS.id, options: {} }]);
    expect(reply.ok).toBe(false);
    expect(reply.message).toMatch(/changed/i);
  });

  it('the same pack again replaces the one already sent - never two', async () => {
    const first = bundles((await click([{ productId: POLO.id, options: { Size: 'S' } }, { productId: SOCKS.id, options: {} }])).actions)[0]!;
    const second = bundles((await click([{ productId: POLO.id, options: { Size: 'M' } }, { productId: SOCKS.id, options: {} }])).actions)[0]!;
    expect(second.replaceBundles).toEqual([first.bundleId]);
  });
});
