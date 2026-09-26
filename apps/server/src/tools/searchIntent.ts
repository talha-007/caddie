import { FEATURE_LABEL, WEATHER_NEEDS, featuresAsked, type Feature, type Weather } from '../catalog/attributes.js';
import { parseRange, type Range } from '../catalog/audience.js';
import { parseColours } from '../catalog/colour.js';
import { conceptKindsInQuery, type ConceptKind } from '../catalog/concepts.js';
import { categoriesAsked, sizeInRequest, withoutSize, type Category } from '../catalog/constraints.js';
import { SPELLING_VARIANTS, singular, wordSimilarity } from '../catalog/identity.js';
import { lookupProductName, namingWords } from '../catalog/lookup.js';
import { normaliseQuery } from '../catalog/taxonomy.js';
import { productById } from '../catalog/sync.js';
import { priceFor } from '../recommend/pricing.js';
import { normaliseSize } from '../recommend/sizeWords.js';
import { phoneticEnglish } from '../ai/phoneticEnglish.js';
import { readIntent } from '../shopper/profile.js';
import { describeFocus, focusQuery, inFocus, isFollowUp, type ShoppingFocus } from '../session/focus.js';
import { shopperSizes } from '../shopper/remember.js';
import type { ToolContext } from './types.js';

/**
 * What a search is actually for - resolved from evidence, not taken from the
 * model's arguments.
 *
 * The model writes the tool call, and it writes things nobody said. Asked for
 * "something warm but sleeveless", it searched category midlayer, the gilets
 * were filtered out, and the Caddie called a midlayer sleeveless. Asked for no
 * size, it searched in M. Told "navy or black", it searched navy. Asked for a
 * relaxed polo, it required lightweight; with no budget given, it set £100.
 * Each was patched on its own until this: every argument is a proposal, and a
 * hard rule needs evidence the customer gave it -
 *
 *   utterance     their words, this turn
 *   conversation  a follow-up ("another one") to the search just shown, or
 *                 something they said earlier in this conversation
 *   profile       what they have told us about themselves and we remembered
 *   derived       read from their words by our own readers: "rain" needs
 *                 waterproof, "lighter" is lightweight
 *   tool          the model's argument, taken on trust - only where the
 *                 customer's words cannot be read (below)
 *
 * What the readers cannot check is never a rule. They read English - the
 * customer's own words, or those words as the voice path normalised them
 * (English heard in Urdu letters, see ai/phoneticEnglish.ts). A request they
 * cannot read at all ("quiero un polo azul") is not a licence for the model:
 * its kind, range, colour and features become hints - searched for, ranked
 * up, never filtered on - and its budget is ignored. Failing to understand
 * the customer fails open, to browsing, never closed on constraints nobody
 * can show they asked for. The search engine itself is untouched: it
 * receives the resolved values.
 */

export type IntentSource = 'utterance' | 'conversation' | 'profile' | 'ui' | 'tool' | 'derived';
export type IntentStrength = 'hard' | 'preference' | 'descriptive';

export interface IntentValue<T> {
  value: T;
  source: IntentSource;
  strength: IntentStrength;
}

export interface Rejected {
  field: string;
  value: unknown;
  /**
   * What became of it: `rejected` - not used at all; `soft` - kept as a hint
   * (searched for, ranked up) but never a rule; `ignored` - dropped, with
   * nothing of it kept.
   */
  disposition: 'rejected' | 'soft' | 'ignored';
  reason: string;
}

