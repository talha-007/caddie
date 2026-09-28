import type { Product } from '@caddie/shared';
import { colourMatch, parseColours } from '../catalog/colour.js';
import { optionScale, productColourWords, resolveVariant, sameDesign, sizeScale } from '../catalog/commerce.js';
import { colourwayName } from '../catalog/colourways.js';
import { allDeals } from '../catalog/bundles.js';
import { designMembers, identityProducts, resolveCustomerProductIdentity } from '../catalog/productIdentity.js';
import { productById } from '../catalog/sync.js';
import { designOf, describeFocus } from '../session/focus.js';
import { currentMission, currentPack, currentProduct, livePending } from '../session/shoppingSession.js';
import type { CaddieSession } from '../session/store.js';
import { asksToRemove, lineChangeAuthorization, quantityInWords } from './cartAuthorization.js';
import { packPieces, packStatus } from './packState.js';
import { sizesNeverGiven } from './searchIntent.js';

/**
 * The job the customer is doing - one answer per turn, read from the
 * Shopping Session, never stored beside it.
 *
 * Caddie often had every fact and still lost the job: a pack piece being
 * replaced became a standalone jacket once it searched for jackets; an add
 * with product, colour and size known asked "shall I add it?" again; "what
 * size?" came back to a customer who had said S twice. The facts were there
 * and nothing held them together as one task with an end.
 *
 * So a goal is derived, in this order, from what the session already holds:
 *
 *   edit-basket         their words take something out or change how many
 *   replace-pack-piece  a piece of the pack in hand is being replaced
 *                       (focus.replacing)
 *   add-product         an add they asked for is waiting on something
 *                       (the gateway's pendingAction)
 *   configure-pack      a pack is in hand (focus.pack)
 *   choose-product      a product is in hand (focus.productId)
 *   browse-products     a kind of garment is being looked for (focus.kinds)
 *
 * A search, a product lookup or a colour question is a step inside the goal,
 * never a goal of its own: "show me another jacket in S" during a
 * replacement leaves it a replacement. The goal ends when it succeeds, when
 * the customer cancels, or when their words start another mission - the same
 * rule the focus already keeps (session/focus.ts), so the two never disagree.
 */

export type GoalKind = 'browse-products' | 'choose-product' | 'add-product' | 'edit-basket' | 'configure-pack' | 'replace-pack-piece';

/** Something the goal still needs from the customer. */
export type Requirement = 'product' | 'colour' | 'size' | 'waist' | 'leg' | 'option' | 'line' | 'quantity' | 'replacement';

/** What happens once nothing is missing and the customer has authorised it. */
export type GoalAction =
  | { type: 'swap-pack-piece'; pack: string; step: number; productId: string }
  | { type: 'add-product'; productId: string; options: Record<string, string> }
  | { type: 'add-pack'; pack: string }
  | { type: 'update-line'; lineId: string; quantity: number };

export interface CustomerGoal {
  kind: GoalKind;
  mission: number;
  /** In a few words, for logs and for the model: "replace the Warrior Jacket - Red in Ambassador Pack - Mixed Conditions". */
  subject: string;
  /** Trusted inputs already settled - never to be asked again. */
  known: Record<string, string>;
  /** What is still needed, first thing first. */
  missing: Requirement[];
  /** open: something missing. ready: nothing missing, waiting for their word. done: carried out. */
  status: 'open' | 'ready' | 'done';
  /** What happens once nothing is missing and the customer has authorised it. */
  action?: GoalAction;
  /** The products a purchase goal is about - one, or the colourways still open. */
  products?: string[];
}

const REQUIREMENT_WORDS: Record<Requirement, string> = {
  product: 'which product',
  colour: 'the colour',
  size: 'the size',
  waist: 'the waist size',
  leg: 'the leg length',
  option: 'an option',
  line: 'which basket item',
  quantity: 'how many',
  replacement: 'a replacement for a sold-out piece',
};

/** The goal the customer is on, from the session and, for a basket edit, this turn's words. */
export function customerGoal(session: CaddieSession, said = ''): CustomerGoal | null {
  const mission = currentMission(session);
  return (
    basketEdit(session, said, mission) ??
    replacement(session, said, mission) ??
    waitingAdd(session, said, mission) ??
    packGoal(session, mission) ??
    productGoal(session, said, mission) ??
    browsing(session, mission)
  );
}

/* ---------------- edit-basket ---------------- */

