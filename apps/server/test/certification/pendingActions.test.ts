import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaddieAttachment, CartAction, Product } from '@caddie/shared';

/**
 * V1 hardening task 3: one code-owned record of the action the Caddie is
 * waiting to finish, and the customer's next words read against it before
 * the model runs. "I think I'll go with red and you already know my size"
 * finishes the add; "Yeah, I think that will be fine. Can we do a pack as
 * well?" is a yes and then a pack; a yes with nothing waiting adds nothing;
 * and whatever tool the model reaches for - or none - the outcome is the same.
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
const { env } = await import('../../src/env.js');
const { confirmApplied } = await import('../support/widgetCart.js');

let nextId = 13000;
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
    description: 'Waterproof rain jacket.',
  };
}

const TOPS = [{ name: 'Size', values: ['S', 'M', 'L', 'XL'] }];
const GLEN_RED = product('GLEN RAIN JACKET - RED', TOPS, () => false, 45);
const GLEN_NAVY = product('GLEN RAIN JACKET - NAVY', TOPS, () => false, 45);
const POLO = product('ELITE POLO - NAVY', TOPS, () => false, 20);
const SOCKS = product('ONE PAIR TOUR ANKLE SOCKS - WHITE', [], () => false, 8);
const WARRIOR = product('WARRIOR JACKET - RED', TOPS, (c) => c.Size !== 'XL', 60);
const HEXA = product('HEXA PERFORMANCE JACKET - BLACK', TOPS, () => false, 40);
const PACK_POLO = product('GOLF TEE POLO - RED', TOPS, () => false, 20);
const TROUSERS = product("MEN'S CLIMA GOLF TROUSERS - NAVY", [
  { name: 'WAIST SIZE', values: ['30', '32', '34'] },
  { name: 'LEG LENGTH', values: ['30', '32', '34'] },
]);
const VAPOUR = product('VAPOUR JACKET - NAVY', TOPS, () => false, 40);
const EVERYTHING = [GLEN_RED, GLEN_NAVY, POLO, SOCKS, WARRIOR, HEXA, PACK_POLO, TROUSERS, VAPOUR];

const step = (title: string, products: Product[]) => ({ title, collection: title, productIds: new Set(products.map((p) => p.id)) });
const COOL_WET = {
  handle: 'ambassador-men-coolwet',
  title: 'AMBASSADOR PACK - COOL & WET',
  range: 'men' as const,
  prices: { GBP: 99 },
  dynamicPrices: false,
  url: '',
  condition: 'coolwet' as const,
  conditionTitle: 'AMBASSADOR PACK - COOL & WET',
  steps: [step('JACKET', [WARRIOR, HEXA]), step('POLO', [PACK_POLO]), step('TROUSERS', [TROUSERS])],
};

let id = '';
let actions: CartAction[] = [];
beforeEach(async () => {
  setCatalogueForTests(EVERYTHING);
  setDealsForTests([COOL_WET]);
  replies.length = 0;
  actions = [];
  id = `pending-${Math.random()}`;
  await sessions.getOrCreate(id);
  await sessions.patch(id, { cartMode: 'theme', widgetContract: 'cart-ops/1' });
});

async function say(text: string, model: Completion[] = []) {
  replies.length = 0;
  replies.push(...model);
  const before = modelCalls;
  const reply = await converse(id, text);
  await sessions.append(id, [
    { id: `u-${Math.random()}`, role: 'user', text, createdAt: new Date().toISOString() },
    { id: `a-${Math.random()}`, role: 'assistant', text: reply.text, createdAt: new Date().toISOString() },
  ]);
  actions.push(...(reply.actions ?? []));
  // The widget reports the basket back after a change.
  const session = await sessions.getOrCreate(id);
  const wasBasket = [...(session.basket ?? [])];
  const basket = [...wasBasket];
  for (const action of reply.actions ?? []) {
    if (action.type === 'add') for (const line of action.lines) { const owner = ownerOf(line.variantId); basket.push({ lineId: `line-${basket.length + 1}`, productId: owner.product.id, variantId: owner.variant.id.split('/').pop(), title: owner.product.title, variantTitle: owner.variant.title, quantity: line.quantity }); }
    if (action.type === 'add-bundle') for (const piece of action.pieces) { const owner = ownerOf(piece.variantId); basket.push({ lineId: `line-${basket.length + 1}`, productId: owner.product.id, title: owner.product.title, variantTitle: owner.variant.title, quantity: 1, bundle: action.bundleId ?? 'b1' }); }
    if (action.type === 'change') { const at = basket.findIndex((line) => line.lineId === action.lineKey); if (at >= 0) { if (action.quantity === 0) basket.splice(at, 1); else basket[at] = { ...basket[at]!, quantity: action.quantity }; } }
  }
  // The widget's part: the change carried out in the (fake) theme cart and reported, so the gateway can complete it (test/support/widgetCart.ts).
  await confirmApplied(id, reply.actions, wasBasket, basket);
  await sessions.patch(id, { basket });
  return { ...reply, modelCalls: modelCalls - before };
}

const owners = new Map(EVERYTHING.flatMap((product) => product.variants.map((variant) => [variant.id.split('/').pop()!, { product, variant }] as const)));
const ownerOf = (variantId: string) => owners.get(String(variantId).split('/').pop()!)!;
const added = () => actions.filter((action) => action.type === 'add').flatMap((action) => (action.type === 'add' ? action.lines.map((line) => `${ownerOf(line.variantId).product.title} [${ownerOf(line.variantId).variant.title}] x${line.quantity}`) : []));
const packsAdded = () => actions.filter((action) => action.type === 'add-bundle');
const pending = async () => (await sessions.getOrCreate(id)).pendingAction;
const cards = (reply: { attachment?: CaddieAttachment }) => (reply.attachment?.kind === 'products' ? reply.attachment.products.map((p) => p.title) : []);
const packItems = (reply: { attachment?: CaddieAttachment }) => (reply.attachment?.kind === 'pack' ? reply.attachment.recommendation.items.map((p) => p.title) : []);

const OFFER_GLEN = 'The Glen Rain Jacket in red is in stock in S for you. Would you like me to add it to your basket?';
/** The Glen in red with S settled, offered by the model - the record written from what the session holds. */
async function offeredGlenRedS() {
  await rememberShopper(id, { range: 'men', usualSize: 'S' }, 'ui-form');
  await say('Show me the Glen rain jacket in red', [{ tool: { name: 'search_products', args: { productName: 'Glen Rain Jacket', colour: 'red' } } }, { content: OFFER_GLEN }]);
  const record = await pending();
  expect(record).toMatchObject({ type: 'add-product', productIds: [GLEN_RED.id], awaiting: 'confirmation', authorized: false });
}
/** "Add the Glen" with its colour open: an add they asked for, waiting on the colour. */
async function glenWaitingColour() {
  await say('Show me the Glen rain jacket', [{ tool: { name: 'search_products', args: { productName: 'Glen Rain Jacket' } } }, { content: 'Here it is in red and navy. Which size do you need?' }]);
  const asked = await say('Please add that one into my basket', [{ tool: { name: 'add_to_cart', args: { productId: GLEN_NAVY.id } } }, { content: 'Which colour would you like?' }]);
  expect(asked.text).toMatch(/colour/i);
  expect(await pending()).toMatchObject({ type: 'add-product', awaiting: 'colour', authorized: true });
  expect(added()).toEqual([]);
}

