import express from 'express';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Product } from '@caddie/shared';
import { setDealsForTests } from '../src/catalog/bundles.js';
import { setCatalogueForTests } from '../src/catalog/sync.js';
import { env } from '../src/env.js';
import { resetLimits } from '../src/lib/rateLimit.js';
import { chatRouter } from '../src/routes/chat.js';
import { eventsRouter } from '../src/routes/events.js';
import { sessionRouter } from '../src/routes/session.js';
import { toolsRouter } from '../src/routes/tools.js';
import { voiceRouter } from '../src/routes/voice.js';
import { claimSession, tokenHash } from '../src/session/ownership.js';
import { sessions } from '../src/session/store.js';

/**
 * Phase 2.1: a session id is not a permission. Every route that reads or
 * changes a shopper's session needs the capability token the browser got
 * when it claimed the session - someone else's id, with no token, a wrong
 * token or another session's token, gets nothing: no read, no change.
 */

const BRAND = [env.shopify.brandTag].filter(Boolean) as string[];
const POLO: Product = {
  id: 'gid://shopify/Product/5500',
  title: 'ELITE POLO - NAVY',
  url: '',
  imageUrl: null,
  vendor: 'Druids',
  productType: null,
  tags: [...BRAND],
  price: { amount: 20, currency: 'GBP' },
  options: [{ name: 'Size', values: ['S', 'M'] }],
  variants: ['S', 'M'].map((size, i) => ({ id: `gid://shopify/ProductVariant/550${i}`, title: size, available: true, price: { amount: 20, currency: 'GBP' }, options: { Size: size } })),
  description: null,
};

