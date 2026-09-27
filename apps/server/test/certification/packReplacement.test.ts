import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Product } from '@caddie/shared';
import { setDealsForTests, type DealRecipe } from '../../src/catalog/bundles.js';
import { setCatalogueForTests } from '../../src/catalog/sync.js';
import { env } from '../../src/env.js';
import { noteShoppingFocus } from '../../src/session/focus.js';
import { readCustomerTurn } from '../../src/ai/turn.js';
import { sessions } from '../../src/session/store.js';
import { runTool } from '../../src/tools/index.js';
import type { ToolResult } from '../../src/tools/types.js';

/**
 * A piece of a pack replaced because it is sold out in their size (preview
 * store). The Warrior Jacket in red had no S; the customer asked for another
 * jacket in small, chose the Hexa Performance in black "instead of that red
 * jacket" - and got a standalone £40 jacket, the pack let go, and then a loop
 * of "shall I add it?" to an explicit "yes, add this, size small".
 */

const BRAND = [env.shopify.brandTag].filter(Boolean) as string[];

function garment(title: string, stock: Record<string, boolean>, price = 40): Product {
  const sizes = Object.keys(stock);
  return {
    id: `gid://shopify/Product/${title.replace(/\W+/g, '-')}`,
    title,
    url: '',
    imageUrl: null,
    vendor: 'Druids',
    productType: null,
    tags: [...BRAND],
    price: { amount: price, currency: 'GBP' },
    options: [{ name: 'Size', values: sizes }],
    variants: sizes.map((size) => ({ id: `${title}-${size}`, title: size, available: stock[size]!, price: { amount: price, currency: 'GBP' }, options: { Size: size } })),
    description: null,
  };
}

const ALL = { S: true, M: true, L: true, XL: true, '2XL': true };
const WARRIOR_RED = garment('WARRIOR JACKET - RED', { S: false, M: false, L: false, XL: false, '2XL': true }, 60);
const HEXA_BLACK = garment("MEN'S HEXA PERFORMANCE JACKET - BLACK", ALL);
const HEXA_NAVY = garment("MEN'S HEXA PERFORMANCE JACKET - NAVY", ALL);
const HEXA_GREY = garment("MEN'S HEXA PERFORMANCE JACKET - GREY", { ...ALL, S: false });
const POLO = garment('ELITE POLO - RED', ALL, 20);
const POLO_WHITE = garment('ELITE POLO - WHITE', ALL, 20);
const CAP = garment('KOMO CAP - RED', { 'ONE SIZE': true }, 15);

const step = (title: string, products: Product[]) => ({ title, collection: title, productIds: new Set(products.map((p) => p.id)) });
const MIXED: DealRecipe = {
  handle: 'ambassador-pack-mixed-conditions',
  title: 'AMBASSADOR PACK - MIXED CONDITIONS',
  range: 'men',
  prices: { GBP: 99 },
  dynamicPrices: false,
  url: '',
  steps: [step('POLO', [POLO, POLO_WHITE]), step('JACKET', [WARRIOR_RED, HEXA_BLACK, HEXA_NAVY, HEXA_GREY]), step('CAP', [CAP])],
};

let id = '';
beforeEach(async () => {
  setCatalogueForTests([WARRIOR_RED, HEXA_BLACK, HEXA_NAVY, HEXA_GREY, POLO, POLO_WHITE, CAP]);
  setDealsForTests([MIXED]);
  id = `replace-${Math.random()}`;
  await sessions.getOrCreate(id);
  await sessions.patch(id, { cartMode: 'theme' });
});
afterEach(() => setDealsForTests([]));

/** One customer turn: their words are read (focus, pack sizes) as converse() does, then the tool the model chose runs. */
async function turn(said: string, tool: string, args: Record<string, unknown>): Promise<ToolResult> {
  await readCustomerTurn(id, said);
  const session = await sessions.getOrCreate(id);
  const result = await runTool(tool, args, { session, utterance: said });
  await sessions.append(id, [
    { id: `u${Math.random()}`, role: 'user', text: said, createdAt: new Date().toISOString() },
    { id: `a${Math.random()}`, role: 'assistant', text: result.speech, createdAt: new Date().toISOString() },
  ]);
  return result;
}

