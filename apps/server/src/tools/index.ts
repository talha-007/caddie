import type { Cart, OutfitPiece, Product } from '@caddie/shared';
import { z } from 'zod';
import { FEATURE_LABEL, attributesOf, hasFeature, type Feature, type Weather } from '../catalog/attributes.js';
import { parseRange, rangeOf, type Range } from '../catalog/audience.js';
import { lookupProductName, unknownNameIn } from '../catalog/lookup.js';
import { normaliseQuery } from '../catalog/taxonomy.js';
import { nextStep } from '../recommend/nextStep.js';
import { hasSignals, rankFacts, rankProducts } from '../recommend/rank.js';
import { describeProfile, readIntent, type Budget } from '../shopper/profile.js';
import { rankRequestFor, rememberShopper, shopperSizes } from '../shopper/remember.js';
import { bestPicks, kindsNamed } from '../recommend/bestPicks.js';
import { answerAbout, describeStock } from '../recommend/productFacts.js';
import { resolveProduct } from '../session/screen.js';
import { colourMatch, coloursOffered, matchesColourText, parseColours } from '../catalog/colour.js';
import { allDeals, type DealRecipe } from '../catalog/bundles.js';
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
import { optionValueMatches } from '../recommend/sizeWords.js';
import { addToCart, getCart, getProductDetails, isBrandProduct, searchProducts, setLineQuantity } from '../shopify/catalog.js';
import { storeCurrency } from '../shopify/money.js';
import { sessions, type CaddieSession } from '../session/store.js';
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
function listFacts(products: Product[]): string {
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

      return `- ${product.title}${label} - ${shown} [${product.id}]${verifiedLine(product)}`;
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
function verifiedLine(product: Product): string {
  const { features, fit } = attributesOf(product);
  const bits = features.slice(0, 5).map((feature) => FEATURE_LABEL[feature]);
  if (fit) bits.push(`${fit} cut`);
  return bits.length ? ` | description states: ${bits.join(', ')}` : '';
}

/**
 * The colour the customer asked for: passed explicitly, or named in the words
 * the model passed on.
 *
 * Never left to the model alone. Given "quiero un polo azul" it searched for
 * "polo"; asked for "a navy outfit, polos and trousers" it put "navy" in the
 * seed and no colour argument at all - and the customer got orange and purple.
 * Whatever reached us, if it names a colour, that colour is the rule.
 */
function colourAsked(explicit: string | undefined, ...texts: Array<string | undefined>): string | undefined {
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

/* ---------------- search_products ---------------- */

const FEATURES = Object.keys(FEATURE_LABEL) as Feature[];

const searchSchema = z.object({
  query: z.string().min(1).describe('What the customer is looking for, in English'),
  colour: z.string().optional(),
  productName: z.string().optional(),
  features: z.array(z.enum(FEATURES as [Feature, ...Feature[]])).optional(),
  limit: z.number().int().min(1).max(20).optional(),
  maxPrice: z.number().positive().optional(),
});

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
    'If the customer names a colour - in any language - pass it, in English, as `colour`. If they name a specific product ("the Tour Championship Jacket"), pass that name as `productName`: the whole catalogue is checked for it.',
  schema: searchSchema,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What the customer is looking for, in English, keeping every describing word ("plain", "lightweight", "rain top").' },
      colour: { type: 'string', description: 'The colour they asked for, in English: "blue", "navy", "light grey". Never leave out a colour they named.' },
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
    },
    required: ['query'],
  },
  async run(args, ctx): Promise<ToolResult> {
    const turn = readIntent(ctx.utterance ?? '');
    const profile = ctx.session.shopper;
    const currency = ctx.session.preferences.currency ?? storeCurrency();

    // Customer words into catalogue words: "rain top" is a jacket that has to be waterproof.
    const normal = normaliseQuery(args.query);

    // Plain is the one thing read from their own words here - "swap this
    // orange polo for a plain white one" must not make orange the filter.
    const saidPlain = ctx.utterance ? parseColours(ctx.utterance).plain : false;
    const namedColour = colourAsked(args.colour, normal.query);
    const asked = saidPlain && namedColour && !parseColours(namedColour).plain ? `plain ${namedColour}` : namedColour;
    /*
     * Required colours filter; preferred ones only rank. A standing "only
     * navy" carries into a search that names no colour; a standing "I like
     * navy" only moves navy up.
     */
    const strength = asked ? colourStrength(asked, turn, ctx) : undefined;
    const standing = !asked && profile?.colours?.strength === 'required' ? profile.colours.words.join(' or ') : undefined;
    const filterColour = strength === 'preferred' ? (parseColours(asked!).plain ? 'plain' : undefined) : (asked ?? standing);
    const rankColour = asked
      ? { words: parseColours(asked).colours.map((colour) => colour.word), strength: strength! }
      : profile?.colours
        ? profile.colours
        : null;

    /*
     * The range they asked for - in the query, or in their own words when the
     * model dropped it ("a polo for my son" searched as "polo"). Only a range
     * someone actually named is remembered: a woman who searched "navy polo"
     * and was shown mens ones has not told us she shops mens.
     */
    const askedRange = parseRange(args.query).range ?? parseRange(ctx.utterance ?? '').range;
    const rangeWord = askedRange && !parseRange(normal.query).range ? `${askedRange === 'women' ? 'ladies' : askedRange} ` : '';
    const words = parseColours(normal.query).rest;
    const query = `${rangeWord}${filterColour ? `${filterColour} ${words}` : strength === 'preferred' ? words : normal.query}`.trim();
    const known = knownRange(ctx);

    const request = rankRequestFor(ctx.session, turn, {
      features: [...normal.features, ...(args.features ?? [])],
      colour: rankColour,
      currency,
    });
    const ceiling = args.maxPrice ?? priceCeiling(request.budget);
    const limit = args.limit ?? 6;
    // Ranking needs room to choose: fetch wide, then keep the best.
    const ranking = hasSignals(request);
    const wide = await searchProducts({
      query,
      limit: ranking ? Math.max(limit * 4, 24) : limit,
      ...(ceiling !== undefined ? { maxPrice: ceiling } : {}),
      ...(known ? { known } : {}),
    });
    /*
     * A preferred colour is looked for, not just waited for. The store has
     * hundreds of polos; the top two dozen by relevance held no navy, and a
     * customer who said "I'd prefer navy" was told there was none. The
     * colour's own results go into the pool first, then everything else.
     */
    const preferredWords = rankColour?.strength === 'preferred' ? rankColour.words.join(' or ') : '';
    const inColour = preferredWords
      ? await searchProducts({
          query: `${rangeWord}${preferredWords} ${words}`.trim(),
          limit: limit * 2,
          ...(ceiling !== undefined ? { maxPrice: ceiling } : {}),
          ...(known ? { known } : {}),
        })
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
          })
        ).filter((product) => needed.every((feature) => hasFeature(product, feature)))
      : [];
    const found = [...withFeature, ...inColour, ...wide].filter(
      (product, index, all) => all.findIndex((other) => other.id === product.id) === index,
    );

    /*
     * A product they named, checked against the whole catalogue - the one
     * thing that can say "we do not stock that" truthfully. Named products
     * that exist go first, ahead of whatever search ranked highest.
     */
    const existence = args.productName ? lookupProductName(args.productName) : unknownNameIn(args.query);
    const named = existence?.status === 'exact' ? existence.products.filter((p) => p.variants.some((v) => v.available)) : [];
    const pool = [...named, ...found.filter((product) => !named.some((n) => n.id === product.id))];

    const ranked = ranking ? rankProducts(pool, request) : [];
    /*
     * Never an exact match beside something that fails what they asked for:
     * partial matches only appear when nothing better exists, and then the
     * facts say so.
     */
    const good = ranked.filter((entry) => entry.matchLevel !== 'partial');
    const shownRanked = ranking ? (good.length ? good : ranked.filter((e) => !e.missedRequirements.includes('turned down earlier'))) : [];
    const products = ranking
      ? [...named.filter((n) => !shownRanked.some((e) => e.product.id === n.id)), ...shownRanked.map((entry) => entry.product)].slice(0, limit)
      : pool.slice(0, limit);
    const onlyPartial = ranking && good.length === 0 && shownRanked.length > 0;

    await sessions.patch(ctx.session.id, {
      lastShown: {
        kind: 'products',
        items: products.map((p) => ({ id: p.id, title: p.title })),
        query,
        ...(filterColour ? { colour: filterColour } : {}),
      },
      ...(askedRange === 'men' || askedRange === 'women' ? { preferences: { audience: askedRange } } : {}),
    });

    const existenceFacts =
      existence?.status === 'not-stocked'
        ? `Catalogue check: nothing in the Druids catalogue is called "${existence.name}" - every product was checked. You may say we do not stock it.${
            existence.closest.length ? ` Closest names: ${existence.closest.map((p) => p.title).join(', ')} - offer them as alternatives, never as it.` : ''
          }`
        : existence?.status === 'exact'
          ? `Catalogue check: Druids does sell "${args.productName}": ${existence.products.map((p) => `${p.title} [${p.id}]${p.variants.some((v) => v.available) ? '' : ' (sold out)'}`).join(', ')}.`
          : existence?.status === 'unknown'
            ? `The full catalogue could not be checked just now. Say you could not find that exact product - never that we do not stock it.`
            : '';

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

    const top = shownRanked[0];
    const pickLine =
      top && !onlyPartial && top.reason
        ? `\nLead with: ${top.product.title} [${top.product.id}] - ${top.matchLevel} match: ${top.reason}.${
            top.missedPreferences.length ? ` It differs on: ${top.missedPreferences.join('; ')} - say so.` : ''
          }`
        : '';
    const partialLine = onlyPartial
      ? `\nNothing meets everything they asked for. These are the closest, and each fails something (below) - say plainly what is missing, never present them as what they asked for.`
      : '';

    /*
     * Worded as "closest" on purpose: the search is by words and always
     * returns its best guesses, and "I found 4 options" invites the model to
     * present them as the thing that was asked for.
     */
    return {
      // A proven absence leads: "closest matches" first made the model hedge and ask the customer to confirm the name.
      speech: existence?.status === 'not-stocked'
        ? `We do not stock the ${existence.name.replace(/^(the|a|an)\s+/i, '')}. The closest options are on screen now.`
        : onlyPartial
        ? `I could not find anything that meets everything you asked for - these are the closest. They are on screen now.`
        : products.length === 1
          ? 'Here is the closest match in the store. It is on screen now.'
          : `Here are the ${products.length} closest matches in the store. They are on screen now.`,
      facts: [
        `Results for "${query}", best match first:\n${listFacts(products)}`,
        normal.mapped.length ? `Searched in catalogue terms: ${normal.mapped.join('; ')}.` : '',
        filterColour && strength !== 'preferred'
          ? `Every result is in ${filterColour} or a shade of it - the colour is in each name. Say which shade when it is not the exact word they used (navy for blue, teal for blue or green).`
          : strength === 'preferred'
            ? `${asked} is a preference, not a rule: those colours are ranked first, others can still show.`
            : '',
        ranking ? `How each fits what they asked for:\n${rankFacts(shownRanked.filter((e) => products.includes(e.product)))}${pickLine}${partialLine}` : '',
        existenceFacts,
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
      if (named?.status === 'not-stocked') {
        const name = named.name.replace(/^(the|a|an)\s+/i, '');
        return {
          speech: `We do not stock the ${name}.`,
          facts: `Catalogue check: nothing in the Druids catalogue is called "${name}" - every product was checked. Say we don't stock it, then offer to show the closest with search_products.${
            named.closest.length ? ` Closest names: ${named.closest.map((p) => `${p.title} [${p.id}]`).join(', ')} - alternatives, never it.` : ''
          }`,
        };
      }
      if (named?.status === 'exact') {
        return {
          speech: 'I found a few with that name - which one did you mean?',
          facts: `Products with that name: ${named.products.map((p) => `${p.title} [${p.id}]`).join(', ')}. Call get_product_details with one of these ids.`,
        };
      }
      return { speech: 'I could not load that product.' };
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
      attributes.fit ? `Cut: ${attributes.fit}.` : '',
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
    const { productId, layering, ...measurements } = args;
    const product = productId ? productById(productId) : null;
    const productRange = product ? rangeOf(product) : undefined;
    const shopper = ctx.session.shopper;

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
    if (recommendation.size && recommendation.basis !== 'none') {
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
  args: { query: string; size?: string; swap?: string; swapWith?: string },
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
  const target = namedDeal && remembered[namedDeal.handle] ? namedDeal : onScreen;
  const fromScreen = !!target && target === onScreen && shown?.kind === 'pack';
  const targetItems = target ? ((fromScreen ? shown!.items : remembered[target.handle]?.items) ?? []) : [];
  const targetColour = target ? (fromScreen ? shown?.colour : remembered[target.handle]?.colour) : undefined;
  // A change keeps the colour that pack was built in, unless they name another.
  if (!colour && targetColour) colour = targetColour;

  // One piece named with a change word is a swap, whether or not the model called it one.
  const slotIndex = target ? stepNamed(target, said) : -1;
  const changeWords = /\b(swap|change|different|another|replace|other|new|else|design|style)\b/i.test(said);
  const wantsSwap = !!(args.swap || args.swapWith) || (changeWords && slotIndex >= 0 && !wholePack);

  // Swapping one piece of that pack: the rest stays, one step is re-picked.
  if (target && wantsSwap) {
    const current = targetItems.map((item) => (item.id ? productById(item.id) : null));
    const stepIndex = current.findIndex((product) => !!product && !!args.swap && sameProduct(product.id, args.swap));
    const chosen = args.swapWith ? await getProductDetails(args.swapWith) : null;
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
      return {
        speech: `The ${chosen.title} is not one of the ${step.title.toLowerCase()} choices for the ${target.title}.`,
        facts: `Only products from that step's collection count towards the pack price. Offer to add it separately instead.`,
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
    // A swap is a different piece, not the same one in another colour: "change the design of the polo".
    const pieces = fillDeal(target, {
      size,
      colour,
      keep,
      exclude: [...(outgoing ? [outgoing.id] : []), ...turnedDown],
      ...(outgoing ? { avoidDesigns: new Set([garmentName(outgoing.title)]) } : {}),
    });
    return showDeal(target, pieces, ctx, currency, args.query, { ...(size ? { size } : {}), ...(colour ? { colour } : {}) });
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
        return showDeal(namedDeal, again, ctx, currency, args.query, fill);
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
    return showDeal(
      namedDeal,
      fillDeal(namedDeal, { ...fill, ...(avoidDesigns.size ? { avoidDesigns } : {}) }),
      ctx,
      currency,
      args.query,
      fill,
    );
  }
  if (choice && 'ask' in choice) {
    const options = choice.ask;
    const named = options.map((d) => `${titleCaseWords(d.conditionTitle ?? d.title)} at £${d.prices.GBP}`);
    const spoken = named.length > 1 ? `${named.slice(0, -1).join(', ')} or ${named[named.length - 1]}` : named[0];
    return {
      speech: `The ${rangeLabel(options[0]!.range)}Ambassador Pack comes in ${options.length}, depending on the conditions you play in: ${spoken}. Which suits you best?`,
      facts:
        `The Ambassador Pack by conditions - ask which, never pick one for them:\n${options
          .map((d) => `- ${d.title}: ${d.steps.length} pieces for £${d.prices.GBP} (${d.steps.map((s) => s.title.toLowerCase()).join(', ')})`)
          .join('\n')}\n` +
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
    const cheapest = Math.min(...ambassadors.map((d) => d.prices.GBP ?? Infinity));
    const leadLine =
      ambassadors.length > 1 && ambassadors.every((d) => d.condition)
        ? `the ${rangeLabel(lead.range)}Ambassador Pack comes in ${ambassadors.length} versions for different conditions, from £${cheapest}`
        : `the ${lead.title} is ${lead.steps.length} pieces for £${lead.prices.GBP}`;
    return {
      speech: `We have ${deals.length} bundle deals - ${leadLine}. Which would you like to see?`,
      facts: `The store's bundle deals, at fixed prices:\n${list.join('\n')}\nWhen they choose one, call recommend_pack with its name to build it.`,
    };
  }
  return null;
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
  let cheaperNote = '';
  if (!blocked && deal.format === 'plus' && pieces.every(Boolean)) {
    const own = piecesTotal(pieces.map((piece) => piece!.variants.find((variant) => variant.available)?.id ?? piece!.variants[0]?.id ?? ''));
    const packPrice = deal.prices.GBP ?? 0;
    if (own > 0 && own < packPrice) {
      recommendation.total = { amount: own, currency: recommendation.total.currency };
      cheaperNote = ` These pieces come to £${own.toFixed(2)} on their own - less than the £${packPrice} pack price - so that is what you would pay.`;
    }
  }
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
    packsShown: {
      ...((await sessions.getOrCreate(ctx.session.id)).packsShown ?? {}),
      [deal.handle]: {
        items: pieces.map((piece) => ({ id: piece?.id ?? '', title: piece?.title ?? '' })),
        ...(fill.colour ? { colour: fill.colour } : {}),
      },
    },
    ...(deal.range !== 'kids' ? { preferences: { audience: deal.range } } : {}),
  });
  const lines = deal.steps
    .map((step, i) => `- ${step.title}: ${pieces[i] ? `${pieces[i]!.title} [${pieces[i]!.id}]` : 'none picked'}`)
    .join('\n');

  return {
    speech: blocked
      ? `The ${deal.title} isn't available just yet.`
      : cheaperNote
        ? `The ${deal.title} is ${deal.steps.length} pieces, one from each step.${cheaperNote}`
        : recommendation.reason,
    facts:
      (blocked
        ? `Not available to buy yet (${blocked}). Say so lightly in one line - no apology, no error wording, never "out of stock" - and offer another pack. Never present its price as one they can pay or offer to add it.\n`
        : '') +
      (cheaperNote
        ? `${deal.title}: its pack price is £${deal.prices.GBP}, but these pieces cost £${recommendation.total.amount.toFixed(2)} on their own, so that is what they pay. Quote £${recommendation.total.amount.toFixed(2)}; never say £${deal.prices.GBP} is what they pay, and never call it a saving.\n`
        : `${deal.title} - £${deal.prices.GBP}, a fixed price for the whole pack (not the sum of the pieces).\n`) +
      `Pieces, one per step:\n${lines}\n` +
      'To change one piece call recommend_pack with swap (and swapWith if they chose it). ' +
      'To buy it, call add_pack_to_cart once they have given sizes - never add the pieces one by one, or the pack price is lost.',
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
    const currency = args.currency ?? ctx.session.preferences.currency ?? storeCurrency();
    const statedBudget = ctx.session.shopper?.budget;
    const budgetAmount =
      args.budgetAmount ?? (statedBudget?.per === 'total' ? statedBudget.amount : undefined) ?? ctx.session.preferences.budgetAmount;
    // Named in their words counts, whether or not the model passed it on.
    const askedColour = colourAsked(args.colour, args.query);
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
    'Add a product to the customer basket. Pass the product id and the options they chose, such as size. Never guess the size for them: if you do not know it, ask first. The product id must be one you have seen in this conversation. ' +
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
    let product = await getProductDetails(args.productId, args.options);
    // "The second one", "the navy one": what they can see, not an id to guess.
    if (!product && !/^(gid:\/\/|\d+$)/.test(args.productId.trim())) {
      const seen = resolveProduct(ctx.session, args.productId);
      if (seen) product = await getProductDetails(seen.product.id, args.options);
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
    const named = new Set(Object.keys(args.options ?? {}).map((key) => key.toLowerCase()));
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
function singleGarmentLine(product: Product): string {
  const name = garmentName(product.title).toUpperCase();
  const ways = [product, ...otherColourways(product)];
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
    const named = args.productId ? await getProductDetails(args.productId) : null;
    const page = ctx.session.page?.productId ? productById(ctx.session.page.productId) : null;
    const screen = (ctx.session.lastShown?.items ?? []).map((item) => (item.id ? productById(item.id) : null)).filter((p): p is Product => !!p);
    const subjects = named ? [named] : page ? [page] : screen;
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
    const every = garments.flatMap((product) => [product, ...otherColourways(product)]);

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
    const withOthers = garments.filter((product) => otherColourways(product).length > 0);

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
        `- ${garmentName(product.title).toUpperCase()}: ${[product, ...otherColourways(product)].map((p) => colourwayName(p.title)).join(', ')}`,
    );
    return {
      speech:
        withOthers.length === 1
          ? singleGarmentLine(withOthers[0]!)
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
        speech: `Which conditions is the Ambassador Pack for - ${choice.ask.map((d) => `${titleCaseWords(d.conditionTitle ?? d.title)} (£${d.prices.GBP})`).join(', ')}?`,
        facts: 'Ask which, then call recommend_pack with the condition to build it before adding.',
      };
    }
    if (!deal) return { speech: 'Which pack would you like - the Ambassador Pack, the Prestige Pack or another?' };
    const built = deal === onScreen && shown ? null : fillDeal(deal, { size: args.size ?? ctx.session.sizeProfile.usualSize });
    if (built) await showDeal(deal, built, ctx, storeCurrency(), args.pack ?? deal.title);

    const products = built ?? (shown?.items ?? []).map((item) => (item.id ? productById(item.id) : null));
    if (products.some((product) => !product)) {
      return { speech: `One of the ${deal.title} steps has nothing in stock that fits, so it is best finished on the pack page.`, facts: deal.url };
    }

    const pieces: Array<{ product: Product; variant: Product['variants'][number] }> = [];
    const questions: string[] = [];
    for (const product of products as Product[]) {
      /*
       * What they chose for this piece, in whatever words arrived. A pack
       * built in this same call has ids the model has not seen, so a piece
       * can be named by title too, and general options ("waist 34, leg 32")
       * go to whichever piece has an option by that name.
       */
      const chosen =
        (args.choices ?? []).find(
          (choice) =>
            sameProduct(product.id, choice.productId) ||
            product.title.toLowerCase().includes(choice.productId.toLowerCase()) ||
            choice.productId.toLowerCase().includes(product.title.toLowerCase()),
        )?.options ?? {};
      const options: Record<string, string> = {};
      for (const [key, value] of Object.entries({ ...(args.options ?? {}), ...chosen })) {
        const name = optionNamed(product, key);
        if (name) options[name] = value;
      }
      const sizeName = sizeOptionName(product);
      if (args.size && sizeName && !(sizeName in options)) options[sizeName] = args.size;
      const narrowed = await getProductDetails(product.id, Object.keys(options).length ? options : undefined);
      const open = product.options.filter(
        (option) => option.values.length > 1 && !Object.keys(options).some((key) => key.toLowerCase() === option.name.toLowerCase()),
      );
      const available = (narrowed?.variants ?? []).filter((variant) => variant.available);
      if (open.length) {
        questions.push(`${product.title}: ${open.map((option) => `${option.name.toLowerCase()} (${option.values.join(', ')})`).join('; ')}`);
      } else if (available.length > 1) {
        // "Large" on a belt that comes in M/L and L/XL: a real choice, asked, not guessed.
        const between = [...new Set(available.map((variant) => Object.values(variant.options).join(' / ')))];
        questions.push(`${product.title}: that matches more than one size - ${between.join(' or ')}? Ask which.`);
      } else if (available.length === 0) {
        /*
         * Said precisely. "Not in stock" was once the answer to a size name we
         * had simply failed to read, for sizes sitting on the shelf.
         */
        const inStock = product.variants
          .filter((variant) => variant.available)
          .map((variant) => Object.values(variant.options).join(' / '));
        const exists = (narrowed?.variants.length ?? 0) > 0;
        questions.push(
          exists
            ? `${product.title}: that size is sold out. In stock: ${inStock.join(', ') || 'nothing'}.`
            : `${product.title}: there is no ${Object.values(options).join(' / ')} - it comes in ${product.options.map((o) => o.values.join(', ')).join(' / ')}.`,
        );
      } else {
        pieces.push({ product, variant: available[0]! });
      }
    }

    if (questions.length) {
      return {
        speech: `Before I add the ${deal.title}, I need a choice on ${questions.length === 1 ? 'one piece' : `${questions.length} pieces`}.`,
        facts: `Still to choose:\n${questions.map((q) => `- ${q}`).join('\n')}\nAsk for these, then call add_pack_to_cart again with size and/or choices.`,
      };
    }

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
        : `Adding the ${deal.title} to your basket - ${pieces.length} pieces for £${charge.toFixed(2)}${charge < (deal.prices.GBP ?? 0) ? ` - less than the £${deal.prices.GBP} pack price, as these pieces come to less on their own` : ""}.`,
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
    'Answer a question about one product: its colours, sizes, what is in stock, the price in a size. Pass `which` as the customer said it ("the second one", "the navy polo", "this", "the Vento") or a product id, and `question` in their words. It knows what is on screen and the page they are on. Use it for any "does it come in...", "is XL in stock", "what sizes", "how much in 2XL".',
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
    const said = ctx.utterance ?? '';
    const question = `${args.question ?? ''} ${said}`.trim();
    const byId = args.which && /^(gid:\/\/|\d+$)/.test(args.which.trim()) ? productById(args.which.trim()) : null;
    const resolved =
      (byId ? { product: byId, how: 'the id given' } : null) ??
      (args.which ? resolveProduct(ctx.session, args.which) : null) ??
      resolveProduct(ctx.session, said);
    const product = resolved?.product ?? (args.which && !byId ? await getProductDetails(args.which) : null);

    if (!product) {
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
  const result = await tool.run(parsed.data, ctx);

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
