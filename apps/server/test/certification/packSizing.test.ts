import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaddieAttachment, Product } from '@caddie/shared';

/**
 * The rainy-season pack (preview store). The Cool & Wet pack came up with the
 * Warrior Jacket - sold out in every size but 2XL - and then "my top size
 * would be medium and for the trouser my waist is 32 and leg length is 34"
 * let the pack go (it names trousers), so none of it was saved; "that is also
 * medium" and "yes it is confirmed" were not read either, and the top size
 * was asked for three times.
 */

type Completion = { content?: string; tool?: { name: string; args: Record<string, unknown> } };
const replies: Completion[] = [];

vi.mock('../../src/lib/http.js', async (original) => ({
  ...(await original<typeof import('../../src/lib/http.js')>()),
  fetchWithTimeout: vi.fn(async (url: string) => {
    if (!String(url).includes('chat/completions')) throw new Error(`unexpected call to ${url}`);
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
const { offerability } = await import('../../src/catalog/commerce.js');
const { sessions } = await import('../../src/session/store.js');
const { rememberShopper } = await import('../../src/shopper/remember.js');
const { converse } = await import('../../src/ai/openai.js');
const { eligibilityFor } = await import('../../src/tools/eligibility.js');
const { packStatus } = await import('../../src/tools/packState.js');
const { env } = await import('../../src/env.js');

let nextId = 9700;
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

const TOPS = [{ name: 'Size', values: ['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL'] }];
// As on the preview store: only 2XL left.
const WARRIOR = product('WARRIOR JACKET - RED', TOPS, (c) => c.Size !== '2XL', 60);
// Navy, so the red Warrior leads the red pack when no size is known - as it did on the store.
const CADDY = product('CADDY CLOUD JACKET - NAVY', TOPS, () => false, 55);
const POLO = product('GOLF TEE POLO - RED', TOPS, () => false, 20);
const TROUSERS = product("MEN'S CLIMA GOLF TROUSERS - NAVY", [
  { name: 'WAIST SIZE', values: ['30', '32', '34'] },
  { name: 'LEG LENGTH', values: ['30', '32', '34'] },
]);
const BELT = product("MEN'S CROC GOLF LEATHER BELT - GREY (ONE SIZE FITS ALL)", [{ name: 'Size', values: ['ONE SIZE FITS ALL'] }], () => false, 20);
const SOCKS = product('ONE PAIR TOUR ANKLE SOCKS - WHITE', [], () => false, 8);
const EVERYTHING = [WARRIOR, CADDY, POLO, TROUSERS, BELT, SOCKS];

const step = (title: string, products: Product[]) => ({ title, collection: title, productIds: new Set(products.map((p) => p.id)) });
const COOL_WET = {
  handle: 'ambassador-men-coolwet',
  title: 'AMBASSADOR PACK - COOL & WET',
  range: 'men' as const,
  prices: { GBP: 132 },
  dynamicPrices: false,
  url: '',
  steps: [step('JACKET', [WARRIOR, CADDY]), step('POLO', [POLO]), step('TROUSERS', [TROUSERS]), step('BELT', [BELT]), step('SOCKS', [SOCKS])],
};

let id = '';
beforeEach(async () => {
  setCatalogueForTests(EVERYTHING);
  setDealsForTests([COOL_WET]);
  replies.length = 0;
  id = `rainy-${Math.random()}`;
  await sessions.getOrCreate(id);
  await sessions.patch(id, { cartMode: 'theme' });
});

async function say(text: string, model: Completion[]) {
  replies.length = 0;
  replies.push(...model);
  const reply = await converse(id, text);
  await sessions.append(id, [
    { id: `u-${Math.random()}`, role: 'user', text, createdAt: new Date().toISOString() },
    { id: `a-${Math.random()}`, role: 'assistant', text: reply.text, createdAt: new Date().toISOString() },
  ]);
  return reply;
}

const pieces = (reply: { attachment?: CaddieAttachment }) => (reply.attachment?.kind === 'pack' ? reply.attachment.recommendation.items.map((p) => p.title) : []);
const SHOW = [{ tool: { name: 'recommend_pack', args: { query: 'Ambassador Pack Cool & Wet', colour: 'red' } } }, { content: 'Here is the Cool & Wet pack.' }];
const choices = async () => (await sessions.getOrCreate(id)).packChoices?.[COOL_WET.handle] ?? {};

describe('stored quick-start sizes: men, M, waist 32', () => {
  it('the first pack holds nothing sold out in M or 32, and asks only what it still needs (the leg)', async () => {
    await rememberShopper(id, { range: 'men', usualSize: 'M', waist: '32' }, 'ui-form');
    const shown = await say('Show me the Cool & Wet Ambassador Pack.', SHOW);
    expect(pieces(shown)).not.toContain(WARRIOR.title);
    expect(pieces(shown)).toContain(CADDY.title);
    const rule = eligibilityFor(await sessions.getOrCreate(id));
    for (const title of pieces(shown)) expect(rule.packPiece(EVERYTHING.find((p) => p.title === title)!)).toBe(true);
    // Top and waist come from what they told us; only the leg is open.
    const status = packStatus(await sessions.getOrCreate(id), COOL_WET.handle);
    expect(status.next).toMatch(/leg/i);
    expect(status.next).not.toMatch(/top size|waist|mens|womens/i);
  });

  it('the one-size belt and socks are untouched by M and 32', async () => {
    const session = await rememberShopper(id, { range: 'men', usualSize: 'M', waist: '32' }, 'ui-form').then(() => sessions.getOrCreate(id));
    const rule = eligibilityFor(session);
    expect(rule.decide(BELT)).toMatchObject({ offer: 'eligible', sizes: {} });
    expect(rule.decide(SOCKS)).toMatchObject({ offer: 'eligible', sizes: {} });
  });
});

describe('sizes given while the pack is in hand', () => {
  it('"my top size would be medium and for the trouser my waist is 32 and leg length is 34": all three kept; the Warrior is not substituted - its step waits for their choice', async () => {
    const shown = await say('Show me Ambassador pack for rainy season, in red.', SHOW);
    // No size known yet: the Warrior, with 2XL left, may be shown.
    expect(pieces(shown)).toContain(WARRIOR.title);
    // The model does the old wrong thing - asks the top size again. It is never asked: the pack's answer comes first.
    const reply = await say('My top size would be medium and for the trouser my waist is 32 and leg length is 34.', [{ content: 'What top size do you wear?' }, { content: 'Anything else?' }]);
    const session = await sessions.getOrCreate(id);
    expect(session.activeShoppingContext?.pack).toBe(COOL_WET.handle);
    expect(await choices()).toMatchObject({ top: 'M', waist: '32', leg: '34' });
    // Said plainly, and only what can be had in M shown - nothing put in the pack for them (V1 task 2, case B).
    expect(reply.text).toMatch(/Warrior Jacket is sold out in M/);
    expect(reply.text).not.toMatch(/what top size/i);
    const offered = reply.attachment?.kind === 'products' ? reply.attachment.products.map((p) => p.title) : [];
    expect(offered).toEqual([CADDY.title]);
    expect(session.activeShoppingContext?.replacing?.step).toBe(0);
    expect(session.packsShown?.[COOL_WET.handle]?.items.map((item) => item.title)).toContain(WARRIOR.title);
    // Their choice goes in; then the pack is ready.
    const chosen = await say('I will take the Caddy Cloud', [{ tool: { name: 'recommend_pack', args: { query: 'Ambassador Pack Cool & Wet', swapWith: CADDY.id } } }, { content: 'Done.' }]);
    expect(pieces(chosen)).toContain(CADDY.title);
    expect(pieces(chosen)).not.toContain(WARRIOR.title);
    expect(packStatus(await sessions.getOrCreate(id), COOL_WET.handle).ready).toBe(true);
  });

  it('sizes given before the pack is shown: it is built in them - no Warrior - and none is asked again', async () => {
    // The model asked for sizes first and showed nothing.
    await say('Show me Ambassador pack for rainy season, in red.', [{ content: 'Could you tell me your size first?' }]);
    await say('My top size would be medium and for the trouser my waist is 32 and leg length is 34.', [{ content: 'Thanks.' }]);
    const shown = await say('Great, show me the pack', SHOW);
    expect(pieces(shown)).not.toContain(WARRIOR.title);
    expect(pieces(shown)).toContain(CADDY.title);
    expect(await choices()).toMatchObject({ top: 'M', waist: '32', leg: '34' });
    expect(packStatus(await sessions.getOrCreate(id), COOL_WET.handle).ready).toBe(true);
  });

  it('"that is also medium", answering the top-size question, fills it', async () => {
    await say('Show me Ambassador pack for rainy season, in red.', SHOW);
    await say('waist 32, leg 34', [{ content: 'What top size do you wear?' }]);
    await say('That is also medium.', [{ content: 'Thanks.' }]);
    expect(await choices()).toMatchObject({ top: 'M', waist: '32', leg: '34' });
  });

  it('"yes it is confirmed" to "is medium your top size?" confirms M, and it is not asked again', async () => {
    await say('Show me Ambassador pack for rainy season, in red.', SHOW);
    await say('waist 32, leg 34', [{ content: 'Just to check - is medium your top size?' }]);
    const reply = await say('Yes it is confirmed.', [{ content: 'Is medium your top size?' }, { content: 'Great - the pack is ready.' }]);
    expect(await choices()).toMatchObject({ top: 'M' });
    expect(reply.text).not.toMatch(/is medium your top size/i);
  });

  it('a yes to an unrelated question sets no size', async () => {
    await say('Show me Ambassador pack for rainy season, in red.', SHOW);
    await say('waist 32, leg 34', [{ content: 'Shall I show you the other packs?' }]);
    await say('yes', [{ content: 'Here they are.' }]);
    expect((await choices()).top).toBeUndefined();
  });

  it('"show me trousers" still leaves the pack', async () => {
    await say('Show me Ambassador pack for rainy season, in red.', SHOW);
    await say('show me trousers', [{ tool: { name: 'search_products', args: { query: 'trousers' } } }, { content: 'Here are some trousers.' }]);
    expect((await sessions.getOrCreate(id)).activeShoppingContext?.pack).toBeUndefined();
  });
});

describe('the Warrior for a customer in M', () => {
  it('is not eligible: 2XL in stock does not rescue it', () => {
    expect(offerability(WARRIOR, [{ size: 'M', as: 'top' }])).toMatchObject({ offer: 'not-eligible', why: 'sold-out' });
    expect(offerability(WARRIOR, []).offer).toBe('eligible');
  });
});
