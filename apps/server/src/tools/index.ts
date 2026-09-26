import type { Cart, OutfitPiece, Product } from '@caddie/shared';
import { z } from 'zod';
import { FEATURE_LABEL, WEATHER_NEEDS, attributesOf, hasFeature, type Feature, type Weather } from '../catalog/attributes.js';
import { inRange, parseRange, rangeOf, type Range } from '../catalog/audience.js';
import { distinctiveWords, lookupProductName, unknownNameIn, type Existence } from '../catalog/lookup.js';
import { normaliseQuery } from '../catalog/taxonomy.js';
import { identityOf, nameWords } from '../catalog/identity.js';
import { categoriesAsked, categoriesOf, isCategory, sizeInRequest, sizeStatus, withoutSize, type Category } from '../catalog/constraints.js';
import {
  descriptiveSearchText,
  mergeCandidates,
  orderHybrid,
  recordHybridDiagnostics,
  semanticDesigns,
  wantsSemantic,
  type CandidateEvidence,
  type HybridDiagnostics,
} from '../catalog/hybrid.js';
import { conceptKindsInQuery, topKindsFor, type Climate } from '../catalog/concepts.js';
import { colourAsked, intentDiagnostics, rememberedWhenEchoed, resolveSearchIntent, sizesNeverGiven } from './searchIntent.js';
import { cartAuthorization, quantityAsked, turnNow } from './cartAuthorization.js';
import { packStatus, packStatusFacts, readPackChoices } from './packState.js';

export { sizesNeverGiven };
import { searchLocalScored } from '../catalog/search.js';
import { nextStep } from '../recommend/nextStep.js';
import { hasSignals, rankFacts, rankProducts, weatherHotOnly } from '../recommend/rank.js';
import { describeProfile, readIntent, type Budget } from '../shopper/profile.js';
import { rankRequestFor, rememberShopper, shopperSizes } from '../shopper/remember.js';
import { bestPicks, kindsNamed } from '../recommend/bestPicks.js';
import { answerAbout, attributesAsked, describeStock, sayAttributes, verifiedFacts } from '../recommend/productFacts.js';
import { resolveProduct } from '../session/screen.js';
import { describeFocus, designOf, focusProduct, focusQuery, inFocus, isFollowUp } from '../session/focus.js';
import { colourMatch, coloursOffered, matchesColourText, parseColours } from '../catalog/colour.js';
import { allDeals, type DealRecipe, type DealStep } from '../catalog/bundles.js';
import { log } from '../lib/logger.js';
import { checkoutTotal, storefrontCartEnabled } from '../shopify/storefrontCart.js';
import { colourwayName, garmentName, otherColourways } from '../catalog/colourways.js';
import { allProducts, productById } from '../catalog/sync.js';
import { asksForDeals, chooseDeal, dealRecommendation, fillDeal, findDeal, toBundleDeal } from '../recommend/deals.js';
import { DEFAULT_SLOTS, fitsSlot, namedSlots, recommendOutfit, slotsFor } from '../recommend/outfit.js';
import { recommendPack } from '../recommend/pack.js';
import { findNamedPack, findUnstockedBundle, recommendNamedPack } from '../recommend/packs.js';
import { priceFor, priceRange } from '../recommend/pricing.js';
import { categoryForProduct, recommendSize } from '../recommend/size.js';
import { normaliseSize, optionValueMatches } from '../recommend/sizeWords.js';
import { addToCart, getCart, getProductDetails, isBrandProduct, searchProducts, setLineQuantity } from '../shopify/catalog.js';
import { storeCurrency } from '../shopify/money.js';
import { sessions, tappedSinceLastSaid, type CaddieSession } from '../session/store.js';
import { defineTool, type CaddieTool, type ToolContext, type ToolResult } from './types.js';

/**
 * The tools the Caddie assistant can call.
 *
 * Every one of them returns `speech` (what the model may say) and an optional
 * `attachment` (what the widget renders). The model is told, in the system
 * prompt, that product facts live in the attachment and must not be restated
 * from memory.
 */

const SYMBOLS: Record<string, string> = { GBP: '£', USD: '$', EUR: '€' };

const money = (amount: number, currency: string) => {
  const symbol = SYMBOLS[currency];
  return symbol ? `${symbol}${amount.toFixed(2)}` : `${currency} ${amount.toFixed(2)}`;
};

/**
 * Which range a set of products belongs to.
 *
 * Saves asking "mens or womens?" when the customer is plainly already looking
 * at one of them. Returns undefined when the products disagree or say nothing,
 * and then find_my_size asks rather than guessing.
 */
function audienceOf(products: Product[]): 'men' | 'women' | undefined {
  // By name and type, not the tags - the live store tags every range "all".
  const ranges = new Set(products.map(rangeOf).filter((range) => range !== 'kids'));
  if (ranges.size !== 1) return undefined;
  return ranges.has('men') ? 'men' : 'women';
}

/** Mens or ladies, when the customer's own words name one. Kids have no size chart here. */
function saidRange(utterance: string | undefined): 'men' | 'women' | undefined {
  const range = utterance ? parseRange(utterance).range : null;
  return range === 'men' || range === 'women' ? range : undefined;
}

/** The range the customer is shopping, as far as we know it. */
function knownRange(ctx: ToolContext): 'men' | 'women' | undefined {
  return ctx.session.sizeProfile.audience ?? ctx.session.preferences.audience;
}

/**
 * The range for a deal: the customer's own words first, kids included.
 *
 * "Ladies ambassador pack" reached recommend_pack as "ambassador pack" often
 * enough to matter, and the customer was shown the mens pack.
 */
function dealRange(ctx: ToolContext): Range | undefined {
  return parseRange(ctx.utterance ?? '').range ?? knownRange(ctx);
}

/**
 * Whether checkout really charges a condition pack its pack price - see
 * add_pack_to_cart. Remembered per pack for a few minutes: whether the
 * discount knows a trigger is a store setting, not something that changes
 * per customer, and a throwaway cart per add would be wasteful.
 */
const packChecks = new Map<string, { verdict: 'ok' | 'wrong'; at: number }>();
const PACK_CHECK_MS = 10 * 60 * 1000;

/** What the chosen variants cost on their own - the most checkout can ever charge for them. */
/** "£156", "£159.99" - how a price is said. */
function pounds(amount: number): string {
  return Number.isInteger(amount) ? `£${amount}` : `£${amount.toFixed(2)}`;
}

/**
 * The line the reply check reads (ai/verify.ts): what they pay, the listed
 * price, and whether there is a saving at all. A saving is only the pieces'
 * own total above what they pay.
 */
export function packPriceLine(listed: number, pays: number, own: number): string {
  const saving = own > pays + 0.005 ? Number((own - pays).toFixed(2)) : 0;
  return `Pack price: pays ${pounds(pays)}; listed ${pounds(listed)}; saving ${saving ? pounds(saving) : 'none'}.`;
}

function piecesTotal(variantIds: string[]): number {
  let total = 0;
  for (const id of variantIds) {
    const variant = allProducts()
      .flatMap((product) => product.variants)
      .find((entry) => entry.id === id);
    total += variant?.price.amount ?? 0;
  }
  return Number(total.toFixed(2));
}

/**
 * 'cheaper': the pieces chosen cost less than the pack price, so checkout
 * charges their own total. Nothing is wrong - the customer pays less - but the
 * pack price is not what they pay, so the Caddie says the real figure.
 *
 * Only a verdict about the pack itself is remembered. Mixed Conditions was
 * checked once with pieces under £129.99, came back at their own total, and
 * that was remembered as "checkout does not apply it" - blocking the pack for
 * everyone for ten minutes, though it priced correctly with dearer pieces.
 */
async function packPriceHolds(deal: DealRecipe, variantIds: string[]): Promise<'ok' | 'cheaper' | 'wrong' | 'unknown'> {
  const expected = deal.prices.GBP ?? NaN;
  const own = piecesTotal(variantIds);
  if (own > 0 && own < expected) return 'cheaper';
  const cached = packChecks.get(deal.handle);
  if (cached && Date.now() - cached.at < PACK_CHECK_MS) return cached.verdict;
  if (!storefrontCartEnabled()) return 'unknown';
  try {
    const lines = buildPlusBundleLines(deal, variantIds);
    const total = await checkoutTotal(lines);
    const verdict = Math.abs(total - expected) < 0.01 ? 'ok' : 'wrong';
    packChecks.set(deal.handle, { verdict, at: Date.now() });
    if (verdict === 'wrong') log.warn('deals.pack_price_not_applied', { handle: deal.handle, expected, total });
    return verdict;
  } catch (err) {
    log.warn('deals.pack_price_check_failed', { handle: deal.handle, err: String(err) });
    return 'unknown';
  }
}

/** The lines the widget will write for a 'plus' pack, for pricing - see buildPlusBundleItems in shared. */
function buildPlusBundleLines(deal: DealRecipe, variantIds: string[]): Array<{ variantId: string; properties: Array<[string, string]> }> {
  return variantIds.map((variantId) => ({
    variantId,
    properties: [
      ['__Localization', 'GB'],
      ['_data_bundle_id', 'caddie-price-check'],
      ...Object.entries(deal.trigger ?? {}),
    ],
  }));
}

/**
 * The pack step their words name - "the polo", "a different jacket" - or -1.
 * The step titles are the store's ("JACKET / GILET", "BELT / CAP"), so each
 * kind of garment is matched against the step that holds it.
 */
const STEP_WORDS: Array<[RegExp, RegExp]> = [
  [/\b(polo|polos|shirt|tee)\b/i, /polo|shirt|tee/i],
  [/\b(jacket|gilet|coat|vest)\b/i, /jacket|gilet/i],
  [/\b(midlayer|mid-layer|hoodie|jumper|sweater|quarter zip)\b/i, /midlayer|hoodie|sweat/i],
  [/\b(trousers?|shorts|joggers?|pants|bottoms)\b/i, /trouser|short|jogger|pant|bottom/i],
  [/\b(belt|cap|hat|beanie)\b/i, /belt|cap|hat/i],
  [/\b(socks?)\b/i, /sock/i],
];

function stepNamed(deal: DealRecipe, text: string): number {
  for (const [said, step] of STEP_WORDS) {
    if (!said.test(text)) continue;
    const index = deal.steps.findIndex((entry) => step.test(entry.title));
    if (index >= 0) return index;
  }
  return -1;
}

/** "COOL & WET" -> "Cool & Wet", for speaking a store label aloud. */
function titleCaseWords(text: string): string {
  return text.toLowerCase().replace(/(^|[\s-])([a-z])/g, (_, gap: string, letter: string) => gap + letter.toUpperCase());
}

/** "Ladies " / "Kids " / "" - how the range prefixes a pack's name. */
function rangeLabel(range: Range): string {
  return range === 'women' ? 'Ladies ' : range === 'kids' ? 'Kids ' : '';
}

/** The products on the customer's screen, read back from the mirror. */
function onScreen(ctx: ToolContext): Product[] {
  return (ctx.session.lastShown?.items ?? [])
    .map((item) => productById(item.id))
    .filter((product): product is Product => product !== null);
}

/**
 * The basket as the model needs it: every line with the ids that change it.
 *
 * Without these the model could add to a basket but never take anything out.
 * Asked to swap an orange polo for a navy one, it added the navy, told the
 * customer the orange had gone, and left it in - there was no line id
 * anywhere in its view to remove it with.
 */
function cartFacts(cart: Cart): string {
  if (cart.lines.length === 0) return 'The basket is empty.';
  return `Basket lines:\n${cart.lines
    .map(
      (line) =>
        `- ${line.title}${line.variantTitle ? ` (${line.variantTitle})` : ''} x${line.quantity}, ${money(
          line.lineTotal.amount,
          line.lineTotal.currency,
        )} [line ${line.lineId}] [product ${line.productId}]`,
    )
    .join('\n')}\nTo remove a line call update_cart_item with its line id and quantity 0.`;
}

/** The store cart as the widget reported it, for the model - with the keys that change it. */
function cartSummary(lines: NonNullable<CaddieSession['basket']>): string {
  if (lines.length === 0) return 'The basket is empty.';
  const rows = lines.map(
    (line) =>
      `- ${line.title}${line.variantTitle ? ` (${line.variantTitle})` : ''} x${line.quantity}${
        line.bundle ? ' [part of a pack]' : ''
      } [line ${line.lineId}] [product ${line.productId}]`,
  );
  return `Basket lines:\n${rows.join('\n')}\nTo remove a line call update_cart_item with its line id and quantity 0.`;
}

/**
 * A bundle id in the theme's own format (bundle_<time>_<nine characters>).
 *
 * Deliberately not imported from @caddie/shared: the production server runs
 * compiled JavaScript, and that package is TypeScript source - a runtime import
 * from it works under tsx and in tests, and fails at start-up in production.
 * The server takes only types from it.
 */
function newBundleId(now: number): string {
  return 'bundle_' + now + '_' + Math.random().toString(36).substr(2, 9);
}

/** gid://shopify/ProductVariant/123 -> 123, as the theme's cart endpoints take ids. */
function numericId(id: string): string {
  return id.split('/').pop() ?? id;
}

/**
 * One line per product, so the model knows exactly what is on screen.
 *
 * The range is included because search does not respect it: ask for "womens
 * polo" in a store that stocks none and you get six mens polos back. Without
 * this the model relays them as womens.
 */
function listFacts(products: Product[], evidence?: (product: Product) => string): string {
  return products
    .map((product) => {
      const range = rangeOf(product);
      const label = ` (${range === 'men' ? 'mens' : range === 'women' ? 'ladies' : 'kids'})`;
      /*
       * "from" where the price moves with the size.
       *
       * product.price is Shopify's cheapest variant, and this list is what
       * the model reads before it answers. Stating that minimum flatly is why
       * "how much is the Tour Polo" came back "it is £42" for a garment that
       * runs to £52 - fixing the product detail path alone left this one
       * still saying it.
       */
      const span = priceRange(product);
      const shown =
        span.min === span.max
          ? money(span.min, span.currency)
          : `${money(span.min, span.currency)} to ${money(span.max, span.currency)} depending on size`;

      const checked = evidence?.(product);
      return `- ${product.title}${label} - ${shown} [${product.id}]${checked ? ` | checked: ${checked}` : ''}${verifiedLine(product)}`;
    })
    .join('\n');
}

/**
 * What the product's own description states, and nothing more.
 *
 * The model may describe a product with these - "a lightweight, breathable
 * polo" - because Druids wrote them. It may not add to them: a polo whose
 * description never says waterproof is not called waterproof, however much
 * the customer wants one.
 */
/**
 * The catalogue check, said as exactly as it was established. Only "not-found"
 * lets the Caddie say we do not stock something; a possible match is never
 * the product and never proof it is missing.
 */
/**
 * The cards for a name that could be several products: every in-stock
 * colourway of each candidate design, the designs taking turns so the
 * customer can choose between the names rather than see one of them six times.
 */
/**
 * "Add it", "add this one to my basket please": a reference and nothing else -
 * no name, colour or kind of garment that could point somewhere other than
 * what they last touched. A size is allowed ("add it in M").
 */
export function bareReference(text: string): boolean {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.some((word) => ['it', 'this', 'that', 'one'].includes(word))) return false;
  const filler = new Set(['add', 'put', 'pop', 'get', 'buy', 'take', 'ill', 'i', 'will', 'can', 'you', 'please', 'it', 'this', 'that', 'one', 'the', 'a', 'to', 'in', 'into', 'my', 'basket', 'cart', 'bag', 'yes', 'yeah', 'ok', 'okay', 'go', 'ahead', 'and', 'just', 'size', 'thanks', 'thank', 'now', 'for', 'me', 'then', 'do', 'lets', 'let', 's']);
  return words.every((word) => filler.has(word) || !!normaliseSize(word));
}

/** "Another one", "something else", "a different one" - asking past what was just shown. */
const ANOTHER = /\b(another|something else|a different one|different ones?|other ones?|other options?|more options|any others)\b/i;

/** Within each group (a match level), what has not been seen first; the order is otherwise kept. */
function unseenFirst<T>(entries: T[], idOf: (entry: T) => string, groupOf: (entry: T) => string, seen: Set<string>): T[] {
  const out: T[] = [];
  let start = 0;
  while (start < entries.length) {
    let end = start;
    while (end < entries.length && groupOf(entries[end]!) === groupOf(entries[start]!)) end += 1;
    const group = entries.slice(start, end);
    out.push(...group.filter((entry) => !seen.has(idOf(entry))), ...group.filter((entry) => seen.has(idOf(entry))));
    start = end;
  }
  return out;
}

/** The cuts a description can state that suit each fit a customer prefers. */
const FIT_SUITS: Record<'tight' | 'regular' | 'relaxed', string[]> = {
  relaxed: ['relaxed'],
  regular: ['regular'],
  tight: ['athletic', 'slim', 'tailored'],
};

/**
 * The cards with the lead moved to the front - see search_products. Chosen
 * only from those that fit as well as the first; ties keep the search's order.
 */
export function leadFirst(
  products: Product[],
  opts: {
    levelOf: (product: Product) => string;
    seen: Set<string>;
    fit?: 'tight' | 'regular' | 'relaxed';
    colours: string[];
    lastLead?: { id: string; colour: string };
  },
): Product[] {
  if (products.length < 2) return products;
  const best = opts.levelOf(products[0]!);
  const laneOf = (colourText: string) => opts.colours.find((colour) => parseColours(colourText).colours.some((c) => c.word === colour) || colourText.includes(colour));
  const lastLane = opts.lastLead ? laneOf(opts.lastLead.colour) : undefined;
  const score = (product: Product) => {
    const fit = attributesOf(product).fit;
    const lane = laneOf(colourwayName(product.title).toLowerCase());
    return (
      (opts.seen.size && !opts.seen.has(product.id) ? 4 : 0) +
      (opts.fit && fit && FIT_SUITS[opts.fit].includes(fit) ? 2 : 0) +
      (lastLane && lane && lane !== lastLane ? 1 : 0) +
      (opts.lastLead && product.id !== opts.lastLead.id ? 1 : 0)
    );
  };
  let chosen = 0;
  products.forEach((product, index) => {
    if (opts.levelOf(product) === best && score(product) > score(products[chosen]!)) chosen = index;
  });
  return chosen === 0 ? products : [products[chosen]!, ...products.filter((_, index) => index !== chosen)];
}

/** One from each list in turn, until all are used. */
function takeTurns<T>(lists: T[][]): T[] {
  const lanes = lists.map((list) => [...list]);
  const out: T[] = [];
  while (lanes.some((lane) => lane.length)) for (const lane of lanes) { const next = lane.shift(); if (next !== undefined) out.push(next); }
  return out;
}

const TOP_WORD = /\btops?\b/i;

function possibleCards(candidates: Product[]): Product[] {
  const byDesign = new Map<string, Product[]>();
  for (const product of candidates.flatMap((candidate) => [candidate, ...otherColourways(candidate)])) {
    if (!product.variants.some((variant) => variant.available)) continue;
    const key = `${rangeOf(product)}|${garmentName(product.title)}`;
    const group = byDesign.get(key) ?? [];
    if (!group.some((p) => p.id === product.id)) group.push(product);
    byDesign.set(key, group);
  }
  const lanes = [...byDesign.values()];
  const out: Product[] = [];
  while (lanes.some((lane) => lane.length)) for (const lane of lanes) { const next = lane.shift(); if (next) out.push(next); }
  return out;
}

function catalogueCheck(existence: Existence): string {
  const listed = (products: Product[]) =>
    products.map((p) => `${p.title} [${p.id}]${p.variants.some((v) => v.available) ? '' : ' (sold out)'}`).join(', ');
  // A misspelt or differently spelt name, read as the catalogue's: say the real name, never repeat theirs as if it were right.
  const corrected =
    (existence.kind === 'exact-product' || existence.kind === 'exact-family') && existence.resolution.type === 'corrected'
      ? `"${existence.resolution.input}" appears to refer to `
      : '';
  switch (existence.kind) {
    case 'exact-product':
      return corrected
        ? `Catalogue check: ${corrected}${listed([existence.product])}. Use the product's real name.`
        : `Catalogue check: exact product found: ${listed([existence.product])}.`;
    case 'exact-family':
      return corrected
        ? `Catalogue check: ${corrected}the ${titleCaseWords(existence.familyName)} design, in ${existence.products.length} colourways: ${listed(existence.products)}. Use the design's real name; ask which colour if it matters.`
        : `Catalogue check: Druids stocks the ${titleCaseWords(existence.familyName)} design in ${existence.products.length} colourways: ${listed(existence.products)}. No single colourway was named - ask which colour if it matters.`;
    case 'possible-match':
      return `Catalogue check: no single product could be confirmed for "${existence.name}" (${existence.reason}).${
        existence.products.length ? ` Possible matches: ${listed(existence.products)}.` : ''
      } Never present one of these as what they named, and never say we do not stock it - say you could not find that exact product.`;
    case 'not-found':
      return `Catalogue check: nothing in the Druids catalogue is called "${existence.name}" - every product was checked. You may say we do not stock it.${
        existence.closest.length ? ` Closest names: ${existence.closest.map((p) => p.title).join(', ')} - offer them as alternatives, never as it.` : ''
      }`;
    case 'unknown':
      return 'The full catalogue could not be checked just now. Say you could not find that exact product - never that we do not stock it.';
  }
}

function verifiedLine(product: Product): string {
  const { features, fit } = attributesOf(product);
  const bits = features.slice(0, 5).map((feature) => FEATURE_LABEL[feature]);
  if (fit) bits.push(`${fit} cut`);
  return bits.length ? ` | description states: ${bits.join(', ')}` : '';
}

/* ---------------- search_products ---------------- */

const FEATURES = Object.keys(FEATURE_LABEL) as Feature[];

/*
 * A search is a description, a product name, or both. The model asked "do
 * you have the Tour Championship Jacket?" by sending the name alone; with
 * query required, the call was refused, the catalogue check never ran, and
 * the Caddie hedged. A name on its own is searched as itself.
 */
const searchSchema = z
  .object({
    query: z.string().optional().describe('What the customer is looking for, in English'),
    colour: z.string().optional(),
    productName: z.string().optional(),
    /*
     * Any words: a proposal the resolver checks (searchIntent.ts). As an enum,
     * "relaxed" - a fit, not a feature - refused the whole call, and the
     * customer who asked for a relaxed-fit polo was shown nothing.
     */
    features: z.array(z.string()).optional(),
    limit: z.number().int().min(1).max(20).optional(),
    maxPrice: z.number().positive().optional(),
    category: z.string().optional(),
    range: z.enum(['mens', 'ladies', 'kids']).optional(),
    size: z.string().optional(),
  })
  .refine((args) => !!args.query?.trim() || !!args.productName?.trim(), {
    message: 'give query, productName, or both',
    path: ['query'],
  })
  .transform((args) => ({ ...args, query: args.query?.trim() || args.productName!.trim() }));

/** Within each match level, one of each preferred colour in turn; everything else keeps its order. */
function colourTurns<T extends { product: Product; matchLevel: string }>(
  entries: T[],
  colours: string[],
  groupOf: (entry: T) => string = (entry) => entry.matchLevel,
): T[] {
  const out: T[] = [];
  let start = 0;
  while (start < entries.length) {
    let end = start;
    while (end < entries.length && groupOf(entries[end]!) === groupOf(entries[start]!)) end += 1;
    const lanes = new Map<string, T[]>();
    for (const entry of entries.slice(start, end)) {
      const colour = colours.find((word) => matchesColourText(entry.product, word) > 0) ?? '';
      lanes.set(colour, [...(lanes.get(colour) ?? []), entry]);
    }
    const queues = [...lanes.values()];
    while (queues.some((queue) => queue.length)) for (const queue of queues) { const next = queue.shift(); if (next) out.push(next); }
    start = end;
  }
  return out;
}

