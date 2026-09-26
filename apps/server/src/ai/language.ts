/**
 * Which writing system a customer is expected to speak in, and whether a
 * transcript is in it.
 *
 * Voice is transcribed with the language left to the model, because Druids
 * sells into more than one market and a customer should be heard in their own
 * language. But detection runs on the audio, and the audio carries an accent:
 * an English sentence spoken with a South Asian accent came back as Urdu, in
 * Urdu script, with "inches" turned into "centimetres". Nothing downstream can
 * recover from that - the model answered a question the customer never asked.
 *
 * So the detected result is checked against what we already know about the
 * customer: the language the storefront page is in, the languages their
 * browser asks for, and what they have already typed or said. A transcript in
 * a script none of those point to is treated as a misdetection and heard again
 * with the expected language named.
 *
 * Scripts rather than languages, on purpose. The transcription models return
 * text, not a language code, and telling Spanish from Portuguese from text is
 * guesswork; telling Arabic script from Latin is not. The failure we are
 * guarding against is always a jump between scripts.
 */

import { phoneticEnglish } from './phoneticEnglish.js';

export type Script =
  | 'latin'
  | 'arabic'
  | 'devanagari'
  | 'bengali'
  | 'gurmukhi'
  | 'cyrillic'
  | 'greek'
  | 'hebrew'
  | 'thai'
  | 'han'
  | 'kana'
  | 'hangul';

const SCRIPT_PATTERNS: Array<[Script, RegExp]> = [
  ['latin', /\p{Script=Latin}/u],
  ['arabic', /\p{Script=Arabic}/u],
  ['devanagari', /\p{Script=Devanagari}/u],
  ['bengali', /\p{Script=Bengali}/u],
  ['gurmukhi', /\p{Script=Gurmukhi}/u],
  ['cyrillic', /\p{Script=Cyrillic}/u],
  ['greek', /\p{Script=Greek}/u],
  ['hebrew', /\p{Script=Hebrew}/u],
  ['thai', /\p{Script=Thai}/u],
  ['han', /\p{Script=Han}/u],
  ['kana', /[\p{Script=Hiragana}\p{Script=Katakana}]/u],
  ['hangul', /\p{Script=Hangul}/u],
];

/** ISO-639-1 codes whose script is not Latin. Everything unlisted is Latin. */
const LANGUAGE_SCRIPTS: Record<string, Script[]> = {
  ar: ['arabic'],
  fa: ['arabic'],
  ur: ['arabic'],
  ps: ['arabic'],
  hi: ['devanagari'],
  mr: ['devanagari'],
  ne: ['devanagari'],
  bn: ['bengali'],
  pa: ['gurmukhi'],
  ru: ['cyrillic'],
  uk: ['cyrillic'],
  bg: ['cyrillic'],
  sr: ['cyrillic', 'latin'],
  el: ['greek'],
  he: ['hebrew'],
  th: ['thai'],
  zh: ['han'],
  ja: ['han', 'kana'],
  ko: ['hangul'],
};

/** "en-GB" -> "en". Anything that is not a plausible language tag is dropped. */
export function baseLanguage(tag: string): string | null {
  const base = tag.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return /^[a-z]{2,3}$/.test(base) ? base : null;
}

export function scriptsForLanguage(tag: string): Script[] {
  const base = baseLanguage(tag);
  if (!base) return [];
  return LANGUAGE_SCRIPTS[base] ?? ['latin'];
}

/**
 * The script most of the letters are in, or null for text with no letters
 * ("36", "..."). Counted by letter, so a Latin product name dropped into an
 * Urdu sentence does not make the sentence Latin.
 */
export function dominantScript(text: string): Script | null {
  const counts = new Map<Script, number>();
  for (const char of text) {
    if (!/\p{L}/u.test(char)) continue;
    const match = SCRIPT_PATTERNS.find(([, pattern]) => pattern.test(char));
    if (match) counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
  }
  let best: Script | null = null;
  let most = 0;
  for (const [script, count] of counts) {
    if (count > most) {
      best = script;
      most = count;
    }
  }
  return best;
}

export interface LanguageHints {
  /** What the storefront and browser say, most preferred first: "en-GB", "ur". */
  languages: string[];
  /** Things the customer has already typed or said in this conversation. */
  earlier: string[];
}

/** Every script this customer could plausibly be speaking in. */
export function expectedScripts(hints: LanguageHints): Set<Script> {
  const scripts = new Set<Script>();
  for (const tag of hints.languages) for (const script of scriptsForLanguage(tag)) scripts.add(script);
  for (const text of hints.earlier) {
    // English that was once heard as Urdu letters is English: it must not make Urdu "expected" from then on.
    const script = dominantScript(text) === 'arabic' && phoneticEnglish(text) ? 'latin' : dominantScript(text);
    if (script) scripts.add(script);
  }
  return scripts;
}

/**
 * The language to hear the clip in again, or null when the first transcript
 * stands.
 *
 * It stands when we know nothing about the customer (no hints: nothing to
 * disagree with), when it has no letters, or when its script is one we
 * expected. Otherwise the answer is the customer's first language whose
 * script we can name - which is what the page and browser put first.
 */
export function languageToRetry(transcript: string, hints: LanguageHints): string | null {
  const heard = dominantScript(transcript);
  if (!heard) return null;
  /*
   * Latin is never second-guessed. The store and its catalogue are English,
   * so a shopper on an Urdu page who speaks English is ordinary - and forcing
   * Urdu onto their correct English transcript would break exactly what
   * worked. Even the wrong way round, romanised Urdu ("mera size kya hai") is
   * still text the model can read. The damage only ever runs from Latin
   * speech into another script.
   */
  if (heard === 'latin') return null;
  const expected = expectedScripts(hints);
  if (expected.size === 0 || expected.has(heard)) return null;
  for (const tag of hints.languages) {
    const base = baseLanguage(tag);
    if (base) return base;
  }
  return null;
}

/** Parses "en-GB,en;q=0.9,ur" or "en-GB,ur" into tags, most preferred first. */
export function parseLanguageList(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return [];
  return raw
    .split(',')
    .map((part) => part.split(';')[0]?.trim() ?? '')
    .filter((tag) => baseLanguage(tag) !== null)
    .slice(0, 8);
}
