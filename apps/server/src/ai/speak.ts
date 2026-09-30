import { env } from '../env.js';
import { UpstreamError } from '../lib/errors.js';
import { fetchWithTimeout } from '../lib/http.js';
import { log } from '../lib/logger.js';
import { costOfAudio } from '../usage/pricing.js';
import { record } from '../usage/store.js';

/**
 * The Caddie's reply to a voice turn, spoken. Text to speech on the words the
 * Caddie already said - nothing is generated here, so what is heard is
 * exactly what is on screen, and the reply checker (ai/verify.ts) has already
 * been over it.
 *
 * Off unless OPENAI_VOICE_MODEL is set. The model, voice and instructions are
 * all configuration: nothing here assumes a particular model.
 */

/** Long enough for any Caddie reply - it speaks in one or two sentences - and a cap on what one request can cost. */
export const MAX_SPOKEN_CHARS = 1000;

/** Speech runs at roughly this many characters a second: an estimate of the audio's length for the usage dashboard, which prices speech per minute. */
const CHARS_PER_SECOND = 15;

export function speechEnabled(): boolean {
  return Boolean(env.openai.apiKey && env.openai.voiceModel);
}

/**
 * What is said aloud: the reply as a sentence would be read, without the
 * marks that are only for the eye - emphasis, bullets, links.
 */
export function spokenText(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_`#>]+/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SPOKEN_CHARS);
}

export async function speak(text: string, meta: { sessionId: string; client?: string }): Promise<Buffer> {
  const input = spokenText(text);
  if (!speechEnabled() || !input) throw new UpstreamError('Spoken replies are off', '');
  const startedAt = Date.now();
  const res = await fetchWithTimeout('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    timeoutMs: 30_000,
    label: 'speech',
    headers: { Authorization: `Bearer ${env.openai.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: env.openai.voiceModel,
      voice: env.openai.voiceName,
      input,
      response_format: 'mp3',
      ...(env.openai.voiceInstructions ? { instructions: env.openai.voiceInstructions } : {}),
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new UpstreamError(`Speech failed (${res.status})`, detail.slice(0, 400));
  }
  const audio = Buffer.from(await res.arrayBuffer());
  const seconds = input.length / CHARS_PER_SECOND;
  log.info('voice.spoken', { sessionId: meta.sessionId, model: env.openai.voiceModel, chars: input.length, bytes: audio.byteLength, ms: Date.now() - startedAt });
  // Priced per minute where the model has a rate in usage/pricing.ts; a model without one reads as zero, and the dashboard names it.
  record({
    at: Date.now(),
    sessionId: meta.sessionId,
    kind: 'speak',
    model: env.openai.voiceModel,
    promptTokens: 0,
    cachedTokens: 0,
    completionTokens: 0,
    audioSeconds: seconds,
    costUsd: costOfAudio(env.openai.voiceModel, seconds),
    ms: Date.now() - startedAt,
    ...(meta.client ? { client: meta.client } : {}),
  });
  return audio;
}
