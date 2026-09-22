import type { CaddieMessage, SizeInput } from '@caddie/shared';

/**
 * Day 7 - Conversation memory.
 *
 * What the customer has already told us, so "cheaper", "different colour" and
 * "show me another" mean something. In-memory for the sprint; the interface is
 * here so we can drop in Redis for the pilot without touching callers.
 */

export interface CaddieSession {
  id: string;
  createdAt: number;
  updatedAt: number;
  /** Shopify cart id, once the customer adds anything. */
  cartId?: string;
  /** Everything we have learned about fit. */
  sizeProfile: SizeInput;
  /**
   * Last thing we showed, so "that one" and "cheaper" resolve.
   *
   * Titles are kept alongside the ids on purpose: the model is told what is on
   * screen, and a bare list of ids leaves it guessing which one the customer
   * means by "the shorts".
   */
  lastShown?: {
    kind: 'products' | 'pack' | 'outfit';
    items: Array<{ id: string; title: string }>;
    query?: string;
    budgetAmount?: number;
    colour?: string;
  };
  preferences: {
    colour?: string;
    budgetAmount?: number;
    currency?: string;
    /** Which range they are browsing, inferred from product tags. */
    audience?: 'men' | 'women';
  };
  messages: CaddieMessage[];
}

export interface SessionStore {
  get(id: string): Promise<CaddieSession | null>;
  getOrCreate(id: string): Promise<CaddieSession>;
  save(session: CaddieSession): Promise<void>;
  patch(id: string, patch: Partial<Omit<CaddieSession, 'id'>>): Promise<CaddieSession>;
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

  private sweep(): void {
    const cutoff = Date.now() - TTL_MS;
    for (const [id, session] of this.sessions) {
      if (session.updatedAt < cutoff) this.sessions.delete(id);
    }
  }
}

export const sessions: SessionStore = new MemorySessionStore();
