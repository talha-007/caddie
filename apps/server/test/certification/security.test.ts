import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../../src/env.js';
import { resetLimits } from '../../src/lib/rateLimit.js';
import { sessionRouter } from '../../src/routes/session.js';
import { toolsRouter } from '../../src/routes/tools.js';
import { vapiRouter } from '../../src/routes/vapi.js';
import { sessions } from '../../src/session/store.js';

/**
 * Certification §6 and §18, in production configuration: claiming, expiry
 * and recovery, the dev bypass, and Vapi's gate. The cross-session matrix
 * itself (every private route x no / wrong / other shopper's token, in
 * development and production) is test/sessionOwnership.test.ts.
 */

let base = '';
let server: ReturnType<ReturnType<typeof express>['listen']>;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/session', sessionRouter);
  app.use('/api/tools', toolsRouter);
  app.use('/api/vapi', vapiRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const wasProd = env.isProd;
const wasSecret = env.vapi.webhookSecret;
beforeEach(() => {
  env.isProd = true;
  resetLimits();
});
afterEach(() => {
  env.isProd = wasProd;
  (env.vapi as { webhookSecret?: string }).webhookSecret = wasSecret;
  delete process.env.CADDIE_DEV_OPEN_SESSIONS;
});

const claim = (id: string) => fetch(`${base}/api/session/${id}/claim`, { method: 'POST' });
const profile = (id: string, token?: string) =>
  fetch(`${base}/api/session/${id}/profile`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'x-caddie-session-token': token } : {}) }, body: JSON.stringify({ size: 'L' }) });

describe('certification: session ownership in production', () => {
  it('claim once; a second claim is refused and hands out nothing', async () => {
    const id = `cert-sec-${Math.random()}`;
    const first = await claim(id);
    expect(first.status).toBe(200);
    const second = await claim(id);
    expect(second.status).toBe(409);
    expect(JSON.stringify(await second.json())).not.toMatch(/token/i);
  });

  it('the dev bypass is ignored in production', async () => {
    process.env.CADDIE_DEV_OPEN_SESSIONS = '1';
    const id = `cert-sec-${Math.random()}`;
    await claim(id);
    expect((await profile(id)).status).toBe(401);
  });

  it('an expired session: the old token opens nothing, the id can be claimed afresh, the new token works', async () => {
    const id = `cert-sec-${Math.random()}`;
    const old = ((await (await claim(id)).json()) as { sessionToken: string }).sessionToken;
    expect((await profile(id, old)).status).toBe(200);
    // Two hours idle: the store lets it go.
    const session = await sessions.getOrCreate(id);
    session.updatedAt = Date.now() - 1000 * 60 * 60 * 3;
    expect(await sessions.get(id)).toBeNull();
    expect((await profile(id, old)).status).toBe(401);
    const fresh = ((await (await claim(id)).json()) as { sessionToken: string }).sessionToken;
    expect(fresh).not.toBe(old);
    expect((await profile(id, fresh)).status).toBe(200);
    expect((await profile(id, old)).status).toBe(401);
  });

  it('direct tools are closed to another shopper\'s session', async () => {
    const a = `cert-sec-a-${Math.random()}`;
    const b = `cert-sec-b-${Math.random()}`;
    await claim(a);
    const tokenB = ((await (await claim(b)).json()) as { sessionToken: string }).sessionToken;
    for (const name of ['find_my_size', 'get_product_details']) {
      const res = await fetch(`${base}/api/tools/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-caddie-session-token': tokenB }, body: JSON.stringify({ sessionId: a, args: {} }) });
      expect(res.status, name).toBe(401);
    }
  });
});

describe('certification: Vapi stays closed', () => {
  const call = (secret?: string) =>
    fetch(`${base}/api/vapi/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(secret ? { 'x-vapi-secret': secret } : {}) }, body: JSON.stringify({ message: { toolCallList: [] } }) });

  it('production with no secret configured: closed', async () => {
    (env.vapi as { webhookSecret?: string }).webhookSecret = '';
    expect((await call()).status).toBe(503);
    expect((await call('anything')).status).toBe(503);
  });

  it('a wrong secret is refused', async () => {
    (env.vapi as { webhookSecret?: string }).webhookSecret = 'the-right-one';
    expect((await call()).status).toBe(401);
    expect((await call('wrong')).status).toBe(401);
  });
});
