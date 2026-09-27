import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Product } from '@caddie/shared';
import { readCustomerTurn } from '../src/ai/turn.js';
import { setDealsForTests, type DealRecipe } from '../src/catalog/bundles.js';
import { setCatalogueForTests } from '../src/catalog/sync.js';
import { env } from '../src/env.js';
import { sessionRouter } from '../src/routes/session.js';
import { readFocus, requestedKinds } from '../src/session/focus.js';
import { currentFocus, currentMission, currentPack, currentProduct, livePending } from '../src/session/shoppingSession.js';
import { sessions } from '../src/session/store.js';
import { runTool, sizesNeverGiven, trustedSize } from '../src/tools/index.js';
import type { ToolContext } from '../src/tools/types.js';
import { ownerHeaders } from './support/ownership.js';

/**
 * Phase 3B: one answer to "what is the customer shopping for right now?".
 *
 * The focus moves only on the customer's words, a card they tap or a card
 * they point at. A product the model looks up, a card merely on screen, the
 * page they are on, the last search and the last pack built do not move it.
 * A mission - the kind of thing they set out for, or a pack - scopes what
 * was said in it: its constraints, the sizes said, a basket add left
 * waiting, the pack a bare "34" answers.
 */

const BRAND = [env.shopify.brandTag].filter(Boolean) as string[];
let next = 30000;
function product(title: string, options: Array<{ name: string; values: string[] }> = [{ name: 'Size', values: ['S', 'M', 'L', 'XL'] }], description = 'Breathable.'): Product {
  const combos = options.reduce<Array<Record<string, string>>>((acc, option) => acc.flatMap((combo) => option.values.map((value) => ({ ...combo, [option.name]: value }))), [{}]);
  const id = next;
  next += 50;
  return {
    id: `gid://shopify/Product/${id}`,
    title,
    url: '',
    imageUrl: null,
    vendor: 'Druids',
    productType: null,
    tags: [...BRAND],
    price: { amount: 30, currency: 'GBP' },
    options,
    variants: combos.map((combo, i) => ({ id: `gid://shopify/ProductVariant/${id + i + 1}`, title: Object.values(combo).join(' / '), available: true, price: { amount: 30, currency: 'GBP' }, options: combo })),
    description,
  };
}

const ELITE_NAVY = product('ELITE POLO - NAVY');
const ELITE_WHITE = product('ELITE POLO - WHITE');
const CLIMA = product('CLIMA JACKET 3.0 - NAVY', undefined, 'Fully waterproof and breathable.');
const WARRIOR = product('WARRIOR JACKET - BLACK', undefined, 'Waterproof and windproof.');
const HOODIE = product('CLUB HOODIE - GREY');
const TROUSERS = product('TOUR TROUSERS - BLACK', [
  { name: 'WAIST SIZE', values: ['32', '34', '36'] },
  { name: 'LEG LENGTH', values: ['30', '32', '34'] },
]);
const step = (title: string, products: Product[]) => ({ title, collection: title, productIds: new Set(products.map((p) => p.id)) });
const PACK: DealRecipe = {
  handle: 'ambassador-men-coolwet',
  title: 'AMBASSADOR PACK - COOL & WET',
  range: 'men',
  prices: { GBP: 99.99 },
  dynamicPrices: false,
  url: '',
  condition: 'coolwet',
  conditionTitle: 'COOL & WET',
  steps: [step('JACKET', [WARRIOR]), step('POLO', [ELITE_NAVY]), step('TROUSERS', [TROUSERS])],
};

let id = '';
beforeEach(async () => {
  setCatalogueForTests([ELITE_NAVY, ELITE_WHITE, CLIMA, WARRIOR, HOODIE, TROUSERS]);
  setDealsForTests([PACK]);
  id = `shop-${Math.random()}`;
  await sessions.getOrCreate(id);
  await sessions.patch(id, { cartMode: 'theme' });
});
afterEach(() => setDealsForTests([]));

