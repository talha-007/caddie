import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Semaphore, fetchWithTimeout } from '../src/lib/http.js';

/**
 * The failure modes that only show up under load, where they are hardest to
 * diagnose and most expensive to hit.
 */

describe('concurrency limit', () => {
  it('never runs more than the cap at once', async () => {
    const limit = new Semaphore(3);
    let running = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 20 }, () =>
        limit.run(async () => {
          running += 1;
          peak = Math.max(peak, running);
          await new Promise((r) => setTimeout(r, 5));
          running -= 1;
        }),
      ),
    );

    expect(peak).toBeLessThanOrEqual(3);
    expect(running).toBe(0);
  });

  it('releases its slot when a task throws, rather than wedging', async () => {
    const limit = new Semaphore(1);

    await expect(limit.run(async () => { throw new Error('upstream died'); })).rejects.toThrow('upstream died');

    // If the slot leaked, this would hang rather than resolve.
    await expect(limit.run(async () => 'fine')).resolves.toBe('fine');
    expect(limit.inFlight).toBe(0);
  });

  it('reports what is waiting, so the queue is visible', async () => {
    const limit = new Semaphore(1);
    const release: Array<() => void> = [];

    const slow = () => limit.run(() => new Promise<void>((resolve) => release.push(resolve)));
    void slow();
    void slow();
    void slow();
    await new Promise((r) => setTimeout(r, 5));

    expect(limit.inFlight).toBe(1);
    expect(limit.queued).toBe(2);
    release.forEach((fn) => fn());
  });
});

describe('upstream timeouts', () => {
  it('gives up on a server that accepts the request and never answers', async () => {
    // Node's fetch has no timeout of its own, so without ours this waits
    // until the socket gives up - holding a customer's request the whole time.
    const server = createServer(() => {
      /* deliberately never responds */
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      await expect(
        fetchWithTimeout(`http://127.0.0.1:${port}/hang`, { timeoutMs: 200, label: 'test upstream' }),
      ).rejects.toThrow(/timed out/i);
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });

  it('names the upstream in the error, so a log says which one stalled', async () => {
    const server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      await expect(
        fetchWithTimeout(`http://127.0.0.1:${port}/hang`, { timeoutMs: 100, label: 'Shopify Admin API' }),
      ).rejects.toThrow(/Shopify Admin API/);
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });
});
