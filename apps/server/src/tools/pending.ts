import type { Product } from '@caddie/shared';
import { colourMatch } from '../catalog/colour.js';
import { optionScale, resolveVariant, sameDesign, sizeApplies, sizeOptionName, sizeScale } from '../catalog/commerce.js';
import { colourwayName, garmentName } from '../catalog/colourways.js';
import { allDeals } from '../catalog/bundles.js';
import { designMembers, identityProducts, resolveCustomerProductIdentity } from '../catalog/productIdentity.js';
import { productById } from '../catalog/sync.js';
import { log } from '../lib/logger.js';
import { customerTurn, designOf, setReplacement } from '../session/focus.js';
import { currentMission, missionStart } from '../session/shoppingSession.js';
import { sessions, type CaddieSession, type PendingAction, type PendingNeed } from '../session/store.js';
import { trustedShopperFacts } from '../shopper/facts.js';
import { executeCommerceAction, type ActionOutcome } from './actionGateway.js';
import { readReply, type ReadReply } from './answers.js';
import { asksToAdd, quantityInWords } from './cartAuthorization.js';
import { eligibilityFor } from './eligibility.js';
import { optionValueMatches } from '../recommend/sizeWords.js';
import { OUTCOME_TIMEOUT_MS, STILL_UPDATING, UNCERTAIN_HELD, expireDispatched } from './cartOperations.js';
import { categoriesAsked, isCategory, sizeInRequest } from '../catalog/constraints.js';
import { swapPackPiece } from './index.js';
import { customerGoal } from './journey.js';
import { packPieces, packStatus, readPackChoices } from './packState.js';
import type { ToolContext, ToolResult } from './types.js';

/**
 * The one action the Caddie is waiting to finish, resolved before the model
 * runs (V1 task 3).
 *
 * Every question asked in order to complete a basket change - which colour,
 * what size, shall I add it, swap the Warrior for the Hexa? - writes one
 * record (session.pendingAction). On the customer's next message this reads
 * their words against that record and nothing else: a yes means this action;
 * a colour or a size fills the field it was waiting for; "you already know
 * my size" is the size already established for this product; a no ends it.
 * Complete and theirs, it is done here, once, through the Action Gateway,
 * and the record is consumed. What is left of the message - "and can we do a
 * pack as well?" - goes on to the model.
 *
 * Before this, what a yes meant was re-read from the Caddie's previous
 * sentence, a yes inside a longer message was no yes at all, a colour answer
 * over five words was not a colour, and the record died after one turn - so
 * "I think I'll go with red and you already know my size" finished nothing,
 * and the Caddie asked "shall I add it?" again (preview store).
 */

export type PendingStatus = 'none' | 'executed' | 'asked' | 'cancelled' | 'superseded';

export interface PendingTurn {
  status: PendingStatus;
  /** What was done or asked, in the tool's own words. */
  result?: ToolResult;
  /** The clauses that were about something else - for the model. */
  remainder: string;
  /** The record as it stands after this message, if one still waits. */
  pending?: PendingAction;
}

/** How long a record may wait, in customer messages, before it is stale whatever else happens. */
const STALE_AFTER_TURNS = 12;

const NEED_WORDS: Record<PendingNeed, string> = {
  outcome: 'the store cart to confirm it',
  colour: 'the colour',
  size: 'the size',
  waist: 'the waist size',
  leg: 'the leg length',
  option: 'an option',
  line: 'which basket item',
  quantity: 'how many',
  confirmation: 'a yes',
};

