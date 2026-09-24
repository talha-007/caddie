import type { CaddieMessage, CaddieState } from '@caddie/shared';
import { redisEnabled } from '../lib/redis.js';
import { RedisSessionStore } from './redisStore.js';

/**
 * Day 7 - Conversation memory.
 *
 * What the customer has already told us, so "cheaper", "different colour" and
 * "show me another" mean something. In-memory for the sprint; the interface is
 * here so we can drop in Redis for the pilot without touching callers.
 */

/**
 * One conversation, as the server works with it during a turn.
 *
 * The remembered part is `CaddieState`, which is the contract the client holds
 * and resends - defined once in @caddie/shared so the two cannot drift. The
 * three fields here are the server's own bookkeeping and are not sent back.
 */
export interface CaddieSession extends CaddieState {
  id: string;
  createdAt: number;
  updatedAt: number;
}

/** Just the remembered part, for handing back to the client. */
export function stateOf(session: CaddieSession): CaddieState {
  return {
    sizeProfile: session.sizeProfile,
    preferences: session.preferences,
    messages: session.messages,
    ...(session.lastShown ? { lastShown: session.lastShown } : {}),
    ...(session.cartId ? { cartId: session.cartId } : {}),
    ...(session.page ? { page: session.page } : {}),
  };
}

export interface SessionStore {
  get(id: string): Promise<CaddieSession | null>;
  getOrCreate(id: string): Promise<CaddieSession>;
  save(session: CaddieSession): Promise<void>;
  patch(id: string, patch: Partial<Omit<CaddieSession, 'id'>>): Promise<CaddieSession>;
  /**
   * Adds to the conversation without writing back anything else.
   *
   * A route reads the session, runs the model - which has its own tools
   * patching size, budget and what is on screen - and then wants to record
   * what was said. Saving the snapshot it read at the start would undo all of
   * that. In memory this happened to work, because both held the same object;
   * over Redis they are copies and the last write won.
   */
  append(id: string, messages: CaddieMessage[]): Promise<void>;
  /**
   * Seeds a session from state the client sent back.
   *
   * This is what makes the backend stateless: a request can land on a server
   * that has never seen this customer, and the state it carries is enough to
   * carry on. The store is then a scratchpad for the length of one turn
   * rather than the place the conversation lives.
   */
  restore(id: string, state: CaddieState): Promise<CaddieSession>;
}

const TTL_MS = 1000 * 60 * 60 * 2; // 2 hours of idle, then the session is gone.
const MAX_MESSAGES = 40;

/**
 * History keeps the words, never the payload.
 *
 * An attachment carries whole products - images, variants, tags, the lot - and
 * a session holding ten of them is 153KB against 2KB without. At a thousand
 * live sessions that is 149MB versus 2MB, for data nothing ever reads back:
 * the model is only ever shown `text`, and `lastShown` carries the ids and
 * titles needed to resolve "that one".
 *
 * Copied rather than deleted in place, because the caller is still holding
 * the same message object and is about to send the attachment to the browser.
 */
function stripAttachment(message: CaddieMessage): CaddieMessage {
  if (!message.attachment) return message;
  const { attachment: _dropped, ...rest } = message;
  return rest;
}

/**
 * Drops undefined values so a patch can never unset something the customer
 * told us earlier. "Show me a cheaper one" must not forget the colour.
 */
function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function blank(id: string): CaddieSession {
  const now = Date.now();
  return {
    id,
    createdAt: now,
    updatedAt: now,
    sizeProfile: {},
    preferences: {},
    messages: [],
  };
}

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, CaddieSession>();

  async get(id: string): Promise<CaddieSession | null> {
    const session = this.sessions.get(id);
    if (!session) return null;
    if (Date.now() - session.updatedAt > TTL_MS) {
      this.sessions.delete(id);
      return null;
    }
    return session;
  }

  async getOrCreate(id: string): Promise<CaddieSession> {
    const existing = await this.get(id);
    if (existing) return existing;
    const session = blank(id);
    this.sessions.set(id, session);
    return session;
  }

  async save(session: CaddieSession): Promise<void> {
    session.updatedAt = Date.now();
    if (session.messages.length > MAX_MESSAGES) {
      session.messages = session.messages.slice(-MAX_MESSAGES);
    }
    session.messages = session.messages.map(stripAttachment);
    this.sessions.set(session.id, session);
    this.sweep();
  }

  /**
   * Mutates the stored session in place. A tool and the route that called it
   * both hold a reference to the same object, so replacing it here would let
   * whichever of them saves last silently undo the other.
   */
  async patch(id: string, patch: Partial<Omit<CaddieSession, 'id'>>): Promise<CaddieSession> {
    const session = await this.getOrCreate(id);
    const sizeProfile = { ...session.sizeProfile, ...defined(patch.sizeProfile ?? {}) };
    const preferences = { ...session.preferences, ...defined(patch.preferences ?? {}) };

    Object.assign(session, defined(patch), { sizeProfile, preferences });
    await this.save(session);
    return session;
  }

  async append(id: string, messages: CaddieMessage[]): Promise<void> {
    const session = await this.getOrCreate(id);
    session.messages.push(...messages);
    await this.save(session);
  }

  async restore(id: string, state: CaddieState): Promise<CaddieSession> {
    const session = await this.getOrCreate(id);
    // Replaced, not merged: the client's copy is the conversation now, and
    // merging would resurrect whatever this instance happened to remember
    // from an older turn of the same session.
    Object.assign(session, state);
    await this.save(session);
    return session;
  }

  private sweep(): void {
    const cutoff = Date.now() - TTL_MS;
    for (const [id, session] of this.sessions) {
      if (session.updatedAt < cutoff) this.sessions.delete(id);
    }
  }
}

/**
 * In Redis when there is one, in memory otherwise.
 *
 * Chosen once at startup rather than per call, so a Redis blip does not
 * silently move a conversation between two different stores.
 */
export const sessions: SessionStore = redisEnabled() ? new RedisSessionStore() : new MemorySessionStore();
