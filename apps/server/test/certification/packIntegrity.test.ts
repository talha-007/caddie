import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaddieAttachment, CartAction, Product } from '@caddie/shared';

/**
 * V1 hardening task 2: an Ambassador Pack as one deterministic workflow.
 * Its pieces stay as configured unless the customer changes one; a piece
 * that can no longer be had after they have seen it is never swapped for
 * them - its step waits for their choice, from eligible pieces only; a search
 * for the replacement stays inside the pack; a pack piece never becomes a
 * standalone line; another pack starts clean; "another" or a colour never
 * rebuilds the whole pack; and "rainy season" always means the real pack.
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
const { rememberShopper } = await import('../../src/shopper/remember.js');
const { converse } = await import('../../src/ai/openai.js');
const { eligibilityFor } = await import('../../src/tools/eligibility.js');
const { packStatus } = await import('../../src/tools/packState.js');
const { env } = await import('../../src/env.js');

let nextId = 11000;
function product(title: string, options: Array<{ name: string; values: string[] }>, soldOut: (combo: Record<string, string>) => boolean = () => false, price = 30): Product {
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
    variants: combos.map((combo, i) => ({ id: `gid://shopify/ProductVariant/${id + i + 1}`, title: Object.values(combo).join(' / ') || 'Default Title', available: !soldOut(combo), price: { amount: price, currency: 'GBP' }, options: combo })),
    description: null,
  };
}

const TOPS = [{ name: 'Size', values: ['S', 'M', 'L', 'XL', '2XL'] }];
// As on the preview store: only 2XL left.
const WARRIOR = product('WARRIOR JACKET - RED', TOPS, (c) => c.Size !== '2XL', 60);
const HEXA_BLACK = product('HEXA PERFORMANCE JACKET - BLACK', TOPS, () => false, 40);
const HEXA_NAVY = product('HEXA PERFORMANCE JACKET - NAVY', TOPS, () => false, 40);
const CADDY = product('CADDY CLOUD JACKET - GREY', TOPS, () => false, 55);
const OUTSIDE = product('TECH JACKET - BLACK', TOPS, () => false, 70);
const MIDLAYER = product('HECTAR MIDLAYER - GREY', TOPS, () => false, 35);
const POLO = product('GOLF TEE POLO - RED', TOPS, () => false, 20);
const TROUSERS = product("MEN'S CLIMA GOLF TROUSERS - NAVY", [
  { name: 'WAIST SIZE', values: ['30', '32', '34'] },
  { name: 'LEG LENGTH', values: ['30', '32', '34'] },
]);
const BELT = product('TOUR PRO BELT - BLACK', [{ name: 'Size', values: ['M/L', 'L/XL'] }], () => false, 20);
const SOCKS = product('ONE PAIR TOUR ANKLE SOCKS - WHITE', [], () => false, 8);
const EVERYTHING = [WARRIOR, HEXA_BLACK, HEXA_NAVY, CADDY, OUTSIDE, MIDLAYER, POLO, TROUSERS, BELT, SOCKS];

const step = (title: string, products: Product[]) => ({ title, collection: title, productIds: new Set(products.map((p) => p.id)) });
const STEPS = [
  step('JACKET', [WARRIOR, HEXA_BLACK, HEXA_NAVY, CADDY]),
  step('MIDLAYER', [MIDLAYER]),
  step('POLO', [POLO]),
  step('TROUSERS', [TROUSERS]),
  step('BELT', [BELT]),
  step('SOCKS', [SOCKS]),
];
const pack = (handle: string, title: string, condition: 'warm' | 'mixed' | 'coolwet', price: number) => ({
  handle,
  title,
  range: 'men' as const,
  prices: { GBP: price },
  dynamicPrices: false,
  url: '',
  condition,
  conditionTitle: title,
  steps: STEPS,
});
const COOL_WET = pack('ambassador-men-coolwet', 'AMBASSADOR PACK - COOL & WET', 'coolwet', 132);
const MIXED = pack('ambassador-men-mixed', 'AMBASSADOR PACK - MIXED CONDITIONS', 'mixed', 129.99);
const WARM = pack('ambassador-men-warm', 'AMBASSADOR PACK - WARM ROUNDS', 'warm', 99);

let id = '';
let actions: CartAction[] = [];
beforeEach(async () => {
  setCatalogueForTests(EVERYTHING);
  setDealsForTests([WARM, MIXED, COOL_WET]);
  replies.length = 0;
  actions = [];
  id = `integrity-${Math.random()}`;
  await sessions.getOrCreate(id);
  await sessions.patch(id, { cartMode: 'theme' });
});

async function say(text: string, model: Completion[]) {
  replies.length = 0;
  replies.push(...model);
  const before = modelCalls;
  const reply = await converse(id, text);
  await sessions.append(id, [
    { id: `u-${Math.random()}`, role: 'user', text, createdAt: new Date().toISOString() },
    { id: `a-${Math.random()}`, role: 'assistant', text: reply.text, createdAt: new Date().toISOString() },
  ]);
  actions.push(...(reply.actions ?? []));
  return { ...reply, modelCalls: modelCalls - before };
}

const pieces = (reply: { attachment?: CaddieAttachment }) => (reply.attachment?.kind === 'pack' ? reply.attachment.recommendation.items.map((p) => p.title) : []);
const cards = (reply: { attachment?: CaddieAttachment }) => (reply.attachment?.kind === 'products' ? reply.attachment.products.map((p) => p.title) : []);
const configured = async (handle = COOL_WET.handle) => ((await sessions.getOrCreate(id)).packsShown?.[handle]?.items ?? []).map((item) => item.id);
const standalone = () => actions.filter((action) => action.type === 'add');
const showRed = [{ tool: { name: 'recommend_pack', args: { query: 'Ambassador Pack Cool & Wet', colour: 'red' } } }, { content: 'Here is the Cool & Wet pack.' }];

/** No size known, the red pack shown (the Warrior leads), then "my top size is M": the jacket waits for their choice. */
async function jacketRequired() {
  const shown = await say('Show me the Cool & Wet Ambassador Pack in red', showRed);
  expect(pieces(shown)).toContain(WARRIOR.title);
  const reply = await say('My top size is M.', [{ content: 'Great - shall I add it?' }]);
  return { shown, reply, before: await configured() };
}

