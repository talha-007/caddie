import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Product } from '@caddie/shared';

/**
 * The recurring failure, through converse() - the one function typed chat
 * and the voice route (/api/voice) both call - with the model stubbed to
 * make exactly the mistake it made: answer "polos" without searching, so the
 * jacket cards stay on screen, then show the Clima Jacket's colours for
 * "different colours". What the customer sees must be polos.
 */

type Completion = { content?: string; tool?: { name: string; args: Record<string, unknown> } };
const replies: Completion[] = [];

vi.mock('../src/lib/http.js', async (original) => ({
  ...(await original<typeof import('../src/lib/http.js')>()),
  fetchWithTimeout: vi.fn(async (url: string) => {
    if (!String(url).includes('chat/completions')) throw new Error(`unexpected call to ${url}`);
    const next = replies.shift() ?? { content: 'They are on screen now.' };
    const message = next.tool
      ? { role: 'assistant', content: null, tool_calls: [{ id: `call-${Math.random()}`, type: 'function', function: { name: next.tool.name, arguments: JSON.stringify(next.tool.args) } }] }
      : { role: 'assistant', content: next.content };
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: next.tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }),
}));

const { setCatalogueForTests } = await import('../src/catalog/sync.js');
const { setDealsForTests } = await import('../src/catalog/bundles.js');
const { categoriesOf } = await import('../src/catalog/constraints.js');
const { sessions } = await import('../src/session/store.js');
const { converse } = await import('../src/ai/openai.js');
const { env } = await import('../src/env.js');

let next = 9000;
function product(title: string, price: number): Product {
  const id = next;
  next += 10;
  return {
    id: `gid://shopify/Product/${id}`,
    title,
    url: '',
    imageUrl: null,
    vendor: 'Druids',
    productType: null,
    tags: [env.shopify.brandTag].filter(Boolean) as string[],
    price: { amount: price, currency: 'GBP' },
    options: [{ name: 'Size', values: ['S', 'M', 'L'] }],
    variants: ['S', 'M', 'L'].map((size, i) => ({ id: `gid://shopify/ProductVariant/${id + i + 1}`, title: size, available: true, price: { amount: price, currency: 'GBP' }, options: { Size: size } })),
    description: null,
  };
}

const ELITE_WHITE = product('ELITE POLO - WHITE', 20);
const ELITE_NAVY = product('ELITE POLO - NAVY', 20);
const CLIMA_NAVY = product('CLIMA JACKET 3.0 - NAVY', 58);
const CLIMA_BLACK = product('CLIMA JACKET 3.0 - BLACK', 58);

beforeEach(() => {
  setCatalogueForTests([ELITE_WHITE, ELITE_NAVY, CLIMA_NAVY, CLIMA_BLACK]);
  setDealsForTests([]);
  replies.length = 0;
});

/** One turn: what converse() returns, then recorded as the routes record it. */
async function turn(id: string, text: string, model: Completion[]) {
  replies.push(...model);
  const reply = await converse(id, text);
  await sessions.append(id, [
    { id: `u-${Math.random()}`, role: 'user', text, createdAt: new Date().toISOString() },
    { id: `a-${Math.random()}`, role: 'assistant', text: reply.text, createdAt: new Date().toISOString() },
  ]);
  return reply;
}

describe('through converse(), typed or spoken', () => {
  it('jackets and polos - polos (answered without a search) - "different colours" on the jacket: polos come back', async () => {
    const id = `converse-${Math.random()}`;
    await sessions.getOrCreate(id);
    await turn(id, "Hey Caddie, show me some options for men's products. I would like to see jackets and polos.", [{ content: 'Here are jackets and polos.' }]);
    // The jackets are what is on screen.
    await sessions.patch(id, { lastShown: { kind: 'products', items: [CLIMA_NAVY, CLIMA_BLACK].map((p) => ({ id: p.id, title: p.title })) } });
    // The model talks about polos without searching: the jacket cards stay.
    await turn(id, 'Show me polos', [{ content: 'The Elite Polo is a good choice.' }]);
    // "Different colours": the model reaches for the Clima Jacket on screen.
    const reply = await turn(id, 'Show me different colors', [{ tool: { name: 'other_colours', args: { productId: CLIMA_NAVY.id } } }, { content: 'These are on screen now.' }]);

    const shown = reply.attachment?.kind === 'products' ? reply.attachment.products : [];
    expect(shown.length).toBeGreaterThan(0);
    expect([...new Set(shown.flatMap((p) => [...categoriesOf(p)]))]).toEqual(['polo']);
    expect((await sessions.getOrCreate(id)).activeShoppingContext).toMatchObject({ kinds: ['polo'], range: 'men', source: 'inherited' });
  });
});
