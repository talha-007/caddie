import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Product } from '@caddie/shared';
import { setDealsForTests } from '../src/catalog/bundles.js';
import { categoriesOf } from '../src/catalog/constraints.js';
import { setCatalogueForTests } from '../src/catalog/sync.js';
import { env } from '../src/env.js';
import { sessionRouter } from '../src/routes/session.js';
import { vapiRouter } from '../src/routes/vapi.js';
import { noteShoppingFocus, readFocus } from '../src/session/focus.js';
import { sessions } from '../src/session/store.js';
import { runTool } from '../src/tools/index.js';

/**
 * "Show me men's jackets and polos", then "polos", then "different colours" -
 * and the Caddie showed the Clima Jacket in its other colours. The jacket
 * cards were still on screen and the model picked the product itself. For
 * days each fix went into the prompt. These pin the fix that does not depend
 * on the model: the customer's latest explicit request is the focus, a
 * follow-up inherits it, and the tools hold the model's picks to it.
 *
 * Every tool call below passes what the model actually got wrong - a jacket
 * when the customer is on polos - and checks what the customer gets.
 */

const BRAND = [env.shopify.brandTag].filter(Boolean) as string[];
let next = 5000;

function product(title: string, price: number, description: string | null = null): Product {
  const sizes = ['S', 'M', 'L', 'XL'];
  const id = next;
  next += 10;
  return {
    id: `gid://shopify/Product/${id}`,
    title,
    url: '',
    imageUrl: null,
    vendor: 'Druids',
    productType: null,
    tags: [...BRAND],
    price: { amount: price, currency: 'GBP' },
    options: [{ name: 'Size', values: sizes }],
    variants: sizes.map((size, i) => ({
      id: `gid://shopify/ProductVariant/${id + i + 1}`,
      title: size,
      available: true,
      price: { amount: price, currency: 'GBP' },
      options: { Size: size },
    })),
    description,
  };
}

const ELITE_WHITE = product('ELITE POLO - WHITE', 20, 'Breathable piqué polo.');
const ELITE_BLACK = product('ELITE POLO - BLACK', 20, 'Breathable piqué polo.');
const ELITE_NAVY = product('ELITE POLO - NAVY', 20, 'Breathable piqué polo.');
const PRIME_SAGE = product('PRIME POLO - SAGE', 15, 'A lighter polo.');
const CLIMA_NAVY = product('CLIMA JACKET 3.0 - NAVY', 58, 'Fully waterproof and breathable.');
const CLIMA_BLACK = product('CLIMA JACKET 3.0 - BLACK', 58, 'Fully waterproof and breathable.');
const LADIES_POLO = product('LADIES ELITE POLO - PINK', 20);
const CATALOGUE = [ELITE_WHITE, ELITE_BLACK, ELITE_NAVY, PRIME_SAGE, CLIMA_NAVY, CLIMA_BLACK, LADIES_POLO];
const JACKET_CARDS = [CLIMA_NAVY, CLIMA_BLACK];