export async function resolvePending(sessionId: string, said: string): Promise<PendingTurn> {
  const session = await sessions.getOrCreate(sessionId);
  const pending = session.pendingAction;
  if (!pending || !said.trim()) return { status: 'none', remainder: said };
  const turn = customerTurn(session);
  // An unrelated mission since ("show me polos" while a jacket waited): the record ended with it.
  if (pending.mission !== undefined && pending.mission !== currentMission(session)) {
    log.info('pending.ended_by_mission', { sessionId, type: pending.type });
    await sessions.patch(sessionId, { pendingAction: undefined });
    return { status: 'none', remainder: said };
  }
  if (turn - pending.turn > STALE_AFTER_TURNS) {
    log.info('pending.stale', { sessionId, type: pending.type, age: turn - pending.turn });
    await sessions.patch(sessionId, { pendingAction: undefined });
    return { status: 'none', remainder: said };
  }
  /*
   * Handed to the widget and not yet borne out by the cart (tools/
   * cartOperations.ts): a yes, or "add it" again, sends nothing a second
   * time - the customer is told it is still being updated. Anything else
   * goes to the model as usual, with the record left standing.
   */
  if (pending.awaiting === 'outcome') {
    const record = pending.dispatched ? session.cartOperations?.[pending.dispatched] : undefined;
    if (!record || (record.status !== 'dispatched' && record.status !== 'uncertain')) {
      await sessions.patch(sessionId, { pendingAction: undefined });
      return { status: 'none', remainder: said };
    }
    if (record.status === 'dispatched' && Date.now() - record.createdAt > OUTCOME_TIMEOUT_MS) await expireDispatched(sessionId, session);
    const heard = readReply(said);
    if (heard.affirms || asksToAdd(said)) {
      log.info('pending.held_for_outcome', { sessionId, operationId: record.id, status: record.status });
      const speech = record.status === 'dispatched' && Date.now() - record.createdAt <= OUTCOME_TIMEOUT_MS ? STILL_UPDATING : UNCERTAIN_HELD;
      return { status: 'asked', result: { speech, facts: 'A basket change is unconfirmed. Nothing else was changed, and nothing is sent again. Say only what the tool said.' }, remainder: '' };
    }
    return { status: 'none', remainder: said };
  }

  const reply = readReply(said);
  const ctx: ToolContext = { session, utterance: said };

  // Another product named: this record is not what they are talking about now.
  if (pending.type !== 'add-pack' && namesOther(said, pending.productIds)) {
    log.info('pending.superseded', { sessionId, type: pending.type });
    await sessions.patch(sessionId, { pendingAction: undefined });
    return { status: 'superseded', remainder: said };
  }
  if (reply.declines) {
    log.info('pending.cancelled', { sessionId, type: pending.type, said: said.slice(0, 80) });
    await sessions.patch(sessionId, { pendingAction: undefined });
    if (pending.type === 'replace-pack-piece') await clearOffer(sessionId);
    return { status: 'cancelled', remainder: reply.remainder };
  }

  switch (pending.type) {
    case 'add-product':
      return addProduct(ctx, pending, reply);
    case 'add-pack':
      return addPack(ctx, pending, reply);
    case 'replace-pack-piece':
      return replacePiece(ctx, pending, reply);
    case 'update-line':
      return updateLine(ctx, pending, reply);
  }
}

/* ---------------- add-product ---------------- */

async function addProduct(ctx: ToolContext, pending: PendingAction, reply: ReadReply): Promise<PendingTurn> {
  const said = ctx.utterance ?? '';
  let products = pending.productIds.map((id) => productById(id)).filter((product): product is Product => !!product);
  if (!products.length) {
    await sessions.patch(ctx.session.id, { pendingAction: undefined });
    return { status: 'none', remainder: said };
  }
  /*
   * The colour they give narrows the colourways; one left is the product.
   * A colour none of them comes in, but the design does - "the red one" when
   * the record held the blue - is that colourway of the same design (live
   * replay): the same product to them, in the colour they want.
   */
  if (reply.colours.length) {
    const inColour = products.filter((product) => colourMatch(product, reply.colours, false) > 0);
    if (inColour.length) products = inColour;
    else {
      const sameDesignInColour = designMembers(products[0]!).filter((product) => colourMatch(product, reply.colours, false) > 0);
      if (sameDesignInColour.length) products = sameDesignInColour;
    }
  }
  const options: Record<string, string> = { ...(pending.options ?? {}) };
  const authorized = !!pending.authorized || reply.affirms || asksToAdd(said);
  const answered = reply.affirms || reply.colours.length > 0 || !!reply.size || !!reply.waist || !!reply.leg || reply.sizeReference;

  const single = products.length === 1 ? products[0]! : undefined;
  if (single) {
    // The sizes they give, each on the option it belongs to.
    const dims = sizeScale(single).dimensions;
    const sizeOption = sizeOptionName(single);
    const waistOption = dims.find((dimension) => dimension.scale === 'waist')?.option;
    const legOption = dims.find((dimension) => dimension.scale === 'leg')?.option;
    if (reply.waist && waistOption) options[waistOption] = reply.waist;
    if (reply.leg && legOption) options[legOption] = reply.leg;
    if (reply.size && sizeOption && !waistOption && sizeApplies(single, reply.size)) options[sizeOption] = reply.size;
    /*
     * "You already know my size": the size already established for this
     * product - their usual size where it applies, else the size we found
     * for them this mission, which their words now accept. Never a guess,
     * and never made their usual size by it.
     */
    if (reply.sizeReference && sizeOption && !options[sizeOption]) {
      const known = await knownSizeFor(ctx.session, single);
      if (known) options[sizeOption] = known;
    }
  }

  const missing: PendingNeed[] = [];
  if (!single) missing.push('colour');
  else {
    const resolution = resolveVariant(single, options);
    if (resolution.status === 'incomplete') for (const option of resolution.missing) missing.push(needOf(option));
  }
  if (!authorized) missing.push('confirmation');

  if (!missing.length) {
    const fresh = await sessions.getOrCreate(ctx.session.id);
    await sessions.patch(ctx.session.id, { pendingAction: { ...pending, productIds: [single!.id], options, authorized: true, missing: [], awaiting: 'confirmation' } });
    const outcome = await executeCommerceAction({ session: await sessions.getOrCreate(ctx.session.id), utterance: said, pendingResolved: true }, { type: 'add-product', productId: single!.id, options, ...(pending.quantity ? { quantity: pending.quantity } : {}) });
    void fresh;
    log.info('pending.resolved', { sessionId: ctx.session.id, type: 'add-product', ok: outcome.ok, reason: outcome.reason ?? null, product: single!.title });
    return { status: outcome.ok ? 'executed' : 'asked', result: fromOutcome(outcome), remainder: reply.remainder, ...(outcome.ok ? {} : { pending: (await sessions.getOrCreate(ctx.session.id)).pendingAction }) };
  }
  // Nothing here was for it: the record waits as it was, the model answers what they said.
  if (!answered) return { status: 'none', remainder: said, pending };
  const name = single ? single.title : designOf(products[0]!.title);
  const question = questionFor(missing[0]!, name, single, options);
  const next: PendingAction = { ...pending, productIds: products.map((product) => product.id), options, authorized, awaiting: missing[0]!, missing, question };
  await sessions.patch(ctx.session.id, { pendingAction: next });
  log.info('pending.updated', { sessionId: ctx.session.id, type: 'add-product', missing, authorized });
  return {
    status: 'asked',
    result: { speech: question, facts: `Waiting add: ${name}${Object.keys(options).length ? ` in ${Object.values(options).join(' / ')}` : ''}. Still needed: ${missing.map((need) => NEED_WORDS[need]).join(', ')}. Ask only for ${NEED_WORDS[missing[0]!]}; nothing was added.` },
    remainder: reply.remainder,
    pending: next,
  };
}

