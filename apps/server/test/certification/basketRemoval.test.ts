import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CartAction, Product } from '@caddie/shared';

/**
 * Taking more than one line out of the basket: the whole basket, a whole
 * pack, "them". Live, a customer with a six-piece pack in the basket said
 * "remove these items", "remove them all" and "please remove it" and was
 * asked which item they meant three times over - a removal could only ever
 * land on one line, the model's six correct line ids were (rightly) not
 * trusted on their own, and the questions the model asked in between bound
 * nothing a yes could execute. Every case here ends with the lines out, or
 * with exactly one question whose yes takes them out.
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
const { env } = await import('../../src/env.js');
const { confirmApplied } = await import('../support/widgetCart.js');

let nextId = 41000;
function product(title: string, type: string, sizes: string[]): Product {
  const id = nextId;
  nextId += 20;
  return {
    id: `gid://shopify/Product/${id}`,
    title,
    url: '',
    imageUrl: null,
    vendor: 'Druids',
    productType: type,
    tags: [env.shopify.brandTag].filter(Boolean) as string[],
    price: { amount: 30, currency: 'GBP' },
    options: sizes.length ? [{ name: 'Size', values: sizes }] : [],
    variants: (sizes.length ? sizes : ['Default Title']).map((size, i) => ({ id: `gid://shopify/ProductVariant/${id + i + 1}`, title: size, available: true, price: { amount: 30, currency: 'GBP' }, options: (sizes.length ? { Size: size } : {}) as Record<string, string> })),
    description: 'Breathable.',
  };
}
const SIZES = ['S', 'M', 'L'];
const JACKET = product('CADDY CLOUD JACKET - WHITE / GREY', 'JACKETS', SIZES);
const MIDLAYER = product('GALACTIC MIDLAYER - NAVY', 'MIDLAYERS', SIZES);
const PACK_POLO = product('GOLF TEE POLO - NAVY', 'POLOS', SIZES);
const TROUSERS = product("MEN'S CLIMA GOLF TROUSERS - NAVY", 'TROUSERS', ['32', '34']);
const CAP = product('KOMO CAP - NAVY', 'CAPS', []);
const SOCKS = product('ONE PAIR TOUR ANKLE SOCKS - BLACK', 'SOCKS', []);
const POLO = product('ELITE POLO - NAVY', 'POLOS', SIZES);
const POLO_WHITE = product('ELITE POLO - WHITE', 'POLOS', SIZES);
const GLOVE = product('CLIMA JACKET 3.0 - NAVY', 'JACKETS', ['M', 'L']);
const EVERYTHING = [JACKET, MIDLAYER, PACK_POLO, TROUSERS, CAP, SOCKS, POLO, POLO_WHITE, GLOVE];

type Line = NonNullable<Awaited<ReturnType<typeof sessions.getOrCreate>>['basket']>[number];
const line = (key: string, own: Product, variantTitle: string, bundle?: string): Line => ({
  lineId: key,
  productId: own.id,
  variantId: (own.variants.find((variant) => variant.title === variantTitle) ?? own.variants[0]!).id.split('/').pop(),
  title: own.title,
  variantTitle,
  quantity: 1,
  ...(bundle ? { bundle, bundleName: 'ambassador-men-warm' } : {}),
});
const PACK: Line[] = [line('k1', JACKET, 'M', 'b1'), line('k2', MIDLAYER, 'M', 'b1'), line('k3', PACK_POLO, 'M', 'b1'), line('k4', TROUSERS, '32', 'b1'), line('k5', CAP, 'Default Title', 'b1'), line('k6', SOCKS, 'Default Title', 'b1')];
const LOOSE_POLO = line('loose-polo', POLO, 'L');
const LOOSE_WHITE = line('loose-white', POLO_WHITE, 'M');
const LOOSE_GLOVE = line('loose-jacket', GLOVE, 'M');

let id = '';
let actions: CartAction[] = [];
beforeEach(async () => {
  setCatalogueForTests(EVERYTHING);
  setDealsForTests([]);
  replies.length = 0;
  modelCalls = 0;
  actions = [];
  id = `cert-removal-${Math.random()}`;
  await sessions.getOrCreate(id);
  await sessions.patch(id, { cartMode: 'theme', widgetContract: 'cart-ops/1' });
});

async function basket(lines: Line[]) {
  await sessions.patch(id, { basket: lines.map((entry) => ({ ...entry })) });
}

/** A turn as the customer has it: the reply, and the widget carrying out and confirming any change. */
async function say(text: string, model: Completion[] = []) {
  replies.length = 0;
  replies.push(...model);
  const before = modelCalls;
  const reply = await converse(id, text);
  await sessions.append(id, [
    { id: `u-${Math.random()}`, role: 'user', text, createdAt: new Date().toISOString() },
    { id: `a-${Math.random()}`, role: 'assistant', text: reply.text, createdAt: new Date().toISOString() },
  ]);
  const turnActions = reply.actions ?? [];
  actions.push(...turnActions);
  const session = await sessions.getOrCreate(id);
  const wasBasket = [...(session.basket ?? [])];
  const after = wasBasket.filter((entry) => !turnActions.some((action) => action.type === 'change' && action.lineKey === entry.lineId && action.quantity === 0));
  await confirmApplied(id, turnActions, wasBasket, after);
  await sessions.patch(id, { basket: after });
  return { ...reply, modelCalls: modelCalls - before };
}
const removed = () => actions.filter((action): action is Extract<CartAction, { type: 'change' }> => action.type === 'change' && action.quantity === 0).map((action) => action.lineKey).sort();
const pending = async () => (await sessions.getOrCreate(id)).pendingAction;
const remaining = async () => ((await sessions.getOrCreate(id)).basket ?? []).map((entry) => entry.lineId).sort();