/** One customer turn as converse() runs it: read by code, then the tools, then recorded with the Caddie's reply. */
async function turn(text: string, during?: (ctx: ToolContext) => Promise<unknown>, reply = 'OK.') {
  await readCustomerTurn(id, text);
  const result = during ? await during({ session: await sessions.getOrCreate(id), utterance: text }) : undefined;
  await sessions.append(id, [
    { id: `u-${Math.random()}`, role: 'user', text, createdAt: new Date().toISOString() },
    { id: `a-${Math.random()}`, role: 'assistant', text: reply, createdAt: new Date().toISOString() },
  ]);
  return result as Awaited<ReturnType<typeof runTool>> | undefined;
}
const tool = (name: string, args: Record<string, unknown>) => (ctx: ToolContext) => runTool(name, args, ctx);
const session = () => sessions.getOrCreate(id);
const ctxFor = async (utterance: string): Promise<ToolContext> => ({ session: await session(), utterance });
const onScreen = (products: Product[]) => sessions.patch(id, { lastShown: { kind: 'products', items: products.map((p) => ({ id: p.id, title: p.title })) } });
const addedVariants = (result: Awaited<ReturnType<typeof runTool>> | undefined) => (result?.actions ?? []).flatMap((action) => ('lines' in action ? action.lines.map((line) => line.variantId) : []));

/* ---------------- focus ---------------- */

describe('one focus, moved only by the customer', () => {
  it('jackets -> polos -> "different colours": polos', async () => {
    await turn('show me jackets');
    await turn('show me polos');
    await onScreen([CLIMA, WARRIOR]); // the jacket cards are still up
    await turn('different colours');
    expect(currentFocus(await session())?.kinds).toEqual(['polo']);
  });

  it('polos -> jackets -> "another one": jackets', async () => {
    await turn('show me polos');
    await turn('show me jackets');
    await turn('another one');
    expect(currentFocus(await session())?.kinds).toEqual(['jacket']);
  });

  it('old cards on screen do not win over what they asked for', async () => {
    await turn('show me polos');
    await onScreen([CLIMA, WARRIOR]);
    const { resolveSearchIntent } = await import('../src/tools/searchIntent.js');
    const { readIntent } = await import('../src/shopper/profile.js');
    await readCustomerTurn(id, 'show me another one');
    const intent = resolveSearchIntent({ query: 'jacket', category: 'jacket' }, await ctxFor('show me another one'), readIntent('show me another one'));
    expect(intent.categories?.value).toEqual(['polo']);
  });

  it('a product the model looks up does not move the focus', async () => {
    await turn('tell me about the Elite Polo in navy');
    expect(currentProduct(await session())?.id).toBe(ELITE_NAVY.id);
    await turn('is it breathable?', async (ctx) => {
      await runTool('get_product_details', { productId: CLIMA.id }, ctx);
      await runTool('product_info', { which: 'Clima Jacket', question: 'is it breathable?' }, ctx);
    });
    expect(currentProduct(await session())?.id).toBe(ELITE_NAVY.id);
  });

  it('pointing at a card - "the second one" - moves it; being on screen does not', async () => {
    await turn('show me polos');
    await onScreen([ELITE_WHITE, ELITE_NAVY]);
    await turn('ok');
    expect(currentProduct(await session())).toBeNull();
    await turn('tell me more about the second one');
    expect(currentProduct(await session())?.id).toBe(ELITE_NAVY.id);
    const answer = await turn('is it breathable?', tool('product_info', { question: 'is it breathable?' }));
    expect(answer?.facts).toMatch(/About: ELITE POLO - NAVY/);
  });

  it('a card tapped is the focus, until they ask for something else', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/session', sessionRouter);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await turn('show me jackets');
    await onScreen([CLIMA, WARRIOR]);
    const res = await fetch(`${base}/api/session/${id}/choice`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await ownerHeaders(id)) }, body: JSON.stringify({ productId: WARRIOR.id, options: { Size: 'L' } }) });
    server.close();
    expect(res.status).toBe(200);
    expect(currentProduct(await session())?.id).toBe(WARRIOR.id);
    await turn('show me polos');
    expect(currentProduct(await session())).toBeNull();
  });
});