export interface SearchIntent {
  /** The words to search, size words and unsupported garment words taken out. */
  query: string;
  productName?: IntentValue<string>;
  categories?: IntentValue<Category[]>;
  range?: IntentValue<Range>;
  /** The colour as it will be applied: "navy or black", "plain white". Strength is decided by the colour rules downstream. */
  colour?: IntentValue<string>;
  size?: IntentValue<string>;
  maxPrice?: IntentValue<number>;
  /** Features the search requires. */
  features: IntentValue<Feature[]>;
  weather: Weather[];
  /** Kinds the customer's own words point at: "sleeveless" -> gilet. Descriptive only. */
  concepts: ConceptKind[];
  /** A price comparison the customer asked for, read from their words - never from the model. */
  price?: PriceIntent;
  /** Whether the customer's words could be read - when not, the model's proposals are hints at most. */
  verifiable: boolean;
  /** The customer's words as read: their own, or the English the voice path's normaliser made of them. */
  evidence: string;
  /** Model proposals kept as hints only: described to meaning search, never required. */
  hints: { features: Feature[] };
  /** Whether a name is one the customer gave - now, earlier, or on the cards - so a check of it may speak for them. */
  namedByCustomer: (name: string) => boolean;
  proposed: SearchArgs;
  rejected: Rejected[];
  /**
   * The customer's current focus (session/focus.ts) and how this search used
   * it: `inherited` - a follow-up, so its kind and range came from their
   * latest request, not from the model or the cards; `explicit` - their words
   * this turn named what to search.
   */
  focus: { source: 'explicit' | 'inherited' | 'none'; active: string; resolved: string };
  /** Where the size came from - kept in the shape the search diagnostics have always reported. */
  sizeProvenance: { requestedSize: string | null; trustedSize: string | null; sizeSource: string; ignoredModelSize: boolean };
  /** A size word to take out of the searched words, trusted or not: "M" is not a word a product is found by. */
  sizeWords?: string;
}

/**
 * "Cheapest" and "cheaper", as the search must compute them.
 *
 *   minimum  the lowest-priced product that meets every other rule
 *   below    strictly below the price of the product being compared with;
 *            no reference when nothing trusted is in focus, and then no
 *            comparison is made at all
 */
export type PriceIntent =
  | { mode: 'minimum' }
  | { mode: 'below'; reference?: { id: string; title: string; price: number } };

/** The search_products arguments this reads - the model's proposal. */
export interface SearchArgs {
  query: string;
  productName?: string;
  category?: string;
  range?: 'mens' | 'ladies' | 'kids';
  colour?: string;
  size?: string;
  maxPrice?: number;
  /** Proposed features - words, checked against the features the catalogue knows. */
  features?: string[];
}

const KNOWN_FEATURES = new Set(Object.keys(FEATURE_LABEL));

/** The proposed features the catalogue knows, and the ones it does not ("relaxed" is a fit). */
function knownFeatures(proposed: string[] | undefined): { known: Feature[]; unknown: string[] } {
  const known: Feature[] = [];
  const unknown: string[] = [];
  for (const word of proposed ?? []) (KNOWN_FEATURES.has(word) ? known.push(word as Feature) : unknown.push(word));
  return { known, unknown };
}

type Turn = ReturnType<typeof readIntent>;

/*
 * Whether our readers can read the customer's words. They read English; a
 * message with none of these words in it is another language (or a bare "XL"),
 * and then there is nothing to check the model against.
 */
const ENGLISH =
  /\b(the|a|an|me|my|i|im|show|want|need|looking|for|in|with|some|something|and|or|any|have|got|do|you|please|get|find|under|is|it|what|which|can|like|prefer|usually|another|one|ones|more|cheaper|add|size|colour|color|also|too|same|different|other|else)\b/i;

/** A message that continues the search on screen rather than starting a new one. */
const FOLLOW_UP =
  /\b(another|other|others|else|more|cheaper|lighter|warmer|darker|brighter|bigger|smaller|longer|shorter|different|similar|same|ones?|those|these|them|that|it|instead|too|also)\b/i;

/** "Lighter" is lightweight; "warmer" is warm - comparatives the feature reader does not take. */
const COMPARATIVES: Array<[RegExp, Feature]> = [
  [/\blighter\b/i, 'lightweight'],
  [/\bwarmer\b/i, 'warm'],
  [/\bstretchier\b/i, 'stretch'],
];

const RANGE_ARG: Record<string, Range> = { mens: 'men', ladies: 'women', kids: 'kids' };

const CHEAPEST = /\b(cheapest|lowest[- ]?price[ds]?|lowest[- ]cost|least expensive|most affordable|best price)\b/i;
const CHEAPER = /\b(cheaper|less expensive|more affordable|lower[- ]?price[ds]?|less pricey|not as expensive|lower cost)\b/i;
/** "Cheaper than £30" is a budget, read as one; only a comparison with nothing named after it is relative. */
const CHEAPER_THAN_AMOUNT = /\b(cheaper|less) than\s*(?:£|\$|€)?\s?\d/i;