let base = '';
let server: ReturnType<ReturnType<typeof express>['listen']>;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/chat', chatRouter);
  app.use('/api/events', eventsRouter);
  app.use('/api/session', sessionRouter);
  app.use('/api/tools', toolsRouter);
  app.use('/api/voice', voiceRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const wasProd = env.isProd;
let A = '';
let B = '';
let tokenA = '';
let tokenB = '';
beforeEach(async () => {
  setCatalogueForTests([POLO]);
  setDealsForTests([]);
  resetLimits();
  A = `owner-a-${Math.random()}`;
  B = `owner-b-${Math.random()}`;
  const a = await claimSession(A);
  const b = await claimSession(B);
  if (!a.ok || !b.ok) throw new Error('claim failed');
  tokenA = a.sessionToken;
  tokenB = b.sessionToken;
  await sessions.patch(A, { cartMode: 'theme', basket: [{ lineId: 'line-a', productId: POLO.id, title: POLO.title, variantTitle: 'M', quantity: 1 }], lastShown: { kind: 'products', items: [{ id: POLO.id, title: POLO.title }] } });
});
afterEach(() => {
  env.isProd = wasProd;
  delete process.env.CADDIE_DEV_OPEN_SESSIONS;
});

type Call = { name: string; method: 'POST' | 'GET'; path: (id: string) => string; body?: (id: string) => unknown; type?: string };
const PRIVATE: Call[] = [
  { name: 'card choice', method: 'POST', path: (id) => `/api/session/${id}/choice`, body: () => ({ productId: POLO.id, options: { Size: 'S' } }) },
  { name: 'profile', method: 'POST', path: (id) => `/api/session/${id}/profile`, body: () => ({ range: 'women', size: 'S' }) },
  { name: 'basket sync', method: 'POST', path: (id) => `/api/session/${id}/basket`, body: () => ({ lines: [] }) },
  { name: 'Add', method: 'POST', path: (id) => `/api/session/${id}/add`, body: () => ({ items: [{ productId: POLO.id, options: { Size: 'M' } }] }) },
  { name: 'pack Add', method: 'POST', path: (id) => `/api/session/${id}/add-pack`, body: () => ({ handle: 'any-pack', pieces: [{ productId: POLO.id, options: { Size: 'M' } }] }) },
  { name: 'cart line', method: 'POST', path: (id) => `/api/session/${id}/cart-line`, body: () => ({ lineId: 'line-a', quantity: 0 }) },
  { name: 'new chat', method: 'POST', path: (id) => `/api/session/${id}/restart`, body: () => ({}) },
  { name: 'sizing form', method: 'POST', path: () => `/api/tools/find_my_size`, body: (id) => ({ sessionId: id, args: { usualSize: 'XL', audience: 'men' } }) },
  { name: 'card product load', method: 'POST', path: () => `/api/tools/get_product_details`, body: (id) => ({ sessionId: id, args: { productId: POLO.id } }) },
  { name: 'chat', method: 'POST', path: () => `/api/chat`, body: (id) => ({ sessionId: id, text: 'show me polos' }) },
  { name: 'voice', method: 'POST', path: (id) => `/api/voice?sessionId=${id}`, type: 'audio/webm' },
  { name: 'event stream', method: 'GET', path: (id) => `/api/events/${id}` },
];

async function send(call: Call, id: string, token?: string): Promise<number> {
  const headers: Record<string, string> = { 'Content-Type': call.type ?? 'application/json', 'x-caddie-cart': 'theme', ...(token ? { 'x-caddie-session-token': token } : {}) };
  const controller = new AbortController();
  const res = await fetch(`${base}${call.path(id)}`, {
    method: call.method,
    headers,
    signal: controller.signal,
    ...(call.method === 'POST' ? { body: call.type ? new Uint8Array(4000) : JSON.stringify(call.body?.(id) ?? {}) } : {}),
  });
  controller.abort(); // the event stream would stay open
  return res.status;
}

const snapshot = async (id: string) => {
  const { updatedAt: _updated, ...rest } = await sessions.getOrCreate(id);
  return JSON.stringify(rest);
};

describe("someone else's session id is not enough", () => {
  for (const [label, token] of [
    ['no token', () => undefined],
    ["B's token", () => tokenB],
    ['a made-up token', () => 'x'.repeat(43)],
  ] as const) {
    it(`A's id with ${label}: every private route refuses, and A is untouched`, async () => {
      const before = await snapshot(A);
      for (const call of PRIVATE) expect(await send(call, A, token()), `${call.name} with ${label}`).toBe(401);
      expect(await snapshot(A)).toBe(before);
    });
  }

  it('the same in production', async () => {
    env.isProd = true;
    const before = await snapshot(A);
    for (const call of PRIVATE.filter((call) => !call.path('').startsWith('/api/tools/') || /find_my_size|get_product_details/.test(call.path('')))) {
      expect(await send(call, A, tokenB), call.name).toBe(401);
    }
    expect(await snapshot(A)).toBe(before);
  });

  it('a session nobody has claimed cannot be used - nor is one created by trying', async () => {
    const ghost = `ghost-${Math.random()}`;
    expect(await send(PRIVATE[0]!, ghost, tokenA)).toBe(401);
    expect(await sessions.get(ghost)).toBeNull();
  });
});

describe('the owner, with their token, has everything as before', () => {
  it('card choice, profile, Add, cart line, sizing, product load, chat, new chat, events: all through', async () => {
    const expected: Record<string, number> = { voice: 501 }; // voice is not configured in tests - but it got past the ownership check
    for (const call of PRIVATE.filter((call) => call.name !== 'pack Add')) {
      expect(await send(call, A, tokenA), call.name).toBe(expected[call.name] ?? 200);
    }
  });

  it('"New chat" keeps the session, and its token still works after it', async () => {
    expect(await send(PRIVATE.find((call) => call.name === 'new chat')!, A, tokenA)).toBe(200);
    expect(await send(PRIVATE[0]!, A, tokenA)).toBe(200);
  });
});

describe('claiming', () => {
  it('once: a claimed session cannot be claimed again, and says nothing more', async () => {
    const res = await fetch(`${base}/api/session/${A}/claim`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).not.toMatch(/token/i);
  });

  it('a fresh id: a fresh 256-bit token, stored only as its hash', async () => {
    const id = `fresh-${Math.random()}`;
    const res = await fetch(`${base}/api/session/${id}/claim`, { method: 'POST' });
    const body = (await res.json()) as { sessionId: string; sessionToken: string };
    expect(body.sessionId).toBe(id);
    expect(Buffer.from(body.sessionToken, 'base64url').length).toBe(32);
    const stored = await sessions.get(id);
    expect(stored?.ownerHash).toBe(tokenHash(body.sessionToken));
    expect(JSON.stringify(stored)).not.toContain(body.sessionToken);
  });

  it('development can open sessions explicitly - production never', async () => {
    process.env.CADDIE_DEV_OPEN_SESSIONS = '1';
    env.isProd = false;
    expect(await send(PRIVATE[0]!, A)).toBe(200);
    env.isProd = true;
    expect(await send(PRIVATE[0]!, A)).toBe(401);
  });
});

describe('the token does not leak', () => {
  it('not in logs, not in replies - only in the claim that hands it out', async () => {
    const lines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error'] as const).map((level) => vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(' '))));
    const replies: string[] = [];
    for (const call of PRIVATE.filter((call) => call.method === 'POST' && !call.type)) {
      const res = await fetch(`${base}${call.path(A)}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-caddie-session-token': tokenA }, body: JSON.stringify(call.body?.(A) ?? {}) });
      replies.push(await res.text());
      await fetch(`${base}${call.path(A)}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-caddie-session-token': tokenB }, body: JSON.stringify(call.body?.(A) ?? {}) });
    }
    spies.forEach((spy) => spy.mockRestore());
    for (const text of [...lines, ...replies]) {
      expect(text).not.toContain(tokenA);
      expect(text).not.toContain(tokenB);
    }
  });

  it('nothing the model reads, or the widget puts in a URL, carries it', () => {
    const src = fileURLToPath(new URL('../src/', import.meta.url));
    const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : [join(dir, name)]));
    // Only ownership, the store and the session routes touch the owner hash; the model's context builders never do.
    const touching = files(src).filter((file) => /ownerHash/.test(readFileSync(file, 'utf8'))).map((file) => file.replace(src, '').replace(/\\/g, '/'));
    expect(touching.sort()).toEqual(['routes/session.ts', 'session/ownership.ts', 'session/store.ts']);
    const api = readFileSync(fileURLToPath(new URL('../../widget/src/lib/api.ts', import.meta.url)), 'utf8');
    expect(api).not.toMatch(/[?&]token=|\/\$\{[^}]*[Tt]oken[^}]*\}/);
    expect(api).toContain("'x-caddie-session-token'");
    expect(api).not.toMatch(/new EventSource/);
  });
});
