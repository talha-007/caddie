import express from 'express';
const { ownerHeaders } = await import('../support/ownership.js');
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CartAction, CartOutcomeReport, Product } from '@caddie/shared';

/**
 * One product journey, proved against the cart rather than the reply
 * (audit findings B2, E1): a change handed to the widget is not made until
 * the cart's read-back bears it out; a size change replaces the line, once,
 * with its quantity; and a report is judged by the change asked for - a
 * repeat is answered the same way, another session's is refused.
 */

const { setCatalogueForTests } = await import('../../src/catalog/sync.js');
const { setDealsForTests } = await import('../../src/catalog/bundles.js');
const { resetLimits } = await import('../../src/lib/rateLimit.js');
const { sessionRouter } = await import('../../src/routes/session.js');
const { sessions } = await import('../../src/session/store.js');
const { runTool } = await import('../../src/tools/index.js');
const { executeCommerceAction } = await import('../../src/tools/actionGateway.js');
const { settleOutcome, judge, OUTCOME_TIMEOUT_MS } = await import('../../src/tools/cartOperations.js');
const { notePendingOffer, alignReplyWithPending, resolvePending } = await import('../../src/tools/pending.js');
const { sizeChangeAsked, quantityInWords } = await import('../../src/tools/cartAuthorization.js');
const { rememberShopper } = await import('../../src/shopper/remember.js');
const { trustedShopperFacts } = await import('../../src/shopper/facts.js');
const { env } = await import('../../src/env.js');
const { CART_OPS_CONTRACT } = await import('@caddie/shared');

const BRAND = [env.shopify.brandTag].filter(Boolean) as string[];
function product(id: string, title: string, type: string, sizes: string[], price: number, soldOut: string[] = []): Product {
  return {
    id: `gid://shopify/Product/${id}`,
    title,
    url: `https://store/products/${id}`,
    imageUrl: null,
    vendor: 'Druids',
    productType: type,
    tags: BRAND,
    price: { amount: price, currency: 'GBP' },
    options: [{ name: 'Size', values: sizes }],
    variants: sizes.map((value, i) => ({ id: `gid://shopify/ProductVariant/${id}${i}`, title: value, available: !soldOut.includes(value), price: { amount: price, currency: 'GBP' }, options: { Size: value } })),
    description: 'Breathable.',
  };
}
const POLO = product('61', 'ELITE POLO - NAVY', 'POLOS', ['S', 'M', 'L', 'XL'], 20); // variants 610 S, 611 M, 612 L, 613 XL
const POLO_NO_L = product('64', 'CLUB POLO - WHITE', 'POLOS', ['S', 'M', 'L'], 20, ['L']); // 642 L sold out
const JACKET = product('63', 'STORM JACKET - BLACK', 'JACKETS', ['S', 'M', 'L'], 60);
const TROUSERS: Product = { ...product('65', 'TECH TROUSERS - NAVY', 'TROUSERS', ['30', '32', '34'], 40), options: [{ name: 'Waist', values: ['30', '32', '34'] }], variants: ['30', '32', '34'].map((w, i) => ({ id: `gid://shopify/ProductVariant/65${i}`, title: w, available: true, price: { amount: 40, currency: 'GBP' }, options: { Waist: w } })) };
const ALL = [POLO, POLO_NO_L, JACKET, TROUSERS];

let base = '';
let server: ReturnType<ReturnType<typeof express>['listen']>;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/session', sessionRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

let id = '';
beforeEach(async () => {
  setCatalogueForTests(ALL);
  setDealsForTests([]);
  resetLimits();
  id = `ops-${Math.random()}`;
  await sessions.getOrCreate(id);
  await sessions.patch(id, { cartMode: 'theme', widgetContract: CART_OPS_CONTRACT });
});

