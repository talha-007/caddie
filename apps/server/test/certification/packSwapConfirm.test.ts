import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaddieAttachment, CartAction, Product } from '@caddie/shared';

/**
 * The Cool & Wet swap loop (preview store). Top size S, waist 32, leg 34;
 * the red Warrior Jacket sold out in S; the Caddie offered "swap the Warrior
 * for the Caddy Cloud Jacket in Small?" - and "Yes, please replace it" got the
 * same offer back, because the yes was bound to nothing and the model tried
 * to add the pack again. A yes to an offered swap is made before the model
 * runs; the model here is scripted to make the old mistake, and never gets
 * the chance.
 */

type Completion = { content?: string; tool?: { name: string; args: Record<string, unknown> } };
const replies: Completion[] = [];
let modelCalls = 0;

vi.mock('../../src/lib/http.js', async (original) => ({
  ...(await original<typeof import('../../src/lib/http.js')>()),
  fetchWithTimeout: vi.fn(async (url: string) => {
    if (!String(url).includes('chat/completions')) throw new Error(`unexpected call to ${url}`);
    modelCalls += 1;
    const next = replies.shift() ?? { content: 'Anything else?' };
    const message = next.tool
      ? { role: 'assistant', content: null, tool_calls: [{ id: `call-${Math.random()}`, type: 'function', function: { name: next.tool.name, arguments: JSON.stringify(next.tool.args) } }] }
      : { role: 'assistant', content: next.content };
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: next.tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }),
}));

const { setCatalogueForTests } = await import('../../src/catalog/sync.js');
const { setDealsForTests } = await import('../../src/catalog/bundles.js');
const { sessions } = await import('../../src/session/store.js');
const { converse } = await import('../../src/ai/openai.js');
const { runTool } = await import('../../src/tools/index.js');
const { packStatus } = await import('../../src/tools/packState.js');
const { env } = await import('../../src/env.js');

let nextId = 8000;
function garment(title: string, options: Array<{ name: string; values: string[] }>, soldOut: string[] = [], price = 40): Product {
  const id = nextId;
  nextId += 100;
  const combos = options.reduce<Array<Record<string, string>>>((all, option) => all.flatMap((combo) => option.values.map((value) => ({ ...combo, [option.name]: value }))), [{}]);
  return {
    id: `gid://shopify/Product/${id}`,
    title,
    url: '',
    imageUrl: null,
    vendor: 'Druids',
    productType: null,
    tags: [env.shopify.brandTag].filter(Boolean) as string[],
    price: { amount: price, currency: 'GBP' },
    options,
    variants: combos.map((combo, i) => ({
      id: `gid://shopify/ProductVariant/${id + i + 1}`,
      title: Object.values(combo).join(' / '),
      available: !soldOut.some((value) => Object.values(combo).includes(value)),
      price: { amount: price, currency: 'GBP' },
      options: combo,
    })),
    description: null,
  };
}

const TOPS = [{ name: 'Size', values: ['S', 'M', 'L', 'XL'] }];
const WARRIOR_RED = garment('WARRIOR JACKET - RED', TOPS, ['S', 'M', 'L'], 60);
const CADDY_CLOUD = garment('CADDY CLOUD JACKET - NAVY', TOPS);
// The same design in another colour: an offer naming the design alone must not bind to either.
const CADDY_CLOUD_BLACK = garment('CADDY CLOUD JACKET - BLACK', TOPS);
// Red, like the pack: when the Warrior is replaced for the size they give, this is the piece chosen in its place.
const WIND_GUARD = garment('WIND GUARD JACKET - RED', TOPS);
const POLO_RED = garment('ELITE POLO - RED', TOPS, [], 20);
const TROUSERS = garment("MEN'S CLIMA GOLF TROUSERS - NAVY", [
  { name: 'WAIST SIZE', values: ['30', '32', '34'] },
  { name: 'LEG LENGTH', values: ['30', '32', '34'] },
], [], 30);
const POLO_WHITE_OTHER = garment('TOUR POLO - WHITE', TOPS, [], 20);
const EVERYTHING = [WARRIOR_RED, CADDY_CLOUD, CADDY_CLOUD_BLACK, WIND_GUARD, POLO_RED, TROUSERS, POLO_WHITE_OTHER];