const WRONG_TOOL: Completion[] = [{ tool: { name: 'search_products', args: { query: 'jackets' } } }, { content: 'Here are some jackets.' }];
const NO_TOOL: Completion[] = [{ content: 'Would you like me to add it to your basket?' }];
const RIGHT_TOOL: Completion[] = [{ tool: { name: 'add_to_cart', args: { productId: GLEN_RED.id, options: { Size: 'S' } } } }, { content: 'Added.' }];
const BEHAVIOURS = [
  { name: 'the right tool', model: RIGHT_TOOL },
  { name: 'the wrong tool', model: WRONG_TOOL },
  { name: 'no tool', model: NO_TOOL },
];

describe('a yes to what is waiting', () => {
  it.each(BEHAVIOURS)('1. "yes" ($name): added once, no re-confirmation', async ({ model }) => {
    await offeredGlenRedS();
    const reply = await say('yes', model);
    expect(added()).toEqual(['GLEN RAIN JACKET - RED [S] x1']);
    expect(reply.text).not.toMatch(/would you like me to add/i);
    expect(await pending()).toBeUndefined();
  });

  it('2. "Yeah, I think that will be fine." is a yes', async () => {
    await offeredGlenRedS();
    const reply = await say('Yeah, I think that will be fine.', NO_TOOL);
    expect(reply.modelCalls).toBe(0);
    expect(added()).toEqual(['GLEN RAIN JACKET - RED [S] x1']);
  });

  it('3. a yes and a second request: added, then the socks shown, in one turn', async () => {
    await offeredGlenRedS();
    const reply = await say('Yes add it, and show me socks.', [{ tool: { name: 'search_products', args: { query: 'socks' } } }, { content: 'Here are the socks.' }]);
    expect(added()).toEqual(['GLEN RAIN JACKET - RED [S] x1']);
    expect(reply.modelCalls).toBeGreaterThan(0);
    expect(cards(reply)).toContain(SOCKS.title);
  });

  it('3b. the real one: "Yeah, I think that will be fine. Is it possible if we can create our pack here?"', async () => {
    await offeredGlenRedS();
    const reply = await say('Yeah, I think that will be fine. Is it possible if we can create our pack here?', [
      { tool: { name: 'recommend_pack', args: { query: 'Ambassador Pack' } } },
      { content: 'Here is the Cool & Wet pack.' },
    ]);
    expect(added()).toEqual(['GLEN RAIN JACKET - RED [S] x1']);
    expect(reply.attachment?.kind).toBe('pack');
  });

  it('4. a yes then a reversal: nothing', async () => {
    await offeredGlenRedS();
    const reply = await say("Yeah... actually no, don't add it", RIGHT_TOOL);
    expect(added()).toEqual([]);
    expect(await pending()).toBeUndefined();
    expect(reply.text).not.toMatch(/I'?ve added|in your basket/i);
  });

  it('22. no waiting action: "yes" adds nothing, whatever the model calls', async () => {
    await say('Show me the Glen rain jacket in red', [{ tool: { name: 'search_products', args: { productName: 'Glen Rain Jacket', colour: 'red' } } }, { content: 'Here it is. Is there anything else?' }]);
    expect(await pending()).toBeUndefined();
    await say('yeah', RIGHT_TOOL);
    expect(added()).toEqual([]);
  });

  it('16. a repeated yes after success adds nothing', async () => {
    await offeredGlenRedS();
    await say('yes', NO_TOOL);
    await say('yes', RIGHT_TOOL);
    await say('yes please', [{ content: 'It is in your basket.' }]);
    expect(added()).toEqual(['GLEN RAIN JACKET - RED [S] x1']);
  });

  it('23. the model calls the wrong tool while the action is complete: only the intended add is made', async () => {
    await offeredGlenRedS();
    const reply = await say('yes', [{ tool: { name: 'add_to_cart', args: { productId: POLO.id, options: { Size: 'S' } } } }, { content: 'Added the polo.' }]);
    expect(added()).toEqual(['GLEN RAIN JACKET - RED [S] x1']);
    expect(reply.text).not.toMatch(/polo/i);
  });
});

describe('answers to what was asked', () => {
  it("5. \"I think I'll go with red\" answers the colour; then only the size is asked", async () => {
    await glenWaitingColour();
    const reply = await say("I think I'll go with red", NO_TOOL);
    expect(reply.modelCalls).toBe(0);
    expect(reply.text).toMatch(/size/i);
    expect(reply.text).not.toMatch(/shall i add|would you like me to add/i);
    expect(await pending()).toMatchObject({ type: 'add-product', productIds: [GLEN_RED.id], awaiting: 'size', authorized: true });
    expect(added()).toEqual([]);
  });

  it.each(BEHAVIOURS)('6. the real sentence ($name): red bound, S from the recommendation, added once', async ({ model }) => {
    await say('My chest is 32 inches, which size should I go for in the Glen rain jacket?', [
      { tool: { name: 'find_my_size', args: { chestCm: 81.28, audience: 'men', productId: GLEN_RED.id } } },
      { content: 'S fits your chest size best, but M works if you want extra room.' },
    ]);
    expect((await sessions.getOrCreate(id)).sizeRecommendation?.size).toBe('S');
    await glenWaitingColour();
    const reply = await say('I think I will go with red and you already know my size so please.', model);
    expect(added()).toEqual(['GLEN RAIN JACKET - RED [S] x1']);
    expect(reply.text).not.toMatch(/would you like me to add|shall i add/i);
    expect(await pending()).toBeUndefined();
  });

  it('7. "you already know my size" with a usual size that applies: used', async () => {
    await rememberShopper(id, { range: 'men', usualSize: 'M' }, 'ui-form');
    await glenWaitingColour();
    await say('The red one please, and you already know my size', NO_TOOL);
    expect(added()).toEqual(['GLEN RAIN JACKET - RED [M] x1']);
  });

  it('8. the same with no size known: the size is asked, nothing added', async () => {
    await glenWaitingColour();
    const reply = await say('The red one please, and you already know my size', NO_TOOL);
    expect(added()).toEqual([]);
    expect(reply.text).toMatch(/size/i);
    expect(await pending()).toMatchObject({ awaiting: 'size' });
  });

  it('9. "use the recommended size" binds the current recommendation to this add', async () => {
    await say('My chest is 32 inches, which size in the Glen rain jacket?', [
      { tool: { name: 'find_my_size', args: { chestCm: 81.28, audience: 'men', productId: GLEN_RED.id } } },
      { content: 'S fits best.' },
    ]);
    await glenWaitingColour();
    await say('red', NO_TOOL);
    expect(await pending()).toMatchObject({ awaiting: 'size' });
    await say('use the recommended size', NO_TOOL);
    expect(added()).toEqual(['GLEN RAIN JACKET - RED [S] x1']);
  });

  it('10. the accepted recommendation is not made their usual size', async () => {
    await say('My chest is 32 inches, which size in the Glen rain jacket?', [
      { tool: { name: 'find_my_size', args: { chestCm: 81.28, audience: 'men', productId: GLEN_RED.id } } },
      { content: 'S fits best.' },
    ]);
    await glenWaitingColour();
    await say('The red one, you already know my size', NO_TOOL);
    expect(added()).toEqual(['GLEN RAIN JACKET - RED [S] x1']);
    const session = await sessions.getOrCreate(id);
    expect(session.shopper?.usualSize).toBeUndefined();
    expect(session.sizeRecommendation?.acceptedMission).toBeDefined();
  });

  it('11b. the size given with the add is kept through the colour question', async () => {
    await say('Show me the Glen rain jacket', [{ tool: { name: 'search_products', args: { productName: 'Glen Rain Jacket' } } }, { content: 'Here it is in red and navy.' }]);
    const asked = await say('Please add it to my basket in small', [{ tool: { name: 'add_to_cart', args: { productId: GLEN_NAVY.id, options: { Size: 'S' } } } }, { content: 'Which colour?' }]);
    expect(asked.text).toMatch(/colour/i);
    expect(await pending()).toMatchObject({ awaiting: 'colour', authorized: true, options: { Size: 'S' } });
    await say("I think I'll go with the red one", NO_TOOL);
    expect(added()).toEqual(['GLEN RAIN JACKET - RED [S] x1']);
  });

  it('17b. a swap offered with the product named in the sentence before the question is bound', async () => {
    await say('Show me the Cool & Wet Ambassador Pack in red', [{ tool: { name: 'recommend_pack', args: { query: 'Ambassador Pack Cool & Wet', colour: 'red' } } }, { content: 'Here it is.' }]);
    await say('My top size is M', [{ content: 'OK.' }]);
    await say('Which would you suggest?', [{ content: "I'd suggest the Hexa Performance Jacket in black; it is in M. Would you like me to add it to your pack instead of the Warrior Jacket?" }]);
    expect(await pending()).toMatchObject({ type: 'replace-pack-piece', productIds: [HEXA.id] });
    const done = await say('yes please', [{ content: 'Done.' }]);
    expect(packItems(done)).toContain(HEXA.title);
  });

  it("11c. the model's option under the wrong name: the size they said still makes the variant", async () => {
    // The catalogue's option is "JACKET SIZE"; the model passes "Size". The customer said "small".
    const JACKET = product('FORGER RAIN JACKET - GREY', [{ name: 'JACKET SIZE', values: ['S', 'M', 'L'] }], () => false, 50);
    setCatalogueForTests([...EVERYTHING, JACKET]);
    for (const variant of JACKET.variants) owners.set(variant.id.split('/').pop()!, { product: JACKET, variant });
    await say('Show me the Forger rain jacket', [{ tool: { name: 'search_products', args: { productName: 'Forger Rain Jacket' } } }, { content: 'Here it is.' }]);
    await say('Please add it to my basket in small', [{ tool: { name: 'add_to_cart', args: { productId: JACKET.id, options: { Size: 'S' } } } }, { content: 'Added.' }]);
    expect(added()).toEqual(['FORGER RAIN JACKET - GREY [S] x1']);
  });

  it('11d. "the red one" when the record held the blue: the red colourway, in the size already given', async () => {
    await say('Show me the Glen rain jacket', [{ tool: { name: 'search_products', args: { productName: 'Glen Rain Jacket' } } }, { content: 'Here it is in red and navy. What size in the navy?' }]);
    // The model adds the navy one for "it": two on screen, so the colour is asked - but the record holds what the model picked.
    await say('Please add it to my basket in small', [{ tool: { name: 'add_to_cart', args: { productId: GLEN_NAVY.id, options: { Size: 'S' } } } }, { content: 'Which colour?' }]);
    await say("I think I'll go with the red one", NO_TOOL);
    expect(added()).toEqual(['GLEN RAIN JACKET - RED [S] x1']);
  });

  it.each([
    'Would you like to pick this one or see the others again?',
    'Shall I add it to your Ambassador Pack - Cool & Wet?',
    'Would you like to choose it, or prefer another jacket from the list?',
  ])('17c. an offer worded "%s" binds the swap', async (question) => {
    await say('Show me the Cool & Wet Ambassador Pack in red', [{ tool: { name: 'recommend_pack', args: { query: 'Ambassador Pack Cool & Wet', colour: 'red' } } }, { content: 'Here it is.' }]);
    await say('My top size is M', [{ content: 'OK.' }]);
    await say('Which would you suggest?', [{ content: `I'd suggest the Hexa Performance Jacket in black; it is in M. ${question}` }]);
    expect(await pending()).toMatchObject({ type: 'replace-pack-piece', productIds: [HEXA.id] });
  });

  it('11. the record lives through colour then size', async () => {
    await glenWaitingColour();
    await say('red', NO_TOOL);
    expect(await pending()).toMatchObject({ productIds: [GLEN_RED.id], awaiting: 'size', authorized: true });
    await say('M', NO_TOOL);
    expect(added()).toEqual(['GLEN RAIN JACKET - RED [M] x1']);
    expect(await pending()).toBeUndefined();
  });

  it('12. and through a question about the jacket in between', async () => {
    await glenWaitingColour();
    await say('red', NO_TOOL);
    await say('Is it waterproof?', [{ tool: { name: 'product_info', args: { which: 'Glen Rain Jacket', question: 'waterproof' } } }, { content: 'Yes, it is described as waterproof.' }]);
    expect(await pending()).toMatchObject({ awaiting: 'size', authorized: true });
    await say('M then', NO_TOOL);
    expect(added()).toEqual(['GLEN RAIN JACKET - RED [M] x1']);
  });

  it('13. an unrelated mission ends it: "M" later is not the jacket\'s size', async () => {
    await glenWaitingColour();
    await say('red', NO_TOOL);
    await say('show me polos', [{ tool: { name: 'search_products', args: { query: 'polos' } } }, { content: 'Here are some polos.' }]);
    await say('M', [{ tool: { name: 'add_to_cart', args: { productId: GLEN_RED.id, options: { Size: 'M' } } } }, { content: 'Added.' }]);
    expect(added()).toEqual([]);
  });

  it('14. "never mind" cancels it, and the rest is answered', async () => {
    await glenWaitingColour();
    const reply = await say('Never mind that. Show me polos.', [{ tool: { name: 'search_products', args: { query: 'polos' } } }, { content: 'Here are some polos.' }]);
    expect(await pending()).toBeUndefined();
    expect(added()).toEqual([]);
    expect(cards(reply)).toContain(POLO.title);
  });

  it.each(BEHAVIOURS)('15. everything given at once ($name): added immediately, no "shall I?"', async ({ model }) => {
    const reply = await say('Add the Glen rain jacket in red in S to my basket', model);
    expect(added()).toEqual(['GLEN RAIN JACKET - RED [S] x1']);
    expect(reply.text).not.toMatch(/would you like me to add|shall i add/i);
  });

  it('24b. "I’m updating your basket" (curly apostrophe) with nothing done is a claim too', async () => {
    await say('Show me the Elite Polo', [{ tool: { name: 'search_products', args: { productName: 'Elite Polo' } } }, { content: 'Here it is.' }]);
    const reply = await say('Change it to L', [{ content: 'I’m updating your basket to the Elite Polo in L.' }, { content: 'Nothing has changed yet.' }]);
    expect(reply.text).not.toMatch(/updating your basket to the/);
    expect(added()).toEqual([]);
  });

  it('24. "Added it" from the model with no gateway success is not what they hear', async () => {
    await glenWaitingColour();
    await say('red', NO_TOOL);
    const reply = await say('Is it waterproof?', [{ content: "Yes, it's waterproof. I've added it to your basket." }, { content: "It's waterproof, and I've added it to your basket." }]);
    expect(added()).toEqual([]);
    expect(reply.text).not.toMatch(/added it to your basket/i);
  });
});

describe('packs', () => {
  async function packReadyButLeg() {
    await rememberShopper(id, { range: 'men', usualSize: 'M', waist: '32' }, 'ui-form');
    const shown = await say('Show me the Cool & Wet Ambassador Pack', [{ tool: { name: 'recommend_pack', args: { query: 'Ambassador Pack Cool & Wet' } } }, { content: 'Here it is. Which leg length?' }]);
    expect(packItems(shown)).toContain(HEXA.title);
  }

  it.each(BEHAVIOURS)('18. "add the pack" with the leg missing ($name): the leg is asked, "34" completes it, no re-confirmation', async ({ model }) => {
    await packReadyButLeg();
    const asked = await say('Add the pack to my basket', [{ tool: { name: 'add_pack_to_cart', args: {} } }, { content: 'Which leg length?' }]);
    expect(asked.text).toMatch(/leg/i);
    expect(await pending()).toMatchObject({ type: 'add-pack', awaiting: 'leg', authorized: true });
    const done = await say('34', model.map((m) => (m.tool?.name === 'add_to_cart' ? { tool: { name: 'add_pack_to_cart', args: {} } } : m)));
    expect(packsAdded()).toHaveLength(1);
    expect(done.text).not.toMatch(/shall i add|would you like me to add/i);
    expect(await pending()).toBeUndefined();
  });

  it('19. sizes alone never authorise the pack add', async () => {
    await packReadyButLeg();
    // ("Waterproof" names the Rainsuit deal to the deal check, which is a rule of its own - not what this test is about.)
    // A question about the pack that names no garment (a garment word reads as a new browse, and "waterproof" names a deal).
    await say('Is the pack paid for as one item at checkout?', [{ content: 'It is. Shall I add the pack to your basket?' }]);
    expect(await pending()).toMatchObject({ type: 'add-pack', awaiting: 'confirmation', authorized: false });
    const sized = await say('waist 32, leg 34', [{ tool: { name: 'add_pack_to_cart', args: {} } }, { content: 'Added the pack.' }]);
    expect(packsAdded()).toEqual([]);
    expect(sized.text).not.toMatch(/added the pack/i);
    await say('yes please', [{ content: 'Done.' }]);
    expect(packsAdded()).toHaveLength(1);
  });

  it.each(['yes', 'please replace it', 'go ahead'])('17. "%s" to an offered swap: exactly once', async (yes) => {
    await say('Show me the Cool & Wet Ambassador Pack in red', [{ tool: { name: 'recommend_pack', args: { query: 'Ambassador Pack Cool & Wet', colour: 'red' } } }, { content: 'Here it is.' }]);
    // The Warrior, sold out in M, must go: choices shown, the Hexa offered by name.
    const required = await say('My top size is M', [{ content: 'OK.' }]);
    expect(cards(required)).toContain(HEXA.title);
    const offer = await say('Which would you suggest?', [{ content: 'Would you like to replace the Warrior Jacket with the Hexa Performance Jacket in black, in M?' }]);
    expect(await pending()).toMatchObject({ type: 'replace-pack-piece', productIds: [HEXA.id], pack: COOL_WET.handle, awaiting: 'confirmation' });
    void offer;
    const done = await say(yes, [{ tool: { name: 'add_pack_to_cart', args: {} } }, { content: 'Swapped.' }]);
    expect(done.modelCalls).toBe(0);
    expect(packItems(done)).toContain(HEXA.title);
    expect(packItems(done)).not.toContain(WARRIOR.title);
    expect(await pending()).toBeUndefined();
    const again = await say('yes', [{ content: 'Anything else?' }]);
    expect(packItems(again)).toEqual([]);
    expect(added()).toEqual([]);
  });
});

describe('the basket', () => {
  async function poloInBasket() {
    await say('Add the Elite Polo in navy in M to my basket', [{ tool: { name: 'add_to_cart', args: { productId: POLO.id, options: { Size: 'M' } } } }, { content: 'Added.' }]);
    expect(added()).toEqual(['ELITE POLO - NAVY [M] x1']);
  }

  it('20. "how many?" then "two": the line is changed, no confirmation', async () => {
    await poloInBasket();
    const asked = await say('change the quantity of the polo', [{ tool: { name: 'update_cart_item', args: { lineId: 'line-1', quantity: 3 } } }, { content: 'How many?' }]);
    expect(asked.text).toMatch(/how many/i);
    expect(await pending()).toMatchObject({ type: 'update-line', awaiting: 'quantity' });
    await say('two', [{ content: 'Done.' }]);
    expect((await sessions.getOrCreate(id)).basket?.[0]?.quantity).toBe(2);
  });

  it('21. removing a pack piece: asked once, the whole pack out on the yes', async () => {
    await sessions.patch(id, {
      basket: [
        { lineId: 'p1', productId: HEXA.id, title: HEXA.title, variantTitle: 'M', quantity: 1, bundle: 'b1' },
        { lineId: 'p2', productId: PACK_POLO.id, title: PACK_POLO.title, variantTitle: 'M', quantity: 1, bundle: 'b1' },
      ],
    });
    const asked = await say('remove the polo', [{ tool: { name: 'update_cart_item', args: { lineId: 'p2', quantity: 0 } } }, { content: 'Removed.' }]);
    expect(asked.text).toMatch(/whole pack/i);
    expect(actions.filter((action) => action.type === 'change')).toEqual([]);
    expect(await pending()).toMatchObject({ type: 'update-line', lineId: 'p2', awaiting: 'confirmation' });
    await say('yes', [{ content: 'Done.' }]);
    expect(actions.filter((action) => action.type === 'change').map((action) => (action.type === 'change' ? action.lineKey : '')).sort()).toEqual(['p1', 'p2']);
    expect((await sessions.getOrCreate(id)).basket).toEqual([]);
  });
});

/*
 * Closure of task 3: the question follows the record. A confirmation is asked
 * only once code holds the exact action it answers; the action is bound from
 * what the session holds, never from the words the model chose; and the
 * words are then held to the record.
 */
describe('the question follows the record', () => {
  async function warriorMustGo(pool: Product[] = [WARRIOR, HEXA]) {
    setDealsForTests([{ ...COOL_WET, steps: [step('JACKET', pool), COOL_WET.steps[1]!, COOL_WET.steps[2]!] }]);
    await say('Show me the Cool & Wet Ambassador Pack in red', [{ tool: { name: 'recommend_pack', args: { query: 'Ambassador Pack Cool & Wet', colour: 'red' } } }, { content: 'Here it is.' }]);
    const required = await say('My top size is M', [{ content: 'OK.' }]);
    expect(cards(required)).toContain(HEXA.title);
  }
  const UNNAMED = 'Should I update your Ambassador Pack with this jacket?';

  it('1-2. one candidate: the record exists, bound to it, whatever the offer calls it - and "yes" swaps the stored product', async () => {
    await warriorMustGo();
    const offer = await say('Which one would you suggest?', [{ content: UNNAMED }]);
    expect(offer.text).toContain('?');
    expect(await pending()).toMatchObject({ type: 'replace-pack-piece', productIds: [HEXA.id], pack: COOL_WET.handle, step: 0, outgoing: WARRIOR.id, options: { size: 'M' }, awaiting: 'confirmation', authorized: false });
    const done = await say('Yes, please replace it.', [{ content: 'Which jacket would you like?' }]);
    expect(done.modelCalls).toBe(0);
    expect(packItems(done)).toContain(HEXA.title);
    expect(packItems(done)).not.toContain(WARRIOR.title);
    expect(done.text).not.toMatch(/which (jacket|one)/i);
  });

  it.each(['Swap the Warrior for the Hexa?', 'Use this jacket in your pack?', 'Should I update the pack with this one?', 'Would you like me to proceed with adding it?'])('3. "%s": the wording is free, the binding is the record', async (question) => {
    await warriorMustGo();
    await say('Which one would you suggest?', [{ content: `The Hexa Performance Jacket is in M. ${question}` }]);
    expect(await pending()).toMatchObject({ type: 'replace-pack-piece', productIds: [HEXA.id] });
    const done = await say('yes', [{ content: 'Anything else?' }]);
    expect(packItems(done)).toContain(HEXA.title);
    expect(await pending()).toBeUndefined();
  });

  it('4. two candidates and nothing selected: no record, and the customer is asked which - never to confirm', async () => {
    await warriorMustGo([WARRIOR, HEXA, VAPOUR]);
    const offer = await say('Which one would you suggest?', [{ content: UNNAMED }]);
    expect(await pending()).toBeUndefined();
    expect(offer.text).toMatch(/which jacket would you like/i);
    expect(offer.text).not.toMatch(/update your/i);
    const nothing = await say('yes', [{ content: 'Which jacket would you like?' }]);
    expect(packItems(nothing)).toEqual([]);
    expect(added()).toEqual([]);
  });

  it('4b. two candidates, one looked up by the model: that is the selection, made by id', async () => {
    await warriorMustGo([WARRIOR, HEXA, VAPOUR]);
    await say('Which one would you suggest?', [{ tool: { name: 'get_product_details', args: { productId: VAPOUR.id } } }, { content: UNNAMED }]);
    expect(await pending()).toMatchObject({ type: 'replace-pack-piece', productIds: [VAPOUR.id] });
    const done = await say('yes', [{ content: 'Done.' }]);
    expect(packItems(done)).toContain(VAPOUR.title);
    expect(packItems(done)).not.toContain(WARRIOR.title);
  });

  it('4c. one candidate suggested with no swap asked: no confirmation record; "yes" swaps nothing, "replace it" swaps the one suggested', async () => {
    await warriorMustGo([WARRIOR, HEXA, VAPOUR]);
    await say('Which one would you suggest?', [{ content: "I'd suggest the Vapour Jacket in navy; it is in M. Would you like me to check its full details for you?" }]);
    expect(await pending()).toBeUndefined();
    const nothing = await say('yes', [{ content: 'It is a waterproof jacket.' }]);
    expect(packItems(nothing)).toEqual([]);
    await say('Which one would you suggest?', [{ content: "The Vapour Jacket in navy. Would you like me to check its full details for you?" }]);
    const done = await say('Yes, please replace it.', [{ content: 'Which jacket would you like?' }]);
    expect(done.modelCalls).toBe(0);
    expect(packItems(done)).toContain(VAPOUR.title);
    expect(packItems(done)).not.toContain(WARRIOR.title);
  });

  it('4d. one candidate suggested, then the checker leaves only "which jacket?": the swap is asked from the state, record first', async () => {
    await warriorMustGo([WARRIOR, HEXA, VAPOUR]);
    // Too long for the check; the rewrite claims a feature the tools never gave, so only its question survives.
    const offer = await say('Which one would you suggest?', [
      { content: "I'd suggest the Vapour Jacket in navy for you. It is in stock in M and sits well with the rest of the pack. It is a fine choice for wet rounds and cool mornings on the course, honestly." },
      { content: 'The Vapour Jacket is fully waterproof and breathable. Which jacket would you like to replace the Warrior Jacket with?' },
    ]);
    expect(offer.text).toMatch(/swap the warrior jacket for the vapour jacket in navy, in m\?/i);
    expect(await pending()).toMatchObject({ type: 'replace-pack-piece', productIds: [VAPOUR.id], awaiting: 'confirmation' });
    const done = await say('yes', [{ content: 'Which jacket?' }]);
    expect(done.modelCalls).toBe(0);
    expect(packItems(done)).toContain(VAPOUR.title);
  });

  it('5-6. the checker rewrites the offer: the record survives, and the reply still asks', async () => {
    await warriorMustGo();
    // A price the tools never gave fails the check; the rewrite drops the question altogether.
    const offer = await say('Which one would you suggest?', [{ content: 'The Hexa Performance Jacket is £999 in M. Should I update your pack with it?' }, { content: 'The Hexa Performance Jacket is a good choice for wet rounds.' }]);
    expect(offer.text).not.toContain('£999');
    expect(await pending()).toMatchObject({ type: 'replace-pack-piece', productIds: [HEXA.id], awaiting: 'confirmation' });
    expect(offer.text).toMatch(/\?/);
    const done = await say('yes', [{ content: 'Done.' }]);
    expect(packItems(done)).toContain(HEXA.title);
  });

  it('7-8. an exact add awaiting authorisation: the record exists before the reply, and a generic "want me to add it?" then "yes" adds the stored product', async () => {
    await rememberShopper(id, { range: 'men', usualSize: 'S' }, 'ui-form');
    await say('Show me the Glen rain jacket in red', [{ tool: { name: 'search_products', args: { productName: 'Glen Rain Jacket', colour: 'red' } } }, { content: 'Here it is in red, in stock in S. Want me to add it?' }]);
    expect(await pending()).toMatchObject({ type: 'add-product', productIds: [GLEN_RED.id], options: { Size: 'S' }, awaiting: 'confirmation', authorized: false });
    const done = await say('yes', [{ content: 'Which size?' }]);
    expect(done.modelCalls).toBe(0);
    expect(added()).toEqual(['GLEN RAIN JACKET - RED [S] x1']);
    expect(await pending()).toBeUndefined();
  });

  it('9. no exact target: a generic offer is not asked - the colour is', async () => {
    await rememberShopper(id, { range: 'men', usualSize: 'S' }, 'ui-form');
    const offer = await say('Show me the Glen rain jacket', [{ tool: { name: 'search_products', args: { productName: 'Glen Rain Jacket' } } }, { content: 'Here it is. Would you like me to add it to your basket?' }]);
    const record = await pending();
    // Two colourways: whatever is recorded waits on the colour, never on a yes.
    if (record) expect(record.awaiting).toBe('colour');
    expect(offer.text).not.toMatch(/add it to your basket\?/i);
    expect(offer.text).toMatch(/which colour/i);
    await say('yes', [{ content: 'Added.' }]);
    expect(added()).toEqual([]);
  });

  it('10. no record, "yes": nothing changes', async () => {
    await say('Show me the Elite Polo', [{ tool: { name: 'search_products', args: { productName: 'Elite Polo' } } }, { content: 'Here it is in navy. It is a nice polo.' }]);
    expect(await pending()).toBeUndefined();
    const nothing = await say('yes', [{ tool: { name: 'add_to_cart', args: { productId: POLO.id, options: { Size: 'M' } } } }, { content: 'Added.' }]);
    expect(added()).toEqual([]);
    expect(nothing.text).not.toMatch(/^added/i);
  });

  it('11. done, then "yes" again: no second swap, no second add', async () => {
    await warriorMustGo();
    await say('Which one would you suggest?', [{ content: UNNAMED }]);
    const done = await say('yes', [{ content: 'Done.' }]);
    expect(packItems(done)).toContain(HEXA.title);
    const again = await say('yes', [{ tool: { name: 'add_pack_to_cart', args: {} } }, { content: 'Swapped again.' }]);
    expect(packItems(again)).toEqual([]);
    expect(added()).toEqual([]);
    expect(packsAdded()).toEqual([]);
    expect(await pending()).toBeUndefined();
  });
});