describe('the page they are on', () => {
  const onPage = (p: Product) => sessions.patch(id, { page: { pageType: 'product', productId: p.id, productTitle: p.title } as never });

  it('"is this waterproof?" on the Clima page, nothing else in hand: the page', async () => {
    await onPage(CLIMA);
    const answer = await turn('is this waterproof?', tool('product_info', { question: 'is this waterproof?' }));
    expect(answer?.facts).toMatch(/About: CLIMA JACKET 3\.0 - NAVY/);
  });

  it('on the Elite page, "tell me about the Clima Jacket": the Clima - and the page does not take it back', async () => {
    await onPage(ELITE_NAVY);
    await turn('tell me about the Clima Jacket');
    expect(currentProduct(await session())?.id).toBe(CLIMA.id);
    await turn('ok');
    const answer = await turn('is it waterproof?', tool('product_info', { question: 'is it waterproof?' }));
    expect(currentProduct(await session())?.id).toBe(CLIMA.id);
    expect(answer?.facts).toMatch(/About: CLIMA JACKET/);
  });
});

/* ---------------- missions ---------------- */

describe('a new mission', () => {
  it('ends a basket add left waiting: "M" after "show me jackets" does not add the polo', async () => {
    await turn('Add the Elite Polo in navy', tool('add_to_cart', { productId: ELITE_NAVY.id }), 'What size would you like for the Elite Polo?');
    expect(livePending(await session())?.productIds).toContain(ELITE_NAVY.id);
    await turn('show me jackets');
    expect(livePending(await session())).toBeUndefined();
    const result = await turn('M', tool('add_to_cart', { productId: ELITE_NAVY.id, options: { Size: 'M' } }));
    expect(addedVariants(result)).toEqual([]);
  });

  it('is numbered afresh, and its constraints start again', async () => {
    await turn('I need a waterproof jacket');
    const first = currentMission(await session());
    await turn('another one');
    expect(currentMission(await session())).toBe(first);
    await turn('show me polos');
    expect(currentMission(await session())).toBe(first + 1);
    expect(currentFocus(await session())?.constraints?.features).toBeUndefined();
  });
});

/* ---------------- contextual garment words ---------------- */

describe('a garment named as context is not what they are shopping for', () => {
  it('"I want something to wear over a hoodie": not hoodies', () => {
    expect(requestedKinds('I want something to wear over a hoodie')).toEqual([]);
    expect(readFocus('I want something to wear over a hoodie', undefined, 1).focus?.kinds ?? []).not.toContain('hoodie');
  });
  it('"show me hoodies": hoodies', () => {
    expect(requestedKinds('show me hoodies')).toEqual(['hoodie']);
  });
  it('"something under my jacket": not jackets', () => {
    expect(requestedKinds('something to wear under my jacket')).toEqual([]);
  });
  it('"a polo to wear over a hoodie": the polo, and only the polo', () => {
    expect(requestedKinds('a polo to wear over a hoodie')).toEqual(['polo']);
  });
  it('"a jacket that goes with these trousers": the jacket', () => {
    expect(requestedKinds('a jacket that goes with these trousers')).toEqual(['jacket']);
  });
});

/* ---------------- the pack in hand ---------------- */