/**
 * The price comparison in the customer's words. The product "cheaper" is
 * compared with is the one they are looking at: the product last talked
 * about, else the one the last search led with - never one the model names.
 */
function readPrice(said: string, ctx: ToolContext, size: string | undefined): PriceIntent | undefined {
  if (CHEAPEST.test(said)) return { mode: 'minimum' };
  if (!CHEAPER.test(said) || CHEAPER_THAN_AMOUNT.test(said)) return undefined;
  // Cheaper than the one in focus - a jacket still on screen is not the comparison when they are on polos.
  const focus = ctx.session.activeShoppingContext;
  const product = [focus?.productId, ctx.session.focusProductId, ctx.session.lastLead?.id]
    .map((id) => (id ? productById(id) : null))
    .find((found): found is NonNullable<typeof found> => !!found && inFocus(found, focus));
  if (!product) return { mode: 'below' };
  return { mode: 'below', reference: { id: product.id, title: product.title, price: priceFor(product, size).amount } };
}

const TOOL_ONLY = 'tool-only; customer language not verified';

export function resolveSearchIntent(args: SearchArgs, ctx: ToolContext, spoken: Turn): SearchIntent {
  /*
   * Their words, as our readers can read them. English written in Urdu
   * letters is read through the same normaliser the voice path uses; nothing
   * else is translated here.
   */
  // Chosen directly, with no model in between: a UI action, trusted as one.
  if (ctx.direct) return direct(args, ctx, spoken);
  const raw = ctx.utterance?.trim() ?? '';
  const phonetic = raw && !ENGLISH.test(raw) ? phoneticEnglish(raw) : null;
  const said = phonetic ? phonetic.normalised : raw;
  const verifiable = !!said && ENGLISH.test(said);
  const turn: Turn = phonetic ? readIntent(said) : spoken;
  const profile = ctx.session.shopper;
  const previous = ctx.session.lastSearch;
  const followUp = FOLLOW_UP.test(said) || said.split(/\s+/).length <= 3;
  /*
   * A follow-up to what they asked for last - "different colours", "another
   * one", "cheaper". Its kind and range are theirs, from the focus read out of
   * their own words (session/focus.ts), not the model's pick and not the last
   * search run: after "jackets and polos", then "polos", "different colours"
   * brought the Clima Jacket back because the model chose it.
   */
  const focus: ShoppingFocus | undefined = ctx.session.activeShoppingContext;
  const inherit = !!focus && focus.kinds.length > 0 && verifiable && isFollowUp(said);
  const rejected: Rejected[] = [];
  const reject = (field: string, value: unknown, reason: string, disposition: Rejected['disposition'] = 'rejected') =>
    rejected.push({ field, value, disposition, reason });

  /*
   * Size - the rule Task 12 made, moved here unchanged. Their words win; a
   * size the model proposes (the size field, or written into its query)
   * counts only if it is one they said in this conversation or their profile
   * holds - the same test the basket uses.
   */
  const saidSize = sizeInRequest(said);
  const proposedSize = args.size?.trim() ? (normaliseSize(args.size) ?? args.size.trim().toUpperCase()) : sizeInRequest(args.query);
  const proposedGrounded = !!proposedSize && sizesNeverGiven([proposedSize], ctx).length === 0;
  const size = saidSize ?? (proposedGrounded ? proposedSize : undefined);
  const sizeProvenance = {
    requestedSize: proposedSize ?? null,
    trustedSize: size ?? null,
    sizeSource: saidSize ? 'utterance' : proposedGrounded ? 'conversation or profile' : 'none',
    ignoredModelSize: !!proposedSize && proposedSize !== size,
  };
  if (sizeProvenance.ignoredModelSize) reject('size', proposedSize, 'not said by the customer or in their profile');
  const sizeWords = proposedSize ?? size;
  const searched = withoutSize(args.query, sizeWords);

  /*
   * Kind of garment. A rule only when they named it now, or when this is a
   * follow-up to a search for that kind. The model's category field and the
   * garment words it writes into its query are proposals alike: "midlayer
   * sleeveless warm" for "something warm but sleeveless" names a midlayer
   * nobody asked for.
   */
  const proposedCategories = (args.category ? categoriesAsked(args.category) : []).length ? categoriesAsked(args.category!) : categoriesAsked(searched);
  const saidCategories = categoriesAsked(withoutSize(said, saidSize));
  const previousCategories = (previous?.categories ?? []) as Category[];
  let categories: IntentValue<Category[]> | undefined;
  if (saidCategories.length) {
    // What they named - the model's pick only when it is one of those ("polos and jackets": the polo search).
    const within = proposedCategories.length && proposedCategories.every((kind) => saidCategories.includes(kind));
    categories = { value: within ? proposedCategories : saidCategories, source: 'utterance', strength: 'hard' };
    const extra = proposedCategories.filter((kind) => !saidCategories.includes(kind));
    if (extra.length) reject('category', extra, `the customer named ${saidCategories.join(' or ')}`);
  } else if (inherit) {
    categories = { value: focus!.kinds, source: 'conversation', strength: 'hard' };
    const off = proposedCategories.filter((kind) => !focus!.kinds.includes(kind));
    if (off.length) reject('category', off, `a follow-up to ${describeFocus(focus)}, the customer's latest request`);
  } else if (proposedCategories.length && followUp && proposedCategories.every((kind) => previousCategories.includes(kind))) {
    categories = { value: proposedCategories, source: 'conversation', strength: 'hard' };
  } else if (proposedCategories.length && !verifiable) {
    // Unreadable: the garment word stays in the words searched, as a hint - it filters nothing.
    reject('category', proposedCategories, TOOL_ONLY, 'soft');
  } else if (proposedCategories.length) {
    reject('category', proposedCategories, 'not named by the customer, and not a follow-up to a search for it');
  }
  // A garment word the model wrote and the customer did not is taken out of the words searched as well.
  const unsupported = rejected.find((entry) => entry.field === 'category' && entry.disposition === 'rejected')?.value as Category[] | undefined;
  /*
   * A follow-up searches for the focus itself: its design, or its kind, and
   * any colour held. The model's words for it were "clima jacket colours"
   * when the customer was on polos; their own ("different colours") name
   * nothing a product is found by.
   */
  const query = inherit ? focusQuery(focus!) : unsupported?.length ? withoutGarments(searched, unsupported, said) : searched;
  if (inherit && searched.trim().toLowerCase() !== query.trim().toLowerCase()) reject('query', args.query, `a follow-up to ${describeFocus(focus)}: searched as "${query}"`, 'ignored');

  /*
   * Range. Their words, or what we already know of them (the range they shop,
   * or the last search's when this follows it). A range only the model
   * proposed is not a rule - and so it is never remembered either.
   */
  const proposedRange = (args.range ? RANGE_ARG[args.range] : undefined) ?? parseRange(args.query).range ?? undefined;
  const saidRange = parseRange(said).range ?? undefined;
  const knownRange = ctx.session.sizeProfile.audience ?? ctx.session.preferences.audience ?? profile?.range;
  let range: IntentValue<Range> | undefined;
  if (saidRange) {
    range = { value: saidRange, source: 'utterance', strength: 'hard' };
    if (proposedRange && proposedRange !== saidRange) reject('range', proposedRange, `the customer said ${saidRange}`);
  } else if (inherit && focus!.range) {
    range = { value: focus!.range, source: 'conversation', strength: 'hard' };
    if (proposedRange && proposedRange !== focus!.range) reject('range', proposedRange, `a follow-up to ${describeFocus(focus)}`);
  } else if (proposedRange && (proposedRange === knownRange || (followUp && proposedRange === previous?.range))) {
    range = { value: proposedRange, source: proposedRange === knownRange ? 'profile' : 'conversation', strength: 'hard' };
  } else if (proposedRange && !verifiable) {
    // Never a gender from the model alone. A range word in its query still counts for relevance.
    reject('range', proposedRange, TOOL_ONLY, parseRange(args.query).range ? 'soft' : 'ignored');
  } else if (proposedRange) {
    reject('range', proposedRange, 'not said by the customer, and not a range they are known to shop');
  }

  /*
   * Colour - Task 16's rules, now with provenance. A colour the customer said
   * now, one they told us they wear, or the one the search they are following
   * up was in. A colour only the model chose ("white, for summer") is not a
   * filter. When the model's colour is not one they said but they did name
   * colours, their own words are used.
   */
  const modelColour = colourAsked(args.colour, normaliseQuery(searched).query);
  const colourWords = modelColour ? parseColours(modelColour).colours.map((colour) => colour.word) : [];
  const saidColours = parseColours(said).colours.map((colour) => colour.word);
  const rememberedColours = profile?.colours?.words ?? [];
  // Followed up, the colours held are the focus's - none after "different colours".
  const previousColours = inherit ? (focus!.colours ?? []) : previous?.colour ? parseColours(previous.colour).colours.map((colour) => colour.word) : [];
  const within = (pool: string[]) => colourWords.length > 0 && colourWords.every((word) => pool.includes(word));
  let colourText: string | undefined;
  let colourSource: IntentSource | undefined;
  let colourStrength: IntentStrength = 'hard';
  if (!modelColour || colourWords.length === 0) {
    // "Plain" alone: a filter, so read only when their words can be.
    if (modelColour && !verifiable) reject('colour', modelColour, TOOL_ONLY, 'ignored');
    else [colourText, colourSource] = [modelColour, modelColour ? 'utterance' : undefined];
  } else if (within(saidColours)) {
    [colourText, colourSource] = [modelColour, 'utterance'];
  } else if (within(rememberedColours)) {
    [colourText, colourSource] = [modelColour, 'profile'];
  } else if (followUp && within(previousColours)) {
    [colourText, colourSource] = [modelColour, 'conversation'];
  } else if (!verifiable) {
    // A preference, not a filter: that colour is looked for and ranked first, every other colour still shows.
    [colourText, colourSource, colourStrength] = [modelColour, 'tool', 'preference'];
    reject('colour', modelColour, TOOL_ONLY, 'soft');
  } else {
    reject('colour', modelColour, 'not said by the customer, remembered, or the colour being followed up');
    if (turn.colours?.words.length) [colourText, colourSource] = [turn.colours.words.join(' or '), 'utterance'];
  }
  // An echo of part of a list they gave is that whole list (Task 16).
  const widened = rememberedWhenEchoed(colourText, turn, profile?.colours);

  /*
   * Budget. A ceiling the customer gave - in this message, or remembered as
   * theirs. The model's maxPrice counts only when that amount is one they
   * said; otherwise the ceiling comes from their budget, if they have one.
   */
  let maxPrice: IntentValue<number> | undefined;
  if (args.maxPrice !== undefined) {
    const amount = args.maxPrice;
    const inWords = new RegExp(`(^|[^\\d.])${String(amount).replace('.', '\\.')}(\\.0+)?(?![\\d])`).test(said);
    const remembered = profile?.budget?.amount === amount || turn.budget?.amount === amount;
    // Never a spending limit nobody gave: unreadable or not, a budget the customer did not state is ignored.
    if (inWords || turn.budget?.amount === amount) maxPrice = { value: amount, source: 'utterance', strength: 'hard' };
    else if (remembered) maxPrice = { value: amount, source: 'profile', strength: 'hard' };
    else reject('maxPrice', amount, verifiable ? 'no budget of that amount was given' : TOOL_ONLY, 'ignored');
  }

  /*
   * Features the search requires. The model's (its features field, and what
   * its query words imply - "rain jacket" needs waterproof) count when the
   * customer's words ask for them, or their weather needs them, or they told
   * us before. A relaxed polo is not a lightweight one because the model
   * thought so.
   */
  const { known: modelFeatures, unknown: notFeatures } = knownFeatures(args.features);
  if (notFeatures.length) reject('features', notFeatures, 'not a feature the catalogue knows', 'ignored');
  const proposedFeatures = [...new Set([...normaliseQuery(searched).features, ...modelFeatures])];
  const evidence = new Set<Feature>([
    ...featuresAsked(said),
    ...normaliseQuery(said).features,
    ...COMPARATIVES.filter(([pattern]) => pattern.test(said)).map(([, feature]) => feature),
    ...(turn.features?.required ?? []),
    ...(turn.features?.preferred ?? []),
    ...(turn.weather ?? []).flatMap((kind) => WEATHER_NEEDS[kind]),
    ...(profile?.features?.required ?? []),
    ...(profile?.features?.preferred ?? []),
  ]);
  // Waterproof asked is water-resistant too.
  if (evidence.has('waterproof')) evidence.add('water-resistant');
  const kept = proposedFeatures.filter((feature) => evidence.has(feature));
  const dropped = proposedFeatures.filter((feature) => !kept.includes(feature));
  // Unreadable: described to meaning search as hints, never required of a product.
  const hinted = verifiable ? [] : dropped;
  if (dropped.length) reject('features', dropped, verifiable ? 'not asked for, and not what their weather needs' : TOOL_ONLY, verifiable ? 'rejected' : 'soft');

  /*
   * A product name. The catalogue check verifies whatever name it is given,
   * but only the customer can say they asked for one: a name the model made
   * up turns "something for the rain" into "we don't stock the Rain Pro
   * Jacket". A name counts when one of its own words is one they said - now,
   * earlier in this conversation, or on the cards they are looking at.
   */
  /*
   * Checked in any language: a name is the same word in Spanish as in English
   * ("¿tienen el Elite Polo?"), and a name nobody gave is a hint in either.
   */
  const now = [...wordsOf(said), ...wordsOf(raw)];
  const before = wordsOf(
    [...ctx.session.messages.filter((message) => message.role === 'user').map((message) => message.text), ...(ctx.session.lastShown?.items.map((item) => item.title) ?? [])].join(' '),
  );
  const nameSource = (name: string): IntentSource | null => {
    // Its naming words only (Task 9): "rain" in "Rain Pro Jacket" is weather the customer mentioned, not the name.
    const own = namingWords(name.toLowerCase());
    if (own.some((word) => mentioned(word, now))) return 'utterance';
    if (own.some((word) => mentioned(word, before))) return 'conversation';
    return null;
  };
  let productName: IntentValue<string> | undefined;
  // A product of another kind, named by the model on a follow-up, is the old topic coming back: never searched as a name.
  const offFocusName = (name: string) => {
    if (!inherit || nameSource(name) === 'utterance') return false;
    const found = lookupProductName(name);
    const product = found?.kind === 'exact-product' ? found.product : found?.kind === 'exact-family' ? found.products[0] : undefined;
    return !!product && !inFocus(product, focus);
  };
  if (args.productName?.trim() && offFocusName(args.productName.trim())) {
    reject('productName', args.productName.trim(), `a follow-up to ${describeFocus(focus)}; the model named another kind`, 'ignored');
  } else if (args.productName?.trim()) {
    const name = args.productName.trim();
    const source = nameSource(name);
    if (source) productName = { value: name, source, strength: 'hard' };
    // Its words stay in what is searched; it is never checked as a name, so it can never be "not stocked".
    else reject('productName', name, namingWords(name.toLowerCase()).length ? 'the customer did not name it' : 'no name in it - a kind of garment', 'soft');
  }

  const price = readPrice(said, ctx, size);
  const focusUse = {
    source: inherit ? ('inherited' as const) : saidCategories.length || saidRange ? ('explicit' as const) : ('none' as const),
    active: describeFocus(focus),
    resolved: inherit ? describeFocus(focus) : [range?.value, categories?.value.join('/')].filter(Boolean).join(' ') || 'nothing',
  };

  return {
    query,
    focus: focusUse,
    ...(price ? { price } : {}),
    ...(productName ? { productName } : {}),
    ...(categories ? { categories } : {}),
    ...(range ? { range } : {}),
    ...(widened ? { colour: { value: widened, source: colourSource ?? 'tool', strength: colourStrength } } : {}),
    ...(size ? { size: { value: size, source: saidSize ? ('utterance' as const) : ('profile' as const), strength: 'hard' as const } } : {}),
    ...(maxPrice ? { maxPrice } : {}),
    features: { value: kept, source: 'utterance', strength: 'hard' },
    weather: turn.weather ?? [],
    concepts: conceptKindsInQuery(said),
    verifiable,
    evidence: said,
    hints: { features: hinted },
    namedByCustomer: (name: string) => nameSource(name) !== null,
    proposed: args,
    rejected,
    sizeProvenance,
    ...(sizeWords ? { sizeWords } : {}),
  };
}