type Line = { key: string; productId: string; variantId: string; quantity: number; bundle?: string };
const line = (key: string, p: Product, variant: string, quantity = 1, bundle?: string): Line => ({ key, productId: p.id, variantId: `gid://shopify/ProductVariant/${variant}`, quantity, ...(bundle ? { bundle } : {}) });
const sync = (lines: Line[]) => ({ lines: lines.map((l) => ({ ...l, title: '', variantTitle: '' })) });
async function basket(lines: Line[]) {
  await fetch(`${base}/api/session/${id}/basket`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-caddie-cart': 'theme', 'x-caddie-widget': CART_OPS_CONTRACT, ...(await ownerHeaders(id)) }, body: JSON.stringify(sync(lines)) });
}
async function talk(text: string) {
  await sessions.append(id, [{ id: `u-${Math.random()}`, role: 'user', text, createdAt: new Date().toISOString() }]);
}
async function report(body: Partial<CartOutcomeReport> & { operationId: string }, session = id) {
  const res = await fetch(`${base}/api/session/${session}/cart-outcome`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-caddie-cart': 'theme', 'x-caddie-widget': CART_OPS_CONTRACT, ...(await ownerHeaders(session)) }, body: JSON.stringify({ status: 'applied', before: null, after: null, evidence: 'ajax-cart-read', ...body }) });
  return { status: res.status, body: (await res.json()) as { status: string; text?: string; recheck?: boolean } };
}
const pending = async () => (await sessions.getOrCreate(id)).pendingAction;
const addAction = (actions: CartAction[] | undefined) => actions?.find((action): action is Extract<CartAction, { type: 'add' }> => action.type === 'add');

describe('handed over is not made', () => {
  it('a chat add is dispatched: stamped actions, the authorisation held, nothing recorded as added', async () => {
    await talk('Add the Elite Polo in navy in M please');
    const out = await executeCommerceAction({ session: await sessions.getOrCreate(id), utterance: 'Add the Elite Polo in navy in M please' }, { type: 'add-product', productId: POLO.id, options: { Size: 'M' } });
    expect(out.ok).toBe(true);
    expect(out.dispatched).toBe(true);
    expect(out.speech).toBe('Updating your basket…');
    const add = addAction(out.actions)!;
    expect(add.operationId).toBe(out.operationId);
    expect(add.expect).toEqual({ add: [{ variantId: '611', quantity: 1 }] });
    const session = await sessions.getOrCreate(id);
    expect(session.lastAdded).toBeUndefined();
    expect(session.pendingAction).toMatchObject({ type: 'add-product', awaiting: 'outcome', authorized: true, dispatched: out.operationId });
    expect(session.cartOperations?.[out.operationId!]).toMatchObject({ status: 'dispatched', variantId: '611', quantity: 1, before: {} });
  });

  it('a second yes while it is in flight sends nothing again', async () => {
    await talk('Add the Elite Polo in M');
    const first = await executeCommerceAction({ session: await sessions.getOrCreate(id), utterance: 'Add the Elite Polo in M' }, { type: 'add-product', productId: POLO.id, options: { Size: 'M' } });
    expect(first.dispatched).toBe(true);
    await talk('yes');
    const again = await resolvePending(id, 'yes');
    expect(again.status).toBe('asked');
    expect(again.result?.speech).toMatch(/still updating your basket/i);
    const direct = await executeCommerceAction({ session: await sessions.getOrCreate(id), utterance: 'yes add it' }, { type: 'add-product', productId: POLO.id, options: { Size: 'M' } });
    expect(direct.ok).toBe(false);
    expect(direct.reason).toBe('not-ready');
    expect((await sessions.getOrCreate(id)).pendingAction?.dispatched).toBe(first.operationId);
  });

  it('the cart bears it out: applied once, the authorisation consumed, "Added the navy Elite Polo in M."', async () => {
    await talk('Add the Elite Polo in M');
    const out = await executeCommerceAction({ session: await sessions.getOrCreate(id), utterance: 'Add the Elite Polo in M' }, { type: 'add-product', productId: POLO.id, options: { Size: 'M' } });
    const first = await report({ operationId: out.operationId!, before: sync([]), after: sync([line('k1', POLO, '611')]) });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ status: 'applied', text: 'Added the navy Elite Polo in M.' });
    const session = await sessions.getOrCreate(id);
    expect(session.pendingAction).toBeUndefined();
    expect(session.lastAdded).toMatchObject({ productId: POLO.id, byOperation: true });
    expect(session.basket).toEqual([expect.objectContaining({ lineId: 'k1', productId: POLO.id, variantId: '611', quantity: 1 })]);
    expect(session.messages.at(-1)).toMatchObject({ role: 'assistant', text: 'Added the navy Elite Polo in M.' });
    // The same report again: the same answer, nothing done twice.
    const again = await report({ operationId: out.operationId!, before: sync([]), after: sync([line('k1', POLO, '611')]) });
    expect(again.body).toEqual({ status: 'duplicate', text: 'Added the navy Elite Polo in M.' });
    expect((await sessions.getOrCreate(id)).messages.filter((m) => m.text === 'Added the navy Elite Polo in M.')).toHaveLength(1);
  });

  it('6. the variant was already in the basket: only the delta proves the add', async () => {
    await basket([line('k0', POLO, '611', 1)]);
    await talk('Add another Elite Polo in M');
    const out = await executeCommerceAction({ session: await sessions.getOrCreate(id), utterance: 'Add the Elite Polo in M' }, { type: 'add-product', productId: POLO.id, options: { Size: 'M' } });
    expect(judge((await sessions.getOrCreate(id)).cartOperations![out.operationId!]!, { status: 'applied', before: sync([line('k0', POLO, '611', 1)]), after: sync([line('k0', POLO, '611', 1)]) })).toBe('uncertain');
    const claimed = await report({ operationId: out.operationId!, status: 'applied', before: sync([line('k0', POLO, '611', 1)]), after: sync([line('k0', POLO, '611', 1)]) });
    expect(claimed.body).toMatchObject({ status: 'uncertain', recheck: true });
    expect((await sessions.getOrCreate(id)).pendingAction?.dispatched).toBe(out.operationId);
    // A later read shows the rise: applied, once.
    const later = await report({ operationId: out.operationId!, status: 'uncertain', before: sync([line('k0', POLO, '611', 1)]), after: sync([line('k0', POLO, '611', 2)]) });
    expect(later.body).toEqual({ status: 'applied', text: 'Added the navy Elite Polo in M.' });
  });

  it('2. the cart refuses and nothing changed: no success claim, the failure said', async () => {
    await talk('Add the Club Polo in L');
    const out = await executeCommerceAction({ session: await sessions.getOrCreate(id), utterance: 'Add the Club Polo in M' }, { type: 'add-product', productId: POLO_NO_L.id, options: { Size: 'M' } });
    const res = await report({ operationId: out.operationId!, status: 'failed', before: sync([]), after: sync([]), error: "The product 'CLUB POLO - WHITE' is already sold out." });
    expect(res.body).toEqual({ status: 'failed', text: 'That size is unavailable.' });
    const session = await sessions.getOrCreate(id);
    expect(session.lastAdded).toBeUndefined();
    expect(session.pendingAction).toBeUndefined();
  });

  it('4. the cart could not be read: uncertain, and nothing retried', async () => {
    await talk('Add the Elite Polo in M');
    const out = await executeCommerceAction({ session: await sessions.getOrCreate(id), utterance: 'Add the Elite Polo in M' }, { type: 'add-product', productId: POLO.id, options: { Size: 'M' } });
    const res = await report({ operationId: out.operationId!, status: 'uncertain', before: sync([]), after: null });
    expect(res.body).toEqual({ status: 'uncertain', text: "I couldn't confirm the update yet. I'm checking your basket.", recheck: true });
    expect((await sessions.getOrCreate(id)).cartOperations?.[out.operationId!]?.status).toBe('uncertain');
  });

  it('16. a report for another session, or an operation never made, is refused', async () => {
    await talk('Add the Elite Polo in M');
    const out = await executeCommerceAction({ session: await sessions.getOrCreate(id), utterance: 'Add the Elite Polo in M' }, { type: 'add-product', productId: POLO.id, options: { Size: 'M' } });
    const other = `ops-other-${Math.random()}`;
    await sessions.getOrCreate(other);
    const wrong = await report({ operationId: out.operationId!, before: sync([]), after: sync([line('k1', POLO, '611')]) }, other);
    expect(wrong.status).toBe(404);
    expect(wrong.body.status).toBe('unknown');
    expect((await sessions.getOrCreate(id)).cartOperations?.[out.operationId!]?.status).toBe('dispatched');
    const never = await report({ operationId: 'op-made-up', before: sync([]), after: sync([]) });
    expect(never.status).toBe(404);
  });

  it('a dispatched change nobody reports on is uncertain after the deadline, and still holds the basket until settled', async () => {
    await talk('Add the Elite Polo in M');
    const out = await executeCommerceAction({ session: await sessions.getOrCreate(id), utterance: 'Add the Elite Polo in M' }, { type: 'add-product', productId: POLO.id, options: { Size: 'M' } });
    const session = await sessions.getOrCreate(id);
    await sessions.patch(id, { cartOperations: { ...session.cartOperations, [out.operationId!]: { ...session.cartOperations![out.operationId!]!, createdAt: Date.now() - OUTCOME_TIMEOUT_MS - 1 } } });
    await talk('Add the Storm Jacket in M');
    // Past the deadline the operation is uncertain, not forgotten: another Caddie change waits until a report settles it.
    const next = await executeCommerceAction({ session: await sessions.getOrCreate(id), utterance: 'Add the Storm Jacket in M' }, { type: 'add-product', productId: JACKET.id, options: { Size: 'M' } });
    expect(next.ok).toBe(false);
    expect(next.reason).toBe('not-ready');
    expect((await sessions.getOrCreate(id)).cartOperations?.[out.operationId!]?.status).toBe('uncertain');
    // A read after the deadline showing the change settles it, and the next change goes.
    await report({ operationId: out.operationId!, status: 'uncertain', before: null, after: sync([line('k1', POLO, '611')]) });
    const then = await executeCommerceAction({ session: await sessions.getOrCreate(id), utterance: 'Add the Storm Jacket in M' }, { type: 'add-product', productId: JACKET.id, options: { Size: 'M' } });
    expect(then.dispatched).toBe(true);
  });

  it('7. after the add is confirmed, a cross-sell or checkout question does not reopen its size or colour', async () => {
    await talk('Add the Elite Polo in M');
    const out = await executeCommerceAction({ session: await sessions.getOrCreate(id), utterance: 'Add the Elite Polo in M' }, { type: 'add-product', productId: POLO.id, options: { Size: 'M' } });
    await report({ operationId: out.operationId!, before: sync([]), after: sync([line('k1', POLO, '611')]) });
    await sessions.patch(id, { activeShoppingContext: { kinds: ['polo'], productId: POLO.id, design: 'ELITE POLO', request: 'Add the Elite Polo in M', turn: 1, source: 'explicit', mission: 1, missionTurn: 1 } });
    for (const offer of ['Would you like to add a jacket to go with it?', 'Would you like to see anything else or proceed to checkout?', 'Shall I add another one?']) {
      await notePendingOffer(id, offer);
      expect(await pending(), offer).toBeUndefined();
      expect(await alignReplyWithPending(id, offer), offer).toBe(offer);
    }
    // A product the customer has not seen: no record, and the offer becomes an offer to show it.
    await notePendingOffer(id, 'Would you like to add the Storm Jacket to go with it?');
    expect(await pending()).toBeUndefined();
    expect(await alignReplyWithPending(id, 'Would you like to add the Storm Jacket to go with it?')).toBe('Would you like to see the Storm Jacket?');
  });
});

