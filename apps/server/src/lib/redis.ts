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
let createdAt = 0;
/** Until when Redis is treated as down: callers get null and use memory straight away. */
let downUntil = 0;
let lastError: string | null = null;

/**
 * How long a failure keeps Redis out of the path. Long enough that a turn's
 * dozen session reads and writes do not each wait on a dead connection; short
 * enough that a Redis that comes back is used again within seconds.
 */
const DOWN_FOR_MS = 10_000;
/** A fresh connection gets this long to become ready before its queue counts as a hang. */
const STARTUP_GRACE_MS = 5_000;

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
    /*
     * No command waits longer than this. With the password wrong, Redis
     * accepted the connection and refused every command, the queue held them,
     * and every chat on the live store hung for 40 seconds and more while
     * /health still said all was well.
     */
    commandTimeout: 1500,
    lazyConnect: false,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
  });

  redis.on('error', (err) => {
    markRedisDown(err);
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
  // Ready means authenticated and answering - not merely a socket that opened.
  redis.on('ready', () => {
    downUntil = 0;
    lastError = null;
  });
  return redis;
}

/**
 * A command failed or timed out: stop sending Redis anything for a while.
 * Every caller already falls back to memory when it gets no client - this is
 * what makes them do it at once, instead of each waiting out a timeout.
 */
export function markRedisDown(err?: unknown): void {
  downUntil = Date.now() + DOWN_FOR_MS;
  if (err) lastError = String(err).slice(0, 200);
}

export function redisEnabled(): boolean {
  return Boolean(env.redisUrl);
}

/** Configured, connected, authenticated and not in a recent failure. */
export function redisUsable(): boolean {
  if (!client) return false;
  if (Date.now() < downUntil) return false;
  if (client.status === 'ready') return true;
  // Just started: the offline queue holds commands until it is ready - see create().
  return Date.now() - createdAt < STARTUP_GRACE_MS && (client.status === 'connecting' || client.status === 'connect');
}

/** For /health: whether the shared state is really in Redis right now. */
export function redisState(): { configured: boolean; usable: boolean; status: string; lastError: string | null } {
  return {
    configured: redisEnabled(),
    usable: redisEnabled() ? (redis(), redisUsable()) : false,
    status: client?.status ?? 'none',
    lastError,
  };
}

/**
 * The shared connection for reads and writes - or null when Redis is not
 * configured, or not usable right now. Null always means "use memory".
 */
export function redis(): Redis | null {
  if (!env.redisUrl) return null;
  if (!client) {
    client = create('main');
    createdAt = Date.now();
  }
  return redisUsable() ? client : null;
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