/**
 * How firmly a colour binds this search.
 *
 * "I'd prefer navy" used to filter out every other colour as firmly as "only
 * navy", and a customer who said navy was a preference saw two polos instead
 * of the twelve that fitted everything else they had asked for. Their words
 * this turn decide; failing that, how they put it before; a colour named for
 * this request and nothing else is required for this request.
 */
function colourStrength(asked: string, turn: ReturnType<typeof readIntent>, ctx: ToolContext): 'required' | 'preferred' {
  const words = parseColours(asked).colours.map((colour) => colour.word);
  if (turn.colours?.words.some((word) => words.includes(word))) return turn.colours.strength;
  const standing = ctx.session.shopper?.colours;
  if (standing?.words.some((word) => words.includes(word))) return standing.strength;
  return 'required';
}

/** The ceiling a budget puts on one garment, if it puts one there at all. */
function priceCeiling(budget: Budget | undefined): number | undefined {
  if (!budget || budget.per !== 'item') return undefined;
  if (budget.kind === 'max') return budget.amount;
  // "Around £50" is not a ceiling at £50, but £90 is not around it either.
  if (budget.kind === 'around') return Math.round(budget.amount * 1.25);
  return undefined;
}

const searchTool = defineTool({
  name: 'search_products',
  description:
    'Search the live Druids store for products. Use this for any question about what is available, what something costs, or what is in stock. Never answer those from memory. ' +
    'Results come back ranked against everything the customer has told you (budget, size, fit, colours, weather, features), each marked exact, strong or partial with the verified reason - put the best one forward and say why in a few words. ' +
    'If the customer names a colour - in any language - pass it, in English, as `colour`. If they name a specific product ("the Tour Championship Jacket"), pass that name as `productName`: the whole catalogue is checked for it. Give `query`, `productName`, or both - a name alone is enough.',
  schema: searchSchema,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What the customer is looking for, in English, keeping every describing word ("plain", "lightweight", "rain top"). Optional when productName is given.' },
      colour: { type: 'string', description: 'The colour they asked for, in English: "blue", "navy", "light grey". Never leave out a colour they named. Colours they told you they usually wear are applied already - no need to repeat them here.' },
      productName: {
        type: 'string',
        description: 'Only when they name one specific product rather than a kind of thing: its name as they said it. The catalogue is checked for it, which is the only thing that lets you say we do or do not stock it.',
      },
      features: {
        type: 'array',
        items: { type: 'string', enum: FEATURES },
        description: 'What the garment must do, when they said so: ["waterproof"] for rain, ["warm"] for cold. Checked against each product description.',
      },
      limit: { type: 'integer', minimum: 1, maximum: 20 },
      maxPrice: { type: 'number', description: 'Upper price limit per item, if the customer gave a hard one' },
      category: { type: 'string', description: 'The kind of garment, when they named one: "polo", "jacket", "gilet", "midlayer", "hoodie", "trousers", "shorts", "cap"... Only that kind comes back.' },
      range: { type: 'string', enum: ['mens', 'ladies', 'kids'], description: 'Only when they said it: mens, ladies (womens) or kids.' },
      size: { type: 'string', description: 'The size they need, when they said one: "XL", "M", "2XL", a waist "34", a ladies "12". Only products in stock in that size come back, priced at that size.' },
    },
    // Either query or productName - enforced by the schema, which searches a name on its own as itself.
    required: [],
  },
  async run(args, ctx): Promise<ToolResult> {
    const turn = readIntent(ctx.utterance ?? '');
    const profile = ctx.session.shopper;
    const currency = ctx.session.preferences.currency ?? storeCurrency();

    /*
     * A piece of the pack on screen, changed: a swap inside the pack, not a
     * search of the store. "Change this trouser with a white trouser" came
     * back as three white trousers from the whole store, two of which the
     * pack does not take - and the customer then asked for one of those.
     */
    const packShown = packOnScreen(ctx);
    if (packShown && asksToChangePackPiece(packShown, ctx.utterance ?? '')) {
      const swapped = await dealAnswer({ query: ctx.session.lastShown?.query ?? packShown.title }, ctx, colourAsked(undefined, ctx.utterance), currency);
      if (swapped) return swapped;
    }
    /*
     * Asked about a piece while a pack is being built: that pack's own
     * choices, never the whole store. White trousers from everywhere put the
     * Premium Play Trousers next to the pack, and the customer took them for
     * a pack choice - they are not one.
     */
    const building = packShown ?? packChoicesInFocus(ctx);
    if (building) {
      const stepIndex = stepNamed(building, `${ctx.utterance ?? ''} ${args.query}`);
      const outside = /\b(separately|on its own|on their own|outside the pack|not in the pack|not for the pack|without the pack|full price)\b/i.test(ctx.utterance ?? '');
      if (stepIndex >= 0 && !outside) return packStepChoices(building, stepIndex, ctx, colourAsked(args.colour, ctx.utterance));
    }

    /*
     * What this request makes a rule - resolved from the customer's words,
     * what they told us and the search they are following up, never from the
     * model's arguments alone. See searchIntent.ts.
     */
    const intent = resolveSearchIntent(args, ctx, turn);
    const sizeProvenance = intent.sizeProvenance;
    if (sizeProvenance.ignoredModelSize) log.warn('search.size_not_given', { sessionId: ctx.session.id, ...sizeProvenance });
    log[intent.rejected.length ? 'warn' : 'info'](intent.rejected.length ? 'search.intent_rejected' : 'search.intent', {
      sessionId: ctx.session.id,
      ...intentDiagnostics(intent),
    });
    const size = intent.size?.value;
    const categories: Category[] = intent.categories?.value ?? [];
    const productName = intent.productName?.value;

    // Customer words into catalogue words: "rain top" is a jacket that has to be waterproof.
    const normal = normaliseQuery(intent.query);

    // Plain is the one thing read from their own words here - "swap this
    // orange polo for a plain white one" must not make orange the filter.
    const saidPlain = ctx.utterance ? parseColours(ctx.utterance).plain : false;
    const namedColour = intent.colour?.value;
    const asked = saidPlain && namedColour && !parseColours(namedColour).plain ? `plain ${namedColour}` : namedColour;
    /*
     * Required colours filter; preferred ones only rank. A standing "only
     * navy" carries into a search that names no colour; a standing "I like
     * navy" only moves navy up.
     */
    // A colour only the model gave, for words nobody could read, ranks - it never filters (see searchIntent.ts).
    const strength = asked ? (intent.colour?.strength === 'preference' ? 'preferred' : colourStrength(asked, turn, ctx)) : undefined;
    const standing = !asked && profile?.colours?.strength === 'required' ? profile.colours.words.join(' or ') : undefined;
    const filterColour = strength === 'preferred' ? (parseColours(asked!).plain ? 'plain' : undefined) : (asked ?? standing);
    const rankColour = asked
      ? { words: parseColours(asked).colours.map((colour) => colour.word), strength: strength! }
      : profile?.colours
        ? profile.colours
        : null;

    /*
     * The range they asked for, or the one we know they shop. Only a range
     * someone actually named is remembered: a woman who searched "navy polo"
     * and was shown mens ones has not told us she shops mens.
     */
    const askedRange = intent.range?.value;
    const rangeWord = askedRange && !parseRange(normal.query).range ? `${askedRange === 'women' ? 'ladies' : askedRange} ` : '';
    const words = parseColours(normal.query).rest;
    const query = `${rangeWord}${filterColour ? `${filterColour} ${words}` : strength === 'preferred' ? words : normal.query}`.trim();
    const known = knownRange(ctx);

    const request = rankRequestFor(ctx.session, turn, {
      features: intent.features.value,
      colour: rankColour,
      currency,
    });
    // The size asked for now is the size ranked on, over the one in their profile.
    if (size) request.size = size;
    const ceiling = intent.maxPrice?.value ?? priceCeiling(request.budget);
    // Features this request needs - not ones remembered from an earlier search.
    const mustDo = [...new Set([...intent.features.value, ...(turn.features?.required ?? [])])];
    /*
     * The day this request describes, from this turn only: "for warm weather",
     * "somewhere hot", or asking for what heat needs. Lightweight alone is not
     * heat - there are lightweight midlayers for a cool evening.
     */
    const askedNow = [...mustDo, ...(turn.features?.preferred ?? [])];
    const climate: Climate | undefined = weatherHotOnly(turn.weather)
      ? 'hot'
      : turn.weather?.includes('cold') || askedNow.includes('warm')
        ? 'cold'
        : askedNow.some((feature) => feature === 'breathable' || feature === 'moisture-wicking' || feature === 'uv-protection')
          ? 'hot'
          : undefined;
    // "Top" with no kind named: the kinds that suit that day, preferred - see topKindsFor.
    const topKinds = topKindsFor(`${intent.query} ${ctx.utterance ?? ''}`, climate, categories);
    if (topKinds.length) request.kinds = topKinds;
    const rules = {
      ...(size ? { size } : {}),
      ...(categories.length ? { categories } : {}),
      ...(askedRange ? { range: askedRange } : {}),
    };
    const limit = args.limit ?? 6;
    // Ranking needs room to choose: fetch wide, then keep the best.
    const ranking = hasSignals(request);
    /*
     * "Another one": what this run of searches has already shown goes behind
     * what it has not. The Caddie answered "do you have another one?" with the
     * polo it had just recommended. Fetched wide, so there is something new to
     * show; when everything good has been seen, the seen ones come back.
     */
    const wantsAnother = ANOTHER.test(ctx.utterance ?? '');
    const seen = new Set(wantsAnother ? [...(ctx.session.recentShown ?? []), ...(ctx.session.lastShown?.items.map((item) => item.id) ?? [])] : []);
    const wide = await searchProducts({
      query,
      limit: ranking || wantsAnother ? Math.max(limit * 4, 24) : limit,
      ...(ceiling !== undefined ? { maxPrice: ceiling } : {}),
      ...(known ? { known } : {}),
      ...rules,
    });
    /*
     * A preferred colour is looked for, not just waited for. The store has
     * hundreds of polos; the top two dozen by relevance held no navy, and a
     * customer who said "I'd prefer navy" was told there was none. The
     * colour's own results go into the pool first, then everything else.
     */
    const preferredWords = rankColour?.strength === 'preferred' ? rankColour.words.join(' or ') : '';
    // Each preferred colour looked for on its own, taking turns: "navy or black" together came back navy first and navy only.
    const inColour = preferredWords
      ? takeTurns(
          await Promise.all(
            rankColour!.words.map((colour) =>
              searchProducts({
                query: `${rangeWord}${colour} ${words}`.trim(),
                limit: limit * 2,
                ...(ceiling !== undefined ? { maxPrice: ceiling } : {}),
                ...(known ? { known } : {}),
                ...rules,
              }),
            ),
          ),
        )
      : [];
    /*
     * A feature they need is looked for across the whole range, not just the
     * first page. "Waterproof trousers" searched as "trousers" found two dozen
     * joggers, none waterproof, and the Caddie said Druids had none - while
     * INFINITE RAIN TROUSERS, which says waterproof in its description, sat
     * further down the list. Every garment the words match is checked for it.
     */
    const needed = request.features?.required ?? [];
    const withFeature = needed.length
      ? (
          await searchProducts({
            query,
            limit: 400,
            ...(ceiling !== undefined ? { maxPrice: ceiling } : {}),
            ...(known ? { known } : {}),
            ...rules,
          })
        ).filter((product) => needed.every((feature) => hasFeature(product, feature)))
      : [];
    /*
     * The kinds a top means today, looked for by name, each on its own:
     * "top" itself only ever found "layering top" midlayers, and "polo dress"
     * searched together found only polo dresses.
     */
    const inKind = (
      await Promise.all(
        topKinds.map((kind) =>
          searchProducts({
            query: TOP_WORD.test(query) ? query.replace(new RegExp(TOP_WORD.source, 'gi'), kind) : `${query} ${kind}`,
            limit: limit * 2,
            ...(ceiling !== undefined ? { maxPrice: ceiling } : {}),
            ...(known ? { known } : {}),
            ...rules,
            categories: [kind],
          }),
        ),
      )
    ).flat();
    const found = [...withFeature, ...inColour, ...inKind, ...wide].filter(
      (product, index, all) => all.findIndex((other) => other.id === product.id) === index,
    );

    /*
     * A product they named, checked against the whole catalogue - the one
     * thing that can say "we do not stock that" truthfully. A colour or range
     * the model passed on its own is part of the name: "Apex polo" with colour
     * black is the black Apex polo, which Druids do not sell.
     */
    const nameRange = askedRange ?? (productName ? parseRange(productName).range : null);
    const nameAsked = productName
      ? [
          productName,
          filterColour && !parseColours(productName).colours.length ? filterColour : '',
          askedRange && !parseRange(productName).range ? (askedRange === 'women' ? 'ladies' : askedRange) : '',
        ]
          .filter(Boolean)
          .join(' ')
      : '';
    /*
     * A name in the searched words the model did not flag (Task 9) speaks for
     * the customer only if they said it: "we don't stock the X" is never said
     * about a name nobody gave.
     */
    const unflagged = productName ? null : unknownNameIn(intent.query);
    const existence = productName ? lookupProductName(nameAsked) : unflagged && intent.namedByCustomer(unflagged.name) ? unflagged : null;
    /*
     * Every rule this request set, checked on every product - the named ones
     * too. The ladies Apex polo in blush once led a search for a black Apex
     * polo, and "navy polo in XL" was answered with polos sold out in XL.
     * What fails a rule is not shown, however well it scores.
     */
    const wantedColour = filterColour ? parseColours(filterColour) : null;
    const failures = (product: Product): string[] => {
      const out: string[] = [];
      if (!product.variants.some((variant) => variant.available)) out.push('sold out');
      if (!inRange(product, nameRange, known)) out.push('not in that range');
      if (wantedColour && (wantedColour.colours.length || wantedColour.plain) && colourMatch(product, wantedColour.colours, true, wantedColour.plain) === 0) {
        out.push(`not ${filterColour}`);
      }
      if (categories.length && !isCategory(product, categories)) out.push(`not a ${categories.join(' or ')}`);
      if (size) {
        const status = sizeStatus(product, size);
        if (status === 'sold-out') out.push(`sold out in ${size}`);
        else if (status !== 'in-stock') out.push(`not made in ${size}`);
      }
      if (ceiling !== undefined && priceFor(product, size).amount > ceiling) out.push(`over ${money(ceiling, currency)}${size ? ` in ${size}` : ''}`);
      for (const feature of mustDo) if (!hasFeature(product, feature)) out.push(`${FEATURE_LABEL[feature]} not stated in its description`);
      return out;
    };
    const meetsRules = (product: Product) => failures(product).length === 0;
    const named =
      existence?.kind === 'exact-product'
        ? [existence.product].filter(meetsRules)
        : existence?.kind === 'exact-family'
          ? existence.products.filter(meetsRules)
          : [];
    // The product they named, when it is not what they asked for: said, never shown as if it were.
    const namedMisses =
      existence?.kind === 'exact-product' && !named.length ? `${existence.product.title} is the product they named, but it is ${failures(existence.product).join(', ')}.` : '';
    /*
     * A name that could be more than one product. "Show me the Hexi polo" was
     * told no single product could be confirmed - Hexie or Hexa - while the
     * cards showed the best-selling Elite and Honeycomb polos, because the
     * candidates lived only in the facts. They are the cards now: every
     * colourway of each candidate design, held to the same rules as anything
     * else, designs taking turns. If none of them meets the rules ("black Apex
     * polo" - the only Apex is blush), the cards are the search as before.
     */
    const possible = existence?.kind === 'possible-match' ? possibleCards(existence.products).filter(meetsRules) : [];
    /*
     * "Cheapest" and "cheaper", computed rather than read off the cards.
     * Asked for the cheapest rainy jacket, the Caddie named a £35 jacket one
     * time and an £80 one the next, while a £16 waterproof jacket sat outside
     * the two dozen products relevance had fetched. So a price question
     * searches everything in scope - the kind asked for, or for "cheaper" the
     * kind of the product being compared with - applies every rule first, and
     * only then orders by the price they would pay, in their size if we know
     * it. The facts carry the proof, so the reply never has to guess.
     */
    let priceNote = '';
    async function priceOrder(): Promise<
      { mode: 'minimum' | 'below'; products: Product[]; facts: string; speech: string } | { answer: ToolResult } | null
    > {
      const price = intent.price!;
      const reference = price.mode === 'below' ? price.reference : undefined;
      if (price.mode === 'below' && !reference) {
        priceNote = 'They asked for something cheaper, but no product is in focus to compare with. Call nothing cheaper - ask which one they mean.';
        return null;
      }
      const compared = reference ? productById(reference.id) : null;
      const scope: Category[] = categories.length ? categories : compared ? [...categoriesOf(compared)] : [];
      const pool = named.length
        ? named
        : await searchProducts({
            query: scope.length ? scope.join(' ') : query,
            limit: 5000,
            ...(ceiling !== undefined ? { maxPrice: ceiling } : {}),
            ...(known ? { known } : {}),
            ...rules,
            ...(scope.length ? { categories: scope } : {}),
          });
      // What their weather needs is part of the rule for a price question: the cheapest "rainy jacket" keeps rain out.
      const needs = [...new Set(intent.weather.flatMap((kind) => WEATHER_NEEDS[kind]))];
      const pence = (product: Product) => Math.round(priceFor(product, size).amount * 100);
      const pounds = (product: Product) => money(priceFor(product, size).amount, currency);
      const eligible = pool.filter(
        (product) => meetsRules(product) && (!scope.length || isCategory(product, scope)) && (!needs.length || needs.some((feature) => hasFeature(product, feature))),
      );
      const needsNote = needs.length ? `, ${needs.map((feature) => FEATURE_LABEL[feature]).join(' or ')} as their weather needs` : '';
      const sizeNote = size ? `, priced in ${size}` : '';

      if (price.mode === 'minimum') {
        if (!eligible.length) {
          priceNote = 'Nothing meets everything they asked for, so there is no cheapest to name. Call none of these the cheapest.';
          return null;
        }
        const order = eligible.map((product, index) => ({ product, index })).sort((a, b) => pence(a.product) - pence(b.product) || a.index - b.index);
        const products = order.map((entry) => entry.product);
        const lowest = products[0]!;
        const joint = products.filter((product) => pence(product) === pence(lowest));
        return {
          mode: 'minimum',
          products,
          facts:
            `Price ordering: sorted by price, lowest first, across all ${eligible.length} products that meet what they asked for${needsNote}${sizeNote}. ` +
            (joint.length > 1
              ? `Joint lowest at ${pounds(lowest)}: ${joint.map((product) => `${product.title} [${product.id}]`).join(', ')} - you may call these the cheapest.`
              : `The lowest-priced is ${lowest.title} [${lowest.id}] at ${pounds(lowest)} - you may call it the cheapest.`),
          speech: `The cheapest that fits is the ${titleCaseWords(lowest.title)} at ${pounds(lowest)}. The rest are on screen, lowest price first.`,
        };
      }

      const ref = reference!;
      const limitPence = Math.round(ref.price * 100);
      const refPounds = money(ref.price, currency);
      // Strictly below: the same price is not cheaper.
      const cheaper = eligible.filter((product) => product.id !== ref.id && pence(product) < limitPence);
      if (!cheaper.length) {
        return {
          answer: {
            speech: `I couldn't find anything cheaper than the ${titleCaseWords(ref.title)} at ${refPounds} that still fits what you asked for.`,
            facts: `Price comparison: compared with ${ref.title} [${ref.id}] at ${refPounds}${sizeNote}. Nothing that meets their requirements${needsNote} costs less. Say so plainly, and never offer anything at ${refPounds} or more as cheaper.`,
          },
        };
      }
      const products = ranking ? rankProducts(cheaper, request).map((entry) => entry.product) : cheaper;
      const shown = products.slice(0, limit);
      return {
        mode: 'below',
        products,
        facts:
          `Price comparison: compared with ${ref.title} [${ref.id}] at ${refPounds}${sizeNote}. Only products below ${refPounds} are shown - ${cheaper.length} qualify:\n` +
          shown.map((product) => `- ${product.title} [${product.id}]: ${pounds(product)}, ${money((limitPence - pence(product)) / 100, currency)} cheaper`).join('\n') +
          `\nNever call anything at ${refPounds} or more cheaper.`,
        speech: `Here ${shown.length === 1 ? 'is one option' : `are ${shown.length} options`} cheaper than the ${titleCaseWords(ref.title)} at ${refPounds}. They are on screen now.`,
      };
    }
    const priced = intent.price && !possible.length ? await priceOrder() : null;
    if (priced && 'answer' in priced) return priced.answer;
    let candidates = found.filter((product) => !named.some((n) => n.id === product.id) && meetsRules(product));
    /*
     * Meaning search, only when the request describes what it wants ("a
     * sleeveless warm outer layer", "something for hot weather") and names
     * nothing. It adds candidates; each one passes the same rules as a word
     * match, and a named product stays ahead of all of them. If it cannot run
     * - not built, not configured, the call failed - this is word search
     * exactly as it was, and the customer never hears about it.
     */
    const identified = existence?.kind === 'exact-product' || existence?.kind === 'exact-family' || !!productName;
    // The model's query and the customer's own words together: a shortened query cannot lose the heat, the rain or the sleeves.
    // Required features, and the model's unverified ones as hints: meaning search is told of both, nothing requires the hints.
    const described_features = [...intent.features.value, ...intent.hints.features];
    const features = described_features.length ? { features: described_features } : {};
    const described = descriptiveSearchText({ query: intent.query, ...(ctx.utterance ? { utterance: ctx.utterance } : {}), ...features });
    const need = wantsSemantic(described, { named: identified, ...features });
    const diagnostics: HybridDiagnostics = {
      semanticUsed: false,
      why: need.why,
      described,
      size: sizeProvenance,
      lexical: found.length,
      semanticScanned: 0,
      semanticDesigns: 0,
      merged: candidates.length,
      afterRules: candidates.length,
    };
    let hybridEvidence: Map<string, CandidateEvidence> | null = null;
    if (need.use) {
      const semantic = await semanticDesigns(described);
      if (semantic.available && semantic.designs.length) {
        const hits = new Map(
          searchLocalScored({
            query,
            limit: 400,
            ...(ceiling !== undefined ? { maxPrice: ceiling } : {}),
            ...(known ? { known } : {}),
            ...rules,
          }).map((hit) => [hit.product.id, hit]),
        );
        const merged = mergeCandidates(
          candidates.filter((product) => !named.some((n) => n.id === product.id)),
          hits,
          semantic.designs,
          (members) => members.find((member) => meetsRules(member) && !named.some((n) => n.id === member.id)),
          { categories, conceptKinds: [...conceptKindsInQuery(described), ...topKinds] },
        );
        candidates = merged.ordered.filter(meetsRules);
        hybridEvidence = merged.evidence;
        Object.assign(diagnostics, {
          semanticUsed: true,
          semanticScanned: semantic.scanned,
          semanticDesigns: semantic.designs.length,
          merged: merged.ordered.length,
          afterRules: candidates.length,
          cache: semantic.cached ? 'hit' : 'miss',
        });
      } else {
        diagnostics.fallback = semantic.reason ?? 'no semantic candidates';
      }
    }
    recordHybridDiagnostics(diagnostics);
    log.info('search.hybrid', { sessionId: ctx.session.id, ...diagnostics });
    const pool = [...named, ...possible, ...candidates.filter((product) => !possible.some((p) => p.id === product.id))];

    const ranked = ranking ? rankProducts(pool, request) : [];
    /*
     * Never an exact match beside something that fails what they asked for:
     * partial matches only appear when nothing better exists, and then the
     * facts say so.
     */
    const good = ranked.filter((entry) => entry.matchLevel !== 'partial');
    const kept = ranking ? (good.length ? good : ranked.filter((e) => !e.missedRequirements.includes('turned down earlier'))) : [];
    /*
     * A descriptive search that used meaning search is ordered by how strong
     * its evidence is, within each match level - see orderHybrid. Named
     * products stay in front; precise searches are untouched.
     */
    const poolPosition = new Map(pool.map((product, index) => [product.id, index]));
    const hybridOrder = {
      rangeAsked: !!askedRange || !!known,
      broad: categories.length === 0 && !identified,
      positionOf: (id: string) => poolPosition.get(id) ?? 0,
    };
    const ordered = hybridEvidence ? orderHybrid(kept, hybridEvidence, hybridOrder) : kept;
    /*
     * Several colours they like equally ("navy or black"): among results that
     * match equally well, the colours take turns. Without this, whichever
     * colour the search happened to reach first filled the screen, and three
     * turns running showed navy alone to someone who wears black as often.
     */
    // Unseen first, then the colours take turns within what is unseen - the other way round, "another one" came back all navy.
    const unseenOrder = seen.size ? unseenFirst(ordered, (entry) => entry.product.id, (entry) => entry.matchLevel, seen) : ordered;
    const shownRanked =
      rankColour?.strength === 'preferred' && rankColour.words.length > 1
        ? colourTurns(unseenOrder, rankColour.words, (entry) => `${entry.matchLevel}|${seen.has(entry.product.id)}`)
        : unseenOrder;
    if (hybridEvidence) {
      diagnostics.top = shownRanked.slice(0, 8).map((entry) => ({
        title: entry.product.title,
        band: hybridEvidence!.get(entry.product.id)?.band ?? 0,
        rankScore: entry.score,
        merged: Math.round((hybridEvidence!.get(entry.product.id)?.score ?? 0) * 100) / 100,
        matchLevel: entry.matchLevel,
      }));
    }
    const unrankedOrder = hybridEvidence
      ? orderHybrid(pool.map((product) => ({ product, matchLevel: 'exact', score: 0 })), hybridEvidence, hybridOrder).map((entry) => entry.product)
      : pool;
    const unranked = seen.size ? unseenFirst(unrankedOrder, (product) => product.id, () => '', seen) : unrankedOrder;
    const searched = ranking
      ? [...named.filter((n) => !shownRanked.some((e) => e.product.id === n.id)), ...shownRanked.map((entry) => entry.product)].slice(0, limit)
      : [...named, ...unranked.filter((product) => !named.some((n) => n.id === product.id))].slice(0, limit);
    // The possible matches, when there are any that fit, are what is on screen - never unrelated products beside them.
    const entryOf = new Map(shownRanked.map((entry) => [entry.product.id, entry]));
    /*
     * Which card leads - the one the Caddie recommends. Named products and
     * possible matches keep their place; otherwise, among the cards that fit
     * equally well, the lead is the one that best suits what the customer has
     * told us: a cut its description states that matches the fit they prefer
     * (a regular-cut polo led for "I prefer a relaxed fit"), something not yet
     * shown when they asked for another, and not the same product or colour
     * as last time when they like several colours equally.
     */
    // Chosen from everything that fits as well as the first card, not only the first six: the relaxed polos sat seventh and eighth.
    const leadPool = ranking ? [...searched, ...shownRanked.map((entry) => entry.product).filter((product) => !searched.includes(product))] : searched;
    const chosenLead = leadFirst(leadPool, {
      levelOf: (product) => entryOf.get(product.id)?.matchLevel ?? '',
      seen,
      ...(request.fit ? { fit: request.fit } : {}),
      colours: rankColour?.strength === 'preferred' && rankColour.words.length > 1 ? rankColour.words : [],
      ...(ctx.session.lastLead ? { lastLead: ctx.session.lastLead } : {}),
    })[0];
    const products = priced
      ? priced.products.slice(0, limit)
      : possible.length
      ? possible.slice(0, limit)
      : named.length || !chosenLead
        ? searched
        : [chosenLead, ...searched.filter((product) => product !== chosenLead)].slice(0, limit);
    const onlyPartial = !priced && !possible.length && ranking && good.length === 0 && shownRanked.length > 0;
    const lead = possible.length ? undefined : products[0];

    await sessions.patch(ctx.session.id, {
      lastShown: {
        kind: 'products',
        items: products.map((p) => ({ id: p.id, title: p.title })),
        query,
        ...(filterColour ? { colour: filterColour } : {}),
      },
      lastSearch: { categories, ...(askedRange ? { range: askedRange } : {}), ...(intent.colour ? { colour: intent.colour.value } : {}) },
      recentShown: [...new Set([...(wantsAnother ? (ctx.session.recentShown ?? []) : []), ...products.map((p) => p.id)])].slice(-40),
      ...(lead ? { lastLead: { id: lead.id, colour: colourwayName(lead.title).toLowerCase() } } : {}),
      ...(askedRange === 'men' || askedRange === 'women' ? { preferences: { audience: askedRange } } : {}),
    });

    // Cards that are not the possible matches the facts name would be the Hexi polo again: log it rather than let it pass unseen.
    if (existence?.kind === 'possible-match' && existence.products.length && !possible.length && products.length) {
      log.warn('search.possible_match_unshown', { name: existence.name, candidates: existence.products.map((p) => p.title), shown: products.map((p) => p.title) });
    }
    // The possible matches named in the facts are the cards on screen, so the words and the screen agree.
    const existenceFacts = existence
      ? possible.length && existence.kind === 'possible-match'
        ? `${catalogueCheck({ ...existence, products })} These possible matches are the cards on screen - ask which one they meant.`
        : catalogueCheck(existence)
      : '';
    /*
     * Why each result is here, as checked - only for what was asked. The model
     * should never have to guess whether the navy polo it is about to offer
     * comes in XL.
     */
    const namedWords = nameWords(productName ?? intent.query);
    const evidence = (product: Product): string => {
      const bits: string[] = [];
      // The design they named, exactly: "Elite Polo" is the Elite Polo, not a polo that shares a word.
      const design = identityOf(product).designWords;
      if (namedWords.length && design.length === namedWords.length && namedWords.every((word) => design.includes(word))) {
        bits.push(`the design they named: ${titleCaseWords(product.title.split(' - ')[0]!)}`);
      }
      if (categories.length) bits.push([...categoriesOf(product)].filter((kind) => categories.includes(kind)).join('/') || categories[0]!);
      if (filterColour && wantedColour?.colours.length) bits.push(colourwayName(product.title).toLowerCase() || filterColour);
      if (size) bits.push(`${size} in stock at ${money(priceFor(product, size).amount, currency)}`);
      if (ceiling !== undefined) bits.push(`within ${money(ceiling, currency)}`);
      for (const feature of mustDo) bits.push(FEATURE_LABEL[feature]);
      // They care about fit, and this one's description states none: say so, rather than leave it to be guessed.
      if (request.fit && !attributesOf(product).fit) bits.push('fit not stated');
      return bits.join(', ');
    };

    if (products.length === 0 && size) {
      /*
       * Nothing in their size. Said as that - never "we have nothing" - with
       * what the same search holds in other sizes, so every size named is real.
       */
      const anySize = await searchProducts({
        query,
        limit: 12,
        ...(ceiling !== undefined ? { maxPrice: ceiling } : {}),
        ...(known ? { known } : {}),
        ...(categories.length ? { categories } : {}),
        ...(askedRange ? { range: askedRange } : {}),
      });
      const others = anySize.filter((product) => failures(product).every((failure) => failure.includes(size)));
      if (others.length) {
        const sizesOf = (product: Product) =>
          [...new Set(product.variants.filter((variant) => variant.available).flatMap((variant) => Object.values(variant.options)))].join(', ');
        return {
          speech: `None of those are in stock in ${size} right now.`,
          facts:
            `Nothing matching is in stock in ${size}. The same search in other sizes:\n${others
              .slice(0, 5)
              .map((product) => `- ${product.title} [${product.id}]: in stock in ${sizesOf(product)}`)
              .join('\n')}\nSay plainly that it is not in ${size}; offer another size or something else. Never show these as available in ${size}.${
              existenceFacts ? `\n${existenceFacts}` : ''
            }${namedMisses ? `\n${namedMisses}` : ''}`,
        };
      }
    }

    if (products.length === 0) {
      /*
       * Nothing in that colour. Say so plainly and offer the colours it does
       * come in - read from the same garments without the colour, so every
       * one named is real and in stock.
       */
      const { colours, rest, plain } = parseColours(query);
      if ((colours.length || plain) && rest.trim()) {
        const others = coloursOffered(await searchProducts({ query: rest, limit: 20 }));
        const wanted = `${plain ? 'plain ' : ''}${colours.map((colour) => colour.word).join(' or ') || 'one colour'}`;
        if (others.length) {
          return {
            speech: `We do not have ${rest.trim()} in ${wanted}. It does come in ${others.slice(0, 6).join(', ')}.`,
            facts: `No ${rest.trim()} in ${wanted}. Colourways in stock: ${others.join(', ')}. Do not offer any of these as ${wanted}.`,
          };
        }
      }
      if (ceiling !== undefined) {
        return {
          speech: `I could not find anything for "${query}" at ${money(ceiling, currency)} or under.`,
          facts: `Nothing matched under the ${money(ceiling, currency)} limit. Do not show or suggest anything over it unless they agree to spend more.${existenceFacts ? `\n${existenceFacts}` : ''}`,
        };
      }
      return { speech: `I could not find anything for "${query}" in the store right now.`, ...(existenceFacts ? { facts: existenceFacts } : {}) };
    }

    // Never "lead with" one of several possible matches: which one they meant is theirs to say.
    // A price question leads with what the price order says; relevance's own pick would contradict it.
    const top = lead && !priced ? entryOf.get(lead.id) : undefined;
    // The level is for the model to weigh, never a phrase to repeat: "an exact match for your request" is not how a salesperson talks.
    const pickLine =
      top && !onlyPartial && top.reason
        ? `\nLead with: ${top.product.title} [${top.product.id}] - it fits because: ${top.reason}.${
            top.missedPreferences.length ? ` It differs on: ${top.missedPreferences.join('; ')} - say so.` : ''
          }`
        : '';
    /*
     * One next step, decided from what is known. A trusted size it is in
     * stock in, on a product that is not in doubt: offer the basket. No size
     * yet: ask for it. Neither while they are choosing between names.
     */
    const buyingSize = size ?? request.size;
    const leadSized = !!lead && (lead.options.find((option) => /size/i.test(option.name))?.values.length ?? 0) > 1;
    const nextStep =
      !lead || onlyPartial || !leadSized || (categories.length === 0 && !identified && !topKinds.length)
        ? ''
        : buyingSize && sizeStatus(lead, buyingSize) === 'in-stock'
          ? `Next step: the ${lead.title} is in stock in ${buyingSize} at ${money(priceFor(lead, buyingSize).amount, currency)} - offer to add it to their basket in ${buyingSize}. Only add it once they say yes.`
          : !buyingSize
            ? 'Next step: their size is not known - ask for it, rather than offering the basket.'
            : '';
    const partialLine = onlyPartial
      ? `\nNothing meets everything they asked for. These are the closest, and each fails something (below) - say plainly what is missing, never present them as what they asked for.`
      : '';

    /*
     * Worded as "closest" on purpose: the search is by words and always
     * returns its best guesses, and "I found 4 options" invites the model to
     * present them as the thing that was asked for.
     */
    // With a pack on screen, which of these can go in it - the rest are full price, bought on their own.
    const inPack = packShown ? products.filter((product) => packShown.steps.some((step) => step.productIds.has(product.id))) : [];
    const packNote = packShown
      ? `The ${packShown.title} was on screen. ${
          inPack.length ? `Of these results only ${inPack.map((p) => p.title).join(', ')} can go in it.` : 'None of these results can go in it.'
        } The others are bought separately at full price - say so, and never offer to put them in the pack.`
      : '';
    const packSpeech =
      packShown && inPack.length < products.length
        ? inPack.length
          ? ` Only the ${inPack.map((p) => titleCaseWords(p.title)).join(' and the ')} can go in the pack - the others would be bought separately.`
          : ' None of these are part of the pack - they would be bought separately.'
        : '';
    return {
      // A proven absence leads: "closest matches" first made the model hedge and ask the customer to confirm the name.
      speech: `${priced
        ? priced.speech
        : possible.length
        ? `I couldn't confirm a single product called the ${(productName ?? existence?.name ?? query).replace(/^(the|a|an)\s+/i, '')}. These are the closest named matches, on screen now.`
        : existence?.kind === 'not-found'
        ? `We do not stock the ${(productName ?? existence.name).replace(/^(the|a|an)\s+/i, '')}. The closest options are on screen now.`
        : onlyPartial
        ? `I could not find anything that meets everything you asked for - these are the closest. They are on screen now.`
        : products.length === 1
          ? 'Here is the closest match in the store. It is on screen now.'
          : `Here are the ${products.length} closest matches in the store. They are on screen now.`}${packSpeech}`,
      facts: [
        packNote,
        `Results for "${query}", ${priced?.mode === 'minimum' ? 'lowest price first' : 'best match first'}:\n${listFacts(products, evidence)}`,
        priced?.facts ?? priceNote,
        normal.mapped.length ? `Searched in catalogue terms: ${normal.mapped.join('; ')}.` : '',
        topKinds.length
          ? `"Top" read as ${topKinds.join(' or ')} for ${climate} weather - a preference, not a rule: other kinds can still show, below these.`
          : '',
        filterColour && strength !== 'preferred'
          ? `Every result is in ${filterColour} or a shade of it - the colour is in each name. Say which shade when it is not the exact word they used (navy for blue, teal for blue or green).`
          : strength === 'preferred'
            ? `${asked} is a preference, not a rule: those colours are ranked first, others can still show.`
            : '',
        ranking ? `How each fits what they asked for:\n${rankFacts(shownRanked.filter((e) => products.includes(e.product)))}${pickLine}${partialLine}` : '',
        nextStep,
        existenceFacts,
        namedMisses,
      ]
        .filter(Boolean)
        .join('\n'),
      attachment: { kind: 'products', products },
    };
  },
});

/* ---------------- get_product_details ---------------- */

const detailsSchema = z.object({
  productId: z.string().min(1),
  options: z.record(z.string()).optional().describe('Chosen variant options, e.g. { "Size": "M" }'),
});

const detailsTool = defineTool({
  name: 'get_product_details',
  description:
    'Get full details and variants for one product. Always call this before adding anything to the cart, so you are adding a variant that really exists and is in stock.',
  schema: detailsSchema,
  parameters: {
    type: 'object',
    properties: {
      productId: { type: 'string' },
      options: { type: 'object', additionalProperties: { type: 'string' } },
    },
    required: ['productId'],
  },
  async run(args, ctx): Promise<ToolResult> {
    const picked = await pickFromPackChoices(ctx);
    if (picked) return picked;
    let product = await getProductDetails(args.productId, args.options);
    // "The second one", "the navy one": what they can see, not an id to guess.
    if (!product && !/^(gid:\/\/|\d+$)/.test(args.productId.trim())) {
      const seen = resolveProduct(ctx.session, args.productId);
      if (seen) product = await getProductDetails(seen.product.id, args.options);
    }
    if (!product) {
      /*
       * A name, not an id, that matched nothing. The model reaches for this
       * tool with "Druids Tour Championship Jacket" as often as it searches,
       * and "I could not load that product" left it asking the customer to
       * confirm the name. The same whole-catalogue check as search answers it.
       */
      const named = /^(gid:\/\/|\d+$)/.test(args.productId.trim()) ? null : lookupProductName(args.productId);
      // One product by that name and colour: that is the one they mean.
      if (named?.kind === 'exact-product') product = await getProductDetails(named.product.id, args.options);
      if (!product && named?.kind === 'not-found') {
        const name = args.productId.replace(/^(the|a|an)\s+/i, '');
        return {
          speech: `We do not stock the ${name}.`,
          facts: `Catalogue check: nothing in the Druids catalogue is called "${name}" - every product was checked. Say we don't stock it, then offer to show the closest with search_products.${
            named.closest.length ? ` Closest names: ${named.closest.map((p) => `${p.title} [${p.id}]`).join(', ')} - alternatives, never it.` : ''
          }`,
        };
      }
      if (!product && (named?.kind === 'exact-family' || named?.kind === 'possible-match')) {
        return {
          speech: named.kind === 'exact-family' ? 'That comes in a few colours - which one would you like?' : "I couldn't find that exact product.",
          facts: `${catalogueCheck(named)} Call get_product_details with one of these ids once you know which.`,
        };
      }
      if (!product) return { speech: 'I could not load that product.' };
    }

    /*
     * What it is like, as Druids describe it - the only product claims the
     * Caddie may make beyond name, price and stock.
     */
    const attributes = attributesOf(product);
    // Now the one being talked about: "is it in XL?" next means this product.
    await sessions.patch(ctx.session.id, { focusProductId: product.id });
    const verified = [
      attributes.features.length ? `Its description states: ${attributes.features.map((f) => FEATURE_LABEL[f]).join(', ')}.` : 'Its description states no technical features - do not claim any.',
      attributes.fit ? `Cut: ${attributes.fit}.` : ctx.session.shopper?.fit ? 'Cut: not stated in its description - never describe its fit.' : '',
      attributes.materials.length ? `Fabric: ${attributes.materials.join(', ')}.` : '',
      // Every size and colour, in stock or not, from the full product - a narrowed lookup holds one variant.
      `Stock: ${describeStock(productById(product.id) ?? product)}`,
    ]
      .filter(Boolean)
      .join(' ');
    const next = await nextStep([product], {
      profile: ctx.session.shopper,
      basketProductIds: (ctx.session.basket ?? []).map((line) => line.productId),
    });

    /*
     * Shopify returns a default variant even when nothing was selected, so the
     * variant count says nothing about whether the customer has chosen. What
     * counts is whether WE passed a selection - or whether there was anything
     * to choose in the first place.
     */
    const nothingToChoose = product.options.every((option) => option.values.length <= 1);
    const hasSelection = Boolean(args.options && Object.keys(args.options).length > 0);
    const chosen = hasSelection || nothingToChoose ? product.variants[0] : null;

    if (chosen) {
      // The variant's own price, not the product's cheapest - they differ on
      // anything priced by size, and this one is a specific garment.
      const chosenPrice = money(chosen.price.amount, chosen.price.currency);
      return {
        speech: chosen.available
          ? `${product.title} in ${Object.values(chosen.options).join(', ')} is ${chosenPrice} and in stock.`
          : `${product.title} in ${Object.values(chosen.options).join(', ')} is out of stock.`,
        facts: [verified, next?.line ?? ''].filter(Boolean).join('\n'),
        attachment: { kind: 'products', products: [product] },
      };
    }

    /*
     * Nothing chosen yet, so there may be no single price to give.
     *
     * product.price is Shopify's cheapest variant. Reading it out as "it
     * costs £42" on a polo that runs £42 to £52 by size is the same fault the
     * packs had, in the path customers hit most: asking what something costs.
     */
    const effective = priceFor(product);
    const price = money(effective.amount, effective.currency);
    const choices = product.options.map((option) => `${option.name}: ${option.values.join(', ')}`).join('. ');

    // "Does this come in navy?" - the other colourways are other products.
    const others = otherColourways(product);
    const colours = others.length
      ? `Also comes in: ${others.map((other) => `${colourwayName(other.title)} [${other.id}]`).join(', ')}. To show them, call other_colours.`
      : 'This is the only colourway in stock.';

    return {
      speech: effective.exact
        ? `${product.title} is ${price}.${choices ? ` ${choices}.` : ''}`
        : `${product.title} starts at ${price} and the price depends on the size.${choices ? ` ${choices}.` : ''}`,
      facts: [
        effective.exact ? '' : `${product.title} is priced per variant, from ${price}. Do not quote a single price until a size is chosen.`,
        colours,
        verified,
        next?.line ?? '',
      ]
        .filter(Boolean)
        .join('\n'),
      attachment: { kind: 'products', products: [product] },
    };
  },
});

/* ---------------- find_my_size ---------------- */

/** A height in their own words: "5'10", "six foot", "178cm", "1.8m", "I'm tall". */
const HEIGHT_SAID = /\b(tall|height|foot|feet|ft)\b|\d\s*['’]|\b\d{3}\s*cm\b|\b[12]\.\d{1,2}\s*m\b/i;

const sizeSchema = z.object({
  heightValue: z.number().positive().optional(),
  heightUnit: z.enum(['cm', 'in']).optional(),
  weightValue: z.number().positive().optional(),
  weightUnit: z.enum(['kg', 'lb']).optional(),
  usualSize: z.string().optional(),
  chestCm: z.number().positive().optional(),
  waistCm: z.number().positive().optional(),
  fitPreference: z.enum(['tight', 'regular', 'relaxed']).optional(),
  layering: z.boolean().optional(),
  audience: z.enum(['men', 'women']).optional(),
  category: z.string().optional(),
  productId: z.string().optional(),
});

const CONFIDENCE_WORDS = {
  high: 'That is straight off the Druids size guide.',
  medium: 'You are close to the line between two sizes.',
  estimate: 'That is an estimate, not a measurement - a tape measure would make it certain.',
} as const;

const sizeTool = defineTool({
  name: 'find_my_size',
  description:
    'Work out which Druids size fits the customer. Pass whatever they have told you so far. If the result has `missing` entries, ask for those instead of guessing a size yourself. ' +
    'It is for sizing help only - never a way to record the size they want to buy now ("add it in L"): that size goes to add_to_cart. usualSize is only a size they said they normally wear. ' +
    'When they are asking about one product ("what size am I in this"), pass its productId: its own chart and cut are used, so the answer can differ between garments.',
  schema: sizeSchema,
  parameters: {
    type: 'object',
    properties: {
      heightValue: { type: 'number' },
      heightUnit: { type: 'string', enum: ['cm', 'in'] },
      weightValue: { type: 'number' },
      weightUnit: { type: 'string', enum: ['kg', 'lb'] },
      usualSize: { type: 'string', description: 'The size they normally wear, e.g. M' },
      chestCm: { type: 'number' },
      waistCm: { type: 'number' },
      fitPreference: { type: 'string', enum: ['tight', 'regular', 'relaxed'] },
      layering: { type: 'boolean', description: 'They want room to wear something underneath.' },
      audience: {
        type: 'string',
        enum: ['men', 'women'],
        description: 'Mens or womens range. They are sized completely differently, so ask if you do not know.',
      },
      category: {
        type: 'string',
        description: 'polo, midlayer, jacket, shorts, trousers, skort, belt or socks. Defaults to polo. Leave out when you pass productId.',
      },
      productId: { type: 'string', description: 'The product they are sizing for, when there is one.' },
    },
    required: [],
  },
  async run(args, ctx): Promise<ToolResult> {
    const { productId, layering, ...proposed } = args;
    const product = productId ? productById(productId) : null;
    const productRange = product ? rangeOf(product) : undefined;
    const shopper = ctx.session.shopper;

    /*
     * A usual size is one they said they usually wear, or the one already
     * theirs. Told "add it in L", the model called this with usualSize L, and
     * L - the size of one jacket - replaced the XL they had given as theirs,
     * for every picker and every search after. The model's argument alone is
     * not a usual size; a size for this purchase goes to the basket.
     */
    const measurements = { ...proposed };
    const asUsual = proposed.usualSize ? (normaliseSize(proposed.usualSize) ?? proposed.usualSize.trim().toUpperCase()) : undefined;
    /*
     * Typed into the size form by the customer (routes/tools.ts validated it):
     * theirs, though no words came with it. The form sends none, and these
     * checks - written for a model's arguments - threw away the usual size
     * and height the customer had just entered, then asked for them again.
     */
    const form = ctx.sizeForm;
    const formUsual = form?.usualSize ? (normaliseSize(form.usualSize) ?? form.usualSize.trim().toUpperCase()) : undefined;
    if (asUsual && asUsual !== formUsual && !usualSizeGiven(asUsual, ctx)) {
      delete measurements.usualSize;
      log.warn('size.usual_not_given', { sessionId: ctx.session.id, proposed: asUsual, said: ctx.utterance?.slice(0, 120) });
      const measured = [measurements.heightValue, measurements.weightValue, measurements.chestCm, measurements.waistCm].some((value) => value !== undefined);
      if (!measured) {
        const forNow = sizeInRequest(ctx.utterance ?? '');
        return {
          speech: forNow ? `${forNow} for this one - got it.` : 'What size do you usually wear?',
          facts: forNow
            ? `${forNow} is the size they want for this purchase, not their usual size - nothing about their size was stored. To buy it, call add_to_cart with ${forNow}.`
            : `${asUsual} is not a size they said they usually wear - nothing was stored. Ask their usual size, or their measurements.`,
        };
      }
    }

    /*
     * A height they never said. "My chest is 36 inches" arrived as a height of
     * 36 inches as well, which the chart rightly refused - and the customer
     * was asked their height instead of given a size. A height said earlier
     * is already in their size profile.
     */
    if (
      measurements.heightValue !== undefined &&
      measurements.heightValue !== ctx.session.sizeProfile.heightValue &&
      measurements.heightValue !== form?.heightValue &&
      !HEIGHT_SAID.test(ctx.utterance ?? '')
    ) {
      log.warn('size.height_not_given', { sessionId: ctx.session.id, proposed: measurements.heightValue, said: ctx.utterance?.slice(0, 120) });
      delete measurements.heightValue;
      delete measurements.heightUnit;
    }

    // Merge with anything they told us earlier, and with the range they are
    // already browsing, so we only ask mens/womens when we truly cannot tell.
    const audience =
      args.audience ??
      /*
       * Said in their own words. "I need a womens polo, my chest is 100cm"
       * reached this tool without the range four times in five, and the
       * customer was asked whether they meant womens.
       */
      saidRange(ctx.utterance) ??
      // The garment they asked about knows its own range.
      (productRange === 'men' || productRange === 'women' ? productRange : undefined) ??
      ctx.session.sizeProfile.audience ??
      ctx.session.preferences.audience ??
      audienceOf(onScreen(ctx)) ??
      // A store that only sells one range has already answered the question.
      audienceOf(allProducts().filter(isBrandProduct));
    // The product decides the chart: trousers are sized by the waist, whatever was asked.
    const category =
      (product && audience ? categoryForProduct(audience, `${product.productType ?? ''} ${product.title}`) : undefined) ?? args.category;

    const profile = {
      ...ctx.session.sizeProfile,
      ...measurements,
      ...(shopper?.usualSize && !measurements.usualSize ? { usualSize: shopper.usualSize } : {}),
      ...(shopper?.fit && !measurements.fitPreference ? { fitPreference: shopper.fit } : {}),
      audience,
      ...(category ? { category } : {}),
    };
    const recommendation = recommendSize(profile, {
      layering: layering ?? shopper?.layering,
      ...(product ? { productTitle: product.title } : {}),
      ...(product && attributesOf(product).fit ? { productFit: attributesOf(product).fit } : {}),
    });
    // A category read off one product is not a fact about the customer.
    const { category: _category, ...remembered } = profile;
    await sessions.patch(ctx.session.id, { sizeProfile: args.category ? profile : remembered });
    if (layering !== undefined) await rememberShopper(ctx.session.id, { layering });
    /*
     * The size worked out becomes their size, so every picker opens on it.
     * A waist size for bottoms, a top size for everything else - separate scales.
     */
    // A usual size they typed into the form stays theirs: the chart's answer is a recommendation beside it, not a replacement.
    if (formUsual) {
      await rememberShopper(ctx.session.id, { usualSize: formUsual, ...(audience ? { range: audience } : {}) });
    } else if (recommendation.size && recommendation.basis !== 'none') {
      const bySize = /^\d{2}$/.test(recommendation.size) && /short|trouser|skort/.test(category ?? '');
      await rememberShopper(ctx.session.id, {
        ...(bySize ? { waist: recommendation.size } : { usualSize: recommendation.size }),
        ...(audience ? { range: audience } : {}),
      });
    }

    if (!recommendation.size) {
      return { speech: recommendation.reason, attachment: { kind: 'size', recommendation } };
    }
    /*
     * Whether the size is in stock in the garment they asked about - a size
     * they cannot buy is only half an answer.
     */
    const stock =
      product && recommendation.size
        ? product.variants.some((variant) => variant.available && Object.values(variant.options).some((value) => optionValueMatches(value, recommendation.size!)))
          ? `${recommendation.size} is in stock in the ${product.title}.`
          : `${recommendation.size} is not in stock in the ${product.title} - say so, and offer the alternative size or another colourway.`
        : '';
    const level = recommendation.confidenceLevel ?? 'estimate';
    return {
      speech: `${recommendation.reason}${level === 'estimate' && !/estimate/i.test(recommendation.reason) ? ` ${CONFIDENCE_WORDS.estimate}` : ''}`,
      facts: [
        `Confidence: ${level}. ${CONFIDENCE_WORDS[level]}`,
        recommendation.alternativeSize ? `Alternative: ${recommendation.alternativeSize} - ${recommendation.alternativeReason ?? ''}` : '',
        category && product ? `Sized on the ${audience === 'women' ? 'ladies' : 'mens'} ${category} chart, for ${product.title}.` : '',
        stock,
      ]
        .filter(Boolean)
        .join('\n'),
      attachment: { kind: 'size', recommendation },
    };
  },
});

/**
 * Whether a size is one they called their usual size: said as such in any of
 * their messages ("I'm usually XL", "my normal size is L" - read by the same
 * reader that keeps their profile), or already their usual size.
 */
function usualSizeGiven(size: string, ctx: ToolContext): boolean {
  const key = (value: string | undefined) => (value ? (normaliseSize(value) ?? value).toUpperCase() : undefined);
  const wanted = key(size);
  const known = [ctx.session.shopper?.usualSize, ctx.session.sizeProfile.usualSize].map(key);
  if (known.includes(wanted)) return true;
  const said = [...ctx.session.messages.filter((message) => message.role === 'user').map((message) => message.text), ctx.utterance ?? ''];
  return said.some((text) => key(readIntent(text).usualSize) === wanted);
}

/* ---------------- recommend_pack ---------------- */

const packSchema = z.object({
  query: z.string().min(1).describe('The kind of kit the pack is for'),
  budgetAmount: z.number().positive().optional(),
  currency: z.string().length(3).optional(),
  colour: z.string().optional(),
  size: z.string().optional(),
  itemCount: z.number().int().min(2).max(6).optional(),
  swap: z.string().optional(),
  swapWith: z.string().optional(),
});

/*
 * The store's real bundle deals, before anything else.
 *
 * Asked for bundles, the Caddie used to put three polos together to a
 * budget, add up their prices and call it "Your Ambassador Pack". Druids'
 * Ambassador Pack is six pieces - jacket, midlayer, polo, trousers, belt or
 * cap, socks - for £99.99, and it was never offered. These are the real
 * recipes from the live theme (catalog/bundles.ts).
 */
async function dealAnswer(
  args: { query: string; size?: string; colour?: string; swap?: string; swapWith?: string },
  ctx: ToolContext,
  colour: string | undefined,
  currency: string,
): Promise<ToolResult | null> {
  if (allDeals().length === 0) return null;
  const size = args.size ?? ctx.session.sizeProfile.usualSize;
  const shown = ctx.session.lastShown;
  const onScreen =
    shown?.kind === 'pack' && shown.bundle ? allDeals().find((deal) => deal.handle === shown.bundle) : undefined;

  /*
   * "Change the colour of every product" with no colour named is a question,
   * not a swap. The model swapped the jacket alone and said the pack had
   * "limited colour options" - it had not looked. The colours the whole pack
   * can come in are counted from its steps, so what is offered is real.
   */
  const said = ctx.utterance ?? '';
  const wholePack = /\b(colou?rs?)\b/i.test(said) && /\b(every|all|whole|each|everything|entire)\b/i.test(said);
  if (onScreen && wholePack && !parseColours(said).colours.length) {
    const perStep = onScreen.steps.map((step) =>
      new Set(
        coloursOffered(
          [...step.productIds].map((id) => productById(id)).filter((p): p is Product => !!p && p.variants.some((v) => v.available)),
        ).map((colour) => colour.toLowerCase()),
      ),
    );
    const counts = new Map<string, number>();
    for (const colours of perStep) for (const colour of colours) counts.set(colour, (counts.get(colour) ?? 0) + 1);
    // Colours that nearly every step has, most complete first.
    const options = [...counts.entries()]
      .filter(([, count]) => count >= Math.max(3, onScreen.steps.length - 1))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([colour]) => colour);
    return {
      speech: options.length
        ? `Which colour would you like the whole pack in? It comes together well in ${options.slice(0, -1).join(', ')}${options.length > 1 ? ' or ' : ''}${options[options.length - 1]}.`
        : 'Which colour would you like the whole pack in?',
      facts: `Ask which colour, then call recommend_pack again with that colour: it rebuilds every piece in new designs. Colours nearly every step comes in: ${options.join(', ') || 'mixed'}.`,
    };
  }
  /*
   * Which pack, and for the Ambassador Pack which conditions: their words
   * this turn (the model paraphrases, so the utterance too), then the weather
   * they have told us about. Nothing to go on is a question, not a default.
   */
  const weather = readIntent(said).weather ?? ctx.session.shopper?.weather;
  const choice = chooseDeal(`${args.query} ${said}`, dealRange(ctx), weather);
  const namedDeal = choice && 'deal' in choice ? choice.deal : undefined;
  const remembered = ctx.session.packsShown ?? {};

  /*
   * The pack a change is for: the one they name, when they have seen it -
   * otherwise the one on screen. "Change the polo in the mixed conditions
   * pack" with Warm Rounds on screen changed Warm Rounds, and then told them
   * no mixed pack was showing.
   */
  // Or the pack in focus while its choices for one piece are on screen.
  const inFocus = ctx.session.packInFocus && remembered[ctx.session.packInFocus] ? allDeals().find((deal) => deal.handle === ctx.session.packInFocus) : undefined;
  const target = namedDeal && remembered[namedDeal.handle] ? namedDeal : (onScreen ?? inFocus);
  const fromScreen = !!target && target === onScreen && shown?.kind === 'pack';
  const targetItems = target ? ((fromScreen ? shown!.items : remembered[target.handle]?.items) ?? []) : [];
  const targetColour = target ? (fromScreen ? shown?.colour : remembered[target.handle]?.colour) : undefined;
  // A change keeps the colour that pack was built in, unless they name another.
  if (!colour && targetColour) colour = targetColour;

  // One piece named with a change word is a swap, whether or not the model called it one.
  const slotIndex = target ? stepNamed(target, said) : -1;
  const changeWords = CHANGE_WORDS.test(said);
  /*
   * One piece named, with a change, a colour or a choice, is a swap of that
   * piece. "Select men's clima golf trousers which is white" came in with the
   * colour and no piece to swap, and every piece of the pack was rebuilt in
   * white - the jacket, polo and belt the customer had not mentioned.
   */
  const aboutOnePiece = changeWords || parseColours(said).colours.length > 0 || CHOICE_WORDS.test(said);
  const wantsSwap = !!(args.swap || args.swapWith) || (!!target && slotIndex >= 0 && !wholePack && aboutOnePiece);

  // Swapping one piece of that pack: the rest stays, one step is re-picked.
  if (target && wantsSwap) {
    const current = targetItems.map((item) => (item.id ? productById(item.id) : null));
    const stepIndex = current.findIndex((product) => !!product && !!args.swap && sameProduct(product.id, args.swap));
    // "swapWith: cap" is the kind of piece they want, not a product to look up - any cap in the store could come back.
    const bare = (args.swapWith ?? '').trim().replace(/^(an?|the)\s+/i, '');
    const kindOnly = /^[a-z]+$/i.test(bare) && PIECE_KINDS.some((kind) => kind.said.test(bare));
    /*
     * A design they name is their pick, whether or not the model passed it.
     * "Swap this premium play trouser which is white" - not in the pack - put
     * white Comfort Shorts in; "select men's clima golf trousers which is
     * white" then said the pack had no white trousers.
     */
    const named = designNamedIn(
      said,
      slotIndex >= 0 ? target.steps[slotIndex] : undefined,
      targetItems,
      new Set(ctx.session.lastShown?.kind === 'products' ? ctx.session.lastShown.items.map((item) => item.id) : []),
    );
    // Their own words first: the model once passed a vague swapWith and the named design was lost.
    const chosen = named ?? (args.swapWith && !kindOnly ? await getProductDetails(args.swapWith) : null);
    const index =
      stepIndex >= 0
        ? stepIndex
        : chosen
          ? target.steps.findIndex((step) => step.productIds.has(chosen.id))
          : slotIndex;
    if (index < 0) {
      return {
        speech: 'Which piece of the pack would you like to change?',
        facts: `Pack pieces: ${target.steps
          .map((step, i) => `${step.title}: ${current[i]?.title ?? 'none'} [${current[i]?.id ?? ''}]`)
          .join('; ')}`,
      };
    }
    const step = target.steps[index]!;
    if (chosen && !step.productIds.has(chosen.id)) {
      // What the pack does take in that colour: "the Premium Play Trousers aren't in it - the Clima Golf Trousers in white are".
      const shade = colourwayName(chosen.title);
      const nearest = [...step.productIds]
        .map((id) => productById(id))
        .filter((p): p is Product => !!p && p.variants.some((v) => v.available) && (!shade || matchesColourText(p, shade) > 0))
        .sort((a, b) => Number(kindOf(b) === kindOf(chosen)) - Number(kindOf(a) === kindOf(chosen)))[0];
      return {
        lead: notInPackLead(chosen, titleCaseWords(target.title)),
        speech: `The ${titleCaseWords(chosen.title)} ${/s$/i.test(garmentName(chosen.title)) ? "aren't" : "isn't"} one of the pack's choices${
          nearest ? ` - the ${titleCaseWords(nearest.title)} is. Shall I put that in?` : ', so it would be bought separately at full price.'
        }`,
        facts:
          `${chosen.title} is not in the ${step.title} step of ${target.title}; only that step's products count towards the pack. Nothing has changed. ` +
          (nearest
            ? `The pack's own choice in that colour: ${nearest.title} [${nearest.id}] - offer it (recommend_pack with swapWith that id), or ${chosen.title} bought separately.`
            : `Offer ${chosen.title} bought separately at full price.`),
      };
    }
    const keep = new Map<number, Product>();
    current.forEach((product, i) => {
      if (product && i !== index) keep.set(i, product);
    });
    if (chosen) keep.set(index, chosen);
    const outgoing = current[index];
    if (outgoing) await rememberShopper(ctx.session.id, { rejected: [outgoing.id], ...(chosen ? { liked: [chosen.id] } : {}) });
    const turnedDown = ctx.session.shopper?.rejected ?? [];
    /*
     * The colour asked for this one piece, in the customer's own words first.
     * "Change the colour of trouser to white" reached here with no colour -
     * the model left it out - and black joggers came back while the Caddie
     * told the customer they were white.
     */
    const pieceColour = chosen ? undefined : (colourAsked(undefined, said) ?? colourAsked(args.colour));
    const redesign = /\b(design|style|different|another|other)\b/i.test(said);
    const outgoingDesign = outgoing ? new Set([garmentName(outgoing.title)]) : undefined;
    const stepProducts = [...step.productIds].map((id) => productById(id)).filter((p): p is Product => !!p);
    const kind = chosen
      ? undefined
      : (kindWanted(said, outgoing, stepProducts) ?? (kindOnly ? kindWanted(args.swapWith!, outgoing, stepProducts) : undefined));
    // A new colour is the same piece recoloured; otherwise a swap is a different piece: "change the design of the polo".
    const pieces = fillDeal(target, {
      size,
      ...((pieceColour ?? colour) ? { colour: pieceColour ?? colour } : {}),
      keep,
      exclude: [...(outgoing ? [outgoing.id] : []), ...turnedDown],
      ...(outgoingDesign ? (pieceColour && !redesign ? { preferDesigns: outgoingDesign } : { avoidDesigns: outgoingDesign }) : {}),
      ...(kind ? { onlyKind: kind.title } : {}),
    });
    const picked = pieces[index];
    if (kind && !picked) {
      // The kind they asked for, and none of it to be had in this step: change nothing.
      return {
        speech: `There's no ${kind.name} I can put in the ${titleCaseWords(target.title)}${size ? ` in ${size}` : ''} right now, so I've left it as it is. Would another piece do?`,
        facts:
          `No ${kind.name} in the ${step.title} step of ${target.title} is in stock${size ? ` in ${size}` : ''}, so the pack is unchanged (still ${outgoing?.title ?? 'as shown'}). ` +
          'Never say it has been changed.',
      };
    }
    if (pieceColour && (!picked || matchesColourText(picked, pieceColour) === 0)) {
      // Nothing in that colour for this step: say what it does come in, and change nothing.
      const offered = coloursOffered(
        [...step.productIds]
          .map((id) => productById(id))
          .filter((p): p is Product => !!p && p.id !== outgoing?.id && p.variants.some((v) => v.available)),
      ).map((c) => c.toLowerCase());
      const choices = [...new Set(offered)].slice(0, 6);
      const piece = step.title.toLowerCase().replace(/\s*\/\s*/g, ' or ');
      return {
        speech: `The ${piece} in the ${titleCaseWords(target.title)} doesn't come in ${pieceColour}${choices.length ? ` - it comes in ${choices.join(', ')}` : ''}. Would one of those do?`,
        facts:
          `Nothing in the ${step.title} step of ${target.title} comes in ${pieceColour}, so the pack is unchanged (still ${outgoing?.title ?? 'as shown'}). ` +
          `The colours this step does come in, across all its designs: ${choices.join(', ') || 'none other'} - name these; never say it comes in only the colour on screen. ` +
          'Never say it has been changed. Offer one of those colours, or the piece they wanted bought separately at full price, outside the pack. Do not call product_info for this - it only knows the one design.',
      };
    }
    // The pack keeps its own colour; one recoloured piece does not recolour the rest on the next swap.
    const packColour = targetColour;
    const result = await showDeal(target, pieces, ctx, currency, args.query, { ...(size ? { size } : {}), ...(packColour ? { colour: packColour } : {}) });
    const card = result.attachment?.kind === 'pack' ? result.attachment.recommendation : undefined;
    // Only at its own price, as shown: a pack that cannot be bought, or costs its pieces' total, keeps showDeal's words.
    const asPriced = card?.bundle?.handle === target.handle && !card.bundle.blocked && card.total.amount === target.prices.GBP;
    if (!picked || picked.id === outgoing?.id || card?.bundle?.handle !== target.handle) return result;
    const changed = `Changed: ${outgoing?.title ?? 'none'} -> ${picked.title}. Name the new piece exactly as it is titled - what it is and its colour.\n`;
    return {
      ...result,
      ...(asPriced
        ? { speech: `I've swapped the ${outgoing ? titleCaseWords(outgoing.title) : step.title.toLowerCase()} for the ${titleCaseWords(picked.title)} - the pack is still £${target.prices.GBP}.` }
        : {}),
      facts: `${changed}${result.facts ?? ''}`,
    };
  }

  if (namedDeal) {
    // Pieces suited to their weather, or to the conditions the pack is for.
    const suits = weather ?? (namedDeal.condition ? CONDITION_WEATHER[namedDeal.condition] : undefined);
    const before = remembered[namedDeal.handle];
    /*
     * A change to a pack they have seen: new designs, not the same pieces
     * recoloured. "Change the colour of every product" brought back the same
     * polo, midlayer and trousers in white. A new colour counts as a change -
     * "white", answering "which colour?".
     */
    const recoloured = !!colour && colour.toLowerCase() !== (before?.colour ?? '').toLowerCase();
    const changing = !!before && (recoloured || changeWords || wholePack);
    const fill = { ...(size ? { size } : {}), ...(colour ? { colour } : {}), ...(suits ? { weather: suits } : {}) };

    // Back to a pack they have already seen, unchanged: the pieces they saw.
    if (before && !changing) {
      const again = before.items.map((item) => (item.id ? productById(item.id) : null));
      if (again.every((piece) => piece && piece.variants.some((variant) => variant.available))) {
        return withOtherVersions(namedDeal, await showDeal(namedDeal, again, ctx, currency, args.query, fill), said);
      }
    }

    /*
     * Variety across packs: each one leads with designs they have not seen in
     * the others. Every pack came back the same Hectar Midlayer, Golf Tee Polo
     * and Clima Trousers, and the customer asked why nothing changed.
     */
    const seenElsewhere = Object.entries(remembered)
      .filter(([handle]) => handle !== namedDeal.handle)
      .flatMap(([, pack]) => pack.items.filter((item) => item.title).map((item) => garmentName(item.title)));
    const own = changing && before ? before.items.filter((item) => item.title).map((item) => garmentName(item.title)) : [];
    const avoidDesigns = new Set([...own, ...seenElsewhere]);
    const shownDeal = await showDeal(
      namedDeal,
      fillDeal(namedDeal, { ...fill, ...(avoidDesigns.size ? { avoidDesigns } : {}) }),
      ctx,
      currency,
      args.query,
      fill,
    );
    return withOtherVersions(namedDeal, shownDeal, said);
  }
  if (choice && 'ask' in choice) {
    const options = choice.ask;
    /*
     * No prices yet. Each version's listed price is not always what it costs:
     * pieces that come to less on their own are charged at that, so "Cool &
     * Wet is £159.99" was followed by a card at £156. The price is given once
     * the pack is built, in their sizes.
     */
    const named = options.map((d) => titleCaseWords(d.conditionTitle ?? d.title));
    const spoken = named.length > 1 ? `${named.slice(0, -1).join(', ')} or ${named[named.length - 1]}` : named[0];
    return {
      speech: `The ${rangeLabel(options[0]!.range)}Ambassador Pack comes in ${spoken}, for the conditions you play in. Which suits you best?`,
      facts:
        `The Ambassador Pack by conditions - ask which, never pick one for them:\n${options
          .map((d) => `- ${d.title}: ${d.steps.length} pieces (${d.steps.map((s) => s.title.toLowerCase()).join(', ')})`)
          .join('\n')}\n` +
        'No prices here: what each costs depends on the pieces picked, and is given once it is built. Never quote a price for a version before it is built - if they ask, build it with recommend_pack.\n' +
        'When they answer (or describe their weather: sun and heat is warm, changeable is mixed, cold or rain is cool & wet), call recommend_pack with "Ambassador Pack" and the condition, e.g. "Ambassador Pack cool and wet".',
    };
  }

  // "Any bundles?" - the deals themselves, for them to choose from.
  if (asksForDeals(args.query)) {
    const range = parseRange(args.query).range ?? knownRange(ctx);
    const inRangeDeals = allDeals().filter((d) => !range || d.range === range);
    const deals = inRangeDeals.length ? inRangeDeals : allDeals();
    const list = deals.map(
      (d) => `- ${d.title}: ${d.steps.length} pieces for £${d.prices.GBP} (${d.steps.map((s) => s.title.toLowerCase()).join(', ')})`,
    );
    // Led by the main range when none is known: "nine versions" counted mens, ladies and kids together.
    const allAmbassadors = deals.filter((d) => /ambassador/.test(d.handle));
    const ambassadors = allAmbassadors.filter((d) => d.range === (range ?? 'men'));
    const lead = ambassadors[0] ?? allAmbassadors[0] ?? deals[0]!;
    const leadLine =
      ambassadors.length > 1 && ambassadors.every((d) => d.condition)
        ? `the ${rangeLabel(lead.range)}Ambassador Pack comes in ${ambassadors.length} versions for different conditions`
        : `the ${lead.title} is ${lead.steps.length} pieces for £${lead.prices.GBP}`;
    return {
      speech: `We have ${deals.length} bundle deals - ${leadLine}. Which would you like to see?`,
      facts: `The store's bundle deals, at fixed prices:\n${list.join('\n')}\nWhen they choose one, call recommend_pack with its name to build it.`,
    };
  }
  return null;
}

