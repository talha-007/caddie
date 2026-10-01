import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { CaddieMessage } from '@caddie/shared';
import { CART_OPS_CONTRACT } from '@caddie/shared';
import { env } from '../env.js';
import { log } from '../lib/logger.js';
import { publish } from '../session/bus.js';
import { sessions } from '../session/store.js';
import { SESSION_TOKEN_HEADER, openSessionsAllowed, ownsSession } from '../session/ownership.js';
import { shopperSizes } from '../shopper/remember.js';
import { runTool } from '../tools/index.js';
import { route } from '../ai/devRouter.js';
import { screen } from '../ai/guard.js';
import { converse, openaiEnabled, type TurnMeta } from '../ai/openai.js';
import { basketPatch } from '../tools/cartOperations.js';
import { consumeShared, LIMITS } from '../lib/rateLimit.js';
import { clientKey, noteCartMode } from '../lib/request.js';
import { clientHash } from '../usage/identity.js';
import { recordMessage } from '../usage/store.js';

/**
 * Text chat for the widget.
 *
 * Three modes, in order of preference:
 *  1. OpenAI (OPENAI_API_KEY set) - a real tool-calling loop in our own
 *     process. This is the text path that ships: lower latency than proxying
 *     through Vapi, and it shares the prompt and tool registry with voice.
 *  2. Vapi chat (VAPI_PRIVATE_KEY + VAPI_ASSISTANT_ID) - the same assistant
 *     that handles voice, answering text.
 *  3. Dev keyword router - no AI at all, so the UI can be built against real
 *     Shopify data with no keys whatsoever.
 *
 * Voice always goes through Vapi, which calls the same tools over the webhook.
 * One prompt, one tool registry, so the two cannot drift apart.
 */

export const chatRouter: Router = Router();

/*
 * Validated rather than trusted. It comes from data attributes on a page we do
 * not control, so every field is bounded - an unbounded productTitle would go
 * straight into a prompt we pay for by the token.
 */
const contextSchema = z.object({
  pageType: z.enum(['product', 'collection', 'cart', 'other']),
  productId: z.string().max(200).optional(),
  productHandle: z.string().max(200).optional(),
  productTitle: z.string().max(200).optional(),
  variantId: z.string().max(200).optional(),
});

const basketLineSchema = z.object({
  key: z.string().min(1).max(200),
  productId: z.string().min(1).max(100),
  variantId: z.string().min(1).max(100),
  title: z.string().max(200).optional(),
  variantTitle: z.string().max(200).optional(),
  quantity: z.number().int().min(0).max(999),
  bundle: z.string().max(100).optional(),
  bundleName: z.string().max(100).optional(),
  properties: z.record(z.string().max(200)).optional(),
  sellingPlanId: z.string().max(100).optional(),
  discounts: z.array(z.object({ title: z.string().max(200), amount: z.number().int().min(0) })).max(20).optional(),
  originalLinePrice: z.number().int().min(0).optional(),
});
const basketSchema = z.object({ cartToken: z.string().max(120).optional(), currency: z.string().max(8).optional(), lines: z.array(basketLineSchema).max(100) });

const bodySchema = z.object({
  sessionId: z.string().min(1).max(100).optional(),
  text: z.string().min(1).max(2000),
  context: contextSchema.optional(),
  basket: basketSchema.optional(),
});

function message(role: CaddieMessage['role'], text: string, attachment?: CaddieMessage['attachment']): CaddieMessage {
  return {
    id: randomUUID(),
    role,
    text,
    createdAt: new Date().toISOString(),
    ...(attachment ? { attachment } : {}),
  };
}

/** The last thing the Caddie said, so the screen can read a reply as a reply. */
function lastAssistantMessage(session: { messages: CaddieMessage[] }): string | undefined {
  for (let i = session.messages.length - 1; i >= 0; i -= 1) {
    const message = session.messages[i];
    if (message?.role === 'assistant' && message.text) return message.text;
  }
  return undefined;
}

const vapiEnabled = () => Boolean(env.vapi.privateKey && env.vapi.assistantId);

