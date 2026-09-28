import express from 'express';
import { ownerHeaders } from './support/ownership.js';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CartAction, Product } from '@caddie/shared';
import { setDealsForTests } from '../src/catalog/bundles.js';
import { setCatalogueForTests } from '../src/catalog/sync.js';
import { env } from '../src/env.js';
import { resetLimits } from '../src/lib/rateLimit.js';
import { sessionRouter } from '../src/routes/session.js';
import { focusFromCard, noteShoppingFocus } from '../src/session/focus.js';
import { sessions } from '../src/session/store.js';
import { runTool } from '../src/tools/index.js';
import { playWidget } from './support/widgetCart.js';
import { notePendingOffer } from '../src/tools/pending.js';

/**
 * Phase 2: every change to the basket goes through the Action Gateway. The
 * model only requests: whether the customer asked, which product or line,
 * which variant, how many, whether it is in stock - the gateway decides, and
 * nothing changes until it has. The widget's buttons go through it too.
 */

const BRAND = [env.shopify.brandTag].filter(Boolean) as string[];
let next = 4000;
function product(title: string, sizes: string[] | null, soldOut: string[] = []): Product {
  const id = next;
  next += 10;
  const values = sizes ?? ['Default Title'];
  const name = sizes ? 'Size' : 'Title';
  return {
    id: `gid://shopify/Product/${id}`,
    title,
    url: `https://store/products/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    imageUrl: null,
    vendor: 'Druids',
    productType: null,
    tags: [...BRAND],
    price: { amount: 20, currency: 'GBP' },
    options: [{ name, values }],
    variants: values.map((value, i) => ({ id: `gid://shopify/ProductVariant/${id + i + 1}`, title: value, available: !soldOut.includes(value), price: { amount: 20, currency: 'GBP' }, options: { [name]: value } })),
    description: null,
  };
}

const SIZES = ['S', 'M', 'L'];
const ELITE_NAVY = product('ELITE POLO - NAVY', SIZES, ['L']);
const ELITE_WHITE = product('ELITE POLO - WHITE', SIZES);
const CLIMA = product('CLIMA JACKET 3.0 - NAVY', SIZES);
const SOCKS = product('ONE PAIR TOUR ANKLE SOCKS - WHITE', null);
const CATALOGUE = [ELITE_NAVY, ELITE_WHITE, CLIMA, SOCKS];

const variantOf = (p: Product, value: string) => p.variants.find((v) => Object.values(v.options).includes(value))!.id.split('/').pop()!;

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
  setCatalogueForTests(CATALOGUE);
  setDealsForTests([]);
  resetLimits();
  id = `gw-${Math.random()}`;
  await sessions.getOrCreate(id);
  await sessions.patch(id, { cartMode: 'theme', widgetContract: 'cart-ops/1' });
});