// "A belt instead of a cap" is a swap too - without "instead" it rebuilt the whole pack.
const CHANGE_WORDS = /\b(swap|switch|change|different|another|replace|other|new|else|design|style|instead|rather)\b/i;
const CHOICE_WORDS = /\b(select|choose|pick|prefer|go with|make it|use|want|like)\b/i;

/**
 * The product a customer names by its design - "premium play", "clima golf
 * trousers" - with the colour they say. Pack choices, the kind of piece they
 * say, and their colour lead; null when no design is named.
 */
function designNamedIn(
  said: string,
  step: DealStep | undefined,
  inPack: Array<{ title: string }>,
  onScreen: Set<string> = new Set(),
): Product | null {
  const spoken = new Set(said.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/).filter(Boolean));
  const colour = colourAsked(undefined, said);
  const kindSaid = PIECE_KINDS.filter((kind) => kind.said.test(said));
  // "Change the clima trousers", no colour: naming the piece going out, not picking it again.
  const packDesigns = new Set(inPack.filter((item) => item.title).map((item) => garmentName(item.title)));
  const named = allProducts().filter((product) => {
    const design = distinctiveWords(garmentName(product.title)).filter((word) => word.length > 1 && !/^(men|mens|ladies|kids|womens?)$/.test(word));
    return (
      design.length > 0 &&
      design.every((word) => spoken.has(word)) &&
      product.variants.some((variant) => variant.available) &&
      // The kind they said: "clima trousers" is not the Clima shorts.
      (kindSaid.length === 0 || kindSaid.some((kind) => kind.title.test(product.title))) &&
      (!!colour || !packDesigns.has(garmentName(product.title)))
    );
  });
  if (named.length === 0) return null;
  // A colour they name comes first: never the navy one when they said white.
  const inColour = colour ? named.filter((product) => matchesColourText(product, colour) > 0) : named;
  if (inColour.length) named.splice(0, named.length, ...inColour);
  // "The white clima ones" with the white Clima trousers on screen is those, not the white Clima shorts.
  const score = (product: Product) =>
    (onScreen.has(product.id) ? 16 : 0) +
    (step?.productIds.has(product.id) ? 8 : 0) +
    (kindSaid.some((kind) => kind.title.test(product.title)) ? 4 : 0) +
    (colour ? Math.min(matchesColourText(product, colour), 3) : 0);
  return named.sort((a, b) => score(b) - score(a))[0]!;
}

