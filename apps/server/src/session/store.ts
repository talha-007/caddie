import type { CartExpectation } from '@caddie/shared';
import type { CaddieMessage, PageContext, SizeInput } from '@caddie/shared';
import { redisEnabled, redisUsable } from '../lib/redis.js';
import type { SizeRecommendationRecord } from '../shopper/facts.js';
import type { ShopperProfile } from '../shopper/profile.js';
import type { ShoppingFocus } from './focus.js';

/** A basket action waiting on the customer's next answer (see tools/actionGateway.ts). */
/** What a waiting action still needs from the customer. */
export type PendingNeed = 'size' | 'colour' | 'waist' | 'leg' | 'option' | 'line' | 'quantity' | 'confirmation' | 'outcome';

/**
 * A basket change handed to the widget, from validation to the cart's own
 * word on it (tools/cartOperations.ts). `dispatched` until the widget's
 * report bears the change out; then applied, failed, partial - or uncertain,
 * when the report could not settle it.
 */
export interface CartOperationRecord {
  id: string;
  kind: 'add-product' | 'update-line';
  status: 'dispatched' | 'applied' | 'failed' | 'partial' | 'uncertain';
  productId?: string;
  /** Numeric variant id of what goes in (or changes). */
  variantId?: string;
  quantity: number;
  /** A replacement: the line going out, as the basket held it. */
  outgoing?: { lineId: string; variantId: string; quantity: number; title: string; choice: string; fingerprint?: string };
  expect: CartExpectation;
  /** The basket at dispatch, numeric variant id to quantity - the baseline when the widget's own read is missing. */
  before: Record<string, number>;
  /** The theme cart the change was made for, when the widget had told us: a report about another cart does not settle it. */
  cartToken?: string;
  onApplied: { liked?: string[]; rejected?: string[]; lastAdded?: boolean };
  wording: { title: string; choice: string; quantity: number };
  source: string;
  turn: number;
  mission?: number;
  createdAt: number;
  resolvedAt?: number;
  /** What was said about it once settled - repeated for a duplicate report. */
  text?: string;
  error?: string;
  /** One of several lines taken out together (the whole basket, a pack): confirmed once, when the last of them settles. */
  batch?: { id: string; size: number; title: string };
}

/**
 * The one record of an action the Caddie asked something in order to finish
 * (tools/pending.ts, V1 task 3). Every question that exists to complete a
 * basket change writes one; the customer's next words are read against it
 * before the model runs, and a "yes" means this and nothing else. What "yes"
 * meant was once re-read from the Caddie's previous sentence, and a yes
 * inside a longer message meant nothing at all.
 */