/** The size already theirs for this product: usual size where it applies, else the current recommendation - accepted now for this mission. */
async function knownSizeFor(session: CaddieSession, product: Product): Promise<string | undefined> {
  const facts = trustedShopperFacts(session);
  if (facts.usualSize && sizeApplies(product, facts.usualSize)) return facts.usualSize;
  const rec = session.sizeRecommendation;
  if (!rec || rec.scale !== 'top' || !sizeApplies(product, rec.size)) return undefined;
  const forThis = rec.productId === product.id || rec.turn >= missionStart(session) || rec.acceptedMission === currentMission(session);
  if (!forThis) return undefined;
  if (rec.acceptedMission !== currentMission(session)) {
    await sessions.patch(session.id, { sizeRecommendation: { ...rec, acceptedMission: currentMission(session) } });
    log.info('pending.recommendation_accepted', { sessionId: session.id, size: rec.size, product: product.title });
  }
  return rec.size;
}

function needOf(option: { name: string; values: string[] }): PendingNeed {
  // With its values: an option with none reads as a waist, and "Size" became "waist" (every size answer missed).
  const scale = optionScale(option);
  if (/colou?r/i.test(option.name)) return 'colour';
  if (scale === 'waist' || /waist/i.test(option.name)) return 'waist';
  if (scale === 'leg' || /leg|length|inseam/i.test(option.name)) return 'leg';
  if (/size/i.test(option.name) || scale) return 'size';
  return 'option';
}

function questionFor(need: PendingNeed, name: string, product: Product | undefined, options: Record<string, string>): string {
  const spoken = titleCase(name);
  const sized = Object.values(options).filter(Boolean);
  switch (need) {
    case 'colour':
      return `Which colour of the ${spoken} would you like?`;
    case 'size': {
      const values = product ? (sizeScale(product).dimensions.find((dimension) => dimension.scale !== 'leg' && dimension.scale !== 'waist')?.values ?? []) : [];
      return `What size would you like for the ${spoken}${values.length ? ` - ${values.join(', ')}` : ''}?`;
    }
    case 'waist':
      return `What waist size for the ${spoken}?`;
    case 'leg':
      return `Which leg length for the ${spoken}?`;
    case 'quantity':
      return `How many of the ${spoken} would you like?`;
    case 'line':
      return 'Which one in your basket do you mean?';
    case 'option':
      return `Which option would you like for the ${spoken}?`;
    case 'confirmation':
      return `Shall I add the ${spoken}${sized.length ? ` in ${sized.join(' / ')}` : ''} to your basket?`;
    case 'outcome':
      return 'Updating your basket…';
  }
}

/* ---------------- add-pack ---------------- */