/** The size-like values among chosen options - size, waist, leg - never a colour. */
function sizeValues(options: Record<string, string> | undefined): string[] {
  return Object.entries(options ?? {})
    .filter(([key]) => /size|waist|leg|length|fit/i.test(key))
    .map(([, value]) => value);
}

/** "trousers", "belt" - what a piece is, by its title. */
function kindOf(product: Product): string | undefined {
  return PIECE_KINDS.find((kind) => kind.name !== 'hat' && kind.title.test(product.title))?.name;
}

/** The pack on the customer's screen right now, if it is one. */
function packOnScreen(ctx: ToolContext): DealRecipe | undefined {
  const shown = ctx.session.lastShown;
  return shown?.kind === 'pack' && shown.bundle ? allDeals().find((deal) => deal.handle === shown.bundle) : undefined;
}

/** The pack whose choices for one piece are on screen - shown by packStepChoices. */
function packChoicesInFocus(ctx: ToolContext): DealRecipe | undefined {
  const shown = ctx.session.lastShown;
  const handle = ctx.session.packInFocus;
  if (!handle || shown?.kind !== 'products' || shown.query !== `pack choices: ${handle}`) return undefined;
  return allDeals().find((deal) => deal.handle === handle);
}

/**
 * "Put the first one in", with a pack's choices for one piece on screen: a
 * swap into that pack, whichever tool the model reached for. It looked the
 * trousers up and asked for a waist size instead, and the pack stayed navy.
 */
