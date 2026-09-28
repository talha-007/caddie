import express from 'express';
const { ownerHeaders } = await import('../support/ownership.js');
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CartAction, CartOutcomeReport, Product } from '@caddie/shared';

/**
 * Finishing the single-product basket journey: age is not evidence, every
 * basket sentence is held to the reported basket, and a failure is only
 * what the store said it was.
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
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: next.tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }),
}));

const { setCatalogueForTests } = await import('../../src/catalog/sync.js');
const { setDealsForTests } = await import('../../src/catalog/bundles.js');
const { resetLimits } = await import('../../src/lib/rateLimit.js');
const { sessionRouter } = await import('../../src/routes/session.js');
const { sessions } = await import('../../src/session/store.js');
const { converse } = await import('../../src/ai/openai.js');
const { executeCommerceAction } = await import('../../src/tools/actionGateway.js');
const { judge, OUTCOME_TIMEOUT_MS, UNCERTAIN_HELD, basketStatement } = await import('../../src/tools/cartOperations.js');
const { resolvePending } = await import('../../src/tools/pending.js');
const { verifyReply } = await import('../../src/ai/verify.js');
const { runTool } = await import('../../src/tools/index.js');
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
    description: 'Breathable.',
  };
}
const POLO = product('61', 'ELITE POLO - WHITE', ['S', 'M', 'L']); // 610 S, 611 M, 612 L
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
  replies.length = 0;
  id = `fin-${Math.random()}`;
  await sessions.getOrCreate(id);
  await sessions.patch(id, { cartMode: 'theme', widgetContract: CART_OPS_CONTRACT });
});

type Line = { key: string; productId: string; variantId: string; quantity: number };
const line = (key: string, p: Product, variant: string, quantity = 1): Line => ({ key, productId: p.id, variantId: `gid://shopify/ProductVariant/${variant}`, quantity });
const sync = (lines: Line[]) => ({ cartToken: 'cart-A', lines: lines.map((l) => ({ ...l, title: '', variantTitle: '' })) });
async function talk(text: string) {
  await sessions.append(id, [{ id: `u-${Math.random()}`, role: 'user', text, createdAt: new Date().toISOString() }]);
}
async function basket(lines: Line[]) {
  await fetch(`${base}/api/session/${id}/basket`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-caddie-cart': 'theme', 'x-caddie-widget': CART_OPS_CONTRACT, ...(await ownerHeaders(id)) }, body: JSON.stringify(sync(lines)) });
}
async function report(body: Partial<CartOutcomeReport> & { operationId: string }) {
  const res = await fetch(`${base}/api/session/${id}/cart-outcome`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-caddie-cart': 'theme', 'x-caddie-widget': CART_OPS_CONTRACT, ...(await ownerHeaders(id)) }, body: JSON.stringify({ status: 'applied', before: null, after: null, evidence: 'ajax-cart-read', ...body }) });
  return (await res.json()) as { status: string; text?: string; recheck?: boolean };
}
async function addM(utterance = 'Add the Elite Polo in M') {
  await talk(utterance);
  return executeCommerceAction({ session: await sessions.getOrCreate(id), utterance }, { type: 'add-product', productId: POLO.id, options: { Size: 'M' } });
}
const record = async (operationId: string) => (await sessions.getOrCreate(id)).cartOperations?.[operationId];

describe('1. age plus an unchanged read is not failure', () => {
  it('past the deadline, an unchanged read leaves it uncertain; a conflicting add is held; the late completion applies once', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const first = await addM();
      expect(first.dispatched).toBe(true);
      // Nothing comes back by the deadline.
      vi.setSystemTime(Date.now() + OUTCOME_TIMEOUT_MS + 1000);
      // The widget reads an unchanged basket.
      const read = await report({ operationId: first.operationId!, status: 'uncertain', before: null, after: sync([]) });
      expect(read.status).toBe('uncertain');
      expect((await record(first.operationId!))?.status).toBe('uncertain');
      // The shopper tries again: nothing is sent, and they are told how to see for themselves - not that it is being checked.
      const again = await addM('Add the Elite Polo in M please');
      expect(again.ok).toBe(false);
      expect(again.reason).toBe('not-ready');
      expect(again.speech).toBe(UNCERTAIN_HELD);
      expect(again.speech).not.toMatch(/checking/);
      await talk('yes');
      expect((await resolvePending(id, 'yes')).result?.speech).toBe(UNCERTAIN_HELD);
      // The original add lands late; the basket shows it.
      const late = await report({ operationId: first.operationId!, status: 'uncertain', before: null, after: sync([line('k1', POLO, '611')]) });
      expect(late).toEqual({ status: 'applied', text: 'Added the white Elite Polo in M.' });
      const session = await sessions.getOrCreate(id);
      expect(Object.values(session.cartOperations ?? {}).filter((op) => op.kind === 'add-product' && op.status !== 'failed')).toHaveLength(1);
      expect(session.messages.filter((m) => m.text === 'Added the white Elite Polo in M.')).toHaveLength(1);
      expect(session.pendingAction).toBeUndefined();
      // And a change goes through now.
      const then = await addM('Add the Elite Polo in M');
      expect(then.dispatched).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the hold survives another record taking the pending slot, and a late result clears only its own', async () => {
    const first = await addM();
    // Something else takes the one pending slot (a question the code asks about anything else).
    await sessions.patch(id, { pendingAction: { type: 'replace-pack-piece', productIds: [JACKET.id], awaiting: 'confirmation', authorized: false, turn: 1 } });
    const blocked = await addM('Add the Storm Jacket in M');
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toBe('not-ready');
    await report({ operationId: first.operationId!, before: sync([]), after: sync([line('k1', POLO, '611')]) });
    expect((await sessions.getOrCreate(id)).pendingAction).toMatchObject({ type: 'replace-pack-piece' });
  });

  it('the verdicts stay distinct: rejected with nothing changed, partial, uncertain, applied', () => {
    const rec = { id: 'op', kind: 'add-product' as const, status: 'dispatched' as const, quantity: 1, expect: { add: [{ variantId: '612', quantity: 1 }], remove: [{ key: 'k1', variantId: '611', quantity: 1 }] }, before: { '611': 1 }, onApplied: {}, wording: { title: 'white Elite Polo', choice: 'L', quantity: 1 }, source: 't', turn: 1, createdAt: Date.now() - OUTCOME_TIMEOUT_MS * 3 };
    const m = [line('k1', POLO, '611')];
    expect(judge(rec, { status: 'failed', failure: 'rejected', before: sync(m), after: sync(m) })).toBe('failed');
    expect(judge(rec, { status: 'failed', failure: 'network', before: sync(m), after: sync(m) })).toBe('uncertain');
    expect(judge(rec, { status: 'uncertain', before: sync(m), after: sync(m) })).toBe('uncertain');
    expect(judge(rec, { status: 'partial', before: sync(m), after: sync([line('k2', POLO, '612'), ...m]) })).toBe('partial');
    // A rejection reported after the store had in fact changed the cart: the read decides, not the error.
    expect(judge(rec, { status: 'failed', failure: 'rejected', before: sync(m), after: sync([line('k2', POLO, '612')]) })).toBe('applied');
  });
});

describe('2. basket statements come from the reported basket', () => {
  const ctx = (lines: Line[], unsettled: Array<{ title: string; choice: string; quantity: number; outgoingChoice?: string }> = []) => ({
    basket: lines.map((l) => ({ productId: l.productId, title: l.productId === POLO.id ? POLO.title : JACKET.title, variantTitle: l.variantId.endsWith('612') ? 'L' : l.variantId.endsWith('611') ? 'M' : 'S', quantity: l.quantity })),
    unsettled,
  });
  const claims = (reply: string, context: ReturnType<typeof ctx>) => verifyReply(reply, '', undefined, undefined, context).filter((v) => v.kind === 'basket').map((v) => v.claim);

  it('the reported sentence: "two white Elite Polos in size M" against a basket of one in L, changing to two in L', () => {
    expect(claims('The basket is being updated with two white Elite Polos in size M.', ctx([line('k1', POLO, '612')], [{ title: 'white Elite Polo', choice: 'L', quantity: 2 }]))).toEqual(['size M']);
    expect(claims('The basket is being updated with two white Elite Polos in size L.', ctx([line('k1', POLO, '612')], [{ title: 'white Elite Polo', choice: 'L', quantity: 2 }]))).toEqual([]);
  });

  it('no stale M after a confirmed L; no invented quantity', () => {
    expect(claims('Your basket is still showing the white Elite Polo in size M.', ctx([line('k1', POLO, '612')]))).toEqual(['size M']);
    expect(claims('Your basket has the white Elite Polo in L.', ctx([line('k1', POLO, '612')]))).toEqual([]);
    expect(claims('You have three Elite Polos in your basket.', ctx([line('k1', POLO, '612', 2)]))).toEqual(['three']);
    expect(claims("I can't see a polo in M in your basket.", ctx([line('k1', POLO, '612')]))).toEqual([]);
  });

  it('the usual size is not the basket line\'s size', async () => {
    const { rememberShopper } = await import('../../src/shopper/remember.js');
    await rememberShopper(id, { usualSize: 'M' }, 'ui-form');
    expect(claims('Your basket has the white Elite Polo in M.', ctx([line('k1', POLO, '612')]))).toEqual(['in M']);
  });

  it('"what is in my basket?" is answered in code\'s words: sizes and quantities from the lines, an unconfirmed change kept apart', async () => {
    await basket([line('k1', POLO, '612', 1), line('k2', JACKET, '631', 1)]);
    const statement = basketStatement(await sessions.getOrCreate(id), (t) => t.split(' - ')[0]!.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()), (t) => t.split(' - ')[1] ?? '');
    expect(statement.speech).toBe('In your basket: white Elite Polo in L x1; black Storm Jacket in M x1.');
    // A change to two, still being confirmed.
    await talk('Make it two');
    await executeCommerceAction({ session: await sessions.getOrCreate(id), utterance: 'Make the polo two' }, { type: 'update-line', lineId: 'k1', quantity: 2 });
    const during = basketStatement(await sessions.getOrCreate(id), (t) => t.split(' - ')[0]!.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()), (t) => t.split(' - ')[1] ?? '');
    expect(during.speech).toBe('In your basket: white Elite Polo in L x1; black Storm Jacket in M x1. A change is still being confirmed: the Elite Polo to x2.');
    const tool = await runTool('view_cart', {}, { session: await sessions.getOrCreate(id), utterance: 'What is in my basket?' });
    expect(tool.speech).toMatch(/^In your basket: white Elite Polo in L x1; black Storm Jacket in M x1\. A change is still being confirmed/);
  });

  it('through converse: a true statement of the basket stands, sizes and quantities included', async () => {
    await basket([line('k1', POLO, '612', 1)]);
    replies.push({ content: 'Your basket has one white Elite Polo in size L. Anything else?' });
    const reply = await converse(id, 'What is in my basket?');
    expect(reply.text).toBe('Your basket has one white Elite Polo in size L. Anything else?');
  });

  it('through converse: the model\'s old size is rewritten, then dropped; the confirmed L is never contradicted', async () => {
    await basket([line('k1', POLO, '612', 1)]);
    replies.push({ content: 'Your basket is still showing the white Elite Polo in size M. Anything else?' }, { content: 'Your basket has the white Elite Polo in size M.' });
    const reply = await converse(id, 'Is my polo in the basket?');
    expect(reply.text).not.toMatch(/size M/);
  });
});

describe('3. a failure is only what the store said it was', () => {
  it('a rejection the store sent: failed, in the store\'s terms', async () => {
    const out = await addM();
    const res = await report({ operationId: out.operationId!, status: 'failed', failure: 'rejected', before: sync([]), after: sync([]), error: "The product 'ELITE POLO - WHITE' is already sold out." });
    expect(res).toEqual({ status: 'failed', text: 'That size is unavailable.' });
  });

  it('a request that got no answer: uncertain, a re-read asked for - never "sold out"', async () => {
    const out = await addM();
    const res = await report({ operationId: out.operationId!, status: 'uncertain', failure: 'network', before: sync([]), after: sync([]), error: 'Failed to fetch' });
    expect(res).toMatchObject({ status: 'uncertain', recheck: true });
    expect(res.text).not.toMatch(/unavailable|sold out/);
    // A widget that wrongly called a lost request "failed" is not believed either.
    const out2 = await (async () => { await report({ operationId: out.operationId!, status: 'uncertain', before: null, after: sync([line('k1', POLO, '611')]) }); return addM('Add the Elite Polo in M'); })();
    const res2 = await report({ operationId: out2.operationId!, status: 'failed', failure: 'network', before: sync([line('k1', POLO, '611')]), after: sync([line('k1', POLO, '611')]), error: 'Failed to fetch' });
    expect(res2.status).toBe('uncertain');
  });

  it('a partial add with an error: the actual partial result', async () => {
    const out = await addM();
    const session = await sessions.getOrCreate(id);
    await sessions.patch(id, { cartOperations: { ...session.cartOperations, [out.operationId!]: { ...session.cartOperations![out.operationId!]!, expect: { add: [{ variantId: '611', quantity: 1 }, { variantId: '631', quantity: 1 }] } } } });
    const res = await report({ operationId: out.operationId!, status: 'partial', failure: 'rejected', before: sync([]), after: sync([line('k1', POLO, '611')]), error: 'Cart Error' });
    expect(res.status).toBe('partial');
    expect(res.text).toBe("Only 1 of the 2 items went into your basket. I'm checking the rest.");
  });
});
