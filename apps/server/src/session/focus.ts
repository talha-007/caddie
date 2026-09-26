import type { Product } from '@caddie/shared';
import { parseRange, rangeOf, type Range } from '../catalog/audience.js';
import { parseColours } from '../catalog/colour.js';
import { categoriesAsked, categoriesOf, withoutSize, sizeInRequest, type Category } from '../catalog/constraints.js';
import { namingWords } from '../catalog/lookup.js';
import { allProducts, catalogueVersion, productById } from '../catalog/sync.js';
import { env } from '../env.js';
import { log } from '../lib/logger.js';
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
}

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

/** How many messages the customer has sent, this one included. */
export function customerTurn(session: CaddieSession, counting = true): number {
  return session.messages.filter((message) => message.role === 'user').length + (counting ? 1 : 0);
}

interface Design {
  name: string;
  /** Its own words - "clima" for the Clima Jacket 3.0, "elite" for the Elite Polo. */
  naming: string[];
  /** The garment words in its name - "jacket", "polo". */
  garments: string[];
  products: Product[];
}

let designs: { version: number; list: Design[] } | null = null;

/** Every design in the catalogue, built once per catalogue change. */
function designIndex(): Design[] {
  const version = catalogueVersion();
  if (designs?.version === version) return designs.list;
  const tag = env.shopify.brandTag?.toLowerCase();
  const byName = new Map<string, Product[]>();
  for (const product of allProducts()) {
    if (tag && !product.tags.some((value) => value.toLowerCase() === tag)) continue;
    const name = designOf(product.title).toUpperCase();
    byName.set(name, [...(byName.get(name) ?? []), product]);
  }
  const list: Design[] = [];
  for (const [name, products] of byName) {
    const lower = name.toLowerCase();
    const naming = namingWords(lower).filter((word) => word.length > 2 && !/^\d/.test(word));
    const garments = wordsIn(lower).filter((word) => categoriesAsked(word).length > 0);
    if (naming.length && garments.length) list.push({ name, naming, garments, products });
  }
  designs = { version, list };
  return list;
}

function wordsIn(text: string): string[] {
  return text.toLowerCase().replace(/['’]/g, '').split(/[^a-z0-9.]+/).filter(Boolean);
}

/**
 * A product their words name: its design's own words and its garment word,
 * both said - "the Clima Jacket", "an Elite Polo". Read against the
 * catalogue's designs rather than by looking the whole sentence up, which
 * read "show me jackets and polos" as a possible Elite Polo.
 */
function productNamed(said: string, preferRange?: Range): { product: Product; design: string } | null {
  const words = new Set(wordsIn(said));
  const has = (word: string) => words.has(word) || words.has(`${word}s`) || words.has(`${word}es`);
  const matches = designIndex().filter((design) => design.naming.every((word) => words.has(word)) && design.garments.some(has));
  if (!matches.length) return null;
  // The most specific name; then the range asked for; then the plain name ("Elite Polo" before "Ladies Elite Polo").
  const range = parseRange(said).range ?? preferRange;
  const best = matches.sort(
    (a, b) =>
      b.naming.length - a.naming.length ||
      Number(!!range && rangeOf(b.products[0]!) === range) - Number(!!range && rangeOf(a.products[0]!) === range) ||
      a.name.length - b.name.length,
  )[0]!;
  return { product: best.products[0]!, design: best.name };
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
  const named = productNamed(text, prior?.range);
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
  const { focus, change } = readFocus(said, prior, customerTurn(session));
  if (change === 'none') return prior;
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
