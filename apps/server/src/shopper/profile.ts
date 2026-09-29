import { formatMoney } from '../catalog/commerce.js';
import { parseRange, type Range } from '../catalog/audience.js';
import { featuresAsked, type Feature, type Weather } from '../catalog/attributes.js';
import { needsSaid } from '../catalog/suitability.js';
import { parseColours } from '../catalog/colour.js';
import { normaliseSize } from '../recommend/sizeWords.js';

/**
 * What the customer has told us they want, for the length of the session.
 *
 * The Caddie used to hold a colour and a budget and nothing else, and hold
 * them all the same way. "I'm usually XL, I like a relaxed fit, mostly navy or
 * black, no more than £50 on a polo" was forgotten by the next request, and
 * "I'd prefer navy" filtered out every other colour as firmly as "only navy".
 *
 * Two things decide how much a statement binds:
 *
 *  - required: "only navy", "it has to be waterproof", "nothing over £60".
 *    Never silently broken.
 *  - preferred: "I'd prefer navy", "ideally under £60", "maybe blue". Used to
 *    rank; something else can still be shown, with the difference said.
 *
 * Read by code from the customer's own words every turn (readIntent), and by
 * the model through note_shopper for what needs interpreting ("Portugal in
 * July" is hot weather). A later statement replaces an earlier one.
 *
 * Three kinds of thing, never promoted one into another (Phase 3A):
 *
 *   durable facts      what the customer normally is or prefers - "I'm
 *                      usually L", "I usually wear navy". `session.shopper`,
 *                      with where each came from (`provenance`). Only the
 *                      customer's own words, the size form or a customer
 *                      action can put a fact here; see shopper/facts.ts.
 *   current intent     what they want right now - "red polos under £30",
 *                      "I need a waterproof jacket". The shopping focus and
 *                      its constraints (session/focus.ts), gone with New chat.
 *   recommendations    what the Caddie worked out - a size from their chest.
 *                      `session.sizeRecommendation`: advice, never their size.
 *
 * "Show me red polos under £30" once remembered red and £30 as the customer's
 * own; a size find_my_size worked out became "usually wears M". Neither was
 * anything they had said about themselves.
 */

export type Strength = 'required' | 'preferred';

/**
 * Where a fact came from. Only the first four are the customer's evidence:
 * a recommendation is ours, and a model hint is a guess.
 */
export type FactSource = 'customer-words' | 'ui-form' | 'ui-selection' | 'customer-confirmation' | 'derived-recommendation' | 'model-hint';
export type FactScope = 'turn' | 'shopping-session' | 'profile';
export interface FactRecord {
  source: FactSource;
  at: number;
}

export interface Budget {
  amount: number;
  /** max: a ceiling. around: near it either way. ideal: under it if possible. */
  kind: 'max' | 'around' | 'ideal';
  /** One garment, or the whole lot. */
  per: 'item' | 'total';
}

export interface ShopperProfile {
  range?: Range;
  usualSize?: string;
  /** Trousers and shorts: the waist size, "34". Tops and bottoms are separate scales. */
  waist?: string;
  fit?: 'tight' | 'regular' | 'relaxed';
  /** Wants room to wear something underneath. */
  layering?: boolean;
  colours?: { words: string[]; strength: Strength };
  avoidColours?: string[];
  features?: { required: Feature[]; preferred: Feature[] };
  budget?: Budget;
  occasion?: string;
  weather?: Weather[];
  /** Product ids they liked or chose. */
  liked?: string[];
  /** Product ids they turned down or swapped out. Never offered again this session. */
  rejected?: string[];
  /** "Just the jacket": the garment they drew a line under. No cross-selling while set. */
  justThis?: string;
  /** Where each durable fact came from. A fact with no trusted record here is not read as one. */
  provenance?: Partial<Record<string, FactRecord>>;
}

/** What can be a durable fact about the customer. Liked, rejected and "just this" belong to one shopping session. */
export const DURABLE_FIELDS = ['range', 'usualSize', 'waist', 'fit', 'colours', 'avoidColours', 'features', 'budget', 'weather'] as const;
export type DurableField = (typeof DURABLE_FIELDS)[number];

