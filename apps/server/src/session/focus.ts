import type { Product } from '@caddie/shared';
import { parseRange, rangeOf, type Range } from '../catalog/audience.js';
import { parseColours } from '../catalog/colour.js';
import { categoriesAsked, categoriesOf, withoutSize, sizeInRequest, type Category } from '../catalog/constraints.js';
import { resolveCustomerProductIdentity } from '../catalog/productIdentity.js';
import { productById } from '../catalog/sync.js';
import { log } from '../lib/logger.js';
import { designTitle } from '../catalog/commerce.js';
import { logFact, trustedShopperFacts } from '../shopper/facts.js';
import { durablePart, mergeProfile, readIntent, standingPart, type FactSource, type ShopperProfile } from '../shopper/profile.js';
import { resolveProduct } from './screen.js';
import { sessions, type CaddieSession } from './store.js';

/**
 * What the customer is shopping for right now - decided in code, from their
 * own words, once a turn.
 *
 * Asked for "men's jackets and polos", then "polos", then "different
 * colours", the Caddie showed the Clima Jacket in its other colours: the
 * jacket cards were still on screen, and the model picked the product for
 * "different colours" itself. For days each fix was a line in the prompt.
 * This is the fix that does not depend on the model: the most recent thing
 * the customer explicitly asked for is the focus, a short follow-up inherits
 * it, and the tools hold the model's picks to it.
 *
 * Only three things move it:
 *   explicit     their words name a kind of garment, a range or a product
 *   card-action  they tapped an option on a product's card (routes/session.ts)
 *   inherited    a follow-up - "different colours", "cheaper", "is it
 *                waterproof?" - keeps it, taking any colour they add
 *
 * Being on screen is not one of them. Cards stay visible long after the
 * conversation has moved on, and "whatever is showing" is exactly how the
 * jackets came back.
 */
export interface ShoppingFocus {
  /** The kinds of garment asked for most recently - both, for "jackets and polos". */
  kinds: Category[];
  /** Kinds asked for alongside that are no longer the focus: kept for the record, never inherited. */
  pending?: Category[];
  range?: Range;
  /** A product they named or tapped; a design ("Clima Jacket 3.0") for its whole family. */
  productId?: string;
  design?: string;
  /** Colours they constrained this request to - never kept after "different colours". */
  colours?: string[];
  /** Their words that set it. */
  request: string;
  /** Which of their messages set it, counted from one. */
  turn: number;
  source: 'explicit' | 'card-action' | 'inherited';
  /**
   * What this shopping session asks of everything shown, from their words
   * along the way: "only navy", "under £30", "a relaxed fit", "for the rain",
   * and what they chose or turned down. Carried through every change of
   * focus - a budget said about polos still holds when they move to jackets -
   * and gone with New chat. Never a fact about the customer: that needs
   * words that say so (shopper/profile.ts durablePart).
   */
  constraints?: ShoppingConstraints;
  /**
   * Which mission this is, counted from one. A mission is what they set out
   * to shop for: it changes when they ask for a kind of garment they were
   * not on, or choose a pack (Phase 3B). A size said, a waiting basket add
   * and a pack's choices belong to the mission they were given in.
   */
  mission?: number;
  /** The customer turn the mission began on. */
  missionTurn?: number;
  /**
   * The pack they are putting together, by handle - the one a bare "34"
   * answers. Set when a pack is shown or its choices are; let go when they
   * ask for something else, choose another pack, or start a New chat. Its
   * choices stay in packChoices; its last build in packsShown.
   */
  pack?: string;
  /**
   * A piece of that pack being replaced: which step, the candidates shown for
   * it (only products the step takes), and the size asked for them ("another
   * jacket available in small"). Lives only while the pack is in hand; ended
   * by the swap, by leaving the pack, or by New chat. What a later "add this
   * instead" or "I like black" is about (tools/index.ts completeReplacement).
   */
  replacing?: {
    step: number;
    candidates: string[];
    size?: string;
    /**
     * A swap the Caddie has just offered, waiting for their yes: the product
     * named ("swap the Warrior for the Caddy Cloud in S?"), or none for "I can
     * swap it for another jacket in S - shall I?", whose yes shows the choices.
     * The customer turn it was offered on - only the next one can confirm it.
     */
    /** The swap offered, or - `suggested` - one candidate named with no swap asked: "replace it" next turn means this one. */
    offer?: { productId?: string; turn: number; suggested?: boolean };
    /**
     * The candidates the model has looked at this turn (get_product_details
     * on a product the step takes). Exactly one is its selection, made by id
     * - what an offer this turn is bound to before a word of it is written.
     * Two is no selection.
     */
    proposed?: { ids: string[]; turn: number };
  };
}

