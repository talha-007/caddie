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
import { sessions } from '../session/store.js';

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

    try {
      const transcript = await transcribe(req.body as Buffer, mimeType);

      // Nothing intelligible. Say so rather than sending silence to the model.
      if (!transcript) {
        return res.json({
          sessionId,
          transcript: '',
          message: assistantMessage('I did not catch that - could you say it again?'),
        });
      }

      const session = await sessions.getOrCreate(sessionId);

      const verdict = await screen(transcript, {
        hasHistory: session.messages.length > 0,
        lastAssistant: [...session.messages].reverse().find((m) => m.role === 'assistant' && m.text)?.text,
      });
      if (!verdict.allow) {
        log.info('voice.declined', { sessionId, reason: verdict.reason });
        return res.json({ sessionId, transcript, message: assistantMessage(verdict.reply) });
      }

      const reply = await converse(sessionId, transcript);

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

      return res.json({ sessionId, transcript, message: answer });
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
