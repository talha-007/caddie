import { beforeEach, describe, expect, it } from 'vitest';
import type { CartAction, Product } from '@caddie/shared';
import { readCustomerTurn } from '../../src/ai/turn.js';
import { setDealsForTests } from '../../src/catalog/bundles.js';
import { setCatalogueForTests } from '../../src/catalog/sync.js';
import { env } from '../../src/env.js';
import { sessions } from '../../src/session/store.js';
import { runTool } from '../../src/tools/index.js';

/**
 * Certification §9: basket lines whose variant titles overlap. The customer
 * names one line; only that line may change. Every case asserts the line key
 * the widget is told to change - the one thing that reaches the store cart.
 */

const BRAND = [env.shopify.brandTag].filter(Boolean) as string[];
let next = 90000;
function product(title: string, type: string, sizes: string[]): Product {
  const id = next;
  next += 20;
  return {
    id: `gid://shopify/Product/${id}`,
    title,
    url: '',
    imageUrl: null,
    vendor: 'Druids',
    productType: type,
    tags: [...BRAND],
    price: { amount: 30, currency: 'GBP' },
    options: [{ name: 'Size', values: sizes }],
    variants: sizes.map((size, i) => ({ id: `gid://shopify/ProductVariant/${id + i + 1}`, title: size, available: true, price: { amount: 30, currency: 'GBP' }, options: { Size: size } })),
    description: 'Breathable.',
  };
}
const POLO = product('ELITE POLO - NAVY', 'POLOS', ['S', 'M', 'L']);
const POLO_WHITE = product('ELITE POLO - WHITE', 'POLOS', ['S', 'M', 'L']);
const JACKET = product('CLIMA JACKET 3.0 - NAVY', 'JACKETS', ['S', 'M', 'L']);
const SOCKS = product('ONE PAIR TOUR ANKLE SOCKS - WHITE', 'SOCKS', ['Default Title']);

let id = '';
beforeEach(async () => {
  setCatalogueForTests([POLO, POLO_WHITE, JACKET, SOCKS]);
  setDealsForTests([]);
  id = `cert-lines-${Math.random()}`;
  await sessions.getOrCreate(id);
  await sessions.patch(id, { cartMode: 'theme', widgetContract: 'cart-ops/1' });
});

type Line = { lineId: string; productId: string; title: string; variantTitle: string; quantity: number; bundle?: string };
async function basket(lines: Line[], lastAdded?: string) {
  await sessions.patch(id, { basket: lines, ...(lastAdded ? { lastAdded: { productId: lastAdded, turn: 1 } } : {}) });
}
/** A turn as converse runs it, then the model's update_cart_item proposal. */
async function ask(said: string, proposal: { lineId: string; quantity: number }) {
  await readCustomerTurn(id, said);
  const result = await runTool('update_cart_item', proposal, { session: await sessions.getOrCreate(id), utterance: said });
  await sessions.append(id, [{ id: `u-${Math.random()}`, role: 'user', text: said, createdAt: new Date().toISOString() }]);
  const changes = (result.actions ?? []).filter((action): action is Extract<CartAction, { type: 'change' }> => action.type === 'change');
  return { result, changes };
}

const polM: Line = { lineId: 'polo-m', productId: POLO.id, title: POLO.title, variantTitle: 'M', quantity: 1 };
const jacM: Line = { lineId: 'jacket-m', productId: JACKET.id, title: JACKET.title, variantTitle: 'M', quantity: 1 };
const jacL: Line = { lineId: 'jacket-l', productId: JACKET.id, title: JACKET.title, variantTitle: 'L', quantity: 1 };
const whiteM: Line = { lineId: 'white-m', productId: POLO_WHITE.id, title: POLO_WHITE.title, variantTitle: 'M', quantity: 1 };
const socks: Line = { lineId: 'socks', productId: SOCKS.id, title: SOCKS.title, variantTitle: '', quantity: 1 };