async function addPack(ctx: ToolContext, pending: PendingAction, reply: ReadReply): Promise<PendingTurn> {
  const said = ctx.utterance ?? '';
  const deal = pending.pack ? allDeals().find((entry) => entry.handle === pending.pack) : undefined;
  if (!deal) {
    await sessions.patch(ctx.session.id, { pendingAction: undefined });
    return { status: 'none', remainder: said };
  }
  // Their answer, read into the pack's own choices (the turn reader does the same later, idempotently).
  const pieces = packPieces(ctx.session, deal.handle);
  const lastReply = [...ctx.session.messages].reverse().find((message) => message.role === 'assistant')?.text ?? '';
  const before = ctx.session.packChoices?.[deal.handle] ?? {};
  const choices = readPackChoices(said, lastReply, pieces, before);
  const changed = JSON.stringify(choices) !== JSON.stringify(before);
  if (changed) await sessions.patch(ctx.session.id, { packChoices: { ...(ctx.session.packChoices ?? {}), [deal.handle]: choices } });
  const authorized = !!pending.authorized || reply.affirms || asksToAdd(said);
  const answered = changed || reply.affirms;
  const session = await sessions.getOrCreate(ctx.session.id);
  const status = packStatus(session, deal.handle);
  /*
   * Asked for, and complete: added. Asked for, and a field still open: the
   * gateway asks it and keeps the record - with their yes. Not asked for: a
   * size answered is a size, never a yes (live replay).
   */
  if (authorized && (changed || reply.affirms || status.ready)) {
    await sessions.patch(ctx.session.id, { pendingAction: { ...pending, authorized: true } });
    const outcome = await executeCommerceAction({ session: await sessions.getOrCreate(ctx.session.id), utterance: said, pendingResolved: true }, { type: 'add-pack', pack: deal.title });
    log.info('pending.resolved', { sessionId: ctx.session.id, type: 'add-pack', ok: outcome.ok, reason: outcome.reason ?? null });
    return { status: outcome.ok ? 'executed' : 'asked', result: fromOutcome(outcome), remainder: reply.remainder, ...(outcome.ok ? {} : { pending: (await sessions.getOrCreate(ctx.session.id)).pendingAction }) };
  }
  if (!answered) return { status: 'none', remainder: said, pending };
  const question = status.ready ? `The ${titleCase(deal.title)} is ready - shall I add it to your basket?` : status.next;
  const next: PendingAction = { ...pending, awaiting: status.ready ? 'confirmation' : pending.awaiting, missing: status.ready ? ['confirmation'] : pending.missing, question };
  await sessions.patch(ctx.session.id, { pendingAction: next });
  return { status: 'asked', result: { speech: question, facts: `The ${deal.title}: ${status.ready ? 'ready, not yet asked for - ask, add nothing until they say' : `still needs ${status.next}`}.` }, remainder: reply.remainder, pending: next };
}

/* ---------------- replace-pack-piece ---------------- */

async function replacePiece(ctx: ToolContext, pending: PendingAction, reply: ReadReply): Promise<PendingTurn> {
  const said = ctx.utterance ?? '';
  const deal = pending.pack ? allDeals().find((entry) => entry.handle === pending.pack) : undefined;
  const replacement = pending.productIds[0] ? productById(pending.productIds[0]) : null;
  if (!deal || !replacement) {
    await sessions.patch(ctx.session.id, { pendingAction: undefined });
    return { status: 'none', remainder: said };
  }
  if (!reply.affirms) return { status: 'none', remainder: said, pending };
  const size = pending.options?.size;
  if (!eligibilityFor(ctx.session, said, size ? [{ size }] : []).eligible(replacement)) {
    await sessions.patch(ctx.session.id, { pendingAction: undefined });
    return {
      status: 'asked',
      result: { speech: `Sorry - the ${titleCase(garmentName(replacement.title))} has just sold out${size ? ` in ${size}` : ''}. Shall I show you the others that can go in?`, facts: `${replacement.title} is no longer available${size ? ` in ${size}` : ''}. Nothing was changed.` },
      remainder: reply.remainder,
    };
  }
  log.info('pending.resolved', { sessionId: ctx.session.id, type: 'replace-pack-piece', pack: deal.handle, replacement: replacement.title });
  const swapped = await swapPackPiece(ctx, deal, replacement);
  await sessions.patch(ctx.session.id, { pendingAction: undefined });
  if (!swapped) return { status: 'none', remainder: said };
  return { status: swapped.attachment?.kind === 'pack' ? 'executed' : 'asked', result: swapped, remainder: reply.remainder };
}

/* ---------------- update-line ---------------- */