const packTitles = (result: ToolResult) => (result.attachment?.kind === 'pack' ? result.attachment.recommendation.items.map((p) => p.title) : []);
const cardTitles = (result: ToolResult) => (result.attachment?.kind === 'products' ? result.attachment.products.map((p) => p.title) : []);
const adds = (result: ToolResult) => (result.actions ?? []).filter((action) => action.type === 'add' || action.type === 'add-bundle');

/** The pack with the Warrior Jacket in it, then "the Warrior is sold out in S - show me another jacket in small". */
async function warriorSoldOut(): Promise<ToolResult> {
  const shown = await turn('show me the ambassador pack mixed conditions in red', 'recommend_pack', { query: 'Ambassador Pack Mixed Conditions', colour: 'red' });
  expect(packTitles(shown)).toContain('WARRIOR JACKET - RED');
  return turn('Warrior jacket small size is showing sold out. So can you show any other jacket which is available in small size.', 'search_products', { query: 'jacket', size: 'S' });
}

describe('replacing a sold-out pack piece', () => {
  it('another jacket in small stays in the pack: only the jackets it takes, in stock in S', async () => {
    const choices = await warriorSoldOut();
    expect(cardTitles(choices).sort()).toEqual([HEXA_BLACK.title, HEXA_NAVY.title].sort());
    expect(choices.speech).toMatch(/can go in the pack/);
    const focus = (await sessions.getOrCreate(id)).activeShoppingContext;
    expect(focus?.pack).toBe(MIXED.handle);
    expect(focus?.replacing).toMatchObject({ step: 1, size: 'S' });
  });

  it('asked to see another jacket, the model swapping one in shows the choices instead', async () => {
    await turn('show me the ambassador pack mixed conditions in red', 'recommend_pack', { query: 'Ambassador Pack Mixed Conditions', colour: 'red' });
    const result = await turn('Warrior jacket small size is showing sold out. So can you show any other jacket which is available in small size.', 'recommend_pack', {
      query: 'Ambassador Pack Mixed Conditions',
      swap: WARRIOR_RED.id,
    });
    expect(packTitles(result)).toEqual([]);
    expect(cardTitles(result).sort()).toEqual([HEXA_BLACK.title, HEXA_NAVY.title].sort());
  });

  it('the pack in hand but other cards on screen: another jacket in small is still the pack’s choices', async () => {
    await turn('show me the ambassador pack mixed conditions in red', 'recommend_pack', { query: 'Ambassador Pack Mixed Conditions', colour: 'red' });
    // The model looked each piece up, so product cards - not the pack - are on screen.
    await sessions.patch(id, { lastShown: { kind: 'products', items: [WARRIOR_RED, POLO, CAP].map((p) => ({ id: p.id, title: p.title })), query: 'details' } });
    const result = await turn('Warrior jacket small size is showing sold out. So can you show any other jacket which is available in small size.', 'search_products', { query: 'jacket', size: 'S' });
    expect(cardTitles(result).sort()).toEqual([HEXA_BLACK.title, HEXA_NAVY.title].sort());
    expect((await sessions.getOrCreate(id)).activeShoppingContext?.replacing?.step).toBe(1);
  });

  it('"add this Hexa instead of that red jacket" with no choices shown is still a replacement', async () => {
    await turn('show me the ambassador pack mixed conditions in red', 'recommend_pack', { query: 'Ambassador Pack Mixed Conditions', colour: 'red' });
    await sessions.patch(id, { lastShown: { kind: 'products', items: [HEXA_NAVY, HEXA_BLACK].map((p) => ({ id: p.id, title: p.title })), query: 'jacket' } });
    const choose = await turn('Add this Hexa Performance. Add this to my bag instead of that red jacket which is not available.', 'add_to_cart', { productId: HEXA_NAVY.id, options: { Size: 'S' } });
    expect(adds(choose)).toEqual([]);
    expect(choose.speech).toMatch(/Which colour/);
    expect(choose.speech).not.toMatch(/\bred\b/i);
    const black = await turn('I like black', 'add_to_cart', { productId: HEXA_BLACK.id, options: { Size: 'S' } });
    expect(adds(black)).toEqual([]);
    expect(packTitles(black)).toContain(HEXA_BLACK.title);
    expect(packTitles(black)).not.toContain(WARRIOR_RED.title);
  });

  it('the whole preview-store transcript ends with Hexa Black S in the pack, and no standalone jacket', async () => {
    await warriorSoldOut();
    // The model reached for add_to_cart with the navy one; the customer did not say a colour.
    const choose = await turn('Add this Hexa Performance. Add this to my bag instead of that red jacket which is not available.', 'add_to_cart', { productId: HEXA_NAVY.id, options: { Size: 'S' } });
    expect(adds(choose)).toEqual([]);
    expect(choose.speech).toMatch(/Which colour/);
    expect(choose.speech).not.toMatch(/red/i);

    const meant = await turn("I meant men's performance jacket. Please replace it in the bag.", 'add_to_cart', { productId: HEXA_NAVY.id });
    expect(adds(meant)).toEqual([]);
    expect((await sessions.getOrCreate(id)).activeShoppingContext?.pack).toBe(MIXED.handle);

    const black = await turn('I like black', 'get_product_details', { productId: HEXA_BLACK.id });
    const pieces = packTitles(black);
    expect(pieces).toContain(HEXA_BLACK.title);
    expect(pieces).not.toContain(WARRIOR_RED.title);
    expect(pieces).toContain(POLO.title);
    expect(adds(black)).toEqual([]);
    const after = (await sessions.getOrCreate(id)).activeShoppingContext;
    expect(after?.pack).toBe(MIXED.handle);
    expect(after?.replacing).toBeUndefined();

    // "Yes, add this, size small" now: the pack, with Hexa Black S as its jacket - never the jacket on its own at £40.
    const yes = await turn('Yes, add this to the bag. The size is small.', 'add_to_cart', { productId: HEXA_BLACK.id, options: { Size: 'S' } });
    const added = adds(yes);
    expect(added.filter((action) => action.type === 'add')).toEqual([]);
    expect(added).toHaveLength(1);
    const lines = added[0]!.type === 'add-bundle' ? added[0]!.pieces.map((piece) => piece.variantId) : [];
    expect(lines).toContain(`${HEXA_BLACK.title}-S`);
    expect(lines.some((variant) => /WARRIOR/.test(variant))).toBe(false);
    expect(yes.speech).toMatch(/£99/);

    // A second yes does not put a second pack in: at most it replaces the one already there.
    const firstId = added[0]!.type === 'add-bundle' ? added[0]!.bundleId : undefined;
    const again = await turn('yes, add it', 'add_to_cart', { productId: HEXA_BLACK.id, options: { Size: 'S' } });
    expect(adds(again).filter((action) => action.type === 'add')).toEqual([]);
    for (const action of adds(again)) expect(action.type === 'add-bundle' && firstId && action.replaceBundles?.includes(firstId)).toBeTruthy();
  });

  it.each(['use this instead', 'replace the red jacket with this', 'add this instead of the red jacket'])('"%s" replaces the piece, not a standalone add', async (said) => {
    await warriorSoldOut();
    // Hexa Black the one card pointed at.
    await sessions.patch(id, { lastShown: { kind: 'products', items: [{ id: HEXA_BLACK.id, title: HEXA_BLACK.title }], query: `pack choices: ${MIXED.handle}` } });
    const result = await turn(said, 'add_to_cart', { productId: HEXA_BLACK.id, options: { Size: 'S' } });
    expect(adds(result)).toEqual([]);
    expect(packTitles(result)).toContain(HEXA_BLACK.title);
    expect(packTitles(result)).not.toContain(WARRIOR_RED.title);
  });

  it('never puts in a colour sold out in the size asked for', async () => {
    await warriorSoldOut();
    const grey = await turn('I like grey', 'get_product_details', { productId: HEXA_GREY.id });
    expect(packTitles(grey)).not.toContain(HEXA_GREY.title);
    expect(packTitles(grey)).not.toContain(HEXA_NAVY.title);
    expect(packTitles(grey)).not.toContain(HEXA_BLACK.title);
    expect(adds(grey)).toEqual([]);
  });

  it('replace wording with nothing settled asks one question, never adds on its own', async () => {
    await warriorSoldOut();
    await sessions.patch(id, { lastShown: { kind: 'products', items: [], query: 'nothing' } });
    const result = await turn('put that in instead', 'add_to_cart', { productId: HEXA_BLACK.id, options: { Size: 'S' } });
    expect(adds(result)).toEqual([]);
  });

  it('asked for separately, it is a standalone add', async () => {
    await warriorSoldOut();
    const result = await turn('add the Hexa Performance Jacket in black in S separately, on its own', 'add_to_cart', { productId: HEXA_BLACK.id, options: { Size: 'S' } });
    expect(packTitles(result)).toEqual([]);
  });
});