describe('the pack in hand', () => {
  it('left for polos, a bare "34" does not touch it; back to it, "34" is its waist', async () => {
    await turn('show me the cool and wet pack', tool('recommend_pack', { query: PACK.title }), 'What waist size do you need for the trousers?');
    expect(currentPack(await session())).toBe(PACK.handle);
    await turn('show me polos');
    expect(currentPack(await session())).toBeUndefined();
    await turn('34');
    expect((await session()).packChoices?.[PACK.handle]?.waist).toBeUndefined();

    await turn('back to the cool and wet pack', tool('recommend_pack', { query: PACK.title }), 'What waist size do you need for the trousers?');
    expect(currentPack(await session())).toBe(PACK.handle);
    await turn('34');
    expect((await session()).packChoices?.[PACK.handle]?.waist).toBe('34');
  });

  it('left with its card still on screen, a search is of the store - and does not take the pack up again', async () => {
    await turn('show me the cool and wet pack', tool('recommend_pack', { query: PACK.title }));
    const result = await turn('actually, show me polos', tool('search_products', { query: 'polo' }));
    expect(result?.speech ?? '').not.toMatch(/choices in the/i);
    expect(currentPack(await session())).toBeUndefined();
  });

  it('leaving the pack for polos is a new mission: its sizes and constraints stay with the pack', async () => {
    await turn('show me the cool and wet pack under £120', tool('recommend_pack', { query: PACK.title }));
    const building = currentMission(await session());
    await turn('actually, show me polos');
    expect(currentMission(await session())).toBe(building + 1);
    expect(currentFocus(await session())?.constraints?.budget).toBeUndefined();
    await turn('34');
    // Said after leaving: not a size for the trousers when they go back.
    await turn('back to the cool and wet pack', tool('recommend_pack', { query: PACK.title }));
    expect(trustedSize('34', await ctxFor('back to the cool and wet pack'))).toBeUndefined();
  });

  it('"change the jacket" keeps the pack in hand', async () => {
    await turn('show me the cool and wet pack', tool('recommend_pack', { query: PACK.title }));
    await turn('change the jacket');
    expect(currentPack(await session())).toBe(PACK.handle);
  });

  it('New chat lets the pack, the focus and a waiting add go', async () => {
    await turn('show me the cool and wet pack', tool('recommend_pack', { query: PACK.title }));
    await turn('Add the Elite Polo in navy', tool('add_to_cart', { productId: ELITE_NAVY.id }), 'What size?');
    const app = express();
    app.use(express.json());
    app.use('/api/session', sessionRouter);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/session/${id}/restart`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await ownerHeaders(id)) }, body: '{}' });
    server.close();
    expect(res.status).toBe(200);
    const after = await session();
    expect(currentFocus(after)).toBeUndefined();
    expect(currentPack(after)).toBeUndefined();
    expect(after.pendingAction).toBeUndefined();
    expect(after.lastShown).toBeUndefined();
    expect(after.packChoices).toBeUndefined();
  });
});

/* ---------------- sizes belong to what they were said for ---------------- */

describe('a size said for one product is not another product\'s size', () => {
  it('"Add the Elite Polo in M", then "Add the Clima Jacket": M does not size the jacket', async () => {
    await turn('Add the Elite Polo in navy in M', tool('add_to_cart', { productId: ELITE_NAVY.id, options: { Size: 'M' } }));
    const ctx = await ctxFor('Add the Clima Jacket');
    expect(sizesNeverGiven(['M'], ctx, CLIMA.id)).toEqual(['M']);
    const result = await turn('Add the Clima Jacket', tool('add_to_cart', { productId: CLIMA.id, options: { Size: 'M' } }));
    expect(addedVariants(result)).toEqual([]);
  });

  it('"I\'m usually M", then "Add the Clima Jacket" in M: their usual size stands', async () => {
    await turn("I'm usually M");
    const result = await turn('Add the Clima Jacket', tool('add_to_cart', { productId: CLIMA.id, options: { Size: 'M' } }));
    expect(addedVariants(result)).toHaveLength(1);
  });

  it('"a jacket in L", then "add the second one": L was said for this mission', async () => {
    await turn('show me a jacket in L');
    await onScreen([CLIMA, WARRIOR]);
    expect(sizesNeverGiven(['L'], await ctxFor('add the second one'), WARRIOR.id)).toEqual([]);
  });

  it('polos in M, then jackets: M was for the polos', async () => {
    await turn('show me polos in M');
    await turn('now show me jackets');
    await onScreen([CLIMA, WARRIOR]);
    expect(sizesNeverGiven(['M'], await ctxFor('add the second one'), WARRIOR.id)).toEqual(['M']);
  });

  it('the same design named again keeps its size', async () => {
    await turn('show me the Elite Polo in M');
    await turn('show me jackets');
    expect(sizesNeverGiven(['M'], await ctxFor('add the Elite Polo in navy'), ELITE_NAVY.id)).toEqual([]);
  });
});

describe('packs and outfits are built in a size the customer gave', () => {
  it('the model\'s M, never given: not used', async () => {
    await turn('build me an outfit');
    expect(trustedSize('M', await ctxFor('build me an outfit'))).toBeUndefined();
  });

  it('M said by them: used', async () => {
    await turn('build me an outfit in M');
    expect(trustedSize('M', await ctxFor('build me an outfit in M'))).toBe('M');
  });

  it('their usual L, the model says M: L', async () => {
    await turn("I'm usually L");
    await turn('build me an outfit');
    expect(trustedSize('M', await ctxFor('build me an outfit'))).toBe('L');
  });

  it('a size recommendation they accepted: used for this mission', async () => {
    await turn('I want a polo');
    await turn('my chest is 100cm, what size?', tool('find_my_size', { chestCm: 100, audience: 'men', category: 'polo' }), 'M should fit you.');
    expect((await session()).sizeRecommendation?.size).toBe('M');
    await turn('great, use that size');
    await turn('build me something with it');
    expect(trustedSize('M', await ctxFor('build me something with it'))).toBe('M');
  });
});

/* ---------------- the model's product is a proposal ---------------- */

describe('other_colours: whose colours is the customer\'s to say', () => {
  const CLIMA_BLACK = product('CLIMA JACKET 3.0 - BLACK', undefined, 'Fully waterproof and breathable.');
  beforeEach(() => setCatalogueForTests([ELITE_NAVY, ELITE_WHITE, CLIMA, CLIMA_BLACK, WARRIOR, HOODIE, TROUSERS]));
  const titles = (result: Awaited<ReturnType<typeof runTool>> | undefined) => (result?.attachment?.kind === 'products' ? result.attachment.products.map((p) => p.title) : []);

  it('the Elite Polo in hand, the model passes the Clima Jacket: the Elite Polo', async () => {
    await turn('tell me about the Elite Polo in navy');
    const result = await turn('what other colours are there?', tool('other_colours', { productId: CLIMA.id }));
    expect(titles(result).length).toBeGreaterThan(0);
    expect(titles(result).every((title) => title.startsWith('ELITE POLO'))).toBe(true);
  });

  it('they name the Clima Jacket now: the Clima Jacket, whatever was in hand or passed', async () => {
    await turn('tell me about the Elite Polo in navy');
    const result = await turn('what colours does the Clima Jacket come in?', tool('other_colours', { productId: ELITE_NAVY.id }));
    expect(titles(result).every((title) => title.startsWith('CLIMA JACKET'))).toBe(true);
  });

  it('nothing of theirs to go on: ask which, never the model\'s pick', async () => {
    const result = await turn('what other colours do you do?', tool('other_colours', { productId: CLIMA.id }));
    expect(titles(result)).toEqual([]);
    expect(result?.speech).toMatch(/which/i);
  });
});

describe('find_my_size: the garment sized is the one the customer means', () => {
  it('the Elite Polo in hand, the model passes the Clima Jacket: sized for the polo', async () => {
    await turn('tell me about the Elite Polo in navy');
    const result = await turn('what size should I get? my chest is 100cm', tool('find_my_size', { chestCm: 100, audience: 'men', productId: CLIMA.id }));
    expect(result?.facts).toMatch(/polo chart, for ELITE POLO - NAVY/);
    expect(result?.facts ?? '').not.toMatch(/CLIMA/);
  });

  it('on the Elite Polo page, "what size in this?", the model passes the Clima Jacket: the page', async () => {
    await sessions.patch(id, { page: { pageType: 'product', productId: ELITE_NAVY.id, productTitle: ELITE_NAVY.title } as never });
    const result = await turn('what size in this? my chest is 100cm', tool('find_my_size', { chestCm: 100, audience: 'men', productId: CLIMA.id }));
    expect(result?.facts).toMatch(/for ELITE POLO - NAVY/);
  });

  it('they name the Clima Jacket: the model passing it too is agreed with', async () => {
    const result = await turn('what size Clima Jacket would I be? chest 100cm', tool('find_my_size', { chestCm: 100, audience: 'men', productId: CLIMA.id }));
    expect(result?.facts).toMatch(/jacket chart, for CLIMA JACKET 3\.0 - NAVY/);
  });

  it('no product of theirs: general sizing, not the model\'s jacket', async () => {
    const result = await turn('what size am I? my chest is 100cm', tool('find_my_size', { chestCm: 100, audience: 'men', productId: CLIMA.id, category: 'jacket' }));
    expect(result?.attachment?.kind).toBe('size');
    expect(result?.facts ?? '').not.toMatch(/CLIMA|jacket chart/);
  });
});

describe('a pack is bought only as the pack they mean', () => {
  const packActions = (result: Awaited<ReturnType<typeof runTool>> | undefined) => (result?.actions ?? []).filter((action) => action.type === 'add-bundle');

  it('left for polos, its card still up: a yes to something else buys nothing', async () => {
    await turn('show me the cool and wet pack', tool('recommend_pack', { query: PACK.title }), 'Here is the Cool & Wet pack.');
    await turn('actually, show me polos', undefined, 'Here are some polos. Would you like to see matching trousers?');
    expect(currentPack(await session())).toBeUndefined();
    expect((await session()).lastShown?.kind).toBe('pack');
    const result = await turn('yes', tool('add_pack_to_cart', { pack: PACK.title }));
    expect(packActions(result)).toEqual([]);
  });

  it('...nor does a yes to "shall I add it?" when the pack was left', async () => {
    await turn('show me the cool and wet pack', tool('recommend_pack', { query: PACK.title }));
    await turn('actually, show me polos', undefined, 'Shall I add it to your basket?');
    const result = await turn('yes please', tool('add_pack_to_cart', {}));
    expect(packActions(result)).toEqual([]);
    expect(result?.speech ?? '').toMatch(/haven't added|which pack/i);
  });

  // Every piece chosen, so only which pack it is decides whether anything is added.
  const ready = () => sessions.patch(id, { packChoices: { [PACK.handle]: { top: 'M', waist: '34', leg: '32' } } });

  it('in hand and ready: "shall I add the pack?" - yes - adds it (the control)', async () => {
    await turn('show me the cool and wet pack', tool('recommend_pack', { query: PACK.title }), 'Shall I add the pack to your basket?');
    await ready();
    const result = await turn('yes', tool('add_pack_to_cart', {}));
    expect(packActions(result)).toHaveLength(1);
  });

  it('left for polos, still on screen and ready: "shall I add the pack?" - yes - adds nothing', async () => {
    await turn('show me the cool and wet pack', tool('recommend_pack', { query: PACK.title }));
    await ready();
    await turn('actually, show me polos', undefined, 'Shall I add the pack to your basket?');
    expect((await session()).lastShown?.kind).toBe('pack');
    const result = await turn('yes', tool('add_pack_to_cart', { pack: PACK.title }));
    expect(packActions(result)).toEqual([]);
  });

  it('"what is in this pack?" can still read the pack on screen - to answer, not to buy', async () => {
    await turn('show me the cool and wet pack', tool('recommend_pack', { query: PACK.title }));
    await turn('actually, show me polos');
    const { screenContext } = await import('../src/ai/openai.js');
    const context = screenContext(await session())?.content ?? '';
    expect(context).toMatch(/WARRIOR JACKET - BLACK/);
    expect(context).toMatch(/TOUR TROUSERS - BLACK/);
    expect(currentPack(await session())).toBeUndefined();
  });
});