export type ShoppingConstraints = Pick<ShopperProfile, 'colours' | 'avoidColours' | 'budget' | 'fit' | 'layering' | 'features' | 'weather' | 'liked' | 'rejected' | 'justThis'>;
const CONSTRAINT_FIELDS = ['colours', 'avoidColours', 'budget', 'fit', 'layering', 'features', 'weather', 'liked', 'rejected', 'justThis'] as const;

export type FocusChange = 'explicit' | 'inherited' | 'none';

/**
 * A message that carries on with the current focus rather than starting
 * something new: "different colours", "another one", "show me more",
 * "cheaper", "more like this", "what sizes", "is it waterproof", "add it",
 * "this one".
 */
const FOLLOW_UP =
  /\b(different|other|others|another|more|cheaper|cheapest|less expensive|similar|like (?:this|that|these|those|it)|same|it|its|this|that|these|those|them|one|ones|sizes?|colou?rs?|colou?rways?|waterproof|water[- ]resistant|breathable|warm|stretch|in stock|price|how much|instead|else|lighter|warmer|add)\b/i;
/**
 * "I want something warm but sleeveless", "do you have anything for the
 * rain": a new request in its own words, not a follow-up - unless it also
 * carries on ("I want another one", "something cheaper"). "Warm" alone once
 * made it a follow-up to the jackets before.
 */
