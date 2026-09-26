import type { Product } from '@caddie/shared';
import { parseRange, rangeOf, type Range } from '../catalog/audience.js';
import { parseColours } from '../catalog/colour.js';
import { categoriesAsked, categoriesOf, withoutSize, sizeInRequest, type Category } from '../catalog/constraints.js';
import { resolveCustomerProductIdentity } from '../catalog/productIdentity.js';
import { productById } from '../catalog/sync.js';
import { log } from '../lib/logger.js';
import { logFact, trustedShopperFacts } from '../shopper/facts.js';
import { durablePart, mergeProfile, readIntent, standingPart, type FactSource, type ShopperProfile } from '../shopper/profile.js';
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
/** "Different colours", "other colours": a change of colour, so any colour held so far is let go. */
const NEW_COLOURS = /\b(different|other|another|more|new)\s+colou?r(s|ways?)?\b|\bcolou?rs?\s+(else|instead)\b/i;

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
  return title.split(/\s+-\s+/)[0]!.trim();
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
  if (categoriesAsked(withoutSize(text, sizeInRequest(text))).length || parseRange(text).range || productNamed(text)) return false;
  return FOLLOW_UP.test(text) || text.split(/\s+/).length <= 3;
}

/**
 * The focus after this message. Their words only - the model's arguments and
 * what is on screen are not read here.
 */
export function readFocus(said: string, prior: ShoppingFocus | undefined, turn: number): { focus: ShoppingFocus | undefined; change: FocusChange } {
  const text = said.trim();
  if (!text) return { focus: prior, change: 'none' };
  const kinds = categoriesAsked(withoutSize(text, sizeInRequest(text)));
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
  if (prior && FOLLOW_UP.test(text)) {
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
  };
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
  const read = readFocus(said, prior, customerTurn(session));
  let { focus } = read;
  const { change } = read;
  /*
   * The session's constraints carry through a follow-up - "another one",
   * "cheaper", "different colours" - and through a new request for the same
   * kind of garment. A new mission does not inherit them: after "I need a
   * waterproof jacket", "show me polos" is polos, not waterproof polos. Only
   * what this message says holds for it, with the products they chose or
   * turned down (their actions, not a request). Their durable facts are
   * untouched - they apply to every mission (shopper/facts.ts).
   */
  if (focus && prior?.constraints && focus !== prior) {
    const fresh = newMission(prior, focus, change);
    const { liked, rejected } = prior.constraints;
    const constraints: ShoppingConstraints = fresh ? { ...(liked ? { liked } : {}), ...(rejected ? { rejected } : {}), ...constraintsIn(said) } : prior.constraints;
    if (fresh) log.info('focus.new_mission', { sessionId, prior: describeFocus(prior), resolved: describeFocus(focus), dropped: Object.keys(prior.constraints).filter((key) => !(key in constraints)) });
    focus = { ...focus, ...(Object.keys(constraints).length ? { constraints } : {}) };
    if (!Object.keys(constraints).length) delete focus.constraints;
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