async function pickFromPackChoices(ctx: ToolContext): Promise<ToolResult | null> {
  const deal = packChoicesInFocus(ctx);
  const said = ctx.utterance ?? '';
  if (!deal || /\?\s*$/.test(said)) return null;
  if (!(CHOICE_WORDS.test(said) || /\b(put|add|swap|go for|take|that one|this one|yes)\b/i.test(said))) return null;
  const hit = resolveProduct(ctx.session, said);
  if (!hit) return null;
  const currency = ctx.session.preferences.currency ?? storeCurrency();
  return dealAnswer({ query: deal.title, swapWith: hit.product.id }, ctx, undefined, currency);
}

/**
 * "No - the Premium Play Trousers aren't part of the pack", kept at the front
 * of the reply unless the reply already says no about that design.
 */
function notInPackLead(product: Product, packName: string): { text: string; unless: RegExp } {
  const design = titleCaseWords(garmentName(product.title));
  const word = (distinctiveWords(garmentName(product.title))[0] ?? design.split(' ')[0]!).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    text: `No - the ${design} ${/s$/i.test(design) ? "aren't" : "isn't"} part of the ${packName}.`,
    unless: new RegExp(`^\\s*no\\b|${word}[^.]*\\b(not|isn't|aren't|can't)\\b|\\b(not|isn't|aren't|can't)\\b[^.]*${word}`, 'i'),
  };
}

/** One step of a pack: only what the pack takes, in the colour and kind asked for. */
async function packStepChoices(deal: DealRecipe, index: number, ctx: ToolContext, colour: string | undefined): Promise<ToolResult> {
  const step = deal.steps[index]!;
  const said = ctx.utterance ?? '';
  const inStock = [...step.productIds]
    .map((id) => productById(id))
    .filter((p): p is Product => !!p && p.variants.some((variant) => variant.available));
  // "Belts" in the belt-or-cap step is belts only.
  const kinds = PIECE_KINDS.filter((kind) => kind.said.test(said) && inStock.some((p) => kind.title.test(p.title)));
  const ofKind = kinds.length ? inStock.filter((p) => kinds.some((kind) => kind.title.test(p.title))) : inStock;
  const matching = colour ? ofKind.filter((p) => matchesColourText(p, colour) > 0) : ofKind;
  const piece = step.title.toLowerCase().replace(/\s*\/\s*/g, ' or ');
  const packName = titleCaseWords(deal.title);
  /*
   * A product they name that the pack does not take is a no, said first.
   * "Do you have premium play trousers in white for the pack?" got "Yes, the
   * pack can include Men's Clima Golf Trousers in white".
   */
  const named = designNamedIn(said, step, []);
  const notInPack = named && !step.productIds.has(named.id) ? named : null;
  const refusal = notInPack
    ? `No - the ${titleCaseWords(garmentName(notInPack.title))} ${/s$/i.test(garmentName(notInPack.title)) ? "aren't" : "isn't"} part of the ${packName}; it could only be bought separately at full price. `
    : '';
  const refusalFact = notInPack
    ? `${notInPack.title} is NOT one of the pack's choices. Start the answer with "No" and say so plainly - never "yes". `
    : '';
  const lead = notInPack ? notInPackLead(notInPack, packName) : undefined;
  if (matching.length === 0) {
    const colours = [...new Set(coloursOffered(ofKind).map((c) => c.toLowerCase()))].slice(0, 6);
    return {
      ...(lead ? { lead } : {}),
      speech: `${refusal}None of the ${piece} choices in the ${packName} come in ${colour ?? 'that'}${colours.length ? ` - they come in ${colours.join(', ')}` : ''}. Would one of those do?`,
      facts:
        refusalFact +
        `Nothing in the ${step.title} step of ${deal.title} matches. Nothing outside the pack has been shown - never suggest a product outside the pack as part of it. ` +
        'Offer the colours it does come in; only if they ask, search outside the pack and say it is bought separately at full price.',
    };
  }
  const shown = matching.sort((a, b) => (colour ? matchesColourText(b, colour) - matchesColourText(a, colour) : 0)).slice(0, 8);
  await sessions.patch(ctx.session.id, {
    lastShown: { kind: 'products', items: shown.map((p) => ({ id: p.id, title: p.title })), query: `pack choices: ${deal.handle}` },
    packInFocus: deal.handle,
  });
  return {
    speech: `${refusal}Here are the ${piece} choices in the ${packName}${colour ? ` in ${colour}` : ''} - any of these can go in the pack. Which would you like?`,
    facts:
      refusalFact +
      `Every product here is one of the ${step.title} choices in ${deal.title} - nothing from outside the pack:\n${shown.map((p) => `- ${p.title} [${p.id}]`).join('\n')}\n` +
      'To put one in, call recommend_pack with swapWith its id. The rest of the pack stays as it is.',
    attachment: { kind: 'products', products: shown },
    ...(lead ? { lead } : {}),
  };
}

/** "Change this trouser with a white trouser" - one piece of that pack, not something bought on its own. */
function asksToChangePackPiece(deal: DealRecipe, said: string): boolean {
  if (stepNamed(deal, said) < 0) return false;
  if (/\b(separately|on its own|on their own|outside the pack|not in the pack|as well|extra)\b/i.test(said)) return false;
  return CHANGE_WORDS.test(said);
}

/**
 * The kinds of piece one pack step can hold: as a customer says it, and as a
 * title shows it. The belt-or-cap step holds belts, caps, beanies and visors.
 */
const PIECE_KINDS: Array<{ name: string; said: RegExp; title: RegExp }> = [
  { name: 'belt', said: /\bbelts?\b/i, title: /\bbelt\b/i },
  { name: 'cap', said: /\bcaps?\b/i, title: /\bcap\b/i },
  { name: 'beanie', said: /\bbeanies?\b/i, title: /\bbeanie\b/i },
  { name: 'visor', said: /\bvisors?\b/i, title: /\bvisor\b/i },
  { name: 'hat', said: /\bhats?\b/i, title: /\b(cap|beanie|visor|hat)\b/i },
  { name: 'shorts', said: /\bshorts\b/i, title: /\bshorts\b/i },
  { name: 'skort', said: /\bskorts?\b/i, title: /\bskorts?\b/i },
  { name: 'joggers', said: /\bjoggers?\b/i, title: /\bjoggers?\b/i },
  { name: 'trousers', said: /\b(trousers?|pants)\b/i, title: /\btrousers?\b/i },
  { name: 'gilet', said: /\b(gilets?|vests?)\b/i, title: /\bgilet\b/i },
  { name: 'jacket', said: /\bjackets?\b/i, title: /\bjacket\b/i },
  { name: 'hoodie', said: /\bhoodies?\b/i, title: /\bhoodie\b/i },
];

/**
 * "I need a belt instead of a cap": the kind of piece they want in its place.
 * Not the kind going out, not the one after "instead of", and only a kind the
 * step actually holds. Asked for a belt, the Caddie said it had swapped in a
 * belt and put a beanie on the card.
 */
export function kindWanted(
  said: string,
  outgoing: Product | null | undefined,
  stepProducts: Product[],
): { name: string; title: RegExp } | undefined {
  const refused = /\b(instead of|rather than|not|no)\s+(an?\s+|the\s+|my\s+)?(\w+)/gi;
  const notWanted = new Set([...said.matchAll(refused)].map((match) => match[3]!.toLowerCase()));
  const mentioned = PIECE_KINDS.map((kind) => ({ kind, at: said.search(kind.said) }))
    .filter(({ kind, at }) => at >= 0 && stepProducts.some((product) => kind.title.test(product.title)))
    .filter(({ kind }) => !(outgoing && kind.title.test(outgoing.title)))
    .filter(({ kind }) => ![...notWanted].some((word) => kind.said.test(word)))
    .sort((a, b) => a.at - b.at);
  return mentioned[0]?.kind;
}

/**
 * "Do you have only one Ambassador Pack?" - the other versions, from the deals
 * themselves. Shown the mens pack again, the Caddie said "we only have this
 * one" while a Ladies and a Kids Ambassador Pack were on sale.
 */
function withOtherVersions(deal: DealRecipe, result: ToolResult, said: string): ToolResult {
  const family = /ambassador/.test(deal.handle) ? /ambassador/ : null;
  if (!family) return result;
  const others = allDeals().filter((d) => d.handle !== deal.handle && family.test(d.handle));
  if (others.length === 0) return result;
  const described = others.map(
    (d) => `${rangeLabel(d.range) || 'Mens '}${d.conditionTitle ? `${titleCaseWords(d.conditionTitle)} ` : ''}Ambassador Pack`,
  );
  const facts = `${result.facts ?? ''}\nOther versions of this pack on sale (there is more than one - never say there is only one; build one to price it): ${described.join('; ')}.`;
  const asks =
    /\b(only|just)\s+(one|the one|this one|that one)\b|\bhow many\b|\bany (other|more)\b|\bother (ones?|packs?|versions?|kinds?)\b|\bpacks\b|\bversions\b/i.test(said);
  if (!asks) return { ...result, facts };
  const ranges = [...new Set(others.filter((d) => d.range !== deal.range).map((d) => rangeLabel(d.range).trim() || 'Mens'))];
  const sameRange = others.filter((d) => d.range === deal.range);
  const extra = [
    sameRange.length ? `it also comes in ${sameRange.map((d) => titleCaseWords(d.conditionTitle ?? d.title)).join(' and ')} versions` : '',
    ranges.length ? `there's a ${ranges.join(' and a ')} Ambassador Pack too` : '',
  ]
    .filter(Boolean)
    .join(', and ');
  return {
    ...result,
    speech: `${result.speech} ${extra.charAt(0).toUpperCase()}${extra.slice(1)} - would you like to see one?`,
    facts,
  };
}

/** The weather each Ambassador condition is for - what its pieces should suit. */
const CONDITION_WEATHER: Record<NonNullable<DealRecipe['condition']>, Weather[]> = {
  warm: ['hot'],
  mixed: ['windy', 'wet'],
  coolwet: ['wet', 'cold'],
};

/**
 * Why a pack cannot be bought right now, or undefined when it can - decided
 * before anything is shown. A Cool & Wet pack with an empty jacket step, at a
 * price checkout would not apply, was put on screen as "Pack price £159.99"
 * with a warning box underneath: an error, as far as the customer could tell.
 */
async function whyNotBuyable(deal: DealRecipe, pieces: Array<Product | null>): Promise<string | undefined> {
  const empty = deal.steps.filter((_, index) => !pieces[index]).map((step) => step.title.toLowerCase());
  if (empty.length) return `no ${empty.join(' or ')} can be picked for it`;
  if (deal.format === 'plus') {
    const variants = pieces.map((piece) => piece!.variants.find((variant) => variant.available)?.id ?? piece!.variants[0]?.id ?? '');
    if ((await packPriceHolds(deal, variants)) === 'wrong') return 'the checkout does not apply its pack price yet';
  }
  return undefined;
}

async function showDeal(
  deal: DealRecipe,
  pieces: Array<Product | null>,
  ctx: ToolContext,
  currency: string,
  query: string,
  fill: { size?: string; colour?: string; weather?: Weather[] } = {},
): Promise<ToolResult> {
  const blocked = await whyNotBuyable(deal, pieces);

  /*
   * The one they asked for cannot be bought yet: show the one that can,
   * filled for the weather they asked about, and say so in a line - never a
   * card that cannot be bought, and never a warning. What is true, said
   * lightly: that version is not available yet, and here is one that is.
   */
  if (blocked && /ambassador/.test(deal.handle)) {
    // The nearest condition that can be bought: Cool & Wet falls back to Mixed, then Warm Rounds.
    const nearest: Array<NonNullable<DealRecipe['condition']>> = deal.condition === 'coolwet' ? ['mixed', 'warm'] : ['warm', 'mixed'];
    const weather = [...new Set([...(fill.weather ?? []), ...(deal.condition ? CONDITION_WEATHER[deal.condition] : [])])];
    for (const condition of nearest) {
      const stand = allDeals().find(
        (d) => d.range === deal.range && d.handle !== deal.handle && /ambassador/.test(d.handle) && d.condition === condition,
      );
      if (!stand) continue;
      const standPieces = fillDeal(stand, { ...(fill.size ? { size: fill.size } : {}), ...(fill.colour ? { colour: fill.colour } : {}), weather });
      if (!(await whyNotBuyable(stand, standPieces))) {
        const shown = await showDeal(stand, standPieces, ctx, currency, query, fill);
        const asked = titleCaseWords(deal.conditionTitle ?? deal.title);
        const suited = deal.condition === 'coolwet' || deal.condition === 'mixed' ? ", with pieces picked for wetter, cooler rounds where I could" : '';
        return {
          ...shown,
          speech: `The ${asked} version isn't available just yet, so here's the ${titleCaseWords(stand.conditionTitle ?? 'Ambassador')} pack at £${stand.prices.GBP}${suited}.`,
          facts:
            `They asked for ${deal.title}; it cannot be bought yet (${blocked}). Shown instead: ${stand.title}, which can. ` +
            'Say this lightly, in one line, with no apology or error wording, and move on to their size. Never say anything is out of stock.\n' +
            (shown.facts ?? ''),
        };
      }
    }
  }

  const recommendation = dealRecommendation(deal, pieces, currency);
  if (blocked && recommendation.bundle) recommendation.bundle.blocked = `The ${titleCaseWords(deal.conditionTitle ?? deal.title)} version isn't available just yet.`;
  /*
   * Pieces that cost less on their own than the pack price are charged at
   * their own total - a discount never raises a price. Quoting £129.99 for
   * pieces the customer will pay £118 for is still a wrong quote.
   */
  // Their words this turn - "waist 34, leg 36" - read into this pack's choices, checked against these pieces.
  const shownPieces = pieces.filter((piece): piece is Product => !!piece);
  if (!blocked && ctx.utterance) {
    const now = await sessions.getOrCreate(ctx.session.id);
    const lastReply = [...now.messages].reverse().find((message) => message.role === 'assistant')?.text ?? '';
    const read = readPackChoices(ctx.utterance, lastReply, shownPieces, now.packChoices?.[deal.handle] ?? {});
    await sessions.patch(ctx.session.id, { packChoices: { ...(now.packChoices ?? {}), [deal.handle]: read } });
  }
  const status = blocked ? null : packStatus(await sessions.getOrCreate(ctx.session.id), deal.handle, shownPieces);

  let cheaperNote = '';
  // What the pieces cost on their own - in the sizes they chose where they have, so the card, the reply and the basket agree.
  const chosenVariant = (piece: Product) => status?.pieces.find((plan) => plan.product.id === piece.id)?.variant?.id;
  const own = pieces.every(Boolean)
    ? piecesTotal(pieces.map((piece) => chosenVariant(piece!) ?? piece!.variants.find((variant) => variant.available)?.id ?? piece!.variants[0]?.id ?? ''))
    : 0;
  if (!blocked && deal.format === 'plus' && pieces.every(Boolean)) {
    const packPrice = deal.prices.GBP ?? 0;
    if (own > 0 && own < packPrice) {
      recommendation.total = { amount: own, currency: recommendation.total.currency };
      cheaperNote = ` These pieces come to £${own.toFixed(2)} on their own - less than the £${packPrice} pack price - so that is what you would pay.`;
      // The card's own line said "6 pieces for £159.99" above a £114.00 total.
      recommendation.reason = `The ${deal.title} is ${deal.steps.length} pieces, one from each step.${cheaperNote}`;
    }
  }
  // What this pack came to when they last saw it - a swap that changes the price says so.
  const shownBefore = (await sessions.getOrCreate(ctx.session.id)).packsShown?.[deal.handle]?.total;
  await sessions.patch(ctx.session.id, {
    lastShown: {
      kind: 'pack',
      // Step order, so a swap knows which step each piece fills.
      items: pieces.map((piece, index) => ({ id: piece?.id ?? '', title: piece?.title ?? '', slot: deal.steps[index]!.title })),
      query,
      bundle: deal.handle,
      // The colour it was built in, so a later swap of one piece keeps it.
      ...(fill.colour ? { colour: fill.colour } : {}),
    },
    // Remembered by pack, so going back to it - or changing it from another pack - finds this one.
    packInFocus: deal.handle,
    packsShown: {
      ...((await sessions.getOrCreate(ctx.session.id)).packsShown ?? {}),
      [deal.handle]: {
        items: pieces.map((piece) => ({ id: piece?.id ?? '', title: piece?.title ?? '' })),
        ...(fill.colour ? { colour: fill.colour } : {}),
        total: recommendation.total.amount,
      },
    },
    ...(deal.range !== 'kids' ? { preferences: { audience: deal.range } } : {}),
  });
  const lines = deal.steps
    .map((step, i) => `- ${step.title}: ${pieces[i] ? `${pieces[i]!.title} [${pieces[i]!.id}]` : 'none picked'}`)
    .join('\n');
  /*
   * Where the pack stands: what they have chosen, what is still open, and the
   * one thing to ask - see packState.ts. The spoken line is the price and that
   * one question; the card shows the pieces.
   */
  /*
   * The price spoken is the one they will pay. The Caddie said "Cool & Wet is
   * £159.99" and the card then showed £156 - these pieces cost less on their
   * own, and checkout charges that. The listed price is only explained if
   * they ask about it.
   */
  const name = titleCaseWords(deal.conditionTitle ? `${deal.conditionTitle} Ambassador Pack` : deal.title);
  const pays = recommendation.total.amount;
  const short = `${cheaperNote ? `This ${titleCaseWords(deal.conditionTitle ?? deal.title)} setup comes to ${pounds(pays)}.` : `The ${name} is ${deal.steps.length} pieces for ${pounds(pays)}.`} ${status?.ready ? 'Shall I add it to your basket?' : (status?.next ?? '')}`.trim();

  return {
    speech: blocked ? `The ${deal.title} isn't available just yet.` : short,
    facts:
      (blocked
        ? `Not available to buy yet (${blocked}). Say so lightly in one line - no apology, no error wording, never "out of stock" - and offer another pack. Never present its price as one they can pay or offer to add it.\n`
        : '') +
      (blocked ? '' : `${packPriceLine(deal.prices.GBP ?? 0, pays, own)}\n`) +
      // £132 on the card, a jacket swapped, £156 on the card - and nothing said until the basket.
      (!blocked && shownBefore !== undefined && Math.abs(shownBefore - pays) > 0.005
        ? `This change takes it from ${pounds(shownBefore)} to ${pounds(pays)} - say the new total, ${pounds(pays)}, in the reply.\n`
        : '') +
      (cheaperNote
        ? `${deal.title}: what they pay for this setup is ${pounds(pays)} - these pieces cost less on their own than the pack's listed price, and checkout charges the lower. Quote ${pounds(pays)}. Mention the listed ${pounds(deal.prices.GBP ?? 0)} only if they ask about it, and then once: "The pack is listed at ${pounds(deal.prices.GBP ?? 0)}, but these selected pieces total ${pounds(pays)}, so ${pounds(pays)} is what you would pay." There is no saving here - never say save, saving, discount or deal.\n`
        : `${deal.title} - ${pounds(pays)}, a fixed price for the whole pack (not the sum of the pieces). Never read out the pieces' own prices.\n`) +
      `Pieces, one per step:\n${lines}\n` +
      'To change one piece call recommend_pack with swap (and swapWith if they chose it). ' +
      'To buy it, call add_pack_to_cart once they have given sizes - never add the pieces one by one, or the pack price is lost.' +
      (status ? `\n${packStatusFacts(status)}` : ''),
    attachment: { kind: 'pack', recommendation },
  };
}

