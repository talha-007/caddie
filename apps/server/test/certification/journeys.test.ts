import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CartAction, Product } from '@caddie/shared';

/**
 * Customer journeys, end to end through converse(), with the model scripted
 * to behave differently each time - the right tool, the wrong colour, the
 * wrong tool, or no tool at all and "shall I add it?". What the customer ends
 * up with must be the same every time: the goal decides it (tools/journey.ts),
 * not which tool the model reached for. Each journey checks the active goal,
 * what is known, what is missing, the action taken and what the customer sees.
 */

type Completion = { content?: string; tool?: { name: string; args: Record<string, unknown> } };
const replies: Completion[] = [];

vi.mock('../../src/lib/http.js', async (original) => ({
  ...(await original<typeof import('../../src/lib/http.js')>()),
  fetchWithTimeout: vi.fn(async (url: string) => {
    if (!String(url).includes('chat/completions')) throw new Error(`unexpected call to ${url}`);
    const next = replies.shift() ?? { content: 'Anything else I can help with?' };
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
const { customerGoal } = await import('../../src/tools/journey.js');
const { env } = await import('../../src/env.js');
const { confirmApplied } = await import('../support/widgetCart.js');

let nextId = 7000;
function garment(title: string, stock: Record<string, boolean>, price = 40): Product {
  const id = nextId;
  nextId += 20;
  const sizes = Object.keys(stock);
  return {
    id: `gid://shopify/Product/${id}`,
    title,
    url: '',
    imageUrl: null,
    vendor: 'Druids',
    productType: null,
    tags: [env.shopify.brandTag].filter(Boolean) as string[],
    price: { amount: price, currency: 'GBP' },
    options: [{ name: 'Size', values: sizes }],
    variants: sizes.map((size, i) => ({ id: `gid://shopify/ProductVariant/${id + i + 1}`, title: size, available: stock[size]!, price: { amount: price, currency: 'GBP' }, options: { Size: size } })),
    description: null,
  };
}

const ALL = { S: true, M: true, L: true, XL: true };
const WARRIOR_RED = garment('WARRIOR JACKET - RED', { S: false, M: false, L: false, XL: true }, 60);
const HEXA_BLACK = garment("MEN'S HEXA PERFORMANCE JACKET - BLACK", ALL);
const HEXA_NAVY = garment("MEN'S HEXA PERFORMANCE JACKET - NAVY", ALL);
const POLO_RED = garment('ELITE POLO - RED', ALL, 20);
const POLO_NAVY = garment('ELITE POLO - NAVY', ALL, 20);
const POLO_WHITE = garment('ELITE POLO - WHITE', ALL, 20);
const CAP = garment('KOMO CAP - RED', { 'ONE SIZE': true }, 15);
const CLIMA_NAVY = garment('CLIMA JACKET 3.0 - NAVY', ALL, 58);
const EVERYTHING = [WARRIOR_RED, HEXA_BLACK, HEXA_NAVY, POLO_RED, POLO_NAVY, POLO_WHITE, CAP, CLIMA_NAVY];

const step = (title: string, products: Product[]) => ({ title, collection: title, productIds: new Set(products.map((p) => p.id)) });
const MIXED = {
  handle: 'ambassador-pack-mixed-conditions',
  title: 'AMBASSADOR PACK - MIXED CONDITIONS',
  range: 'men' as const,
  prices: { GBP: 99 },
  dynamicPrices: false,
  url: '',
  steps: [step('POLO', [POLO_RED, POLO_WHITE]), step('JACKET', [WARRIOR_RED, HEXA_BLACK, HEXA_NAVY]), step('CAP', [CAP])],
};

beforeEach(() => {
  setCatalogueForTests(EVERYTHING);
  setDealsForTests([MIXED]);
  replies.length = 0;
});

const owners = new Map(EVERYTHING.flatMap((product) => product.variants.map((variant) => [variant.id.split('/').pop()!, { product, variant }] as const)));
/** The theme cart takes bare variant numbers; the catalogue holds GIDs. */
const variantOwner = { get: (id: string) => owners.get(String(id).split('/').pop()!) };

/** Everything the customer ends up with: the basket, as the widget applies the actions it is handed. */
interface Played {
  id: string;
  actions: CartAction[];
  replies: string[];
}

async function start(): Promise<Played> {
  const id = `journey-${Math.random()}`;
  await sessions.getOrCreate(id);
  await sessions.patch(id, { cartMode: 'theme', widgetContract: 'cart-ops/1' });
  return { id, actions: [], replies: [] };
}

/** One turn: the model scripted as given, the reply recorded as the routes record it, the basket synced as the widget does. */
async function say(played: Played, text: string, model: Completion[]) {
  replies.length = 0;
  replies.push(...model);
  const reply = await converse(played.id, text);
  await sessions.append(played.id, [
    { id: `u-${Math.random()}`, role: 'user', text, createdAt: new Date().toISOString() },
    { id: `a-${Math.random()}`, role: 'assistant', text: reply.text, createdAt: new Date().toISOString() },
  ]);
  const session = await sessions.getOrCreate(played.id);
  const before = [...(session.basket ?? [])];
  const basket = [...before];
  for (const action of reply.actions ?? []) {
    played.actions.push(action);
    if (action.type === 'add') {
      for (const line of action.lines) {
        const owner = variantOwner.get(line.variantId)!;
        basket.push({ lineId: `line-${basket.length + 1}`, productId: owner.product.id, variantId: owner.variant.id.split('/').pop(), title: owner.product.title, variantTitle: owner.variant.title, quantity: line.quantity });
      }
    }
    if (action.type === 'add-bundle') {
      for (const piece of action.pieces) {
        const owner = variantOwner.get(piece.variantId)!;
        basket.push({ lineId: `line-${basket.length + 1}`, productId: owner.product.id, title: owner.product.title, variantTitle: owner.variant.title, quantity: 1, bundle: action.bundle.title });
      }
    }
    if (action.type === 'change') {
      const at = basket.findIndex((line) => line.lineId === action.lineKey);
      if (at >= 0) {
        if (action.quantity === 0) basket.splice(at, 1);
        else basket[at] = { ...basket[at]!, quantity: action.quantity };
      }
    }
  }
  // The widget's part: the change carried out in the (fake) theme cart and reported, so the gateway can complete it (test/support/widgetCart.ts).
  await confirmApplied(played.id, reply.actions, before, basket);
  await sessions.patch(played.id, { basket });
  played.replies.push(reply.text);
  return reply;
}

async function goal(played: Played, said = '') {
  return customerGoal(await sessions.getOrCreate(played.id), said);
}

/** What went in, as "TITLE [size]" - singles and pack pieces apart. */
function added(played: Played) {
  const singles: string[] = [];
  const packs: string[][] = [];
  for (const action of played.actions) {
    if (action.type === 'add') for (const line of action.lines) singles.push(`${variantOwner.get(line.variantId)!.product.title} [${variantOwner.get(line.variantId)!.variant.title}] x${line.quantity}`);
    if (action.type === 'add-bundle') packs.push(action.pieces.map((piece) => `${variantOwner.get(piece.variantId)!.product.title} [${variantOwner.get(piece.variantId)!.variant.title}]`));
  }
  return { singles, packs };
}

async function basketNow(played: Played) {
  return ((await sessions.getOrCreate(played.id)).basket ?? []).map((line) => `${line.title} [${line.variantTitle}] x${line.quantity}`);
}

/* ------------------------------------------------------------------ */

describe('1. pack-piece replacement', () => {
  const WARRIOR_SOLD_OUT = 'Warrior jacket small size is showing sold out. So can you show any other jacket which is available in small size.';
  const CHOOSE = 'Add this Hexa Performance. Add this to my bag instead of that red jacket which is not available.';

  // How the model might handle each step - every combination must end the same.
  const variants: Array<{ name: string; show: Completion[]; choose: Completion[]; black: Completion[]; yes: Completion[] }> = [
    {
      name: 'the tools it should call',
      show: [{ tool: { name: 'search_products', args: { query: 'jacket', size: 'S' } } }, { content: 'Here are the jackets for the pack in S.' }],
      choose: [{ tool: { name: 'recommend_pack', args: { query: 'Ambassador Pack Mixed Conditions', swapWith: HEXA_NAVY.id } } }, { content: 'Which colour would you like?' }],
      black: [{ tool: { name: 'recommend_pack', args: { query: 'Ambassador Pack Mixed Conditions', swapWith: HEXA_BLACK.id } } }, { content: 'Done - the black Hexa is in the pack.' }],
      yes: [{ tool: { name: 'add_pack_to_cart', args: {} } }, { content: 'The pack is going in your bag.' }],
    },
    {
      name: 'standalone add_to_cart throughout',
      show: [{ tool: { name: 'recommend_pack', args: { query: 'Ambassador Pack Mixed Conditions', swap: WARRIOR_RED.id } } }, { content: 'Here you go.' }],
      choose: [{ tool: { name: 'add_to_cart', args: { productId: HEXA_NAVY.id, options: { Size: 'S' } } } }, { content: 'Which colour?' }],
      black: [{ tool: { name: 'add_to_cart', args: { productId: HEXA_BLACK.id, options: { Size: 'S' } } } }, { content: 'Lovely.' }],
      yes: [{ tool: { name: 'add_to_cart', args: { productId: HEXA_BLACK.id, options: { Size: 'S' } } } }, { content: 'Added.' }],
    },
    {
      name: 'no tool once it has shown the choices',
      show: [{ tool: { name: 'search_products', args: { query: 'jackets available in small' } } }, { content: 'These can go in the pack.' }],
      choose: [{ tool: { name: 'get_product_details', args: { productId: HEXA_NAVY.id } } }, { content: 'Which colour would you like?' }],
      black: [{ content: 'Great choice - shall I put the black one in the pack?' }],
      yes: [{ content: 'Shall I add the pack to your bag now?' }],
    },
  ];

  it.each(variants)('$name: Hexa Black S replaces the Warrior inside the pack, never a standalone jacket', async (variant) => {
    const played = await start();
    /*
     * The pack shown before their size is known (the Warrior has other sizes);
     * they find S sold out on its card and ask for another jacket in small -
     * the preview-store order. Their size given on its own would have replaced
     * the Warrior at once (packSizing.test.ts).
     */
    await say(played, 'Show me the Ambassador Pack Mixed Conditions in red', [
      { tool: { name: 'recommend_pack', args: { query: 'Ambassador Pack Mixed Conditions', colour: 'red' } } },
      { content: 'Here is the pack.' },
    ]);
    const shown = await say(played, WARRIOR_SOLD_OUT, variant.show);
    let g = await goal(played);
    expect(g?.kind).toBe('replace-pack-piece');
    expect(g?.known).toMatchObject({ pack: MIXED.title, step: 'JACKET', replacing: WARRIOR_RED.title, size: 'S' });
    // The only jackets the pack takes in S are the Hexa, in two colours.
    expect(g?.known.product).toMatch(/HEXA PERFORMANCE JACKET/);
    expect(g?.missing).toEqual(['colour']);
    expect(shown.attachment?.kind).toBe('products');

    const choose = await say(played, CHOOSE, variant.choose);
    g = await goal(played);
    expect(g?.kind).toBe('replace-pack-piece');
    expect(g?.known.product).toMatch(/HEXA PERFORMANCE JACKET/);
    expect(g?.missing).toEqual(['colour']);
    expect(choose.text).toMatch(/colour/i);

    const black = await say(played, 'I like black', variant.black);
    expect(black.attachment?.kind).toBe('pack');
    g = await goal(played);
    // Back in the pack's own flow: the replacement is done, nothing else is missing.
    expect(g?.kind).toBe('configure-pack');
    expect(g?.known).toMatchObject({ top: 'S' });
    expect(g?.missing).toEqual([]);

    const yes = await say(played, 'Yes, add this to the bag. The size is small.', variant.yes);
    const { singles, packs } = added(played);
    expect(singles).toEqual([]);
    expect(packs).toHaveLength(1);
    expect(packs[0]).toContain(`${HEXA_BLACK.title} [S]`);
    expect(packs[0]!.some((piece) => /WARRIOR/.test(piece))).toBe(false);
    // Nothing more was asked: the pack went in on that turn.
    expect(yes.text).not.toMatch(/\?\s*$/);
  });
});

describe('2. exact product add', () => {
  const variants: Array<{ name: string; model: Completion[] }> = [
    { name: 'add_to_cart', model: [{ tool: { name: 'add_to_cart', args: { productId: POLO_NAVY.id, options: { Size: 'M' } } } }, { content: 'Added.' }] },
    { name: "the model's other colour", model: [{ tool: { name: 'add_to_cart', args: { productId: POLO_WHITE.id, options: { Size: 'M' } } } }, { content: 'Added.' }] },
    { name: 'no tool, asks to confirm', model: [{ content: 'Shall I add the Elite Polo in navy, size M, to your basket?' }] },
  ];

  it.each(variants)('$name: one Elite Polo navy M, added on that turn', async (variant) => {
    const played = await start();
    const before = customerGoal(await sessions.getOrCreate(played.id), 'Add the Elite Polo in navy in M to my basket');
    expect(before).toBeNull();
    const reply = await say(played, 'Add the Elite Polo in navy in M to my basket', variant.model);
    expect(added(played).singles).toEqual(['ELITE POLO - NAVY [M] x1']);
    expect(reply.text).not.toMatch(/shall i|would you like me to/i);
    const g = await goal(played);
    expect(g?.known).toMatchObject({ product: 'ELITE POLO - NAVY', colour: 'NAVY', size: 'M' });
    expect(g?.status).toBe('done');

    // A repeated yes adds nothing more.
    await say(played, 'yes', [{ tool: { name: 'add_to_cart', args: { productId: POLO_NAVY.id, options: { Size: 'M' } } } }, { content: 'Done.' }]);
    expect(added(played).singles).toEqual(['ELITE POLO - NAVY [M] x1']);
  });
});

describe('3. product add needing one size', () => {
  const variants: Array<{ name: string; model: Completion[] }> = [
    { name: 'add_to_cart with the size', model: [{ tool: { name: 'add_to_cart', args: { productId: POLO_NAVY.id, options: { Size: 'M' } } } }, { content: 'Added.' }] },
    { name: 'no tool, confirms instead', model: [{ content: 'Great - shall I add the navy Elite Polo in M?' }] },
    { name: 'looks it up again', model: [{ tool: { name: 'get_product_details', args: { productId: POLO_NAVY.id } } }, { content: 'It comes in M - want me to add it?' }] },
  ];

  it.each(variants)('$name: the size is asked once, then it goes in', async (variant) => {
    const played = await start();
    const ask = await say(played, 'Add the Elite Polo in navy to my basket', [
      { tool: { name: 'add_to_cart', args: { productId: POLO_NAVY.id } } },
      { content: 'What size would you like?' },
    ]);
    expect(ask.text).toMatch(/size/i);
    let g = await goal(played);
    expect(g?.kind).toBe('add-product');
    expect(g?.known).toMatchObject({ product: 'ELITE POLO - NAVY', colour: 'NAVY' });
    expect(g?.missing).toEqual(['size']);

    await say(played, 'M', variant.model);
    expect(added(played).singles).toEqual(['ELITE POLO - NAVY [M] x1']);
    g = await goal(played);
    expect(g?.status).toBe('done');
  });
});

describe('3b. the size asked without the add being tried', () => {
  it.each([
    { name: 'no tool on the answer', model: [{ content: 'Shall I add it in M?' }] },
    { name: 'a lookup on the answer', model: [{ tool: { name: 'get_product_details', args: { productId: POLO_NAVY.id } } }, { content: 'Would you like me to add it to your basket now?' }] },
  ])('"add the polo" answered "which size?" with no tool, then "M" ($name): it goes in', async ({ model }) => {
    const played = await start();
    // The model asks for the size itself and never calls add_to_cart.
    await say(played, 'Add the Elite Polo in navy to my basket', [{ content: 'Which size would you like?' }]);
    const g = await goal(played);
    expect(g?.missing).toEqual(['size']);
    // The add they asked for is waiting on the size, whatever the model did.
    expect((await sessions.getOrCreate(played.id)).pendingAction).toMatchObject({ type: 'add-product', awaiting: 'size' });
    await say(played, 'M', model);
    expect(added(played).singles).toEqual(['ELITE POLO - NAVY [M] x1']);
  });
});

describe('2b. nothing offered again once done', () => {
  it('a "yes" after the add is not met with "shall I add it?"', async () => {
    const played = await start();
    await say(played, 'Add the Elite Polo in navy in M to my basket', [{ tool: { name: 'add_to_cart', args: { productId: POLO_NAVY.id, options: { Size: 'M' } } } }, { content: 'Added.' }]);
    const again = await say(played, 'yes', [{ content: 'Shall I add the Elite Polo in navy, size M, to your basket now?' }, { content: "It's in your basket. Anything else?" }]);
    expect(again.text).not.toMatch(/shall i add/i);
    expect(added(played).singles).toEqual(['ELITE POLO - NAVY [M] x1']);
  });
});

describe('4 and 5. basket edits', () => {
  async function withPoloInBasket() {
    const played = await start();
    await say(played, 'Add the Elite Polo in navy in M to my basket', [{ tool: { name: 'add_to_cart', args: { productId: POLO_NAVY.id, options: { Size: 'M' } } } }, { content: 'Added.' }]);
    expect(await basketNow(played)).toEqual(['ELITE POLO - NAVY [M] x1']);
    return played;
  }

  it.each([
    { name: 'update_cart_item', model: [{ tool: { name: 'update_cart_item', args: { lineId: 'line-1', quantity: 2 } } }, { content: 'Done.' }] },
    { name: 'no tool', model: [{ content: 'Would you like me to change it to two?' }] },
  ])('4. "make it two" ($name): two of the polo', async ({ model }) => {
    const played = await withPoloInBasket();
    const g = customerGoal(await sessions.getOrCreate(played.id), 'make it two');
    expect(g?.kind).toBe('edit-basket');
    expect(g?.known).toMatchObject({ change: 'quantity', line: 'ELITE POLO - NAVY (M)', quantity: '2' });
    expect(g?.missing).toEqual([]);
    await say(played, 'make it two', model);
    expect(await basketNow(played)).toEqual(['ELITE POLO - NAVY [M] x2']);
  });

  it.each([
    { name: 'update_cart_item', model: [{ tool: { name: 'update_cart_item', args: { lineId: 'line-1', quantity: 0 } } }, { content: 'Removed.' }] },
    { name: 'no tool', model: [{ content: 'Are you sure you want to remove the polo?' }] },
  ])('5. "remove the polo" ($name): the basket is empty', async ({ model }) => {
    const played = await withPoloInBasket();
    const g = customerGoal(await sessions.getOrCreate(played.id), 'remove the polo');
    expect(g?.kind).toBe('edit-basket');
    expect(g?.known).toMatchObject({ change: 'remove', line: 'ELITE POLO - NAVY (M)', quantity: '0' });
    await say(played, 'remove the polo', model);
    expect(await basketNow(played)).toEqual([]);
  });
});

describe('6. switching category halfway through a goal', () => {
  it.each([
    { name: 'add_to_cart for the polo', model: [{ tool: { name: 'add_to_cart', args: { productId: POLO_NAVY.id, options: { Size: 'M' } } } }, { content: 'Added.' }] },
    { name: 'no tool', model: [{ content: 'M it is. Anything else?' }] },
  ])('a size after "show me jackets" is not the polo\'s ($name)', async ({ model }) => {
    const played = await start();
    await say(played, 'Add the Elite Polo in navy to my basket', [{ tool: { name: 'add_to_cart', args: { productId: POLO_NAVY.id } } }, { content: 'What size?' }]);
    expect((await goal(played))?.kind).toBe('add-product');
    await say(played, 'actually, show me jackets', [{ tool: { name: 'search_products', args: { query: 'jackets' } } }, { content: 'Here are some jackets.' }]);
    const g = await goal(played);
    expect(g?.kind).toBe('browse-products');
    expect(g?.known.looking_for).toMatch(/jacket/);
    await say(played, 'M', model);
    expect(added(played).singles).toEqual([]);
  });
});

describe('1b. a pack shown with their size already known', () => {
  it('never holds the Warrior sold out in S - an available jacket is chosen instead', async () => {
    const played = await start();
    const shown = await say(played, 'Show me the Ambassador Pack Mixed Conditions in red, top size S', [
      { tool: { name: 'recommend_pack', args: { query: 'Ambassador Pack Mixed Conditions', colour: 'red' } } },
      { content: 'Here is the pack.' },
    ]);
    const pieces = shown.attachment?.kind === 'pack' ? shown.attachment.recommendation.items.map((p) => p.title) : [];
    expect(pieces).not.toContain(WARRIOR_RED.title);
    expect(pieces.some((title) => /HEXA/.test(title))).toBe(true);
  });
});

describe('7. an alternative search inside the same goal', () => {
  async function replacing() {
    const played = await start();
    /*
     * The pack shown before their size is known (the Warrior has other sizes);
     * they find S sold out on its card and ask for another jacket in small -
     * the preview-store order. Their size given on its own would have replaced
     * the Warrior at once (packSizing.test.ts).
     */
    await say(played, 'Show me the Ambassador Pack Mixed Conditions in red', [
      { tool: { name: 'recommend_pack', args: { query: 'Ambassador Pack Mixed Conditions', colour: 'red' } } },
      { content: 'Here is the pack.' },
    ]);
    await say(played, 'The Warrior jacket is sold out in small, can you show me another jacket available in S?', [
      { tool: { name: 'search_products', args: { query: 'jacket', size: 'S' } } },
      { content: 'Here are the jackets for the pack in S.' },
    ]);
    expect((await goal(played))?.kind).toBe('replace-pack-piece');
    return played;
  }

  it('"show me another jacket in S" keeps the replacement - whichever tool', async () => {
    for (const tool of [
      { name: 'search_products', args: { query: 'another jacket', size: 'S' } },
      { name: 'recommend_pack', args: { query: 'Ambassador Pack Mixed Conditions', swap: WARRIOR_RED.id } },
    ]) {
      const played = await replacing();
      const reply = await say(played, 'show me another jacket in S', [{ tool }, { content: 'Here you go.' }]);
      const g = await goal(played);
      expect(g?.kind).toBe('replace-pack-piece');
      expect(g?.known.size).toBe('S');
      expect(reply.attachment?.kind).toBe('products');
      const shown = reply.attachment?.kind === 'products' ? reply.attachment.products.map((p) => p.title) : [];
      expect(shown.every((title) => /HEXA/.test(title))).toBe(true);
      expect(added(played).singles).toEqual([]);
    }
  });

  it('"show me polos" ends the replacement', async () => {
    const played = await replacing();
    await say(played, 'show me polos', [{ tool: { name: 'search_products', args: { query: 'polos' } } }, { content: 'Here are some polos.' }]);
    const g = await goal(played);
    expect(g?.kind).toBe('browse-products');
    expect((await sessions.getOrCreate(played.id)).activeShoppingContext?.pack).toBeUndefined();
  });
});
