import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Product } from '@caddie/shared';
import { packReadiness, replyShape } from '../src/ai/verify.js';
import { setDealsForTests, type DealRecipe } from '../src/catalog/bundles.js';
import { setCatalogueForTests } from '../src/catalog/sync.js';
import { env } from '../src/env.js';
import { rememberShopper } from '../src/shopper/remember.js';
import { sessions } from '../src/session/store.js';
import { runTool } from '../src/tools/index.js';
import { packStatus, packStatusFacts, readPackChoices } from '../src/tools/packState.js';

/**
 * A Cool & Wet Ambassador Pack showed a red Warrior Jacket sold out in the
 * customer's size, and trousers reading "34 / 34" before any leg was chosen -
 * they had asked for a 36, which the trousers do not come in. A pack is ready
 * only when every piece has a confirmed choice that makes a real variant in
 * stock.
 */

const BRAND = [env.shopify.brandTag].filter(Boolean) as string[];
let next = 1000;

function piece(title: string, options: Array<{ name: string; values: string[] }>, soldOut: (combo: Record<string, string>) => boolean = () => false): Product {
  const combos = options.reduce<Array<Record<string, string>>>((acc, option) => acc.flatMap((combo) => option.values.map((value) => ({ ...combo, [option.name]: value }))), [{}]);
  return {
    id: `gid://shopify/Product/${next++}`,
    title,
    url: '',
    imageUrl: null,
    vendor: 'Druids',
    productType: null,
    tags: [...BRAND],
    price: { amount: 25, currency: 'GBP' },
    options,
    variants: combos.map((combo) => ({
      id: `gid://shopify/ProductVariant/${next++}`,
      title: Object.values(combo).join(' / '),
      available: !soldOut(combo),
      price: { amount: 25, currency: 'GBP' },
      options: combo,
    })),
    description: 'Waterproof.',
  };
}

const TOPS = { name: 'Size', values: ['S', 'M', 'L', 'XL'] };
const WARRIOR_RED = piece('WARRIOR JACKET - RED', [TOPS], (combo) => combo.Size === 'S');
const TEX_BLACK = piece('TEX RAIN JACKET - BLACK', [TOPS]);
const MIDLAYER = piece('HECTAR MIDLAYER - GREY', [TOPS]);
const POLO = piece('GOLF TEE POLO - WHITE', [TOPS]);
const TROUSERS = piece('INFINITE RAIN TROUSERS - BLACK', [
  { name: 'WAIST SIZE', values: ['32', '34', '36'] },
  { name: 'LEG LENGTH', values: ['30', '32', '34'] },
]);
const BELT = piece('TOUR PRO BELT - BLACK', [{ name: 'Size', values: ['S/M', 'L/XL'] }]);
const SOCKS = piece('GOLF SOCKS - BLACK', [{ name: 'Size', values: ['ONE SIZE'] }]);

const step = (title: string, products: Product[]) => ({ title, collection: title, productIds: new Set(products.map((p) => p.id)) });
const COOL_WET: DealRecipe = {
  handle: 'ambassador-men-coolwet',
  title: 'AMBASSADOR PACK - COOL & WET',
  range: 'men',
  prices: { GBP: 159.99 },
  dynamicPrices: false,
  url: '',
  condition: 'coolwet',
  conditionTitle: 'COOL & WET',
  steps: [
    step('JACKET', [WARRIOR_RED, TEX_BLACK]),
    step('MIDLAYER', [MIDLAYER]),
    step('POLO', [POLO]),
    step('TROUSERS', [TROUSERS]),
    step('BELT', [BELT]),
    step('SOCKS', [SOCKS]),
  ],
};
const PIECES = [WARRIOR_RED, MIDLAYER, POLO, TROUSERS, BELT, SOCKS];