export interface PendingAction {
  type: 'add-product' | 'add-pack' | 'replace-pack-piece' | 'update-line';
  /** add-product: the products it may finish with - the one named, or its colourways. replace-pack-piece: the replacement. */
  productIds: string[];
  /** Options already settled, kept when the answer fills in the rest. */
  options?: Record<string, string>;
  quantity?: number;
  /** add-pack, replace-pack-piece: the pack, and the step and piece being replaced. */
  pack?: string;
  step?: number;
  outgoing?: string;
  /** update-line: the basket line. */
  lineId?: string;
  /** update-line: every line the removal takes out when it is more than one - the whole basket, or a whole pack. */
  lineIds?: string[];
  /** The one thing it is waiting for now. */
  awaiting: PendingNeed;
  /** Everything still needed, first first. */
  missing?: PendingNeed[];
  /** Whether the customer has asked for it - so a field answered later needs no second "yes". */
  authorized?: boolean;
  /** The question asked, in the code's words - so the reply can be held to it. */
  question?: string;
  /** Their message count when it was asked. */
  turn: number;
  /** The shopping mission it was asked in (session/shoppingSession.ts) - an unrelated new mission ends it. */
  mission?: number;
  /** Handed to the widget under this operation id, awaiting the cart's word (awaiting 'outcome'): held so a second yes cannot send it again. */
  dispatched?: string;
  /** update-line: the line's variant, so the line can be found again if the cart re-keys it before their yes. */
  variantId?: string;
  /** update-line: the line's distinguishing fingerprint (properties, selling plan), for the same reason. */
  lineFingerprint?: string;
}
import { RedisSessionStore } from './redisStore.js';

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
  /**
   * Where the basket lives. 'theme': the store's own cart, in the shopper's
   * browser, changed by the widget - the one the bundle discounts apply to
   * and the theme's cart icon shows. Anything else: our Storefront API cart
   * (the dev harness). Set from the widget's x-caddie-cart header.
   */
  cartMode?: 'theme' | 'storefront';
  /**
   * What is in that basket, as of the last time any tool read or changed it.
   * The model is shown this each turn so "swap the orange polo" can find it.
   */
  basket?: Array<{
    lineId: string;
    productId: string;
    /** Numeric variant id, as the widget read it - what a replacement's line going out is matched by. */
    variantId?: string;
    /** What makes this line distinct from another of the same variant (properties, selling plan), as a fingerprint - never the values. */
    fingerprint?: string;
    title: string;
    variantTitle: string;
    quantity: number;
    /** The pack this line belongs to (its bundle id), when it is part of one. */
    bundle?: string;
    /** Which deal that pack is, by page handle. */
    bundleName?: string;
  }>;
  /** Packs the Caddie has put in the store cart, so a change replaces one rather than adding another. */
  packsAdded?: Array<{ handle: string; bundleId: string }>;
  /**
   * Measurements the customer gave (height, weight, chest, waist), with their
   * provenance in shopper.provenance. `usualSize`, `fitPreference` and
   * `audience` here are compatibility mirrors of the shopper profile, written
   * only by rememberShopper and read by nothing that decides (Phase 3A;
   * removed in 3B).
   */
  sizeProfile: SizeInput;
  /** The size the Caddie last worked out - advice, never their size. See shopper/facts.ts. */
  sizeRecommendation?: SizeRecommendationRecord;
  /**
   * Last thing we showed, so "that one" and "cheaper" resolve.
   *
   * Titles are kept alongside the ids on purpose: the model is told what is on
   * screen, and a bare list of ids leaves it guessing which one the customer
   * means by "the shorts".
   */
  lastShown?: {
    kind: 'products' | 'pack' | 'outfit';
    /** `slot` is set for an outfit, so a swap knows which one to rebuild. */
    items: Array<{ id: string; title: string; slot?: string }>;
    /** Outfit pieces already swapped out, so "another" never offers them again. */
    swappedOut?: string[];
    /** Set when the pack on screen is one of the store's bundle deals: its page handle. */
    bundle?: string;
    query?: string;
    budgetAmount?: number;
    colour?: string;
    /** An outfit: the size it was built for, so "add everything" adds each piece in it. */
    size?: string;
  };
  /**
   * The last outfit built, kept when a search replaces what is on screen, so
   * "swap the polo" still has an outfit to swap in. See outfitShown.
   */
  lastOutfit?: CaddieSession['lastShown'];
  /**
   * Products shown in the current run of searches, so "another one" leads
   * with something new. Started again by any search that is not asking for
   * another.
   */
  recentShown?: string[];
  /**
   * Options the customer picked on a product card themselves, by product id
   * (see CardChoice). Theirs for that product only - never their usual size.
   */
  cardChoices?: Record<string, { options: Record<string, string>; variantId?: string; at: number }>;
  /**
   * A basket action the customer asked for that is waiting on one thing
   * ("add the Elite Polo" - "what size?"). Their answer next turn finishes
   * that action, for those products, and nothing else: "M" cannot finish a
   * different product's add, and a turn about anything else lets it go.
   * Set and cleared only by the Action Gateway (tools/actionGateway.ts).
   */
  pendingAction?: PendingAction;
  /**
   * SHA-256 of the session's capability token (session/ownership.ts) - the
   * proof a request comes from the browser that owns this session. The token
   * itself is never stored, and this hash never leaves the server.
   */
  ownerHash?: string;
  /** The product the gateway last put in the basket, and when - what "make it two" and "remove it" mean. */
  lastAdded?: { productId: string; turn: number; byPending?: boolean; byOperation?: boolean };
  /** Basket changes handed to the widget, by operation id, and what became of each (tools/cartOperations.ts). */
  cartOperations?: Record<string, CartOperationRecord>;
  /** The theme cart's token as the widget last reported it. */
  cartToken?: string;
  /** The basket-change contract the widget on this session speaks (x-caddie-widget); absent for an older widget. */
  widgetContract?: string;
  /**
   * What the customer has chosen for each pack, by handle (see
   * tools/packState.ts): confirmed values only, and what they asked for that
   * the pack does not come in. Never a card's default or a model's guess.
   */
  packChoices?: Record<string, { top?: string; waist?: string; leg?: string; belt?: string; requested?: { top?: string; waist?: string; leg?: string } }>;
  /**
   * What the customer is shopping for now - the kind, range, product and
   * colours they last asked for, read from their own words (session/focus.ts).
   * Short follow-ups inherit it; what is on screen never moves it.
   */
  activeShoppingContext?: ShoppingFocus;
  /**
   * The product the last search led with, and its colour - history, so the
   * next lead can vary and "cheaper" has something to compare with when
   * nothing is in hand. Never what they are shopping for.
   */
  lastLead?: { id: string; colour: string };
  /** Products offered as the natural next piece already: each is offered once, never pushed again. */
  crossSellOffered?: string[];
  /**
   * When lastShown last changed - a card tapped before it was on an older
   * screen, and no longer what "add it" means (shoppingSession.ts).
   */
  shownAt?: number;
  /**
   * The tool results of the last couple of turns, for checking replies only
   * (verify.ts) - never sent to the model. "How much is the pack?" is
   * answered from the card on screen, whose price came a turn earlier.
   */
  recentEvidence?: string;
  /**
   * Every bundle deal shown this session, as it was last shown, by handle. So
   * "the mixed conditions pack" is the one they saw, not a fresh pick, and
   * "change the polo in the mixed pack" changes that pack even when Warm
   * Rounds is the one on screen.
   */
  packsShown?: Record<string, { items: Array<{ id: string; title: string }>; colour?: string; total?: number }>;
  /**
   * The storefront page the customer is on, from the last message that told
   * us. Held on the session because voice carries no context of its own - a
   * spoken "what size am I in this" arrives with nothing attached.
   */
  page?: PageContext;
  /**
   * What they have told us they want - budget and how strict it is, colours
   * required or preferred, fit, weather, what they turned down. See
   * shopper/profile.ts. Replaced whole on every change, never patched field by
   * field, so a stated "no longer" can remove something.
   */
  shopper?: ShopperProfile;
  /** The currency they shop in. (Phase 3A's colour, budget and range mirrors are gone: see shopper/facts.ts.) */
  preferences: {
    currency?: string;
  };
  messages: CaddieMessage[];
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
    // A new screen: a card tapped on the last one no longer speaks for them (shoppingSession.ts).
    if (patch.lastShown) session.shownAt = Date.now();
    // A finished (or abandoned) action clears what it was waiting on.
    if ('pendingAction' in patch && patch.pendingAction === undefined) delete session.pendingAction;
    await this.save(session);
    return session;
  }

  async append(id: string, messages: CaddieMessage[]): Promise<void> {
    const session = await this.getOrCreate(id);
    session.messages.push(...messages);
    await this.save(session);
  }

  private sweep(): void {
    const cutoff = Date.now() - TTL_MS;
    for (const [id, session] of this.sessions) {
      if (session.updatedAt < cutoff) this.sessions.delete(id);
    }
  }
}