/** Arguments chosen directly (see ToolContext.direct): each one a rule, from the UI. Size keeps its own check. */
function direct(args: SearchArgs, ctx: ToolContext, turn: Turn): SearchIntent {
  const ui = <T>(value: T): IntentValue<T> => ({ value, source: 'ui', strength: 'hard' });
  const proposedSize = args.size?.trim() ? (normaliseSize(args.size) ?? args.size.trim().toUpperCase()) : sizeInRequest(args.query);
  const categories = (args.category ? categoriesAsked(args.category) : []).length ? categoriesAsked(args.category!) : categoriesAsked(withoutSize(args.query, proposedSize));
  const range = (args.range ? RANGE_ARG[args.range] : undefined) ?? parseRange(args.query).range ?? undefined;
  const query = withoutSize(args.query, proposedSize);
  const colour = rememberedWhenEchoed(colourAsked(args.colour, normaliseQuery(query).query), turn, ctx.session.shopper?.colours);
  const features = [...new Set([...normaliseQuery(query).features, ...knownFeatures(args.features).known])];
  return {
    query,
    ...(args.productName?.trim() ? { productName: ui(args.productName.trim()) } : {}),
    ...(categories.length ? { categories: ui(categories) } : {}),
    ...(range ? { range: ui(range) } : {}),
    ...(colour ? { colour: ui(colour) } : {}),
    ...(proposedSize ? { size: ui(proposedSize) } : {}),
    ...(args.maxPrice !== undefined ? { maxPrice: ui(args.maxPrice) } : {}),
    features: ui(features),
    weather: turn.weather ?? [],
    concepts: conceptKindsInQuery(ctx.utterance ?? ''),
    verifiable: true,
    evidence: ctx.utterance ?? '',
    hints: { features: [] },
    namedByCustomer: () => true,
    proposed: args,
    rejected: [],
    focus: { source: 'explicit', active: describeFocus(ctx.session.activeShoppingContext), resolved: 'chosen in the UI' },
    sizeProvenance: { requestedSize: proposedSize ?? null, trustedSize: proposedSize ?? null, sizeSource: proposedSize ? 'ui' : 'none', ignoredModelSize: false },
    ...(proposedSize ? { sizeWords: proposedSize } : {}),
  };
}