async function updateLine(ctx: ToolContext, pending: PendingAction, reply: ReadReply): Promise<PendingTurn> {
  const said = ctx.utterance ?? '';
  if (!pending.lineId) {
    await sessions.patch(ctx.session.id, { pendingAction: undefined });
    return { status: 'none', remainder: said };
  }
  // "Two", "make it two", "2 please": the number they give, however they give it.
  const quantity = pending.awaiting === 'quantity' ? (reply.quantity ?? quantityInWords(said)?.set) : pending.quantity;
  const authorized = pending.awaiting === 'confirmation' ? reply.affirms : quantity !== undefined;
  if (!authorized || quantity === undefined) return { status: 'none', remainder: said, pending };
  const outcome = await executeCommerceAction({ session: ctx.session, utterance: said, pendingResolved: true }, { type: 'update-line', lineId: pending.lineId, quantity });
  log.info('pending.resolved', { sessionId: ctx.session.id, type: 'update-line', ok: outcome.ok, reason: outcome.reason ?? null, quantity });
  if (!outcome.ok) await sessions.patch(ctx.session.id, { pendingAction: undefined });
  return { status: outcome.ok ? 'executed' : 'asked', result: fromOutcome(outcome), remainder: reply.remainder };
}

/* ---------------- offers become records ---------------- */

const OFFERS_ADD = /\b(add|put|pop)\b[^.?!]*\?|\b(shall i|should i|would you like me to|want me to|do you want me to|like me to) (add|put|pop)\b/i;

/**
 * The reply going out offers to add something: the record is written now,
 * from what the session knows the customer is buying (tools/journey.ts) - so
 * their yes next turn is bound by code, not by re-reading this sentence.
 */
export async function notePendingOffer(sessionId: string, reply: string): Promise<void> {
  const session = await sessions.getOrCreate(sessionId);
  if (session.pendingAction) return;
  // A pack piece being replaced: an offer now is a swap, and only the swap offer (tools/index.ts) may record it - never an add of the piece on its own.
  if (session.activeShoppingContext?.replacing) return;
  const question = reply.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.includes('?')).pop() ?? '';
  if (!OFFERS_ADD.test(question)) return;
  const goal = customerGoal(session);
  const mission = currentMission(session);
  // The messages so far, as the gateway stamps its records.
  const turn = customerTurn(session, false);
  // A pack offered - ready, or with a field still open: their yes is for this pack, and their sizes are its fields, never a yes.
  const packHandle = goal?.kind === 'configure-pack' ? (goal.action?.type === 'add-pack' ? goal.action.pack : session.activeShoppingContext?.pack) : undefined;
  // "Shall I add it?" while the pack is what they are configuring is the pack - unless the question names a product of its own.
  const namedInQuestion = identityProducts(resolveCustomerProductIdentity(question, 'offer'));
  if (packHandle && (/\bpack\b/i.test(question) || !namedInQuestion.length)) {
    await sessions.patch(sessionId, { pendingAction: { type: 'add-pack', productIds: [], pack: packHandle, awaiting: 'confirmation', missing: ['confirmation'], authorized: false, question, turn, mission } });
    log.info('pending.offer_recorded', { sessionId, type: 'add-pack', pack: packHandle });
    return;
  }
  let products: Product[] = [];
  let options: Record<string, string> = {};
  if ((goal?.kind === 'choose-product' || goal?.kind === 'add-product') && goal.status !== 'done' && goal.products?.length) {
    products = goal.products.map((id) => productById(id)).filter((product): product is Product => !!product);
    if (goal.action?.type === 'add-product') options = goal.action.options;
  } else {
    /*
     * The product the offer itself names - bound now, by code, never re-read
     * on the yes. Only one the customer has in front of them (on screen or
     * in hand): a product the model brings up on its own ("shall I add the
     * Tyde Jacket to go with it?") is a suggestion, not a choice, and a
     * record for it once turned a stray "yes" into "which colour of the
     * Tyde Jacket?" (product-to-basket journey).
     */
    const seen = new Set([...(session.lastShown?.items ?? []).map((item) => item.id), ...(session.activeShoppingContext?.productId ? [session.activeShoppingContext.productId] : [])]);
    products = identityProducts(resolveCustomerProductIdentity(question, 'offer')).filter((product) => seen.has(product.id));
  }
  if (!products.length) return;
  /*
   * Just put in the basket, or on its way there: no offer reopens its size
   * or colour. "Would you like to add a polo to go under it?" after the
   * midlayer went in once became "Which colour of the Stealth Midlayer would
   * you like?" (audit finding T1b). And an offer of another kind of garment
   * is not an offer of this product.
   */
  const added = session.lastAdded;
  if (added && products.some((product) => product.id === added.productId) && turn - added.turn <= 6) {
    log.info('pending.offer_not_reopened', { sessionId, product: added.productId });
    return;
  }
  const kinds = categoriesAsked(question);
  if (kinds.length && !products.some((product) => isCategory(product, kinds))) return;
  const missing: PendingNeed[] = [];
  if (products.length > 1) missing.push('colour');
  else {
    const resolution = resolveVariant(products[0]!, options);
    if (resolution.status === 'incomplete') for (const option of resolution.missing) missing.push(needOf(option));
  }
  missing.push('confirmation');
  // A field still open: the question is for that field - the offer as worded ("shall I add it?") is not asked over the top of it.
  const asked = missing[0] === 'confirmation' ? question : questionFor(missing[0]!, garmentName(products[0]!.title), products.length === 1 ? products[0] : undefined, options);
  await sessions.patch(sessionId, {
    pendingAction: { type: 'add-product', productIds: products.map((product) => product.id), ...(Object.keys(options).length ? { options } : {}), awaiting: missing[0]!, missing, authorized: false, question: asked, turn, mission },
  });
  log.info('pending.offer_recorded', { sessionId, type: 'add-product', products: products.map((product) => product.title), missing });
}

