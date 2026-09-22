import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { CaddieMessage } from '@caddie/shared';
import { env } from '../env.js';
import { log } from '../lib/logger.js';
import { publish } from '../session/bus.js';
import { sessions } from '../session/store.js';
import { runTool } from '../tools/index.js';
import { route } from '../ai/devRouter.js';
import { screen } from '../ai/guard.js';
import { converse, openaiEnabled } from '../ai/openai.js';
import { consumeShared, LIMITS } from '../lib/rateLimit.js';
import { clientKey } from '../lib/request.js';

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

const bodySchema = z.object({
  sessionId: z.string().min(1).max(100).optional(),
  text: z.string().min(1).max(2000),
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

const vapiEnabled = () => Boolean(env.vapi.privateKey && env.vapi.assistantId);

chatRouter.post('/', async (req, res, next) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'bad_request', detail: parsed.error.message });
  }

  const sessionId = parsed.data.sessionId ?? randomUUID();

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

  const session = await sessions.getOrCreate(sessionId);
  const userMessage = message('user', parsed.data.text);

  try {
    /*
     * Screen before the expensive loop. The full call carries ~2,400 tokens of
     * prompt and tool schemas before it reads a word, so an essay request that
     * gets this far has already cost us.
     */
    const verdict = await screen(parsed.data.text, session.messages.length > 0);
    if (!verdict.allow) {
      log.info('chat.declined', { sessionId, reason: verdict.reason });
      const reply = message('assistant', verdict.reply);
      // Not remembered: a declined message should not shape what follows.
      return res.json({ sessionId, message: reply });
    }

    const reply = openaiEnabled()
      ? await viaOpenai(sessionId, parsed.data.text)
      : vapiEnabled()
        ? await viaVapi(sessionId, parsed.data.text)
        : await viaDevRouter(sessionId, parsed.data.text);

    // Appended rather than saved: the tools have been writing to this session
    // throughout the turn, and saving the copy read at the start would undo it.
    await sessions.append(sessionId, [userMessage, reply]);

    if (reply.attachment) {
      publish({ type: 'attachment', sessionId, attachment: reply.attachment });
    }

    return res.json({ sessionId, message: reply });
  } catch (err) {
    return next(err);
  }
});

/* ---------------- OpenAI ---------------- */

async function viaOpenai(sessionId: string, text: string): Promise<CaddieMessage> {
  const reply = await converse(sessionId, text);
  return message('assistant', reply.text, reply.attachment);
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

  const result = await runTool(intent.tool, intent.args, { session });
  return message('assistant', result.speech, result.attachment);
}