/**
 * Redis for sharing, memory underneath it, always.
 *
 * Choosing one store at startup meant that when Redis stopped answering - a
 * wrong password, on the live server - every read and write waited on it and
 * every conversation hung. Now every session is also kept in this process,
 * Redis is used while it answers, and the newer of the two copies wins on
 * read, so a conversation carries on through a Redis outage and is not rolled
 * back when Redis returns. With more than one instance an outage means each
 * serves its own customers from memory until Redis is back.
 */
class ResilientSessionStore implements SessionStore {
  private readonly shared = new RedisSessionStore();
  private readonly local = new MemorySessionStore();

  async get(id: string): Promise<CaddieSession | null> {
    const [remote, mine] = await Promise.all([redisUsable() ? this.shared.get(id) : Promise.resolve(null), this.local.get(id)]);
    if (remote && mine) return remote.updatedAt >= mine.updatedAt ? remote : mine;
    return remote ?? mine;
  }

  async getOrCreate(id: string): Promise<CaddieSession> {
    return (await this.get(id)) ?? this.local.getOrCreate(id);
  }

  async save(session: CaddieSession): Promise<void> {
    await this.local.save(session);
    if (redisUsable()) await this.shared.save(session);
  }

  async patch(id: string, patch: Partial<Omit<CaddieSession, 'id'>>): Promise<CaddieSession> {
    const session = await this.getOrCreate(id);
    const sizeProfile = { ...session.sizeProfile, ...defined(patch.sizeProfile ?? {}) };
    const preferences = { ...session.preferences, ...defined(patch.preferences ?? {}) };
    Object.assign(session, defined(patch), { sizeProfile, preferences });
    // A new screen: a card tapped on the last one no longer speaks for them (shoppingSession.ts).
    if (patch.lastShown) session.shownAt = Date.now();
    // A finished (or abandoned) action clears what it was waiting on.
    if ('pendingAction' in patch && patch.pendingAction === undefined) delete session.pendingAction;
    await this.save(session);
    return session;
  }

  async append(id: string, messages: CaddieMessage[]): Promise<void> {
    const session = await this.getOrCreate(id);
    session.messages.push(...messages);
    await this.save(session);
  }
}

/** Resilient when Redis is configured; memory alone when it is not. */
export const sessions: SessionStore = redisEnabled() ? new ResilientSessionStore() : new MemorySessionStore();