function basketEdit(session: CaddieSession, said: string, mission: number): CustomerGoal | null {
  if (!said.trim() || lineChangeAuthorization({ session, utterance: said }) !== 'customer-utterance') return null;
  const lines = session.basket ?? [];
  const named = identityProducts(resolveCustomerProductIdentity(said));
  const byName = lines.filter((line) => named.some((product) => product.id === line.productId || sameDesignId(product, line.productId)));
  const lastAdded = session.lastAdded ? lines.filter((line) => line.productId === session.lastAdded!.productId) : [];
  const line = byName.length === 1 ? byName[0] : !named.length && lines.length === 1 ? lines[0] : !named.length && lastAdded.length === 1 ? lastAdded[0] : undefined;
  const change = asksToRemove(said) ? 'remove' : 'quantity';
  const amount = change === 'remove' ? { set: 0 } : quantityInWords(said);
  const quantity = amount?.set ?? (amount?.more !== undefined && line ? line.quantity + amount.more : undefined);
  const missing: Requirement[] = [...(line ? [] : ['line' as const]), ...(quantity === undefined ? ['quantity' as const] : [])];
  return {
    kind: 'edit-basket',
    mission,
    subject: `${change === 'remove' ? 'remove' : 'change the quantity of'} ${line ? line.title : 'an item in the basket'}`,
    known: {
      change,
      ...(line ? { line: `${line.title}${line.variantTitle ? ` (${line.variantTitle})` : ''}` } : {}),
      ...(quantity !== undefined ? { quantity: String(quantity) } : {}),
    },
    missing,
    status: missing.length ? 'open' : 'ready',
    ...(line && quantity !== undefined ? { action: { type: 'update-line' as const, lineId: line.lineId, quantity } } : {}),
  };
}

function sameDesignId(product: Product, id: string): boolean {
  const other = productById(id);
  return !!other && sameDesign(product, other);
}

/* ---------------- replace-pack-piece ---------------- */

function replacement(session: CaddieSession, said: string, mission: number): CustomerGoal | null {
  const focus = session.activeShoppingContext;
  const handle = currentPack(session);
  const replacing = focus?.replacing;
  if (!handle || !replacing) return null;
  const deal = allDeals().find((entry) => entry.handle === handle);
  const step = deal?.steps[replacing.step];
  if (!deal || !step) return null;
  const outgoing = packPieces(session, handle)[replacing.step];
  let candidates = replacing.candidates.map((id) => productById(id)).filter((product): product is Product => !!product);
  /*
   * Their words this turn narrow it: "I like black", "the Hexa one". Never by
   * the colour of the piece going out - "instead of that red jacket" is not
   * asking for red.
   */
  // Only when one thing is put in place of another ("instead of that red jacket") - "the Vapor in navy" is navy.
  const going = new Set(outgoing && /\b(instead|replace|replacing|swap|in place of|rather than)\b/i.test(said) ? productColourWords(outgoing, false) : []);
  const colours = parseColours(said).colours.filter((colour) => !going.has(colour.word));
  if (colours.length) {
    const inColour = candidates.filter((product) => colourMatch(product, colours, false) > 0);
    if (inColour.length) candidates = inColour;
  }
  const named = identityProducts(resolveCustomerProductIdentity(said)).map((product) => designOf(product.title));
  const ofNamed = candidates.filter((product) => named.includes(designOf(product.title)));
  if (ofNamed.length) candidates = ofNamed;
  const designs = new Set(candidates.map((product) => designOf(product.title)));
  const known: Record<string, string> = { pack: deal.title, step: step.title };
  if (outgoing) known.replacing = outgoing.title;
  if (replacing.size) known.size = replacing.size;
  if (designs.size === 1) known.product = [...designs][0]!;
  if (candidates.length === 1) known.colour = colourwayName(candidates[0]!.title);
  const missing: Requirement[] = candidates.length === 1 ? [] : designs.size === 1 ? ['colour'] : ['product'];
  return {
    kind: 'replace-pack-piece',
    mission,
    subject: `replace the ${outgoing?.title ?? step.title.toLowerCase()} in ${deal.title}`,
    known,
    missing,
    status: missing.length ? 'open' : 'ready',
    ...(candidates.length === 1 ? { action: { type: 'swap-pack-piece' as const, pack: handle, step: replacing.step, productId: candidates[0]!.id } } : {}),
  };
}

/* ---------------- add-product / choose-product ---------------- */