describe('1. sizes known before the pack is shown', () => {
  it('men / M / waist 32: only pieces they can have, no Warrior, and only the leg asked', async () => {
    await rememberShopper(id, { range: 'men', usualSize: 'M', waist: '32' }, 'ui-form');
    const shown = await say('Show me an Ambassador Pack for rainy season', [
      { tool: { name: 'recommend_pack', args: { query: 'Ambassador Pack rainy season' } } },
      { content: 'Here is the Cool & Wet pack.' },
    ]);
    expect(shown.attachment?.kind === 'pack' && shown.attachment.recommendation.bundle?.handle).toBe(COOL_WET.handle);
    expect(pieces(shown)).not.toContain(WARRIOR.title);
    const rule = eligibilityFor(await sessions.getOrCreate(id));
    for (const title of pieces(shown)) expect(rule.packPiece(EVERYTHING.find((p) => p.title === title)!)).toBe(true);
    expect(packStatus(await sessions.getOrCreate(id), COOL_WET.handle).next).toMatch(/leg/i);
  });
});

describe('2-6. a piece they have seen, sold out in the size they then give', () => {
  it('2. never swapped for them: said, eligible jackets in M shown, the step waits', async () => {
    const { reply, before } = await jacketRequired();
    expect(reply.modelCalls).toBe(0);
    expect(reply.text).toMatch(/Warrior Jacket is sold out in M/);
    const offered = cards(reply);
    expect(offered.sort()).toEqual([CADDY.title, HEXA_BLACK.title, HEXA_NAVY.title].sort());
    // The configured jacket is still the one they saw - nothing was put in for them.
    expect(before).toContain(WARRIOR.id);
    expect((await sessions.getOrCreate(id)).activeShoppingContext?.replacing).toMatchObject({ step: 0, size: 'M' });
    expect(standalone()).toEqual([]);
  });

  it('3. "show me another jacket available in M" stays in the pack, for the jacket', async () => {
    await jacketRequired();
    const reply = await say('Show me another jacket available in M.', [{ tool: { name: 'search_products', args: { query: 'jacket', size: 'M' } } }, { content: 'Here you go.' }]);
    const session = await sessions.getOrCreate(id);
    expect(session.activeShoppingContext?.pack).toBe(COOL_WET.handle);
    expect(session.activeShoppingContext?.replacing?.step).toBe(0);
    expect(cards(reply)).not.toContain(WARRIOR.title);
    expect(cards(reply).length).toBeGreaterThan(0);
    const rule = eligibilityFor(session);
    for (const title of cards(reply)) expect(rule.eligible(EVERYTHING.find((p) => p.title === title)!)).toBe(true);
  });

  it('3b. "show me black jackets" and "I prefer the Hexa" stay in the pack; "show me polos" leaves it', async () => {
    await jacketRequired();
    await say('show me black jackets', [{ tool: { name: 'search_products', args: { query: 'jackets', colour: 'black' } } }, { content: 'Here.' }]);
    expect((await sessions.getOrCreate(id)).activeShoppingContext?.pack).toBe(COOL_WET.handle);
    await say('what jackets do you have in M?', [{ tool: { name: 'search_products', args: { query: 'jackets', size: 'M' } } }, { content: 'Here.' }]);
    expect((await sessions.getOrCreate(id)).activeShoppingContext?.replacing?.step).toBe(0);
    await say('show me polos', [{ tool: { name: 'search_products', args: { query: 'polos' } } }, { content: 'Here are some polos.' }]);
    expect((await sessions.getOrCreate(id)).activeShoppingContext?.pack).toBeUndefined();
  });

  it('4. "use the Caddy Cloud": the jacket step only; the other five pieces identical; nothing on its own', async () => {
    const { before } = await jacketRequired();
    const reply = await say('Use the Caddy Cloud', [{ tool: { name: 'add_to_cart', args: { productId: CADDY.id, options: { Size: 'M' } } } }, { content: 'Done.' }]);
    expect(pieces(reply)).toContain(CADDY.title);
    const after = await configured();
    expect(after[0]).toBe(CADDY.id);
    expect(after.slice(1)).toEqual(before.slice(1));
    expect(standalone()).toEqual([]);
  });

  it('5. the Hexa in two colours: asked once; "black" puts the black one in the pack', async () => {
    await jacketRequired();
    const ask = await say("I'll take the Hexa", [{ tool: { name: 'add_to_cart', args: { productId: HEXA_NAVY.id, options: { Size: 'M' } } } }, { content: 'Which colour?' }]);
    expect(ask.text).toMatch(/colour/i);
    const black = await say('black', [{ tool: { name: 'get_product_details', args: { productId: HEXA_BLACK.id } } }, { content: 'Done.' }]);
    expect(pieces(black)).toContain(HEXA_BLACK.title);
    expect((await configured())[0]).toBe(HEXA_BLACK.id);
    expect(standalone()).toEqual([]);
  });

  it('6. "add this Hexa instead of the red jacket": a swap in the pack', async () => {
    await jacketRequired();
    await sessions.patch(id, { lastShown: { kind: 'products', items: [{ id: HEXA_BLACK.id, title: HEXA_BLACK.title }], query: `pack choices: ${COOL_WET.handle}` } });
    const reply = await say('Add this Hexa instead of the red jacket.', [{ tool: { name: 'add_to_cart', args: { productId: HEXA_BLACK.id, options: { Size: 'M' } } } }, { content: 'Added.' }]);
    expect(pieces(reply)).toContain(HEXA_BLACK.title);
    expect(standalone()).toEqual([]);
  });

  it('7. a jacket from outside the pack, asked for loosely: asked once - the pack, or separately', async () => {
    await jacketRequired();
    const reply = await say('add the Tech Jacket', [{ tool: { name: 'add_to_cart', args: { productId: OUTSIDE.id, options: { Size: 'M' } } } }, { content: 'Added it.' }]);
    expect(reply.text).toMatch(/pack|own/i);
    expect(standalone()).toEqual([]);
  });

  it('a standalone add left waiting is cancelled when the replacement starts', async () => {
    await say('Show me the Cool & Wet Ambassador Pack in red', showRed);
    await sessions.patch(id, { pendingAction: { type: 'add-product', productIds: [OUTSIDE.id], awaiting: 'size', turn: 1 } });
    await say('My top size is M.', [{ content: 'OK.' }]);
    expect((await sessions.getOrCreate(id)).pendingAction).toBeUndefined();
  });
});