chatRouter.post('/', async (req, res, next) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'bad_request', detail: parsed.error.message });
  }

  /*
   * Only the browser that owns the session may talk in it (session/ownership.ts):
   * the conversation, the profile and the basket are that shopper's. Checked
   * before the rate limit, so someone else's id cannot spend their allowance.
   */
  const sessionId = parsed.data.sessionId ?? (openSessionsAllowed() ? randomUUID() : undefined);
  if (!sessionId) return res.status(400).json({ error: 'session_required' });
  if (!openSessionsAllowed() && !ownsSession(await sessions.get(sessionId), req.get(SESSION_TOKEN_HEADER) ?? undefined)) {
    log.warn('session.not_owned', { path: '/api/chat', session: sessionId.slice(0, 8) });
    return res.status(401).json({ error: 'session_not_owned' });
  }

  // Public, unauthenticated, and every call spends money.
  const [bySession, byAddress] = await Promise.all([
    consumeShared(`chat:${sessionId}`, LIMITS.perSession),
    consumeShared(`ip:${clientKey(req)}`, LIMITS.perAddress),
  ]);
  const limited = !bySession.ok ? bySession : !byAddress.ok ? byAddress : null;
  if (limited) {
    log.warn('chat.rate_limited', { sessionId });
    return res.status(429).json({
      error: 'rate_limited',
      detail: 'That is a lot of questions at once. Give me a minute and try again.',
      retryAfter: limited.retryAfter,
    });
  }

  const session = await noteCartMode(req, await sessions.getOrCreate(sessionId), (id, change) => sessions.patch(id, change));

  // Written before the model runs, and kept on the session so a spoken
  // follow-up - which carries no context of its own - still knows the page.
  if (parsed.data.context) {
    await sessions.patch(sessionId, { page: parsed.data.context });
  }
  // The basket the message was typed over, on the storefront: the same reading the basket route takes, so the turn's words are never about a basket the server has not seen.
  if (parsed.data.basket && session.cartMode === 'theme') {
    const lines = parsed.data.basket.lines.map((line) => ({ ...line, title: line.title ?? '', variantTitle: line.variantTitle ?? '' }));
    await sessions.patch(sessionId, { ...basketPatch(lines, parsed.data.basket.currency), ...(parsed.data.basket.cartToken ? { cartToken: parsed.data.basket.cartToken } : {}) });
    log.info('chat.basket_applied', { sessionId, lines: lines.length });
  } else if (session.cartMode === 'theme' && session.widgetContract === CART_OPS_CONTRACT) {
    // A current widget reads the cart before every message; none here means that read failed or timed out. The copy the server had is kept, never emptied.
    log.warn('chat.basket_missing', { sessionId, kept: (session.basket ?? []).length });
  }

  const userMessage = message('user', parsed.data.text);

  try {
    /*
     * Screen before the expensive loop. The full call carries ~2,400 tokens of
     * prompt and tool schemas before it reads a word, so an essay request that
     * gets this far has already cost us.
     */
    const client = clientHash(clientKey(req));

    const verdict = await screen(parsed.data.text, {
      hasHistory: session.messages.length > 0,
      lastAssistant: lastAssistantMessage(session),
      sessionId,
      client,
    });
    if (!verdict.allow) {
      log.info('chat.declined', { sessionId, reason: verdict.reason });
      const reply = message('assistant', verdict.reply);
      // Not remembered: a declined message should not shape what follows.
      return res.json({ sessionId, message: reply });
    }

    const reply = openaiEnabled()
      ? await viaOpenai(sessionId, parsed.data.text, { client })
      : vapiEnabled()
        ? await viaVapi(sessionId, parsed.data.text)
        : await viaDevRouter(sessionId, parsed.data.text);

    // Appended rather than saved: the tools have been writing to this session
    // throughout the turn, and saving the copy read at the start would undo it.
    await sessions.append(sessionId, [userMessage, reply]);
    recordMessage(sessionId, 'user', parsed.data.text);
    recordMessage(sessionId, 'assistant', reply.text);

    if (reply.attachment) {
      publish({ type: 'attachment', sessionId, attachment: reply.attachment });
    }

    return res.json({ sessionId, message: reply });
  } catch (err) {
    return next(err);
  }
});

/* ---------------- OpenAI ---------------- */

async function viaOpenai(sessionId: string, text: string, meta?: TurnMeta): Promise<CaddieMessage> {
  const reply = await converse(sessionId, text, meta);
  // Their sizes as they stand after this turn, so the pickers open on them.
  const shopper = shopperSizes(await sessions.getOrCreate(sessionId));
  return {
    ...message('assistant', reply.text, reply.attachment),
    ...(reply.actions ? { actions: reply.actions } : {}),
    ...(shopper ? { shopper } : {}),
  };
}

/* ---------------- Vapi Chat API ---------------- */

async function viaVapi(sessionId: string, text: string): Promise<CaddieMessage> {
  const res = await fetch('https://api.vapi.ai/chat', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.vapi.privateKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      assistantId: env.vapi.assistantId,
      // Keeps voice and text on one thread, and tells the tool webhook who is asking.
      assistantOverrides: { metadata: { sessionId } },
      sessionId,
      input: text,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    log.error('vapi.chat.failed', { status: res.status, detail });
    throw new Error(`Vapi chat failed with ${res.status}`);
  }

  const body = (await res.json()) as { output?: Array<{ content?: string }> };
  const text_ = body.output?.map((part) => part.content ?? '').join(' ').trim();
  return message('assistant', text_ || 'Sorry, I did not catch that.');
}

/* ---------------- Dev router ---------------- */

async function viaDevRouter(sessionId: string, text: string): Promise<CaddieMessage> {
  const session = await sessions.getOrCreate(sessionId);
  const intent = route(text, session);

  if (!intent) {
    return message(
      'assistant',
      'Dev mode: try "find my size, I am 180cm and 80kg", "build me a pack under 150", or "an outfit for a match day".',
    );
  }

  // The dev router's arguments come from its own parser of the customer's text, not a model.
  const result = await runTool(intent.tool, intent.args, { session, utterance: text, direct: true });
  return message('assistant', result.speech, result.attachment);
}