/** The resolved intent as one log line: what was proposed, what stands, what was set aside and why. */
export function intentDiagnostics(intent: SearchIntent) {
  return {
    verifiable: intent.verifiable,
    evidence: intent.evidence,
    proposed: intent.proposed,
    resolved: {
      query: intent.query,
      productName: intent.productName ? `${intent.productName.value} (${intent.productName.source})` : null,
      categories: intent.categories ? `${intent.categories.value.join('/')} (${intent.categories.source})` : null,
      range: intent.range ? `${intent.range.value} (${intent.range.source})` : null,
      colour: intent.colour ? `${intent.colour.value} (${intent.colour.source})` : null,
      size: intent.size ? `${intent.size.value} (${intent.size.source})` : null,
      maxPrice: intent.maxPrice ? `${intent.maxPrice.value} (${intent.maxPrice.source})` : null,
      features: intent.features.value,
      hints: intent.hints.features,
      weather: intent.weather,
      concepts: intent.concepts,
      price: intent.price ?? null,
    },
    rejected: intent.rejected,
    focus: intent.focus,
  };
}

function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1);
}

/** Said, or said misspelt, or said the other way it is spelt ("vapour" for "vapor"). */
function mentioned(word: string, pool: string[]): boolean {
  const target = singular(word.toLowerCase());
  return pool.some((said) => {
    const own = singular(said);
    return own === target || SPELLING_VARIANTS[own] === target || SPELLING_VARIANTS[target] === own || wordSimilarity(own, target) !== null;
  });
}