async function said(text: string) {
  await noteShoppingFocus(id, text);
  await sessions.append(id, [{ id: `u-${Math.random()}`, role: 'user', text, createdAt: new Date().toISOString() }]);
}
async function caddie(text: string) {
  await sessions.append(id, [{ id: `a-${Math.random()}`, role: 'assistant', text, createdAt: new Date().toISOString() }]);
  // The offer in it is bound by code, as converse binds every reply before it goes out (tools/pending.ts).
  await notePendingOffer(id, text);
}
async function onScreen(products: Product[]) {
  await sessions.patch(id, { lastShown: { kind: 'products', items: products.map((p) => ({ id: p.id, title: p.title })) } });
}
async function tool(name: string, args: Record<string, unknown>, utterance: string) {
  const result = await runTool(name, args, { session: await sessions.getOrCreate(id), utterance });
  // The widget's part: a change handed over is carried out and reported before it counts as made (test/support/widgetCart.ts).
  await playWidget(id, result.actions);
  return result;
}
const adds = (actions: CartAction[] | undefined) => (actions ?? []).flatMap((a) => (a.type === 'add' ? a.lines : []));
const changes = (actions: CartAction[] | undefined) => (actions ?? []).flatMap((a) => (a.type === 'change' ? [{ lineKey: a.lineKey, quantity: a.quantity }] : []));
const post = async (path: string, body: unknown) =>
  fetch(`${base}/api/session/${id}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-caddie-cart': 'theme', ...(await ownerHeaders(id)) }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: (await r.json()) as { ok: boolean; actions?: CartAction[]; message?: string } }));

describe('product adds, from chat', () => {
  it('named: the Elite Polo in navy in M - the model passes the white one, navy M goes in', async () => {
    const result = await tool('add_to_cart', { productId: ELITE_WHITE.id, options: { Size: 'M' } }, 'Add the Elite Polo in navy in M');
    expect(adds(result.actions)).toEqual([{ variantId: variantOf(ELITE_NAVY, 'M'), quantity: 1 }]);
    expect(result.outcome).toMatchObject({ ok: true, action: 'add-product' });
  });

  it('a card tapped, then "add it": that card, in the size tapped', async () => {
    await onScreen([ELITE_NAVY, CLIMA]);
    const session = await sessions.getOrCreate(id);
    await sessions.patch(id, { cardChoices: { [CLIMA.id]: { options: { Size: 'S' }, at: Date.now() + 5000 } }, activeShoppingContext: focusFromCard(CLIMA, session.activeShoppingContext, 1) });
    const result = await tool('add_to_cart', { productId: ELITE_NAVY.id }, 'Add it.');
    expect(adds(result.actions)).toEqual([{ variantId: variantOf(CLIMA, 'S'), quantity: 1 }]);
  });

  it('one size: straight in', async () => {
    const result = await tool('add_to_cart', { productId: SOCKS.id }, 'Add the One Pair Tour Ankle Socks');
    expect(adds(result.actions)).toEqual([{ variantId: variantOf(SOCKS, 'Default Title'), quantity: 1 }]);
  });

  it('a size missing: asked, nothing added, and the add waits for it - for that product only', async () => {
    await said('Add the Elite Polo in navy');
    const asked = await tool('add_to_cart', { productId: ELITE_NAVY.id }, 'Add the Elite Polo in navy');
    expect(adds(asked.actions)).toEqual([]);
    expect(asked.outcome).toMatchObject({ ok: false, reason: 'missing-option' });
    expect((await sessions.getOrCreate(id)).pendingAction).toMatchObject({ type: 'add-product', productIds: [ELITE_NAVY.id], awaiting: 'size' });
    await caddie('Which size would you like for the ELITE POLO - NAVY?');
    await said('M');
    const done = await tool('add_to_cart', { productId: CLIMA.id, options: { Size: 'M' } }, 'M');
    expect(adds(done.actions)).toEqual([{ variantId: variantOf(ELITE_NAVY, 'M'), quantity: 1 }]);
    expect((await sessions.getOrCreate(id)).pendingAction).toBeUndefined();
  });

  it('a different topic lets the waiting add go: "M" later does not finish it', async () => {
    await said('Add the Elite Polo in navy');
    await tool('add_to_cart', { productId: ELITE_NAVY.id }, 'Add the Elite Polo in navy');
    await caddie('Which size would you like?');
    await said('Show me jackets');
    await caddie('Here are some jackets.');
    await said('M');
    const late = await tool('add_to_cart', { productId: ELITE_NAVY.id, options: { Size: 'M' } }, 'M');
    expect(adds(late.actions)).toEqual([]);
    expect(late.outcome).toMatchObject({ ok: false, reason: 'not-authorized' });
  });

  it('a name that fits several products: nothing added, and asked which', async () => {
    const both = product('LADIES TOUR ANKLE SOCKS - PINK', null);
    setCatalogueForTests([...CATALOGUE, both]);
    const result = await tool('add_to_cart', { productId: SOCKS.id }, 'Add the tour ankle socks');
    expect(adds(result.actions)).toEqual([]);
    expect(result.outcome).toMatchObject({ ok: false, reason: 'ambiguous-target' });
  });

  it('nothing to say which product: nothing added - the model\'s pick alone is never enough', async () => {
    await onScreen([ELITE_NAVY, ELITE_WHITE, CLIMA]);
    const result = await tool('add_to_cart', { productId: CLIMA.id, options: { Size: 'M' } }, 'Add it in M');
    expect(adds(result.actions)).toEqual([]);
    expect(result.outcome).toMatchObject({ ok: false, reason: 'no-target' });
    expect(result.speech).toMatch(/Which one/);
  });

  it('the exact variant sold out: nothing added, and said', async () => {
    const result = await tool('add_to_cart', { productId: ELITE_NAVY.id, options: { Size: 'L' } }, 'Add the Elite Polo in navy in L');
    expect(adds(result.actions)).toEqual([]);
    expect(result.outcome).toMatchObject({ ok: false, reason: 'sold-out' });
  });

  it('two when they say two; one when only the model says two', async () => {
    expect(adds((await tool('add_to_cart', { productId: ELITE_NAVY.id, options: { Size: 'M' }, quantity: 2 }, 'Add two of the Elite Polo in navy in M')).actions)).toEqual([{ variantId: variantOf(ELITE_NAVY, 'M'), quantity: 2 }]);
    expect(adds((await tool('add_to_cart', { productId: ELITE_NAVY.id, options: { Size: 'M' }, quantity: 2 }, 'Add the Elite Polo in navy in M')).actions)).toEqual([{ variantId: variantOf(ELITE_NAVY, 'M'), quantity: 1 }]);
  });

  it('a yes answers what was offered - the product and size offered, once', async () => {
    await onScreen([ELITE_NAVY, CLIMA]);
    await said('Show me polos');
    await caddie('Shall I add the Elite Polo in navy in M?');
    await said('Yes');
    const result = await tool('add_to_cart', { productId: CLIMA.id, options: { Size: 'S' }, quantity: 2 }, 'Yes');
    expect(adds(result.actions)).toEqual([{ variantId: variantOf(ELITE_NAVY, 'M'), quantity: 1 }]);
  });

  it('a yes to a product is not a pack', async () => {
    await caddie('Shall I add the Elite Polo in navy in M?');
    await said('Yes');
    const result = await tool('add_pack_to_cart', { pack: 'Ambassador Pack' }, 'Yes');
    expect(result.outcome).toMatchObject({ ok: false, reason: 'not-authorized' });
    expect(result.actions ?? []).toEqual([]);
  });
});

describe('basket changes, from chat', () => {
  const basket = [
    { lineId: 'line-polo', productId: ELITE_NAVY.id, title: ELITE_NAVY.title, variantTitle: 'M', quantity: 1 },
    { lineId: 'line-jacket', productId: CLIMA.id, title: CLIMA.title, variantTitle: 'M', quantity: 1 },
  ];
  beforeEach(async () => {
    await sessions.patch(id, { basket });
  });

  it('"remove the Elite Polo": that line - whatever line the model passes', async () => {
    const result = await tool('update_cart_item', { lineId: 'line-jacket', quantity: 0 }, 'Remove the Elite Polo');
    expect(changes(result.actions)).toEqual([{ lineKey: 'line-polo', quantity: 0 }]);
  });

  it('"what\'s in my basket?": the model removing something is refused', async () => {
    const result = await tool('update_cart_item', { lineId: 'line-polo', quantity: 0 }, "What's in my basket?");
    expect(changes(result.actions)).toEqual([]);
    expect(result.outcome).toMatchObject({ ok: false, reason: 'not-authorized' });
  });

  it('"make the polo quantity 2": the polo, to 2', async () => {
    const result = await tool('update_cart_item', { lineId: 'line-polo', quantity: 2 }, 'Make the polo quantity 2');
    expect(changes(result.actions)).toEqual([{ lineKey: 'line-polo', quantity: 2 }]);
  });

  it('"make it two" right after adding: the item just added', async () => {
    await sessions.patch(id, { lastAdded: { productId: CLIMA.id, turn: 0 } });
    const result = await tool('update_cart_item', { lineId: 'line-polo', quantity: 2 }, 'Make it two');
    expect(changes(result.actions)).toEqual([{ lineKey: 'line-jacket', quantity: 2 }]);
  });

  it('two lines it could be: asked which, nothing changed', async () => {
    await sessions.patch(id, { basket: [...basket, { lineId: 'line-polo-l', productId: ELITE_WHITE.id, title: ELITE_WHITE.title, variantTitle: 'L', quantity: 1 }] });
    const result = await tool('update_cart_item', { lineId: 'line-polo', quantity: 0 }, 'Remove the polo');
    expect(changes(result.actions)).toEqual([]);
    expect(result.speech).toMatch(/Which one do you mean|Which item/);
  });

  it('"make it two" with nothing to say which: asked, not guessed', async () => {
    const result = await tool('update_cart_item', { lineId: 'line-polo', quantity: 2 }, 'Make it two');
    expect(changes(result.actions)).toEqual([]);
    expect(result.outcome?.ok).toBe(false);
  });
});

describe('the widget\'s buttons go through the gateway', () => {
  it('Add, one size: in', async () => {
    const { body } = await post('/add', { items: [{ productId: SOCKS.id, options: {} }] });
    expect(body.ok).toBe(true);
    expect(adds(body.actions)).toEqual([{ variantId: variantOf(SOCKS, 'Default Title'), quantity: 1 }]);
  });

  it('Add, the size on the picker: that variant', async () => {
    const { body } = await post('/add', { items: [{ productId: ELITE_WHITE.id, options: { Size: 'S' } }] });
    expect(adds(body.actions)).toEqual([{ variantId: variantOf(ELITE_WHITE, 'S'), quantity: 1 }]);
  });

  it('Add with a size not picked: refused, nothing to make', async () => {
    const { body } = await post('/add', { items: [{ productId: ELITE_WHITE.id, options: {} }] });
    expect(body.ok).toBe(false);
    expect(body.actions ?? []).toEqual([]);
    expect(body.message).toMatch(/size/i);
  });

  it('Add in a sold-out size: refused', async () => {
    const { body } = await post('/add', { items: [{ productId: ELITE_NAVY.id, options: { Size: 'L' } }] });
    expect(body.ok).toBe(false);
    expect(body.actions ?? []).toEqual([]);
  });

  it('Add, an option the product does not have: refused', async () => {
    const { body } = await post('/add', { items: [{ productId: ELITE_WHITE.id, options: { Size: '9XL' } }] });
    expect(body.ok).toBe(false);
  });

  it('the basket\'s remove button: that line, through the gateway', async () => {
    await sessions.patch(id, { basket: [{ lineId: 'k1', productId: ELITE_WHITE.id, title: ELITE_WHITE.title, variantTitle: 'S', quantity: 2 }] });
    const { body } = await post('/cart-line', { lineId: 'k1', quantity: 0 });
    expect(changes(body.actions)).toEqual([{ lineKey: 'k1', quantity: 0 }]);
    const missing = await post('/cart-line', { lineId: 'nope', quantity: 0 });
    expect(missing.body.ok).toBe(false);
  });

  it('the widget has no way left to change the store cart except what the gateway hands back', () => {
    const widget = fileURLToPath(new URL('../../widget/src/', import.meta.url));
    const useCaddie = readFileSync(`${widget}lib/useCaddie.ts`, 'utf8');
    const themeCart = readFileSync(`${widget}lib/themeCart.ts`, 'utf8');
    for (const direct of ['addToThemeCart', 'addBundleToThemeCart', 'changeThemeCartLine', 'setThemeCartLines']) expect(useCaddie).not.toContain(direct);
    expect(themeCart).not.toMatch(/export \{[^}]*(addLines|addBundle|changeLine|setLines)/);
    expect(useCaddie).toContain('addFromCard(');
    expect(useCaddie).toContain('addPackFromCard(');
    expect(useCaddie).toContain('changeCartLine(');
  });
});