const packTool = defineTool({
  name: 'recommend_pack',
  description:
    'Build a pack of real Druids products. Pass the words the customer used as the query, including any weather or trip they mention: if they name a pack Druids sells - the Ambassador Pack, the Rainsuit Special - that pack comes back at its real price, or the question of which version. Call it straight away for a named pack; never ask for a budget first. Only with no pack named is a selection put together for their budget.',
  schema: packSchema,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      budgetAmount: { type: 'number' },
      currency: { type: 'string', description: "ISO code. Leave it out unless the customer names a currency - it defaults to the store's own." },
      colour: { type: 'string' },
      size: { type: 'string' },
      itemCount: { type: 'integer', minimum: 2, maximum: 6 },
      swap: { type: 'string', description: 'Id of the one pack piece to change. The rest of the pack stays.' },
      swapWith: { type: 'string', description: 'With swap: the product they chose instead - its id, or its exact name.' },
    },
    required: ['query'],
  },
  async run(args, ctx): Promise<ToolResult> {
    const picked = await pickFromPackChoices(ctx);
    if (picked) return picked;
    const currency = args.currency ?? ctx.session.preferences.currency ?? storeCurrency();
    const statedBudget = ctx.session.shopper?.budget;
    const budgetAmount =
      args.budgetAmount ?? (statedBudget?.per === 'total' ? statedBudget.amount : undefined) ?? ctx.session.preferences.budgetAmount;
    // Named in their words counts, whether or not the model passed it on.
    /*
     * A colour only when the customer gave one. "The cool and wet pack" came
     * back all blue: the model passed a colour nobody had said. Their last few
     * messages count, a standing colour counts, and so does another language -
     * the model translates "azul" to blue.
     */
    const recent = [...ctx.session.messages.filter((m) => m.role === 'user').slice(-3).map((m) => m.text), ctx.utterance ?? ''].join(' ');
    const colourGiven =
      parseColours(recent).colours.length > 0 ||
      !!ctx.session.shopper?.colours ||
      !!ctx.session.preferences.colour ||
      /[^\x00-\x7F]/.test(ctx.utterance ?? '');
    const askedColour = colourGiven ? colourAsked(args.colour, args.query) : undefined;
    if (!colourGiven && (args.colour || parseColours(args.query).colours.length)) {
      log.warn('pack.colour_not_given', { sessionId: ctx.session.id, colour: args.colour ?? args.query });
    }
    const colour = askedColour ?? ctx.session.preferences.colour;

    const deal = await dealAnswer(args, ctx, colour, currency);
    if (deal) return deal;

    /*
     * A pack Druids actually sells is a different answer to a selection put
     * together for a budget. "What is in the Ambassador Pack" is a question
     * about a real product with a real price, so it is answered from that
     * product rather than by assembling something that costs about the same.
     */
    /*
     * A bundle Druids sells that this store does not carry. Checked first,
     * because otherwise the budget assembler answers it: "the Prestige Pack
     * includes three items and costs £92" was a real reply, about a pack that
     * is not in the store, at a price that is not its own.
     */
    const unstocked = findUnstockedBundle(args.query);
    if (unstocked) {
      return {
        speech: `I cannot pull up the ${unstocked.name} - I do not have its contents or its price to hand, so I would rather not guess at them. The team on the website can tell you. Shall I show you what we do have instead?`,
        facts: `${unstocked.name} is a real Druids bundle, but it is not in this catalogue and we hold no price for it. Do not describe it, price it, or offer a substitute as though it were that pack.`,
      };
    }

    const named = findNamedPack(args.query);
    if (named) {
      const real = await recommendNamedPack(named, {
        colour,
        size: args.size ?? ctx.session.sizeProfile.usualSize,
      });

      if (real?.pack) {
        await sessions.patch(ctx.session.id, {
          lastShown: {
            kind: 'pack',
            // The pack itself first, so "add it" means the pack and not the polo.
            items: [
              { id: real.pack.productId, title: real.pack.title },
              ...real.items.map((p) => ({ id: p.id, title: p.title })),
            ],
            query: args.query,
            colour: askedColour,
          },
          preferences: { colour: askedColour, currency, audience: audienceOf(real.items) },
        });

        return {
          speech: real.reason,
          facts: `${real.pack.title} [${real.pack.productId}] - ${money(
            real.pack.price.amount,
            real.pack.price.currency,
          )}, the price of the pack and not the sum of its pieces.
Filling it from stock:
${listFacts(real.items)}`,
          attachment: { kind: 'pack', recommendation: real },
        };
      }
    }

    const recommendation = await recommendPack({
      query: args.query,
      colour,
      size: args.size ?? ctx.session.sizeProfile.usualSize,
      itemCount: args.itemCount,
      ...(budgetAmount !== undefined ? { budget: { amount: budgetAmount, currency } } : {}),
    }, knownRange(ctx));

    await sessions.patch(ctx.session.id, {
      lastShown: {
        kind: 'pack',
        items: recommendation.items.map((p) => ({ id: p.id, title: p.title })),
        query: args.query,
        budgetAmount,
        colour: askedColour,
      },
      preferences: { colour: askedColour, budgetAmount, currency, audience: audienceOf(recommendation.items) },
    });

    if (recommendation.items.length === 0) return { speech: recommendation.reason };
    return {
      speech: `${recommendation.reason} That comes to ${money(
        recommendation.total.amount,
        recommendation.total.currency,
      )}.`,
      facts: `Pack contents:
${listFacts(recommendation.items)}`,
      attachment: { kind: 'pack', recommendation },
    };
  },
});

/* ---------------- recommend_outfit ---------------- */

const OUTFIT_PIECES = ['top', 'bottom', 'layer', 'accessory'] as const;

const outfitSchema = z.object({
  seed: z.string().min(1).describe('The item or occasion the outfit is built around'),
  pieces: z.array(z.enum(OUTFIT_PIECES)).optional(),
  swap: z.string().optional(),
  swapWith: z.string().optional(),
  budgetAmount: z.number().positive().optional(),
  currency: z.string().length(3).optional(),
  colour: z.string().optional(),
  size: z.string().optional(),
});

/** The model sometimes drops the gid:// prefix when it copies an id back. */
function sameProduct(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

/**
 * The outfit on screen, as pieces a swap can keep.
 *
 * Only ids and slots are held on the session, so the products are read back
 * from the mirror. Anything that has since gone - deleted, or no longer in
 * the catalogue - is simply rebuilt with the swapped slot.
 */
/**
 * The outfit they are working on: the one on screen, or the last one built.
 *
 * Not only lastShown. Asked to "swap the polo for a plain white one", the
 * model searched for a plain white polo first - which replaced what was on
 * screen - and then asked for the swap. The outfit was gone, so it was
 * rebuilt from nothing: the trousers vanished in one run and turned white in
 * another, while the reply said they were unchanged.
 */
function outfitShown(ctx: ToolContext): CaddieSession['lastShown'] {
  const shown = ctx.session.lastShown;
  return shown?.kind === 'outfit' ? shown : ctx.session.lastOutfit;
}

async function outfitOnScreen(ctx: ToolContext): Promise<OutfitPiece[]> {
  const shown = outfitShown(ctx);
  if (shown?.kind !== 'outfit') return [];
  const pieces = await Promise.all(
    shown.items.map(async (item) => {
      if (!item.slot) return null;
      const product = await getProductDetails(item.id);
      return product ? { slot: item.slot, product } : null;
    }),
  );
  return pieces.filter((piece): piece is OutfitPiece => piece !== null);
}

const outfitTool = defineTool({
  name: 'recommend_outfit',
  description:
    'Build an outfit from real Druids products around an item or an occasion. Use when the customer wants a full look, or several garments that go together. ' +
    'Pass `pieces` when they name the garments they want ("polos and trousers" is ["top", "bottom"]) - only those are included. Leave it out for an occasion with nothing named, which gets the full look. ' +
    'To change one piece of the outfit on screen ("swap the polo", "a different pair of trousers"), pass `swap` with that product id: the rest of the outfit stays and only that piece is replaced. If they chose what goes in its place, pass that product id as `swapWith`.',
  schema: outfitSchema,
  parameters: {
    type: 'object',
    properties: {
      seed: { type: 'string' },
      pieces: {
        type: 'array',
        items: { type: 'string', enum: [...OUTFIT_PIECES] },
        description: 'Only these parts of the outfit. top = polos and shirts, bottom = trousers and shorts, layer = midlayers, hoodies, gilets, jackets, accessory = socks, caps, beanies.',
      },
      swap: { type: 'string', description: 'Id of the one outfit piece to replace. Everything else in the outfit stays.' },
      swapWith: {
        type: 'string',
        description: 'The product the customer chose: with swap, what goes in its place; with no outfit on screen, what to build the outfit around. Its id if you have seen it, otherwise its exact name. Never an id you have not seen.',
      },
      budgetAmount: { type: 'number' },
      currency: { type: 'string' },
      colour: { type: 'string' },
      size: { type: 'string' },
    },
    required: ['seed'],
  },
  async run(args, ctx): Promise<ToolResult> {
    const currency = args.currency ?? ctx.session.preferences.currency ?? storeCurrency();
    const budgetAmount = args.budgetAmount ?? ctx.session.preferences.budgetAmount;
    const askedColour = colourAsked(args.colour, args.seed, args.swap ? outfitShown(ctx)?.query : undefined);
    const colour = askedColour ?? ctx.session.preferences.colour;
    const input = {
      seed: args.seed,
      colour,
      size: args.size ?? ctx.session.sizeProfile.usualSize,
      ...(budgetAmount !== undefined ? { budget: { amount: budgetAmount, currency } } : {}),
    };

    /*
     * A swap is the same outfit with one piece changed, built by us - not a
     * fresh search. Left to the model, "swap the polo" became a product
     * search that showed the same polo again, alongside the Ambassador Pack.
     */
    /*
     * A swap the model did not call a swap. Told "swap the orange polo for a
     * solid navy one" with an outfit on screen, it sometimes asked for a fresh
     * outfit around "solid navy polo" - and the trousers vanished. Their own
     * words decide: asking to swap, and naming exactly one piece on screen.
     */
    const swapWords = /\b(swap|swop|replace|instead|change|exchange)\b/i.test(ctx.utterance ?? '');
    const wantsSwap = !!(args.swap || args.swapWith) || (swapWords && outfitShown(ctx)?.kind === 'outfit');
    const onScreen = wantsSwap ? await outfitOnScreen(ctx) : [];
    const mentioned = namedSlots(ctx.utterance ?? '');
    const impliedSwap =
      !args.swap && !args.swapWith && swapWords ? onScreen.filter((piece) => mentioned.includes(piece.slot)) : [];

    /*
     * The customer's own pick for that slot - "I like the navy one, put it in
     * instead" - goes in as chosen rather than being searched for again.
     */
    const chosen = args.swapWith ? await getProductDetails(args.swapWith) : null;
    // They picked one and we cannot find it: say so. Quietly putting in a
    // different polo would answer a question they did not ask.
    if (args.swapWith && !chosen) {
      return {
        speech: 'I could not find that exact product to put in the outfit.',
        facts: `"${args.swapWith}" is not a product id or an exact product name in the catalogue. Find it with search_products, then call recommend_outfit again with its id as swapWith. Do not guess an id.`,
      };
    }
    /*
     * A pick that contradicts what they asked for is not their pick. Asked to
     * "swap the polo for a navy one", the model passed the orange polo already
     * in their basket as the piece to build around, and the customer got
     * orange. The colour they named wins; the model is told to find one.
     */
    if (chosen && colour && matchesColourText(chosen, colour) === 0) {
      return {
        speech: `The ${chosen.title} is not ${colour}, so I have not put it in. Let me find a ${colour} one instead.`,
        facts: `${chosen.title} does not match the colour asked for (${colour}). Search for a ${colour} piece with search_products, then call recommend_outfit with that product's id as swapWith. Never swap in the piece they asked to replace.`,
      };
    }

    /*
     * The piece going out: the one named, or else the one in the slot their
     * pick belongs to. Given a white polo and no "swap", the tool used to
     * build a new outfit from the words "white polo" - one polo, trousers gone.
     */
    const named = (piece: OutfitPiece) =>
      sameProduct(piece.product.id, args.swap ?? '') ||
      // The model passes names as often as ids; a title match is as exact.
      (!!args.swap && piece.product.title.toLowerCase().replace(/\s+/g, '') === args.swap.toLowerCase().replace(/\s+/g, ''));
    if (args.swap && onScreen.length && !onScreen.some(named) && !chosen) {
      // Never quietly rebuild the whole outfit because one reference missed:
      // that turned a customer's trousers into navy shorts.
      return {
        speech: 'I could not tell which piece of the outfit to change - which one did you mean?',
        facts: `"${args.swap}" is not in the outfit on screen. Its pieces:\n${onScreen
          .map((piece) => `- ${piece.slot}: ${piece.product.title} [${piece.product.id}]`)
          .join('\n')}\nCall recommend_outfit again with swap set to one of these ids.`,
      };
    }
    const outgoing =
      onScreen.find(named) ??
      (chosen
        ? onScreen.find((piece) => {
            const slot = DEFAULT_SLOTS.find((entry) => entry.slot === piece.slot);
            return slot ? fitsSlot(chosen, slot) : false;
          })
        : undefined) ??
      // Exactly one piece named in a swap request; two is a question, not a guess.
      (impliedSwap.length === 1 ? impliedSwap[0] : undefined);
    const swappedOut = outgoing
      ? [...(outfitShown(ctx)?.swappedOut ?? []), outgoing.product.id]
      : [];
    const keep = onScreen.filter((piece) => piece !== outgoing);
    if (outgoing && chosen) keep.push({ slot: outgoing.slot, product: chosen });

    /*
     * Their pick with no outfit on screen to swap it into: the outfit is built
     * around it. Otherwise "put the Vento polo in the outfit" built a fresh
     * outfit with an orange polo, and the model told them it had used the
     * Vento.
     */
    let slots = slotsFor(args.seed, args.pieces, ctx.utterance);
    if (chosen && !outgoing) {
      const home = DEFAULT_SLOTS.find((slot) => fitsSlot(chosen, slot));
      if (home) {
        keep.push({ slot: home.slot, product: chosen });
        if (!slots.some((slot) => slot.slot === home.slot)) {
          slots = DEFAULT_SLOTS.filter((slot) => slot.slot === home.slot || slots.some((s) => s.slot === slot.slot)).map(
            (slot) => slots.find((s) => s.slot === slot.slot) ?? slot,
          );
        }
      }
    }

    const shopper = ctx.session.shopper;
    const weather = readIntent(ctx.utterance ?? '').weather ?? shopper?.weather;
    const turnedDown = shopper?.rejected ?? [];
    const aim = shopper?.budget?.per === 'total' && shopper.budget.kind === 'around' && budgetAmount === shopper.budget.amount;
    const recommendation = outgoing
      ? await recommendOutfit(
          { ...input, seed: outfitShown(ctx)?.query ?? args.seed },
          // The same slots as before, in the same order, narrowed as before.
          slotsFor(outfitShown(ctx)?.query ?? args.seed, onScreen.map((piece) => piece.slot), ctx.utterance),
          { keep, exclude: [...swappedOut, ...turnedDown], aim, ...(weather ? { weather } : {}), ...(knownRange(ctx) ? { known: knownRange(ctx) } : {}) },
        )
      : await recommendOutfit(input, slots, {
          keep,
          exclude: turnedDown,
          aim,
          ...(weather ? { weather } : {}),
          ...(knownRange(ctx) ? { known: knownRange(ctx) } : {}),
        });
    // Swapped out is turned down: it is never offered again this session.
    if (outgoing && outgoing.product.id !== chosen?.id) await rememberShopper(ctx.session.id, { rejected: [outgoing.product.id] });
    if (chosen) await rememberShopper(ctx.session.id, { liked: [chosen.id] });

    const shownOutfit = {
      kind: 'outfit' as const,
      items: recommendation.pieces.map((piece) => ({
        id: piece.product.id,
        title: piece.product.title,
        slot: piece.slot,
      })),
      query: outgoing ? (outfitShown(ctx)?.query ?? args.seed) : args.seed,
      budgetAmount,
      colour: askedColour,
      ...(swappedOut.length ? { swappedOut } : {}),
    };
    await sessions.patch(ctx.session.id, {
      lastShown: shownOutfit,
      lastOutfit: shownOutfit,
      // What they were shown decides the range, so "what size am I" does not ask mens or womens again.
      preferences: { colour: askedColour, budgetAmount, currency, audience: audienceOf(recommendation.pieces.map((piece) => piece.product)) },
    });

    if (outgoing && !recommendation.pieces.some((piece) => piece.slot === outgoing.slot)) {
      return {
        speech: `I could not find another ${outgoing.slot} that fits the brief, so I have left it out rather than show you the same one again.`,
        facts: `No alternative found for ${outgoing.product.title}. The rest of the outfit is unchanged.`,
        attachment: { kind: 'outfit', recommendation },
      };
    }

    if (recommendation.pieces.length === 0) return { speech: recommendation.reason };

    /*
     * Swapped in the outfit, but already bought. The outfit on screen is a
     * suggestion; the basket is what they pay for. Leaving the old polo there
     * silently is how a customer ended up with both.
     */
    const inBasket = outgoing
      ? (ctx.session.basket ?? []).find((line) => sameProduct(line.productId, outgoing.product.id))
      : undefined;
    /*
     * When they chose the new piece themselves, "swap this orange polo" means
     * the one they bought as well - in the size they bought it in. Done here
     * rather than left to the model, which was told to offer it and did not.
     * Only when exactly one in-stock variant fits that size (and the colour
     * they asked for); otherwise ask. A tool-picked "something else" never
     * touches the basket.
     */
    let basketSpeech = '';
    let basketNote = '';
    if (inBasket && outgoing) {
      const placed = recommendation.pieces.find((piece) => piece.slot === outgoing.slot)?.product;
      const theirPick = chosen && placed && sameProduct(placed.id, chosen.id) ? chosen : null;
      const sizes = inBasket.variantTitle.split('/').map((part) => part.trim().toLowerCase());
      const wantedColours = colour ? parseColours(colour).colours : [];
      const fits = theirPick
        ? theirPick.variants.filter(
            (variant) =>
              variant.available &&
              Object.entries(variant.options).every(([name, value]) =>
                /size/i.test(name) ? sizes.includes(value.toLowerCase()) : true,
              ) &&
              (wantedColours.length === 0 ||
                colourMatch({ ...theirPick, title: '', variants: [variant] }, wantedColours) > 0),
          )
        : [];

      if (theirPick && fits.length === 1 && fits[0]) {
        const swapped = await runTool(
          'add_to_cart',
          { productId: theirPick.id, options: fits[0].options, replaces: outgoing.product.id },
          ctx,
        );
        basketSpeech = ` In your basket too: ${swapped.speech}`;
        basketNote = swapped.facts ? `\n${swapped.facts}` : '';
      } else if (theirPick) {
        basketSpeech = ` The ${outgoing.product.title} is still in your basket - which size would you like the ${theirPick.title} in, so I can swap it there too?`;
      } else {
        basketSpeech = ` The ${outgoing.product.title} you added is still in your basket - shall I swap it there as well?`;
        basketNote = `\nThe ${outgoing.product.title} is still in their basket [line ${inBasket.lineId}]; this only changed the outfit.`;
      }
    }
    return {
      facts: `Outfit pieces:\n${recommendation.pieces
        .map((piece) => `- ${piece.slot}: ${piece.product.title} [${piece.product.id}]`)
        .join('\n')}${basketNote}`,
      // In the words, not only the facts: left to the facts, the model skipped it.
      speech: `${recommendation.reason} The full look is ${money(
        recommendation.total.amount,
        recommendation.total.currency,
      )}.${basketSpeech}`,
      attachment: { kind: 'outfit', recommendation },
    };
  },
});

/* ---------------- cart tools ---------------- */

/**
 * Takes a product and the chosen options, never a variant id.
 *
 * Models invent variant ids. Asked to "add the shorts in large" it will
 * confidently pass a plausible-looking id it has never seen, and Shopify
 * rejects it - or worse, it matches something real and the customer gets the
 * wrong item. Resolving the variant here makes that impossible: an id that was
 * never on screen fails a lookup instead.
 */
const addToCartSchema = z.object({
  productId: z.string().min(1).describe('A product id from a search, recommendation or details call'),
  options: z
    .record(z.string())
    .optional()
    .describe('The size and colour the customer chose, e.g. { "Size": "L" }'),
  quantity: z.number().int().min(1).max(10).optional(),
  replaces: z.string().optional(),
});

const addToCartTool = defineTool({
  name: 'add_to_cart',
  description:
    'Add a product to the customer basket. Pass the product id and the options they chose, such as size. Never guess the size for them - but do not ask for one before calling this: many products (socks, belts) come in one size, and this tool says exactly what is still needed. The product id must be one you have seen in this conversation. ' +
    'When it takes the place of something already in the basket - "swap the orange polo for this one", "change my S to an M" - pass that basket item as `replaces` (its line id or product id). The old one is removed only once the new one is in.',
  schema: addToCartSchema,
  parameters: {
    type: 'object',
    properties: {
      productId: { type: 'string', description: 'A product id seen in this conversation, or the exact product name if you have not seen its id. Never make up an id.' },
      options: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Chosen options, e.g. { "Size": "L" }',
      },
      quantity: { type: 'integer', minimum: 1, maximum: 10 },
      replaces: {
        type: 'string',
        description: 'Line id or product id of the basket item this one replaces. Leave out for a plain add.',
      },
    },
    required: ['productId'],
  },
  async run(args, ctx): Promise<ToolResult> {
    const picked = await pickFromPackChoices(ctx);
    if (picked) return picked;
    /*
     * What they picked on this product's card, when their words now name no
     * size: "add it" after tapping M is M - over the size the model reached
     * for from their profile. A size they say now always wins.
     */
    /*
     * "Add it", straight after tapping a size on a card, is that card's
     * product - whatever the model reached for. It once added the jacket it
     * had just recommended rather than the one the customer had tapped. Only
     * for a bare reference: "add that black jacket" names something, and is
     * the model's to resolve.
     */
    const tappedId = tappedSinceLastSaid(ctx.session);
    const tapped = tappedId ? productById(tappedId) : null;
    const proposed = productById(args.productId) ?? (/^(gid:\/\/|\d+$)/.test(args.productId.trim()) ? null : resolveProduct(ctx.session, args.productId)?.product ?? null);
    if (tapped && proposed?.id !== tapped.id && bareReference(ctx.utterance ?? '')) {
      log.warn('cart.it_is_the_tapped_card', { sessionId: ctx.session.id, proposed: proposed?.id ?? args.productId, tapped: tapped.id });
      args = { ...args, productId: tapped.id };
    }
    const onCard = tapped && args.productId === tapped.id ? tapped : proposed;
    const card = onCard ? ctx.session.cardChoices?.[onCard.id] : undefined;
    const saysSize = !!sizeInRequest(ctx.utterance ?? '');
    const options: Record<string, string> | undefined =
      card && !saysSize
        ? {
            ...Object.fromEntries(Object.entries(args.options ?? {}).filter(([name]) => !Object.keys(card.options).some((picked) => picked.toLowerCase() === name.toLowerCase()))),
            ...card.options,
          }
        : args.options;
    if (card && !saysSize) log.info('cart.card_choice_used', { sessionId: ctx.session.id, productId: onCard!.id, options: card.options });
    // A size nobody said is a guess, and a guessed size in the basket is the one rule that does not bend.
    const invented = sizesNeverGiven(sizeValues(options), ctx, onCard?.id ?? args.productId);
    if (invented.length) {
      log.warn('cart.size_not_given', { sessionId: ctx.session.id, sizes: invented });
      return {
        speech: 'What size would you like?',
        facts: `Nothing was added. The customer never gave ${invented.join(', ')} - never choose a size for them. Ask, then add with the size they say.`,
      };
    }
    let product = await getProductDetails(args.productId, options);
    // "The second one", "the navy one": what they can see, not an id to guess.
    if (!product && !/^(gid:\/\/|\d+$)/.test(args.productId.trim())) {
      const seen = resolveProduct(ctx.session, args.productId);
      if (seen) product = await getProductDetails(seen.product.id, options);
    }
    if (!product) {
      return { speech: 'I could not find that product. Let me search again rather than guess.' };
    }

    /*
     * Which choices are still open - measured against what they actually
     * named, not against how many things they named.
     *
     * Counting was the bug. A customer who says "large" on a polo that comes
     * in six colours has chosen one of two things, and the old check saw a
     * non-zero count and went ahead; variants[0] then picked their colour for
     * them. The test store hides this completely - colour is baked into the
     * product title there and every product carries a single option - but the
     * real store has Size and Colour on nearly everything.
     */
    const named = new Set(Object.keys(options ?? {}).map((key) => key.toLowerCase()));
    const stillOpen = product.options.filter(
      (option) => option.values.length > 1 && !named.has(option.name.toLowerCase()),
    );

    if (stillOpen.length > 0) {
      return {
        speech: `Which ${stillOpen.map((option) => option.name.toLowerCase()).join(' and ')} would you like for the ${product.title}?`,
        facts: `${product.title} needs a choice:\n${stillOpen
          .map((option) => `- ${option.name}: ${option.values.join(', ')}`)
          .join('\n')}`,
      };
    }

    /*
     * Every option named and more than one garment still matching means the
     * choices did not identify one. Ask again rather than take the first: a
     * wrong colour in the basket is a return, and the customer does not find
     * out until it arrives.
     */
    if (product.variants.length > 1) {
      return {
        speech: `I want to be certain which ${product.title} you mean before I add it - could you confirm the ${product.options
          .map((option) => option.name.toLowerCase())
          .join(' and ')}?`,
        facts: `${product.variants.length} variants still match for ${product.title}. Do not choose one for them.`,
      };
    }

    const variant = product.variants[0];
    if (!variant) {
      return { speech: `I could not find that combination for the ${product.title}.` };
    }
    if (!variant.available) {
      const choice = Object.values(variant.options).join(', ');
      return {
        speech: `The ${product.title} in ${choice} is out of stock. Shall I check another size?`,
        facts: `Unavailable variant: ${product.title} ${choice}. Other options: ${product.options
          .map((option) => `${option.name}: ${option.values.join(', ')}`)
          .join('; ')}`,
      };
    }

    /*
     * Chosen is liked; what it replaces is turned down. The next suggestion is
     * worked out now, from what they actually chose - never offered after
     * "just the jacket".
     */
    const replacedIds = args.replaces
      ? (ctx.session.basket ?? [])
          .filter((line) => line.lineId === args.replaces || sameProduct(line.productId, args.replaces ?? ''))
          .map((line) => line.productId)
          .filter((id) => !sameProduct(id, product.id))
      : [];
    const shopper = await rememberShopper(ctx.session.id, { liked: [product.id], ...(replacedIds.length ? { rejected: replacedIds } : {}) });
    const next = await nextStep([product], {
      profile: shopper,
      basketProductIds: (ctx.session.basket ?? []).map((line) => line.productId),
    });
    const nextLine = next ? `\n${next.line}` : '';

    /*
     * On the storefront the basket is the theme's cart, in the shopper's
     * browser: the widget makes the change. Everything above - the variant,
     * its stock, the choices still open - is decided here as before.
     */
    if (ctx.session.cartMode === 'theme') {
      const outgoingLines = args.replaces
        ? (ctx.session.basket ?? []).filter(
            (line) =>
              line.lineId === args.replaces || (sameProduct(line.productId, args.replaces ?? '') && !sameProduct(line.productId, product.id)),
          )
        : [];
      const choice = Object.values(variant.options).filter((value) => value !== 'Default Title').join(', ');
      return {
        speech: outgoingLines.length
          ? `Swapping the ${outgoingLines.map((line) => line.title).join(' and ')} for the ${product.title}${choice ? ` in ${choice}` : ''}.`
          : `Adding the ${product.title}${choice ? ` in ${choice}` : ''} to your basket.`,
        facts: `The widget makes this change in the store cart and shows the basket once it has. Say it is going in, not that the basket now holds it.${nextLine}`,
        actions: [
          {
            type: 'add',
            lines: [{ variantId: numericId(variant.id), quantity: args.quantity ?? 1 }],
            ...(outgoingLines.length ? { removeKeys: outgoingLines.map((line) => line.lineId) } : {}),
          },
        ],
      };
    }

    let cart = await addToCart(ctx.session.cartId, variant.id, args.quantity ?? 1);
    await sessions.patch(ctx.session.id, { cartId: cart.id });

    /*
     * A swap, removed only now that the new piece is safely in. The other way
     * round, a failed add would leave the customer with neither. Matching by
     * product as well as line lets "change my S to an M" work: every other
     * line of that product goes, the one just added stays.
     */
    const outgoing = args.replaces
      ? cart.lines.filter(
          (line) =>
            line.variantId !== variant.id &&
            (line.lineId === args.replaces || sameProduct(line.productId, args.replaces ?? '')),
        )
      : [];
    for (const line of outgoing) {
      cart = await setLineQuantity(cart.id, line.lineId, 0);
    }

    const total = `Your basket is ${money(cart.subtotal.amount, cart.subtotal.currency)} for ${cart.totalQuantity} ${
      cart.totalQuantity === 1 ? 'item' : 'items'
    }.`;
    const speech = outgoing.length
      ? `Swapped the ${outgoing.map((line) => line.title).join(' and ')} for the ${product.title}. ${total}`
      : args.replaces
        ? `Added the ${product.title}, but I could not find the item it was replacing in your basket, so nothing was removed. ${total}`
        : `Added. ${total}`;
    return { speech, facts: `${cartFacts(cart)}${nextLine}`, attachment: { kind: 'cart', cart } };
  },
});