let id = '';
beforeEach(async () => {
  setCatalogueForTests([WARRIOR_RED, TEX_BLACK, MIDLAYER, POLO, TROUSERS, BELT, SOCKS]);
  setDealsForTests([COOL_WET]);
  id = `pack-${Math.random()}`;
  await sessions.getOrCreate(id);
  // The pack on screen, as showDeal leaves it - the red Warrior first.
  await sessions.patch(id, {
    cartMode: 'theme',
    lastShown: { kind: 'pack', bundle: COOL_WET.handle, items: PIECES.map((p, i) => ({ id: p.id, title: p.title, slot: COOL_WET.steps[i]!.title })) },
    packInFocus: COOL_WET.handle,
    packsShown: { [COOL_WET.handle]: { items: PIECES.map((p) => ({ id: p.id, title: p.title })) } },
  });
});
afterEach(() => setDealsForTests([]));

async function choose(said: string, lastReply = '') {
  const session = await sessions.getOrCreate(id);
  const choices = readPackChoices(said, lastReply, PIECES, session.packChoices?.[COOL_WET.handle] ?? {});
  await sessions.patch(id, { packChoices: { [COOL_WET.handle]: choices } });
  return choices;
}
const status = async () => packStatus(await sessions.getOrCreate(id), COOL_WET.handle);

async function say(utterance: string, tool = 'add_pack_to_cart', args: Record<string, unknown> = {}) {
  const session = await sessions.getOrCreate(id);
  return runTool(tool, args, { session, utterance });
}

describe('what counts as chosen', () => {
  it('waist 34, leg 36: waist confirmed, 36 kept as asked for, the leg left open - never 34/34', async () => {
    const choices = await choose('Waist 34, leg 36');
    expect(choices).toMatchObject({ waist: '34', requested: { leg: '36' } });
    expect(choices.leg).toBeUndefined();
  });

  it('then "34", asked for the leg: the leg is confirmed', async () => {
    await choose('Waist 34, leg 36');
    const choices = await choose('34', "The trousers don't come in a 36 leg. Would you like 30, 32 or 34?");
    expect(choices).toMatchObject({ waist: '34', leg: '34' });
    expect(choices.requested).toBeUndefined();
  });

  it('a bare "34" after a reply about something else: the one measurement still open takes it', async () => {
    await choose('Waist 34, leg 36');
    const choices = await choose('34', 'Which jacket would you like instead?');
    expect(choices).toMatchObject({ waist: '34', leg: '34' });
  });

  it('said while the pack is being shown: recommend_pack records it itself, the 36 kept as requested', async () => {
    await sessions.patch(id, { lastShown: undefined, packChoices: {} });
    const result = await say('Waist 34, leg 36.', 'recommend_pack', { query: COOL_WET.title });
    expect((await sessions.getOrCreate(id)).packChoices?.[COOL_WET.handle]).toMatchObject({ waist: '34', requested: { leg: '36' } });
    expect(result.facts).toMatch(/Requested but unavailable: .*36/);
  });

  it('a card opening on 34/34 is not a choice: with no leg said, the leg is open', async () => {
    await rememberShopper(id, { usualSize: 'S', waist: '34' });
    const now = await status();
    expect(now.ready).toBe(false);
    expect(now.pieces.find((p) => p.product === TROUSERS)!.missing.map((m) => m.kind)).toEqual(['leg']);
  });
});

describe('readiness', () => {
  it('the red Warrior sold out in S: not ready, and a swap is what is asked', async () => {
    await rememberShopper(id, { usualSize: 'S' });
    await choose('waist 34 leg 34');
    const now = await status();
    expect(now.ready).toBe(false);
    expect(now.next).toBe('The red Warrior Jacket is sold out in S. I can swap it for another jacket in S - shall I?');
    expect(packStatusFacts(now)).toMatch(/NOT READY - never say it is ready/);
  });

  it('only the one missing thing is asked - the top and waist are known', async () => {
    await rememberShopper(id, { usualSize: 'M' });
    await choose('Waist 34, leg 36');
    const now = await status();
    expect(now.next).toBe("Waist 34 is fine, but the trousers don't come in a 36 leg. Would you like 30, 32 or 34?");
    expect(now.next).not.toMatch(/top size/);
  });
});