let base = '';
let server: ReturnType<ReturnType<typeof express>['listen']>;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/session', sessionRouter);
  app.use('/api/vapi', vapiRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

let id = '';
beforeEach(async () => {
  setCatalogueForTests(CATALOGUE);
  setDealsForTests([]);
  id = `focus-${Math.random()}`;
  await sessions.getOrCreate(id);
});

/** A customer message, read as converse() reads it before any tool runs, then recorded. */
async function say(text: string) {
  await noteShoppingFocus(id, text);
  await sessions.append(id, [{ id: `u-${Math.random()}`, role: 'user', text, createdAt: new Date().toISOString() }]);
}

/** A tool as the model called it, this turn. */
async function tool(name: string, args: Record<string, unknown>, utterance: string) {
  // The turn's words are already recorded by say(); the tools see them as this turn's utterance.
  return runTool(name, args, { session: await sessions.getOrCreate(id), utterance });
}

/** Cards on screen, as a search leaves them. */
async function onScreen(products: Product[]) {
  await sessions.patch(id, { lastShown: { kind: 'products', items: products.map((p) => ({ id: p.id, title: p.title })) } });
}

const shown = (result: Awaited<ReturnType<typeof tool>>) => (result.attachment?.kind === 'products' ? result.attachment.products : []);
const kinds = (products: Product[]) => [...new Set(products.flatMap((p) => [...categoriesOf(p)]))];
const focus = async () => (await sessions.getOrCreate(id)).activeShoppingContext;

describe('the recurring failure: jackets and polos, then polos, then different colours', () => {
  it('stays on men\'s polos - searched or shown in other colours, whatever the model picks', async () => {
    await say("Hey Caddie, show me some options for men's products. I would like to see jackets and polos.");
    expect((await focus())?.kinds.sort()).toEqual(['jacket', 'polo']);
    await onScreen(JACKET_CARDS);

    await say('Show me polos');
    expect(await focus()).toMatchObject({ kinds: ['polo'], range: 'men', pending: ['jacket'], source: 'explicit' });

    await say('Show me different colors');
    expect(await focus()).toMatchObject({ kinds: ['polo'], range: 'men', source: 'inherited' });

    // The model searched the jacket again...
    const searched = shown(await tool('search_products', { query: 'clima jacket colours', category: 'jacket', productName: 'Clima Jacket' }, 'Show me different colors'));
    expect(searched.length).toBeGreaterThan(0);
    expect(kinds(searched)).toEqual(['polo']);
    expect(searched.every((p) => !/LADIES/.test(p.title))).toBe(true);

    // ...or asked for the jacket's other colours, with only jacket cards on screen.
    const colours = shown(await tool('other_colours', { productId: CLIMA_NAVY.id }, 'Show me different colors'));
    expect(colours.length).toBeGreaterThan(0);
    expect(kinds(colours)).toEqual(['polo']);
  });
});

describe('the most recent explicit request wins', () => {
  it('jackets, then polos, then "another one": another polo', async () => {
    await say('Show me jackets');
    await say('Show me polos');
    await say('Another one');
    expect(kinds(shown(await tool('search_products', { query: 'jacket', category: 'jacket' }, 'Another one')))).toEqual(['polo']);
  });

  it('polos, then jackets, then "different colours": jackets', async () => {
    await say('Show me polos');
    await say('Show me jackets');
    await say('Different colours');
    await onScreen([ELITE_WHITE, ELITE_BLACK]);
    expect(kinds(shown(await tool('search_products', { query: 'polo colours', category: 'polo' }, 'Different colours')))).toEqual(['jacket']);
    expect(kinds(shown(await tool('other_colours', { productId: ELITE_WHITE.id }, 'Different colours')))).toEqual(['jacket']);
  });

  it('a polo, then "something cheaper": a cheaper polo, compared with the polo', async () => {
    await say("Show me men's polos");
    await sessions.patch(id, { focusProductId: CLIMA_NAVY.id, lastLead: { id: ELITE_WHITE.id, colour: 'white' } });
    await say('Something cheaper');
    const cheaper = shown(await tool('search_products', { query: 'cheaper jacket', category: 'jacket' }, 'Something cheaper'));
    expect(kinds(cheaper)).toEqual(['polo']);
    // Cheaper than the £20 polo, not the £58 jacket the model had last looked up.
    expect(cheaper.every((p) => p.price.amount < 20)).toBe(true);
  });
});

describe('a product in focus', () => {
  it('"what about the Clima Jacket?" then "is it waterproof?": the Clima Jacket', async () => {
    await say('Show me polos');
    await say('What about the Clima Jacket?');
    expect(await focus()).toMatchObject({ kinds: ['jacket'], design: 'CLIMA JACKET 3.0' });
    await onScreen([ELITE_WHITE, ELITE_BLACK]);
    await sessions.patch(id, { focusProductId: ELITE_WHITE.id });
    await say('Is it waterproof?');
    const answer = await tool('product_info', { which: 'Elite Polo', question: 'is it waterproof?' }, 'Is it waterproof?');
    expect(answer.facts).toMatch(/About: CLIMA JACKET 3\.0/);
  });

  it('a tapped jacket card, while on polos: "what sizes?" is the jacket', async () => {
    await say('Show me polos');
    await onScreen([ELITE_WHITE, CLIMA_NAVY]);
    const tapped = await fetch(`${base}/api/session/${id}/choice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: CLIMA_NAVY.id, options: { Size: 'M' } }),
    });
    expect(tapped.ok).toBe(true);
    expect(await focus()).toMatchObject({ kinds: ['jacket'], productId: CLIMA_NAVY.id, source: 'card-action' });
    await say('What sizes?');
    const answer = await tool('product_info', { which: 'Elite Polo', question: 'what sizes?' }, 'What sizes?');
    expect(answer.facts).toMatch(/About: CLIMA JACKET 3\.0 - NAVY/);
  });

  it('their own reference still stands: "the first one" is the first card', async () => {
    await say("What about the Clima Jacket?");
    await onScreen([ELITE_WHITE, CLIMA_NAVY]);
    await say('What sizes does the first one come in?');
    const answer = await tool('product_info', { which: 'the first one', question: 'what sizes?' }, 'What sizes does the first one come in?');
    expect(answer.facts).toMatch(/About: ELITE POLO - WHITE/);
  });
});

describe('cards on screen do not move the focus', () => {
  it('jacket cards still showing, focus on polos: "show me more" is more polos', async () => {
    await say('Show me polos');
    await onScreen(JACKET_CARDS);
    await say('Show me more');
    expect((await focus())?.kinds).toEqual(['polo']);
    expect(kinds(shown(await tool('search_products', { query: 'more jackets', category: 'jacket' }, 'Show me more')))).toEqual(['polo']);
  });

  it('a card being shown is never a focus change - only words and taps are', () => {
    const polos = readFocus('Show me polos', undefined, 1).focus;
    // Nothing in what readFocus reads is on screen: the same words give the same focus whatever is showing.
    expect(readFocus('show me more', polos, 2).focus?.kinds).toEqual(['polo']);
    expect(readFocus('I like it', polos, 2).focus?.kinds).toEqual(['polo']);
  });
});

describe('several kinds asked at once', () => {
  it('"jackets and polos": both kept, and a follow-up searches both', async () => {
    await say("Show me men's jackets and polos");
    expect((await focus())?.kinds.sort()).toEqual(['jacket', 'polo']);
    await say('Show me more');
    expect(kinds(shown(await tool('search_products', { query: 'polo' }, 'Show me more'))).sort()).toEqual(['jacket', 'polo']);
  });

  it('then "polos": polos is the focus, and the jackets are kept aside - never inherited', async () => {
    await say("Show me men's jackets and polos");
    await say('Show me polos');
    await say('Different colours');
    expect(await focus()).toMatchObject({ kinds: ['polo'], pending: ['jacket'] });
  });
});

describe('spoken the same as typed', () => {
  it('a Vapi voice turn reads the same focus: "polos", then "different colours" with the model on the jacket', async () => {
    const call = (said: string[], tools: Array<{ name: string; args: Record<string, unknown> }>) =>
      fetch(`${base}/api/vapi/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            type: 'tool-calls',
            call: { id, assistantOverrides: { metadata: { sessionId: id } } },
            artifact: { messages: said.map((message) => ({ role: 'user', message })) },
            toolCallList: tools.map((t, i) => ({ id: `t${i}`, function: { name: t.name, arguments: JSON.stringify(t.args) } })),
          },
        }),
      }).then((r) => r.json());

    await onScreen(JACKET_CARDS);
    await call(["I'd like to see some men's polos"], [{ name: 'search_products', args: { query: 'polos', range: 'mens' } }]);
    expect(await focus()).toMatchObject({ kinds: ['polo'], range: 'men' });
    await onScreen(JACKET_CARDS);
    await call(["I'd like to see some men's polos", 'Different colours'], [{ name: 'other_colours', args: { productId: CLIMA_NAVY.id } }]);
    const last = (await sessions.getOrCreate(id)).lastShown;
    const products = (last?.items ?? []).map((item) => CATALOGUE.find((p) => p.id === item.id)!).filter(Boolean);
    expect(products.length).toBeGreaterThan(0);
    expect(kinds(products)).toEqual(['polo']);
  });
});