const step = (title: string, products: Product[]) => ({ title, collection: title, productIds: new Set(products.map((p) => p.id)) });
const COOL_WET = {
  handle: 'ambassador-men-coolwet',
  title: 'AMBASSADOR PACK - COOL & WET',
  range: 'men' as const,
  prices: { GBP: 132 },
  dynamicPrices: false,
  url: '',
  steps: [step('JACKET', [WARRIOR_RED, CADDY_CLOUD, CADDY_CLOUD_BLACK, WIND_GUARD]), step('POLO', [POLO_RED]), step('TROUSERS', [TROUSERS])],
};

beforeEach(() => {
  setCatalogueForTests(EVERYTHING);
  setDealsForTests([COOL_WET]);
  replies.length = 0;
});

const owner = new Map(EVERYTHING.flatMap((product) => product.variants.map((variant) => [variant.id.split('/').pop()!, { product, variant }] as const)));

interface Played {
  id: string;
  actions: CartAction[];
}

async function say(played: Played, text: string, model: Completion[]) {
  replies.length = 0;
  replies.push(...model);
  const before = modelCalls;
  const reply = await converse(played.id, text);
  await sessions.append(played.id, [
    { id: `u-${Math.random()}`, role: 'user', text, createdAt: new Date().toISOString() },
    { id: `a-${Math.random()}`, role: 'assistant', text: reply.text, createdAt: new Date().toISOString() },
  ]);
  played.actions.push(...(reply.actions ?? []));
  return { ...reply, modelCalls: modelCalls - before };
}

const packItems = (reply: { attachment?: CaddieAttachment }) => (reply.attachment?.kind === 'pack' ? reply.attachment.recommendation.items.map((p) => p.title) : []);
const OFFER = 'Would you like to swap the Warrior Jacket for the Caddy Cloud Jacket in navy, in Small?';
// What the model did on the loop: add the pack again, and offer the swap again.
const THE_OLD_MISTAKE: Completion[] = [
  { tool: { name: 'add_pack_to_cart', args: { pack: 'Ambassador Pack Cool & Wet', size: 'S' } } },
  { content: 'The red Warrior Jacket is sold out in size Small. I can swap it for another jacket in size Small, would you like me to do that?' },
];

/** Up to the offer: pack, sizes, add refused for the sold-out Warrior, the jackets it can take, the Caddy Cloud offered. */
async function toTheOffer(): Promise<Played> {
  const played = { id: `coolwet-${Math.random()}`, actions: [] as CartAction[] };
  await sessions.getOrCreate(played.id);
  await sessions.patch(played.id, { cartMode: 'theme' });
  const shown = await say(played, 'Show me your Ambassador Packs, I am looking for rainy season, in red.', [
    { tool: { name: 'recommend_pack', args: { query: 'Ambassador Pack Cool & Wet', colour: 'red' } } },
    { content: 'Here is the Cool & Wet pack. What top size do you wear?' },
  ]);
  expect(packItems(shown)).toContain(WARRIOR_RED.title);
  /*
   * Their sizes: the Warrior is sold out in S. It is not swapped for them -
   * the jacket waits for their choice, and only jackets in S are shown
   * (V1 task 2, case B).
   */
  const sized = await say(played, 'Top size S, waist 32, leg 34.', [{ content: 'Thanks - shall I add the pack to your basket?' }]);
  expect(sized.modelCalls).toBe(0);
  expect(sized.text).toMatch(/Warrior Jacket is sold out in S/);
  const inS = sized.attachment?.kind === 'products' ? sized.attachment.products.map((p) => p.title) : [];
  expect(inS).not.toContain(WARRIOR_RED.title);
  expect(inS).toContain(CADDY_CLOUD.title);
  expect(played.actions).toEqual([]);
  // They would rather see the other jackets: the pack's own, in S - and the Caddie offers one by name (the model's words, live).
  const choices = await say(played, 'Can you show me the other jackets that can go in the pack?', [
    { tool: { name: 'search_products', args: { query: 'jacket' } } },
    { content: OFFER },
  ]);
  const shownJackets = choices.attachment?.kind === 'products' ? choices.attachment.products.map((p) => p.title) : [];
  expect(shownJackets).toContain(CADDY_CLOUD.title);
  expect(shownJackets).not.toContain(WARRIOR_RED.title);
  const offer = choices;
  expect(offer.text).toMatch(/Caddy Cloud/);
  const replacing = (await sessions.getOrCreate(played.id)).activeShoppingContext?.replacing;
  expect(replacing?.offer?.productId).toBe(CADDY_CLOUD.id);
  expect(replacing?.size).toBe('S');
  return played;
}

