import express from 'express';
const { ownerHeaders } = await import('../support/ownership.js');
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CartAction, CartOutcomeReport, Product } from '@caddie/shared';

/**
 * Acceptance of the single-product basket journey: what the deadline does
 * and does not do, how a report is bound to the operation, the cart and the
 * line, and which widget may be handed a change at all.
 */

const { setCatalogueForTests } = await import('../../src/catalog/sync.js');
const { setDealsForTests } = await import('../../src/catalog/bundles.js');
const { resetLimits } = await import('../../src/lib/rateLimit.js');
const { sessionRouter } = await import('../../src/routes/session.js');
const { sessions } = await import('../../src/session/store.js');
const { executeCommerceAction } = await import('../../src/tools/actionGateway.js');
const { judge, lineFingerprint, settleOutcome, OUTCOME_TIMEOUT_MS, UNCERTAIN_HELD } = await import('../../src/tools/cartOperations.js');
const { resolvePending } = await import('../../src/tools/pending.js');
const { env } = await import('../../src/env.js');
const { CART_OPS_CONTRACT } = await import('@caddie/shared');

const BRAND = [env.shopify.brandTag].filter(Boolean) as string[];
function product(id: string, title: string, sizes: string[]): Product {
  return {
    id: `gid://shopify/Product/${id}`,
    title,
    url: '',
    imageUrl: null,
    vendor: 'Druids',
    productType: 'POLOS',
    tags: BRAND,
    price: { amount: 20, currency: 'GBP' },
    options: [{ name: 'Size', values: sizes }],
    variants: sizes.map((value, i) => ({ id: `gid://shopify/ProductVariant/${id}${i}`, title: value, available: true, price: { amount: 20, currency: 'GBP' }, options: { Size: value } })),
    description: null,
  };
}
const POLO = product('61', 'ELITE POLO - NAVY', ['S', 'M', 'L']); // 610 S, 611 M, 612 L
const JACKET = { ...product('63', 'STORM JACKET - BLACK', ['S', 'M', 'L']), productType: 'JACKETS' };

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
  setCatalogueForTests([POLO, JACKET]);
  setDealsForTests([]);
  resetLimits();
  id = `acc-${Math.random()}`;
  await sessions.getOrCreate(id);
  await sessions.patch(id, { cartMode: 'theme', widgetContract: CART_OPS_CONTRACT });
});