const updateCartSchema = z.object({
  lineId: z.string().min(1),
  quantity: z.number().int().min(0).max(10).describe('0 removes the line'),
});

const updateCartTool = defineTool({
  name: 'update_cart_item',
  description: 'Change the quantity of a basket line, or remove it by setting quantity to 0.',
  schema: updateCartSchema,
  parameters: {
    type: 'object',
    properties: {
      lineId: { type: 'string' },
      quantity: { type: 'integer', minimum: 0, maximum: 10 },
    },
    required: ['lineId', 'quantity'],
  },
  async run(args, ctx): Promise<ToolResult> {
    if (ctx.session.cartMode === 'theme') {
      const lines = ctx.session.basket ?? [];
      const line = lines.find((entry) => entry.lineId === args.lineId);
      if (!line) return { speech: 'I cannot find that in your basket.', facts: cartSummary(lines) };
      /*
       * A pack is priced as a whole. Taking one piece out leaves the rest
       * marked as a bundle the discount no longer matches, so they would
       * quietly go back to full price - it comes out whole, and says so.
       */
      if (line.bundle) {
        const pack = lines.filter((entry) => entry.bundle === line.bundle);
        if (args.quantity === 0) {
          return {
            speech: `That piece is part of a pack, so I have taken the whole pack out - ${pack.length} pieces.`,
            actions: pack.map((entry) => ({ type: 'change' as const, lineKey: entry.lineId, quantity: 0 })),
          };
        }
        return { speech: 'Pieces in a pack come one of each - to change one, rebuild the pack instead.' };
      }
      return {
        speech: args.quantity === 0 ? `Taking the ${line.title} out of your basket.` : `Changing the ${line.title} to ${args.quantity}.`,
        actions: [{ type: 'change', lineKey: line.lineId, quantity: args.quantity }],
      };
    }
    if (!ctx.session.cartId) return { speech: 'There is nothing in your basket yet.' };
    // Quantity 0 removes the line - setLineQuantity handles both cases.
    const cart = await setLineQuantity(ctx.session.cartId, args.lineId, args.quantity);
    return {
      speech: `Basket updated - ${money(cart.subtotal.amount, cart.subtotal.currency)}.`,
      facts: cartFacts(cart),
      attachment: { kind: 'cart', cart },
    };
  },
});

/* ---------------- other_colours ---------------- */

/** One garment's colours, said the way the Caddie speaks: a short list, or a count - never a long list read aloud. */
function singleGarmentLine(product: Product, buyable: (product: Product) => boolean = () => true): string {
  const name = garmentName(product.title).toUpperCase();
  const ways = [product, ...otherColourways(product)].filter(buyable);
  if (ways.length > 4) return `The ${name} comes in ${ways.length} colourways - they are all on screen.`;
  return `The ${name} comes in ${ways.map((p) => colourwayName(p.title).toLowerCase()).join(', ')} - they are on screen.`;
}

const otherColoursSchema = z.object({ productId: z.string().optional(), colour: z.string().optional() });

/**
 * "Show me other colours" - of what they are looking at.
 *
 * A salesperson does not ask "which product?" about the jacket in the
 * customer's hand. The product is the one named, else the page they are on,
 * else what is on screen - every garment there, in its other colours.
 */