describe('certification: removing more than one line', () => {
  it('the live conversation: "remove these items from my basket" over a six-piece pack takes the pack out, with no question and no model call', async () => {
    await basket(PACK);
    const reply = await say('Caddy, please remove these items from my basket.');
    expect(reply.modelCalls).toBe(0);
    expect(removed()).toEqual(['k1', 'k2', 'k3', 'k4', 'k5', 'k6']);
    expect(await remaining()).toEqual([]);
    expect(reply.text).not.toMatch(/which/i);
  });

  it('"remove them all" takes everything out - a pack and a loose line alike', async () => {
    await basket([...PACK, LOOSE_POLO]);
    const reply = await say('Remove them all.');
    expect(reply.modelCalls).toBe(0);
    expect(removed()).toEqual(['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'loose-polo']);
    expect(await remaining()).toEqual([]);
  });

  it('"take the pack out" with a loose polo beside it: the pack, and only the pack', async () => {
    await basket([...PACK, LOOSE_POLO]);
    await say('Take the pack out please.');
    expect(removed()).toEqual(['k1', 'k2', 'k3', 'k4', 'k5', 'k6']);
    expect(await remaining()).toEqual(['loose-polo']);
  });

  it('"remove these items" over a pack and a loose polo: asked once, bound to every line, and "please remove it" is the yes', async () => {
    await basket([...PACK, LOOSE_POLO]);
    const asked = await say('Remove these items please.');
    expect(asked.modelCalls).toBe(0);
    expect(removed()).toEqual([]);
    expect(asked.text).toMatch(/shall i take it all out\?/i);
    expect(await pending()).toMatchObject({ type: 'update-line', awaiting: 'confirmation', quantity: 0, lineIds: ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'loose-polo'] });
    const done = await say('Please remove it.');
    expect(done.modelCalls).toBe(0);
    expect(removed()).toEqual(['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'loose-polo']);
    expect(await remaining()).toEqual([]);
    expect(done.text).not.toMatch(/which/i);
  });

  it('"remove it" with one pack and nothing else in the basket: the pack, asked once - and "yes" takes it out', async () => {
    await basket(PACK);
    const asked = await say('Remove it.', [{ tool: { name: 'update_cart_item', args: { lineId: 'k1', quantity: 0 } } }, { content: 'Which item would you like me to remove?' }]);
    expect(removed()).toEqual([]);
    expect(asked.text).toMatch(/all 6 pieces/i);
    expect(asked.text).toMatch(/\?\s*$/);
    expect(await pending()).toMatchObject({ type: 'update-line', awaiting: 'confirmation', lineIds: ['k1', 'k2', 'k3', 'k4', 'k5', 'k6'] });
    await say('Yes please.');
    expect(removed()).toEqual(['k1', 'k2', 'k3', 'k4', 'k5', 'k6']);
  });

  it('the model asking its own question over a refused, untargeted removal: the tool\'s question is what they hear', async () => {
    await basket([LOOSE_POLO, LOOSE_WHITE, LOOSE_GLOVE]);
    const reply = await say('Remove the polo.', [
      { tool: { name: 'update_cart_item', args: { lineId: 'loose-jacket', quantity: 0 } } },
      { content: 'Would you like me to remove everything in your basket?' },
    ]);
    expect(removed()).toEqual([]);
    expect(reply.text).toMatch(/which one do you mean - the elite polo - navy in l or the elite polo - white in m\?/i);
  });

  it('asked to remove and the model asks instead of calling the tool: sent back once, and the tool decides', async () => {
    await basket([LOOSE_POLO, LOOSE_GLOVE]);
    const reply = await say('Can you remove the jacket?', [
      { content: 'Which item would you like me to remove?' },
      { tool: { name: 'update_cart_item', args: { lineId: 'loose-jacket', quantity: 0 } } },
      { content: 'Taking the jacket out.' },
    ]);
    expect(reply.modelCalls).toBe(3);
    expect(removed()).toEqual(['loose-jacket']);
    expect(await remaining()).toEqual(['loose-polo']);
  });

  it('"remove all the polos" with a jacket beside them: both polos, the jacket stays', async () => {
    await basket([LOOSE_POLO, LOOSE_WHITE, LOOSE_GLOVE]);
    await say('Remove all the polos.');
    expect(removed()).toEqual(['loose-polo', 'loose-white']);
    expect(await remaining()).toEqual(['loose-jacket']);
  });

  it('a removal that names one line still takes that line and no other', async () => {
    await basket([LOOSE_POLO, LOOSE_GLOVE]);
    await say('Remove the jacket from my basket.');
    expect(removed()).toEqual(['loose-jacket']);
    expect(await remaining()).toEqual(['loose-polo']);
  });

  it('"remove the pack" with no pack in the basket says so, and changes nothing', async () => {
    await basket([LOOSE_POLO]);
    const reply = await say('Remove the pack.');
    expect(removed()).toEqual([]);
    expect(reply.text).toMatch(/no pack in your basket/i);
  });

  it('"remove all of these items and show me polos" over a pack: the pack out, stamped as an operation, no confirmation (live, 29 Sep)', async () => {
    await basket(PACK);
    const reply = await say('Yes, can you please remove all of these items and show me polos?', [
      { tool: { name: 'update_cart_item', args: { lineId: 'k3', quantity: 0 } } },
      { tool: { name: 'search_products', args: { query: 'polos' } } },
      { content: 'Taking the pack out. Here are polos.' },
    ]);
    expect(reply.text).not.toMatch(/shall i\?/i);
    expect(removed()).toEqual(['k1', 'k2', 'k3', 'k4', 'k5', 'k6']);
    // Every change carries the operation the widget runs it under - bare changes are refused as unstamped.
    for (const action of actions) expect(action).toHaveProperty('operationId');
    expect(await remaining()).toEqual([]);
  });

  it('a pack piece removed from the cart drawer itself (a tap) takes the pack out with an operation', async () => {
    await basket(PACK);
    const { runTool } = await import('../../src/tools/index.js');
    const result = await runTool('update_cart_item', { lineId: 'k2', quantity: 0 }, { session: await sessions.getOrCreate(id), utterance: '', direct: true });
    expect(result.outcome?.ok).toBe(true);
    expect((result.actions ?? []).map((action) => (action.type === 'change' ? action.lineKey : '')).sort()).toEqual(['k1', 'k2', 'k3', 'k4', 'k5', 'k6']);
    for (const action of result.actions ?? []) expect(action).toHaveProperty('operationId');
  });

  it('a whole pack out is one operation per line, confirmed once when the last settles (the widget runs one action per operation id)', async () => {
    await basket(PACK);
    const { settleOutcome } = await import('../../src/tools/cartOperations.js');
    replies.length = 0;
    const reply = await converse(id, 'Remove them all.');
    const changes = (reply.actions ?? []).filter((action): action is Extract<CartAction, { type: 'change' }> => action.type === 'change');
    expect(changes).toHaveLength(6);
    expect(new Set(changes.map((action) => action.operationId)).size).toBe(6);
    // The widget: one change at a time, each reported with the cart read back.
    let left = PACK.map((line) => ({ key: line.lineId, productId: line.productId, variantId: line.variantId!, title: line.title, variantTitle: line.variantTitle, quantity: 1 }));
    const texts: string[] = [];
    for (const action of changes) {
      const before = { lines: left };
      left = left.filter((line) => line.key !== action.lineKey);
      const answer = await settleOutcome(id, { operationId: action.operationId!, status: 'applied', before, after: { lines: left }, evidence: 'ajax-cart-read' });
      expect(answer.status).toBe('applied');
      texts.push(answer.text ?? '');
      if (left.length) expect((await pending())?.awaiting).toBe('outcome');
    }
    expect(texts.slice(0, 5)).toEqual(['', '', '', '', '']);
    expect(texts[5]).toMatch(/removed the whole pack from your basket/i);
    expect(await pending()).toBeUndefined();
    expect((await sessions.getOrCreate(id)).basket).toEqual([]);
  });

  it('"remove them" after the pack has gone: nothing to loop on - the basket is empty and it says so', async () => {
    await basket(PACK);
    await say('Remove them all.');
    expect(await remaining()).toEqual([]);
    const reply = await say('Remove them.');
    expect(reply.text).toMatch(/empty/i);
  });
});