/* ---------------- Reading it from their words ---------------- */

const MONEY = String.raw`(?:£|\$|€|gbp\s?|eur\s?|usd\s?)?\s?(\d{1,4}(?:\.\d{1,2})?)\s?(?:pounds?|quid|euros?|dollars?|gbp|eur|usd)?`;
/** A number that is a measurement, not money: "under 34 waist", "36 inches". */
const MEASURE_AFTER = /^\s?(cm|mm|in\b|inch|inches|"|kg|kilos?|lbs?|stone|waist|chest|leg|inside leg|ft|feet|foot)/i;

const BUDGET_PATTERNS: Array<{ kind: Budget['kind']; pattern: RegExp }> = [
  // "ideally under £60" is a wish; checked before "under £60", which is a ceiling.
  { kind: 'ideal', pattern: new RegExp(String.raw`\b(?:ideally|preferably|hopefully|if possible|would like to keep it|rather keep it|try to keep it)\s+(?:under|below|less than|around|about|within|at)?\s*` + MONEY, 'i') },
  { kind: 'around', pattern: new RegExp(String.raw`\b(?:around|about|roughly|approximately|approx\.?|in the region of|ballpark|somewhere near|circa)\s+` + MONEY, 'i') },
  {
    kind: 'max',
    pattern: new RegExp(
      String.raw`\b(?:under|below|less than|no more than|not more than|max(?:imum)?(?: of)?|up to|at most|nothing (?:over|above|more than)|(?:do not|don't|dont) want to (?:spend|pay) (?:more than|over)|not (?:spend|pay)(?:ing)? (?:more than|over)|capped at|cap of|within|budget (?:is|of)|my budget'?s?|spend(?:ing)? (?:up to|no more than)?)\s*(?:is\s+|of\s+)?` + MONEY,
      'i',
    ),
  },
  // "£50 each", "£40 tops", "£150 in total": the limit said after the figure.
  {
    kind: 'max',
    pattern: new RegExp(MONEY + String.raw`\s?(?:each|per item|per piece|apiece|a piece|tops|max|maximum|limit|budget|in total|total|all in|altogether|for everything|for the lot)\b`, 'i'),
  },
];

function readBudget(text: string): Budget | undefined {
  for (const { kind, pattern } of BUDGET_PATTERNS) {
    const match = pattern.exec(text);
    if (!match?.[1]) continue;
    const after = text.slice((match.index ?? 0) + match[0].length);
    if (MEASURE_AFTER.test(after)) continue;
    const amount = Number(match[1]);
    // "under 2" is a count, "under 5000" is not a golf shirt.
    if (!Number.isFinite(amount) || amount < 5 || amount > 5000) continue;
    const said = match[0];
    const hasCurrency = /£|\$|€|pounds?|quid|euros?|dollars?|gbp|eur|usd|budget|spend|pay/i.test(said + after.slice(0, 12));
    // A bare "under 40" with no money word is still money when nothing says otherwise.
    if (!hasCurrency && amount < 10) continue;
    return { amount, kind, per: budgetPer(text) };
  }
  return undefined;
}

/** "£50 on a polo" is per item; "£150 for the outfit" is the total. */
function budgetPer(text: string): Budget['per'] {
  if (/\b(each|per (item|piece|garment|polo|shirt)|apiece|a piece|a pop|on (a|one|the|each) \w+)\b/i.test(text)) return 'item';
  if (/\b(total|in total|all in|altogether|overall|for everything|for the lot|for (the|an|my|a) (outfit|pack|look|kit|bundle|set)|whole (outfit|look|lot))\b/i.test(text)) return 'total';
  if (/\b(outfit|pack|bundle|kit|everything|few things|several|full look|set)\b/i.test(text)) return 'total';
  // One garment named, and nothing about a total: that garment's budget.
  const garments = text.match(/\b(polo|shirt|jacket|gilet|midlayer|hoodie|trousers?|shorts|joggers?|cap|belt|socks|skort|coat|jumper|top)s?\b/gi) ?? [];
  return new Set(garments.map((g) => g.toLowerCase().replace(/s$/, ''))).size === 1 ? 'item' : 'total';
}

const PREFER = /\b(prefer|preferably|ideally|maybe|perhaps|possibly|or something|if possible|if you have|would be nice|i like|quite like|really like|love|keen on|lean(ing)? towards|open to|mostly|usually wear|tend to wear|fan of|not necessarily|(?:doesn'?t|does not|don'?t|need not|needn'?t) (?:have|need) to be)\b/i;
const REQUIRE = /\b(only|must|has to|have to|needs? to be|got to be|nothing but|has got to|essential|definitely|strictly|exclusively)\b/i;
/** "It doesn't have to be waterproof": a requirement let go of - a preference at most, whatever "have to" says (V1 task 4). */
const LET_GO = /\b(?:doesn'?t|does not|don'?t|need not|needn'?t) (?:have|need) to be\b|\bnot necessarily\b/i;

/** "anything but black", "not black", "no orange": colours to keep away from. */
function avoidedColours(text: string): { avoid: string[]; rest: string } {
  const avoid: string[] = [];
  const rest = text.replace(
    /\b(?:not|no|anything but|except|apart from|avoid|nothing in|don'?t (?:want|like)|hate|without|never)\s+(?:any\s+|a\s+|the\s+)?((?:[a-z]+(?:\s+or\s+|\s*,\s*|\s+and\s+)?){1,3})/gi,
    (whole, words: string) => {
      const found = parseColours(words).colours.map((colour) => colour.word);
      if (!found.length) return whole;
      avoid.push(...found);
      return ' ';
    },
  );
  return { avoid, rest };
}

const FIT_RELAXED = /\b(relaxed|loose|roomy|baggy|generous|comfortable|comfy) (fit|cut)\b|\blike (my |them |it |things |tops |clothes |shirts )?(a bit )?(loose|looser|roomy|relaxed|baggy|oversized)\b|\b(bit of|some|extra) room\b|\bnot too (tight|fitted|snug)\b/i;
const FIT_TIGHT = /\b(slim|tight|fitted|snug|close|athletic|tailored) (fit|cut)\b|\blike (my |them |it |things |tops |clothes |shirts )?(tight|fitted|snug|close[- ]fitting)\b|\bnot too (loose|baggy)\b/i;
const FIT_REGULAR = /\b(regular|normal|standard|true to size) (fit|cut)\b/i;
const LAYERING = /\b(layer(ing)? (it |something |a \w+ )?(under|underneath)|wear (it |a \w+ |something )?(under|over|underneath)|over (a|my) (hoodie|jumper|midlayer|polo|sweater|layer)|room (to|for) (layer|a layer)|with (a )?layers? underneath)\b/i;

const USUAL_SIZE = /\b(?:i'?m|i am|usually|normally|i wear|i take|typically|always)\s+(?:a\s+|an\s+|size\s+|in\s+(?:a\s+)?)*(xxs|xs|s|m|l|xl|xxl|xxxl|2xl|3xl|4xl|small|medium|large|x-?large|extra large|extra small)\b(?!\s*(?:chest|waist|cm|in\b|inch))/i;
/** "My normal polo size is L", "my usual size's XL", "I generally wear a medium". */
const USUAL_NAMED = /\b(?:my\s+)?(?:usual|normal|regular|typical|standard)\s+(?:\w+\s+)?size(?:\s+is|'s|\s*=|\s*:)?\s+(?:a\s+|an\s+)?(xxs|xs|s|m|l|xl|xxl|xxxl|2xl|3xl|4xl|small|medium|large|x-?large|extra large|extra small)\b|\b(?:generally|mostly|normally|usually|typically)\s+wear\s+(?:a\s+|an\s+|size\s+)?(xxs|xs|s|m|l|xl|xxl|xxxl|2xl|3xl|4xl|small|medium|large|x-?large|extra large|extra small)\b/i;
const USUAL_UK = /\b(?:i'?m|i am|usually|normally|i wear|i take|typically)\s+(?:a\s+)?(?:size\s+|uk\s+)(\d{1,2})\b(?!\s*(?:cm|in\b|inch|"|waist|chest))/i;


const JUST_THIS = /\b(?:just|only)\s+(?:the|this|that|a|one|my)\s+([a-z]+)(?:\s+(?:please|thanks|for now|today))?\s*[.!]?\s*$|\b(?:that'?s all|that is all|that'?s everything|nothing else|no(?:thing)? more|i'?m done|i'?m good thanks)\b/i;
const MORE_WANTED = /\b(what else|anything else|goes with|go with|match(es|ing)? (it|this|that)|complete the look|full look|outfit|pack|bundle|also|as well)\b/i;

/**
 * What one message says. `standing` marks a colour or feature stated as a
 * rule or a taste ("only navy", "I'd prefer navy") rather than the subject of
 * this one request ("show me blue polos") - only standing ones are remembered,
 * so asking for blue polos does not turn every later jacket blue.
 */
export type Intent = Partial<ShopperProfile> & { coloursStanding?: boolean; featuresStanding?: boolean };

/** Everything their latest message tells us, and only that. */
export function readIntent(text: string): Intent {
  const out: Intent = {};
  const lower = text.toLowerCase();

  const range = parseRange(text).range;
  if (range) out.range = range;

  const budget = readBudget(lower);
  if (budget) out.budget = budget;

  const { avoid, rest } = avoidedColours(lower);
  if (avoid.length) out.avoidColours = avoid;
  const colours = parseColours(rest).colours.map((colour) => colour.word);
  if (colours.length) {
    // "Navy or black" offered as options, or said with a softener, is a preference.
    const soft = (PREFER.test(rest) && !REQUIRE.test(rest)) || LET_GO.test(rest);
    out.colours = { words: colours, strength: soft ? 'preferred' : 'required' };
    /*
     * "You showed me only red" is a complaint about what was shown, not a
     * rule; read as "only red", it filtered every later polo search of the
     * session to red and yellow (live, 29 Sep). What the Caddie did is not
     * what they require.
     */
    const aboutWhatWasShown = rest.replace(/\byou(?:'ve| have)? (?:only )?(?:showed|show|shown|gave|given|sent|found|listed|displayed)(?: me)?(?: only)?\b[^.,;!?]*/gi, ' ');
    out.coloursStanding = PREFER.test(aboutWhatWasShown) || REQUIRE.test(aboutWhatWasShown);
  }

  // "Relaxed-fit" is "relaxed fit": the patterns read words, and a hyphen joined them into one.
  const fitText = lower.replace(/\b(relaxed|loose|roomy|slim|tight|fitted|athletic|tailored|regular|normal|standard|classic)-(fit|cut)\b/g, '$1 $2');
  if (FIT_RELAXED.test(fitText)) out.fit = 'relaxed';
  else if (FIT_TIGHT.test(fitText)) out.fit = 'tight';
  else if (FIT_REGULAR.test(fitText)) out.fit = 'regular';
  if (LAYERING.test(lower)) out.layering = true;

  const named = USUAL_NAMED.exec(lower);
  const usual = USUAL_SIZE.exec(lower)?.[1] ?? (named ? (named[1] ?? named[2]) : undefined) ?? USUAL_UK.exec(lower)?.[1];
  const size = usual ? normaliseSize(usual.replace(/^x-?large$/, 'xl')) : null;
  if (size) out.usualSize = size;

  // "a 34 waist", "waist size 34", "34 inch waist" - trouser sizes run 26 to 46.
  const waist = /\b(\d{2})\s?(?:"|in|inch|inches)?\s?waist\b|\bwaist\s?(?:size\s?)?(?:is\s|of\s)?(\d{2})\b(?!\s?cm)/.exec(lower);
  const waistSize = Number(waist?.[1] ?? waist?.[2]);
  /*
   * Not a waist they are buying: "add the 34 waist" is one pair, and
   * remembered as their waist it would size every later pair of trousers.
   * "I have a 34 waist", "waist size 36" are about them.
   */
  const buying = /\b(add|buy|order|put|pop|basket|cart|get me|i'?ll take|the\s+\d{2}\s?(?:"|in|inch|inches)?\s?waist)\b/.test(lower);
  if (waistSize >= 26 && waistSize <= 46 && !buying) out.waist = String(waistSize);

  const asked = featuresAsked(lower);
  if (asked.length) {
    const soft = (PREFER.test(lower) && !REQUIRE.test(lower)) || LET_GO.test(lower);
    out.features = soft ? { required: [], preferred: asked } : { required: asked, preferred: [] };
    out.featuresStanding = PREFER.test(lower) || REQUIRE.test(lower) || /\b(need|needs|want)\b/.test(lower);
  }

  // The weather their words name, read by the one reader search gates on and product questions answer from (catalog/suitability.ts).
  const weather = needsSaid(lower).needs;
  if (weather.length) out.weather = weather;

  const just = JUST_THIS.exec(lower);
  if (just) out.justThis = just[1] ?? 'this';
  else if (MORE_WANTED.test(lower)) out.justThis = '';

  return out;
}

/* ---------------- Keeping it ---------------- */

/**
 * What of one message holds for the rest of this shopping session: a colour
 * or feature stated as a rule or a taste ("only navy", "I'd prefer navy"),
 * a budget, a fit, the weather. A colour named for this one request ("show
 * me blue polos") is the focus's (session/focus.ts), not this.
 */
export function standingPart(intent: Intent): Partial<ShopperProfile> {
  const { coloursStanding, featuresStanding, ...rest } = intent;
  if (!coloursStanding) delete rest.colours;
  if (!featuresStanding) delete rest.features;
  return rest;
}

/**
 * Words that say something is how they are, not what they want today: "I'm
 * usually", "I normally play in", "my usual colours", "I prefer". Kept
 * deliberately narrow - when unsure, a statement stays with this shopping
 * session and is not remembered about them.
 */
const STANDING =
  /\b(usually|normally|generally|typically|always|mostly|tend to|in general|these days|from now on|any ?more|my (?:usual|normal|regular|standard|favourite|favorite)|i (?:really )?prefer|i (?:really )?(?:like|love) (?:wearing|to wear|my|them|it|things|tops|clothes|shirts)|i (?:only )?ever wear|i never wear|i wear mostly)\b/i;
/** "I don't like black any more", "I never wear orange": about them, not this search. */
const STANDING_AVOID = /\b(any ?more|never wear|i (?:don'?t|do not) (?:like|wear)|i hate|can'?t stand|not a fan of)\b/i;
/** "I'm a woman", "I shop ladies": a range that is who they are. */
const STANDING_RANGE = /\b(?:i'?m|i am)\s+(?:a\s+)?(?:man|woman|lady|gent|guy|girl|boy|female|male)\b|\bi (?:usually |normally |always |only )?(?:wear|buy|shop(?: in| for)?) (?:mens|men'?s|ladies|ladies'|womens|women'?s)\b/i;

/**
 * What of one message is a durable fact about the customer. Their usual size
 * and waist are said about themselves by the readers that find them; anything
 * else needs words that make it standing. "Polos under £30" is this search;
 * "I usually spend under £50" is them.
 */
export function durablePart(intent: Intent, text: string): Partial<ShopperProfile> {
  const lower = text.toLowerCase();
  const standing = STANDING.test(lower);
  const out: Partial<ShopperProfile> = {};
  if (intent.usualSize) out.usualSize = intent.usualSize;
  if (intent.waist) out.waist = intent.waist;
  if (intent.range && STANDING_RANGE.test(lower)) out.range = intent.range;
  if (!standing) {
    if (intent.avoidColours?.length && STANDING_AVOID.test(lower)) out.avoidColours = intent.avoidColours;
    return out;
  }
  if (intent.range && !out.range && /\b(usually|normally|always|generally|mostly)\b/.test(lower)) out.range = intent.range;
  if (intent.colours) out.colours = intent.colours;
  if (intent.avoidColours?.length) out.avoidColours = intent.avoidColours;
  if (intent.fit) out.fit = intent.fit;
  if (intent.features) out.features = intent.features;
  if (intent.budget) out.budget = intent.budget;
  if (intent.weather?.length) out.weather = intent.weather;
  return out;
}

/** A later statement replaces an earlier one, field by field. Lists of ids accumulate. */
export function mergeProfile(current: ShopperProfile | undefined, update: Partial<ShopperProfile>): ShopperProfile {
  const next: ShopperProfile = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(update) as Array<[keyof ShopperProfile, unknown]>) {
    if (key === ('coloursStanding' as keyof ShopperProfile) || key === ('featuresStanding' as keyof ShopperProfile)) continue;
    if (value === undefined) continue;
    if (key === 'liked' || key === 'rejected') {
      const merged = [...new Set([...((next[key] as string[] | undefined) ?? []), ...(value as string[])])].slice(-30);
      (next as Record<string, unknown>)[key] = merged;
    } else if (key === 'justThis' && value === '') {
      delete next.justThis;
    } else {
      (next as Record<string, unknown>)[key] = value;
    }
  }
  // A colour they now avoid is no longer one they want.
  if (update.avoidColours?.length && next.colours && !update.colours) {
    const words = next.colours.words.filter((colour) => !update.avoidColours!.includes(colour));
    if (words.length) next.colours = { ...next.colours, words };
    else delete next.colours;
  }
  // A colour they now want cannot also be one they avoid.
  if (update.colours && next.avoidColours) {
    next.avoidColours = next.avoidColours.filter((colour) => !update.colours!.words.includes(colour));
    if (!next.avoidColours.length) delete next.avoidColours;
  }
  // A liked product is no longer a rejected one, and the other way round.
  if (update.liked && next.rejected) next.rejected = next.rejected.filter((id) => !update.liked!.includes(id));
  if (update.rejected && next.liked) next.liked = next.liked.filter((id) => !update.rejected!.includes(id));
  return next;
}

export function describeBudget(budget: Budget, currency = 'GBP'): string {
  const amount = formatMoney(budget.amount, currency, { short: true });
  const per = budget.per === 'item' ? ' per item' : ' in total';
  if (budget.kind === 'max') return `no more than ${amount}${per} (a hard limit)`;
  if (budget.kind === 'around') return `around ${amount}${per}`;
  return `ideally under ${amount}${per} (a preference, not a limit)`;
}

/**
 * The profile as the model reads it each turn - short, because it varies per
 * call and so never caches.
 */
export function describeProfile(profile: ShopperProfile | undefined, currency = 'GBP'): string | null {
  const bits = profileBits(profile, currency);
  return bits.length ? `What this customer has told us (use it, never ask again): ${bits.join('; ')}.` : null;
}

/** Each thing a profile holds, as a short phrase - shared by every description of the customer. */
export function profileBits(profile: Partial<ShopperProfile> | undefined, currency = 'GBP'): string[] {
  if (!profile) return [];
  const bits: string[] = [];
  if (profile.range) bits.push(`range: ${profile.range === 'women' ? 'ladies' : profile.range === 'men' ? 'mens' : 'kids'}`);
  if (profile.usualSize) bits.push(`usually wears ${profile.usualSize}`);
  if (profile.waist) bits.push(`waist ${profile.waist}`);
  if (profile.fit) bits.push(`likes a ${profile.fit === 'tight' ? 'close' : profile.fit} fit`);
  if (profile.layering) bits.push('wants room to layer underneath');
  if (profile.colours) bits.push(`colour: ${profile.colours.words.join(' or ')} (${profile.colours.strength})`);
  if (profile.avoidColours?.length) bits.push(`avoid: ${profile.avoidColours.join(', ')}`);
  if (profile.features?.required.length) bits.push(`must be: ${profile.features.required.join(', ')}`);
  if (profile.features?.preferred.length) bits.push(`would like: ${profile.features.preferred.join(', ')}`);
  if (profile.budget) bits.push(`budget: ${describeBudget(profile.budget, currency)}`);
  if (profile.occasion) bits.push(`for: ${profile.occasion}`);
  if (profile.weather?.length) bits.push(`weather: ${profile.weather.join(', ')}`);
  if (profile.rejected?.length) bits.push(`turned down ${profile.rejected.length} product(s) - never offer them again`);
  if (profile.justThis) bits.push(`said "just the ${profile.justThis}" - do not cross-sell`);
  return bits;
}
