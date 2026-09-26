import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Product } from '@caddie/shared';
import { setDealsForTests } from '../src/catalog/bundles.js';
import { setCatalogueForTests } from '../src/catalog/sync.js';
import { env } from '../src/env.js';
import { resetLimits } from '../src/lib/rateLimit.js';
import { sessionRouter } from '../src/routes/session.js';
import { toolsRouter } from '../src/routes/tools.js';
import { vapiRouter } from '../src/routes/vapi.js';
import { rememberShopper } from '../src/shopper/remember.js';
import { sessions } from '../src/session/store.js';
import { runTool } from '../src/tools/index.js';

/**
 * Phase 0 containment. The audit found /api/tools open in production - every
 * tool, run `direct`, past basket authorisation and search provenance, for
 * any session id; the size form's fields thrown away by guards written for a
 * model; the Vapi webhook open without its secret; and the session routes
 * unlimited. These pin the closed doors, and that the widget's own calls
 * still get through.
 */

const BRAND = [env.shopify.brandTag].filter(Boolean) as string[];
const SIZES = ['S', 'M', 'L', 'XL'];
const POLO: Product = {
  id: 'gid://shopify/Product/8800',
  title: 'ELITE POLO - NAVY',
  url: '',
  imageUrl: null,
  vendor: 'Druids',
  productType: null,
  tags: [...BRAND],
  price: { amount: 20, currency: 'GBP' },
  options: [{ name: 'Size', values: SIZES }],
  variants: SIZES.map((size, i) => ({ id: `gid://shopify/ProductVariant/880${i}`, title: size, available: true, price: { amount: 20, currency: 'GBP' }, options: { Size: size } })),
  description: null,
};

