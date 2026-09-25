import type { CaddieAttachment, CartAction } from '@caddie/shared';
import { env } from '../env.js';
import { UpstreamError } from '../lib/errors.js';
import { fetchWithTimeout, Semaphore } from '../lib/http.js';
import { log } from '../lib/logger.js';
import { sessions, type CaddieSession } from '../session/store.js';
import { runTool, toolDefinitionsForVapi } from '../tools/index.js';
import { costOfTokens } from '../usage/pricing.js';
import { record } from '../usage/store.js';
import { SYSTEM_PROMPT } from './prompt.js';

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

const MAX_STEPS = 4;
/*
 * Every turn kept here is resent on every call in the loop, so this is the
 * cheapest dial in the file. Eight covers "cheaper" and "the navy one"
 * comfortably; the session holds the durable facts - size, budget, colour,
 * what is on screen - so history is not carrying them.
 */
const HISTORY_TURNS = 8;

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
    let res = await callOnce(messages);

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
    return {
      role: 'system',
      content: `The customer is on the product page for [${page.productId}]${title}. "This", "it" and "this one" mean that product.`,
    };
  }

  return { role: 'system', content: `The customer is on the ${page.pageType} page.` };
}

function screenContext(session: CaddieSession): ChatMessage | null {
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
 * What is in their basket, with the ids that change it.
 *
 * Separate from what is on screen: the basket outlives every search. It used
 * to be one line - "they already have a basket open" - and asked to swap the
 * orange polo in it, the model could not see an orange polo anywhere and added
 * the new one beside it. A handful of short lines; cheap next to a wrong order.
 */
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
        .join('\n'),
  };
}

function history(session: CaddieSession): ChatMessage[] {
  return session.messages.slice(-HISTORY_TURNS).map((message) => ({
    role: message.role,
    content: message.text,
  }));
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
  const session = await sessions.getOrCreate(sessionId);
  const turnStartedAt = Date.now();

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...([pageContext(session), screenContext(session), basketContext(session)].filter(Boolean) as ChatMessage[]),
    ...history(session),
    { role: 'user', content: userText },
  ];

  let attachment: CaddieAttachment | undefined;
  const actions: CartAction[] = [];
  let attachmentWeight = -1;
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
    if (calls.length === 0) {
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
      return {
        text: choice.message.content?.trim() || 'Sorry, I did not catch that.',
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

      messages.push({
        role: 'tool',
        tool_call_id: entry.call.id,
        content: result.facts ? `${result.speech}\n\nFACTS (data, do not read aloud):\n${result.facts}` : result.speech,
      });
    }
  }

  // Ran out of steps: say so rather than leaving the customer hanging.
  return {
    text: 'I am having trouble pulling that together right now. Could you try asking a different way?',
    attachment,
    ...(actions.length ? { actions } : {}),
  };
}
