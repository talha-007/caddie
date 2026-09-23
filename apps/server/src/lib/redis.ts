import Redis from 'ioredis';
import { env } from '../env.js';
import { log } from './logger.js';

/**
 * Redis, when there is more than one of us.
 *
 * Four things stop working the moment a second instance exists, and only one
 * of them is obvious:
 *
 *  1. **Sessions.** A customer's next message can land on another instance.
 *     Without shared state they lose their size, their budget and their
 *     basket mid-conversation.
 *  2. **Rate limits.** Per-instance counters mean the real limit is the limit
 *     times the number of instances.
 *  3. **The event stream.** This is the one that surprises people: an SSE
 *     connection lives on the instance that accepted it, but the chat request
 *     that produces a card may be handled by a different one. Without a shared
 *     bus the cards never reach the screen.
 *  4. **Catalogue changes.** Shopify posts a webhook to one instance. The
 *     others would not know until their own delta pull, so two customers could
 *     see different prices for the same minute.
 *
 * With no REDIS_URL everything falls back to in-process memory, which is
 * correct for one instance and for local development.
 */

let client: Redis | null = null;
let subscriber: Redis | null = null;
let warned = false;

function create(label: string): Redis {
  const redis = new Redis(env.redisUrl, {
    /*
     * The offline queue stays on. Turning it off looked like the cautious
     * choice - fail fast rather than queue forever - but it fails every
     * command issued before the socket is ready, which includes the first
     * requests after a restart. That silently lost the opening turn of a
     * conversation. maxRetriesPerRequest is what bounds the waiting.
     */
    enableOfflineQueue: true,
    maxRetriesPerRequest: 2,
    connectTimeout: 5000,
    lazyConnect: false,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
  });

  redis.on('error', (err) => {
    // One line per failure, not per retry.
    if (!warned) {
      warned = true;
      log.error('redis.error', { label, err: String(err) });
      setTimeout(() => {
        warned = false;
      }, 30_000).unref?.();
    }
  });

  redis.on('connect', () => log.info('redis.connected', { label }));
  return redis;
}

export function redisEnabled(): boolean {
  return Boolean(env.redisUrl);
}

/** The shared connection for reads and writes. */
export function redis(): Redis | null {
  if (!env.redisUrl) return null;
  if (!client) client = create('main');
  return client;
}

/**
 * A second connection, for subscriptions.
 *
 * A Redis connection in subscriber mode cannot run ordinary commands, so the
 * bus needs its own.
 */
export function redisSubscriber(): Redis | null {
  if (!env.redisUrl) return null;
  if (!subscriber) subscriber = create('subscriber');
  return subscriber;
}

export async function closeRedis(): Promise<void> {
  await Promise.allSettled([client?.quit(), subscriber?.quit()]);
  client = null;
  subscriber = null;
}