function waitingAdd(session: CaddieSession, said: string, mission: number): CustomerGoal | null {
  const pending = livePending(session);
  if (!pending) return null;
  const products = pending.productIds.map((id) => productById(id)).filter((product): product is Product => !!product);
  if (!products.length) return null;
  return purchaseGoal('add-product', session, said, mission, products, pending.options ?? {});
}

function productGoal(session: CaddieSession, said: string, mission: number): CustomerGoal | null {
  const held = currentProduct(session);
  if (!held) return null;
  /*
   * "The Glen" names a design, and the focus holds its first colourway - the
   * catalogue's order, not a choice. Every colourway stays open until their
   * words, the colour of this mission or a card tapped picks one; a yes to
   * "add it?" before that must never buy whichever came first (V1 task 3).
   */
  const chosen = session.activeShoppingContext?.source === 'card-action' ? [held] : designMembers(held);
  return purchaseGoal('choose-product', session, said, mission, chosen.length ? chosen : [held], {});
}

/**
 * One product to buy: which colourway, which size - each only from what the
 * customer gave. The colour is the product's own when one colourway is in
 * hand, or the colour they asked for this mission; the size is one they said
 * for this product or this mission, picked on its card, their usual size, or
 * a recommendation they accepted (searchIntent.ts sizesNeverGiven - the same
 * rule the basket uses). Never a size the model or a card's default chose.
 */
function purchaseGoal(kind: 'add-product' | 'choose-product', session: CaddieSession, said: string, mission: number, products: Product[], settled: Record<string, string>): CustomerGoal {
  const focusColours = session.activeShoppingContext?.colours ?? [];
  const saidColours = parseColours(said).colours;
  let pool = products;
  if (pool.length > 1 && saidColours.length) pool = pool.filter((product) => colourMatch(product, saidColours, false) > 0);
  if (pool.length > 1 && focusColours.length) {
    const inFocus = pool.filter((product) => focusColours.some((colour) => colourwayName(product.title).toLowerCase().includes(colour.toLowerCase())));
    if (inFocus.length) pool = inFocus;
  }
  const known: Record<string, string> = {};
  const missing: Requirement[] = [];
  const designs = new Set(pool.map((product) => designOf(product.title)));
  known.product = pool.length === 1 ? pool[0]!.title : [...designs].join(' / ');
  if (pool.length > 1) missing.push(designs.size > 1 ? 'product' : 'colour');
  let action: GoalAction | undefined;
  if (pool.length === 1) {
    const product = pool[0]!;
    known.colour = colourwayName(product.title);
    const options = { ...settled, ...(session.cardChoices?.[product.id]?.options ?? {}) };
    if (!sizeScale(product).oneSize) {
      const ctx = { session, utterance: said };
      for (const option of product.options.filter((own) => own.values.length > 1)) {
        const scale = optionScale(option);
        if (!scale || Object.keys(options).some((name) => name.toLowerCase() === option.name.toLowerCase())) continue;
        const given = option.values.filter((value) => sizesNeverGiven([value], ctx, product.id).length === 0);
        // A leg is never read from a bare number - the 32 they gave was a waist.
        if (given.length === 1 && scale !== 'leg') options[option.name] = given[0]!;
      }
    } else known.size = 'one size';
    const resolution = resolveVariant(product, options);
    for (const [name, value] of Object.entries(options)) known[name.toLowerCase().includes('leg') ? 'leg' : name.toLowerCase().includes('waist') ? 'waist' : 'size'] = value;
    if (resolution.status === 'incomplete') {
      for (const option of resolution.missing) {
        const scale = optionScale(option);
        missing.push(scale === 'waist' ? 'waist' : scale === 'leg' ? 'leg' : scale ? 'size' : /colou?r/i.test(option.name) ? 'colour' : 'option');
      }
    } else if (resolution.status === 'exact' && resolution.variant.available) {
      action = { type: 'add-product', productId: product.id, options };
    } else missing.push('size');
  }
  // Put in the basket since this product came into hand: done, so a repeated "yes" is not a second add.
  const lastAdded = session.lastAdded;
  const added = action?.type === 'add-product' && !!lastAdded && lastAdded.productId === action.productId && lastAdded.turn + 1 >= (session.activeShoppingContext?.turn ?? 0);
  return {
    kind,
    mission,
    subject: `${kind === 'add-product' ? 'add' : 'decide on'} ${known.product}`,
    known,
    missing,
    status: added ? 'done' : missing.length ? 'open' : 'ready',
    ...(action ? { action } : {}),
    products: pool.map((product) => product.id),
  };
}

