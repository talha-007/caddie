/**
 * What OpenAI charges, in USD.
 *
 * A table we keep by hand, because a response does not come back with a price
 * on it. It drifts whenever OpenAI reprices, so everything built on it is
 * labelled an estimate on screen - the authority on what we actually owe is
 * the invoice, and this is for spotting what is expensive and why.
 *
 * Cached input is a quarter of fresh input on the 4.1 family. That is the
 * whole reason the system prompt is long rather than short, and the reason
 * trimming it made us 40% more expensive - see the cost note in CLAUDE.md.
 */

export interface ModelPrice {
  /** Per million fresh input tokens. */
  input: number;
  /** Per million input tokens served from the prompt cache. */
  cachedInput: number;
  /** Per million output tokens. */
  output: number;
}

const PER_MILLION: Record<string, ModelPrice> = {
  'gpt-4.1': { input: 2.0, cachedInput: 0.5, output: 8.0 },
  'gpt-4.1-mini': { input: 0.4, cachedInput: 0.1, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, cachedInput: 0.025, output: 0.4 },
  'gpt-4o': { input: 2.5, cachedInput: 1.25, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, cachedInput: 0.075, output: 0.6 },
  'gpt-5': { input: 1.25, cachedInput: 0.125, output: 10.0 },
  'gpt-5-mini': { input: 0.25, cachedInput: 0.025, output: 2.0 },
};

/** Transcription is billed by the audio minute, not by the token. */
const PER_MINUTE: Record<string, number> = {
  'gpt-4o-mini-transcribe': 0.003,
  'gpt-4o-transcribe': 0.006,
  'whisper-1': 0.006,
};

/**
 * Prices are published against the bare model name, but the API is usually
 * given a dated one - gpt-4.1-mini-2025-04-14 bills as gpt-4.1-mini. Longest
 * matching prefix, so gpt-4.1-mini never falls through to gpt-4.1.
 */
function lookup<T>(table: Record<string, T>, model: string): T | null {
  if (table[model]) return table[model] as T;

  let best: string | null = null;
  for (const name of Object.keys(table)) {
    if (model.startsWith(name) && (!best || name.length > best.length)) best = name;
  }
  return best ? (table[best] as T) : null;
}

export function priceOf(model: string): ModelPrice | null {
  return lookup(PER_MILLION, model);
}

/** Whether we can put a number against this model at all. */
export function isPriced(model: string): boolean {
  return Boolean(lookup(PER_MILLION, model) ?? lookup(PER_MINUTE, model));
}

/**
 * Cost of one completion.
 *
 * `promptTokens` from OpenAI *includes* the cached ones, so the fresh count is
 * the difference. Billing them both at the full input rate - the obvious
 * reading - overstates a cached turn by about four times, which on an 85%
 * cache hit rate is most of them.
 */
export function costOfTokens(
  model: string,
  promptTokens: number,
  cachedTokens: number,
  completionTokens: number,
): number {
  const price = lookup(PER_MILLION, model);
  if (!price) return 0;

  const cached = Math.min(Math.max(cachedTokens, 0), Math.max(promptTokens, 0));
  const fresh = Math.max(promptTokens - cached, 0);

  return (
    (fresh * price.input + cached * price.cachedInput + Math.max(completionTokens, 0) * price.output) /
    1_000_000
  );
}

/** Cost of transcribing a clip. */
export function costOfAudio(model: string, seconds: number): number {
  const perMinute = lookup(PER_MINUTE, model);
  if (!perMinute) return 0;
  return (Math.max(seconds, 0) / 60) * perMinute;
}

/** Shown on the dashboard so nobody has to read this file to check a rate. */
export function priceTable(): Array<{ model: string; input: number; cachedInput: number; output: number }> {
  return Object.entries(PER_MILLION).map(([model, price]) => ({ model, ...price }));
}

export function audioPriceTable(): Array<{ model: string; perMinute: number }> {
  return Object.entries(PER_MINUTE).map(([model, perMinute]) => ({ model, perMinute }));
}
