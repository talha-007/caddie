import type { CaddieMessage } from '@caddie/shared';
import type { CaddieSession, SessionStore } from './store.js';
import { log } from '../lib/logger.js';
import { markRedisDown, redis } from '../lib/redis.js';

/**
 * Sessions in Redis, so any instance can serve any customer.
 *
 * The alternative is sticky sessions at the load balancer, which works until
 * an instance restarts and everyone it was holding loses their conversation -
 * including the id of the basket they were filling.
 *
 * Reads and writes are whole-session JSON. A session is about 2KB once the
 * attachments are stripped out, so there is nothing to gain from splitting it
 * into fields, and this way a save is atomic.
 */

const PREFIX = 'caddie:session:';
const TTL_SECONDS = 60 * 60 * 2;

function blank(id: string): CaddieSession {
  const now = Date.now();
  return { id, createdAt: now, updatedAt: now, sizeProfile: {}, preferences: {}, messages: [] };
}

function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export class RedisSessionStore implements SessionStore {
  /**
   * Falls back to a fresh session rather than failing the request.
   *
   * If Redis is unreachable the customer repeats themselves, which is a far
   * better failure than an error page.
   */
  async get(id: string): Promise<CaddieSession | null> {
    const client = redis();
    if (!client) return null;

    try {
      const raw = await client.get(PREFIX + id);
      return raw ? (JSON.parse(raw) as CaddieSession) : null;
    } catch (err) {
      markRedisDown(err);
      log.warn('session.read_failed', { id, err: String(err) });
      return null;
    }
  }

  async getOrCreate(id: string): Promise<CaddieSession> {
    return (await this.get(id)) ?? blank(id);
  }

  async save(session: CaddieSession): Promise<void> {
    const client = redis();
    if (!client) return;

    session.updatedAt = Date.now();
    if (session.messages.length > 40) session.messages = session.messages.slice(-40);
    // History keeps the words, never the payload - see store.ts.
    session.messages = session.messages.map(({ attachment: _dropped, ...rest }) => rest);

    try {
      // Every save renews the two hours, so an active conversation never expires.
      await client.set(PREFIX + session.id, JSON.stringify(session), 'EX', TTL_SECONDS);
    } catch (err) {
      markRedisDown(err);
      log.warn('session.write_failed', { id: session.id, err: String(err) });
    }
  }

  /** Re-reads first, so nothing the tools wrote during the turn is lost. */
  async append(id: string, messages: CaddieMessage[]): Promise<void> {
    const session = await this.getOrCreate(id);
    session.messages.push(...messages);
    await this.save(session);
  }

  /**
   * Read, merge, write.
   *
   * Two tools in the same turn can patch at once, and the last write wins on
   * the fields it names. They patch different things - one the size profile,
   * another what is on screen - so in practice this is fine, and the
   * alternative is a lock held across a Shopify call.
   */
  async patch(id: string, patch: Partial<Omit<CaddieSession, 'id'>>): Promise<CaddieSession> {
    const session = await this.getOrCreate(id);
    const sizeProfile = { ...session.sizeProfile, ...defined(patch.sizeProfile ?? {}) };
    const preferences = { ...session.preferences, ...defined(patch.preferences ?? {}) };

    Object.assign(session, defined(patch), { sizeProfile, preferences });
    // A new screen: "it" no longer means the product talked about on the last one.
    if (patch.lastShown && patch.focusProductId === undefined) delete session.focusProductId;
    await this.save(session);
    return session;
  }
}