describe('which question comes first', () => {
  it('a chosen piece sold out in their size comes before the missing leg; then the leg', async () => {
    await rememberShopper(id, { usualSize: 'S' });
    await choose('Waist 34, leg 36');
    const first = await status();
    expect(first.next).toBe('The red Warrior Jacket is sold out in S. I can swap it for another jacket in S - shall I?');
    expect(packStatusFacts(first)).toMatch(/Ask only this: "The red Warrior Jacket is sold out/);
    await say('Yes, swap it.', 'recommend_pack', { query: 'Ambassador Pack', swap: WARRIOR_RED.id });
    const after = await status();
    expect(after.next).toBe("Waist 34 is fine, but the trousers don't come in a 36 leg. Would you like 30, 32 or 34?");
    expect((await sessions.getOrCreate(id)).packChoices?.[COOL_WET.handle]).toMatchObject({ waist: '34', requested: { leg: '36' } });
  });

  it('the order after that: top, then waist, then leg', async () => {
    await sessions.patch(id, {
      lastShown: { kind: 'pack', bundle: COOL_WET.handle, items: [TEX_BLACK, MIDLAYER, POLO, TROUSERS, BELT, SOCKS].map((p, i) => ({ id: p.id, title: p.title, slot: COOL_WET.steps[i]!.title })) },
    });
    const pieces = [TEX_BLACK, MIDLAYER, POLO, TROUSERS, BELT, SOCKS];
    const at = async () => packStatus(await sessions.getOrCreate(id), COOL_WET.handle, pieces).next;
    expect(await at()).toBe('What top size do you wear?');
    await rememberShopper(id, { usualSize: 'S' });
    expect(await at()).toBe('What waist size do you need for the trousers?');
    await choose('waist 34');
    expect(await at()).toBe('Which leg length for the trousers: 30, 32 or 34?');
  });
});

describe('adding the pack', () => {
  it('"add this pack" before it is complete: nothing added, the one missing thing asked', async () => {
    await rememberShopper(id, { usualSize: 'M' });
    await choose('waist 34');
    const result = await say('Add this pack');
    expect(result.actions ?? []).toEqual([]);
    expect(result.speech).toBe('Which leg length for the trousers: 30, 32 or 34?');
    expect(result.facts).toMatch(/^Nothing was added/);
  });

  it('complete: the six exact variants go in', async () => {
    await rememberShopper(id, { usualSize: 'M' });
    await choose('34 waist, 32 leg');
    const result = await say('Add this pack');
    // The pack goes in as one bundle - its pieces, each a variant.
    const ids = (result.actions ?? []).flatMap((action) => ('pieces' in action ? (action.pieces as Array<{ variantId: string }>).map((p) => p.variantId) : []));
    const want = (product: Product, combo: Record<string, string>) =>
      product.variants.find((v) => Object.entries(combo).every(([k, val]) => v.options[k] === val))!.id.split('/').pop();
    expect(ids).toHaveLength(6);
    expect(ids).toEqual(
      expect.arrayContaining([
        want(WARRIOR_RED, { Size: 'M' }),
        want(MIDLAYER, { Size: 'M' }),
        want(POLO, { Size: 'M' }),
        want(TROUSERS, { 'WAIST SIZE': '34', 'LEG LENGTH': '32' }),
        want(BELT, { Size: 'S/M' }),
        want(SOCKS, { Size: 'ONE SIZE' }),
      ]),
    );
  });

  it('a search since has taken the screen: the pack they saw goes in, not a fresh build', async () => {
    await rememberShopper(id, { usualSize: 'M' });
    await choose('34 waist, 32 leg');
    await sessions.patch(id, { lastShown: { kind: 'products', items: [{ id: MIDLAYER.id, title: MIDLAYER.title }] } });
    const result = await say('Add the Cool & Wet pack', 'add_pack_to_cart', { pack: COOL_WET.title });
    const ids = (result.actions ?? []).flatMap((action) => ('pieces' in action ? (action.pieces as Array<{ variantId: string }>).map((p) => p.variantId) : []));
    expect(ids).toContain(WARRIOR_RED.variants.find((v) => v.options.Size === 'M')!.id.split('/').pop());
  });

  it('refused for want of consent: the facts say what is confirmed, so "selected leg 36" has nothing to stand on', async () => {
    await rememberShopper(id, { usualSize: 'S' });
    await choose('Waist 34, leg 36');
    const result = await say('OK, select that size.');
    expect(result.actions ?? []).toEqual([]);
    expect(result.facts).toMatch(/never say a size was selected/);
    expect(result.facts).toMatch(/Pack status: NOT READY/);
    expect(result.facts).toMatch(/Requested but unavailable: .*36/);
  });

  it('the model adding it without being asked: nothing added', async () => {
    await rememberShopper(id, { usualSize: 'M' });
    await choose('34 waist, 32 leg');
    const result = await say("I'm usually M.");
    expect(result.actions ?? []).toEqual([]);
    expect(result.facts).toMatch(/Basket unchanged/);
  });

  it('"yes" to "shall I add it?": added', async () => {
    await rememberShopper(id, { usualSize: 'M' });
    await choose('34 waist, 32 leg');
    await sessions.append(id, [
      { id: 'u1', role: 'user', text: '34 waist, 32 leg', createdAt: new Date(Date.now() - 2000).toISOString() },
      { id: 'a1', role: 'assistant', text: 'Your pack is ready in M with 34/32 trousers. Shall I add it to your basket?', createdAt: new Date(Date.now() - 1000).toISOString() },
    ]);
    const result = await say('Yes');
    expect((result.actions ?? []).length).toBeGreaterThan(0);
  });
});

describe('changing the jacket', () => {
  it('only the jacket changes; every choice stands, and the new one is in stock in S', async () => {
    await rememberShopper(id, { usualSize: 'S' });
    await choose('waist 34 leg 34');
    const before = (await sessions.getOrCreate(id)).packChoices;
    const result = await say('Change the jacket.', 'recommend_pack', { query: 'Ambassador Pack', swap: WARRIOR_RED.id });
    const items = result.attachment?.kind === 'pack' ? result.attachment.recommendation.items.map((p) => p.title) : [];
    expect(items).toContain('TEX RAIN JACKET - BLACK');
    expect(items).not.toContain('WARRIOR JACKET - RED');
    for (const kept of ['HECTAR MIDLAYER - GREY', 'GOLF TEE POLO - WHITE', 'INFINITE RAIN TROUSERS - BLACK', 'TOUR PRO BELT - BLACK', 'GOLF SOCKS - BLACK']) expect(items).toContain(kept);
    expect((await sessions.getOrCreate(id)).packChoices).toEqual(before);
    expect((await status()).ready).toBe(true);
  });
});

describe('short replies', () => {
  const said = 'Show me the Cool & Wet pack';
  it('two short sentences and one question pass', () => {
    expect(replyShape('The Cool & Wet Ambassador Pack is six pieces for £159.99. What top size do you wear?', said)).toEqual([]);
    expect(replyShape("The Warrior Jacket is sold out in S. I can swap it for one in stock in S - shall I?", 'chest 36')).toEqual([]);
    expect(replyShape('Your pack is ready in S with 34/34 trousers. Shall I add it to your basket?', '34')).toEqual([]);
  });

  it('a catalogue read aloud, or two questions, does not', () => {
    const long =
      'The Cool & Wet pack includes the Warrior Jacket in red, the Hectar Midlayer in grey, the Golf Tee Polo in white, the Infinite Rain Trousers in black, a belt and socks. It is built for wet rounds and keeps you dry. What top size do you wear? And what waist?';
    const shape = replyShape(long, said, PIECES).map((v) => v.claim);
    expect(shape).toEqual(expect.arrayContaining(['more than one question', 'lists the cards']));
    expect(shape.some((claim) => /sentences/.test(claim))).toBe(true);
  });

  it('asked what is included: the longer answer is allowed', () => {
    const detail = 'It includes the Warrior Jacket, the Hectar Midlayer, the Golf Tee Polo, the Infinite Rain Trousers, a belt and socks. Everything is picked for wet rounds. The jacket and trousers are waterproof.';
    expect(replyShape(detail, "What's included in the Ambassador Pack?", PIECES)).toEqual([]);
  });

  it('"your pack is ready" is caught while the pack is not', () => {
    expect(packReadiness('Great, your pack is ready. Shall I add it?', 'Pack status: NOT READY - never say it is ready')).toEqual([{ kind: 'status', claim: 'your pack is ready' }]);
    expect(packReadiness('Your pack is ready. Shall I add it?', 'Pack status: READY - every piece chosen')).toEqual([]);
  });
});