describe('a yes to an offered pack swap is made once, before the model', () => {
  it.each(['Yes, please replace it.', 'yes', 'OK', 'please replace it', 'do it', 'swap it'])('"%s": the Caddy Cloud replaces the jacket, no second offer', async (yes) => {
    const played = await toTheOffer();
    const done = await say(played, yes, THE_OLD_MISTAKE);
    // The model was never asked: the confirmed swap was consumed first.
    expect(done.modelCalls).toBe(0);
    const items = packItems(done);
    expect(items).toContain(CADDY_CLOUD.title);
    expect(items).not.toContain(WARRIOR_RED.title);
    expect(items).not.toContain(WIND_GUARD.title);
    expect(done.text).not.toMatch(/sold out|would you like me to (do that|swap)/i);
    // The pack in hand, the Caddy Cloud as its jacket, in S; the pack now ready, and said so.
    const session = await sessions.getOrCreate(played.id);
    expect(session.activeShoppingContext?.pack).toBe(COOL_WET.handle);
    expect(session.activeShoppingContext?.replacing).toBeUndefined();
    const status = packStatus(session, COOL_WET.handle);
    const jacket = status.pieces.find((plan) => /JACKET/.test(plan.product.title))!;
    expect(jacket.product.title).toBe(CADDY_CLOUD.title);
    expect(jacket.variant?.options.Size).toBe('S');
    expect(status.ready).toBe(true);
    expect(done.text).toMatch(/ready - shall I add it to your basket\?/);
    // Nothing went in the basket on its own.
    expect(played.actions).toEqual([]);
  });

  it('"OK" to the sold-out offer names one swap; "Yes, please replace it" then makes exactly that one', async () => {
    const played = await toTheOffer();
    // Back to the moment after "OK": the choices, with the first offered by name.
    const session = await sessions.getOrCreate(played.id);
    const replacing = session.activeShoppingContext!.replacing!;
    await sessions.patch(played.id, { activeShoppingContext: { ...session.activeShoppingContext!, replacing: { ...replacing, offer: { turn: replacing.offer!.turn } } }, pendingAction: undefined });
    const choices = await say(played, 'OK', THE_OLD_MISTAKE);
    expect(choices.modelCalls).toBe(0);
    expect(choices.text).toMatch(/Shall I swap the Warrior Jacket for the Caddy Cloud Jacket in navy, in S\b/);
    const done = await say(played, 'Yes, please replace it.', THE_OLD_MISTAKE);
    expect(done.modelCalls).toBe(0);
    expect(packItems(done)).toContain(CADDY_CLOUD.title);
    expect(packItems(done)).not.toContain(WARRIOR_RED.title);
    expect(played.actions).toEqual([]);
  });

  it('a second yes does not swap again: it answers "shall I add it?", adding the pack once', async () => {
    const played = await toTheOffer();
    await say(played, 'Yes, please replace it.', THE_OLD_MISTAKE);
    const again = await say(played, 'yes', [{ tool: { name: 'add_pack_to_cart', args: {} } }, { content: 'The pack is going in your basket.' }]);
    // The swap's own words offered the pack add, bound as a record; the yes answers it before the model (V1 task 3).
    expect(again.modelCalls).toBe(0);
    const bundles = played.actions.filter((action) => action.type === 'add-bundle');
    const singles = played.actions.filter((action) => action.type === 'add');
    expect(singles).toEqual([]);
    expect(bundles).toHaveLength(1);
    const pieces = bundles[0]!.type === 'add-bundle' ? bundles[0]!.pieces.map((piece) => owner.get(piece.variantId.split('/').pop()!)!) : [];
    expect(pieces.map((piece) => `${piece.product.title} [${piece.variant.title}]`)).toContain(`${CADDY_CLOUD.title} [S]`);
    expect(pieces.some((piece) => piece.product.id === WARRIOR_RED.id)).toBe(false);
    // And a third yes, with nothing offered, changes nothing.
    const third = await say(played, 'yes', [{ content: 'Anything else?' }]);
    expect(third.modelCalls).toBeGreaterThan(0);
    expect(played.actions.filter((action) => action.type === 'add-bundle')).toHaveLength(1);
  });

  it('"show me polos" before the yes ends the offer: a later yes swaps nothing', async () => {
    const played = await toTheOffer();
    await say(played, 'show me polos', [{ tool: { name: 'search_products', args: { query: 'polos' } } }, { content: 'Here are some polos.' }]);
    const session = await sessions.getOrCreate(played.id);
    expect(session.activeShoppingContext?.pack).toBeUndefined();
    expect(session.activeShoppingContext?.replacing).toBeUndefined();
    const yes = await say(played, 'yes', [{ content: 'Which polo would you like?' }]);
    expect(yes.modelCalls).toBeGreaterThan(0);
    expect(packItems(yes)).toEqual([]);
    expect(played.actions).toEqual([]);
  });

  it('an offer naming a two-colour design without its colour binds nothing - the yes does not guess', async () => {
    const played = await toTheOffer();
    await say(played, 'Which would you pick?', [{ content: 'Would you like to swap the Warrior Jacket for the Caddy Cloud Jacket in Small?' }]);
    expect((await sessions.getOrCreate(played.id)).activeShoppingContext?.replacing?.offer).toBeUndefined();
    const yes = await say(played, 'yes', [{ content: 'Which colour - navy or black?' }]);
    expect(yes.modelCalls).toBeGreaterThan(0);
    expect(packItems(yes)).toEqual([]);
  });

  it('a no is a no: the offer is cancelled, nothing swapped', async () => {
    const played = await toTheOffer();
    const no = await say(played, 'no, not that one', [{ content: 'No problem - which would you prefer?' }]);
    expect(packItems(no)).toEqual([]);
    expect((await sessions.getOrCreate(played.id)).pendingAction).toBeUndefined();
    const later = await say(played, 'yes', [{ content: 'Which one would you like?' }]);
    expect(packItems(later)).toEqual([]);
  });

  it('a yes after a question about it still makes the swap - the offer waits (V1 task 3)', async () => {
    const played = await toTheOffer();
    await say(played, 'is it waterproof?', [{ content: 'It is described as waterproof.' }]);
    const late = await say(played, 'Yes, swap it', THE_OLD_MISTAKE);
    expect(late.modelCalls).toBe(0);
    expect(packItems(late)).toContain(CADDY_CLOUD.title);
    expect(packItems(late)).not.toContain(WARRIOR_RED.title);
  });
});

