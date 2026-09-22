import { env } from '../env.js';
import { CaddieError, UpstreamError } from '../lib/errors.js';
import { log } from '../lib/logger.js';

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

export async function transcribe(audio: Buffer, mimeType: string): Promise<string> {
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
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
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
  return text;
}