/* ---------------- configure-pack ---------------- */

function packGoal(session: CaddieSession, mission: number): CustomerGoal | null {
  const handle = currentPack(session);
  if (!handle) return null;
  const deal = allDeals().find((entry) => entry.handle === handle);
  const status = packStatus(session, handle);
  if (!deal || !status.pieces.length) return null;
  const known: Record<string, string> = { pack: deal.title };
  if (status.choices.top) known.top = status.choices.top;
  if (status.choices.waist) known.waist = status.choices.waist;
  if (status.choices.leg) known.leg = status.choices.leg;
  const missing: Requirement[] = [];
  if (status.pieces.some((plan) => plan.soldOut)) missing.push('replacement');
  for (const plan of status.pieces) {
    for (const entry of plan.missing) {
      const need: Requirement = entry.kind === 'top' ? 'size' : entry.kind === 'waist' ? 'waist' : entry.kind === 'leg' ? 'leg' : 'option';
      if (!missing.includes(need)) missing.push(need);
    }
  }
  return {
    kind: 'configure-pack',
    mission,
    subject: `put together ${deal.title}`,
    known,
    missing,
    status: status.ready ? 'ready' : 'open',
    ...(status.ready ? { action: { type: 'add-pack' as const, pack: handle } } : {}),
  };
}

/* ---------------- browse-products ---------------- */

function browsing(session: CaddieSession, mission: number): CustomerGoal | null {
  const focus = session.activeShoppingContext;
  if (!focus?.kinds.length) return null;
  return { kind: 'browse-products', mission, subject: `find ${describeFocus(focus)}`, known: { looking_for: describeFocus(focus) }, missing: ['product'], status: 'open' };
}

/* ---------------- for the model ---------------- */

/**
 * The goal, for the model: what the job is, what is settled and must not be
 * asked again, and the one thing to ask. Data, not a script - the tools and
 * the gateway still decide.
 */
export function describeGoal(goal: CustomerGoal): string {
  const known = Object.entries(goal.known)
    .map(([name, value]) => `${name.replace(/_/g, ' ')} ${value}`)
    .join('; ');
  const next = goal.missing.length ? `Still needed: ${goal.missing.map((need) => REQUIREMENT_WORDS[need]).join(', ')} - ask only for ${REQUIREMENT_WORDS[goal.missing[0]!]}.` : goal.status === 'done' ? 'It is done.' : 'Nothing is missing: when they say so, do it - no further confirmation.';
  return `The customer's goal: ${goal.subject}. Settled - never ask for these again: ${known || 'nothing yet'}. ${next} A search or lookup is a step in this goal, not a new one.`;
}

/** The goal as one log line. */
export function goalLog(goal: CustomerGoal | null): Record<string, unknown> {
  if (!goal) return { goal: null };
  return { goal: goal.kind, subject: goal.subject, known: goal.known, missing: goal.missing, status: goal.status, action: goal.action?.type ?? null };
}

/** The known inputs a question in the reply asks for again - "what size?" to a customer whose size is settled. */
export function asksForKnown(goal: CustomerGoal, reply: string): Requirement[] {
  const questions = reply.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.includes('?'));
  const asked: Requirement[] = [];
  for (const question of questions) {
    // "What size?", and also "Is medium your top size?" - a settled size asked back is asked again.
    if (/\b(what|which)\s+(top\s+)?size\b|\bsize (would|do|should) you\b|\byour (top )?size\b|\btop size\b/i.test(question) &&('size' in goal.known || 'top' in goal.known) && !goal.missing.includes('size')) asked.push('size');
    if (/\b(what|which)\s+colou?r\b|\bcolou?r (would|do) you\b/i.test(question) && 'colour' in goal.known && !goal.missing.includes('colour')) asked.push('colour');
    if (/\bwaist\b/i.test(question) && 'waist' in goal.known && !goal.missing.includes('waist')) asked.push('waist');
  }
  return [...new Set(asked)];
}

/** Whether their words name a product other than the goal's. */
export function namesOtherProduct(goal: CustomerGoal, said: string): boolean {
  const named = identityProducts(resolveCustomerProductIdentity(said));
  if (!named.length || !goal.action || goal.action.type === 'add-pack' || goal.action.type === 'update-line') return false;
  const target = productById(goal.action.productId);
  return !!target && !named.some((product) => sameDesign(product, target));
}