describe('8. one piece changed, never the whole pack', () => {
  async function configuredPack() {
    await rememberShopper(id, { range: 'men', usualSize: 'M', waist: '32' }, 'ui-form');
    await say('Show me the Cool & Wet Ambassador Pack', [{ tool: { name: 'recommend_pack', args: { query: 'Ambassador Pack Cool & Wet' } } }, { content: 'Here it is.' }]);
    return configured();
  }

  it('"another jacket please": only the jacket step changes', async () => {
    const before = await configuredPack();
    await say('another jacket please', [{ tool: { name: 'recommend_pack', args: { query: 'Ambassador Pack Cool & Wet' } } }, { content: 'Here.' }]);
    const after = await configured();
    expect(after.slice(1)).toEqual(before.slice(1));
  });

  it('"another colour" with no piece named: asked which piece; nothing rebuilt', async () => {
    const before = await configuredPack();
    const reply = await say("I'd like another colour", [{ tool: { name: 'recommend_pack', args: { query: 'Ambassador Pack Cool & Wet', colour: 'navy' } } }, { content: 'Which piece?' }]);
    expect(reply.text).toMatch(/which piece/i);
    expect(await configured()).toEqual(before);
  });

  it('"S, any other option?" does not rebuild the pack', async () => {
    const before = await configuredPack();
    await say('S, any other option?', [{ tool: { name: 'recommend_pack', args: { query: 'Ambassador Pack Cool & Wet', size: 'S' } } }, { content: 'Here.' }]);
    expect(await configured()).toEqual(before);
  });

  it('"start the pack again" is a rebuild they asked for', async () => {
    await configuredPack();
    const reply = await say('start the pack again with all new pieces', [{ tool: { name: 'recommend_pack', args: { query: 'Ambassador Pack Cool & Wet' } } }, { content: 'Here.' }]);
    expect(reply.attachment?.kind).toBe('pack');
  });

  it('12. "show me my pack" after a replacement: the same pieces, all eligible', async () => {
    await jacketRequired();
    await say('Use the Caddy Cloud', [{ tool: { name: 'add_to_cart', args: { productId: CADDY.id, options: { Size: 'M' } } } }, { content: 'Done.' }]);
    const before = await configured();
    const reply = await say('show me my pack', [{ tool: { name: 'recommend_pack', args: { query: 'Ambassador Pack Cool & Wet' } } }, { content: 'Here it is.' }]);
    expect(await configured()).toEqual(before);
    const rule = eligibilityFor(await sessions.getOrCreate(id));
    for (const title of pieces(reply)) expect(rule.packPiece(EVERYTHING.find((p) => p.title === title)!)).toBe(true);
  });
});

