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

/**
 * Text chat for the widget.
 *
 * Two modes:
 *  - Vapi mode (default once VAPI_PRIVATE_KEY and VAPI_ASSISTANT_ID are set):
 *    the message goes to the Vapi Chat API, which calls our tools through the
 *    webhook. This is what ships.
 *  - Dev mode (no Vapi keys): a keyword router picks a tool directly, so the
 *    widget can be built and tested against REAL Shopify data without Vapi.
 *    The language understanding is dumb; the product data is real.
 */

export const chatRouter: Router = Router();

const bodySchema = z.object({
  sessionId: z.string().min(1).optional(),
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
  const session = await sessions.getOrCreate(sessionId);
  const userMessage = message('user', parsed.data.text);

  try {
    const reply = vapiEnabled()
      ? await viaVapi(sessionId, parsed.data.text)
      : await viaDevRouter(sessionId, parsed.data.text);

    session.messages.push(userMessage, reply);
    await sessions.save(session);

    if (reply.attachment) {
      publish({ type: 'attachment', sessionId, attachment: reply.attachment });
    }

    return res.json({ sessionId, message: reply });
  } catch (err) {
    return next(err);
  }
});

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