/** The query without the garment words of kinds nobody asked for. */
function withoutGarments(query: string, kinds: Category[], said: string): string {
  const saidWords = new Set(wordsOf(said));
  return query
    .split(/\s+/)
    .filter((word) => {
      const clean = word.toLowerCase().replace(/[^a-z]/g, '');
      if (!clean || saidWords.has(clean)) return true;
      return !categoriesAsked(clean).some((kind) => kinds.includes(kind));
    })
    .join(' ')
    .trim();
}

/*
 * The helpers below moved here from tools/index.ts, unchanged, so the rules
 * they carry live with the rest of the provenance.
 */

/**
 * The colour the customer asked for: passed explicitly, or named in the words
 * the model passed on.
 *
 * Never left to the model alone. Given "quiero un polo azul" it searched for
 * "polo"; asked for "a navy outfit, polos and trousers" it put "navy" in the
 * seed and no colour argument at all - and the customer got orange and purple.
 * Whatever reached us, if it names a colour, that colour is the rule.
 */
export function colourAsked(explicit: string | undefined, ...texts: Array<string | undefined>): string | undefined {
  /*
   * "Plain" travels with the colour. Asked to swap for a "plain white polo",
   * the model searched "white polo", "plain" never arrived, and the customer
   * was moved into the white-and-orange one.
   */
  const plain = [explicit, ...texts].some((text) => text && parseColours(text).plain);
  const withPlain = (colour: string) => (plain && !parseColours(colour).plain ? `plain ${colour}` : colour);

  if (explicit?.trim()) return withPlain(explicit.trim());
  const named = texts.flatMap((text) => (text ? parseColours(text).colours.map((colour) => colour.word) : []));
  if (named.length) return withPlain([...new Set(named)].join(' or '));
  return plain ? 'plain' : undefined;
}

