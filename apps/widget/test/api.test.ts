import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, TIMEOUTS, TimeoutError, fetchWithDeadline, reportCartOutcome } from '../src/lib/api.js';

/**
 * The transport's deadlines and the outcome report's delivery: a hung
 * request ends in a TimeoutError within its deadline (audit finding B5); a
 * lost acknowledgement is retried, a 404 is the server's answer, and the
 * report is the same one each time - never a new add.
 */

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  sessionStorage.clear();
  (window as unknown as { Shopify?: unknown }).Shopify = undefined;
});
afterEach(() => vi.useRealTimers());

describe('14. a request that hangs', () => {
  it('ends with a TimeoutError at its deadline, not never', async () => {
    vi.useFakeTimers();
    globalThis.fetch = ((_: unknown, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))) as typeof fetch;
    let outcome: unknown = 'still waiting';
    const pending = fetchWithDeadline('http://caddie.test/api/chat', { method: 'POST' }, 1000, 'The Caddie').catch((err) => (outcome = err));
    await vi.advanceTimersByTimeAsync(900);
    expect(outcome).toBe('still waiting');
    await vi.advanceTimersByTimeAsync(200);
    await pending;
    expect(outcome).toBeInstanceOf(TimeoutError);
    expect((outcome as TimeoutError).message).toMatch(/The Caddie took longer than 1s/);
  });

  it('deadlines are finite and the basket\'s is short', () => {
    expect(TIMEOUTS.cart).toBeGreaterThan(0);
    expect(TIMEOUTS.cart).toBeLessThan(TIMEOUTS.chat);
    expect(TIMEOUTS.voice).toBeGreaterThan(TIMEOUTS.chat);
  });
});

describe('16. delivering the outcome report', () => {
  const report = { operationId: 'op-a', status: 'applied' as const, before: { lines: [] }, after: { lines: [] }, evidence: 'ajax-cart-read' as const };
  const claim = () => json(200, { sessionId: 's1', sessionToken: 'tok' });

  it('retries a lost acknowledgement with the same report, and never anything else', async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    let failures = 2;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/claim')) return claim();
      posts.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (failures-- > 0) throw new TypeError('Failed to fetch');
      return json(200, { status: 'applied', text: 'Added the navy polo in M.' });
    }) as typeof fetch;
    const answer = await reportCartOutcome('s1', report);
    expect(answer).toEqual({ status: 'applied', text: 'Added the navy polo in M.' });
    expect(posts).toHaveLength(3);
    expect(posts.every((post) => post.url.endsWith('/api/session/s1/cart-outcome'))).toBe(true);
    expect(posts.every((post) => JSON.stringify(post.body) === JSON.stringify(report))).toBe(true);
  });

  it('a 404 is the server\'s answer - not this session\'s operation - and is not retried', async () => {
    let posts = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/claim')) return claim();
      posts += 1;
      return json(404, { status: 'unknown' });
    }) as typeof fetch;
    expect(await reportCartOutcome('s1', report)).toEqual({ status: 'unknown' });
    expect(posts).toBe(1);
  });

  it('gives up after its attempts with the last error, so the caller keeps the report for later', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/claim')) return claim();
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    await expect(reportCartOutcome('s1', report, 2)).rejects.toBeInstanceOf(TypeError);
  });

  it('a server error is an ApiError with its status', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/claim')) return claim();
      return json(500, {});
    }) as typeof fetch;
    await expect(reportCartOutcome('s1', report, 1)).rejects.toBeInstanceOf(ApiError);
  });
});