/* ---------------- the question follows the record ---------------- */

/**
 * A question asking the customer to confirm a change to a specific thing -
 * "add it", "the Glen", "this jacket", a swap, an update to the pack. A
 * cross-sell ("Would you like some socks too?") names no target and is not
 * one: it is an offer to look, not to act.
 */
const TRANSACTIONAL = /\b(?:add|adding|put|putting|pop|include|proceed with adding|proceed with)\s+(?:it|this|that|these|them|both|the|your|this one|that one)\b[^?]*\?|\b(?:swap|replace|switch|exchange)\b[^?]*\?|\bupdate\b[^?]*\bpack\b[^?]*\?|\b(?:want|like|prefer|go with|choose|pick)\s+(?:it|this one|that one|this|that)\b[^?]*\b(?:pack|basket|place)\b[^?]*\?/i;

/**
 * No confirmation question without a record to answer it (V1 task 3).
 *
 * The record is bound from state before the reply is fixed (notePackSwapOffer,
 * notePendingOffer); this is the last look at the words going out. A
 * transactional question with nothing bound - "Should I update your pack
 * with this jacket?", the jacket unnamed - becomes the question for the
 * missing target instead, so a yes never has nothing to mean. And a record
 * awaiting a yes whose question the rewrite lost gets it back: the record
 * lives independently of the text.
 */
export async function alignReplyWithPending(sessionId: string, reply: string): Promise<string> {
  const session = await sessions.getOrCreate(sessionId);
  const pending = session.pendingAction;
  const sentences = reply.split(/(?<=[.!?])\s+/);
  const questionAt = sentences.map((sentence, index) => (sentence.includes('?') ? index : -1)).filter((index) => index >= 0).pop() ?? -1;
  const question = questionAt >= 0 ? sentences[questionAt]! : '';
  const thisTurn = !!pending && pending.turn === customerTurn(session, false);
  /*
   * The candidate is established - one suggested this turn (notePackSwapOffer)
   * - and the words lost it to a rewrite, asking "which jacket?" or a swap
   * with nothing named. The record is written from the state and the exact
   * swap is what they hear: question follows state.
   */
  if (question && !pending && (TRANSACTIONAL.test(question) || /\bwhich\b/i.test(question))) {
    const bound = await bindSuggestedSwap(sessionId, session);
    if (bound) {
      log.warn('reply.suggested_swap_asked', { sessionId, over: question.slice(0, 120), ask: bound });
      sentences[questionAt] = bound;
      return sentences.join(' ');
    }
  }
  if (question && TRANSACTIONAL.test(question) && !pending) {
    /*
     * "Would you like me to add this in M?" of the card the code chose to
     * lead with: the lead is a code-known target, so the offer binds to it
     * rather than becoming "which one would you like?" (audit finding T1c).
     */
    const lead = await bindLeadOffer(sessionId, session, question, reply);
    if (lead) {
      if (lead !== question) sentences[questionAt] = lead;
      return sentences.join(' ');
    }
    /*
     * An offer to add a product the customer has not got in front of them
     * ("shall I add the Storm Jacket to go with it?") is a suggestion: made
     * as an offer to show it, which a yes can answer without a record.
     */
    const suggested = identityProducts(resolveCustomerProductIdentity(question, 'offer'));
    const seen = new Set([...(session.lastShown?.items ?? []).map((item) => item.id), ...(session.activeShoppingContext?.productId ? [session.activeShoppingContext.productId] : [])]);
    if (suggested.length && !suggested.some((product) => seen.has(product.id))) {
      const shown = `Would you like to see the ${titleCase(garmentName(suggested[0]!.title))}?`;
      log.info('reply.offer_made_a_showing', { sessionId, product: suggested[0]!.title });
      sentences[questionAt] = shown;
      return sentences.join(' ');
    }
    const ask = targetQuestion(session);
    log.warn('reply.offer_unbound_converted', { sessionId, question: question.slice(0, 120), ask, reply: reply.slice(0, 300) });
    sentences[questionAt] = ask;
    return sentences.join(' ');
  }
  /*
   * The record's question is the one they must hear: the field it still
   * needs, or the confirmation it waits for. A reply that asks something else
   * - "shall I add it?" over an open size, "anything else?" after the
   * gateway asked about the whole pack - or that lost its question to a
   * rewrite, gets the record's question in its place.
   */
  if (pending && thisTurn && pending.question && !asksFor(pending, reply)) {
    log.warn('reply.waiting_question_restored', { sessionId, type: pending.type, awaiting: pending.awaiting, over: question.slice(0, 80) });
    if (questionAt >= 0) sentences[questionAt] = pending.question;
    else sentences.push(pending.question);
    return sentences.join(' ').trim();
  }
  return reply;
}

