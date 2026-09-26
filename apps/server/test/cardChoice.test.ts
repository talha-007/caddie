import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Product } from '@caddie/shared';
import { setDealsForTests } from '../src/catalog/bundles.js';
import { setCatalogueForTests } from '../src/catalog/sync.js';
import { env } from '../src/env.js';
import { sessionRouter } from '../src/routes/session.js';
import { rememberShopper } from '../src/shopper/remember.js';
import { sessions } from '../src/session/store.js';
import { bareReference, runTool } from '../src/tools/index.js';

/**
 * The customer picked M on the Tex Rain Jacket's card, said "add it", and the
 * Caddie - which had never heard of the M - asked for their size and reached
 * for a different jacket. The card now tells the server what the customer
 * picked themselves, and only that.
 */

const BRAND = [env.shopify.brandTag].filter(Boolean) as string[];

function jacket(title: string, base: number, out: string[] = []): Product {
  const sizes = ['S', 'M', 'L', 'XL'];
  return {
    id: `gid://shopify/Product/${base}`,
    title,
    url: '',
    imageUrl: null,
    vendor: 'Druids',
    productType: 'RAIN JACKET',
    tags: [...BRAND],
    price: { amount: 68, currency: 'GBP' },
    options: [{ name: 'Size', values: sizes }],
    variants: sizes.map((size, i) => ({
      id: `gid://shopify/ProductVariant/${base + i + 1}`,
      title: size,
      available: !out.includes(size),
      price: { amount: 68, currency: 'GBP' },
      options: { Size: size },
    })),
    description: 'Fully waterproof.',
  };
}

const TEX = jacket('TEX RAIN JACKET - BLACK', 100);
const WARRIOR = jacket('WARRIOR JACKET - BLACK', 200);
const GLEN = jacket('GLEN RAIN JACKET - BLUE', 300, ['M']);

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

beforeEach(() => {
  setCatalogueForTests([TEX, WARRIOR, GLEN]);
  setDealsForTests([]);
});

/** A shopper on the storefront: the basket is the theme's, so an add comes back as the widget's instruction. */
async function shopper(): Promise<string> {
  const id = `card-${Math.random()}`;
  await sessions.getOrCreate(id);
  await sessions.patch(id, { cartMode: 'theme' });
  return id;
}

