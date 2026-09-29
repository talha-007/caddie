import type { CaddieAttachment, CartAction, Product } from '@caddie/shared';
import { env } from '../env.js';
import { UpstreamError } from '../lib/errors.js';
import { fetchWithTimeout, Semaphore } from '../lib/http.js';
import { log } from '../lib/logger.js';
import { sessions, type CaddieSession } from '../session/store.js';
import { currentPack, currentScreen, livePending, tappedSinceLastSaid } from '../session/shoppingSession.js';
import { packStatus } from '../tools/packState.js';
import { describeShopper } from '../shopper/facts.js';
import { readCustomerTurn } from './turn.js';
import { completeGoal, confirmPackSwap, notePackSwapOffer, replacementRequired, runTool, toolDefinitionsForVapi } from '../tools/index.js';
import { asksForKnown, customerGoal, describeGoal, goalLog, type CustomerGoal } from '../tools/journey.js';
import { guardCards } from '../tools/eligibility.js';
import { alignReplyWithPending, knownSizeFor, notePendingOffer, resolvePending } from '../tools/pending.js';
import { UPDATING, basketStatement, unsettledOperation } from '../tools/cartOperations.js';
import { colourwayName, garmentName } from '../catalog/colourways.js';
import { costOfTokens } from '../usage/pricing.js';
import { record } from '../usage/store.js';
import { SYSTEM_PROMPT } from './prompt.js';
import { verifyReply, withoutClaims, type VerifyContext } from './verify.js';
import { namesADeal } from '../recommend/deals.js';
import { productById } from '../catalog/sync.js';
import { asksToAdd, asksToRemove, removalOfBasket, removalOnly } from '../tools/cartAuthorization.js';
import { readReply } from '../tools/answers.js';
import { needsModelReading, readTurnWithModel } from './readTurn.js';
import { ASKS_SIZE, SIZE_ON_CARD, SIZES_ON_CARDS } from '../tools/sizeHandoff.js';
import { customerTurn, describeFocus } from '../session/focus.js';
import { allDeals } from '../catalog/bundles.js';
import { primaryKind, resolveVariant, sizeApplies, sizeOptionName, sizeScale } from '../catalog/commerce.js';

/**
 * The Caddie's brain for text chat.
 *
 * Voice goes through Vapi, which runs its own model and calls our tools over
 * the webhook. Text comes through here. Both share one system prompt and one
 * tool registry, so the two paths cannot drift into different behaviour.
 *
 * The loop is deliberately short: the model calls tools, we run them, it gets
 * the results and answers. Anything needing more than a few rounds is a sign
 * the prompt is unclear rather than a reason to raise the limit.
 */

// One more than the tools need: a reply that fails the check (verify.ts) gets one rewrite.
const MAX_STEPS = 6;
/*
 * Every turn kept here is resent on every call in the loop, so this is a
 * cost dial - but a cheap one: the stable prefix is ~14,000 tokens and cached,
 * the history a few hundred. Eight messages was four exchanges, and in the
 * recorded conversations the model had forgotten the pack it was building
 * and the price it had quoted by turn five, while a customer was still
 * talking about them (admin log, 25-28 Sep). Twenty keeps a whole pack
 * conversation in view; MAX_MESSAGES in session/store.ts is the ceiling.
 */
const HISTORY_TURNS = 20;
/** How much of what the tools said in recent turns the model is shown (newest first). */
const TOOL_MEMORY_CHARS = 3500;

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface Choice {
  message: { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] };
  finish_reason: string;
}

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

export const openaiEnabled = (): boolean => Boolean(env.openai.apiKey);

/**
 * How many model calls may be in flight at once.
 *
 * Unbounded, a rush of customers becomes a rush of simultaneous calls, OpenAI
 * starts refusing them, and every one of those customers waits on a retry -
 * the queue has just moved somewhere we cannot see it. Holding the line here
 * keeps the failure mode a slightly longer wait instead of an error.
 */
const inFlight = new Semaphore(env.openai.maxConcurrent);

