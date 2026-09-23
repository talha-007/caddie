import { env } from '../env.js';
import { CaddieError, UpstreamError } from '../lib/errors.js';
import { fetchWithTimeout } from '../lib/http.js';
import { log } from '../lib/logger.js';
import { costOfAudio } from '../usage/pricing.js';
import { record } from '../usage/store.js';

/**
 * Speech to text.
 *
 * This is the stopgap until Vapi handles voice end to end: the widget records
 * the customer, we transcribe here, and the transcript goes through exactly
 * the same chat loop as typed text. That means voice can be tested on real
 * devices before Vapi is wired up, and it keeps working as a fallback after.
 *
 * Deliberately server side rather than the browser's SpeechRecognition API:
 * support for that is patchy across iOS Safari and Android, and Day 12 tests
 * on both.
 */

/** What MediaRecorder produces, mapped to a filename OpenAI will accept. */
const EXTENSIONS: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/mpga': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
};

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export function extensionFor(mimeType: string): string {
  const base = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  return EXTENSIONS[base] ?? 'webm';
}

export function transcribeEnabled(): boolean {
  return Boolean(env.openai.apiKey);
}

/**
 * Roughly how long a clip is, from how big it is.
 *
 * Transcription is billed by the audio minute, but the gpt-4o transcribe
 * models return only `json` or `text` - `verbose_json`, the one that carries a
 * real duration, is whisper-1 only. So this is derived from the file size at a
 * nominal speech bitrate, and the dashboard labels voice spend an estimate
 * rather than pretending to a precision we do not have.
 *
 * MediaRecorder's default webm/opus for speech sits around 32 kbps.
 */
const NOMINAL_BYTES_PER_SECOND = 4000;

/** Who the clip belongs to, for the usage dashboard. */
export interface TranscribeMeta {
  sessionId?: string;
  client?: string;
}

export async function transcribe(audio: Buffer, mimeType: string, meta?: TranscribeMeta): Promise<string> {
  if (!env.openai.apiKey) {
    throw new UpstreamError('Transcription needs OPENAI_API_KEY.');
  }
  // These are the caller's fault, not an upstream failure - a mis-tapped mic
  // sends an empty body, and it should not look like Shopify fell over.
  if (audio.byteLength === 0) {
    throw new CaddieError('No audio received.', 400, 'empty_audio');
  }
  if (audio.byteLength > MAX_AUDIO_BYTES) {
    throw new CaddieError('That recording is too long - keep it under 25MB.', 413, 'audio_too_large');
  }

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }), `speech.${extensionFor(mimeType)}`);
  form.append('model', env.openai.transcribeModel);
  // The customer is talking about golf kit, so bias the model towards it.
  form.append(
    'prompt',
    'The speaker is shopping for Druids golf clothing: polos, midlayers, gilets, hoodies, shorts, trousers. Sizes are S, M, L, XL, 2XL, or waist sizes like 32 and 34.',
  );

  const startedAt = Date.now();
  const res = await fetchWithTimeout('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    // Uploading a recording, so more room than a text call.
    timeoutMs: 45_000,
    label: 'transcription',
    headers: { Authorization: `Bearer ${env.openai.apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new UpstreamError(`Transcription failed (${res.status})`, detail.slice(0, 400));
  }

  const body = (await res.json()) as { text?: string };
  const text = body.text?.trim() ?? '';
  log.info('voice.transcribed', { ms: Date.now() - startedAt, bytes: audio.byteLength, chars: text.length });

  const seconds = audio.byteLength / NOMINAL_BYTES_PER_SECOND;
  record({
    at: Date.now(),
    sessionId: meta?.sessionId ?? 'unknown',
    kind: 'transcribe',
    model: env.openai.transcribeModel,
    promptTokens: 0,
    cachedTokens: 0,
    completionTokens: 0,
    audioSeconds: seconds,
    costUsd: costOfAudio(env.openai.transcribeModel, seconds),
    ms: Date.now() - startedAt,
    ...(meta?.client ? { client: meta.client } : {}),
  });

  return text;
}