/*
 * "Mostly navy or black", then "show me a polo": the model searched with
 * colour navy, every turn, and black was never seen again - the ranking
 * preferred navy alone and marked every black polo "not navy". A colour that
 * is only part of the list the customer gave - in this message or before -
 * is that whole list, not the first word of it. A colour outside the list
 * ("a red polo") is theirs, and is left exactly as it is.
 */
export function rememberedWhenEchoed(
  asked: string | undefined,
  turn: Turn,
  remembered: { words: string[]; strength: 'required' | 'preferred' } | undefined,
): string | undefined {
  // The colours they said in this message, else the ones they told us before - the same echo, either way.
  const whole = turn.colours?.words.length ? turn.colours.words : remembered?.words;
  if (!asked || !whole?.length) return asked;
  const { colours, plain } = parseColours(asked);
  if (!colours.length || !colours.every((colour) => whole.includes(colour.word))) return asked;
  const kept = whole.filter((word) => !(turn.avoidColours ?? []).includes(word));
  return `${plain ? 'plain ' : ''}${kept.join(' or ')}`;
}

/**
 * Sizes among these that the customer never gave: not in anything they said
 * this conversation, nor in their profile. Used by the basket too - a size
 * the model chose is never one to buy in.
 */
export function sizesNeverGiven(values: Array<string | undefined>, ctx: ToolContext, productId?: string): string[] {
  const said = [...ctx.session.messages.filter((message) => message.role === 'user').map((message) => message.text), ctx.utterance ?? '']
    .join(' ')
    .toLowerCase();
  // "I'm" is not an M, nor "it's" an S: apostrophes join, never split.
  const tokens = said.replace(/['’]/g, '').replace(/[^a-z0-9\s/-]/g, ' ').split(/[\s/]+/).filter(Boolean);
  const known = new Set<string>(tokens.filter((token) => /\d/.test(token)));
  tokens.forEach((token, i) => {
    for (const phrase of [token, `${token} ${tokens[i + 1] ?? ''}`, `${token} ${tokens[i + 1] ?? ''} ${tokens[i + 2] ?? ''}`]) {
      const size = normaliseSize(phrase.trim());
      if (size) known.add(size.toLowerCase());
    }
  });
  const profile = shopperSizes(ctx.session);
  for (const size of [profile?.size, profile?.waist]) if (size) known.add((normaliseSize(String(size)) ?? String(size)).toLowerCase());
  // What they picked on this product's card themselves - for this product only.
  const card = productId ? ctx.session.cardChoices?.[productById(productId)?.id ?? productId] : undefined;
  for (const value of Object.values(card?.options ?? {})) known.add((normaliseSize(value) ?? value).toLowerCase());
  const given = (value: string) =>
    /^one\s*size/i.test(value) ||
    // "M/L" on a belt is one of their sizes if either half is.
    value.split('/').some((part) => known.has((normaliseSize(part.trim()) ?? part.trim()).toLowerCase()));
  return values.filter((value): value is string => !!value?.trim()).filter((value) => !given(value));
}