export function modelLoad(): { inFlight: number; queued: number } {
  return { inFlight: inFlight.inFlight, queued: inFlight.queued };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function callOnce(messages: ChatMessage[]): Promise<Response> {
  return fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    timeoutMs: env.openai.timeoutMs,
    label: 'OpenAI',
    headers: {
      Authorization: `Bearer ${env.openai.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: env.openai.model,
      messages,
      tools: toolDefinitionsForVapi(),
      tool_choice: 'auto',
    }),
  });
}

async function complete(messages: ChatMessage[]): Promise<{ choice: Choice; usage?: Usage }> {
  return inFlight.run(async () => {
    /*
     * A call that hangs is retried once, not waited out. About one call in
     * thirty stalled until the 45s limit and the customer got an error; the
     * same request sent again answers in two or three seconds. So the limit
     * is shorter (OPENAI_TIMEOUT_MS, 20s) and a timeout or dropped connection
     * gets one more go - worst case about forty seconds, not a dead turn.
     */
    let res: Response;
    try {
      res = await callOnce(messages);
    } catch (err) {
      log.warn('openai.retrying_after_error', { err: String(err).slice(0, 200) });
      res = await callOnce(messages);
    }

    /*
     * A 429 here is OpenAI's own rate limit, not ours, and it is usually over
     * in a second or two - unlike Shopify's. One short retry turns a failed
     * conversation into a slightly slow one. A 5xx gets the same treatment,
     * since those are typically transient.
     */
    if (res.status === 429 || res.status >= 500) {
      const after = Number(res.headers.get('retry-after'));
      const waitMs = Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 5000) : 1200;
      log.warn('openai.retrying', { status: res.status, waitMs });
      await sleep(waitMs);
      res = await callOnce(messages);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new UpstreamError(`OpenAI responded ${res.status}`, detail.slice(0, 500));
    }

    const body = (await res.json()) as { choices?: Choice[]; usage?: Usage };
    const choice = body.choices?.[0];
    if (!choice) throw new UpstreamError('OpenAI returned no choices');
    return { choice, usage: body.usage };
  });
}

/**
 * Reminds the model what the customer is currently looking at, so "that one",
 * "the cheaper one" and "a different colour" have something to attach to.
 */
/**
 * Where the customer is standing in the shop.
 *
 * Deliberately short. The system prompt is identical on every call and caches
 * at a quarter of the price; this varies per turn and does not, so it says
 * which product and nothing else. It is also a pointer rather than a fact -
 * it reached us through the browser, so the model is told to look the product
 * up rather than read anything here back to the customer.
 */
export function pageContext(session: CaddieSession): ChatMessage | null {
  const page = session.page;
  if (!page || page.pageType === 'other') return null;

  if (page.pageType === 'product') {
    // A product page we cannot name is worse than silence: it tells the model
    // there is a "this" to talk about without saying what it is.
    if (!page.productId) return null;

    const title = page.productTitle ? ` - ${page.productTitle}` : '';
    // Socks and belts come in one size: asked to add them, the Caddie asked which size.
    const product = productById(page.productId);
    const oneSize = product && sizeScale(product).oneSize ? ' It comes in one size only - never ask which size.' : '';
    return {
      role: 'system',
      content: `The customer is on the product page for [${page.productId}]${title}. "This", "it" and "this one" mean that product.${oneSize}`,
    };
  }

  return { role: 'system', content: `The customer is on the ${page.pageType} page.` };
}

export function screenContext(session: CaddieSession): ChatMessage | null {
  const shown = session.lastShown;
  if (!shown) return null;

  const bits = [`The customer is looking at a ${shown.kind} result on screen.`];
  if (shown.query) bits.push(`They asked for: "${shown.query}".`);
  if (shown.colour) bits.push(`Colour preference: ${shown.colour}.`);
  if (shown.budgetAmount) bits.push(`Budget: ${shown.budgetAmount}.`);
  bits.push(
    'On screen right now:\n' +
      shown.items.map((item) => `- ${item.title} [${item.id}]`).join('\n'),
  );

  return { role: 'system', content: bits.join(' ') };
}

/**
 * What they are shopping for now (session/focus.ts), said once, after what
 * is on screen: the cards can be older than the conversation. The tools hold
 * to it whatever the model picks; this is so it picks right the first time.
 */
function focusContext(session: CaddieSession): ChatMessage | null {
  const focus = session.activeShoppingContext;
  if (!focus || (!focus.kinds.length && !focus.productId && !focus.pack)) return null;
  const said = focus.request ? ` (their words: "${focus.request.slice(0, 120)}")` : '';
  const pack = focus.pack ? ` The pack they are putting together: ${allDeals().find((deal) => deal.handle === focus.pack)?.title ?? focus.pack}.` : '';
  const what = focus.kinds.length || focus.productId ? `What the customer is shopping for now: ${describeFocus(focus)}${said}. ` : '';
  return {
    role: 'system',
    content: `${what}${pack}${what ? ' A short follow-up - different colours, another one, show me more, cheaper, what sizes, is it waterproof - is about this, not about older cards still on screen.' : ''}`.trim(),
  };
}

/**
 * The customer's goal (tools/journey.ts): what is settled, never to be asked
 * again, and the one thing still needed. Per turn and short - it varies, so
 * it does not cache.
 */
function goalContext(goal: CustomerGoal | null): ChatMessage | null {
  if (!goal || goal.kind === 'browse-products') return null;
  return { role: 'system', content: describeGoal(goal) };
}

/**
 * What they picked on a product card themselves - the product they are
 * handling now, and the size they chose for it. "Add it" means this.
 */
function cardChoiceContext(session: CaddieSession): ChatMessage | null {
  // Only a tap since they last spoke: after that, "it" is whatever they talked about.
  const id = tappedSinceLastSaid(session);
  const choice = id ? session.cardChoices?.[id] : undefined;
  if (!id || !choice) return null;
  const title = productById(id)?.title ?? id;
  const picked = Object.entries(choice.options).map(([name, value]) => `${name} ${value}`).join(', ');
  return {
    role: 'system',
    content: `The customer picked ${picked} themselves on the card for ${title} [${id}]. "It", "this" and "add it" mean that product, in ${picked} - no need to ask - unless they now name a different size or product.`,
  };
}

/**
 * What is in their basket, with the ids that change it.
 *
 * Separate from what is on screen: the basket outlives every search. It used
 * to be one line - "they already have a basket open" - and asked to swap the
 * orange polo in it, the model could not see an orange polo anywhere and added
 * the new one beside it. A handful of short lines; cheap next to a wrong order.
 */
/** The basket and any unconfirmed change, in code's words, for the rewrite note. */
function basketWords(session: CaddieSession): string {
  const titled = (text: string) => text.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
  return basketStatement(session, (title) => titled(garmentName(title)), colourwayName).facts;
}

function basketContext(session: CaddieSession): ChatMessage | null {
  const lines = session.basket ?? [];
  // Theme-cart shoppers have no cart id of ours: the basket is what the widget reported.
  if ((!session.cartId && session.cartMode !== 'theme') || lines.length === 0) return null;
  return {
    role: 'system',
    content:
      'In their basket now:\n' +
      lines
        .map(
          (line) =>
            `- ${line.title}${line.variantTitle ? ` (${line.variantTitle})` : ''} x${line.quantity}${line.bundle ? " [part of a pack]" : ""} [product ${line.productId}] [line ${line.lineId}]`,
        )
        .join('\n') +
      (unsettledOperation(session)
        ? `\nStill being confirmed by the store cart, NOT in the basket yet: ${unsettledOperation(session)!.wording.title} ${unsettledOperation(session)!.wording.choice} x${unsettledOperation(session)!.quantity}. Say sizes and quantities only from the lines above.`
        : ''),
  };
}

/**
 * What the customer has told us they want, so it is never asked twice. After
 * the stable prompt, like the rest of the per-turn context, so the cache holds.
 */
/**
 * What the reply checker may know beyond this turn's card: what is on screen,
 * and which products' sizes are settled - tapped on their card, resolved in
 * the pack in hand (tools/packState.ts), or just put in the basket. Read
 * fresh: a tool this turn may have changed them.
 */
async function verifyContext(sessionId: string): Promise<VerifyContext> {
  const now = await sessions.getOrCreate(sessionId);
  const settled = new Set<string>();
  for (const [id, choice] of Object.entries(now.cardChoices ?? {})) {
    const product = productById(id);
    if (product && resolveVariant(product, choice.options).status === 'exact') settled.add(product.id);
  }
  const pack = currentPack(now);
  if (pack) for (const plan of packStatus(now, pack).pieces) if (!plan.missing.length) settled.add(plan.product.id);
  if (now.lastAdded) settled.add(now.lastAdded.productId);
  // The basket as the widget last reported it, and any change still being confirmed: what basket sentences are held to.
  const unsettled = Object.values(now.cartOperations ?? {})
    .filter((record) => record.status === 'dispatched' || record.status === 'uncertain')
    .map((record) => ({ ...(record.productId ? { productId: record.productId } : {}), title: record.wording.title, choice: record.wording.choice, quantity: record.quantity, ...(record.outgoing ? { outgoingChoice: record.outgoing.choice } : {}) }));
  return {
    screen: currentScreen(now)?.products ?? [],
    sizeSettled: settled,
    ...(now.cartMode === 'theme' ? { basket: (now.basket ?? []).map((line) => ({ productId: line.productId, title: line.title, variantTitle: line.variantTitle, quantity: line.quantity })), unsettled } : {}),
  };
}

export function shopperContext(session: CaddieSession): ChatMessage | null {
  const text = describeShopper(session, session.preferences.currency);
  return text ? { role: 'system', content: text } : null;
}

/** The lead's own words, recognised however the model rephrases them: its first five words in any punctuation ("Pick your size on the card" / "pick your size on the card—"). */
function leadUnless(speech: string): RegExp {
  const words = speech.split(/\s+/).filter((word) => /[a-z]/i.test(word)).slice(0, 5).map((word) => word.replace(/[^a-z0-9']/gi, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(words.join('\\W+'), 'i');
}

function history(session: CaddieSession): ChatMessage[] {
  return session.messages.slice(-HISTORY_TURNS).map((message) => ({
    role: message.role,
    content: message.text,
  }));
}

/**
 * What the tools said in the last turns, shown to the model. History holds
 * only the words; the cards, prices and sizes the tools returned were kept
 * for the reply checker (recentEvidence) and never shown to the model - so
 * "how much is the pack?" two turns after the pack card got a list of pieces
 * and no price, and "is it in medium?" went back to search (admin log). The
 * same text the checker holds the reply to is what the model reads.
 */
function toolMemoryContext(session: CaddieSession): ChatMessage | null {
  const kept = (session.recentEvidence ?? '').trim();
  if (!kept) return null;
  const shown = kept.length > TOOL_MEMORY_CHARS ? `${kept.slice(0, TOOL_MEMORY_CHARS)}\n[older results cut]` : kept;
  return {
    role: 'system',
    content: `What your tools returned in the last few turns, newest first. Use it to answer follow-ups about these products, prices, sizes and packs without asking or searching again; it is verified data. Anything not here still needs a tool.\n${shown}`,
  };
}

/**
 * Tools that change the basket, and so must never run alongside each other.
 *
 * Exported so it can be checked against the tool registry: adding a third
 * cart-writing tool and forgetting to name it here brings back the bug where
 * four adds became four separate baskets.
 */
export function writesToCart(name: string): boolean {
  return name === 'add_to_cart' || name === 'update_cart_item' || name === 'add_pack_to_cart';
}

/**
 * How much a card matters, when a turn produces several and only one is shown.
 *
 * Last-one-wins lost things. The model built an outfit and then, in the same
 * turn, asked the size tool whether the customer wanted mens or womens - and
 * the size tool's empty card replaced the outfit, so the customer never saw
 * what they asked for. So:
 *
 *   a basket just changed      the outcome of the turn
 *   an outfit or a pack        what they asked to be shown
 *   products, a basket read    the answer to a question
 *   a size with a size in it   a result, but it is in the words as well
 *   a size still being asked   a question, and the words carry it
 */
export function cardWeight(card: CaddieAttachment, wroteToCart: boolean): number {
  switch (card.kind) {
    case 'cart':
      return wroteToCart ? 5 : 3;
    case 'outfit':
    case 'pack':
      return 4;
    case 'products':
      return 3;
    case 'size':
      return card.recommendation.size ? 2 : 1;
    default:
      return 2;
  }
}

/** Two result lists as one, alternating, without repeats, capped so the card stays readable. */
export function interleave<T extends { id: string }>(first: T[], second: T[], cap = 12): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (let i = 0; out.length < cap && (i < first.length || i < second.length); i++) {
    for (const item of [first[i], second[i]]) {
      if (item && !seen.has(item.id) && out.length < cap) {
        seen.add(item.id);
        out.push(item);
      }
    }
  }
  return out;
}

export interface Reply {
  text: string;
  attachment?: CaddieAttachment;
  /** Store-cart changes the tools decided on, in order, for the widget to make. */
  actions?: CartAction[];
}

/** Who the turn belongs to, for the usage dashboard. Never used for anything else. */
export interface TurnMeta {
  client?: string;
}

export async function converse(sessionId: string, userText: string, meta?: TurnMeta): Promise<Reply> {
  /*
   * What this message says - about them, what they are shopping for, the
   * pack in hand - read by code before the model runs, so every tool this
   * turn already uses it (ai/turn.ts).
   */
  /*
   * The action the Caddie is waiting to finish, first (tools/pending.ts):
   * their yes, colour, size or no is read against that one record before
   * anything else moves - before the focus, which a second request in the
   * same message ("...and show me socks") would carry off. Complete and
   * theirs, it is done here, once.
   */
  /*
   * Their words read by a model first (ai/readTurn.ts), when they answer a
   * question or are not in English: the yes, the size, the colour that the
   * pattern readers below would otherwise miss. Cached for this turn, so
   * every reader that follows sees the same reading.
   */
  {
    const before = await sessions.getOrCreate(sessionId);
    const lastAssistant = [...before.messages].reverse().find((message) => message.role === 'assistant')?.text;
    const answering = !!before.pendingAction || /\?\s*$/.test(lastAssistant ?? '');
    if (needsModelReading(userText, answering)) await readTurnWithModel(userText, { sessionId, ...(lastAssistant ? { question: lastAssistant } : {}), ...(meta?.client ? { client: meta.client } : {}) });
  }
  /*
   * "Add everything" with an outfit on screen: every piece, each its own
   * add - the model called product details four times and added one, and
   * an offer waiting on the swapped polo then swallowed the words (journey
   * test, 29 Sep). A piece offered in a slot's place takes that slot.
   */
  const wantsAll = /\b(everything|all of (it|them|these|those)|the (whole |full |complete )?outfit|the lot|all (the |of the )?(pieces|items|four|three))\b/i.test(userText);
  {
    const before = await sessions.getOrCreate(sessionId);
    if (before.lastOutfit?.items?.length && asksToAdd(userText) && wantsAll && before.cartMode === 'theme' && !unsettledOperation(before)) {
      const offer = before.pendingAction?.type === 'add-product' && before.pendingAction.awaiting === 'confirmation' ? before.pendingAction : undefined;
      const offered = offer?.productIds.map((id) => productById(id)).find((product): product is Product => !!product);
      const items = before.lastOutfit.items.filter((item) => item.id).map((item) => {
        const own = productById(item.id);
        return offered && own && primaryKind(own) && primaryKind(own) === primaryKind(offered) ? offered.id : item.id;
      });
      if (offer) await sessions.patch(sessionId, { pendingAction: undefined });
      // What "everything" points at is the outfit, whatever search has replaced it on screen since: its pieces are the screen for these adds.
      await sessions.patch(sessionId, { lastShown: { kind: 'products', items: items.map((id) => ({ id, title: productById(id)?.title ?? '' })) } });
      const actions: CartAction[] = [];
      const cards: Product[] = [];
      let dispatched = 0;
      const speeches: string[] = [];
      for (const id of [...new Set(items)]) {
        const fresh = await sessions.getOrCreate(sessionId);
        // The size they gave for the outfit ("mens, medium") goes with each piece it applies to; the rest hand off to their cards.
        const piece = productById(id);
        // Their size for the outfit: known for the product, else the letter size they said most recently ("mens, medium").
        const saidLately = [...fresh.messages].filter((message) => message.role === 'user').slice(-6).reverse().map((message) => readReply(message.text).size).find((size) => !!size && !/^\d/.test(size));
        const known = (piece ? await knownSizeFor(fresh, piece) : undefined) ?? saidLately ?? before.lastOutfit?.size;
        const sizeOption = piece ? sizeOptionName(piece) : null;
        const options = piece && known && sizeOption && sizeApplies(piece, known) ? { [sizeOption]: known } : undefined;
        const added = await runTool('add_to_cart', { productId: id, ...(options ? { options } : {}) }, { session: fresh, utterance: userText, pendingActions: actions.length });
        if (added.actions?.length) actions.push(...added.actions);
        if (added.outcome?.ok) dispatched += 1;
        else if (added.attachment?.kind === 'products') cards.push(...added.attachment.products);
        else speeches.push(added.speech);
        const content = added.facts ? `${added.speech}\n\nFACTS (data, do not read aloud):\n${added.facts}` : added.speech;
        await sessions.patch(sessionId, { recentEvidence: [content, (await sessions.getOrCreate(sessionId)).recentEvidence ?? ''].join('\n').slice(0, 8000) });
      }
      log.info('journey.outfit_added_before_model', { sessionId, pieces: items.length, dispatched, needSize: cards.length, swappedIn: offered?.title ?? null });
      const text = [dispatched ? UPDATING : '', cards.length ? SIZES_ON_CARDS : '', ...speeches.slice(0, 1)].filter(Boolean).join(' ').trim();
      if (cards.length) await sessions.patch(sessionId, { lastShown: { kind: 'products', items: cards.map((product) => ({ id: product.id, title: product.title })) } });
      return { text: text || SIZES_ON_CARDS, ...(cards.length ? { attachment: { kind: 'products' as const, products: cards } } : {}), ...(actions.length ? { actions } : {}) };
    }
  }
  const pendingTurn = await resolvePending(sessionId, userText);
  const turnRead = await readCustomerTurn(sessionId, userText);
  const session = await sessions.getOrCreate(sessionId);
  const turnStartedAt = Date.now();
  // The job they are doing (tools/journey.ts), read from the session this turn's words have just updated.
  const startGoal = customerGoal(session, userText);
  log.info('journey.goal', { sessionId, at: 'start', ...goalLog(startGoal) });

  /*
   * A yes to the pack swap just offered is made here, before the model runs.
   * Left to the model, "Yes, please replace it" went to add_pack_to_cart, the
   * pack was still not ready for the sold-out Warrior, and the same swap was
   * offered again (Cool & Wet, preview store). The tool's own words say what
   * changed and the one thing the pack needs next.
   */
  // Through the same last check as every tool's card (tools/eligibility.ts).
  /*
   * A piece of the pack in hand can no longer be had in the size just given
   * (revalidatePack): that is this turn's answer, before the model runs - what
   * cannot stay, and only what can be had in its place, for them to choose.
   * Never a substitute picked for them after they have seen the pack.
   */
  const revalidated = turnRead.revalidated;
  const revalidatedDeal = revalidated ? allDeals().find((deal) => deal.handle === revalidated.handle) : undefined;
  if (revalidated && revalidatedDeal) {
    const required = await guardCards(await replacementRequired({ session, utterance: userText }, revalidatedDeal, revalidated.step), { session: await sessions.getOrCreate(sessionId), utterance: userText }, 'pack-revalidation');
    log.info('journey.replacement_required_before_model', { sessionId, pack: revalidated.handle, piece: revalidated.piece });
    const content = required.facts ? `${required.speech}\n\nFACTS (data, do not read aloud):\n${required.facts}` : required.speech;
    await sessions.patch(sessionId, { recentEvidence: [content, session.recentEvidence ?? ''].join('\n').slice(0, 8000) });
    return { text: required.speech, ...(required.attachment ? { attachment: required.attachment } : {}) };
  }

  /*
   * Their message was about the waiting action and nothing else: what was
   * done, or the one thing still needed, is the reply - the model is not
   * asked whether an action already made should be made, or a question
   * already answered asked again.
   */
  /*
   * Superseded is never "only the pending": the words that set the record
   * aside are a new request, in any script - an Urdu-script "add the Bouncer"
   * once got "No problem - nothing has been added" because its letters were
   * not a-z (29 Sep).
   */
  const onlyPending = pendingTurn.status !== 'none' && pendingTurn.status !== 'superseded' && !/\p{L}{3,}/u.test(pendingTurn.remainder);
  if (onlyPending) {
    const result = pendingTurn.result ?? { speech: 'No problem - nothing has been added.', facts: 'They cancelled the waiting action. Nothing changed.' };
    log.info('journey.pending_answered_before_model', { sessionId, status: pendingTurn.status, action: result.outcome?.action ?? null, ok: result.outcome?.ok ?? null });
    const content = result.facts ? `${result.speech}\n\nFACTS (data, do not read aloud):\n${result.facts}` : result.speech;
    await sessions.patch(sessionId, { recentEvidence: [content, session.recentEvidence ?? ''].join('\n').slice(0, 8000) });
    // What the action's own words offer next ("shall I add the pack?") is bound like any other offer.
    await notePackSwapOffer(sessionId, result.speech);
    await notePendingOffer(sessionId, result.speech);
    return { text: result.speech, ...(result.attachment ? { attachment: result.attachment } : {}), ...(result.actions?.length ? { actions: result.actions } : {}) };
  }

  const confirmed = await confirmPackSwap({ session, utterance: userText });
  const swapped = confirmed ? await guardCards(confirmed, { session, utterance: userText }, 'confirm-pack-swap') : null;
  if (swapped) {
    log.info('journey.swap_confirmed_before_model', { sessionId });
    const content = swapped.facts ? `${swapped.speech}\n\nFACTS (data, do not read aloud):\n${swapped.facts}` : swapped.speech;
    await sessions.patch(sessionId, { recentEvidence: [content, session.recentEvidence ?? ''].join('\n').slice(0, 8000) });
    await notePackSwapOffer(sessionId, swapped.speech);
    await notePendingOffer(sessionId, swapped.speech);
    return { text: swapped.speech, ...(swapped.attachment ? { attachment: swapped.attachment } : {}), ...(swapped.actions?.length ? { actions: swapped.actions } : {}) };
  }

  /*
   * A removal of the basket as a whole, a pack, or "them", said outright and
   * nothing else asked: made here, before the model runs. "Remove these
   * items from my basket" got a question and no tool; "remove them all" got
   * six refused calls and the model's own "remove the entire pack?" with
   * nothing recorded behind it; "please remove it" was then a new "it" to
   * resolve (live, pack removal). The gateway reads their words, takes out
   * the lines they mean or asks one question bound to every line, and the
   * customer hears its exact words.
   */
  /*
   * "What colours does it come in?" about the product in hand: the colours
   * tool, before the model. Left to the model it searched for rain gear
   * and answered about a jacket (journey test, 29 Sep).
   */
  const asksColours = /\b(what|which) colou?rs?\b|\bcolou?rs? (does|do) (it|this|that|they|these) come in\b|\bother colou?rs?\b|\bcome in (any )?(other|different) colou?rs?\b|\bany other colou?rs?\b/i.test(userText);
  const inHandId = session.page?.pageType === 'product' && session.page.productId ? session.page.productId : session.activeShoppingContext?.productId ?? session.lastLead?.id;
  if (pendingTurn.status === 'none' && asksColours && inHandId && !asksToAdd(userText)) {
    const colours = await runTool('other_colours', { productId: inHandId }, { session, utterance: userText });
    log.info('journey.colours_before_model', { sessionId, productId: inHandId, ok: !colours.outcome || colours.outcome.ok });
    const content = colours.facts ? `${colours.speech}\n\nFACTS (data, do not read aloud):\n${colours.facts}` : colours.speech;
    await sessions.patch(sessionId, { recentEvidence: [content, session.recentEvidence ?? ''].join('\n').slice(0, 8000) });
    if (colours.attachment?.kind === 'products') await sessions.patch(sessionId, { lastShown: { kind: 'products', items: colours.attachment.products.map((product) => ({ id: product.id, title: product.title })) } });
    return { text: colours.speech, ...(colours.attachment ? { attachment: colours.attachment } : {}) };
  }
  if (pendingTurn.status === 'none' && !livePending(session) && !session.basket && session.cartMode === 'theme' && removalOfBasket(userText)) {
    // The widget has not reported the basket yet (its sync on open is fire-and-forget): said so, rather than "which item?" over lines the server cannot see.
    log.warn('journey.basket_unknown', { sessionId });
    const speech = "I can't see your basket from here just yet - give it a second and ask me again, or open the cart with the basket icon.";
    await sessions.patch(sessionId, { recentEvidence: [speech, session.recentEvidence ?? ''].join('\n').slice(0, 8000) });
    return { text: speech };
  }
  if (pendingTurn.status === 'none' && !livePending(session) && session.basket && session.cartMode === 'theme' && (removalOfBasket(userText) || (!session.basket.length && removalOnly(userText)))) {
    const removed = await runTool('update_cart_item', { lineId: session.basket[0]?.lineId ?? 'none', quantity: 0 }, { session, utterance: userText });
    log.info('journey.removal_before_model', { sessionId, ok: removed.outcome?.ok ?? null, reason: removed.outcome?.reason ?? null, dispatched: removed.outcome?.dispatched ?? false });
    const content = removed.facts ? `${removed.speech}\n\nFACTS (data, do not read aloud):\n${removed.facts}` : removed.speech;
    await sessions.patch(sessionId, { recentEvidence: [content, session.recentEvidence ?? ''].join('\n').slice(0, 8000) });
    return { text: removed.speech, ...(removed.attachment ? { attachment: removed.attachment } : {}), ...(removed.actions?.length ? { actions: removed.actions } : {}) };
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...([pageContext(session), screenContext(session), focusContext(session), goalContext(startGoal), basketContext(session), shopperContext(session), toolMemoryContext(session)].filter(Boolean) as ChatMessage[]),
    ...history(session),
    /*
     * Last before their words: the tap happened after the reply before it.
     * Placed with the other context, it lost to the history - the model added
     * the jacket it had just recommended, not the one they had tapped.
     */
    ...([cardChoiceContext(session)].filter(Boolean) as ChatMessage[]),
    { role: 'user', content: userText },
  ];

  /*
   * What this turn's reply may rest on: the customer's own words, what is on
   * their screen and in their basket, what they have told us, every tool
   * result this turn - and the Caddie's own earlier replies. Those were once
   * excluded as "what is being checked", but every reply in history has
   * already passed this same check before it went out, so a price or a name
   * the Caddie has said is one it verified. Without them, "how much is the
   * pack?" two turns after "£129.99" lost the figure (admin log). See
   * verify.ts.
   */
  const evidence: string[] = [
    userText,
    ...messages.slice(1).filter((m) => m.role === 'system' || m.role === 'user' || m.role === 'assistant').map((m) => String(m.content ?? '')),
    // What the tools said in the last turns: "how much is the pack?" is answered from a card already shown.
    session.recentEvidence ?? '',
  ];
  const toolEvidence: string[] = [];
  /** Kept for the next turn's check: this turn's tool results first, then what was already kept. */
  const keepEvidence = () =>
    sessions.patch(sessionId, { recentEvidence: [...toolEvidence, session.recentEvidence ?? ''].join('\n').slice(0, 8000) });
  let lastToolSpeech = '';
  // What the Action Gateway said about each basket action this turn - whether it happened is its word, not the model's.
  const outcomes: Array<{ ok: boolean; action: string; reason?: string; dispatched?: boolean; speech: string }> = [];
  // A sentence a tool said the reply must open with - see ToolResult.lead.
  let lead: { text: string; unless: RegExp } | undefined;
  let rewrote = false;
  let showRewrote = false;
  // Whether an add was tried this turn - once it has, a question back is the tool's, not the model skipping it.
  let addTried = false;
  // Whether the goal was carried out by code this turn (see below) - once, never twice.
  let goalCarriedOut = false;

  let attachment: CaddieAttachment | undefined;
  const actions: CartAction[] = [];
  let attachmentWeight = -1;

  /*
   * The waiting action dealt with before the model ran, and a second request
   * in the same message: the model is told what was done - or what is still
   * needed, which opens the reply - and answers the rest. "Yeah, that will be
   * fine. Can we create a pack as well?" adds the jacket once and then builds
   * the pack, in one turn.
   */
  if (pendingTurn.status !== 'none') {
    const result = pendingTurn.result;
    if (result) {
      if (result.actions) actions.push(...result.actions);
      if (result.outcome) outcomes.push({ ...result.outcome, speech: result.speech });
      if (result.attachment) {
        attachment = result.attachment;
        attachmentWeight = cardWeight(result.attachment, !!result.outcome?.ok);
      }
      const content = result.facts ? `${result.speech}\n\nFACTS (data, do not read aloud):\n${result.facts}` : result.speech;
      evidence.push(content);
      toolEvidence.push(content);
      lastToolSpeech = result.speech;
    }
    const note =
      pendingTurn.status === 'executed'
        ? `Already done this turn, before you: "${result?.speech ?? ''}" It is done - do not do it again, do not offer it again, do not ask about it. Now answer the rest of what they said: "${pendingTurn.remainder}".`
        : pendingTurn.status === 'asked'
          ? `The action they asked for is still waiting: ${result?.speech ?? ''} Your reply must open with exactly that question (nothing has been added). Then answer the rest of what they said: "${pendingTurn.remainder}".`
          : `They cancelled what was waiting - nothing was added or changed. Answer what they said: "${pendingTurn.remainder}".`;
    messages.splice(messages.length - 1, 0, { role: 'system', content: note });
    evidence.push(note);
    /*
     * The action's own words open the reply whether it is still asking or
     * was just done. "Red blazer, you already know my size" executed the
     * waiting add, and the model answered only the rest - "we don't stock a
     * red blazer" - so the customer never heard that the jacket was going in
     * (admin log, 28 Sep).
     */
    if ((pendingTurn.status === 'asked' || pendingTurn.status === 'executed') && result?.speech) lead = { text: result.speech, unless: leadUnless(result.speech) };
    log.info('journey.pending_before_model', { sessionId, status: pendingTurn.status, remainder: pendingTurn.remainder.slice(0, 80) });
  }
  /** Set when searches were merged, so "on screen" is updated to match. */
  let merged = false;

  // Tracked so cost per conversation is a measurement rather than a guess.
  let promptTokens = 0;
  let cachedTokens = 0;
  let completionTokens = 0;

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const startedAt = Date.now();
    const { choice, usage } = await complete(messages);

    promptTokens += usage?.prompt_tokens ?? 0;
    cachedTokens += usage?.prompt_tokens_details?.cached_tokens ?? 0;
    completionTokens += usage?.completion_tokens ?? 0;

    log.debug('openai.step', { step, ms: Date.now() - startedAt, finish: choice.finish_reason });

    const calls = choice.message.tool_calls ?? [];

    /*
     * The reply, checked before anyone hears it. A claim the tools did not
     * back gets one rewrite, told exactly what to drop; if the rewrite still
     * makes one, those sentences go, and if nothing is left, the tool's own
     * words - which are always exact - are what the customer hears.
     */
    let finalText = choice.message.content?.trim() ?? '';
    // The goal as the turn ends - what the reply is judged against.
    let turnGoal: CustomerGoal | null = null;
    if (calls.length === 0 && !goalCarriedOut) {
      const now = await sessions.getOrCreate(sessionId);
      const goal = customerGoal(now, userText);
      turnGoal = goal;
      /*
       * Ready and authorised, and nothing done: done now, by code. The model
       * asking "shall I add it?" to "yes, add this, size small" - with the
       * product, colour and size all settled - was a loop the customer could
       * not get out of. Whatever the model did with the turn, the outcome is
       * the same.
       */
      if (goal?.status === 'ready' && !outcomes.some((outcome) => outcome.ok)) {
        const done = await completeGoal(goal, { session: now, utterance: userText, pendingActions: actions.length });
        const succeeded = !!done && (done.outcome ? done.outcome.ok : done.attachment?.kind === 'pack');
        if (done && succeeded) {
          goalCarriedOut = true;
          log.info('journey.completed_by_code', { sessionId, ...goalLog(goal), modelSaid: finalText.slice(0, 160) });
          if (done.actions) actions.push(...done.actions);
          if (done.outcome) outcomes.push({ ...done.outcome, speech: done.speech });
          if (done.attachment) {
            attachment = done.attachment;
            attachmentWeight = cardWeight(done.attachment, !!done.outcome);
          }
          const content = done.facts ? `${done.speech}\n\nFACTS (data, do not read aloud):\n${done.facts}` : done.speech;
          evidence.push(content);
          toolEvidence.push(content);
          lastToolSpeech = done.speech;
          // The tool's own words are exact: what was done, and the next thing the goal needs.
          finalText = done.speech;
        }
      }
      /*
       * Asked to add, the goal still missing something, and no add tried: the
       * add is still what they asked for. The model answered "which size?"
       * without calling add_to_cart, so nothing was waiting - the "S" that
       * followed authorised nothing, and the Caddie asked "shall I add it?".
       * The request goes to the gateway now: it records the add as waiting,
       * on exactly what is missing, so their answer finishes it.
       */
      if (!goalCarriedOut && goal && (goal.kind === 'choose-product' || goal.kind === 'add-product') && goal.status === 'open' && goal.products?.length && !addTried && asksToAdd(userText) && !livePending(now)) {
        addTried = true;
        const asked = await runTool('add_to_cart', { productId: goal.products[0]! }, { session: now, utterance: userText, pendingActions: actions.length });
        log.info('journey.add_requested_by_code', { sessionId, ok: asked.outcome?.ok ?? null, reason: asked.outcome?.reason ?? null, ...goalLog(goal) });
        if (asked.outcome) outcomes.push({ ...asked.outcome, speech: asked.speech });
        const content = asked.facts ? `${asked.speech}\n\nFACTS (data, do not read aloud):\n${asked.facts}` : asked.speech;
        evidence.push(content);
        toolEvidence.push(content);
        if (asked.outcome?.ok) {
          goalCarriedOut = true;
          if (asked.actions) actions.push(...asked.actions);
          if (asked.attachment) {
            attachment = asked.attachment;
            attachmentWeight = cardWeight(asked.attachment, true);
          }
          finalText = asked.speech;
        } else {
          // Refused with a choice to make: the candidates go on screen with the question, so a tap can answer it.
          if (asked.attachment?.kind === 'products') {
            attachment = asked.attachment;
            attachmentWeight = cardWeight(asked.attachment, false);
          }
          if (!/\?/.test(finalText)) finalText = asked.speech;
        }
      }
      /*
       * The same for the pack: "add the pack to my basket" answered with
       * "which leg length?" and no tool called, so nothing recorded that they
       * had asked - and their "34" then bought them "shall I add it?" (live
       * replay, V1 task 3). The gateway records the add, with their yes, on
       * exactly what the pack still needs.
       */
      if (!goalCarriedOut && goal?.kind === 'configure-pack' && !addTried && asksToAdd(userText) && !livePending(now)) {
        addTried = true;
        const asked = await runTool('add_pack_to_cart', {}, { session: now, utterance: userText, pendingActions: actions.length });
        log.info('journey.pack_add_requested_by_code', { sessionId, ok: asked.outcome?.ok ?? null, reason: asked.outcome?.reason ?? null });
        if (asked.outcome) outcomes.push({ ...asked.outcome, speech: asked.speech });
        const content = asked.facts ? `${asked.speech}\n\nFACTS (data, do not read aloud):\n${asked.facts}` : asked.speech;
        evidence.push(content);
        toolEvidence.push(content);
        if (asked.outcome?.ok) {
          goalCarriedOut = true;
          if (asked.actions) actions.push(...asked.actions);
          if (asked.attachment) {
            attachment = asked.attachment;
            attachmentWeight = cardWeight(asked.attachment, true);
          }
          finalText = asked.speech;
        } else if (!/\?/.test(finalText)) finalText = asked.speech;
      }
      /*
       * Offering again what is done - "shall I add it now?" to a bare "yes"
       * after the jacket went in. Sent back once: it is in the basket.
       */
      if (goal?.status === 'done' && !goalCarriedOut && !rewrote && /\b(add|put)\b[^.?!]*\?|\b(shall i|should i|would you like me to|want me to|like me to) (add|put)\b/i.test(finalText)) {
        rewrote = true;
        log.warn('reply.offered_done_again', { sessionId, ...goalLog(goal) });
        messages.push({ role: 'assistant', content: finalText });
        messages.push({ role: 'system', content: `${goal.known.product ?? 'It'} is already in their basket - it went in earlier. Do not offer to add it again. Say it is in their basket and ask whether they need anything else.` });
        continue;
      }
      /*
       * Asking again for what is settled - "what size?" to a customer who has
       * said S twice. Sent back once, told what is known and the one thing
       * still needed.
       */
      const askedAgain = goal && !goalCarriedOut ? asksForKnown(goal, finalText) : [];
      if (goal && askedAgain.length && !rewrote) {
        rewrote = true;
        log.warn('reply.asked_known', { sessionId, asked: askedAgain, ...goalLog(goal) });
        messages.push({ role: 'assistant', content: finalText });
        messages.push({ role: 'system', content: `Do not ask for ${askedAgain.join(' or ')} - it is already settled. ${describeGoal(goal)}` });
        continue;
      }
    }
    /*
     * The record before the words (V1 task 3): a swap or an add the model's
     * reply offers is bound now, from what the session holds - the one
     * candidate, the product in hand, its size - before the checker below
     * may rewrite the reply. A rewrite that loses the product's name, or the
     * question, loses nothing: the record stands and the question comes back
     * from it (alignReplyWithPending). After the goal above: an add the
     * customer asked for is the gateway's record, with their authorisation
     * - never an offer's, which would wait for a yes they already gave.
     */
    if (calls.length === 0 && finalText && !rewrote) {
      await notePackSwapOffer(sessionId, finalText);
      await notePendingOffer(sessionId, finalText);
    }
    /*
     * Asking the customer to confirm a product's name without having looked.
     * "Could you confirm the exact name of the jacket?" came back for the Tour
     * Championship Jacket, with no search at all - the catalogue check would
     * have answered it. Sent back once to look first.
     */
    const asksForName = /\b(confirm|check)\b[^.?]{0,40}\b(exact |product |full |the )?name\b|\bunder (a )?(slightly )?different name\b/i.test(finalText);
    const checked = evidence.some((entry) => entry.includes('Catalogue check:'));
    // Asking for the name when the catalogue has not been checked for it - whether or not anything else was searched.
    if (calls.length === 0 && !rewrote && !checked && asksForName) {
      rewrote = true;
      log.warn('reply.asked_without_looking', { sessionId });
      messages.push({ role: 'assistant', content: finalText });
      messages.push({
        role: 'system',
        content:
          'Do not ask them to confirm the name - look it up. Call search_products with the name they gave as productName; the catalogue check says whether Druids sells it. Then answer.',
      });
      continue;
    }
    /*
     * Asked to add something, and answered with "what size?" without trying.
     * "Add this one pair tour ankle socks to my basket" got "What size would
     * you like?" three times in three - the socks come in one size, and the
     * customer had to ask why. add_to_cart knows what the product needs and
     * asks for exactly what is missing, so it goes first.
     */
    /*
     * The same, after a search: "Add the One Pair Tour Ankle Socks to my
     * basket" was searched, then answered "which colour?" and "what size?" -
     * one size, and only one colour in stock. Whatever the question, when
     * they asked to add and nothing was tried, the add tool goes first: it
     * knows which product they named and asks for exactly what is missing.
     */
    const asksSize = ASKS_SIZE.test(finalText);
    const askedInstead = asksSize || /\?\s*$/.test(finalText);
    /*
     * "What size do you need?" as the closing line of every search. In the
     * recorded conversations it ended replies to "show me the cheapest
     * jackets" and "show me trousers" alike, and a customer who was
     * browsing was interrogated instead of helped (admin log). Their size is
     * asked when they are buying. Sent back once, told to end with an offer.
     */
    /*
     * The Caddie never asks for a size (tools/sizeHandoff.ts): the card does.
     * A reply that asks is sent back once; if it asks again, the question
     * comes off and, when an add is waiting on a size, the card's line goes
     * in its place.
     */
    /*
     * "Which colour of the Block Pique Polo would you like?" at the end of an
     * answer to "which is better for hot weather?" (journey test, 29 Sep): a
     * colour is asked when they are adding, never as the closing line of an
     * answer. The question comes off.
     */
    const asksColourChoice = /\s*[^.?!]*\bwhich (colour|color)\b[^?]*\?/i;
    if (calls.length === 0 && asksColourChoice.test(finalText) && !asksToAdd(userText) && (await sessions.getOrCreate(sessionId)).pendingAction?.awaiting !== 'colour') {
      const stripped = finalText.replace(asksColourChoice, '').trim();
      if (stripped) {
        log.warn('reply.colour_question_removed', { sessionId });
        finalText = stripped;
      }
    }
    /*
     * "Which one would you like?" as the closing line over a screen of
     * results, with nothing waiting: the customer has just been shown six
     * cards and asked to do the Caddie's job (journey test, 29 Sep). It comes
     * off; the recommendation and one offer stand. Kept when a real choice
     * is waiting - two lines in the basket, two designs named - because then
     * the question is the code's own.
     */
    const askedWhichOne = /\s*[^.?!]*\bwhich (one|ones|of (these|those|them))?\s*(would you|do you|are you)?\s*(like|prefer|want|fancy|going for|choose|pick)\b[^?]*\?/i;
    if (calls.length === 0 && attachment?.kind === 'products' && askedWhichOne.test(finalText) && !outcomes.length && !livePending(await sessions.getOrCreate(sessionId))) {
      const stripped = finalText.replace(askedWhichOne, '').trim();
      if (stripped) {
        log.warn('reply.which_one_removed', { sessionId });
        finalText = stripped;
      }
    }
    const askedAboutTheirSize = /\b(what size am i|my size|which size (am i|would i be|do i need)|size (guide|chart))\b/i.test(userText);
    if (calls.length === 0 && asksSize && !askedAboutTheirSize) {
      if (!rewrote) {
        rewrote = true;
        log.warn('reply.asked_size', { sessionId });
        messages.push({ role: 'assistant', content: finalText });
        messages.push({
          role: 'system',
          content:
            `Never ask their size - they choose it on the product page (View product). ${asksToAdd(userText) || livePending(await sessions.getOrCreate(sessionId)) ? `Say exactly: "${SIZE_ON_CARD}"` : 'Keep your recommendation and end with one offer instead - to add the one you led with, or to narrow down by colour, budget or the weather they play in.'} One sentence, no size question.`,
        });
        continue;
      }
      const stripped = finalText.replace(/,?\s*(and|or)\s+(what|which)\s+(top |waist |leg )?size[^?]*\?/i, '?').replace(/\s*[^.?!]*\b(what|which)\s+(top |waist |leg )?size\b[^?]*\?/i, '').replace(/\s*[^.?!]*\bsize (would|do|should|will) you\b[^?]*\?/i, '').trim();
      const waitingOnSize = livePending(await sessions.getOrCreate(sessionId))?.awaiting;
      const handoff = waitingOnSize === 'size' || waitingOnSize === 'waist' || waitingOnSize === 'leg' ? ` ${SIZE_ON_CARD}` : '';
      log.warn('reply.size_question_removed', { sessionId });
      finalText = `${stripped}${handoff}`.trim() || SIZE_ON_CARD;
    }
    /*
     * Not when the goal still needs something: "add this Hexa instead of the
     * red jacket" rightly gets "which colour?" - sent back to call
     * add_to_cart, it put a standalone jacket beside the pack.
     */
    const goalStillNeeds = !!turnGoal && (turnGoal.kind === 'replace-pack-piece' || turnGoal.kind === 'configure-pack') && turnGoal.missing.length > 0;
    if (calls.length === 0 && !rewrote && !addTried && !goalStillNeeds && askedInstead && asksToAdd(userText)) {
      rewrote = true;
      log.warn(asksSize ? 'reply.asked_size_without_trying' : 'reply.asked_instead_of_adding', { sessionId });
      messages.push({ role: 'assistant', content: finalText });
      messages.push({
        role: 'system',
        content:
          'They asked to add it. Call add_to_cart now (add_pack_to_cart for a pack) with the product they named and any size or colour they have given - many products come in one size, or one colour in stock, and need nothing more. If something is really needed, the tool says exactly what, and you ask for that.',
      });
      continue;
    }
    /*
     * A deal named, and answered with a question instead of the deal. "An
     * Ambassador Pack, I mostly play in the rain" got "which version would you
     * like?" with no tool called - the tool reads the weather and picks Cool &
     * Wet itself. Sent back once to call it.
     */
    /*
     * Asked to take something out, and answered with a question instead of
     * the tool. "Remove these items from my basket" got "which item?" with
     * no tool called - update_cart_item reads their words and asks only what
     * is really missing. Sent back once to call it.
     */
    if (calls.length === 0 && !rewrote && !goalCarriedOut && !livePending(await sessions.getOrCreate(sessionId)) && (session.basket ?? []).length && asksToRemove(userText) && /\?\s*$/.test(finalText) && !outcomes.length) {
      rewrote = true;
      log.warn('reply.asked_instead_of_removing', { sessionId });
      messages.push({ role: 'assistant', content: finalText });
      messages.push({
        role: 'system',
        content:
          'They asked to take something out of the basket. Do not ask which - call update_cart_item now with quantity 0 and the line id you think they mean (one call is enough for "all", "them" or "the pack"). The tool reads their words, takes out the lines they mean, and asks for exactly what is missing if anything is.',
      });
      continue;
    }
    /*
     * Asked to see something, and nothing shown. "Show me the cheapest polo
     * and the most expensive" was answered "would you like to narrow down
     * by colour or budget?" with no search at all; "I also want to see
     * yellow" was answered from memory with no new cards (live, 29 Sep).
     * A customer who asks to see gets a screen. Sent back once to search.
     */
    const asksToSee = /\b(show|see|find|looking for|browse|cheapest|expensive|dearest|priciest|options?|what (do|have) you (got|have)|do you have|any (other|more)|as well|too)\b/i.test(userText);
    if (calls.length === 0 && !showRewrote && !attachment && !goalCarriedOut && !outcomes.length && asksToSee && !asksToAdd(userText) && !asksToRemove(userText)) {
      // Its own allowance: the size-reflex rewrite often runs first on the same turn, and a screen matters more than the wording.
      showRewrote = true;
      log.warn('reply.answered_without_showing', { sessionId });
      messages.push({ role: 'assistant', content: finalText });
      messages.push({
        role: 'system',
        content:
          'They asked to see products and nothing new is on screen. Call search_products now with their words (colour, price, kind as they said them - "cheapest" and "most expensive" are read by the tool) and then reply in one sentence about what it returned. Do not answer from memory.',
      });
      continue;
    }
    if (calls.length === 0 && !rewrote && step === 0 && namesADeal(userText) && /\?\s*$/.test(finalText)) {
      rewrote = true;
      log.warn('reply.skipped_the_deal', { sessionId });
      messages.push({ role: 'assistant', content: finalText });
      messages.push({
        role: 'system',
        content:
          'They named a deal. Call recommend_pack with their words (including any weather or trip) before asking anything - it builds the pack, or tells you exactly what to ask.',
      });
      continue;
    }
    /*
     * A change announced with no tool called. "I'll swap back the cap for the
     * belt" went out with the cap still in the pack - nothing had been asked
     * to change it. Sent back once to make the change, then say so.
     */
    const claimsChange =
      // "Shall I add it?" is an offer, not a claim: a bare "I" only with a past tense (V1 task 3).
      /\b(I'?ve|I have|I'?ll|I will)\s+(now\s+)?(swapped|changed|switched|replaced|updated|added|removed|swap|change|switch|replace|update|add|remove)\b|\bI\s+(now\s+)?(swapped|changed|switched|replaced|updated|added|removed)\b|\bhas been (swapped|changed|replaced|added|removed)\b/i.test(
        finalText,
      );
    if (calls.length === 0 && !rewrote && step === 0 && claimsChange) {
      rewrote = true;
      log.warn('reply.claimed_without_doing', { sessionId });
      messages.push({ role: 'assistant', content: finalText });
      messages.push({
        role: 'system',
        content:
          'Nothing has changed yet - no tool was called. Make the change first (recommend_pack with swap for a pack piece, the cart tools for the basket), then tell them what the tool says changed.',
      });
      continue;
    }
    /*
     * The catalogue check has already answered - nothing is called that - and
     * the reply still hedges: "I couldn't find it, could you check the name?"
     * That reads as though it might exist. Said plainly, once.
     */
    const provedAbsent = evidence.some((entry) => entry.includes('nothing in the Druids catalogue is called'));
    if (calls.length === 0 && !rewrote && provedAbsent && asksForName) {
      rewrote = true;
      log.warn('reply.hedged_after_check', { sessionId });
      messages.push({ role: 'assistant', content: finalText });
      messages.push({
        role: 'system',
        content:
          'The catalogue check covered every product: Druids does not sell it. Say "we don\'t stock the [name]" plainly, then offer the closest options. Do not ask them to check or confirm the name.',
      });
      continue;
    }
    /*
     * "I've added it" after the gateway refused the add. The tool said nothing
     * changed and why; a reply that says otherwise is sent back once, and if
     * it still claims the change, the gateway's own words are what is said.
     */
    const refused = outcomes.filter((outcome) => !outcome.ok);
    const claimsDone =
      /\b(i'?ve|i have|i'?m|i am|it'?s|they'?re|is|are|has been|have been)\s+(now\s+)?(added|adding|put|putting|placed|placing|removed|removing|taken|taking|updated|updating|changed|changing|swapped|swapping)\b|\b(going|gone|goes)\s+(in|into)\s+(your|the)\s+(basket|cart|bag)\b|\bin your (basket|cart|bag)( now)?\b|^\s*(added|removed|updated|swapped|changed)\b/i;
    /*
     * "I've added it" with no gateway success this turn - refused, or never
     * even attempted (V1 task 3). The gateway's word is the only word on
     * whether the basket changed: sent back once, and if it still claims,
     * what the customer hears is what the gateway (or the waiting action)
     * said.
     */
    // Handed to the widget is not made: "added" is a claim until the cart's report says so (tools/cartOperations.ts).
    const dispatchedNow = outcomes.find((outcome) => outcome.ok && outcome.dispatched);
    /*
     * A basket change went to the widget this turn and the reply says nothing
     * of it: "remove all of these and show me polos" came back as polos only,
     * and the customer had to look at the drawer to know the pack was going
     * (harness replay, 29 Sep). The update opens the reply.
     */
    if (dispatchedNow && calls.length === 0 && !/\b(basket|cart|bag)\b/i.test(finalText)) finalText = `${UPDATING} ${finalText}`.trim();
    // "I’m updating your basket" with a curly apostrophe once slipped past this check: read with plain quotes.
    const plainText = finalText.replace(/[‘’]/g, "'");
    const nowSession = await sessions.getOrCreate(sessionId);
    /*
     * "Your basket has the white Elite Polo in L" is a statement of what is
     * there, not a claim that something was just done: it stands when the
     * basket the widget reported holds that product and no doing-word is
     * used (the sizes and quantities in it are held to the basket by the
     * checker). "Nothing has changed in your basket" once replaced exactly
     * such an answer to "what is in my basket?" (journey acceptance).
     */
    const statesContents =
      /\bin your (basket|cart|bag)( now)?\b/i.test(plainText) &&
      (nowSession.basket ?? []).some((line) => plainText.toLowerCase().includes(garmentName(line.title).toLowerCase())) &&
      !/\b(added|adding|put|placed|placing|going in|gone in|goes in|removed|removing|updated|updating|changed|changing|swapped|swapping)\b/i.test(plainText);
    // A pack card built this turn: "I've swapped the polo" is about the pack on screen, not the basket.
    const packChangedNow = (attachment?.kind === 'pack' || attachment?.kind === 'outfit') && !outcomes.length;
    if (calls.length === 0 && !outcomes.some((outcome) => outcome.ok && !outcome.dispatched) && !goalCarriedOut && claimsDone.test(plainText) && !statesContents && !packChangedNow) {
      const waiting = nowSession.pendingAction;
      // "Nothing has changed": an earlier turn may well have added something.
      const truth = dispatchedNow ? UPDATING : (refused[refused.length - 1]?.speech ?? waiting?.question ?? 'Nothing has changed in your basket.');
      if (!rewrote) {
        rewrote = true;
        log.warn('reply.claimed_refused_action', { sessionId, reasons: refused.map((outcome) => outcome.reason), attempted: refused.length > 0 });
        messages.push({ role: 'assistant', content: finalText });
        messages.push({
          role: 'system',
          content: refused.length
            ? `Nothing changed in the basket - the ${refused.map((outcome) => outcome.action).join(' and ')} was not made (${refused.map((outcome) => outcome.reason ?? 'refused').join(', ')}). Never say it was added, changed or removed. Say what the tool said and ask only what it asked: "${truth}"`
            : `Nothing changed in the basket this turn - no basket tool succeeded. Never say it was added, changed or removed. ${waiting ? `Ask only: "${truth}"` : 'Say nothing has been added yet.'}`,
        });
        continue;
      }
      log.warn('reply.claimed_refused_action_after_rewrite', { sessionId });
      finalText = truth;
    }
    /*
     * A basket change refused for want of a target, and the model asking a
     * question of its own over the tool's. "Which item do you mean?" bound
     * nothing either way, but "shall I remove the entire pack?" invited a
     * yes that no record could honour - and the loop began (live, pack
     * removal). The tool's question is the one the next turn can answer.
     */
    const untargeted = refused.filter((outcome) => (outcome.action === 'update-line' || outcome.action === 'add-product') && (outcome.reason === 'no-target' || outcome.reason === 'ambiguous-target'));
    if (calls.length === 0 && untargeted.length && !outcomes.some((outcome) => outcome.ok) && /\?/.test(finalText) && !livePending(nowSession)) {
      const own = untargeted[untargeted.length - 1]!.speech;
      if (own && finalText !== own) {
        log.warn('reply.basket_question_unbound', { sessionId, over: finalText.slice(0, 120) });
        finalText = own;
      }
    }
    if (calls.length === 0 && finalText) {
      const violations = verifyReply(finalText, evidence.join('\n'), attachment, userText, await verifyContext(sessionId));
      if (violations.length && !rewrote) {
        rewrote = true;
        log.warn('reply.unverified', { sessionId, claims: violations.map((v) => `${v.kind}:${v.claim}`) });
        messages.push({ role: 'assistant', content: finalText });
        const unbacked = violations.filter((v) => v.kind !== 'wording' && v.kind !== 'offer' && v.kind !== 'length' && v.kind !== 'status' && v.kind !== 'pricing');
        const worded = violations.filter((v) => v.kind === 'wording');
        const offered = violations.filter((v) => v.kind === 'offer');
        messages.push({
          role: 'system',
          content: [
            unbacked.length
              ? `Your reply stated things no tool gave you this turn: ${unbacked
                  .map((v) => v.claim)
                  .join(', ')}. Rewrite it using only prices, product names, colours, counts, features and fit from this turn's tool results and what is on screen - a piece's colour is the one in its title; a product's features, fit and shape (sleeveless, hooded, zip, neck, sleeve length) are only those its own name or facts state, for that product. What the customer wants is not a product fact. Leave out anything you cannot back.`
              : 'Rewrite your reply.',
            worded.length
              ? `Say it as a salesperson would - not "${worded.map((v) => v.claim).join('", "')}". Give the verified reason instead: "it's lightweight and breathable, which is what you asked for".`
              : '',
            offered.length
              ? 'The products are already on screen: do not offer to show them. Ask which one they meant, their size, or whether to add it to the basket.'
              : '',
            violations.some((v) => v.kind === 'length')
              ? `Say it in at most two short sentences and one question, under about 35 words - yours was ${violations.find((v) => v.kind === 'length')!.claim}. Merge or drop a sentence, keeping the question. The cards already show the pieces, colours, sizes and prices - do not list them, and do not repeat back what they told you.`
              : '',
            violations.some((v) => v.kind === 'pricing')
              ? 'Give the price they will pay - the "Pack price: pays" figure - and nothing else about it. The listed price is not what they pay, and there is no saving, discount or deal to mention.'
              : '',
            violations.some((v) => v.kind === 'status')
              ? 'The pack is not ready - never say it is ready or complete. Ask only the one thing its Pack status line says to ask.'
              : '',
            violations.some((v) => v.kind === 'basket')
              ? `What is in the basket is only what the "In their basket now" line and the Basket facts say: ${basketWords(await sessions.getOrCreate(sessionId))}. State sizes and quantities from that alone; a change still being confirmed is "being updated", not in the basket. Never repeat a size or quantity from an earlier turn.`
              : '',
            violations.some((v) => v.kind === 'comparison')
              ? 'Call something the cheapest, or cheaper, only when the facts give a "Price ordering" or "Price comparison" line saying so - otherwise give its price and nothing more.'
              : '',
            'Do not mention this check.',
          ]
            .filter(Boolean)
            .join(' '),
        });
        continue;
      }
      if (violations.length) {
        log.warn('reply.unverified_after_rewrite', { sessionId, claims: violations.map((v) => `${v.kind}:${v.claim}`) });
        finalText = withoutClaims(finalText, violations) || lastToolSpeech || 'Let me check that properly - could you ask me again?';
      }
    }

    if (calls.length === 0) {
      log.info('journey.goal', { sessionId, at: 'end', ...goalLog(customerGoal(await sessions.getOrCreate(sessionId), userText)) });
      log.info('openai.turn', {
        sessionId,
        model: env.openai.model,
        steps: step + 1,
        promptTokens,
        cachedTokens,
        completionTokens,
      });

      record({
        at: Date.now(),
        sessionId,
        kind: 'chat',
        model: env.openai.model,
        promptTokens,
        cachedTokens,
        completionTokens,
        audioSeconds: 0,
        costUsd: costOfTokens(env.openai.model, promptTokens, cachedTokens, completionTokens),
        ms: Date.now() - turnStartedAt,
        steps: step + 1,
        ...(meta?.client ? { client: meta.client } : {}),
      });
      // Each search recorded only its own results; the screen shows them together.
      if (merged && attachment?.kind === 'products') {
        const current = await sessions.getOrCreate(sessionId);
        await sessions.patch(sessionId, {
          lastShown: {
            ...(current.lastShown ?? { kind: 'products' as const }),
            kind: 'products',
            items: attachment.products.map((product) => ({ id: product.id, title: product.title })),
          },
        });
      }
      if (toolEvidence.length) await keepEvidence();
      if (lead && finalText && !lead.unless.test(finalText)) {
        log.warn('reply.lead_restored', { sessionId });
        finalText = `${lead.text} ${finalText.replace(/^(yes|yeah|sure|of course)\b[,!.]?\s*/i, '')}`;
      }
      /*
       * Words the code put in (a tool's own speech, a rewrite) may offer too;
       * then the words are held to the record: a confirmation that binds
       * nothing is not asked, and a record whose question was lost gets it
       * back (V1 task 3).
       */
      await notePackSwapOffer(sessionId, finalText);
      await notePendingOffer(sessionId, finalText);
      finalText = await alignReplyWithPending(sessionId, finalText);
      return {
        text: finalText || 'Sorry, I did not catch that.',
        attachment,
        ...(actions.length ? { actions } : {}),
      };
    }

    messages.push({ role: 'assistant', content: choice.message.content, tool_calls: calls });

    /*
     * Searches run together; anything that writes to the basket runs alone.
     *
     * Each tool is a round trip to Shopify, so three searches in sequence is
     * three times the wait for no reason - an outfit asking for a top, a
     * bottom and a layer was paying that every time.
     *
     * Cart writes are not like that, and treating them as independent cost a
     * customer their order. Asked to add four garments, the model issues four
     * add_to_cart calls in one batch. Run together, all four read
     * `session.cartId` before any of them has finished, all four find it
     * empty, and all four create a *separate* basket. Four carts exist, the
     * session keeps whichever wrote last, and the customer - told "all four
     * items have been added, totalling £100" - sees one item at £58.
     *
     * So they go one at a time, and each re-reads the session first, which is
     * how the second add finds the basket the first one opened.
     */
    if (calls.some((call) => call.function.name === 'add_to_cart' || call.function.name === 'add_pack_to_cart')) addTried = true;
    const execute = async (call: (typeof calls)[number]) => {
      let args: unknown = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {
        args = {};
      }

      try {
        // Read fresh: a cart write earlier in this same batch may have opened
        // the basket this call needs to add to.
        const current = await sessions.getOrCreate(sessionId);
        const result = await runTool(call.function.name, args, { session: current, utterance: userText, pendingActions: actions.length });
        log.info('openai.tool', { tool: call.function.name, sessionId });
        return { call, result };
      } catch (err) {
        // Log the arguments and the upstream detail: "create_cart failed" on
        // its own tells you nothing about which variant the model invented.
        log.error('openai.tool.failed', {
          tool: call.function.name,
          args,
          err: String(err),
          detail: err instanceof UpstreamError ? err.detail : undefined,
        });
        return { call, failed: true as const };
      }
    };

    type Outcome = Awaited<ReturnType<typeof execute>>;
    const results: Outcome[] = new Array(calls.length);

    // Everything that only reads, together.
    await Promise.all(
      calls.map(async (call, index) => {
        if (writesToCart(call.function.name)) return;
        results[index] = await execute(call);
      }),
    );

    // Then the basket, in the order the model asked for it.
    for (const [index, call] of calls.entries()) {
      if (!writesToCart(call.function.name)) continue;
      results[index] = await execute(call);
    }

    // Appended in call order, so the transcript stays deterministic.
    for (const entry of results) {
      if ('failed' in entry) {
        messages.push({
          role: 'tool',
          tool_call_id: entry.call.id,
          content:
            'That lookup failed. Tell the customer you hit a problem and offer to try again. Do not invent an answer.',
        });
        continue;
      }

      /*
       * One card per turn, handed back rather than published here.
       *
       * Every tool's card used to go to the screen as it ran. "Add all of
       * these" is a product lookup and an add_to_cart per item, so the
       * customer watched each product appear on its own and a basket after
       * every add - five items, ten cards - before the one answer they asked
       * for. The route publishes the turn's card once the model has finished.
       *
       * Which card wins is by what it is, not by which came last - see
       * cardWeight. A later card of the same weight replaces an earlier one.
       */
      const { result } = entry;
      if (result.actions) actions.push(...result.actions);
      if (result.outcome) outcomes.push({ ...result.outcome, speech: result.speech });
      if (result.attachment) {
        const weight = cardWeight(result.attachment, writesToCart(entry.call.function.name));
        /*
         * Two searches in one turn are one answer. Asked for "polos and
         * jackets", the model searched for each; the jackets card replaced
         * the polos card, and the customer was told about six polos they
         * could not see. The products are merged, taking turns, instead.
         */
        if (attachment?.kind === 'products' && result.attachment.kind === 'products') {
          attachment = { kind: 'products', products: interleave(attachment.products, result.attachment.products) };
          merged = true;
        } else if (weight >= attachmentWeight) {
          attachment = result.attachment;
          attachmentWeight = weight;
        }
      }

      const content = result.facts ? `${result.speech}\n\nFACTS (data, do not read aloud):\n${result.facts}` : result.speech;
      evidence.push(content);
      toolEvidence.push(content);
      if (result.speech) lastToolSpeech = result.speech;
      if (result.lead) lead = result.lead;
      messages.push({ role: 'tool', tool_call_id: entry.call.id, content });
    }
  }

  // Ran out of steps: say so rather than leaving the customer hanging.
  return {
    // The last tool's own words are exact; a generic apology is only for when there are none.
    text: lastToolSpeech || 'I am having trouble pulling that together right now. Could you try asking a different way?',
    attachment,
    ...(actions.length ? { actions } : {}),
  };
}