/** Whether the reply asks what the record is waiting for - in the record's own words or its own. */
function asksFor(pending: PendingAction, reply: string): boolean {
  if (pending.question && reply.includes(pending.question)) return true;
  const questions = reply.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.includes('?'));
  if (!questions.length) return false;
  const asked = questions.join(' ');
  switch (pending.awaiting) {
    case 'size':
      return /\bsize\b/i.test(asked);
    case 'colour':
      return /\bcolou?r/i.test(asked);
    case 'waist':
      return /\bwaist\b/i.test(asked);
    case 'leg':
      return /\bleg\b|\blength\b/i.test(asked);
    case 'quantity':
      return /\bhow many\b|\bquantity\b/i.test(asked);
    case 'line':
    case 'option':
      return /\bwhich\b/i.test(asked);
    case 'outcome':
      return true;
    case 'confirmation': {
      // "Which jacket would you like to replace it with?" asks for a choice, not a yes - whatever verbs it holds.
      const last = questions[questions.length - 1]!;
      if (/^\s*(?:which|what|who|where|how)\b/i.test(last)) return false;
      return TRANSACTIONAL.test(asked) || /\bremov|\bwhole pack\b|\btake (?:it|them|the \w+) out\b|\bgo ahead\b|\bconfirm\b/i.test(asked);
    }
  }
}

/**
 * The one candidate the state holds for the piece being replaced - suggested
 * this turn with no swap asked - made the record of the swap, and the exact
 * question for it returned. Null when nothing is established.
 */
async function bindSuggestedSwap(sessionId: string, session: CaddieSession): Promise<string | null> {
  const focus = session.activeShoppingContext;
  const replacing = focus?.replacing;
  const handle = focus?.pack;
  const offer = replacing?.offer;
  if (!replacing || !handle || !offer?.productId || offer.turn !== customerTurn(session)) return null;
  const deal = allDeals().find((entry) => entry.handle === handle);
  const step = deal?.steps[replacing.step];
  const product = productById(offer.productId);
  const outgoing = packPieces(session, handle)[replacing.step];
  if (!deal || !step || !product || !outgoing) return null;
  const size = replacing.size;
  if (!eligibilityFor(session, '', size ? [{ size }] : []).eligible(product)) return null;
  const question = `Shall I swap the ${titleCase(garmentName(outgoing.title))} for the ${titleCase(garmentName(product.title))} in ${colourwayName(product.title).toLowerCase()}${size ? `, in ${size}` : ''}?`;
  await setReplacement(sessionId, { ...replacing, offer: { productId: product.id, turn: offer.turn } });
  await sessions.patch(sessionId, {
    pendingAction: {
      type: 'replace-pack-piece',
      productIds: [product.id],
      pack: handle,
      step: replacing.step,
      outgoing: outgoing.id,
      ...(size ? { options: { size } } : {}),
      awaiting: 'confirmation',
      missing: ['confirmation'],
      authorized: false,
      question,
      turn: customerTurn(session, false),
      mission: currentMission(session),
    },
  });
  log.info('pending.offer_recorded', { sessionId, type: 'replace-pack-piece', product: product.title, from: 'suggested' });
  return question;
}

/**
 * An offer of "this" or "it", or of the lead by name, with the lead card the
 * code chose still on screen: the record is that product, in the size their
 * card choice or usual size gives, and the question stands - or becomes the
 * field still open. Null when the offer is of something else.
 */
