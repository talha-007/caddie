import { tmpdir } from 'node:os';
import { env } from '../env.js';
import { CaddieError, UpstreamError } from '../lib/errors.js';
import { fetchWithTimeout } from '../lib/http.js';
import { log } from '../lib/logger.js';
import { costOfAudio } from '../usage/pricing.js';
import { record } from '../usage/store.js';
import { languageToRetry, type LanguageHints } from './language.js';

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

/**
 * Below this, there is nothing in the clip worth sending.
 *
 * A tap that opens and closes the recorder still produces a container with a
 * header and a few frames of silence, which is not zero bytes and so passed
 * the only check there was. Silence is exactly the input that makes a
 * transcription model invent - see the echo guard below.
 *
 * Roughly a third of a second at the nominal speech bitrate.
 */
const MIN_AUDIO_BYTES = 1_200;

/**
 * Words per second that no one actually speaks.
 *
 * Ordinary speech is two to three words a second and a fast talker reaches
 * four. A transcript claiming a dozen words from one second of audio did not
 * come from the audio - it came from our own prompt, which the model repeats
 * back when it has nothing to transcribe.
 *
 * This is the check rather than matching the text against the prompt, because
 * "I need a medium polo" is a sentence a real customer says. What is not
 * possible is saying it in a fifth of a second.
 */
const MAX_WORDS_PER_SECOND = 6;

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

/** Who the clip belongs to, and what we know of the language they speak. */
export interface TranscribeMeta {
  sessionId?: string;
  client?: string;
  /** Storefront and browser languages, and what they have already said. See ai/language.ts. */
  hints?: LanguageHints;
}

/**
 * Whether a transcript claims more speech than the clip could hold.
 *
 * Nobody says twelve words in one second, whatever they are saying, so this
 * never refuses a real customer - it only catches the case where the model
 * had silence and a word list and produced a sentence from the word list.
 */
export function impossibleSpeechRate(text: string, seconds: number): boolean {
  if (seconds <= 0) return false;
  const words = text.split(/\s+/).filter(Boolean).length;
  // One or two words can legitimately sit in a very short clip.
  if (words <= 2) return false;
  return words / seconds > MAX_WORDS_PER_SECOND;
}

export async function transcribe(audio: Buffer, mimeType: string, meta?: TranscribeMeta): Promise<string> {
  if (!env.openai.apiKey) {
    throw new UpstreamError('Transcription needs OPENAI_API_KEY.');
  }
  // These are the caller's fault, not an upstream failure - a mis-tapped mic
  // sends an empty body, and it should not look like Shopify fell over.
  if (audio.byteLength < MIN_AUDIO_BYTES) {
    throw new CaddieError('No audio received.', 400, 'empty_audio');
  }
  if (audio.byteLength > MAX_AUDIO_BYTES) {
    throw new CaddieError('That recording is too long - keep it under 25MB.', 413, 'audio_too_large');
  }

  /*
   * Detected first, then checked. A single-market deployment can still force
   * one language with OPENAI_TRANSCRIBE_LANGUAGE; otherwise the model hears
   * the customer's own language, and a result in a script nothing about the
   * customer points to is heard again in the one they are expected to speak.
   */
  const forced = env.openai.transcribeLanguage || undefined;
  let text = await hear(audio, mimeType, meta, forced);

  const retry = forced || !meta?.hints ? null : languageToRetry(text, meta.hints);
  if (retry) {
    const again = await hear(audio, mimeType, meta, retry);
    log.warn('voice.language_retry', {
      sessionId: meta?.sessionId,
      expected: retry,
      detected: text.slice(0, 120),
      retried: again.slice(0, 120),
    });
    // Named-language transcription of genuinely foreign speech can come back
    // empty; then the detected text is still the better of the two.
    if (/[\p{L}\p{N}]/u.test(again)) text = again;
  }

  const seconds = audio.byteLength / NOMINAL_BYTES_PER_SECOND;

  /*
   * Last line of defence against a transcript nobody spoke.
   *
   * The clip is short, the model had a word list and nothing else to go on,
   * and it returned a fluent sentence. Counting words against the length of
   * the audio catches that without ever refusing a real customer: nobody says
   * twelve words in one second, whatever they are saying.
   *
   * Dropped rather than raised, because the honest outcome is the same one a
   * genuinely silent clip gets - "I did not catch that" - and the customer
   * simply speaks again.
   */
  /*
   * Nothing but punctuation is not speech.
   *
   * With no prompt to echo, a silent clip usually comes back empty - but
   * sometimes as "." or "...", which is truthy and would be sent to the model
   * as though the customer had said something.
   */
  if (text && !/[\p{L}\p{N}]/u.test(text)) {
    log.warn('voice.transcript_rejected', { reason: 'no words in it', text: text.slice(0, 40) });
    return '';
  }

  if (impossibleSpeechRate(text, seconds)) {
    log.warn('voice.transcript_rejected', {
      reason: 'impossible speech rate',
      words: text.split(/\s+/).filter(Boolean).length,
      seconds: Number(seconds.toFixed(2)),
      text: text.slice(0, 120),
    });
    return '';
  }

  return text;
}

/**
 * One transcription call, in the given language or in whatever the model
 * detects. Each call is billed, so each one is recorded.
 */
async function hear(audio: Buffer, mimeType: string, meta: TranscribeMeta | undefined, language?: string): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }), `speech.${extensionFor(mimeType)}`);
  form.append('model', env.openai.transcribeModel);
  // A language code, not a prompt: it names what to write in and gives the
  // model no words to repeat back.
  if (language) form.append('language', language);
  /*
   * No prompt at all.
   *
   * A transcription prompt is a spelling hint, and it is also a script: given
   * a clip with no speech in it the model hands the prompt back as though it
   * had been spoken. This started as a sentence listing garments and sizes,
   * and a customer who said nothing appeared to ask for "a medium polo, a
   * large midlayer, and an extra-large gilet". Cut to a word list, it still
   * echoed. Cut to the single word "Druids", it echoed that.
   *
   * There is no version of this that is both useful and safe, because the
   * useful part - words the model would not otherwise reach for - is exactly
   * the part it invents from. So it sends nothing, and a misspelled brand
   * name is a price worth paying for never inventing an order.
   *
   * Do not add one back.
   */

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
  /*
   * The text and the format, not just the counts.
   *
   * Nine seconds of speech came back as eight characters, and the counts
   * alone could not say whether the microphone, the container format or the
   * model was at fault. What was actually said, and what we actually sent,
   * separates those in one line.
   */
  log.info('voice.transcribed', {
    ms: Date.now() - startedAt,
    bytes: audio.byteLength,
    mimeType,
    language: language ?? 'detected',
    chars: text.length,
    text: text.slice(0, 200),
  });

  /*
   * A clip that produced almost nothing is worth keeping, in development.
   *
   * Whether the recording is silent, truncated, or perfectly audible speech
   * the model declined to transcribe is not a question logs can answer - it
   * needs the file. Never in production: that is a customer's voice on disk.
   */
  if (!env.isProd && audio.byteLength > 8_000 && text.length < 20) {
    try {
      const { writeFile } = await import('node:fs/promises');
      const path = `${tmpdir()}/caddie-voice-${Date.now()}.${extensionFor(mimeType)}`;
      await writeFile(path, audio);
      log.warn('voice.suspicious_clip', { path, bytes: audio.byteLength, chars: text.length });
    } catch {
      // Diagnostics are never worth failing a customer's request for.
    }
  }

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