describe('certification: the basket line the customer names, never one that merely shares a variant title', () => {
  it('same size on two products: "remove the Elite Polo" removes the polo', async () => {
    await basket([polM, jacM], JACKET.id);
    const { changes } = await ask('remove the Elite Polo', { lineId: 'jacket-m', quantity: 0 });
    expect(changes).toMatchObject([{ type: 'change', lineKey: 'polo-m', quantity: 0 }]);
  });

  it('"make the jacket two" changes the jacket line', async () => {
    await basket([polM, jacM]);
    const { changes } = await ask('make the jacket two', { lineId: 'polo-m', quantity: 2 });
    expect(changes).toMatchObject([{ type: 'change', lineKey: 'jacket-m', quantity: 2 }]);
  });

  it('"remove the M one" with an M polo and an L jacket (the jacket just added): the M polo, or a question - never the jacket', async () => {
    await basket([polM, jacL], JACKET.id);
    const { changes, result } = await ask('remove the M one', { lineId: 'jacket-l', quantity: 0 });
    expect(changes.some((change) => change.lineKey === 'jacket-l')).toBe(false);
    if (!changes.length) expect(result.speech).toMatch(/which/i);
  });

  it('"remove the navy one" with a navy and a white polo in M: the navy one, or a question', async () => {
    await basket([polM, whiteM], POLO_WHITE.id);
    const { changes, result } = await ask('remove the navy one', { lineId: 'white-m', quantity: 0 });
    expect(changes.some((change) => change.lineKey === 'white-m')).toBe(false);
    if (!changes.length) expect(result.speech).toMatch(/which/i);
  });

  it('two sizes of one jacket: "remove the jacket" asks which', async () => {
    await basket([jacM, jacL]);
    const { changes, result } = await ask('remove the jacket', { lineId: 'jacket-m', quantity: 0 });
    expect(changes).toEqual([]);
    expect(result.speech).toMatch(/which/i);
  });

  it('"remove it" after another item was discussed: the one in hand, not the last added', async () => {
    // The jacket was added on turn 1; the polo is talked about on turn 2.
    await basket([polM, jacM], JACKET.id);
    await sessions.append(id, [{ id: 'u0', role: 'user', text: 'add the Clima Jacket in M', createdAt: new Date().toISOString() }]);
    await readCustomerTurn(id, 'tell me about the Elite Polo in navy');
    await sessions.append(id, [{ id: 'u', role: 'user', text: 'tell me about the Elite Polo in navy', createdAt: new Date().toISOString() }]);
    const { changes, result } = await ask('remove it', { lineId: 'jacket-m', quantity: 0 });
    expect(changes.some((change) => change.lineKey === 'jacket-m')).toBe(false);
    if (!changes.length) expect(result.speech).toMatch(/which/i);
  });

  it('a generic variant title (Default Title) on socks: "remove the socks" is the socks line', async () => {
    await basket([polM, socks]);
    const { changes } = await ask('remove the socks', { lineId: 'polo-m', quantity: 0 });
    expect(changes).toMatchObject([{ type: 'change', lineKey: 'socks', quantity: 0 }]);
  });

  it('a pack piece: asked first, then its whole pack comes out on their yes, nothing else (V1 task 3)', async () => {
    const piece = { ...polM, lineId: 'pack-polo', bundle: 'b1' };
    const piece2 = { ...jacM, lineId: 'pack-jacket', bundle: 'b1' };
    await basket([piece, piece2, { ...polM, lineId: 'loose-polo' }]);
    const asked = await ask('remove the jacket', { lineId: 'loose-polo', quantity: 0 });
    expect(asked.changes).toEqual([]);
    expect(asked.result.speech).toMatch(/whole pack out/);
    const { changes } = await ask('yes', { lineId: 'loose-polo', quantity: 0 });
    expect(changes.map((change) => change.lineKey).sort()).toEqual(['pack-jacket', 'pack-polo']);
  });
});

describe('certification: "make it two" sent to add_to_cart', () => {
  it('changes the line to two - the model\'s add is read as the quantity change the customer asked for', async () => {
    await basket([polM], POLO.id);
    await readCustomerTurn(id, 'Make it two.');
    const result = await runTool('add_to_cart', { productId: POLO.id, options: { Size: 'M' }, quantity: 2, replaces: 'polo-m' }, { session: await sessions.getOrCreate(id), utterance: 'Make it two.' });
    expect(result.actions).toMatchObject([{ type: 'change', lineKey: 'polo-m', quantity: 2 }]);
  });

  it('"add another one" is not turned into a line change', async () => {
    // As it happens: they added the polo in M, then ask for another.
    await basket([polM], POLO.id);
    await sessions.append(id, [{ id: 'u0', role: 'user', text: 'Add the Elite Polo in navy in M', createdAt: new Date().toISOString() }]);
    await readCustomerTurn(id, 'Add another one.');
    const result = await runTool('add_to_cart', { productId: POLO.id, options: { Size: 'M' } }, { session: await sessions.getOrCreate(id), utterance: 'Add another one.' });
    // Still an add, decided by the add path (its own target rules) - never turned into a line change.
    expect((result.actions ?? []).some((a) => a.type === 'change')).toBe(false);
    expect(result.speech).not.toMatch(/which item in your basket/i);
  });

  it('"make it two" with two different lines and nothing to tell them apart: asked, never guessed', async () => {
    await basket([polM, jacM]);
    await readCustomerTurn(id, 'Make it two.');
    const result = await runTool('add_to_cart', { productId: JACKET.id, options: { Size: 'M' }, quantity: 2 }, { session: await sessions.getOrCreate(id), utterance: 'Make it two.' });
    expect(result.actions ?? []).toEqual([]);
    expect(result.speech).toMatch(/which/i);
  });
});

describe('certification: "remove one" of two', () => {
  it('takes one off, not the line', async () => {
    await basket([{ ...jacL, quantity: 2 }], JACKET.id);
    const { changes } = await ask('Remove one.', { lineId: 'jacket-l', quantity: 1 });
    expect(changes).toMatchObject([{ type: 'change', lineKey: 'jacket-l', quantity: 1 }]);
  });
  it('"remove the jacket" still takes the line out', async () => {
    await basket([{ ...jacL, quantity: 2 }], JACKET.id);
    const { changes } = await ask('Remove the jacket.', { lineId: 'jacket-l', quantity: 0 });
    expect(changes).toMatchObject([{ type: 'change', lineKey: 'jacket-l', quantity: 0 }]);
  });
  it('"remove one" of one takes it out', async () => {
    await basket([jacL], JACKET.id);
    const { changes } = await ask('Remove one.', { lineId: 'jacket-l', quantity: 0 });
    expect(changes).toMatchObject([{ type: 'change', lineKey: 'jacket-l', quantity: 0 }]);
  });
});