describe('sizing inside a pack uses the pack\'s own garments', () => {
  async function inThePack() {
    const id = `coolwet-size-${Math.random()}`;
    await sessions.getOrCreate(id);
    await say({ id, actions: [] }, 'Show me your Ambassador Packs, I am looking for rainy season, in red.', [
      { tool: { name: 'recommend_pack', args: { query: 'Ambassador Pack Cool & Wet', colour: 'red' } } },
      { content: 'Here is the Cool & Wet pack.' },
    ]);
    return id;
  }

  it('a chest with category "top" is sized on the jacket chart - never "which category?"', async () => {
    const id = await inThePack();
    const said = 'My chest is 36 inches, waist 32, leg 34.';
    const top = await runTool('find_my_size', { chestCm: 91.44, audience: 'men', category: 'top' }, { session: await sessions.getOrCreate(id), utterance: said });
    expect(top.speech).not.toMatch(/size guide for|category/i);
    const rec = top.attachment?.kind === 'size' ? top.attachment.recommendation : null;
    expect(rec?.size).toBeTruthy();
    expect(rec?.missing ?? []).not.toContain('category');
    expect((await sessions.getOrCreate(id)).sizeRecommendation).toMatchObject({ scale: 'top', size: rec!.size });

    // The trousers, sized in the same turn from the waist they gave, do not replace the top size.
    const bottom = await runTool('find_my_size', { waistCm: 81.28, audience: 'men', category: 'trousers' }, { session: await sessions.getOrCreate(id), utterance: said });
    expect(bottom.speech).not.toMatch(/size guide for/i);
    expect((await sessions.getOrCreate(id)).sizeRecommendation).toMatchObject({ scale: 'top', size: rec!.size });
  });
});