describe('the next pack question after the swap', () => {
  it('a piece not made in their confirmed top size is asked about by name, not "what top size"', async () => {
    const BELT = garment('TOUR PRO BELT - BLACK', { 'M/L': true, 'L/XL': true }, 20);
    const WITH_BELT: DealRecipe = { ...MIXED, steps: [...MIXED.steps.slice(0, 2), step('BELT', [BELT])] };
    setCatalogueForTests([WARRIOR_RED, HEXA_BLACK, HEXA_NAVY, HEXA_GREY, POLO, POLO_WHITE, BELT]);
    setDealsForTests([WITH_BELT]);
    await turn('show me the ambassador pack mixed conditions in black', 'recommend_pack', { query: 'Ambassador Pack Mixed Conditions', colour: 'black' });
    await turn('top size S', 'recommend_pack', { query: 'Ambassador Pack Mixed Conditions' });
    const result = await turn('add the pack to my bag, size small', 'add_pack_to_cart', {});
    expect(adds(result)).toEqual([]);
    expect(result.speech).toMatch(/Tour Pro Belt - Black doesn't come in S - which size would you like: M\/L or L\/XL\?/);
    expect(result.speech).not.toMatch(/What top size/);
  });
});

describe('leaving the pack (Phase 3B) still works', () => {
  it('pack, then "show me polos" leaves the pack', async () => {
    await turn('show me the ambassador pack mixed conditions in red', 'recommend_pack', { query: 'Ambassador Pack Mixed Conditions', colour: 'red' });
    await noteShoppingFocus(id, 'show me polos');
    expect((await sessions.getOrCreate(id)).activeShoppingContext?.pack).toBeUndefined();
  });

  it('pack, then the Warrior sold out, "show me another jacket available in S" stays in the pack', async () => {
    await turn('show me the ambassador pack mixed conditions in red', 'recommend_pack', { query: 'Ambassador Pack Mixed Conditions', colour: 'red' });
    await noteShoppingFocus(id, 'The Warrior jacket is sold out in small, show me another jacket available in S');
    expect((await sessions.getOrCreate(id)).activeShoppingContext?.pack).toBe(MIXED.handle);
  });
});

describe('an explicit add is authorised once', () => {
  async function hexaBlackOnScreen() {
    await turn("Show me the Men's Hexa Performance Jacket in black", 'search_products', { query: 'hexa performance jacket', colour: 'black' });
    await sessions.patch(id, {
      lastShown: { kind: 'products', items: [HEXA_BLACK, HEXA_NAVY, HEXA_GREY].map((p) => ({ id: p.id, title: p.title })), query: 'hexa performance jacket' },
    });
  }

  it('"Yes, add this to my basket. The size is small." adds Hexa Black S, once, without asking again', async () => {
    await hexaBlackOnScreen();
    const result = await turn('Yes, add this to my basket. The size is small.', 'add_to_cart', { productId: HEXA_BLACK.id, options: { Size: 'S' } });
    const added = adds(result);
    expect(added).toHaveLength(1);
    expect(JSON.stringify(added[0])).toMatch(/BLACK-S/);
  });

  it('"S" then "Add it" adds once; a repeated yes does not add it again', async () => {
    await hexaBlackOnScreen();
    await turn('S', 'get_product_details', { productId: HEXA_BLACK.id, options: { Size: 'S' } });
    const first = await turn('Add it', 'add_to_cart', { productId: HEXA_BLACK.id, options: { Size: 'S' } });
    expect(adds(first)).toHaveLength(1);
    await sessions.patch(id, { basket: [{ lineId: 'hexa-s', productId: HEXA_BLACK.id, title: HEXA_BLACK.title, variantTitle: 'S', quantity: 1 }] });
    const again = await turn('yes', 'add_to_cart', { productId: HEXA_BLACK.id, options: { Size: 'S' } });
    expect(adds(again)).toEqual([]);
  });

  it("the model's other colour is not added", async () => {
    await hexaBlackOnScreen();
    const result = await turn('Yes, add this to my basket. The size is small.', 'add_to_cart', { productId: HEXA_NAVY.id, options: { Size: 'S' } });
    expect(JSON.stringify(adds(result))).not.toMatch(/NAVY/);
  });
});