const otherColoursTool = defineTool({
  name: 'other_colours',
  description:
    'Show the other colours of a garment - Druids lists each colourway as its own product. ' +
    'Pass productId when they mean one product. Leave it out for "other colours" of what they are looking at: the product page they are on, or everything on screen. Do not ask which product first.',
  schema: otherColoursSchema,
  parameters: {
    type: 'object',
    properties: {
      productId: { type: 'string', description: 'A product id or exact name. Leave out for the page or the screen.' },
      colour: {
        type: 'string',
        description: 'For "does it come in green?": the colour, in English. Shades count - lime is green, navy is blue.',
      },
    },
    required: [],
  },
  async run(args, ctx): Promise<ToolResult> {
    let named = args.productId ? await getProductDetails(args.productId) : null;
    const page = ctx.session.page?.productId ? productById(ctx.session.page.productId) : null;
    let screen = (ctx.session.lastShown?.items ?? []).map((item) => (item.id ? productById(item.id) : null)).filter((p): p is Product => !!p);
    /*
     * "Different colours" is of what they are shopping for now. Asked on
     * polos, with the jacket cards from before still on screen, the model
     * passed the Clima Jacket and its colours came back. On a follow-up the
     * model's pick must be of the kind in focus, and so must the cards used.
     */
    const focus = ctx.session.activeShoppingContext;
    const followUp = isFollowUp(ctx.utterance ?? '') && !!focus?.kinds.length;
    let pageInFocus = page;
    if (followUp) {
      if (named && !inFocus(named, focus)) {
        log.warn('focus.model_pick_off_focus', { sessionId: ctx.session.id, tool: 'other_colours', proposed: named.title, focus: describeFocus(focus) });
        named = null;
      }
      const held = focusProduct(focus);
      if (!named && held && inFocus(held, focus)) named = held;
      screen = screen.filter((product) => inFocus(product, focus));
      if (page && !inFocus(page, focus)) pageInFocus = null;
      // Nothing of theirs to show the colours of: search what they are shopping for.
      if (!named && !pageInFocus && screen.length === 0) {
        log.info('focus.searched_instead', { sessionId: ctx.session.id, tool: 'other_colours', focus: describeFocus(focus) });
        return runTool('search_products', { query: focusQuery(focus!) }, ctx);
      }
    }
    const subjects = named ? [named] : pageInFocus ? [pageInFocus] : screen;
    if (subjects.length === 0) {
      return { speech: 'Which piece would you like to see in other colours?' };
    }

    // One of each garment, then all of its other colours.
    const seen = new Set<string>();
    const garments = subjects.filter((product) => {
      const key = garmentName(product.title);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    /*
     * Only colours they can buy, in their size. With S as their size, "other
     * colours" of the Elite Polo showed grey, sage, lavender and jade - sold
     * out in S, so each card opened on a Sold out button. Their top size and
     * their waist are each checked on the scale they apply to; a size a
     * product is not sized in (S on trousers) rules nothing out.
     */
    const theirs = shopperSizes(ctx.session);
    const buyable = (product: Product) =>
      product.variants.some((variant) => variant.available) &&
      [theirs?.size, theirs?.waist].every((size) => !size || !['sold-out', 'not-made'].includes(sizeStatus(product, size)));
    const all = garments.flatMap((product) => [product, ...otherColourways(product)]);
    const every = all.filter(buyable);
    if (every.length === 0) {
      const subject = garmentName(garments[0]!.title).toUpperCase();
      const inSize = [theirs?.size, theirs?.waist].filter(Boolean).join(' / ');
      return {
        speech: `The ${subject} isn't in stock${inSize ? ` in ${inSize}` : ''} in any colour right now. Shall I find something similar that is?`,
        facts: `No colourway of ${subject} can be bought${inSize ? ` in ${inSize}` : ''} - none were shown. Never offer or show a sold-out colour.`,
      };
    }
    if (every.length < all.length) log.info('colours.sold_out_hidden', { sessionId: ctx.session.id, hidden: all.filter((product) => !buyable(product)).map((product) => product.title), size: theirs?.size ?? null, waist: theirs?.waist ?? null });

    /*
     * "Does it come in green?" is answered with the same colour rules as
     * search. Left to the model, it said no to a polo that comes in
     * white/lime.
     */
    if (args.colour) {
      const colour = args.colour;
      const inColour = every.filter((product) => matchesColourText(product, colour) > 0);
      const subject = garmentName(garments[0]!.title).toUpperCase();
      if (inColour.length === 0) {
        return {
          speech: `We do not have the ${subject} in ${colour} - it comes in ${every.length} other colourways. Shall I show you them?`,
          facts: `Colourways in stock, for you only - do not read them out: ${every.map((p) => colourwayName(p.title)).join(', ')}.`,
        };
      }
      await sessions.patch(ctx.session.id, {
        lastShown: { kind: 'products', items: inColour.map((p) => ({ id: p.id, title: p.title })), query: `${subject} in ${colour}` },
      });
      const shades = inColour.map((p) => colourwayName(p.title).toLowerCase()).join(' and ');
      return {
        speech: `Yes - the ${subject} comes in ${shades}. It is on screen.`,
        facts: `Say which shade it is when it is not the exact word they used.\n${listFacts(inColour)}`,
        attachment: { kind: 'products', products: inColour },
      };
    }

    const shown = every.slice(0, 12);
    // Counted and listed as shown: only the colours they can buy, never "11 colourways" above seven cards.
    const waysOf = (product: Product) => [product, ...otherColourways(product)].filter(buyable);
    const withOthers = garments.filter((product) => waysOf(product).length > 1);

    await sessions.patch(ctx.session.id, {
      lastShown: { kind: 'products', items: shown.map((product) => ({ id: product.id, title: product.title })), query: 'other colours' },
    });

    if (withOthers.length === 0) {
      return {
        speech:
          garments.length === 1
            ? `The ${garmentName(garments[0]!.title).toUpperCase()} only comes in ${colourwayName(garments[0]!.title).toLowerCase() || 'the one colour'} at the moment.`
            : 'None of these come in other colours at the moment.',
      };
    }
    const lines = withOthers.map(
      (product) =>
        `- ${garmentName(product.title).toUpperCase()}: ${waysOf(product).map((p) => colourwayName(p.title)).join(', ')}`,
    );
    return {
      speech:
        withOthers.length === 1
          ? singleGarmentLine(withOthers[0]!, buyable)
          : `Here are those in their other colours - they are on screen.`,
      facts: `Colourways in stock:\n${lines.join('\n')}\n${listFacts(shown)}`,
      attachment: { kind: 'products', products: shown },
    };
  },
});

/* ---------------- add_pack_to_cart ---------------- */

const addPackSchema = z.object({
  pack: z.string().optional(),
  size: z.string().optional(),
  options: z.record(z.string()).optional(),
  choices: z
    .array(z.object({ productId: z.string().min(1), options: z.record(z.string()) }))
    .optional(),
});

/**
 * The product's own name for an option, from the words the model used:
 * "leg" is LEG LENGTH, "waist" is WAIST SIZE, "size" is SIZE. Exact first,
 * then a shared word. Null when the product has no such option.
 */
function optionNamed(product: Product, key: string): string | null {
  const wanted = key.trim().toLowerCase();
  const exact = product.options.find((option) => option.name.toLowerCase() === wanted);
  if (exact) return exact.name;
  const words = wanted.split(/[\s_-]+/).filter((word) => word.length > 2);
  return (
    product.options.find((option) => words.some((word) => option.name.toLowerCase().split(/\s+/).includes(word)))?.name ?? null
  );
}

/** The option on a product that holds its size, whatever the store calls it. */
function sizeOptionName(product: Product): string | null {
  return product.options.find((option) => /size|waist/i.test(option.name) && option.values.length > 1)?.name ?? null;
}

const addPackTool = defineTool({
  name: 'add_pack_to_cart',
  description:
    'Add the bundle deal on screen (Ambassador Pack, Prestige Pack and the rest) to the basket as one pack, at its pack price. ' +
    'Pass `size` when one size fits every piece ("everything in L"), and `choices` for anything that differs or needs more than a size (trousers need waist and leg). ' +
    'Never add pack pieces with add_to_cart one by one - that loses the pack price.',
  schema: addPackSchema,
  parameters: {
    type: 'object',
    properties: {
      pack: { type: 'string', description: 'The deal by name ("prestige pack") when it is not already on screen.' },
      size: { type: 'string', description: 'One size for every piece that comes in sizes, e.g. "L".' },
      options: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Options for whichever pieces have them, e.g. { "waist": "34", "leg": "32" } for the trousers.',
      },
      choices: {
        type: 'array',
        description: 'Per piece: the product id and its chosen options, e.g. { "WAIST SIZE": "34", "LEG LENGTH": "32" }.',
        items: {
          type: 'object',
          properties: { productId: { type: 'string' }, options: { type: 'object', additionalProperties: { type: 'string' } } },
          required: ['productId', 'options'],
        },
      },
    },
    required: [],
  },
  async run(args, ctx): Promise<ToolResult> {
    const shown = ctx.session.lastShown;
    const onScreen =
      shown?.kind === 'pack' && shown.bundle ? allDeals().find((entry) => entry.handle === shown.bundle) : undefined;
    /*
     * "Add the Prestige Pack in L" with nothing on screen yet is a natural
     * thing to say, and it used to go nowhere. Named, and not the one on
     * screen, the pack is built here - one piece per step, in their size.
     */
    // An Ambassador Pack named without its conditions is the one on screen, never a guess at one.
    const weather = readIntent(ctx.utterance ?? '').weather ?? ctx.session.shopper?.weather;
    const choice = args.pack ? chooseDeal(`${args.pack} ${ctx.utterance ?? ''}`, dealRange(ctx), weather) : null;
    const named = choice && 'deal' in choice ? choice.deal : null;
    const deal = named && named.handle !== onScreen?.handle ? named : onScreen;
    if (!deal && choice && 'ask' in choice) {
      return {
        speech: `Which conditions is the Ambassador Pack for - ${choice.ask.map((d) => titleCaseWords(d.conditionTitle ?? d.title)).join(', ')}?`,
        facts: 'Ask which, then call recommend_pack with the condition to build it before adding.',
      };
    }
    if (!deal) return { speech: 'Which pack would you like - the Ambassador Pack, the Prestige Pack or another?' };
    /*
     * The pack as they last saw it, even after a search has taken the screen:
     * rebuilding it here swapped pieces they had never been shown. Built
     * fresh only when they have not seen it at all.
     */
    const seen = deal === onScreen && shown ? null : ctx.session.packsShown?.[deal.handle]?.items.map((item) => (item.id ? productById(item.id) : null));
    const built = deal === onScreen && shown ? null : seen?.length && seen.every(Boolean) ? null : fillDeal(deal, { size: ctx.session.sizeProfile.usualSize });
    if (built) await showDeal(deal, built, ctx, storeCurrency(), args.pack ?? deal.title);

    const products = built ?? seen ?? (shown?.items ?? []).map((item) => (item.id ? productById(item.id) : null));
    if (products.some((product) => !product)) {
      return { speech: `One of the ${deal.title} steps has nothing in stock that fits, so it is best finished on the pack page.`, facts: deal.url };
    }

    /*
     * Only what the customer chose. The model's size and options are
     * proposals: told "select the white clima trousers", it added the pack in
     * L, waist 34, leg 32 - sizes nobody had said. Their words this turn are
     * read into the pack's choices, then every piece is resolved from what is
     * confirmed - a real variant, in stock - or the one thing still open is
     * asked, and nothing is added. See packState.ts.
     */
    const fresh = await sessions.getOrCreate(ctx.session.id);
    const lastReply = [...fresh.messages].reverse().find((message) => message.role === 'assistant')?.text ?? '';
    const choices = readPackChoices(ctx.utterance ?? '', lastReply, products as Product[], fresh.packChoices?.[deal.handle] ?? {});
    await sessions.patch(ctx.session.id, { packChoices: { ...(fresh.packChoices ?? {}), [deal.handle]: choices } });
    const status = packStatus(await sessions.getOrCreate(ctx.session.id), deal.handle, products as Product[]);
    if (!status.ready) {
      return { speech: status.next, facts: `Nothing was added. ${packStatusFacts(status)}` };
    }
    const pieces = status.pieces.map((plan) => ({ product: plan.product, variant: plan.variant! }));

    if (ctx.session.cartMode !== 'theme') {
      return {
        speech: `The ${deal.title} price is applied in the store's own basket, so it is added from the pack page on the website.`,
        facts: `Pack page: ${deal.url}`,
      };
    }

    const bundle = toBundleDeal(deal, pieces.map((piece) => piece.product));

    /*
     * A condition pack is only added once checkout has been seen to charge its
     * pack price. Its price comes from a discount Function keyed on the pack's
     * trigger, and the theme ships triggers before the Function knows them:
     * Mixed Conditions and Cool & Wet priced at the sum of their pieces in a
     * test cart. Adding them would charge the customer something other than
     * what the Caddie just quoted.
     */
    // What they will actually pay: the pack price, or the pieces' own total when that is lower.
    let charge = deal.prices.GBP ?? 0;
    if (deal.format === 'plus') {
      const verdict = await packPriceHolds(deal, pieces.map((piece) => piece.variant.id));
      if (verdict === 'cheaper') charge = piecesTotal(pieces.map((piece) => piece.variant.id));
      if (verdict !== 'ok' && verdict !== 'cheaper') {
        const warm = allDeals().find((d) => d.range === deal.range && d.condition === 'warm' && d.handle !== deal.handle);
        return {
          speech:
            verdict === 'wrong'
              ? `I can't add the ${deal.title} at its £${deal.prices.GBP} pack price yet - the checkout isn't applying it.${warm ? ` I can add the ${warm.conditionTitle ? titleCaseWords(warm.conditionTitle) : warm.title} pack instead, or you can build it on the pack page.` : ' You can build it on the pack page.'}`
              : `I can't confirm the ${deal.title} price at checkout right now, so I would rather not add it. You can build it on the pack page.`,
          facts: `Checkout ${verdict === 'wrong' ? 'did not apply the pack price' : 'could not be checked'} for ${deal.title}. Nothing was added. Never say it was. Pack page: ${deal.url}`,
        };
      }
    }

    /*
     * The same pack again is a change to it, not a second one. Asked "L/XL for
     * the belt" after the pack had gone in, the Caddie added the whole
     * Ambassador Pack a second time. The old one is replaced - found both
     * from what the widget has reported and from what we have already sent,
     * since a quick follow-up can arrive before the basket is reported back.
     */
    const earlier = new Set<string>([
      ...(ctx.session.basket ?? []).filter((line) => line.bundleName === deal.handle && line.bundle).map((line) => line.bundle!),
      ...(ctx.session.packsAdded ?? []).filter((pack) => pack.handle === deal.handle).map((pack) => pack.bundleId),
    ]);
    const now = Date.now();
    const bundleId = newBundleId(now);
    await sessions.patch(ctx.session.id, {
      packsAdded: [
        ...(ctx.session.packsAdded ?? []).filter((pack) => pack.handle !== deal.handle),
        { handle: deal.handle, bundleId },
      ],
    });

    return {
      speech: earlier.size
        ? `Updating your ${deal.title} with those choices - still ${pieces.length} pieces for £${charge.toFixed(2)}.`
        : `Adding the ${deal.title} to your basket for ${pounds(charge)}.`,
      facts: earlier.size
        ? 'This replaces the pack already in their basket - there is still only one. The widget makes the change once you answer.'
        : 'The widget adds the pack to the store cart as one bundle and shows the basket once it has.',
      actions: [
        {
          type: 'add-bundle',
          bundle,
          bundleId,
          ...(earlier.size ? { replaceBundles: [...earlier] } : {}),
          pieces: pieces.map((piece) => ({
            variantId: numericId(piece.variant.id),
            productId: numericId(piece.product.id),
            price: piece.variant.price.amount,
            compareAtPrice: null,
            // The condition packs write the product handle on each line, as the theme does.
            handle: /\/products\/([^/?#]+)/.exec(piece.product.url)?.[1] ?? '',
          })),
        },
      ],
    };
  },
});

const viewCartTool = defineTool({
  name: 'view_cart',
  description: 'Read the current basket back to the customer.',
  schema: z.object({}),
  parameters: { type: 'object', properties: {}, required: [] },
  async run(_args, ctx): Promise<ToolResult> {
    if (ctx.session.cartMode === 'theme') {
      if (ctx.pendingActions) {
        return {
          speech: 'That is going into your basket now - it will show on screen in a moment.',
          facts: 'The basket changes from this reply have not been made yet: the widget makes them after you answer. Do not say the basket is empty or unchanged.',
        };
      }
      // The store cart as the widget last reported it - it sends it after every change.
      const lines = ctx.session.basket ?? [];
      if (lines.length === 0) return { speech: 'Your basket is empty at the moment.' };
      const count = lines.reduce((sum, line) => sum + line.quantity, 0);
      return { speech: `You have ${count} ${count === 1 ? 'item' : 'items'} in your basket - it is on screen.`, facts: cartSummary(lines) };
    }
    if (!ctx.session.cartId) return { speech: 'Your basket is empty at the moment.' };
    const cart = await getCart(ctx.session.cartId);
    return {
      speech: `You have ${cart.totalQuantity} ${
        cart.totalQuantity === 1 ? 'item' : 'items'
      }, ${money(cart.subtotal.amount, cart.subtotal.currency)} in total.`,
      facts: cartFacts(cart),
      attachment: { kind: 'cart', cart },
    };
  },
});

/* ---------------- product_info ---------------- */

const infoSchema = z.object({
  which: z.string().optional(),
  question: z.string().optional(),
});

/**
 * A question about one product, answered from its variants.
 *
 * Colours, sizes, stock, the price in a size: the model was reading these off
 * raw option lists, and read a size list as stock and a starting price as the
 * price. Which product they mean is worked out from what they can see ("the
 * second one", "the navy one", "this") rather than an id the model copied.
 */
const productInfoTool = defineTool({
  name: 'product_info',
  description:
    'Answer a question about one product: its colours, sizes, what is in stock, the price in a size - and what it is like: waterproof, breathable, warm, its cut, sleeveless, hooded, the zip. Pass `which` as the customer said it ("the second one", "the navy polo", "this", "the Vento") or a product id, and `question` in their words. It knows what is on screen and the page they are on. Use it for any "does it come in...", "is XL in stock", "what sizes", "how much in 2XL".',
  schema: infoSchema,
  parameters: {
    type: 'object',
    properties: {
      which: { type: 'string', description: 'The product as the customer referred to it, or its id. Leave out for "this" / what they are looking at.' },
      question: { type: 'string', description: 'The question in their words, in English: "is XL in stock?", "what colours?"' },
    },
    required: [],
  },
  async run(args, ctx): Promise<ToolResult> {
    const picked = await pickFromPackChoices(ctx);
    if (picked) return picked;
    const said = ctx.utterance ?? '';
    const question = `${args.question ?? ''} ${said}`.trim();
    const byId = args.which && /^(gid:\/\/|\d+$)/.test(args.which.trim()) ? productById(args.which.trim()) : null;
    let resolved =
      (byId ? { product: byId, how: 'the id given' } : null) ??
      (args.which ? resolveProduct(ctx.session, args.which) : null) ??
      resolveProduct(ctx.session, said);
    /*
     * "Is it waterproof?", "what sizes?" - about what they are shopping for
     * now, whatever the model looked up last. A reference in their own words
     * ("the second one", "the navy one") is theirs and stands.
     */
    const focus = ctx.session.activeShoppingContext;
    const theirs = resolveProduct(ctx.session, said);
    const pointedAt = !!theirs && /^(number \d|last on screen|on screen, from what they described)/.test(theirs.how);
    if (focus && !pointedAt && isFollowUp(said)) {
      const held = focusProduct(focus);
      const picked = resolved?.product;
      if (held && (!picked || designOf(picked.title) !== designOf(held.title))) {
        if (picked) log.warn('focus.model_pick_off_focus', { sessionId: ctx.session.id, tool: 'product_info', proposed: picked.title, focus: describeFocus(focus) });
        resolved = { product: held, how: 'the product they are shopping for' };
      } else if (!held && picked && !inFocus(picked, focus)) {
        log.warn('focus.model_pick_off_focus', { sessionId: ctx.session.id, tool: 'product_info', proposed: picked.title, focus: describeFocus(focus) });
        const onScreen = (ctx.session.lastShown?.items ?? []).map((item) => productById(item.id)).filter((found): found is Product => !!found && inFocus(found, focus));
        const talked = ctx.session.focusProductId ? productById(ctx.session.focusProductId) : null;
        const instead = talked && inFocus(talked, focus) ? talked : onScreen.length === 1 ? onScreen[0] : null;
        resolved = instead ? { product: instead, how: 'the one they are shopping for' } : null;
      }
    }
    const product = resolved?.product ?? (args.which && !byId && !(focus && isFollowUp(said)) ? await getProductDetails(args.which) : null);

    if (!product) {
      /*
       * A design, not one colourway: "is the Arvid Gilet waterproof?" with its
       * four colours on screen. Colour changes nothing its description says,
       * so asking "which colour?" answered nothing. When every colourway
       * answers the same, the design is answered; only when they differ, or
       * no design is named, is the customer asked which.
       */
      const named = lookupProductName(args.which ?? said);
      // Or "is this relaxed fit?" with one design on screen in several colours: that design.
      const onScreen = (ctx.session.lastShown?.items ?? []).map((item) => productById(item.id)).filter((found): found is Product => !!found);
      const oneDesign = onScreen.length > 0 && new Set(onScreen.map((found) => garmentName(found.title))).size === 1 ? onScreen : [];
      const family = named?.kind === 'exact-family' ? named.products : named?.kind === 'exact-product' ? [named.product] : oneDesign;
      const answers = family.map((member) => attributesAsked(member, question));
      if (family.length && answers[0]!.length && answers.every((answer) => JSON.stringify(answer) === JSON.stringify(answers[0]))) {
        const design =
          named?.kind === 'exact-family' ? titleCaseWords(named.familyName) : named?.kind === 'exact-product' ? titleCaseWords(family[0]!.title) : titleCaseWords(garmentName(family[0]!.title));
        await sessions.patch(ctx.session.id, { focusProductId: family[0]!.id });
        return {
          speech: sayAttributes(design, answers[0]!),
          facts: `About: the ${design} design - every colourway shares this description (${family.map((member) => `${member.title} [${member.id}]`).join(', ')}).\n${verifiedFacts(family[0]!)}\nAsked about: ${answers[0]!
            .map((answer) => `${answer.asked} - ${answer.state === 'yes' ? 'yes, its description states it' : answer.state === 'other' ? `its description says ${answer.instead}${answer.unsaid ? ` - ${answer.asked} itself is not stated (never say no)` : ' instead'}` : 'not stated (never say no)'}`)
            .join('; ')}. Answer this first; colour does not change it, so do not ask which colour.`,
        };
      }
      const screen = (ctx.session.lastShown?.items ?? []).filter((item) => item.id);
      return {
        speech: screen.length ? 'Which one do you mean?' : 'Which product would you like to know about?',
        facts: screen.length
          ? `On screen, in order:\n${screen.map((item, i) => `${i + 1}. ${item.title} [${item.id}]`).join('\n')}\nAsk which, offering two or three of these by name.`
          : 'Nothing is on screen. Search for what they mean first.',
      };
    }
    const answer = answerAbout(product, question);
    await sessions.patch(ctx.session.id, { focusProductId: product.id });
    return {
      speech: answer.speech,
      facts: `About: ${product.title} [${product.id}] (${resolved?.how ?? 'by name'}).\n${answer.facts}\nAnswer only from these facts. Sizes, stock and prices are exact; do not add any.`,
    };
  },
});

/* ---------------- best_picks ---------------- */

const picksSchema = z.object({
  garments: z.string().optional().describe('Kinds to cover, if they named any: "polos and trousers"'),
  limit: z.number().int().min(1).max(12).optional(),
});

const bestPicksTool = defineTool({
  name: 'best_picks',
  description:
    "The shop's best sellers for this customer: their range, in stock in their size, across polos, bottoms, midlayers and jackets (or only the kinds they name). Use it for \"best picks\", \"what's popular\", \"best sellers\", \"what do you recommend\" with nothing more specific - and straight after they tell you who they shop for and their size.",
  schema: picksSchema,
  parameters: {
    type: 'object',
    properties: {
      garments: { type: 'string', description: 'Only these kinds, if they named any: "polos and trousers"' },
      limit: { type: 'integer', minimum: 1, maximum: 12 },
    },
    required: [],
  },
  async run(args, ctx): Promise<ToolResult> {
    const sizes = shopperSizes(ctx.session);
    const range: Range = parseRange(ctx.utterance ?? '').range ?? sizes?.range ?? 'men';
    /*
     * The kinds their own words name. Asked only for "your best picks", the
     * model passed a garment list of its own and a limit of 12, and the screen
     * filled with polos and trousers - no midlayer, no jacket. Its list counts
     * only when their words (in another language, say) named nothing we read.
     */
    const said = ctx.utterance ?? '';
    const named = kindsNamed(said);
    const kinds = named.length || /\b(best|popular|recommend|sellers?|picks?)\b/i.test(said) ? named : kindsNamed(args.garments ?? '');
    const limit = Math.min(args.limit ?? 6, /\b(more|all)\b/i.test(said) ? 12 : 6);
    const request = rankRequestFor(ctx.session, readIntent(ctx.utterance ?? ''), { currency: storeCurrency() });
    const products = bestPicks(allProducts(), {
      range,
      ...(sizes?.size ? { size: sizes.size } : {}),
      ...(sizes?.waist ? { waist: sizes.waist } : {}),
      ...(kinds.length ? { kinds } : {}),
      limit,
      rank: request,
    });

    await sessions.patch(ctx.session.id, {
      lastShown: { kind: 'products', items: products.map((p) => ({ id: p.id, title: p.title })), query: 'best picks' },
    });
    if (products.length === 0) {
      return { speech: `I could not find best sellers in stock in your size right now.`, facts: 'Offer to search for something specific instead.' };
    }
    const sizeWords = [sizes?.size, sizes?.waist ? `${sizes.waist} waist` : ''].filter(Boolean).join(' and ');
    return {
      speech: `Here are our best sellers${sizeWords ? ` in stock in ${sizeWords}` : ''} - they are on screen now.`,
      facts:
        `Best picks: the store's own best sellers (Shopify sales rank), ${range === 'women' ? 'ladies' : range === 'kids' ? 'kids' : 'mens'} range, one colour of each garment${
          sizeWords ? `, every one in stock in ${sizeWords}` : ''
        }:\n${listFacts(products)}\n` +
        'Lead with one and say in a few words why - it is a best seller, and anything the description states. Their size is already chosen on each card; they can change it there.',
      attachment: { kind: 'products', products },
    };
  },
});

/* ---------------- note_shopper ---------------- */

/**
 * What the customer told us that needs understanding rather than parsing.
 *
 * Most of the profile is read from their words by code every turn (see
 * shopper/profile.ts): budgets, colours, fit, sizes. Some of it needs a
 * reader - "a golf trip to Portugal in July" is hot weather, "I don't like the
 * look of that one" turns down a product. The model records those here, and
 * code keeps them: every later search, size and outfit uses them.
 */
const noteSchema = z.object({
  occasion: z.string().max(80).optional(),
  weather: z.array(z.enum(['wet', 'cold', 'hot', 'windy'])).optional(),
  fit: z.enum(['tight', 'regular', 'relaxed']).optional(),
  layering: z.boolean().optional(),
  colours: z.object({ words: z.array(z.string()).min(1), strength: z.enum(['required', 'preferred']) }).optional(),
  avoidColours: z.array(z.string()).optional(),
  requiredFeatures: z.array(z.enum(FEATURES as [Feature, ...Feature[]])).optional(),
  preferredFeatures: z.array(z.enum(FEATURES as [Feature, ...Feature[]])).optional(),
  budget: z
    .object({ amount: z.number().positive(), kind: z.enum(['max', 'around', 'ideal']), per: z.enum(['item', 'total']) })
    .optional(),
  liked: z.array(z.string()).optional(),
  rejected: z.array(z.string()).optional(),
  justThis: z.string().optional(),
  clearJustThis: z.boolean().optional(),
});

const noteShopperTool = defineTool({
  name: 'note_shopper',
  description:
    'Remember something the customer told you about what they need, when it takes understanding rather than a keyword: the occasion, the weather a place or season means ("Portugal in July" is hot), products they liked or turned down (by id), that they only want this one thing ("just the jacket"), or a budget\'s kind ("max" is a hard limit, "around" is near it, "ideal" is a wish; per item or total). Call it alongside your other tools; say nothing about it to the customer.',
  schema: noteSchema,
  parameters: {
    type: 'object',
    properties: {
      occasion: { type: 'string', description: 'e.g. "club match", "wedding", "golf trip to Portugal"' },
      weather: { type: 'array', items: { type: 'string', enum: ['wet', 'cold', 'hot', 'windy'] } },
      fit: { type: 'string', enum: ['tight', 'regular', 'relaxed'] },
      layering: { type: 'boolean' },
      colours: {
        type: 'object',
        properties: { words: { type: 'array', items: { type: 'string' } }, strength: { type: 'string', enum: ['required', 'preferred'] } },
        required: ['words', 'strength'],
      },
      avoidColours: { type: 'array', items: { type: 'string' } },
      requiredFeatures: { type: 'array', items: { type: 'string', enum: FEATURES } },
      preferredFeatures: { type: 'array', items: { type: 'string', enum: FEATURES } },
      budget: {
        type: 'object',
        properties: {
          amount: { type: 'number' },
          kind: { type: 'string', enum: ['max', 'around', 'ideal'] },
          per: { type: 'string', enum: ['item', 'total'] },
        },
        required: ['amount', 'kind', 'per'],
      },
      liked: { type: 'array', items: { type: 'string' }, description: 'Product ids they said they like' },
      rejected: { type: 'array', items: { type: 'string' }, description: 'Product ids they turned down - never offered again' },
      justThis: { type: 'string', description: 'The garment they said is all they want, e.g. "jacket"' },
      clearJustThis: { type: 'boolean', description: 'They have since asked for more' },
    },
    required: [],
  },
  async run(args, ctx): Promise<ToolResult> {
    const existing = ctx.session.shopper?.features;
    const update = {
      ...(args.occasion ? { occasion: args.occasion } : {}),
      ...(args.weather?.length ? { weather: args.weather } : {}),
      ...(args.fit ? { fit: args.fit } : {}),
      ...(args.layering !== undefined ? { layering: args.layering } : {}),
      ...(args.colours ? { colours: { words: args.colours.words.map((w) => w.toLowerCase()), strength: args.colours.strength } } : {}),
      ...(args.avoidColours?.length ? { avoidColours: args.avoidColours.map((w) => w.toLowerCase()) } : {}),
      ...(args.requiredFeatures || args.preferredFeatures
        ? {
            features: {
              required: args.requiredFeatures ?? existing?.required ?? [],
              preferred: args.preferredFeatures ?? existing?.preferred ?? [],
            },
          }
        : {}),
      ...(args.budget ? { budget: args.budget } : {}),
      ...(args.liked?.length ? { liked: args.liked } : {}),
      ...(args.rejected?.length ? { rejected: args.rejected } : {}),
      ...(args.justThis ? { justThis: args.justThis } : args.clearJustThis ? { justThis: '' } : {}),
    };
    const profile = await rememberShopper(ctx.session.id, update);
    return {
      speech: '',
      facts: `Noted. ${describeProfile(profile, ctx.session.preferences.currency ?? storeCurrency()) ?? ''}`.trim(),
    };
  },
});

/* ---------------- registry ---------------- */

export const tools: CaddieTool[] = [
  searchTool,
  detailsTool,
  sizeTool,
  packTool,
  outfitTool,
  addToCartTool,
  addPackTool,
  otherColoursTool,
  updateCartTool,
  viewCartTool,
  noteShopperTool,
  bestPicksTool,
  productInfoTool,
] as CaddieTool[];

const byName = new Map(tools.map((tool) => [tool.name, tool]));

export function getTool(name: string): CaddieTool | undefined {
  return byName.get(name);
}

/** The shape Vapi wants when we register the assistant's tools. */
export function toolDefinitionsForVapi() {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

export async function runTool(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
  const tool = getTool(name);
  if (!tool) return { speech: `Unknown tool ${name}.` };

  const parsed = tool.schema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return {
      speech: `I could not use ${name} with those details: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')} ${issue.message}`)
        .join('; ')}`,
    };
  }

  /*
   * An add to the basket needs the customer to have asked for it - see
   * cartAuthorization.ts. Checked here, so every way in - the model, an
   * outfit swap, the Add button - goes through it.
   */
  let data = parsed.data;
  if (name === 'add_pack_to_cart') {
    const auth = cartAuthorization(ctx);
    if (!auth.authorized) {
      log.warn('cart.unauthorized_add_attempt', { sessionId: ctx.session.id, pack: (data as { pack?: string }).pack ?? ctx.session.lastShown?.bundle ?? null, utterance: (ctx.utterance ?? '').slice(0, 160) });
      const handle = ctx.session.lastShown?.kind === 'pack' ? ctx.session.lastShown.bundle : ctx.session.packInFocus;
      const standing = handle ? packStatusFacts(packStatus(ctx.session, handle)) : '';
      return {
        speech: "I haven't added the pack to your basket.",
        facts: `Basket unchanged. The customer did not ask to add the pack - their words were "${(ctx.utterance ?? '').slice(0, 160)}". Do not say it was added, and never say a size was selected that the status below does not confirm.${standing ? `\n${standing}` : ''}`,
      };
    }
  }
  if (name === 'add_to_cart') {
    const args = data as { productId: string; options?: Record<string, string>; quantity?: number; replaces?: string };
    const auth = cartAuthorization(ctx, { ...(args.replaces ? { replaces: args.replaces } : {}) });
    if (!auth.authorized) {
      log.warn('cart.unauthorized_add_attempt', {
        sessionId: ctx.session.id,
        productId: args.productId,
        options: args.options ?? null,
        utterance: (ctx.utterance ?? '').slice(0, 160),
      });
      return {
        speech: "I haven't added anything to your basket.",
        facts: `Basket unchanged. The customer did not ask to add anything - their words were "${(ctx.utterance ?? '').slice(0, 160)}". Do not say anything was added, and add nothing until they ask.`,
      };
    }
    const quantity = quantityAsked(ctx, args.quantity);
    if (args.quantity !== undefined && quantity !== args.quantity) log.warn('cart.quantity_not_asked', { sessionId: ctx.session.id, proposed: args.quantity });
    data = { ...args, ...(args.quantity !== undefined ? { quantity } : {}) } as typeof data;
  }
  const result = await tool.run(data, ctx);

  if ((name === 'add_to_cart' || name === 'add_pack_to_cart') && !ctx.direct) {
    const added = (result.actions?.length ?? 0) > 0 || result.attachment?.kind === 'cart';
    const productId = name === 'add_pack_to_cart' ? `pack:${ctx.session.lastShown?.bundle ?? ctx.session.packInFocus ?? ''}` : (data as { productId: string }).productId;
    // Asked to add, waiting on a size or colour: their answer next turn finishes it. Added: nothing waits.
    await sessions.patch(ctx.session.id, added ? { pendingAdd: undefined } : { pendingAdd: { productId, turn: turnNow(ctx) } });
  }

  /*
   * Every basket any tool hands back is remembered, whoever asked for it.
   * The widget's Add buttons call add_to_cart directly, outside the
   * conversation, so the model only knew "they have a basket open". Asked to
   * swap the orange polo in it, it could not see the orange polo and added the
   * new one beside it.
   */
  if (result.attachment?.kind === 'cart') {
    await sessions.patch(ctx.session.id, {
      basket: result.attachment.cart.lines.map((line) => ({
        lineId: line.lineId,
        productId: line.productId,
        title: line.title,
        variantTitle: line.variantTitle,
        quantity: line.quantity,
      })),
    });
  }
  return result;
}