describe('an offer of the lead card binds to the size it names', () => {
  it('"Should I add it in size L?" with M their usual size: the record is L, so the words and the add agree', async () => {
    await rememberShopper(id, { usualSize: 'M' }, 'ui-form');
    await sessions.patch(id, { lastShown: { kind: 'products', items: [{ id: POLO.id, title: POLO.title }] }, lastLead: { id: POLO.id, colour: 'navy' }, activeShoppingContext: { kinds: ['polo'], productId: POLO.id, design: 'ELITE POLO', request: 'Show me the Elite Polo', turn: 1, source: 'explicit', mission: 1, missionTurn: 1 } });
    await talk('Change that polo to L.');
    const reply = await alignReplyWithPending(id, 'I can get the Elite Polo in navy in size L. Should I add it to your basket?');
    expect(reply).toBe('I can get the Elite Polo in navy in size L. Should I add it to your basket?');
    expect(await pending()).toMatchObject({ type: 'add-product', productIds: [POLO.id], options: { Size: 'L' }, awaiting: 'confirmation' });
  });
});

describe('7. "change that polo to L" replaces the line', () => {
  it('reads a size change, never a quantity', () => {
    expect(sizeChangeAsked('Change that polo to L.')).toEqual({ size: 'L' });
    expect(sizeChangeAsked('Actually make it a large')).toEqual({ size: 'L' });
    expect(sizeChangeAsked('Change its size to 34')).toEqual({ size: '34' });
    expect(sizeChangeAsked('Make it two')).toBeNull();
    expect(sizeChangeAsked('Change it to 2 of them')).toBeNull();
    expect(quantityInWords('Change its size to 34')).toBeNull();
  });

  it('8. M x2 -> L: the L goes in with the quantity, the M goes out, the old line named', async () => {
    await basket([line('k1', POLO, '611', 2), line('k2', JACKET, '631', 1)]);
    await talk('Change that polo to L.');
    const result = await runTool('add_to_cart', { productId: POLO.id, options: { Size: 'L' } }, { session: await sessions.getOrCreate(id), utterance: 'Change that polo to L.' });
    expect(result.outcome).toMatchObject({ ok: true, dispatched: true });
    const add = addAction(result.actions)!;
    expect(add.lines).toEqual([{ variantId: '612', quantity: 2 }]);
    expect(add.removeKeys).toEqual(['k1']);
    expect(add.expect).toEqual({ add: [{ variantId: '612', quantity: 2 }], remove: [{ key: 'k1', variantId: '611', quantity: 2 }] });
    const record = (await sessions.getOrCreate(id)).cartOperations![add.operationId!]!;
    expect(record.outgoing).toMatchObject({ lineId: 'k1', variantId: '611', quantity: 2, choice: 'M' });
    // Confirmed only when the read-back shows L in and M out, the jacket untouched.
    const done = await report({ operationId: add.operationId!, before: sync([line('k1', POLO, '611', 2), line('k2', JACKET, '631', 1)]), after: sync([line('k3', POLO, '612', 2), line('k2', JACKET, '631', 1)]) });
    expect(done.body).toEqual({ status: 'applied', text: 'Done - the navy Elite Polo is now in L.' });
    expect(trustedShopperFacts(await sessions.getOrCreate(id)).usualSize).toBeUndefined();
  });

  it('the same words through update_cart_item take the same path', async () => {
    await basket([line('k1', POLO, '611', 1)]);
    await talk('change the polo to a large');
    const result = await runTool('update_cart_item', { lineId: 'k1', quantity: 1 }, { session: await sessions.getOrCreate(id), utterance: 'change the polo to a large' });
    expect(addAction(result.actions)?.lines).toEqual([{ variantId: '612', quantity: 1 }]);
  });

  it('9. L unavailable: refused before anything is sent, the M untouched', async () => {
    await basket([line('k1', POLO_NO_L, '641', 1)]);
    await talk('Change that polo to L.');
    const result = await runTool('add_to_cart', { productId: POLO_NO_L.id, options: { Size: 'L' } }, { session: await sessions.getOrCreate(id), utterance: 'Change that polo to L.' });
    expect(result.outcome?.ok).toBe(false);
    expect(result.actions).toBeUndefined();
    expect(result.speech).toMatch(/sold out|unavailable|not in stock|out of stock/i);
    expect((await sessions.getOrCreate(id)).basket?.[0]?.lineId).toBe('k1');
  });

  it('9b. the cart refuses the L: "That size is unavailable. Your original navy Elite Polo in M is still in the basket."', async () => {
    await basket([line('k1', POLO, '611', 1)]);
    await talk('Change that polo to L.');
    const result = await runTool('add_to_cart', { productId: POLO.id, options: { Size: 'L' } }, { session: await sessions.getOrCreate(id), utterance: 'Change that polo to L.' });
    const add = addAction(result.actions)!;
    const res = await report({ operationId: add.operationId!, status: 'failed', before: sync([line('k1', POLO, '611', 1)]), after: sync([line('k1', POLO, '611', 1)]), error: 'The product is already sold out.' });
    expect(res.body).toEqual({ status: 'failed', text: 'That size is unavailable. Your original navy Elite Polo in M is still in the basket.' });
  });

  it('10. L already in the basket: its quantity rises by the M line\'s, the pre-existing quantity kept', async () => {
    await basket([line('k1', POLO, '611', 1), line('k2', POLO, '612', 1)]);
    await talk('Change the M polo to L.');
    const result = await runTool('add_to_cart', { productId: POLO.id, options: { Size: 'L' } }, { session: await sessions.getOrCreate(id), utterance: 'Change the M polo to L.' });
    const add = addAction(result.actions)!;
    expect(add.removeKeys).toEqual(['k1']);
    const done = await report({ operationId: add.operationId!, before: sync([line('k1', POLO, '611', 1), line('k2', POLO, '612', 1)]), after: sync([line('k2', POLO, '612', 2)]) });
    expect(done.body.status).toBe('applied');
  });

  it('11. two polos in the basket and "that polo": asked which, nothing sent', async () => {
    await basket([line('k1', POLO, '611', 1), line('k2', POLO_NO_L, '641', 1)]);
    await talk('Change that polo to S.');
    const result = await runTool('add_to_cart', { productId: POLO.id, options: { Size: 'S' } }, { session: await sessions.getOrCreate(id), utterance: 'Change that polo to S.' });
    expect(result.actions).toBeUndefined();
    expect(result.speech).toMatch(/which one do you mean - the Elite Polo - Navy in M or the Club Polo - White in M\?/i);
  });

  it('13. the L went in but the M did not come out: no "done", the M offered for removal, nothing else touched', async () => {
    await basket([line('k1', POLO, '611', 1), line('k2', JACKET, '631', 1)]);
    await talk('Change that polo to L.');
    const result = await runTool('add_to_cart', { productId: POLO.id, options: { Size: 'L' } }, { session: await sessions.getOrCreate(id), utterance: 'Change that polo to L.' });
    const add = addAction(result.actions)!;
    const res = await report({ operationId: add.operationId!, status: 'partial', before: sync([line('k1', POLO, '611', 1), line('k2', JACKET, '631', 1)]), after: sync([line('k9', POLO, '612', 1), line('k1', POLO, '611', 1), line('k2', JACKET, '631', 1)]), error: 'Cart line not found' });
    expect(res.body.status).toBe('partial');
    expect(res.body.text).toBe("The navy Elite Polo in L is in your basket, but I couldn't take out the M - both are there for now. Shall I remove the M?");
    expect(await pending()).toMatchObject({ type: 'update-line', lineId: 'k1', quantity: 0, awaiting: 'confirmation', authorized: false });
    expect((await sessions.getOrCreate(id)).basket?.map((l) => l.lineId).sort()).toEqual(['k1', 'k2', 'k9']);
  });

  it('a pack piece is not changed on its own', async () => {
    await basket([line('k1', POLO, '611', 1, 'b1'), line('k2', JACKET, '631', 1, 'b1')]);
    await talk('Change that polo to L.');
    const result = await runTool('add_to_cart', { productId: POLO.id, options: { Size: 'L' } }, { session: await sessions.getOrCreate(id), utterance: 'Change that polo to L.' });
    expect(result.actions).toBeUndefined();
    expect(result.speech).toMatch(/part of your pack, so I can't change its size on its own/);
  });

  it('17. their usual size changes nothing in the basket', async () => {
    await basket([line('k1', POLO, '611', 1)]);
    await rememberShopper(id, { usualSize: 'L' }, 'customer-words');
    await talk("I'm usually a large.");
    const out = await executeCommerceAction({ session: await sessions.getOrCreate(id), utterance: "I'm usually a large." }, { type: 'update-line', lineId: 'k1', quantity: 1 });
    expect(out.ok).toBe(false);
    expect((await sessions.getOrCreate(id)).basket).toEqual([expect.objectContaining({ lineId: 'k1', variantId: '611', quantity: 1 })]);
  });
});