describe('9. another pack starts clean', () => {
  it('a half-finished jacket replacement on Mixed Conditions is gone on Cool & Wet', async () => {
    await say('Show me the Mixed Conditions Ambassador Pack in red', [{ tool: { name: 'recommend_pack', args: { query: 'Ambassador Pack Mixed Conditions', colour: 'red' } } }, { content: 'Here.' }]);
    await say('My top size is M.', [{ content: 'OK.' }]);
    expect((await sessions.getOrCreate(id)).activeShoppingContext?.replacing).toBeDefined();
    await say('Switch to Cool & Wet.', [{ tool: { name: 'recommend_pack', args: { query: 'Ambassador Pack Cool & Wet' } } }, { content: 'Here is Cool & Wet.' }]);
    const focus = (await sessions.getOrCreate(id)).activeShoppingContext;
    expect(focus?.pack).toBe(COOL_WET.handle);
    expect(focus?.replacing).toBeUndefined();
  });
});

describe('10. the belt keeps its own size', () => {
  it('"M/L" is the belt\'s; top stays M', async () => {
    await rememberShopper(id, { range: 'men', usualSize: 'M', waist: '32' }, 'ui-form');
    await say('Show me the Cool & Wet Ambassador Pack', [{ tool: { name: 'recommend_pack', args: { query: 'Ambassador Pack Cool & Wet' } } }, { content: 'Here it is.' }]);
    await say('my top size is M, leg 34', [{ content: 'Which size for the belt: M/L or L/XL?' }]);
    await say('M/L', [{ content: 'Thanks.' }]);
    const choices = (await sessions.getOrCreate(id)).packChoices?.[COOL_WET.handle];
    expect(choices).toMatchObject({ top: 'M', belt: 'M/L' });
    expect(packStatus(await sessions.getOrCreate(id), COOL_WET.handle).ready).toBe(true);
  });
});