const NEW_REQUEST = /\b(?:i (?:want|need|would like|'d like|am after|'m after|am looking for|'m looking for)|looking for|do you (?:have|sell|do)|have you got)\s+(?:something|anything|a|an|some)\b/i;
const CARRIES_ON = /\b(another|different|other|others|cheaper|cheapest|similar|same|more like|instead|else)\b/i;
function newRequest(text: string): boolean {
  return NEW_REQUEST.test(text) && !CARRIES_ON.test(text);
}

/** "Different colours", "other colours": a change of colour, so any colour held so far is let go. */
const NEW_COLOURS = /\b(different|other|another|more|new)\s+colou?r(s|ways?)?\b|\bcolou?rs?\s+(else|instead)\b/i;

/**
 * A garment named as context rather than asked for: "to wear over a hoodie",
 * "something under my jacket", "what goes with these trousers". The layering
 * reader still hears it (shopper/profile.ts); the focus does not take it as
 * the kind they want. "Over a hoodie" once made hoodies the thing being
 * shopped for.
 */
const GARMENT_WORD = String.raw`(?:hoodies?|jumpers?|sweaters?|sweatshirts?|jackets?|coats?|gilets?|vests?|polos?|shirts?|tees?|t-shirts?|mid-?layers?|base ?layers?|trousers|shorts|skorts?|joggers?|waterproofs?|layers?)`;
const CONTEXT_GARMENT = new RegExp(
  String.raw`\b(?:over|under|underneath|beneath|on top of|to go with|goes with|go with|to match|that matches|matching)\s+(?:a|an|my|the|your|his|her|their|this|that|these|those)?\s*(?:[a-z'-]+\s+){0,2}?` + GARMENT_WORD + String.raw`\b`,
  'gi',
);

/** The kinds of garment their words ask for - sizes and contextual garments ("over a hoodie") left out. */
export function requestedKinds(text: string): Category[] {
  return categoriesAsked(withoutSize(text, sizeInRequest(text)).replace(CONTEXT_GARMENT, ' '));
}

/** "My usual colours", "the colours I normally wear". */
const USUAL_COLOURS = /\b(?:my|the)\s+(?:usual|normal|regular|standard|favourite|favorite)\s+colou?rs?\b|\bcolou?rs?\s+i\s+(?:usually|normally|always)\s+wear\b/i;

/** How many messages the customer has sent, this one included. */
export function customerTurn(session: CaddieSession, counting = true): number {
  return session.messages.filter((message) => message.role === 'user').length + (counting ? 1 : 0);
}

/**
 * A product their words name - read by the one product-name reader the
 * basket and search use too (catalog/productIdentity.ts), so "the product
 * they are shopping for" and "the product they asked to add" can never be
 * two readings of the same words. Several products it could be: no product
 * focus, only the kind.
 */
function productNamed(said: string): { product: Product; design: string } | null {
  const identity = resolveCustomerProductIdentity(said);
  if (identity.status === 'exact') return { product: identity.product, design: identity.design };
  if (identity.status === 'family') return { product: identity.products[0]!, design: identity.design };
  return null;
}

/** "CLIMA JACKET 3.0 - NAVY" is the Clima Jacket 3.0 design. */
export function designOf(title: string): string {
  return designTitle(title);
}

/** The kinds a product is: a Clima Jacket is a jacket. */
export function kindsOf(product: Product): Category[] {
  return [...categoriesOf(product)];
}

/** Whether a product is of the kind in focus (or there is no kind to hold it to). */
export function inFocus(product: Product, focus: ShoppingFocus | undefined): boolean {
  if (!focus?.kinds.length) return true;
  return kindsOf(product).some((kind) => focus.kinds.includes(kind));
}

/** A follow-up to the current focus: no new kind, range or product named, and a follow-up's words - or very few. */
export function isFollowUp(said: string): boolean {
  const text = said.trim();
  if (!text) return false;
  if (requestedKinds(text).length || parseRange(text).range || productNamed(text)) return false;
  if (newRequest(text)) return false;
  return FOLLOW_UP.test(text) || text.split(/\s+/).length <= 3;
}

/**
 * The focus after this message. Their words only - the model's arguments and
 * what is on screen are not read here.
 */
export function readFocus(said: string, prior: ShoppingFocus | undefined, turn: number): { focus: ShoppingFocus | undefined; change: FocusChange } {
  const text = said.trim();
  if (!text) return { focus: prior, change: 'none' };
  const kinds = requestedKinds(text);
  const range = parseRange(text).range ?? undefined;
  const named = productNamed(text);
  const colours = NEW_COLOURS.test(text) ? [] : parseColours(text).colours.map((colour) => colour.word);

  // A product named: that product, of its own kind and range.
  if (named) {
    const own = kindsOf(named.product);
    return {
      change: 'explicit',
      focus: {
        // Its own kind: "the Clima Jacket" is a jacket, whatever else was said with it.
        kinds: own.length ? own.slice(0, 1) : kinds,
        range: range ?? rangeOf(named.product),
        productId: named.product.id,
        design: named.design,
        ...(colours.length ? { colours } : {}),
        request: text,
        turn,
        source: 'explicit',
      },
    };
  }

  // A kind of garment named: that kind, in the range they said or were already shopping.
  if (kinds.length) {
    const dropped = (prior?.kinds ?? []).filter((kind) => !kinds.includes(kind));
    const pending = [...new Set([...(prior?.kinds.length && prior.kinds.length > 1 ? dropped : []), ...(prior?.pending ?? [])])].filter((kind) => !kinds.includes(kind));
    const keptRange = range ?? prior?.range;
    return {
      change: 'explicit',
      focus: {
        kinds,
        ...(pending.length ? { pending } : {}),
        ...(keptRange ? { range: keptRange } : {}),
        ...(colours.length ? { colours } : {}),
        request: text,
        turn,
        source: 'explicit',
      },
    };
  }

  // Only a range: "show me the ladies ones" - the same kinds, for them.
  if (range && prior) {
    return {
      change: 'explicit',
      focus: { kinds: prior.kinds, ...(prior.pending ? { pending: prior.pending } : {}), range, ...(colours.length ? { colours } : {}), request: text, turn, source: 'explicit' },
    };
  }
  if (range) return { change: 'explicit', focus: { kinds: [], range, ...(colours.length ? { colours } : {}), request: text, turn, source: 'explicit' } };

  // A follow-up keeps the focus, with any colour they add - and lets go of the colour on "different colours".
  if (prior && FOLLOW_UP.test(text) && !newRequest(text)) {
    const { colours: _held, ...rest } = prior;
    const nextColours = NEW_COLOURS.test(text) ? undefined : colours.length ? colours : prior.colours;
    return { change: 'inherited', focus: { ...rest, ...(nextColours?.length ? { colours: nextColours } : {}), source: prior.source === 'card-action' ? 'card-action' : 'inherited' } };
  }
  return { focus: prior, change: 'none' };
}

/** A tap on a product's card: that product is what "it" and "what sizes?" mean now. */
export function focusFromCard(product: Product, prior: ShoppingFocus | undefined, turn: number): ShoppingFocus {
  const own = kindsOf(product);
  return {
    kinds: own.slice(0, 1),
    ...(prior?.pending ? { pending: prior.pending } : {}),
    range: rangeOf(product),
    productId: product.id,
    design: designOf(product.title),
    request: prior?.request ?? '',
    turn,
    source: 'card-action',
    ...(prior?.constraints ? { constraints: prior.constraints } : {}),
    // A tap is not a new mission: the mission, and the pack being built, carry on.
    ...(prior?.mission ? { mission: prior.mission, missionTurn: prior.missionTurn ?? prior.turn } : {}),
    ...(prior?.pack ? { pack: prior.pack } : {}),
  };
}

/**
 * A card they point at in words - "the second one", "the navy one", "that
 * one" - is what they are talking about now. Pointed at, not merely on
 * screen: a card being visible never moves the focus.
 */
function pointedAt(session: CaddieSession, said: string): Product | null {
  // A pack's card lists the pack itself first; "the first one" there is a piece question for the pack reader.
  if (session.lastShown?.kind === 'pack') return null;
  const found = resolveProduct(session, said);
  if (!found) return null;
  if (/^(number \d|last on screen)/.test(found.how)) return found.product;
  if (found.how.startsWith('on screen, from what they described') && /\b(one|this|that|it)\b/i.test(said)) return found.product;
  return null;
}

function focusFromReference(product: Product, prior: ShoppingFocus | undefined, said: string, turn: number): ShoppingFocus {
  const colours = parseColours(said).colours.map((colour) => colour.word);
  return {
    kinds: kindsOf(product).slice(0, 1),
    ...(prior?.pending ? { pending: prior.pending } : {}),
    range: rangeOf(product),
    productId: product.id,
    design: designOf(product.title),
    ...(colours.length ? { colours } : {}),
    request: said,
    turn,
    source: 'explicit',
  };
}

/** Words that keep a pack in hand while naming a garment: "change the jacket", "a different polo for the pack". */
const PACK_WORDS = /\b(pack|bundle|deal|change|swap|replace|instead|in it|for it)\b/i;

/** Asking for something in place of a piece: it is sold out, another one, one that is available. */
const REPLACING_PIECE = /\b(sold out|out of stock|not available|unavailable|isn'?t available|another|other|different|alternative|instead|replace|swap)\b/i;

/**
 * About a piece of the pack in hand: "the Warrior jacket is sold out, show me
 * another jacket in small". It names a product and a kind, so it read as a
 * new mission, the pack was let go, and the swap became a standalone add
 * (preview store). A piece of the pack named - or its kind - with words asking
 * for something in its place keeps the pack in hand. "Show me polos" says
 * nothing of the kind, and still leaves it.
 */
export function aboutPackPiece(session: CaddieSession, said: string): boolean {
  const handle = session.activeShoppingContext?.pack;
  if (!handle || !REPLACING_PIECE.test(said)) return false;
  const pieces = (session.packsShown?.[handle]?.items ?? []).map((item) => (item.id ? productById(item.id) : null)).filter((p): p is Product => !!p);
  const named = productNamed(said)?.product;
  if (named && pieces.some((piece) => designOf(piece.title) === designOf(named.title))) return true;
  const kinds = requestedKinds(said);
  return kinds.length > 0 && kinds.every((kind) => pieces.some((piece) => kindsOf(piece).includes(kind)));
}

/**
 * About the piece being replaced, while it is: "show me black jackets", "I
 * prefer the Hexa", "what jackets do you have in S?" - the garment of that
 * step, or a product it takes. The search is a step in replacing the pack's
 * jacket, never a new mission; "show me polos", while a jacket is replaced,
 * still is one.
 */
function aboutReplacement(session: CaddieSession, said: string): boolean {
  const focus = session.activeShoppingContext;
  const replacing = focus?.replacing;
  const handle = focus?.pack;
  if (!replacing || !handle) return false;
  // Bought on its own is not the pack's.
  if (/\b(separately|on its own|on their own|as well|extra|outside the pack|full price)\b/i.test(said)) return false;
  // Only the piece going out and what can replace it: the pack's other pieces say nothing about this step.
  const candidates = replacing.candidates
    .map((id) => productById(id))
    .filter((p): p is Product => !!p);
  const outgoing = productById(session.packsShown?.[handle]?.items[replacing.step]?.id ?? '');
  const stepKinds = new Set([...(outgoing ? kindsOf(outgoing) : []), ...candidates.flatMap((candidate) => kindsOf(candidate))]);
  const named = productNamed(said)?.product;
  if (named) return kindsOf(named).some((kind) => stepKinds.has(kind));
  const kinds = requestedKinds(said);
  return kinds.length > 0 && kinds.every((kind) => stepKinds.has(kind));
}

/** Giving a size: "waist is 32", "leg length 34", "my top size would be medium", "for the trouser 32". */
const GIVES_SIZE = /\b(?:waist|leg|inside leg|inseam|top size|size|chest)\b[^.?!]{0,25}?\b(?:\d{2}|x{0,3}s|m|x{0,3}l|[2-5]xl|small|medium|large|extra large)\b/i;

/**
 * Sizes for the pack in hand: "my top size would be medium and for the
 * trouser my waist is 32 and leg length is 34". It names a kind - trousers -
 * so it read as a new request, the pack was let go, and none of the sizes
 * reached it: the Caddie asked for them again, three times (preview store).
 * A size given for kinds the pack holds - or for no kind at all - is the
 * pack's; "show me trousers in 32" names no size of the pack's and still
 * leaves it only through other words.
 */
function givesPackSizes(session: CaddieSession, said: string): boolean {
  const handle = session.activeShoppingContext?.pack;
  if (!handle || !(GIVES_SIZE.test(said) || sizeInRequest(said))) return false;
  if (/\b(show|see|find|search|browse|look for|looking for|any|other)\b/i.test(said)) return false;
  // A product named, or bought on its own - "add the Hexa in S separately" - is not a size for the pack.
  if (productNamed(said) || /\b(separately|on its own|on their own|as well|extra|outside the pack|full price)\b/i.test(said)) return false;
  const pieces = (session.packsShown?.[handle]?.items ?? []).map((item) => (item.id ? productById(item.id) : null)).filter((p): p is Product => !!p);
  const kinds = requestedKinds(said);
  return kinds.every((kind) => pieces.some((piece) => kindsOf(piece).includes(kind)));
}

/**
 * The pack they are building, set by the tool that shows it: a new pack is a
 * new mission, the same pack again is not.
 */
export async function setActivePack(sessionId: string, handle: string): Promise<void> {
  const session = await sessions.getOrCreate(sessionId);
  const prior = session.activeShoppingContext;
  if (prior?.pack === handle) return;
  const turn = customerTurn(session);
  /*
   * Another pack: nothing of the old one's replacement comes with it. A step
   * index, candidates and an offered swap from Mixed Conditions pointed into
   * Cool & Wet's steps once the pack in hand changed (audit, V1 task 2).
   */
  const { replacing: stale, ...kept } = prior ?? ({} as ShoppingFocus);
  if (stale) log.info('focus.replacing_cleared', { sessionId, from: prior?.pack ?? null, to: handle });
  const focus: ShoppingFocus = prior
    ? { ...(kept as ShoppingFocus), pack: handle, mission: (prior.mission ?? 1) + 1, missionTurn: turn }
    : { kinds: [], request: '', turn, source: 'explicit', pack: handle, mission: 1, missionTurn: turn };
  log.info('focus.pack', { sessionId, pack: handle, prior: prior?.pack ?? null, mission: focus.mission });
  await sessions.patch(sessionId, { activeShoppingContext: focus });
}

/** The product in focus, when there is one and it still exists. */
export function focusProduct(focus: ShoppingFocus | undefined): Product | null {
  return focus?.productId ? productById(focus.productId) : null;
}

const KIND_WORD: Partial<Record<Category, string>> = { trousers: 'trousers', shorts: 'shorts', socks: 'socks', shoes: 'shoes' };
const RANGE_WORD: Record<Range, string> = { men: "men's", women: 'ladies', kids: 'kids' };

/** "men's polos", "ladies jackets and polos", "the Clima Jacket 3.0" - for logs and the model's context. */
export function describeFocus(focus: ShoppingFocus | undefined): string {
  if (!focus) return 'nothing yet';
  if (focus.design) return `the ${focus.design}`;
  const kinds = focus.kinds.map((kind) => KIND_WORD[kind] ?? `${kind}s`).join(' and ');
  return [focus.colours?.length ? focus.colours.join(' or ') : '', focus.range ? RANGE_WORD[focus.range] : '', kinds || 'anything'].filter(Boolean).join(' ');
}

/** The words to search for the focus: its design, else its kinds - with any colour held. */
export function focusQuery(focus: ShoppingFocus): string {
  const kinds = focus.kinds.map((kind) => KIND_WORD[kind] ?? kind).join(' ');
  return [focus.design ?? kinds, ...(focus.colours ?? [])].filter(Boolean).join(' ');
}

/**
 * Read this message into the session's focus, before any tool runs. Called
 * once a turn from every way in - typed chat and the voice route through
 * converse(), Vapi from its tool route - so a spoken "different colours"
 * resolves exactly as a typed one does.
 */
export async function noteShoppingFocus(sessionId: string, said: string): Promise<ShoppingFocus | undefined> {
  const session = await sessions.getOrCreate(sessionId);
  const prior = session.activeShoppingContext;
  const turn = customerTurn(session);
  const read = readFocus(said, prior, turn);
  let { focus, change } = read;
  // "The second one", "the navy one": the card they point at is what they are talking about now.
  if (change !== 'explicit') {
    const pointed = pointedAt(session, said);
    if (pointed && pointed.id !== prior?.productId) {
      focus = focusFromReference(pointed, prior, said, turn);
      change = 'explicit';
    }
  }
  /*
   * The session's constraints carry through a follow-up - "another one",
   * "cheaper", "different colours" - and through a new request for the same
   * kind of garment. A new mission does not inherit them: after "I need a
   * waterproof jacket", "show me polos" is polos, not waterproof polos. Only
   * what this message says holds for it, with the products they chose or
   * turned down (their actions, not a request). Their durable facts are
   * untouched - they apply to every mission (shopper/facts.ts).
   */
  if (focus && focus !== prior) {
    /*
     * The mission, and the pack in hand - one definition for both. A new
     * mission is a kind of garment they were not on, or leaving the pack they
     * were building for a garment or product without the pack in their words.
     * It is numbered afresh, which ends a basket add left waiting in the last
     * one (the gateway checks it) and scopes the sizes said in it; and its
     * constraints start again from this message (Phase 3A), keeping only the
     * products they chose or turned down. A follow-up, the same kind again,
     * or a change to a piece of the pack ("change the jacket") carries on.
     */
    const leavesPack =
      !!prior?.pack &&
      change === 'explicit' &&
      (requestedKinds(said).length > 0 || !!productNamed(said)) &&
      !PACK_WORDS.test(said) &&
      !aboutPackPiece(session, said) &&
      !givesPackSizes(session, said) &&
      !aboutReplacement(session, said);
    const fresh = !!prior && (newMission(prior, focus, change) || leavesPack);
    const mission = !prior ? 1 : fresh ? (prior.mission ?? 1) + 1 : (prior.mission ?? 1);
    const missionTurn = !prior || fresh ? turn : (prior.missionTurn ?? prior.turn);
    let constraints = prior?.constraints;
    if (fresh && prior?.constraints) {
      const { liked, rejected } = prior.constraints;
      constraints = { ...(liked ? { liked } : {}), ...(rejected ? { rejected } : {}), ...constraintsIn(said) };
    }
    if (fresh) log.info('focus.new_mission', { sessionId, prior: describeFocus(prior), resolved: describeFocus(focus), mission, dropped: Object.keys(prior?.constraints ?? {}).filter((key) => !(key in (constraints ?? {}))) });
    if (leavesPack) log.info('focus.pack_left', { sessionId, pack: prior!.pack, utterance: said.slice(0, 120) });
    const { pack: _pack, constraints: _constraints, ...rest } = focus;
    focus = {
      ...rest,
      ...(constraints && Object.keys(constraints).length ? { constraints } : {}),
      mission,
      missionTurn,
      ...(prior?.pack && !leavesPack ? { pack: prior.pack, ...(prior.replacing ? { replacing: prior.replacing } : {}) } : {}),
    };
  }
  /*
   * "Go back to my usual colours": the colours they told us they wear, in
   * place of the red this search was in. Without this the red was held, as
   * any colour is on a follow-up.
   */
  const backToUsual = USUAL_COLOURS.test(said);
  if (focus && backToUsual) {
    const { colours: _held, ...rest } = focus;
    const usual = trustedShopperFacts(session).colours?.words ?? [];
    focus = usual.length ? { ...rest, colours: usual } : rest;
  }
  if (change === 'none' && !backToUsual) return prior;
  log.info('focus.updated', {
    sessionId,
    utterance: said.slice(0, 160),
    prior: describeFocus(prior),
    resolved: describeFocus(focus),
    source: change,
    ...(focus?.mission ? { mission: focus.mission } : {}),
    ...(focus?.pack ? { pack: focus.pack } : {}),
    ...(focus?.pending?.length ? { pending: focus.pending } : {}),
  });
  if (focus && JSON.stringify(focus) !== JSON.stringify(prior)) await sessions.patch(sessionId, { activeShoppingContext: focus });
  return focus;
}

/**
 * Whether this request starts a new mission: named explicitly, and of kinds
 * the focus was not on. "Show me jackets" and "what about jackets?" after red
 * polos both are - a garment kind named is a new request however it is
 * phrased (isFollowUp says the same). A range alone ("the ladies ones"), the
 * same kind again, or a product of that kind carries on the mission. A focus
 * with no kind yet ("my budget is £50" before anything was asked for) is not
 * a mission to leave.
 */
export function newMission(prior: ShoppingFocus, next: ShoppingFocus, change: FocusChange): boolean {
  if (change !== 'explicit' || !prior.kinds.length || !next.kinds.length) return false;
  return !next.kinds.some((kind) => prior.kinds.includes(kind));
}

/** What one message asks of this shopping session - read the same way wherever it is kept (shopper/remember.ts). */
export function constraintsIn(text: string): ShoppingConstraints {
  const intent = readIntent(text);
  const held = { ...standingPart(intent), ...durablePart(intent, text) } as Partial<ShopperProfile>;
  return Object.fromEntries(CONSTRAINT_FIELDS.filter((key) => key !== 'liked' && key !== 'rejected' && held[key] !== undefined).map((key) => [key, held[key]])) as ShoppingConstraints;
}

/**
 * Something that holds for the rest of this shopping session - a budget, a
 * colour rule, a fit, a product they chose or turned down. The customer's
 * words or their own actions only: a model's reading of them, or something
 * we worked out, is not their evidence and is not kept (Phase 3A).
 */
export async function noteShoppingConstraints(sessionId: string, update: ShoppingConstraints, source: FactSource): Promise<ShoppingConstraints | undefined> {
  const fields = CONSTRAINT_FIELDS.filter((field) => update[field] !== undefined);
  if (!fields.length) return undefined;
  if (source === 'model-hint' || source === 'derived-recommendation') {
    for (const field of fields) logFact(sessionId, field, source, 'shopping-session', false, update[field], 'not the customer’s evidence');
    return undefined;
  }
  const session = await sessions.getOrCreate(sessionId);
  const prior = session.activeShoppingContext;
  const picked = Object.fromEntries(fields.map((field) => [field, update[field]])) as ShoppingConstraints;
  const { provenance: _provenance, ...merged } = mergeProfile(prior?.constraints, picked);
  const constraints = Object.fromEntries(CONSTRAINT_FIELDS.filter((field) => merged[field] !== undefined).map((field) => [field, merged[field]])) as ShoppingConstraints;
  // No focus yet ("under £30" before any garment): a focus of nothing in particular, holding them.
  const focus: ShoppingFocus = prior ? { ...prior, constraints } : { kinds: [], request: '', turn: customerTurn(session), source: 'explicit', constraints };
  await sessions.patch(sessionId, { activeShoppingContext: focus });
  for (const field of fields) logFact(sessionId, field, source, 'shopping-session', true, update[field]);
  return constraints;
}

/** The piece of the pack in hand being replaced, and what was shown for it - or ended (undefined). */
export async function setReplacement(sessionId: string, replacing: ShoppingFocus['replacing']): Promise<void> {
  const session = await sessions.getOrCreate(sessionId);
  const prior = session.activeShoppingContext;
  if (!prior?.pack) return;
  const { replacing: _old, ...rest } = prior;
  /*
   * A piece of the pack being replaced outranks a standalone add left
   * waiting: "M" or "yes" is for the pack now, never the add of a jacket on
   * its own that was asked about before (audit, V1 task 2).
   */
  const standalone = replacing && !_old && session.pendingAction?.type === 'add-product';
  await sessions.patch(sessionId, { activeShoppingContext: replacing ? { ...rest, replacing } : rest, ...(standalone ? { pendingAction: undefined } : {}) });
  if (standalone) log.info('pending.cleared_for_pack', { sessionId, pack: prior.pack });
  log.info('focus.replacing', { sessionId, pack: prior.pack, ...(replacing ? { step: replacing.step, candidates: replacing.candidates.length, size: replacing.size ?? null } : { ended: true }) });
}
