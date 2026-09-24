import { randomUUID } from 'node:crypto';
import express, { Router } from 'express';
import type { CaddieMessage } from '@caddie/shared';
import { screen } from '../ai/guard.js';
import { converse, openaiEnabled } from '../ai/openai.js';
import { MAX_AUDIO_BYTES, transcribe, transcribeEnabled } from '../ai/transcribe.js';
import { log } from '../lib/logger.js';
import { consumeShared, LIMITS } from '../lib/rateLimit.js';
import { clientKey } from '../lib/request.js';
import { publish } from '../session/bus.js';
import { sessions, stateOf } from '../session/store.js';
import { stateSchema } from '../session/stateSchema.js';
import { clientHash } from '../usage/identity.js';
import { recordMessage } from '../usage/store.js';

/**
 * Voice in, chat out.
 *
 * POST /api/voice with the raw recording as the body and the recording's
 * mime type as Content-Type. The transcript then goes through the same chat
 * loop as typed text, so voice and text behave identically and there is only
 * one path to debug.
 *
 *   const blob = await recorder.stop();
 *   await fetch(`${API}/api/voice?sessionId=${id}`, {
 *     method: 'POST',
 *     headers: { 'Content-Type': blob.type },
 *     body: blob,
 *   });
 *
 * Raw body rather than multipart so there is no upload dependency to install.
 * Returns the transcript alongside the reply, so the UI can show what it heard
 * - when the Caddie answers oddly, the first question is always whether it
 * misheard.
 */

export const voiceRouter: Router = Router();

/**
 * Reads conversation state out of the x-caddie-state header.
 *
 * **Base64, not raw JSON.** The state carries what was said, and what the
 * Caddie says is full of pound signs. A browser throws on a header value
 * outside Latin-1, so raw JSON here would work in testing and then fail the
 * first time a price was mentioned - which is every real conversation.
 *
 * Capped before it is decoded, because a header is the cheapest thing in the
 * world for a caller to make enormous. Anything that fails simply starts the
 * customer fresh: a spoken question deserves an answer more than it deserves
 * a 400 about a header they have never heard of.
 */
const MAX_STATE_HEADER = 96_000;

async function restoreFromHeader(sessionId: string, raw: string | undefined) {
  if (!raw || raw.length > MAX_STATE_HEADER) return sessions.getOrCreate(sessionId);

  try {
    // Plain JSON is accepted too, so a curl by hand is not a puzzle.
    const text = raw.trimStart().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const parsed = stateSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return sessions.getOrCreate(sessionId);
    return await sessions.restore(sessionId, parsed.data);
  } catch {
    return sessions.getOrCreate(sessionId);
  }
}

voiceRouter.post(
  '/',
  express.raw({ type: ['audio/*', 'video/webm', 'application/octet-stream'], limit: MAX_AUDIO_BYTES }),
  async (req, res, next) => {
    if (!transcribeEnabled() || !openaiEnabled()) {
      return res.status(501).json({
        error: 'voice_unavailable',
        detail: 'Set OPENAI_API_KEY to enable voice.',
      });
    }

    const sessionId = (req.query.sessionId as string) || req.get('x-caddie-session') || randomUUID();
    const mimeType = req.get('content-type') ?? 'audio/webm';

    // Transcription is billed per minute on top of the conversation, so voice
    // gets a tighter budget than text.
    const [bySession, byAddress] = await Promise.all([
      consumeShared(`voice:${sessionId}`, LIMITS.voicePerSession),
      consumeShared(`ip:${clientKey(req)}`, LIMITS.perAddress),
    ]);
    const limited = !bySession.ok ? bySession : !byAddress.ok ? byAddress : null;
    if (limited) {
      log.warn('voice.rate_limited', { sessionId });
      return res.status(429).json({
        error: 'rate_limited',
        detail: 'Let me catch up - try again in a minute.',
        retryAfter: limited.retryAfter,
      });
    }

    const client = clientHash(clientKey(req));

    try {
      const transcript = await transcribe(req.body as Buffer, mimeType, { sessionId, client });

      // Nothing intelligible. Say so rather than sending silence to the model.
      if (!transcript) {
        return res.json({
          sessionId,
          transcript: '',
          message: assistantMessage('I did not catch that - could you say it again?'),
        });
      }

      /*
       * The body is the recording, so the state travels in a header.
       *
       * Unparseable or oversized state is ignored rather than refused: a
       * customer who has just spoken should get an answer, and the worst case
       * is a Caddie that has forgotten them - not one that rejects them.
       */
      const session = await restoreFromHeader(sessionId, req.get('x-caddie-state'));

      const verdict = await screen(transcript, {
        hasHistory: session.messages.length > 0,
        lastAssistant: [...session.messages].reverse().find((m) => m.role === 'assistant' && m.text)?.text,
        sessionId,
        client,
      });
      if (!verdict.allow) {
        log.info('voice.declined', { sessionId, reason: verdict.reason });
        return res.json({
          sessionId,
          transcript,
          message: assistantMessage(verdict.reply),
          state: stateOf(session),
        });
      }

      const reply = await converse(sessionId, transcript, { client });
      recordMessage(sessionId, 'user', transcript);
      recordMessage(sessionId, 'assistant', reply.text);

      const heard: CaddieMessage = {
        id: randomUUID(),
        role: 'user',
        text: transcript,
        createdAt: new Date().toISOString(),
      };
      const answer = assistantMessage(reply.text, reply.attachment);

      // Appended, not saved: see the note in chat.ts.
      await sessions.append(sessionId, [heard, answer]);

      if (answer.attachment) {
        publish({ type: 'attachment', sessionId, attachment: answer.attachment });
      }

      const finished = await sessions.getOrCreate(sessionId);
      return res.json({ sessionId, transcript, message: answer, state: stateOf(finished) });
    } catch (err) {
      return next(err);
    }
  },
);

function assistantMessage(text: string, attachment?: CaddieMessage['attachment']): CaddieMessage {
  return {
    id: randomUUID(),
    role: 'assistant',
    text,
    createdAt: new Date().toISOString(),
    ...(attachment ? { attachment } : {}),
  };
}