async function bindLeadOffer(sessionId: string, session: CaddieSession, question: string, reply: string): Promise<string | null> {
  const lead = session.lastLead ? productById(session.lastLead.id) : null;
  if (!lead || !(session.lastShown?.items ?? []).some((item) => item.id === lead.id)) return null;
  const pronoun = /\b(?:this|it|that|this one|that one)\b/i.test(question);
  const named = identityProducts(resolveCustomerProductIdentity(question, 'offer'));
  const ofLead = named.some((product) => sameDesign(product, lead));
  if (!pronoun && !ofLead) return null;
  if (named.length && !ofLead) return null;
  const goal = customerGoal(session);
  if (goal?.products?.length && !goal.products.includes(lead.id)) return null;
  const card = session.cardChoices?.[lead.id]?.options ?? {};
  const sizeOption = sizeOptionName(lead);
  const options: Record<string, string> = { ...card };
  // The size the offer itself names ("add it in size L?") is the record's, over a card choice or their usual size: the words and the record must agree.
  // The size may be in the sentence before the question: "I can get it in size L. Should I add it?"
  const offered = sizeInRequest(question) ?? sizeInRequest(reply);
  const wanted = offered && sizeApplies(lead, offered) ? offered : (await knownSizeFor(session, lead));
  if (sizeOption && (offered || !options[sizeOption]) && wanted && sizeApplies(lead, wanted)) {
    const value = lead.options.find((option) => option.name === sizeOption)?.values.find((candidate) => optionValueMatches(candidate, wanted));
    if (value) options[sizeOption] = value;
  }
  const resolution = resolveVariant(lead, options);
  const missing: PendingNeed[] = [];
  if (resolution.status === 'incomplete') for (const option of resolution.missing) missing.push(needOf(option));
  missing.push('confirmation');
  const name = garmentName(lead.title);
  const asked = missing[0] === 'confirmation' ? question : questionFor(missing[0]!, name, lead, options);
  await sessions.patch(sessionId, {
    pendingAction: { type: 'add-product', productIds: [lead.id], ...(Object.keys(options).length ? { options } : {}), awaiting: missing[0]!, missing, authorized: false, question: asked, turn: customerTurn(session, false), mission: currentMission(session) },
  });
  log.info('pending.offer_recorded', { sessionId, type: 'add-product', products: [lead.title], missing, from: 'lead' });
  return asked;
}

/** What to ask for instead of a confirmation that binds nothing: the target still missing. */
function targetQuestion(session: CaddieSession): string {
  const focus = session.activeShoppingContext;
  const handle = focus?.pack;
  const deal = handle ? allDeals().find((entry) => entry.handle === handle) : undefined;
  if (focus?.replacing && deal?.steps[focus.replacing.step]) {
    const piece = deal.steps[focus.replacing.step]!.title.toLowerCase().replace(/\s*\/\s*/g, ' or ');
    return `Which ${piece} would you like in its place?`;
  }
  const goal = customerGoal(session);
  if ((goal?.kind === 'choose-product' || goal?.kind === 'add-product') && goal.products && goal.products.length > 1) {
    return `Which colour of the ${titleCase(garmentName(productById(goal.products[0]!)?.title ?? ''))} would you like?`;
  }
  return 'Which one would you like?';
}

/* ---------------- helpers ---------------- */

function namesOther(said: string, productIds: string[]): boolean {
  const named = identityProducts(resolveCustomerProductIdentity(said));
  if (!named.length) return false;
  const own = productIds.map((id) => productById(id)).filter((product): product is Product => !!product);
  return !named.some((product) => own.some((mine) => sameDesign(product, mine)));
}

async function clearOffer(sessionId: string): Promise<void> {
  const session = await sessions.getOrCreate(sessionId);
  const replacing = session.activeShoppingContext?.replacing;
  if (replacing?.offer) await setReplacement(sessionId, { step: replacing.step, candidates: replacing.candidates, ...(replacing.size ? { size: replacing.size } : {}) });
}

function fromOutcome(outcome: ActionOutcome): ToolResult {
  return {
    speech: outcome.speech,
    facts: outcome.facts,
    ...(outcome.actions ? { actions: outcome.actions } : {}),
    ...(outcome.cart ? { attachment: { kind: 'cart', cart: outcome.cart } } : {}),
    outcome: { ok: outcome.ok, action: outcome.action, ...(outcome.reason ? { reason: outcome.reason } : {}) },
  };
}

function titleCase(text: string): string {
  return text.toLowerCase().replace(/(^|[\s-])([a-z])/g, (_, gap: string, letter: string) => gap + letter.toUpperCase());
}

/** For tests and logs: the colourway a record has settled on, or its design. */
export function describePending(pending: PendingAction | undefined): string {
  if (!pending) return 'none';
  const products = pending.productIds.map((id) => productById(id)).filter((product): product is Product => !!product);
  const what = products.length === 1 ? products[0]!.title : products.length ? `${designOf(products[0]!.title)} (${products.map((product) => colourwayName(product.title)).join('/')})` : pending.pack ?? pending.lineId ?? '';
  return `${pending.type} ${what} awaiting ${pending.awaiting}${pending.authorized ? ' (authorised)' : ''}`;
}
