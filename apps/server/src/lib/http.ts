import { UpstreamError } from './errors.js';

/**
 * fetch, with a deadline.
 *
 * Node's fetch has no timeout. A hung upstream therefore holds the request,
 * its session, and a slot in whatever concurrency budget we are keeping, until
 * the socket eventually gives up - which on a busy day is how one slow
 * dependency becomes an outage everywhere.
 *
 * Every outbound call goes through here so none can be forgotten.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number; label?: string } = {},
): Promise<Response> {
  const { timeoutMs = 20_000, label = 'upstream', ...rest } = init;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...rest, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new UpstreamError(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Caps how many of something run at once, queueing the rest.
 *
 * Without this, a burst of customers becomes a burst of simultaneous model
 * calls: the provider starts returning 429s, every one of those customers
 * waits on a retry, and the queue is simply moved somewhere we cannot see it.
 * Holding the line here keeps failures predictable.
 */
export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly max: number) {}

  get inFlight(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiting.length;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;

    try {
      return await task();
    } finally {
      this.active -= 1;
      // Let the next one in, whether this succeeded or not.
      this.waiting.shift()?.();
    }
  }
}