type Line = { key: string; productId: string; variantId: string; quantity: number; properties?: Record<string, string>; sellingPlanId?: string };
const line = (key: string, p: Product, variant: string, quantity = 1, extra: Partial<Line> = {}): Line => ({ key, productId: p.id, variantId: `gid://shopify/ProductVariant/${variant}`, quantity, ...extra });
const sync = (lines: Line[], cartToken = 'cart-A') => ({ cartToken, lines: lines.map((l) => ({ ...l, title: '', variantTitle: '' })) });
async function talk(text: string) {
  await sessions.append(id, [{ id: `u-${Math.random()}`, role: 'user', text, createdAt: new Date().toISOString() }]);
}
async function basket(lines: Line[], cartToken = 'cart-A') {
  await fetch(`${base}/api/session/${id}/basket`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-caddie-cart': 'theme', 'x-caddie-widget': CART_OPS_CONTRACT, ...(await ownerHeaders(id)) }, body: JSON.stringify(sync(lines, cartToken)) });
}
async function report(body: Partial<CartOutcomeReport> & { operationId: string }) {
  const res = await fetch(`${base}/api/session/${id}/cart-outcome`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-caddie-cart': 'theme', 'x-caddie-widget': CART_OPS_CONTRACT, ...(await ownerHeaders(id)) }, body: JSON.stringify({ status: 'applied', before: null, after: null, evidence: 'ajax-cart-read', ...body }) });
  return (await res.json()) as { status: string; text?: string; recheck?: boolean };
}
async function addM(utterance = 'Add the Elite Polo in M') {
  await talk(utterance);
  return executeCommerceAction({ session: await sessions.getOrCreate(id), utterance }, { type: 'add-product', productId: POLO.id, options: { Size: 'M' } });
}
const addAction = (actions: CartAction[] | undefined) => actions?.find((action): action is Extract<CartAction, { type: 'add' }> => action.type === 'add');
async function age(operationId: string, ms: number) {
  const session = await sessions.getOrCreate(id);
  await sessions.patch(id, { cartOperations: { ...session.cartOperations, [operationId]: { ...session.cartOperations![operationId]!, createdAt: Date.now() - ms } } });
}
const record = async (operationId: string) => (await sessions.getOrCreate(id)).cartOperations?.[operationId];

describe('1. uncertainty and the deadline', () => {
  it('past the deadline: uncertain, not failed; the same change again is held, not sent; the late outcome completes it once', async () => {
    const first = await addM();
    expect(first.dispatched).toBe(true);
    await age(first.operationId!, OUTCOME_TIMEOUT_MS + 1);
    // The shopper tries the same change again.
    const again = await addM('Add the Elite Polo in M please');
    expect(again.ok).toBe(false);
    expect(again.reason).toBe('not-ready');
    expect(again.speech).toBe(UNCERTAIN_HELD);
    expect((await record(first.operationId!))?.status).toBe('uncertain');
    // Its expected result is kept, and its authorisation with it.
    expect((await record(first.operationId!))?.expect).toEqual({ add: [{ variantId: '611', quantity: 1 }] });
    expect((await sessions.getOrCreate(id)).pendingAction?.dispatched).toBe(first.operationId);
    await talk('yes');
    expect((await resolvePending(id, 'yes')).result?.speech).toBe(UNCERTAIN_HELD);
    // The original completes late: applied once, one confirmation, one line.
    const done = await report({ operationId: first.operationId!, before: sync([]), after: sync([line('k1', POLO, '611')]) });
    expect(done).toEqual({ status: 'applied', text: 'Added the navy Elite Polo in M.' });
    const session = await sessions.getOrCreate(id);
    expect(session.pendingAction).toBeUndefined();
    expect(Object.values(session.cartOperations ?? {}).filter((op) => op.kind === 'add-product')).toHaveLength(1);
    expect(session.messages.filter((m) => m.text === 'Added the navy Elite Polo in M.')).toHaveLength(1);
  });

  it('uncertain report, duplicate uncertain report, then fresh evidence: applied once, one confirmation', async () => {
    const first = await addM();
    const one = await report({ operationId: first.operationId!, status: 'uncertain', before: sync([]), after: null });
    expect(one).toMatchObject({ status: 'uncertain', recheck: true });
    const two = await report({ operationId: first.operationId!, status: 'uncertain', before: sync([]), after: null });
    expect(two).toMatchObject({ status: 'uncertain' });
    const three = await report({ operationId: first.operationId!, status: 'uncertain', before: null, after: sync([line('k1', POLO, '611')]) });
    expect(three).toEqual({ status: 'applied', text: 'Added the navy Elite Polo in M.' });
    const four = await report({ operationId: first.operationId!, status: 'uncertain', before: null, after: sync([line('k1', POLO, '611')]) });
    expect(four).toEqual({ status: 'duplicate', text: 'Added the navy Elite Polo in M.' });
    expect((await sessions.getOrCreate(id)).messages.filter((m) => m.text === 'Added the navy Elite Polo in M.')).toHaveLength(1);
  });

  it('a read after the deadline that still shows no change is not evidence of failure: uncertain, held, recoverable', async () => {
    const first = await addM();
    await age(first.operationId!, OUTCOME_TIMEOUT_MS + 1);
    const res = await report({ operationId: first.operationId!, status: 'uncertain', before: null, after: sync([]) });
    expect(res.status).toBe('uncertain');
    expect((await sessions.getOrCreate(id)).pendingAction?.dispatched).toBe(first.operationId);
    const next = await addM('Add the Elite Polo in M');
    expect(next.ok).toBe(false);
    expect(next.reason).toBe('not-ready');
    // Only the store's own refusal settles it as failed.
    const refused = await report({ operationId: first.operationId!, status: 'failed', failure: 'rejected', before: sync([]), after: sync([]), error: 'sold out' });
    expect(refused.status).toBe('failed');
    expect((await addM('Add the Elite Polo in M')).dispatched).toBe(true);
  });

  it('a late result clears only its own pending state, never a newer action\'s', async () => {
    const first = await addM();
    await report({ operationId: first.operationId!, status: 'failed', before: sync([]), after: sync([]), error: 'sold out' });
    // A newer action, waiting on a size.
    await talk('Add the Storm Jacket');
    const asked = await executeCommerceAction({ session: await sessions.getOrCreate(id), utterance: 'Add the Storm Jacket' }, { type: 'add-product', productId: JACKET.id });
    expect(asked.ok).toBe(false);
    expect((await sessions.getOrCreate(id)).pendingAction).toMatchObject({ type: 'add-product', productIds: [JACKET.id], awaiting: 'size' });
    // The old operation's report arrives again, late.
    await report({ operationId: first.operationId!, before: sync([]), after: sync([line('k1', POLO, '611')]) });
    expect((await sessions.getOrCreate(id)).pendingAction).toMatchObject({ type: 'add-product', productIds: [JACKET.id], awaiting: 'size' });
  });
});

describe('2. cart and line reconciliation', () => {
  const opRecord = (expect_: { add?: Array<{ variantId: string; quantity: number }>; remove?: Array<{ key: string; variantId: string; quantity: number }> }, extra: Record<string, unknown> = {}) =>
    ({ id: 'op-x', kind: 'add-product' as const, status: 'dispatched' as const, quantity: 1, expect: expect_, before: {}, onApplied: {}, wording: { title: 'navy Elite Polo', choice: 'M', quantity: 1 }, source: 'test', turn: 1, createdAt: Date.now(), ...extra });

  it('A. same variant, different properties: the intended line, not the total', () => {
    const gift = line('k1', POLO, '611', 1, { properties: { _gift: 'yes' } });
    const plain = line('k2', POLO, '611', 1);
    const rec = opRecord({ add: [{ variantId: '612', quantity: 1 }], remove: [{ key: 'k2', variantId: '611', quantity: 1 }] }, { outgoing: { lineId: 'k2', variantId: '611', quantity: 1, title: 'ELITE POLO - NAVY', choice: 'M', fingerprint: lineFingerprint(plain) } });
    // The wrong line went: the gift line gone, the plain one still there. The total fell by one, but not the intended line.
    expect(judge(rec, { status: 'applied', before: sync([gift, plain]), after: sync([line('k3', POLO, '612'), plain]) })).toBe('partial');
    // The right line went.
    expect(judge(rec, { status: 'applied', before: sync([gift, plain]), after: sync([line('k3', POLO, '612'), gift]) })).toBe('applied');
  });

  it('B. the replacement variant already present keeps its quantity, and only the asked rise counts', () => {
    const rec = opRecord({ add: [{ variantId: '612', quantity: 1 }], remove: [{ key: 'k1', variantId: '611', quantity: 1 }] });
    expect(judge(rec, { status: 'applied', before: sync([line('k1', POLO, '611', 1), line('k2', POLO, '612', 3)]), after: sync([line('k2', POLO, '612', 4)]) })).toBe('applied');
    // The L line did not rise: the add did not land, whatever the widget said.
    expect(judge(rec, { status: 'applied', before: sync([line('k1', POLO, '611', 1), line('k2', POLO, '612', 3)]), after: sync([line('k2', POLO, '612', 3)]) })).toBe('partial');
  });

  it('C. a partial add: the actual partial result, not success and not nothing', async () => {
    const rec = opRecord({ add: [{ variantId: '611', quantity: 1 }, { variantId: '631', quantity: 1 }] });
    expect(judge(rec, { status: 'applied', before: sync([]), after: sync([line('k1', POLO, '611')]) })).toBe('partial');
    expect(judge(rec, { status: 'applied', before: sync([]), after: sync([line('k1', POLO, '611'), line('k2', JACKET, '631')]) })).toBe('applied');
    expect(judge(rec, { status: 'failed', before: sync([]), after: sync([]) })).toBe('failed');
  });

  it('D. a delayed report from an older operation does not overwrite newer state', async () => {
    const first = await addM();
    const settled = await report({ operationId: first.operationId!, before: sync([]), after: sync([line('k1', POLO, '611')]) });
    expect(settled.status).toBe('applied');
    await talk('Add the Storm Jacket in M');
    const second = await executeCommerceAction({ session: await sessions.getOrCreate(id), utterance: 'Add the Storm Jacket in M' }, { type: 'add-product', productId: JACKET.id, options: { Size: 'M' } });
    await report({ operationId: second.operationId!, before: sync([line('k1', POLO, '611')]), after: sync([line('k1', POLO, '611'), line('k2', JACKET, '631')]) });
    // The first operation's report, delayed and repeated: a duplicate, and the basket stays as the newer one left it.
    const late = await report({ operationId: first.operationId!, before: sync([]), after: sync([line('k1', POLO, '611')]) });
    expect(late.status).toBe('duplicate');
    const session = await sessions.getOrCreate(id);
    expect(session.basket?.map((l) => l.lineId).sort()).toEqual(['k1', 'k2']);
    expect(session.lastAdded?.productId).toBe(JACKET.id);
  });

  it('E. the cart changed under the operation: a report about another cart settles nothing', async () => {
    await basket([], 'cart-A');
    const first = await addM();
    expect((await record(first.operationId!))?.cartToken).toBe('cart-A');
    const other = await report({ operationId: first.operationId!, before: sync([], 'cart-B'), after: sync([line('k1', POLO, '611')], 'cart-B') });
    expect(other).toMatchObject({ status: 'uncertain', recheck: true });
    expect((await sessions.getOrCreate(id)).pendingAction?.dispatched).toBe(first.operationId);
    const same = await report({ operationId: first.operationId!, before: sync([], 'cart-A'), after: sync([line('k1', POLO, '611')], 'cart-A') });
    expect(same.status).toBe('applied');
  });

  it('F. the leftover line after a partial replacement is re-found by variant and properties before a yes removes it', async () => {
    await basket([line('k1', POLO, '611', 1), line('k2', JACKET, '631', 1)]);
    await talk('Change that polo to L.');
    const { runTool } = await import('../../src/tools/index.js');
    const result = await runTool('add_to_cart', { productId: POLO.id, options: { Size: 'L' } }, { session: await sessions.getOrCreate(id), utterance: 'Change that polo to L.' });
    const add = addAction(result.actions)!;
    const partial = await report({ operationId: add.operationId!, status: 'partial', before: sync([line('k1', POLO, '611', 1), line('k2', JACKET, '631', 1)]), after: sync([line('k9', POLO, '612', 1), line('k1', POLO, '611', 1), line('k2', JACKET, '631', 1)]), error: 'Cart line not found' });
    expect(partial.status).toBe('partial');
    expect((await sessions.getOrCreate(id)).pendingAction).toMatchObject({ type: 'update-line', lineId: 'k1', variantId: '611', quantity: 0, awaiting: 'confirmation' });
    // The cart re-keys before their yes (another add from the theme): the M line is now k7.
    await basket([line('k8', POLO, '612', 1), line('k7', POLO, '611', 1), line('k6', JACKET, '631', 1)]);
    await talk('yes');
    const turn = await resolvePending(id, 'yes');
    expect(turn.status).toBe('executed');
    const change = turn.result?.actions?.find((action): action is Extract<CartAction, { type: 'change' }> => action.type === 'change');
    expect(change).toMatchObject({ lineKey: 'k7', quantity: 0 });
  });
});

describe('3. client and server compatibility', () => {
  it('a widget that cannot report (no contract header) is not handed a change, and told so', async () => {
    id = `acc-old-${Math.random()}`;
    await sessions.getOrCreate(id);
    await sessions.patch(id, { cartMode: 'theme' });
    const out = await addM();
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('unavailable');
    expect(out.speech).toMatch(/refresh the page, or use the Add button/);
    expect(out.actions).toBeUndefined();
    expect((await sessions.getOrCreate(id)).cartOperations ?? {}).toEqual({});
  });

  it('the header on any session request records the contract; the claim tells the widget the server\'s', async () => {
    await sessions.patch(id, { widgetContract: undefined });
    await basket([]);
    expect((await sessions.getOrCreate(id)).widgetContract).toBe(CART_OPS_CONTRACT);
    const claim = await fetch(`${base}/api/session/claim-${Math.random()}/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((r) => r.json() as Promise<{ contract?: string }>);
    expect(claim.contract).toBe(CART_OPS_CONTRACT);
  });

  it('the matched pair: handed over and reported', async () => {
    const out = await addM();
    expect(out.dispatched).toBe(true);
    expect((await report({ operationId: out.operationId!, before: sync([]), after: sync([line('k1', POLO, '611')]) })).status).toBe('applied');
  });
});
