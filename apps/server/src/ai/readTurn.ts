import { isColourWord } from '../catalog/colour.js';
import { env } from '../env.js';
import { fetchWithTimeout } from '../lib/http.js';
import { log } from '../lib/logger.js';
import { normaliseSize } from '../recommend/sizeWords.js';
import { costOfTokens } from '../usage/pricing.js';
import { record } from '../usage/store.js';

/**
 * One customer message, read by a model into data the code can act on.
 *
 * The regex readers in tools/answers.ts read English, and only the English
 * they were written for: "that is also medium" was no size, "sí, en talla
 * M" was nothing at all, and a customer writing in Urdu was told we do not
 * stock the Ambassador Pack (admin log, 25-28 Sep). This is the second
 * reader: the cheapest model, asked once per message for the yes, the no,
 * the size, the waist and leg, the colours and the quantity, in any
 * language. It never decides alone - readReply takes its answer only for a
 * field the regexes left empty, and every value is checked against what
 * the code already knows to be a size or a colour. If it is slow or down,
 * the regexes carry on as before.
 */
export interface TurnReading {
  affirms: boolean;
  declines: boolean;
  /** They ask, in this message, to put something in the basket now / take something out. */
  asksToAdd: boolean;
  asksToRemove: boolean;
  size?: string;
  waist?: string;
  leg?: string;
  colours: string[];
  quantity?: number;
  language?: string;
  /** What they asked for by price: the cheapest, the dearest, or both ends. */
  priceIntent?: 'cheapest' | 'dearest' | 'both';
  /**
   * What they are asking to see or buy, as the model read it: the kinds of
   * garment, for whom, a spending limit, the features and the weather. The
   * search takes the conversation model's proposals when this agrees with
   * them - so a customer can ask in any words, and the model still cannot
   * search for a filter nobody asked for.
   */
  asks: { kinds: string[]; range?: 'men' | 'women' | 'kids'; budgetMax?: number; features: string[]; weather: string[]; productNames: string[] };
}

const KINDS = ['polo', 'midlayer', 'hoodie', 'jacket', 'gilet', 'trousers', 'shorts', 'skort', 'dress', 'baselayer', 'cap', 'visor', 'beanie', 'hat', 'belt', 'socks', 'shoes'];
const FEATURES = ['waterproof', 'water-resistant', 'windproof', 'breathable', 'moisture-wicking', 'quick-dry', 'stretch', 'lightweight', 'warm', 'uv-protection', 'hooded', 'quarter-zip', 'full-zip'];
const WEATHERS = ['wet', 'cold', 'hot', 'windy'];