/** Exactly what the card sends when the customer taps a size. */
function tap(sessionId: string, product: Product, options: Record<string, string>) {
  return fetch(`${base}/api/session/${sessionId}/choice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ productId: product.id, options }),
  });
}

async function add(sessionId: string, args: Record<string, unknown>, utterance: string) {
  const session = await sessions.getOrCreate(sessionId);
  const result = await runTool('add_to_cart', args, { session, utterance });
  const variantIds = (result.actions ?? []).flatMap((action) => ('lines' in action ? action.lines.map((line) => line.variantId) : []));
  return { result, variantIds };
}

describe('the card tells the server what the customer picked', () => {
  it('kept for that product, and that product is now "it"', async () => {
    const id = await shopper();
    expect((await tap(id, TEX, { Size: 'M' })).status).toBe(200);
    const session = await sessions.getOrCreate(id);
    expect(session.cardChoices?.[TEX.id]?.options).toEqual({ Size: 'M' });
    expect(session.focusProductId).toBe(TEX.id);
  });

  it('only options the product really has; an unknown product is refused', async () => {
    const id = await shopper();
    expect((await tap(id, TEX, { Size: 'XXXL', Colour: 'Pink' })).status).toBe(400);
    expect((await tap(id, jacket('NOT IN THE CATALOGUE', 900), { Size: 'M' })).status).toBe(400);
    expect((await sessions.getOrCreate(id)).cardChoices).toBeUndefined();
  });
});

describe('"add it" after tapping M', () => {
  it('adds the M it was tapped on - no size question', async () => {
    const id = await shopper();
    await tap(id, TEX, { Size: 'M' });
    const { result, variantIds } = await add(id, { productId: TEX.id }, 'Add it.');
    expect(result.speech).not.toMatch(/what size|which size/i);
    expect(variantIds).toEqual(['102']);
  });

  it('the card wins over the size the model took from their profile, and the profile stays XL', async () => {
    const id = await shopper();
    await rememberShopper(id, { usualSize: 'XL' });
    await tap(id, TEX, { Size: 'M' });
    const { variantIds } = await add(id, { productId: TEX.id, options: { Size: 'XL' } }, 'Add it.');
    expect(variantIds).toEqual(['102']);
    expect((await sessions.getOrCreate(id)).shopper?.usualSize).toBe('XL');
  });

  it('a size they say now wins over the card', async () => {
    const id = await shopper();
    await tap(id, TEX, { Size: 'M' });
    const { variantIds } = await add(id, { productId: TEX.id, options: { Size: 'L' } }, 'Add it in L.');
    expect(variantIds).toEqual(['103']);
  });

  it('M tapped on one jacket is not M for another', async () => {
    const id = await shopper();
    await tap(id, TEX, { Size: 'M' });
    // Then they move on to the Warrior jacket, by name.
    const session = await sessions.getOrCreate(id);
    await sessions.patch(id, {
      messages: [...session.messages, { id: 'm1', role: 'user', text: 'Tell me about the Warrior jacket', createdAt: new Date(Date.now() + 1000).toISOString() }],
      focusProductId: WARRIOR.id,
    });
    const asked = await add(id, { productId: WARRIOR.id }, 'Add it.');
    expect(asked.variantIds).toEqual([]);
    expect(asked.result.speech).toMatch(/size/i);
    // Nor may the model carry it across: M was never said for the Warrior.
    const guessed = await add(id, { productId: WARRIOR.id, options: { Size: 'M' } }, 'Add it.');
    expect(guessed.variantIds).toEqual([]);
    expect(guessed.result.speech).toMatch(/what size/i);
  });

  it('M sold out since: nothing added, and the customer is told', async () => {
    const id = await shopper();
    await tap(id, GLEN, { Size: 'M' });
    const { result, variantIds } = await add(id, { productId: GLEN.id }, 'Add it.');
    expect(variantIds).toEqual([]);
    expect(result.speech).toMatch(/out of stock/i);
  });
});

describe('what the card merely shows is not a choice', () => {
  it('with no tap, "add it" asks for the size', async () => {
    const id = await shopper();
    const { result, variantIds } = await add(id, { productId: TEX.id }, 'Add it.');
    expect(variantIds).toEqual([]);
    expect(result.speech).toMatch(/which size/i);
  });
});

describe('focus', () => {
  it('the latest card touched is "it"; a new search lets it go, the choice stays with its product', async () => {
    const id = await shopper();
    await tap(id, TEX, { Size: 'M' });
    await tap(id, WARRIOR, { Size: 'L' });
    expect((await sessions.getOrCreate(id)).focusProductId).toBe(WARRIOR.id);
    const session = await sessions.getOrCreate(id);
    await runTool('search_products', { query: 'rain jacket' }, { session, utterance: 'show me rain jackets' });
    const after = await sessions.getOrCreate(id);
    expect(after.focusProductId).toBeUndefined();
    expect(after.cardChoices?.[TEX.id]?.options).toEqual({ Size: 'M' });
  });
});

describe('the typed flow is unchanged', () => {
  it('a size they said, with no card touched', async () => {
    const id = await shopper();
    const session = await sessions.getOrCreate(id);
    await sessions.patch(id, { messages: [...session.messages, { id: 'm1', role: 'user', text: 'XL', createdAt: new Date().toISOString() }] });
    const { variantIds } = await add(id, { productId: TEX.id, options: { Size: 'XL' } }, 'Add it.');
    expect(variantIds).toEqual(['104']);
  });
});

describe('option names as the store writes them', () => {
  it('"size" and "m" are the product\'s own "Size" and "M"', async () => {
    const id = await shopper();
    expect((await tap(id, TEX, { size: 'm' })).status).toBe(200);
    expect((await sessions.getOrCreate(id)).cardChoices?.[TEX.id]?.options).toEqual({ Size: 'M' });
  });
});

describe('"it" is the card they tapped, not the product the model just recommended', () => {
  it('the model reaches for the lead; "add it" still means the tapped Tex, in M', async () => {
    const id = await shopper();
    await tap(id, TEX, { Size: 'M' });
    const { variantIds } = await add(id, { productId: WARRIOR.id }, 'Add it.');
    expect(variantIds).toEqual(['102']);
  });

  it('even after the model looked another product up', async () => {
    const id = await shopper();
    await tap(id, TEX, { Size: 'M' });
    await sessions.patch(id, { focusProductId: WARRIOR.id });
    const { variantIds } = await add(id, { productId: WARRIOR.id, options: { Size: 'M' } }, 'add it to my basket please');
    expect(variantIds).toEqual(['102']);
  });

  it("a request that names something is the model's to resolve", async () => {
    const id = await shopper();
    await tap(id, TEX, { Size: 'M' });
    const { variantIds, result } = await add(id, { productId: WARRIOR.id }, 'Add that Warrior jacket.');
    expect(variantIds).toEqual([]);
    expect(result.speech).toMatch(/size/i);
  });

  it('a new screen of results lets the tapped card go', async () => {
    const id = await shopper();
    await tap(id, TEX, { Size: 'M' });
    const session = await sessions.getOrCreate(id);
    await runTool('search_products', { query: 'rain jacket' }, { session, utterance: 'show me rain jackets' });
    expect((await sessions.getOrCreate(id)).cardFocus).toBeUndefined();
  });

  it.each([
    ['Add it.', true],
    ['add it to my basket please', true],
    ['Add this one in M', true],
    ['Yes, add it', true],
    ['Add that black jacket', false],
    ['Add the Warrior jacket', false],
    ['add some trousers', false],
  ])('bare reference: %s', (text, bare) => {
    expect(bareReference(text)).toBe(bare);
  });
});