describe('11. "Ambassador Pack for rainy season" is the real pack, whatever the model does', () => {
  it.each([
    { name: 'empty placeholders and a zero budget', args: { query: 'ambassador pack', colour: '', size: '', budgetAmount: 0 } },
    { name: 'the words as given', args: { query: 'Ambassador Pack rainy season' } },
    { name: 'a budget it made up', args: { query: 'pack', budgetAmount: 100 } },
  ])('$name: Cool & Wet, never a budget question', async ({ args }) => {
    const reply = await say('Show me an Ambassador Pack for rainy season', [{ tool: { name: 'recommend_pack', args } }, { content: 'Here is the Cool & Wet pack.' }]);
    expect(reply.attachment?.kind).toBe('pack');
    expect(reply.attachment?.kind === 'pack' && reply.attachment.recommendation.bundle?.handle).toBe(COOL_WET.handle);
    expect(reply.text).not.toMatch(/budget/i);
  });

  it('a budget "pack" is not offered at all', async () => {
    const reply = await say('put me together a pack of basics for £100', [{ tool: { name: 'recommend_pack', args: { query: 'basics', budgetAmount: 100 } } }, { content: 'Here are our packs.' }]);
    expect(reply.attachment).toBeUndefined();
  });
});

describe('asking to see another piece, whichever tool the model picks', () => {
  it.each(['other_colours', 'get_product_details', 'search_products'])('%s: the pack jacket choices, eligible, the pack kept', async (tool) => {
    await rememberShopper(id, { range: 'men', usualSize: 'M', waist: '32' }, 'ui-form');
    await say('Show me the Cool & Wet Ambassador Pack', [{ tool: { name: 'recommend_pack', args: { query: 'Ambassador Pack Cool & Wet' } } }, { content: 'Here it is.' }]);
    const before = await configured();
    const args = tool === 'search_products' ? { query: 'jackets' } : { productId: before[0]! };
    const reply = await say('Can I see the other jackets that can go in the pack?', [{ tool: { name: tool, args } }, { content: 'Here are the jackets.' }]);
    expect(cards(reply).length).toBeGreaterThan(0);
    const rule = eligibilityFor(await sessions.getOrCreate(id));
    for (const title of cards(reply)) expect(rule.eligible(EVERYTHING.find((p) => p.title === title)!)).toBe(true);
    const session = await sessions.getOrCreate(id);
    expect(session.activeShoppingContext?.pack).toBe(COOL_WET.handle);
    expect(session.activeShoppingContext?.replacing?.step).toBe(0);
    expect(await configured()).toEqual(before);
  });
});

describe('the choice itself', () => {
  it('"use the Vapor in navy" when a navy gilet goes out: navy is what they asked for', async () => {
    // The dearer navy piece: chosen first, as the Arvid Gilet was live.
    const GILET_NAVY = product('ARVID GILET - NAVY', TOPS, () => false, 65);
    const VAPOR_NAVY = product('VAPOR JACKET 2.0 - NAVY', TOPS, () => false, 50);
    const VAPOR_BLACK = product('VAPOR JACKET 2.0 - BLACK', TOPS, () => false, 50);
    setCatalogueForTests([...EVERYTHING, GILET_NAVY, VAPOR_NAVY, VAPOR_BLACK]);
    const GILET_PACK = { ...COOL_WET, steps: [step('JACKET / GILET', [GILET_NAVY, VAPOR_NAVY, VAPOR_BLACK]), ...STEPS.slice(1)] };
    setDealsForTests([GILET_PACK]);
    await rememberShopper(id, { range: 'men', usualSize: 'M', waist: '32' }, 'ui-form');
    await say('Show me the Cool & Wet Ambassador Pack in navy', [{ tool: { name: 'recommend_pack', args: { query: 'Ambassador Pack Cool & Wet', colour: 'navy' } } }, { content: 'Here it is.' }]);
    expect((await configured())[0]).toBe(GILET_NAVY.id);
    await say('Can I see the other jackets that can go in the pack?', [{ tool: { name: 'search_products', args: { query: 'jackets' } } }, { content: 'Here they are.' }]);
    // The model does nothing with the choice: the choice is still made.
    const chosen = await say('Use the vapor jacket 2.0 in navy', [{ content: 'Can you confirm the exact navy shade?' }]);
    expect((await configured())[0]).toBe(VAPOR_NAVY.id);
    expect(chosen.text).not.toMatch(/confirm the exact/i);
    expect((await sessions.getOrCreate(id)).activeShoppingContext?.replacing).toBeUndefined();
  });

  it('a swap the model makes itself still ends the replacement - no stale state left', async () => {
    await jacketRequired();
    await say('the grey Caddy Cloud looks good to me', [{ tool: { name: 'recommend_pack', args: { query: 'Ambassador Pack Cool & Wet', swapWith: CADDY.id } } }, { content: 'Swapped.' }]);
    expect((await configured())[0]).toBe(CADDY.id);
    expect((await sessions.getOrCreate(id)).activeShoppingContext?.replacing).toBeUndefined();
  });
});