const READER_PROMPT = `You read one message from a shopper in a golf clothing chat and return JSON only.
Fields:
- affirms: true only if the message agrees to, accepts or confirms what the assistant just asked (yes, go ahead, please do, that one, remove it, add it). False if they ask something else, change the request, or only give information.
- declines: true if they refuse, cancel, or say no to what was asked.
- asksToAdd: true if this message asks to put something in the basket now (add it, buy it, I'll take it, put it in my bag). False for a question about a product or a yes alone.
- asksToRemove: true if this message asks to take something out of the basket.
- size: a top size they state (XS, S, M, L, XL, 2XL, 3XL, 4XL, or a UK/number size like 10 or 12), else null. "Medium" is M, "extra large" is XL.
- waist: their waist in inches if stated, else null. leg: their leg length in inches if stated, else null.
- colours: English colour words they ask for (navy, black, white, red, blue, grey, green...), else [].
- quantity: how many items they want if they say a number, else null.
- language: the BCP-47 tag of the language the message is written in (en, es, ur, bn, de, fr...).
- priceIntent: "cheapest" if they ask for the cheapest, cheap ones, or nothing too expensive; "dearest" if they ask for the expensive, dearest, priciest or top-of-the-range ones; "both" if they ask for both ends; else null.
- asks: what they are asking to see or buy in THIS message, however they phrase it:
  - kinds: the kinds of garment, from exactly this list: polo, midlayer, hoodie, jacket, gilet, trousers, shorts, skort, dress, baselayer, cap, visor, beanie, hat, belt, socks, shoes. "Rain top" is jacket; "jumper" is midlayer; "pants" is trousers; "a hat for the sun" is cap. [] if they name none.
  - range: "men", "women" or "kids" only if they say who it is for ("for my wife", "ladies", "for my son"); else null.
  - budgetMax: a spending limit they state, as a number (under £50 is 50; "about £100 for the lot" is 100); else null.
  - features: from exactly this list, only what they ask for or their weather plainly needs: waterproof, water-resistant, windproof, breathable, moisture-wicking, quick-dry, stretch, lightweight, warm, uv-protection, hooded, quarter-zip, full-zip. "Something for the rain" is waterproof; "keeps me warm" is warm. [] if none.
  - weather: the conditions they mention, from: wet, cold, hot, windy. [] if none.
  - productNames: product or design names they mention, ALWAYS written in English Latin letters (a-z) as a shop would - never in the original script. Transliterate names spoken in another script or misheard: "باؤنسڑ پولو" is "Bouncer Polo", "ہیکسا جیکٹ" is "Hexa Jacket", "Haggar jacket" is probably "Hexa Jacket", "worker jacket" is probably "Warrior Jacket". [] if none.
The message may be in any language; read its meaning. Never guess a value that is not in the message.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    affirms: { type: 'boolean' },
    declines: { type: 'boolean' },
    asksToAdd: { type: 'boolean' },
    asksToRemove: { type: 'boolean' },
    size: { type: ['string', 'null'] },
    waist: { type: ['string', 'null'] },
    leg: { type: ['string', 'null'] },
    colours: { type: 'array', items: { type: 'string' } },
    quantity: { type: ['integer', 'null'] },
    language: { type: ['string', 'null'] },
    priceIntent: { type: ['string', 'null'], enum: ['cheapest', 'dearest', 'both', null] },
    asks: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kinds: { type: 'array', items: { type: 'string' } },
        range: { type: ['string', 'null'], enum: ['men', 'women', 'kids', null] },
        budgetMax: { type: ['number', 'null'] },
        features: { type: 'array', items: { type: 'string' } },
        weather: { type: 'array', items: { type: 'string' } },
        productNames: { type: 'array', items: { type: 'string', pattern: "^[A-Za-z0-9 '&.-]+$" } },
      },
      required: ['kinds', 'range', 'budgetMax', 'features', 'weather', 'productNames'],
    },
  },
  required: ['affirms', 'declines', 'asksToAdd', 'asksToRemove', 'size', 'waist', 'leg', 'colours', 'quantity', 'language', 'priceIntent', 'asks'],
};

const MAX_CACHE = 500;
const cache = new Map<string, TurnReading>();
const key = (said: string) => said.trim().toLowerCase().replace(/\s+/g, ' ');

/** The model's reading of exactly these words, if it has been asked this turn. */
export function modelReadingFor(said: string): TurnReading | undefined {
  return cache.get(key(said));
}

export function setModelReadingForTests(said: string, reading: TurnReading | undefined): void {
  if (reading) cache.set(key(said), reading);
  else cache.delete(key(said));
}

/** The words nearly every English sentence has one of. A message of three or more words with none of them is not English. */
const ENGLISH_WORDS = /\b(the|a|an|i|i'm|im|me|my|you|your|it|it's|its|is|are|do|does|can|could|would|will|show|want|need|have|has|got|get|in|for|with|and|or|please|yes|no|not|what|which|size|add|remove|one|this|that|these|those|to|of|like|some|any|more|less|cheaper|under|over|on|at|be|go|ok|okay|thanks|thank)\b/i;

/** Words the English pattern readers cannot be trusted on: letters outside ASCII, or no English in them at all. "Necesito un polo Elite en blanco" has no accent and no English. */
export function notEnglish(said: string): boolean {
  if (/[^\x00-\x7F£€‘’“”…–—]/.test(said)) return true;
  const words = said.trim().split(/\s+/).filter(Boolean);
  return words.length >= 3 && !ENGLISH_WORDS.test(said);
}

/** Whether these words are worth a model read: an answer to a question, or not English. */
export function needsModelReading(said: string, answering: boolean): boolean {
  const words = said.trim();
  if (!words) return false;
  if (notEnglish(words)) return true;
  // Any message of a few words may be a request in words the patterns do not know: read it.
  return answering || words.split(/\s+/).length >= 2;
}

function keep(reading: TurnReading): void {
  if (cache.size >= MAX_CACHE) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
}

/** What they asked for, kept only where the words are the catalogue's own: kinds, features and weather from the fixed lists, a range, a positive budget. */
function readAsks(raw: unknown): TurnReading['asks'] {
  const asks = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const list = (value: unknown, allowed: string[]) => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.toLowerCase().trim()).filter((entry) => allowed.includes(entry)) : []);
  const range = asks.range === 'men' || asks.range === 'women' || asks.range === 'kids' ? asks.range : undefined;
  const budgetMax = typeof asks.budgetMax === 'number' && Number.isFinite(asks.budgetMax) && asks.budgetMax > 0 ? asks.budgetMax : undefined;
  const productNames = Array.isArray(asks.productNames) ? asks.productNames.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter((entry) => entry.length > 1 && entry.length <= 40).slice(0, 4) : [];
  return { kinds: [...new Set(list(asks.kinds, KINDS))], ...(range ? { range } : {}), ...(budgetMax !== undefined ? { budgetMax } : {}), features: [...new Set(list(asks.features, FEATURES))], weather: [...new Set(list(asks.weather, WEATHERS))], productNames };
}

/** Only what the code can vouch for: a real size word, real colour words, a sane quantity. */
function sanitise(raw: Record<string, unknown>): TurnReading {
  const size = typeof raw.size === 'string' ? normaliseSize(raw.size) : null;
  const inches = (value: unknown) => (typeof value === 'string' && /^\d{2}$/.test(value.trim()) ? value.trim() : typeof value === 'number' && value >= 24 && value <= 60 ? String(value) : undefined);
  const colours = Array.isArray(raw.colours) ? raw.colours.filter((word): word is string => typeof word === 'string').map((word) => word.toLowerCase().trim()).filter((word) => isColourWord(word)) : [];
  const quantity = typeof raw.quantity === 'number' && Number.isInteger(raw.quantity) && raw.quantity >= 1 && raw.quantity <= 10 ? raw.quantity : undefined;
  return {
    affirms: raw.affirms === true && raw.declines !== true,
    declines: raw.declines === true,
    asksToAdd: raw.asksToAdd === true && raw.declines !== true,
    asksToRemove: raw.asksToRemove === true && raw.declines !== true,
    ...(size ? { size: size.toUpperCase() } : {}),
    ...(inches(raw.waist) ? { waist: inches(raw.waist) } : {}),
    ...(inches(raw.leg) ? { leg: inches(raw.leg) } : {}),
    colours,
    ...(quantity !== undefined ? { quantity } : {}),
    ...(typeof raw.language === 'string' && raw.language ? { language: raw.language.slice(0, 8) } : {}),
    ...(raw.priceIntent === 'cheapest' || raw.priceIntent === 'dearest' || raw.priceIntent === 'both' ? { priceIntent: raw.priceIntent } : {}),
    asks: readAsks(raw.asks),
  };
}

/**
 * Ask the model, once, and keep the answer for this turn's readers. Null when
 * the model is unavailable: nothing waits on it.
 */
export async function readTurnWithModel(said: string, context: { sessionId: string; question?: string; client?: string }): Promise<TurnReading | null> {
  const cached = cache.get(key(said));
  if (cached) return cached;
  if (!env.openai.apiKey) return null;
  const startedAt = Date.now();
  try {
    const res = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      timeoutMs: 6000,
      label: 'read-turn',
      headers: { Authorization: `Bearer ${env.openai.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: env.openai.guardModel,
        messages: [
          { role: 'system', content: READER_PROMPT },
          ...(context.question ? [{ role: 'user' as const, content: `The assistant just asked: "${context.question.slice(0, 240)}"` }] : []),
          { role: 'user', content: `The shopper's message: "${said.slice(0, 600)}"` },
        ],
        response_format: { type: 'json_schema', json_schema: { name: 'turn_reading', strict: true, schema: SCHEMA } },
        max_tokens: 120,
        temperature: 0,
      }),
    });
    if (!res.ok) {
      log.warn('read_turn.unavailable', { sessionId: context.sessionId, status: res.status });
      return null;
    }
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const content = body.choices?.[0]?.message?.content ?? '';
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content) as Record<string, unknown>;
    } catch {
      log.warn('read_turn.unparseable', { sessionId: context.sessionId, content: content.slice(0, 120) });
      return null;
    }
    const reading = sanitise(parsed);
    const promptTokens = body.usage?.prompt_tokens ?? 0;
    const completionTokens = body.usage?.completion_tokens ?? 0;
    record({
      at: Date.now(),
      sessionId: context.sessionId,
      kind: 'read',
      model: env.openai.guardModel,
      promptTokens,
      cachedTokens: 0,
      completionTokens,
      audioSeconds: 0,
      costUsd: costOfTokens(env.openai.guardModel, promptTokens, 0, completionTokens),
      ms: Date.now() - startedAt,
      ...(context.client ? { client: context.client } : {}),
    });
    keep(reading);
    cache.set(key(said), reading);
    log.info('read_turn', { sessionId: context.sessionId, ms: Date.now() - startedAt, affirms: reading.affirms, declines: reading.declines, asksToAdd: reading.asksToAdd, asksToRemove: reading.asksToRemove, asks: reading.asks, size: reading.size ?? null, waist: reading.waist ?? null, leg: reading.leg ?? null, colours: reading.colours, quantity: reading.quantity ?? null, language: reading.language ?? null });
    return reading;
  } catch (err) {
    log.warn('read_turn.failed', { sessionId: context.sessionId, err: String(err) });
    return null;
  }
}