let base = '';
let server: ReturnType<ReturnType<typeof express>['listen']>;
const wasProd = env.isProd;
const hadSecret = env.vapi.webhookSecret;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/tools', toolsRouter);
  app.use('/api/session', sessionRouter);
  app.use('/api/vapi', vapiRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

beforeEach(() => {
  setCatalogueForTests([POLO]);
  setDealsForTests([]);
  resetLimits();
});
afterEach(() => {
  env.isProd = wasProd;
  env.vapi.webhookSecret = hadSecret;
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

/** A shopper somewhere else, with a basket-mode session and a profile of their own. */
async function someoneElse(): Promise<string> {
  const id = `victim-${Math.random()}`;
  await sessions.getOrCreate(id);
  await sessions.patch(id, { cartMode: 'theme' });
  await rememberShopper(id, { usualSize: 'M', range: 'men' });
  return id;
}

describe('/api/tools in production: only what the storefront widget calls', () => {
  it('a mutating tool is refused, and nothing on the session changes', async () => {
    env.isProd = true;
    const victim = await someoneElse();
    const before = JSON.stringify(await sessions.getOrCreate(victim));
    for (const [tool, args] of [
      ['add_to_cart', { productId: POLO.id, options: { Size: 'M' }, quantity: 5 }],
      ['update_cart_item', { lineId: 'line-1', quantity: 0 }],
      ['add_pack_to_cart', { pack: 'Ambassador Pack' }],
      ['note_shopper', { colours: { words: ['pink'], strength: 'required' }, budget: { amount: 5, kind: 'max', per: 'total' } }],
      ['recommend_outfit', { seed: 'polo' }],
      ['search_products', { query: 'polo' }],
    ] as const) {
      const res = await post(`/api/tools/${tool}`, { sessionId: victim, args });
      expect(res.status, tool).toBe(404);
    }
    // Another shopper's session, named outright, is exactly as it was.
    expect(JSON.stringify(await sessions.getOrCreate(victim))).toBe(before);
  });

  it('the widget\'s own calls still work: a card loading its product', async () => {
    env.isProd = true;
    const res = await post('/api/tools/get_product_details', { sessionId: `w-${Math.random()}`, args: { productId: POLO.id } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attachment?: { kind: string } };
    expect(body.attachment?.kind).toBe('products');
  });

  it('view_cart is a dev-harness call: refused in production, served in development', async () => {
    env.isProd = true;
    expect((await post('/api/tools/view_cart', { sessionId: `w-${Math.random()}`, args: {} })).status).toBe(404);
    env.isProd = false;
    expect((await post('/api/tools/view_cart', { sessionId: `w-${Math.random()}`, args: {} })).status).toBe(200);
  });

  it('in development the dev harness still adds through it', async () => {
    env.isProd = false;
    const id = `dev-${Math.random()}`;
    await sessions.getOrCreate(id);
    // As the widget does: the size tapped on the card first, then Add.
    expect((await post(`/api/session/${id}/choice`, { productId: POLO.id, options: { Size: 'M' } })).status).toBe(200);
    const res = await post('/api/tools/add_to_cart', { sessionId: id, args: { productId: POLO.id, options: { Size: 'M' } } }, { 'x-caddie-cart': 'theme' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { actions?: unknown[] };
    expect(body.actions?.length).toBe(1);
  });
});

describe('the size form: what the customer typed is theirs', () => {
  const submit = (sessionId: string, args: Record<string, unknown>) => post('/api/tools/find_my_size', { sessionId, args });

  it('usual size L, height 180cm, chest 40in: all kept, and L stays their usual size', async () => {
    env.isProd = true;
    const id = `form-${Math.random()}`;
    const res = await submit(id, { usualSize: 'L', heightValue: 180, heightUnit: 'cm', chestCm: 101.6, audience: 'men' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { speech: string; attachment?: { kind: string } };
    expect(body.speech).not.toMatch(/What size do you usually wear/);
    expect(body.attachment?.kind).toBe('size');
    const session = await sessions.getOrCreate(id);
    expect(session.sizeProfile).toMatchObject({ heightValue: 180, heightUnit: 'cm', chestCm: 101.6 });
    expect(session.shopper?.usualSize).toBe('L');
  });

  it('only a usual size: not asked for again', async () => {
    const id = `form-${Math.random()}`;
    const body = (await (await submit(id, { usualSize: 'L', audience: 'men' })).json()) as { speech: string };
    expect(body.speech).not.toMatch(/What size do you usually wear/);
    expect((await sessions.getOrCreate(id)).shopper?.usualSize).toBe('L');
  });

  it('no waist submitted: no waist invented or stored', async () => {
    const id = `form-${Math.random()}`;
    await submit(id, { usualSize: 'L', heightValue: 180, heightUnit: 'cm', audience: 'men' });
    const session = await sessions.getOrCreate(id);
    expect(session.shopper?.waist).toBeUndefined();
    expect(session.sizeProfile.waistCm).toBeUndefined();
    expect(session.sizeProfile.chestCm).toBeUndefined();
  });

  it('anything that is not a size-form field is refused', async () => {
    const id = `form-${Math.random()}`;
    expect((await submit(id, { usualSize: 'L', waist: '34' })).status).toBe(400);
    expect((await submit(id, { heightValue: 'tall' })).status).toBe(400);
    expect((await sessions.getOrCreate(id)).shopper?.usualSize).toBeUndefined();
  });

  it('the model still cannot: a usual size and height nobody said are not taken', async () => {
    const id = `model-${Math.random()}`;
    const session = await sessions.getOrCreate(id);
    await runTool('find_my_size', { usualSize: 'XL', heightValue: 190, heightUnit: 'cm', chestCm: 100, audience: 'men' }, { session, utterance: 'what size polo would I be?' });
    const after = await sessions.getOrCreate(id);
    expect(after.sizeProfile.heightValue).toBeUndefined();
    expect(after.shopper?.usualSize).not.toBe('XL');
  });
});

describe('the Vapi webhook until voice is customer-ready', () => {
  const call = (headers: Record<string, string> = {}) =>
    post('/api/vapi/webhook', { message: { type: 'tool-calls', call: { id: `call-${Math.random()}` }, toolCallList: [] } }, headers);

  it('production without VAPI_WEBHOOK_SECRET: refused, not open', async () => {
    env.isProd = true;
    env.vapi.webhookSecret = '';
    expect((await call()).status).toBe(503);
  });

  it('a wrong secret is refused; the right one gets through', async () => {
    env.isProd = true;
    env.vapi.webhookSecret = 'right-secret';
    expect((await call({ 'x-vapi-secret': 'wrong-secret' })).status).toBe(401);
    expect((await call()).status).toBe(401);
    expect((await call({ 'x-vapi-secret': 'right-secret' })).status).toBe(200);
  });
});

describe('session routes are rate limited, generously', () => {
  it('a shopper tapping sizes is never limited; a script hammering one session is', async () => {
    const id = `taps-${Math.random()}`;
    await sessions.getOrCreate(id);
    const tap = () => post(`/api/session/${id}/choice`, { productId: POLO.id, options: { Size: 'M' } });
    // An hour of heavy browsing is well inside the limit.
    for (let i = 0; i < 60; i += 1) expect((await tap()).status).toBe(200);
    let limited = 0;
    for (let i = 0; i < 600 && !limited; i += 1) if ((await tap()).status === 429) limited = i;
    expect(limited).toBeGreaterThan(0);
    // Another shopper is untouched by it.
    const other = `other-${Math.random()}`;
    await sessions.getOrCreate(other);
    expect((await post(`/api/session/${other}/choice`, { productId: POLO.id, options: { Size: 'L' } })).status).toBe(200);
  }, 60_000);

  it('/basket and /profile are limited the same way', async () => {
    const id = `sync-${Math.random()}`;
    let limited = false;
    for (let i = 0; i < 700 && !limited; i += 1) {
      const res = await post(`/api/session/${id}/${i % 2 ? 'basket' : 'profile'}`, i % 2 ? { lines: [] } : { range: 'men', size: 'M' });
      limited = res.status === 429;
    }
    expect(limited).toBe(true);
  }, 60_000);
});
