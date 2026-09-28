import { chartCategoryOf, firstBuyableVariant, formatMoney, nothingToChoose, productColourWords, resolveVariant, sizeApplies, sizeOptionName as sizeOptionOf, sizeScale } from '../catalog/commerce.js';
import type { Cart, CartAction, OutfitPiece, Product } from '@caddie/shared';
import { z } from 'zod';
import { FEATURE_LABEL, WEATHER_NEEDS, attributesOf, featuresAsked, hasFeature, type Feature, type Weather } from '../catalog/attributes.js';
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
import { asksToAdd, asksToRemove, cartAuthorization, lineChangeAuthorization, offerSentence, offeredAction, quantityAsked, quantityInWords, turnNow } from './cartAuthorization.js';
import { executeCommerceAction, registerPlanner, type ActionOutcome, type ActionPlan, type ActionSource, type CommerceAction } from './actionGateway.js';
import { packPieces, packStatus, packStatusFacts, readPackChoices, type PackChoices } from './packState.js';
import { namesOtherProduct, type CustomerGoal } from './journey.js';
import { eligibilityFor, eligibilityOf, guardCards } from './eligibility.js';

export { sizesNeverGiven };
import { searchLocalScored } from '../catalog/search.js';
import { nextStep } from '../recommend/nextStep.js';
import { hasSignals, rankFacts, rankProducts, weatherHotOnly } from '../recommend/rank.js';
import { describeProfile, readIntent, type Budget } from '../shopper/profile.js';
import { acceptedRecommendation, currentRange, describeShopper, logFact, shopperView, trustedShopperFacts, type SizeRecommendationRecord } from '../shopper/facts.js';
import { rankRequestFor, rememberMeasurements, rememberShopper, shopperSizes } from '../shopper/remember.js';
import { aboutPackPiece, customerTurn, noteShoppingConstraints, requestedKinds, setActivePack, setReplacement } from '../session/focus.js';
import { bestPicks, kindsNamed } from '../recommend/bestPicks.js';
import { answerAbout, attributesAsked, describeStock, sayAttributes, verifiedFacts } from '../recommend/productFacts.js';
import { resolveProduct } from '../session/screen.js';
import { describeFocus, designOf, focusProduct, focusQuery, inFocus, isFollowUp } from '../session/focus.js';
import { describeIdentity, designMembers, identityProducts, resolveCustomerProductIdentity, type CustomerIdentity, type NamedDesign } from '../catalog/productIdentity.js';
import { colourMatch, coloursOffered, matchesColourText, parseColours, type ColourRequest } from '../catalog/colour.js';
import { allDeals, type DealRecipe, type DealStep } from '../catalog/bundles.js';
import { log } from '../lib/logger.js';
import { checkoutTotal, storefrontCartEnabled } from '../shopify/storefrontCart.js';
import { colourwayName, garmentName, otherColourways } from '../catalog/colourways.js';
import { allProducts, productById } from '../catalog/sync.js';
import { asksForDeals, chooseDeal, dealRecommendation, fillDeal, findDeal, namesADeal, toBundleDeal } from '../recommend/deals.js';
import { DEFAULT_SLOTS, fitsSlot, namedSlots, recommendOutfit, slotsFor } from '../recommend/outfit.js';
import { recommendPack } from '../recommend/pack.js';
import { findNamedPack, findUnstockedBundle, recommendNamedPack } from '../recommend/packs.js';
import { priceFor, priceRange } from '../recommend/pricing.js';
import { categoryForProduct, recommendSize } from '../recommend/size.js';
import { normaliseSize, optionValueMatches, sameSize } from '../recommend/sizeWords.js';
import { addToCart, getCart, getProductDetails, isBrandProduct, searchProducts, setLineQuantity } from '../shopify/catalog.js';
import { storeCurrency } from '../shopify/money.js';
import { sessions, type CaddieSession, type PendingNeed } from '../session/store.js';
import { agreesWithTarget, currentMission, currentPack, currentProduct, livePending, tappedSinceLastSaid, trustedProductTarget, type TrustedTarget } from '../session/shoppingSession.js';
import { defineTool, type CaddieTool, type ToolContext, type ToolResult } from './types.js';

/**
 * The tools the Caddie assistant can call.
 *
 * Every one of them returns `speech` (what the model may say) and an optional
 * `attachment` (what the widget renders). The model is told, in the system
 * prompt, that product facts live in the attachment and must not be restated
 * from memory.
 */

// One money format for everything a customer reads (catalog/commerce.ts).
const money = formatMoney;

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

/**
 * The range the customer is shopping, as far as we know it: their words, the
 * range they are shopping now, then the one they told us is theirs
 * (shopper/facts.ts). The range of whatever was last shown is not evidence.
 */
function knownRange(ctx: ToolContext): 'men' | 'women' | undefined {
  const range = currentRange(ctx.session, ctx.utterance);
  return range === 'men' || range === 'women' ? range : undefined;
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
  // Plurals too: "the other jackets that can go in the pack" named no piece of it (live replay, V1 task 2).
  [/\b(jackets?|gilets?|coats?|vests?)\b/i, /jacket|gilet/i],
  [/\b(midlayers?|mid-layers?|hoodies?|jumpers?|sweaters?|quarter zips?)\b/i, /midlayer|hoodie|sweat/i],
  [/\b(trousers?|shorts|joggers?|pants|bottoms)\b/i, /trouser|short|jogger|pant|bottom/i],
  [/\b(belts?|caps?|hats?|beanies?)\b/i, /belt|cap|hat/i],
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
      // No size to choose is a fact about the product (catalog/commerce.ts): said, so no one asks for one.
      const oneSize = sizeScale(product).oneSize ? ' | one size - never ask a size' : '';
      return `- ${product.title}${label} - ${shown} [${product.id}]${oneSize}${checked ? ` | checked: ${checked}` : ''}${verifiedLine(product)}`;
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
  // "I'll" is one word ("ill"), not "i" and "ll".
  const words = text.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  // "Add them" is as bare as "add it": a pair of socks, a set of the cards on screen.
  if (!words.some((word) => ['it', 'this', 'that', 'one', 'them', 'these', 'those'].includes(word))) return false;
  const filler = new Set(['add', 'put', 'pop', 'get', 'buy', 'take', 'ill', 'i', 'will', 'can', 'you', 'please', 'it', 'this', 'that', 'one', 'them', 'these', 'those', 'the', 'a', 'to', 'in', 'into', 'my', 'basket', 'cart', 'bag', 'yes', 'yeah', 'ok', 'okay', 'go', 'ahead', 'and', 'just', 'size', 'thanks', 'thank', 'now', 'for', 'me', 'then', 'do', 'lets', 'let', 's']);
  return words.every((word) => filler.has(word) || !!normaliseSize(word));
}

/**
 * What the customer authorised adding - decided from them, before the
 * model's productId is looked at.
 *
 * "Add the One Pair Tour Ankle Socks" went into the basket as LADIES TOUR
 * ANKLE SOCKS: the model searched a shorter name, and whatever id it passed
 * was added. The target now comes from the customer, in this order - the
 * product their words name; a card they point at ("the second one", "the
 * navy one"); the card they just tapped, for a bare "add it"; the product a
 * waiting add was for, when they answer its size; the product the Caddie
 * offered, when they say yes; the product they are shopping for. Only when
 * none of those says anything is the model's pick used as it always was.
 */
type ActionTarget =
  | { kind: 'bound'; products: Product[]; label: string; source: 'customer-words' | 'screen-reference' | 'card-action' | 'pending' | 'offer' | 'last-reply' | 'focus' }
  | { kind: 'ambiguous'; designs: NamedDesign[] }
  | { kind: 'unbound' };

/** Of several designs a name fits, the ones the customer is looking at: on screen, in focus, or waiting to be added. */
function presented(ctx: ToolContext, designs: NamedDesign[]): NamedDesign[] {
  const onScreen = new Set((ctx.session.lastShown?.items ?? []).map((item) => item.id));
  const focus = ctx.session.activeShoppingContext;
  const waiting = new Set(livePending(ctx.session)?.productIds ?? []);
  return designs.filter(
    (design) =>
      design.products.some((product) => onScreen.has(product.id) || waiting.has(product.id) || product.id === focus?.productId) ||
      (!!focus?.design && design.design === focus.design.toUpperCase()),
  );
}

function fromIdentity(identity: CustomerIdentity, ctx: ToolContext, source: 'customer-words' | 'offer'): ActionTarget | null {
  if (identity.status === 'exact') return { kind: 'bound', products: [identity.product], label: identity.product.title, source };
  // In a colour it is not made in: bound to nothing, so nothing is added - the add asks which colour.
  if (identity.status === 'family') return { kind: 'bound', products: identity.colourMissing ? [] : identity.products, label: identity.design, source };
  if (identity.status === 'ambiguous') {
    const shown = presented(ctx, identity.designs);
    if (shown.length === 1) return { kind: 'bound', products: shown[0]!.products, label: shown[0]!.design, source };
    return { kind: 'ambiguous', designs: identity.designs };
  }
  return null;
}

export function actionTarget(ctx: ToolContext): ActionTarget {
  // The Add button: the customer clicked that exact product.
  if (ctx.direct) return { kind: 'unbound' };
  const said = ctx.utterance ?? '';
  const named = fromIdentity(resolveCustomerProductIdentity(said), ctx, 'customer-words');
  if (named) return named;

  const pointed = resolveProduct(ctx.session, said);
  if (pointed && /^(number \d|last on screen|on screen, from what they described)/.test(pointed.how)) {
    return { kind: 'bound', products: [pointed.product], label: pointed.product.title, source: 'screen-reference' };
  }
  const held = focusProduct(ctx.session.activeShoppingContext);
  const colours = parseColours(said).colours.map((colour) => colour.word);
  if (held && colours.length) {
    const inColour = designMembers(held).filter((product) => matchesColourText(product, colours.join(' or ')) > 0);
    if (inColour.length === 1) return { kind: 'bound', products: inColour, label: inColour[0]!.title, source: 'focus' };
  }

  const tappedId = tappedSinceLastSaid(ctx.session);
  const tapped = tappedId && bareReference(said) ? productById(tappedId) : null;
  if (tapped) return { kind: 'bound', products: [tapped], label: tapped.title, source: 'card-action' };

  const auth = cartAuthorization(ctx);
  const pending = livePending(ctx.session);
  if (auth.authorized && auth.source === 'continuation' && pending) {
    const waiting = pending.productIds.map((id) => productById(id)).filter((product): product is Product => !!product);
    if (waiting.length) return { kind: 'bound', products: waiting, label: waiting.length === 1 ? waiting[0]!.title : designOf(waiting[0]!.title), source: 'pending' };
  }
  if (auth.authorized && auth.source === 'confirmation') {
    const lastReply = [...ctx.session.messages].reverse().find((message) => message.role === 'assistant')?.text ?? '';
    const offer = offerSentence(lastReply);
    const offered = offer ? fromIdentity(resolveCustomerProductIdentity(offer, 'offer'), ctx, 'offer') : null;
    if (offered) return offered;
  }
  /*
   * The product the Caddie's last reply recommended by name - "I'd go for the
   * Elite Polo in navy. What size?" - "M, add it". Their "it" answers what
   * they were just told; a reply naming several is not one to pick from.
   */
  /*
   * "Yes, add this to the bag. The size is small." is authorised by their own
   * words but is not a bare reference, so nothing bound "this" - the add found
   * no target and the Caddie asked to confirm, again and again (preview store).
   * An authorised add pointing at "this", "that" or "it" is answered the same way.
   */
  const pointsBack = bareReference(said) || (auth.authorized && (auth.source !== 'utterance' || /\b(this|that|it)\b/i.test(said)));
  if (pointsBack) {
    const lastReply = [...ctx.session.messages].reverse().find((message) => message.role === 'assistant')?.text ?? '';
    const recommended = lastReply ? fromIdentity(resolveCustomerProductIdentity(lastReply, 'offer'), ctx, 'offer') : null;
    if (recommended?.kind === 'bound' && recommended.products.length) return { ...recommended, source: 'last-reply' };
  }
  /*
   * The only card on screen: "add it", "I'll take the M", "L" to "shall I
   * add it?" cannot mean anything else - unless they name a kind it is not.
   */
  const screenItems = (ctx.session.lastShown?.items ?? []).filter((item) => item.id);
  const only = screenItems.length === 1 ? productById(screenItems[0]!.id) : null;
  const kindsSaid = categoriesAsked(said);
  if (only && (bareReference(said) || auth.authorized) && (!kindsSaid.length || isCategory(only, kindsSaid))) {
    return { kind: 'bound', products: [only], label: only.title, source: 'screen-reference' };
  }
  /*
   * The product they are shopping for - while it is still what they are
   * looking at. After a search has put other cards on screen, "it" is the
   * Caddie's to resolve from those; a focus left over from before is not.
   */
  const members = held ? designMembers(held) : [];
  const shown = new Set((ctx.session.lastShown?.items ?? []).map((item) => item.id));
  if (held && members.some((product) => shown.has(product.id)) && pointsBack) {
    // The colour they settled on is theirs: the held colourway, not the whole design.
    const focusColours = ctx.session.activeShoppingContext?.colours ?? [];
    if (focusColours.length && matchesColourText(held, focusColours.join(' or ')) > 0) return { kind: 'bound', products: [held], label: held.title, source: 'focus' };
    return { kind: 'bound', products: members, label: designOf(held.title), source: 'focus' };
  }
  return { kind: 'unbound' };
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

/** The customer's named product, as the search's name check reports one. */
function existenceFrom(identity: CustomerIdentity): Existence | null {
  const resolution = { type: 'exact' as const, input: identity.status === 'exact' ? identity.product.title : '', corrections: [] };
  if (identity.status === 'exact') return { kind: 'exact-product', name: identity.product.title, product: identity.product, resolution };
  // In a colour it is not made in: left to the name check, which says so and shows what it does come in.
  if (identity.status === 'family' && identity.colourMissing) return null;
  if (identity.status === 'family') return { kind: 'exact-family', name: identity.design, familyName: identity.design, products: identity.products, resolution: { ...resolution, input: identity.design } };
  if (identity.status === 'ambiguous') {
    return { kind: 'possible-match', name: identity.designs.map((design) => design.design).join(' / '), products: identity.designs.flatMap((design) => design.products), reason: 'the name they gave fits more than one product' };
  }
  return null;
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
  const standing = shopperView(ctx.session).colours;
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
    const profile = shopperView(ctx.session);
    const currency = ctx.session.preferences.currency ?? storeCurrency();

    /*
     * A piece of the pack on screen, changed: a swap inside the pack, not a
     * search of the store. "Change this trouser with a white trouser" came
     * back as three white trousers from the whole store, two of which the
     * pack does not take - and the customer then asked for one of those.
     */
    /*
     * Only a pack still in hand. After "actually, show me polos" the pack's
     * card can still be on screen, but they have left it: this is a search
     * of the store, and the pack is not taken up again (Phase 3B).
     */
    const onScreenPack = packOnScreen(ctx);
    const packShown = onScreenPack && onScreenPack.handle === currentPack(ctx.session) ? onScreenPack : undefined;
    /*
     * "Can you show any other jacket available in small" asks to see the
     * choices, not to have one picked for them: the Warrior went out and a
     * jacket they had not chosen came in. Asking to see goes to the step's choices below.
     */
    /*
     * "The Warrior is sold out in small - show me another jacket available
     * in small", with the pack in hand but not on screen: that piece's
     * choices. Searched store-wide, the Clima and Wind Guard came back, and
     * the customer's choice then went in on its own (live replay).
     */
    const pieceChoices = await showPieceChoices(ctx);
    if (pieceChoices) return pieceChoices;
    const asksToSee = SEE_WORDS.test(ctx.utterance ?? '');
    if (packShown && !asksToSee && asksToChangePackPiece(packShown, ctx.utterance ?? '')) {
      const swapped = await dealAnswer({ query: ctx.session.lastShown?.query ?? packShown.title }, ctx, colourAsked(undefined, ctx.utterance), currency);
      if (swapped) return swapped;
    }
    /*
     * Asked about a piece while a pack is being built: that pack's own
     * choices, never the whole store. White trousers from everywhere put the
     * Premium Play Trousers next to the pack, and the customer took them for
     * a pack choice - they are not one.
     */
    const replacing = liveReplacement(ctx);
    const building = packShown ?? packChoicesInFocus(ctx) ?? replacing?.deal;
    if (building) {
      const named = stepNamed(building, `${ctx.utterance ?? ''} ${args.query}`);
      // "Show me the black ones" while a piece is being replaced: that piece's choices.
      const stepIndex = named >= 0 ? named : replacing && building === replacing.deal ? replacing.step : -1;
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
    const modelExistence = productName ? lookupProductName(nameAsked) : unflagged && intent.namedByCustomer(unflagged.name) ? unflagged : null;
    /*
     * A product the customer named, read from their words - never the
     * model's rewrite of them. "One Pair Tour Ankle Socks" was searched as
     * "tour ankle socks", and the lookup found the Ladies pair. The model's
     * name still helps find products; it never decides which one they meant.
     */
    const customerIdentity = ctx.direct ? ({ status: 'none' } as CustomerIdentity) : resolveCustomerProductIdentity(ctx.utterance ?? '');
    const own = new Set(identityProducts(customerIdentity).map((p) => p.id));
    const modelIds = modelExistence?.kind === 'exact-product' ? [modelExistence.product.id] : modelExistence?.kind === 'exact-family' ? modelExistence.products.map((p) => p.id) : [];
    // The same product the customer named: the lookup's own report, which says when a misspelling was read ("galatic" is GALACTIC).
    const agrees = modelIds.length > 0 && modelIds.every((id) => own.has(id));
    const existence = agrees ? modelExistence : existenceFrom(customerIdentity) ?? modelExistence;
    if (customerIdentity.status !== 'none') {
      const rejected = modelIds.length > 0 && !modelIds.some((id) => own.has(id));
      log[rejected ? 'warn' : 'info'](rejected ? 'identity.rejected_model_target' : 'identity.resolved', {
        sessionId: ctx.session.id,
        customer: describeIdentity(customerIdentity),
        modelProposal: modelExistence ? `${modelExistence.kind}: ${modelExistence.name}` : null,
        tool: 'search_products',
      });
    }
    /*
     * Every rule this request set, checked on every product - the named ones
     * too. The ladies Apex polo in blush once led a search for a black Apex
     * polo, and "navy polo in XL" was answered with polos sold out in XL.
     * What fails a rule is not shown, however well it scores.
     */
    const wantedColour = filterColour ? parseColours(filterColour) : null;
    // Whether it may be offered, in the sizes of theirs that apply to it (tools/eligibility.ts).
    const offerRule = eligibilityOf(ctx);
    const failures = (product: Product): string[] => {
      const out: string[] = [];
      if (!product.variants.some((variant) => variant.available)) out.push('sold out');
      else {
        const offer = offerRule.decide(product);
        if (offer.offer !== 'eligible' && offer.reason) out.push(offer.reason);
      }
      if (!inRange(product, nameRange, known)) out.push('not in that range');
      if (wantedColour && (wantedColour.colours.length || wantedColour.plain) && colourMatch(product, wantedColour.colours, true, wantedColour.plain) === 0) {
        out.push(`not ${filterColour}`);
      }
      if (categories.length && !isCategory(product, categories)) out.push(`not a ${categories.join(' or ')}`);
      if (size) {
        // Only a size that applies: a cap in one size is not "not made in M", a polo not "not made in 32".
        const status = sizeStatus(product, size);
        if (status === 'sold-out') out.push(`sold out in ${size}`);
        else if (status === 'not-made' || status === 'other-scale') out.push(`not made in ${size}`);
      }
      if (ceiling !== undefined && priceFor(product, size).amount > ceiling) out.push(`over ${money(ceiling, currency)}${size ? ` in ${size}` : ''}`);
      for (const feature of mustDo) if (!hasFeature(product, feature)) out.push(`${FEATURE_LABEL[feature]} not stated in its description`);
      return [...new Set(out)];
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
      recentShown: [...new Set([...(wantsAnother ? (ctx.session.recentShown ?? []) : []), ...products.map((p) => p.id)])].slice(-40),
      ...(lead ? { lastLead: { id: lead.id, colour: colourwayName(lead.title).toLowerCase() } } : {}),
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

    /*
     * The product they named, not to be had in their size or at all, and
     * nothing else to show: said as that - informational only, never a card.
     * It fell through to "we do not have the Warrior Jacket in red - it does
     * come in red" when their size was their usual one rather than said now.
     */
    const namedAll = existence?.kind === 'exact-product' ? [existence.product] : existence?.kind === 'exact-family' ? existence.products : [];
    if (products.length === 0 && namedAll.length && !namedAll.some(meetsRules)) {
      const subject = namedAll[0]!;
      const why = failures(subject).join(', ');
      return {
        speech: `The ${titleCaseWords(existence?.kind === 'exact-family' ? garmentName(subject.title) : subject.title)} is ${why} right now. Shall I find you something similar that is available?`,
        facts: `${subject.title} is the product they named, but it is ${why} - informational only: say so, never show or offer it as something to buy. Offer available alternatives.${existenceFacts ? `\n${existenceFacts}` : ''}`,
      };
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
    const leadSized = !!lead && !sizeScale(lead).oneSize;
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
    // A lookup is not the customer's focus: loading a card, or the model checking a product, moves nothing (Phase 3B).
    const verified = [
      attributes.features.length ? `Its description states: ${attributes.features.map((f) => FEATURE_LABEL[f]).join(', ')}.` : 'Its description states no technical features - do not claim any.',
      attributes.fit ? `Cut: ${attributes.fit}.` : shopperView(ctx.session).fit ? 'Cut: not stated in its description - never describe its fit.' : '',
      attributes.materials.length ? `Fabric: ${attributes.materials.join(', ')}.` : '',
      // Every size and colour, in stock or not, from the full product - a narrowed lookup holds one variant.
      `Stock: ${describeStock(productById(product.id) ?? product)}`,
    ]
      .filter(Boolean)
      .join(' ');
    const next = await nextStep([product], {
      profile: shopperView(ctx.session, ctx.utterance),
      basketProductIds: (ctx.session.basket ?? []).map((line) => line.productId),
      eligible: eligibilityOf(ctx).eligible,
    });

    /*
     * Shopify returns a default variant even when nothing was selected, so the
     * variant count says nothing about whether the customer has chosen. What
     * counts is whether WE passed a selection - or whether there was anything
     * to choose in the first place.
     */
    const hasSelection = Boolean(args.options && Object.keys(args.options).length > 0);
    /*
     * The variant chosen, only when the choices name exactly one - through
     * the same resolver the basket uses (catalog/commerce.ts). A size with the
     * colour still open is not a variant, and its first one is not an answer.
     */
    const resolution = resolveVariant(productById(product.id) ?? product, hasSelection ? args.options : {});
    const chosen = resolution.status === 'exact' ? resolution.variant : null;

    /*
     * Asked about by name, and not to be had in their size (or at all): said,
     * never shown as a card to choose - informational only. "Do you have the
     * Warrior Jacket in S?" is "it's sold out in S", then what is.
     */
    const offer = eligibilityOf(ctx).decide(productById(product.id) ?? product, { named: true });
    if (!ctx.direct && (offer.offer !== 'eligible' || (chosen && !chosen.available))) {
      const why = chosen && !chosen.available ? `sold out in ${Object.values(chosen.options).join(' / ')}` : offer.reason ?? 'sold out';
      return {
        speech: `The ${titleCaseWords(product.title)} is ${why} right now. Shall I find you something similar that is available?`,
        facts: `${product.title} is ${why} - informational only: say so, never show or offer it as something to buy, and never add it. Offer available alternatives (search_products).`,
      };
    }

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
    /*
     * The garment being sized: the one the customer means - named, pointed
     * at, in hand, or the page for "this" - or the form's own product. The
     * model's product counts only when it is that design: a lookup of the
     * Clima Jacket must not size a customer who is looking at a polo.
     */
    const offered = productId ? productById(productId) : null;
    const sizingTarget: TrustedTarget = ctx.sizeForm || ctx.direct ? { status: 'none' } : trustedProductTarget(ctx.session, ctx.utterance ?? '');
    if (sizingTarget.status === 'ambiguous') {
      return { speech: `Which do you mean - ${sizingTarget.designs.map((design) => titleCaseWords(design)).join(' or ')}?`, facts: `What they named fits more than one product: ${sizingTarget.designs.join('; ')}. Ask which before sizing.` };
    }
    const product =
      ctx.sizeForm || ctx.direct ? offered : sizingTarget.status === 'product' ? (agreesWithTarget(sizingTarget, offered) ? offered : sizingTarget.products[0]!) : null;
    if (offered && product?.id !== offered.id && !agreesWithTarget(sizingTarget, offered) && !ctx.sizeForm && !ctx.direct) {
      log.warn('size.model_product_ignored', { sessionId: ctx.session.id, proposed: offered.title, sized: product?.title ?? null });
    }
    const productRange = product ? rangeOf(product) : undefined;
    const facts = trustedShopperFacts(ctx.session);
    const view = shopperView(ctx.session, ctx.utterance);

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
      measurements.heightValue !== facts.measurements.heightValue &&
      measurements.heightValue !== form?.heightValue &&
      !HEIGHT_SAID.test(ctx.utterance ?? '')
    ) {
      log.warn('size.height_not_given', { sessionId: ctx.session.id, said: ctx.utterance?.slice(0, 120) });
      delete measurements.heightValue;
      delete measurements.heightUnit;
    }
    /*
     * The same for weight, chest and waist: a number the model supplies
     * must be one they gave - typed into the form, told us before, or said
     * in their words (in any unit the model converted from). A chest nobody
     * gave would size them as firmly as one they measured.
     */
    for (const field of ['weightValue', 'chestCm', 'waistCm'] as const) {
      const value = measurements[field];
      if (value === undefined || value === form?.[field] || value === facts.measurements[field] || measurementSaid(field, value, ctx)) continue;
      logFact(ctx.session.id, field, 'model-hint', 'turn', false, undefined, 'no such measurement in their words');
      delete measurements[field];
      if (field === 'weightValue') delete measurements.weightUnit;
    }

    /*
     * Which chart: the form's answer, their words, the garment's own range,
     * the range they are shopping now, the range they told us is theirs - and
     * only then the model's guess, or what is on screen. The model's audience
     * once came first, and replaced what the customer had said.
     */
    const current = currentRange(ctx.session);
    const audience =
      form?.audience ??
      /*
       * Said in their own words. "I need a womens polo, my chest is 100cm"
       * reached this tool without the range four times in five, and the
       * customer was asked whether they meant womens.
       */
      saidRange(ctx.utterance) ??
      // The garment they asked about knows its own range.
      (productRange === 'men' || productRange === 'women' ? productRange : undefined) ??
      (current === 'men' || current === 'women' ? current : undefined) ??
      (form ? undefined : args.audience) ??
      audienceOf(onScreen(ctx)) ??
      // A store that only sells one range has already answered the question.
      audienceOf(allProducts().filter(isBrandProduct));
    /*
     * With a pack in hand and no one product named, the pack's own garment is
     * what is being sized: "chest 36, waist 32, leg 34" for the Cool & Wet
     * pack reached this tool as category "top" - no such chart - and the
     * customer was asked for a category. A chest sizes the pack's tops, a
     * waist its trousers, each on that piece's own chart.
     */
    const packPiece = !product && audience ? packSizingPiece(ctx, args.category, measurements) : null;
    // The product decides the chart: trousers are sized by the waist, whatever was asked.
    const category =
      (product && audience ? chartCategoryOf(product, audience) : undefined) ??
      (packPiece && audience ? chartCategoryOf(packPiece, audience) : undefined) ??
      sizingCategory(args.category, audience, ctx);

    /*
     * Fit and layering move the size, so they need the customer's evidence
     * like anything else: the form's fit, or their own words - this turn,
     * earlier in this shopping, or what they told us about themselves. The
     * model's `relaxed` or `layering: true` alone once moved a size up that
     * nobody had asked to move.
     */
    const fit = form?.fitPreference ?? view.fit;
    if (measurements.fitPreference !== undefined && measurements.fitPreference !== fit) {
      logFact(ctx.session.id, 'fit', 'model-hint', 'turn', false, measurements.fitPreference, 'not in the customer’s words or profile');
    }
    delete measurements.fitPreference;
    const layers = !!view.layering;
    if (layering !== undefined && layering !== layers) logFact(ctx.session.id, 'layering', 'model-hint', 'turn', false, layering, 'not in the customer’s words');

    // What they gave us before, then what they gave now.
    const profile = {
      ...facts.measurements,
      ...measurements,
      ...(facts.usualSize && !measurements.usualSize ? { usualSize: facts.usualSize } : {}),
      ...(fit ? { fitPreference: fit } : {}),
      audience,
      ...(category ? { category } : {}),
    };
    const recommendation = recommendSize(profile, {
      layering: layers,
      ...(product ? { productTitle: product.title } : {}),
      ...(product && attributesOf(product).fit ? { productFit: attributesOf(product).fit } : {}),
    });

    /*
     * What is theirs is kept as theirs: measurements they gave, the usual
     * size and range they typed into the form. The answer is kept as ours -
     * a recommendation beside their usual size, never in its place. It once
     * became "usually wears M" for every picker, search and pack after.
     */
    const source = form ? 'ui-form' : 'customer-words';
    await rememberMeasurements(ctx.session.id, measurements, source);
    // A usual size in their words that nothing recorded yet - only the latest they gave, so an old "XL" never undoes "I'm usually M now".
    if (!form && asUsual && measurements.usualSize && !facts.usualSize && latestUsualSaid(ctx) === asUsual.toUpperCase()) {
      await rememberShopper(ctx.session.id, { usualSize: asUsual }, 'customer-words');
    }
    if (formUsual || form?.audience) {
      await rememberShopper(ctx.session.id, { ...(formUsual ? { usualSize: formUsual } : {}), ...(form?.audience ? { range: form.audience } : {}) }, 'ui-form');
    }
    if (recommendation.size && recommendation.basis !== 'none') {
      const bySize = /^\d{2}$/.test(recommendation.size) && /short|trouser|skort/.test(category ?? '');
      const record: SizeRecommendationRecord = {
        size: recommendation.size,
        scale: bySize ? 'waist' : 'top',
        ...(category ? { category } : {}),
        ...(product ? { productId: product.id } : {}),
        basis: recommendation.basis,
        turn: customerTurn(ctx.session),
        at: Date.now(),
      };
      /*
       * One turn, both charts: the pack's top size is kept. The model sized
       * the tops from the chest, then the trousers from the waist the
       * customer had just said - and "32" replaced S, so their yes accepted a
       * top size of 32. The waist was theirs already; the top size is the
       * answer they are being asked to accept.
       */
      const earlier = ctx.session.sizeRecommendation;
      const keepTop = !!currentPack(ctx.session) && record.scale === 'waist' && earlier?.scale === 'top' && earlier.turn === record.turn;
      if (keepTop) log.info('size.pack_top_kept', { sessionId: ctx.session.id, top: earlier!.size, waist: record.size });
      else {
        await sessions.patch(ctx.session.id, { sizeRecommendation: record });
        logFact(ctx.session.id, 'recommendedSize', 'derived-recommendation', 'shopping-session', true, record.size);
      }
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
 * The piece of the pack in hand a sizing question is about: the kind the
 * customer or the model named, when a piece of the pack is that kind; the
 * trousers for a waist given alone; otherwise the first piece sized in
 * letters - the tops, which share the pack's one top size. Null without a
 * pack, or when nothing in it is sized.
 */
function packSizingPiece(ctx: ToolContext, proposed: string | undefined, measurements: { chestCm?: number; waistCm?: number; heightValue?: number; weightValue?: number }): Product | null {
  if (ctx.sizeForm || ctx.direct) return null;
  const handle = currentPack(ctx.session);
  if (!handle) return null;
  const pieces = packPieces(ctx.session, handle).filter((piece) => !sizeScale(piece).oneSize);
  const bottoms = pieces.filter((piece) => sizeScale(piece).dimensions.some((dimension) => dimension.scale === 'waist'));
  const tops = pieces.filter((piece) => sizeScale(piece).dimensions.some((dimension) => dimension.scale === 'letter'));
  const kinds = [...requestedKinds(ctx.utterance ?? ''), ...(proposed ? categoriesAsked(proposed) : [])];
  const ofKind = pieces.find((piece) => kinds.some((kind) => isCategory(piece, [kind])));
  if (ofKind) return ofKind;
  const waistOnly = measurements.waistCm !== undefined && measurements.chestCm === undefined && measurements.heightValue === undefined && measurements.weightValue === undefined;
  if (waistOnly || /\b(trouser|short|skort|jogger|pant|waist|bottom)/i.test(proposed ?? '')) return bottoms[0] ?? null;
  return tops[0] ?? bottoms[0] ?? null;
}

/**
 * The chart to size on when no product is: the form's, or the kind the
 * customer asked for (their words, or what they are shopping for). The
 * model's category counts only when it is that kind; with nothing to go on,
 * none - the general chart, never a garment the model picked.
 */
function sizingCategory(proposed: string | undefined, audience: 'men' | 'women' | undefined, ctx: ToolContext): string | undefined {
  if (ctx.sizeForm || ctx.direct) return proposed;
  const kinds = [...new Set([...requestedKinds(ctx.utterance ?? ''), ...(ctx.session.activeShoppingContext?.kinds ?? [])])];
  if (!kinds.length) {
    if (proposed) log.warn('size.model_category_ignored', { sessionId: ctx.session.id, proposed });
    return undefined;
  }
  const fromKinds = audience ? kinds.map((kind) => categoryForProduct(audience, kind)).filter((found): found is string => !!found) : [];
  if (proposed && audience && fromKinds.includes(categoryForProduct(audience, proposed) ?? proposed)) return proposed;
  if (proposed && !fromKinds.length && categoriesAsked(proposed).some((kind) => kinds.includes(kind))) return proposed;
  if (proposed) log.warn('size.model_category_ignored', { sessionId: ctx.session.id, proposed, asked: kinds });
  return fromKinds[0];
}

/**
 * Whether a size is one they called their usual size: said as such in any of
 * their messages ("I'm usually XL", "my normal size is L" - read by the same
 * reader that keeps their profile), or already their usual size.
 */
function usualSizeGiven(size: string, ctx: ToolContext): boolean {
  const key = (value: string | undefined) => (value ? (normaliseSize(value) ?? value).toUpperCase() : undefined);
  const wanted = key(size);
  const known = [trustedShopperFacts(ctx.session).usualSize].map(key);
  if (known.includes(wanted)) return true;
  const said = [...ctx.session.messages.filter((message) => message.role === 'user').map((message) => message.text), ctx.utterance ?? ''];
  return said.some((text) => key(readIntent(text).usualSize) === wanted);
}

/** The usual size in the most recent of their messages that states one. */
function latestUsualSaid(ctx: ToolContext): string | undefined {
  const said = [...ctx.session.messages.filter((message) => message.role === 'user').map((message) => message.text), ctx.utterance ?? ''];
  for (const text of said.reverse()) {
    const size = readIntent(text).usualSize;
    if (size) return (normaliseSize(size) ?? size).toUpperCase();
  }
  return undefined;
}

/**
 * Whether a measurement is one the customer said: a number in their words
 * this conversation, as said or as the model would have converted it -
 * inches to centimetres, pounds or stone to kilograms. "My chest is 40
 * inches" arrives as 101.6cm.
 */
function measurementSaid(field: 'weightValue' | 'chestCm' | 'waistCm', value: number, ctx: ToolContext): boolean {
  const said = [...ctx.session.messages.filter((message) => message.role === 'user').map((message) => message.text), ctx.utterance ?? ''].join(' ').toLowerCase();
  const word = field === 'weightValue' ? /\b(weigh|weight|kg|kilos?|lbs?|pounds|stone|st)\b/ : field === 'chestCm' ? /\bchest\b/ : /\bwaist\b/;
  if (!word.test(said)) return false;
  const numbers = [...said.matchAll(/\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
  const factors = field === 'weightValue' ? [1, 0.4536, 6.35, 2.2046] : [1, 2.54, 1 / 2.54];
  return numbers.some((number) => factors.some((factor) => Math.abs(number * factor - value) <= Math.max(1.5, value * 0.02)));
}

/**
 * A budget the model passed, when the customer gave that amount - in this
 * message or earlier, or as the budget this shopping session holds. Otherwise
 * none: a spending limit nobody gave is not one to build a pack under.
 */
function groundedBudget(amount: number | undefined, ctx: ToolContext): number | undefined {
  if (amount === undefined) return undefined;
  const said = [...ctx.session.messages.filter((message) => message.role === 'user').slice(-6).map((message) => message.text), ctx.utterance ?? ''];
  const inWords = said.some((text) => readIntent(text).budget?.amount === amount || new RegExp(`(?:£|\\$|€)\\s?${String(amount).replace('.', '\\.')}(?![\\d])`).test(text));
  if (inWords || shopperView(ctx.session).budget?.amount === amount) return amount;
  logFact(ctx.session.id, 'budget', 'model-hint', 'turn', false, amount, 'no budget of that amount was given');
  return undefined;
}

/**
 * The size a pack or outfit is built in - which pieces are in stock depends
 * on it. The model's size counts only when it is one the customer gave for
 * this mission, or their usual size, a size recommendation they accepted, or
 * the pack's own confirmed choice; otherwise their usual size, or none, and
 * the pieces are chosen size-neutrally. A model's "M" once decided which
 * pieces a customer who had said nothing about size was shown.
 */
export function trustedSize(proposed: string | undefined, ctx: ToolContext): string | undefined {
  const usual = trustedShopperFacts(ctx.session).usualSize;
  if (!proposed?.trim()) return usual;
  const size = normaliseSize(proposed) ?? proposed.trim().toUpperCase();
  const pack = currentPack(ctx.session);
  const chosen = pack ? ctx.session.packChoices?.[pack] : undefined;
  if ([chosen?.top, chosen?.waist].some((value) => !!value && value.toUpperCase() === size.toUpperCase())) return size;
  if (sizesNeverGiven([size], ctx).length === 0) return size;
  logFact(ctx.session.id, 'size', 'model-hint', 'turn', false, size, 'not given by the customer for this mission');
  return usual;
}

/** Whether the model's name for a pack is this pack. */
function chooseDealMatches(proposed: string, deal: DealRecipe): boolean {
  const found = chooseDeal(proposed, deal.range);
  return !!found && (('deal' in found && found.deal.handle === deal.handle) || ('ask' in found && found.ask.includes(deal)));
}

/** Words that ask for a pack or a selection of things, not one garment. */
const PACK_REQUEST = /\b(packs?|bundles?|deals?|kits?|sets?|a few (things|bits|pieces)|several (things|pieces)|some (things|bits|pieces)|essentials|basics|starter|everything I need|whole (kit|lot|outfit)|selection)\b/i;

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
  const size = trustedSize(args.size, ctx);
  // Every piece chosen, kept or shown again must be one they can buy in their size (tools/eligibility.ts).
  const eligible = eligibilityOf(ctx).packPiece;
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
  const weather = readIntent(said).weather ?? shopperView(ctx.session).weather;
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
  const inHand = currentPack(ctx.session);
  const inFocus = inHand && remembered[inHand] ? allDeals().find((deal) => deal.handle === inHand) : undefined;
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
    // A piece to swap in that is not to be had in their size: said, and nothing changes.
    if (chosen && !eligible(productById(chosen.id) ?? chosen)) {
      const why = eligibilityOf(ctx).decide(productById(chosen.id) ?? chosen, { named: true }).reason ?? 'sold out';
      return {
        speech: `The ${titleCaseWords(chosen.title)} is ${why}, so I've left the pack as it is. Shall I show you the ones that can go in?`,
        facts: `${chosen.title} is ${why} - it cannot go in the pack. Nothing changed. Offer the pieces that are available (search for that piece of the pack).`,
      };
    }
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
    // A swap they asked for: the piece is turned down for this shopping session, not for good.
    if (outgoing) await noteShoppingConstraints(ctx.session.id, { rejected: [outgoing.id], ...(chosen ? { liked: [chosen.id] } : {}) }, 'customer-confirmation');
    const turnedDown = shopperView(ctx.session).rejected ?? [];
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
      eligible,
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
    // The step being replaced now holds their choice, however the swap came: the replacement is over.
    if (ctx.session.activeShoppingContext?.replacing?.step === index) await setReplacement(ctx.session.id, undefined);
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
    /*
     * A configured pack is rebuilt only when they ask for the whole pack to
     * change: "start the pack again", "the whole pack in navy", a new colour
     * for the pack itself or in answer to "which colour for the whole pack?".
     * Any "another", "change", "different" or colour in the sentence used to
     * rebuild every piece - "S, any other option?" brought back a new gilet,
     * midlayer, polo and trousers (live replay). A change to one piece is that
     * piece's (the swap above); one without a piece named is asked about.
     */
    const lastReply = [...ctx.session.messages].reverse().find((message) => message.role === 'assistant')?.text ?? '';
    const packRecoloured = recoloured && (/\bpack\b/i.test(said) || /\bwhole pack\b/i.test(lastReply));
    const changing = !!before && (WHOLE_PACK.test(said) || (wholePack && !!colour) || packRecoloured);
    // Judged in the sizes they gave before this pack was in hand too (earlierPackChoices).
    const packRule = packRuleFor(ctx, namedDeal);
    const fill = { ...(size ? { size } : {}), ...(colour ? { colour } : {}), ...(suits ? { weather: suits } : {}), eligible: packRule };

    if (before && !changing && slotIndex < 0 && (changeWords || recoloured) && !namesADeal(said.replace(/\b(ambassador )?pack\b/gi, ' '))) {
      const pieces = before.items.map((item) => item.title).filter(Boolean);
      return {
        speech: `Which piece of the ${titleCaseWords(namedDeal.title)} would you like to change?`,
        facts: `A change was asked for without saying which piece; nothing was changed. Pieces: ${pieces.join('; ')}. Ask which one - the rest stays as it is.`,
      };
    }

    // Back to a pack they have already seen, unchanged: the pieces they saw.
    if (before && !changing) {
      const again = before.items.map((item) => (item.id ? productById(item.id) : null));
      if (again.every((piece) => piece && packRule(piece))) {
        return withOtherVersions(namedDeal, await showDeal(namedDeal, again, ctx, currency, args.query, fill), said);
      }
      /*
       * A piece they saw can no longer be had in their size: it is not shown
       * as part of the pack, and nothing is put in its place for them - that
       * step waits for their choice, from what can be had (V1 task 2).
       */
      const index = again.findIndex((piece) => !piece || !packRule(piece));
      if (index >= 0 && again.every(Boolean)) return replacementRequired({ ...ctx, session: await sessions.getOrCreate(ctx.session.id) }, namedDeal, index);
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
  const handle = currentPack(ctx.session);
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

/** Asking to see what there is, rather than choosing: "can you show any other jacket available in small". */
const SEE_WORDS = /\b(show|see|options|available|have you got|do you have|what (other|else)|which (other|ones?))\b/i;

/**
 * "Can you show any other jacket available in small size" about a piece of
 * the pack in hand: that piece's choices, for them to pick from. The model
 * reached for recommend_pack with a swap and put in a Clima Jacket nobody
 * had chosen (live replay). A design they name is a choice, and is left to
 * the swap.
 */
async function showPieceChoices(ctx: ToolContext): Promise<ToolResult | null> {
  const said = ctx.utterance ?? '';
  const handle = ctx.direct ? undefined : currentPack(ctx.session);
  const deal = handle ? allDeals().find((entry) => entry.handle === handle) : undefined;
  if (!deal || !SEE_WORDS.test(said) || !(CHANGE_WORDS.test(said) || /\b(sold out|out of stock|not available|unavailable)\b/i.test(said))) return null;
  if (SEPARATELY.test(said)) return null;
  const index = stepNamed(deal, said);
  if (index < 0) return null;
  // A design named that is not the piece going out: they have chosen, not asked to see.
  const outgoing = packPieces(ctx.session, deal.handle)[index];
  const named = identityProducts(resolveCustomerProductIdentity(said));
  if (named.some((product) => !outgoing || designOf(product.title) !== designOf(outgoing.title))) return null;
  log.info('pack.piece_choices_shown', { sessionId: ctx.session.id, pack: deal.handle, step: deal.steps[index]!.title });
  return packStepChoices(deal, index, ctx, colourAsked(undefined, said));
}

/** The size a piece of the pack is configured in - its chosen size option, never the leg. */
function pieceSize(session: CaddieSession, handle: string, index: number): string | undefined {
  const plan = packStatus(session, handle).pieces[index];
  return Object.entries(plan?.chosen ?? {}).find(([name]) => !/leg|length|inseam/i.test(name))?.[1];
}

/** A swap offered in the Caddie's words: "Would you like to swap the Warrior for the Caddy Cloud in Small?", "I can swap it for another jacket - shall I?". */
// However it is worded: "swap X for Y?", "shall I add the Vapor to your pack?", "would you like to choose it?" (live replay).
const SWAP_OFFER = /\b(swap|replace|switch|change|exchange|instead|put in|(?:add|update) [^?]*\b(?:to|with|in) (?:your|the) (?:[a-z&' -]{0,40}\s)?pack\b|update [^?]*\bpack\b|with (?:this|that|the new) (?:jacket|gilet|polo|midlayer|trousers|shorts|belt|cap|piece|one|choice)|(?:choose|pick|take|select) (?:it|that|this one|this)|go with (?:it|that|this one)|(?:want|like) (?:it|that|this one)|in (?:its|the warrior'?s) place|(?:use|have|keep) (?:it|this|that|this one|that one|the new one|this jacket|this one)\b[^?]*\bpack\b)/i;

/** "Men's Caddy Cloud Jacket" and "CADDY CLOUD JACKET - NAVY/RED" as the same words. */
function plainWords(text: string): string {
  return ` ${text.toLowerCase().replace(/\b(men'?s|mens|ladies|women'?s|womens|the)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

/**
 * The swap the Caddie's reply just offered, kept so their yes can be bound to
 * it (Cool & Wet, preview store). "Would you like to swap the Warrior Jacket
 * for the Caddy Cloud Jacket in Small?" - "Yes, please replace it" was not
 * tied to anything: the model called add_pack_to_cart again, the pack was
 * still not ready for the sold-out Warrior, and the same offer came back.
 *
 * Read from the Caddie's own reply, as offeredAction reads an offered add -
 * but only ever bound to a product the pack's step takes, in stock in the
 * piece's size. A reply offering nothing clears the offer.
 */
export async function notePackSwapOffer(sessionId: string, reply: string): Promise<void> {
  const session = await sessions.getOrCreate(sessionId);
  const handle = currentPack(session);
  const deal = handle ? allDeals().find((entry) => entry.handle === handle) : undefined;
  if (!deal) return;
  const replacing = session.activeShoppingContext?.replacing;
  // Bound already this turn, from the model's own reply before the checker rewrote it: the record outlives the words (V1 task 3).
  if (session.pendingAction?.type === 'replace-pack-piece' && session.pendingAction.turn === customerTurn(session, false)) return;
  const question = reply.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.includes('?')).pop() ?? '';
  // "It would replace the Warrior in your pack. Should I add it for you?": with a piece being replaced, an "add it" is the swap.
  const offering =
    SWAP_OFFER.test(question) ||
    (!!replacing && /\b(?:add(?:ing)?|put(?:ting)?|proceed(?: with(?: adding)?)?|go ahead(?: with)?) (?:it|this|that|this one|that one)\b/i.test(question) && SWAP_OFFER.test(reply));
  const soldOut = packStatus(session, deal.handle).pieces.findIndex((plan) => plan.soldOut);
  const index = replacing?.step ?? soldOut;
  if (index < 0 || !deal.steps[index]) return;
  const step = deal.steps[index]!;
  const outgoing = packPieces(session, deal.handle)[index];
  const size = replacing?.size ?? pieceSize(session, deal.handle, index);
  const pool = [...step.productIds]
    .map((id) => productById(id))
    .filter((product): product is Product => !!product && (!outgoing || designOf(product.title) !== designOf(outgoing.title)))
    .filter(eligibilityFor(session, '', size ? [{ size }] : []).eligible);
  /*
   * The product offered: named in the question, or - "I'd suggest the Vapor
   * Jacket 2.0 in navy. Would you like me to add it to your pack instead of
   * the Warrior?" - in the reply just before it (live replay). Several named
   * across the reply bind nothing.
   */
  /*
   * State first (V1 task 3): the one candidate there is, or the one the
   * model selected by looking it up (replacing.proposed). Only with neither
   * does the name in the reply select - reported as the last prose-dependent
   * selection; the yes never reads prose either way.
   */
  const looked = replacing?.proposed?.turn === customerTurn(session, false) ? replacing.proposed.ids : [];
  // Or the one the reply suggested before a rewrite lost its name (offer.suggested, this turn).
  const suggested = replacing?.offer?.suggested && replacing.offer.turn === customerTurn(session) ? pool.find((product) => product.id === replacing.offer?.productId) : undefined;
  const proposed = looked.length === 1 ? pool.find((product) => product.id === looked[0]) : suggested;
  const words = plainWords(question);
  let named = proposed ? [proposed] : pool.length === 1 ? [pool[0]!] : pool.filter((product) => words.includes(plainWords(designOf(product.title))));
  if (!named.length) {
    const whole = plainWords(reply);
    named = pool.filter((product) => whole.includes(plainWords(designOf(product.title))));
    // Misspelt by the model ("Vapour" for the Vapor): the same name reader the customer's words go through.
    if (!named.length) {
      const read = identityProducts(resolveCustomerProductIdentity(reply, 'offer'));
      named = pool.filter((product) => read.some((found) => designOf(found.title) === designOf(product.title)));
    }
    // "The Vapor in navy": a design's own first word, when only one design in the pool starts with it.
    if (!named.length) {
      const first = (product: Product) => plainWords(designOf(product.title)).trim().split(' ')[0] ?? '';
      const distinct = pool.filter((product) => first(product).length >= 4 && whole.includes(` ${first(product)} `));
      if (new Set(distinct.map((product) => designOf(product.title))).size === 1) named = distinct;
    }
    if (named.length > 1) {
      const colours = parseColours(reply).colours;
      const inColour = colours.length ? named.filter((product) => colourMatch(product, colours, false) > 0) : [];
      if (inColour.length) named = inColour;
    }
  }
  if (named.length > 1) {
    // Its colour: in the question, else in the reply before it ("the Tech Jacket in black… Should I swap the Warrior for this Tech Jacket?").
    const going = new Set(outgoing ? productColourWords(outgoing, false) : []);
    for (const text of [question, reply]) {
      const colours = parseColours(text).colours.filter((colour) => !going.has(colour.word));
      const inColour = colours.length ? named.filter((product) => colourMatch(product, colours, false) > 0) : [];
      if (inColour.length && inColour.length < named.length) {
        named = inColour;
        break;
      }
    }
  }
  const productId = named.length === 1 ? named[0]!.id : undefined;
  if (!offering) {
    /*
     * No swap asked. One candidate named all the same ("I'd suggest the Vapor
     * Jacket 2.0 in navy. Would you like its full details?") is the candidate
     * established: "replace it" next turn means this one, and is never met
     * with "which jacket?" (live replay, V1 task 3). A bare yes is not a swap
     * - it answers whatever was asked (confirmPackSwap).
     */
    if (replacing && productId) {
      await setReplacement(sessionId, { step: replacing.step, candidates: replacing.candidates, ...(replacing.size ? { size: replacing.size } : {}), offer: { productId, turn: customerTurn(session), suggested: true } });
      log.info('pack.swap_suggested', { sessionId, pack: deal.handle, suggested: named[0]!.title });
    } else if (replacing?.offer) await setReplacement(sessionId, { step: replacing.step, candidates: replacing.candidates, ...(replacing.size ? { size: replacing.size } : {}) });
    return;
  }
  // Several named: nothing bound - their yes will not guess - and no earlier offer left standing in its place.
  if (!productId && named.length > 1) {
    log.info('pack.swap_offer_unbound', { sessionId, named: named.map((product) => product.title), reply: reply.slice(0, 300) });
    if (replacing) await setReplacement(sessionId, { step: replacing.step, candidates: replacing.candidates, ...(replacing.size ? { size: replacing.size } : {}) });
    // And no earlier swap left waiting for a yes that this offer did not make.
    if (session.pendingAction?.type === 'replace-pack-piece') await sessions.patch(sessionId, { pendingAction: undefined });
    return;
  }
  const candidates = productId ? replacing?.candidates ?? pool.map((product) => product.id) : pool.map((product) => product.id);
  await setReplacement(sessionId, { step: index, candidates, ...(size ? { size } : {}), offer: { ...(productId ? { productId } : {}), turn: customerTurn(session) } });
  /*
   * The one record of what a yes now means (tools/pending.ts): the pack, the
   * step, the piece going out and the one offered in its place.
   */
  if (productId) {
    await sessions.patch(sessionId, {
      pendingAction: {
        type: 'replace-pack-piece',
        productIds: [productId],
        pack: deal.handle,
        step: index,
        ...(outgoing ? { outgoing: outgoing.id } : {}),
        ...(size ? { options: { size } } : {}),
        awaiting: 'confirmation',
        missing: ['confirmation'],
        authorized: false,
        // "Which jacket would you like to replace it with?" over a bound swap is not the question; the exact swap is.
        question: /^\s*(?:which|what)\b/i.test(question) && outgoing ? `Shall I swap the ${titleCaseWords(garmentName(outgoing.title))} for the ${titleCaseWords(garmentName(productById(productId)!.title))} in ${colourwayName(productById(productId)!.title).toLowerCase()}${size ? `, in ${size}` : ''}?` : question,
        // The messages so far, as the gateway stamps its records.
        turn: customerTurn(session, false),
        mission: currentMission(session),
      },
    });
  } else if (session.pendingAction?.type === 'replace-pack-piece') await sessions.patch(sessionId, { pendingAction: undefined });
  log.info('pack.swap_offered', { sessionId, pack: deal.handle, step: step.title, offered: productId ? productById(productId)?.title : 'choices', size: size ?? null, ...(productId ? {} : { reply: reply.slice(0, 300) }) });
}

/** A yes to the swap just offered: "yes", "OK", "please replace it", "do it", "swap it". */
const CONFIRMS_SWAP = /^\s*(yes|yeah|yep|yup|ok|okay|sure|go ahead|go for it|do it|do that|swap it|replace it|change it|sounds good|perfect|great|fine|that'?s fine|absolutely|of course)\b|^\s*please\s*[.!]?\s*$|\b(please )?(replace|swap|change) (it|that|them)\b|\bdo it\b|\bgo ahead\b/i;
/** ...and not a no, a question, or a different choice. */
const INSTRUCTS_SWAP = /\b(?:replace|swap|switch|change|use|take|put in|add|go with|go for|choose|pick|select)\b[^.?!]*\b(?:it|that|this|them|this one|that one|the \w+)\b|\bswap\b/i;
const DECLINES_SWAP = /\b(no|nope|not|don'?t|do not|never|rather|different|another|other|instead of that)\b/i;

/**
 * Their answer to the swap just offered, before anything else runs. Checked
 * first - ahead of the model and of any tool - so a confirmed swap is made,
 * never re-derived: not the sold-out check, not a search, not a standalone
 * add. Once made the offer is gone, so a second yes changes nothing.
 *
 *   a product was offered   it goes into the pack, in the piece's size
 *   choices were offered    that piece's choices, in its size
 *
 * Then the pack's status: ready, or the one thing still missing.
 */
export async function confirmPackSwap(ctx: ToolContext): Promise<ToolResult | null> {
  if (ctx.direct) return null;
  const said = ctx.utterance ?? '';
  const replacing = ctx.session.activeShoppingContext?.replacing;
  const handle = currentPack(ctx.session);
  const offer = replacing?.offer;
  if (!replacing || !offer || !handle) return null;
  // Only the very next message answers it.
  if (offer.turn + 1 !== customerTurn(ctx.session)) return null;
  if (!CONFIRMS_SWAP.test(said) || DECLINES_SWAP.test(said) || /\?\s*$/.test(said)) return null;
  // A candidate only suggested, no swap asked: "yes" answers the question that was asked; "replace it" is the swap.
  if (offer.suggested && !INSTRUCTS_SWAP.test(said)) return null;
  const deal = allDeals().find((entry) => entry.handle === handle);
  if (!deal) return null;
  const offered = offer.productId ? productById(offer.productId) : null;
  // A product or colour of their own is a new choice, not a yes to this one.
  const named = identityProducts(resolveCustomerProductIdentity(said));
  if (named.length && (!offered || !named.some((product) => designOf(product.title) === designOf(offered.title)))) return null;
  if (!offered) {
    log.info('pack.swap_confirmed', { sessionId: ctx.session.id, pack: deal.handle, step: deal.steps[replacing.step]?.title, chose: 'choices' });
    const choices = await packStepChoices(deal, replacing.step, ctx, undefined);
    /*
     * The choices, and one of them offered by name - so the yes that follows
     * is bound to exactly that swap (notePackSwapOffer reads this sentence).
     * "Which would you like?" left "Yes, please replace it" pointing at eight
     * jackets at once.
     */
    const first = choices.attachment?.kind === 'products' ? choices.attachment.products[0] : undefined;
    const outgoing = packPieces(ctx.session, deal.handle)[replacing.step];
    if (!first || !outgoing) return choices;
    const size = replacing.size ?? pieceSize(ctx.session, deal.handle, replacing.step);
    const lead = choices.speech.replace(/\s*Which would you like\?\s*$/, '');
    return {
      ...choices,
      // Its colour too: a design in two colours named alone binds to neither.
      speech: `${lead} Shall I swap the ${titleCaseWords(garmentName(outgoing.title))} for the ${titleCaseWords(garmentName(first.title))} in ${colourwayName(first.title).toLowerCase()}${size ? `, in ${size}` : ''}, or would you like one of the others?`,
    };
  }
  if (!eligibilityOf(ctx, replacing.size ? [{ size: replacing.size }] : []).eligible(offered)) {
    await setReplacement(ctx.session.id, { step: replacing.step, candidates: replacing.candidates.filter((id) => id !== offered.id), size: replacing.size });
    return {
      speech: `Sorry - the ${titleCaseWords(garmentName(offered.title))} has just sold out in ${replacing.size}. Shall I show you the others that can go in?`,
      facts: `${offered.title} is no longer in stock in ${replacing.size}. Nothing was changed.`,
    };
  }
  log.info('pack.swap_confirmed', { sessionId: ctx.session.id, pack: deal.handle, step: deal.steps[replacing.step]?.title, chose: offered.title, size: replacing.size ?? null });
  return swapPackPiece(ctx, deal, offered);
}

/**
 * One piece of the pack in hand swapped for the product given - the swap the
 * customer confirmed, made once, then the replacement ended and the pack's
 * next question (or that it is ready) said with it.
 */
export async function swapPackPiece(ctx: ToolContext, deal: DealRecipe, replacement: Product): Promise<ToolResult | null> {
  const currency = ctx.session.preferences.currency ?? storeCurrency();
  const swapped = await dealAnswer({ query: deal.title, swapWith: replacement.id }, ctx, undefined, currency);
  if (!swapped || swapped.attachment?.kind !== 'pack') return swapped;
  await setReplacement(ctx.session.id, undefined);
  // What the pack needs now - asked once, or said to be ready.
  const status = packStatus(await sessions.getOrCreate(ctx.session.id), deal.handle);
  const next = status.ready ? `The ${titleCaseWords(deal.title)} is ready - shall I add it to your basket?` : status.next;
  const speech = /\?\s*$/.test(swapped.speech) ? swapped.speech : `${swapped.speech} ${next}`.trim();
  return { ...swapped, speech, facts: `${swapped.facts ?? ''}\n${packStatusFacts(status)}`.trim() };
}

/** The piece of the pack in hand being replaced, if a replacement is live. */
function liveReplacement(ctx: ToolContext): { deal: DealRecipe; step: number; candidates: string[]; size?: string } | null {
  const focus = ctx.session.activeShoppingContext;
  const replacing = focus?.replacing;
  const handle = currentPack(ctx.session);
  if (!replacing || !handle || focus?.pack !== handle) return null;
  const deal = allDeals().find((entry) => entry.handle === handle);
  if (!deal || !deal.steps[replacing.step]) return null;
  return { deal, step: replacing.step, candidates: replacing.candidates, ...(replacing.size ? { size: replacing.size } : {}) };
}

/** Putting one thing in place of another. */
const IN_PLACE_OF = /\b(instead|replace|replacing|swap|in place of|rather than)\b/i;

/**
 * "Add this Hexa Performance to my bag instead of that red jacket", with the
 * pack in hand and no choices shown for it: a replacement all the same. A
 * design one step of the pack takes, named with words putting it in place of
 * another, opens the replacement of that step - the colour of the piece going
 * out is not read as the colour wanted ("that red jacket").
 */
function impliedReplacement(ctx: ToolContext): { deal: DealRecipe; step: number; candidates: string[]; size?: string } | null {
  const said = ctx.utterance ?? '';
  const handle = currentPack(ctx.session);
  const deal = handle ? allDeals().find((entry) => entry.handle === handle) : undefined;
  if (!deal || !IN_PLACE_OF.test(said) || SEPARATELY.test(said)) return null;
  const pieces = packPieces(ctx.session, deal.handle);
  const matches: Array<{ step: number; candidates: string[] }> = [];
  deal.steps.forEach((step, index) => {
    const outgoing = pieces[index];
    // The outgoing piece's colours taken out of their words, so "that red jacket" does not ask for a red one.
    const going = outgoing ? productColourWords(outgoing, false) : [];
    const words = going.reduce((text, colour) => text.replace(new RegExp(`\\b${colour}\\b`, 'gi'), ' '), said);
    const named = identityProducts(resolveCustomerProductIdentity(words)).filter((product) => step.productIds.has(product.id) && (!outgoing || designOf(product.title) !== designOf(outgoing.title)));
    if (!named.length) return;
    const designs = new Set(named.map((product) => designOf(product.title)));
    const candidates = [...step.productIds].map((id) => productById(id)).filter((product): product is Product => !!product && designs.has(designOf(product.title)));
    matches.push({ step: index, candidates: candidates.map((product) => product.id) });
  });
  if (matches.length !== 1) return null;
  const size = sizeInRequest(said);
  log.info('pack.replacement_implied', { sessionId: ctx.session.id, pack: deal.handle, step: deal.steps[matches[0]!.step]!.title, candidates: matches[0]!.candidates.length });
  return { deal, ...matches[0]!, ...(size ? { size } : {}) };
}

/** Words that choose, or put in place: "add this instead", "use the black one", "yes", "I like black". */
const REPLACEMENT_CHOICE = /\b(add|put|pop|use|swap|replace|instead|take|go for|go with|i'?ll have|yes|yeah|yep|that one|this one|like|love|want|prefer|choose|pick|select|in the bag|in the basket|into the (bag|basket)|in the pack|into the pack)\b/i;
/** Asking for a separate item on its own - not a change to the pack. */
const SEPARATELY = /\b(separately|on its own|as well|as an extra|extra one|in addition|outside the pack|not in the pack|full price)\b/i;

/**
 * Finishing the replacement of a pack piece, whichever tool the model called
 * - add_to_cart, recommend_pack, a product lookup. "Add this Hexa
 * Performance to my bag instead of that red jacket" became a standalone £40
 * jacket add, and then a loop of confirmations (preview store). Inside a live
 * replacement, what the customer chooses goes into the pack:
 *
 *   - the product: a card they point at, a design they name, narrowed by a
 *     colour they say - only products the pack's step takes, and never the
 *     colour of the piece going out ("instead of that red jacket");
 *   - in the size the replacement was asked for, in stock, or not at all;
 *   - one design in several colours: the colour is asked, once.
 *
 * Null when the words choose nothing here - the tool then does its own work.
 */
async function completeReplacement(ctx: ToolContext): Promise<ToolResult | null> {
  if (ctx.direct) return null;
  // A yes to the swap just offered comes before anything else.
  const confirmed = await confirmPackSwap(ctx);
  if (confirmed) return confirmed;
  const live = liveReplacement(ctx) ?? impliedReplacement(ctx);
  const said = ctx.utterance ?? '';
  if (!live || !said.trim() || /\?\s*$/.test(said) || SEPARATELY.test(said)) return null;
  const { deal, step: index } = live;
  const step = deal.steps[index]!;
  const inStep = (product: Product | null | undefined): product is Product => !!product && step.productIds.has(product.id);
  const outgoing = packPieces(ctx.session, deal.handle)[index];
  // The colour of the piece going out is not the colour they want: "instead of that red jacket".
  /*
   * Only when the sentence puts one thing in place of the other: "instead of
   * that red jacket" is not asking for red, but "use the Vapor in navy" is
   * navy, whatever colour the gilet going out happened to be (live replay).
   */
  const goingColours = new Set(outgoing && IN_PLACE_OF.test(said) ? productColourWords(outgoing, false) : []);
  const colours = parseColours(said).colours.filter((colour) => !goingColours.has(colour.word));
  const colourOnly = colours.length > 0 && said.trim().split(/\s+/).length <= 5;
  if (!REPLACEMENT_CHOICE.test(said) && !colourOnly) return null;
  /*
   * Asking to see is not choosing: "show me black jackets" put the one black
   * jacket in the pack for them. Only with words that choose - "use", "add",
   * "take", "instead" - does a look become a pick.
   */
  if (SEE_WORDS.test(said) && !/\b(add|put|use|take|swap|replace|instead|go (?:for|with)|i'?ll have)\b/i.test(said)) return null;

  const pointed = resolveProduct(ctx.session, said);
  const pointedAt = pointed && /^(number \d|last on screen|on screen, from what they described)/.test(pointed.how) && inStep(pointed.product) ? pointed.product : null;
  // A design they name, among what the step takes - its colourways, not the outgoing piece.
  const named = identityProducts(resolveCustomerProductIdentity(said)).filter(inStep).filter((product) => !outgoing || designOf(product.title) !== designOf(outgoing.title));
  const namedDesigns = new Set(named.map((product) => designOf(product.title)));
  let pool: Product[] = pointedAt ? [pointedAt] : named.length ? [...step.productIds].map((id) => productById(id)).filter(inStep).filter((product) => namedDesigns.has(designOf(product.title))) : live.candidates.map((id) => productById(id)).filter(inStep);
  pool = pool.filter((product) => product.variants.some((variant) => variant.available));
  if (colours.length) pool = pool.filter((product) => colourMatch(product, colours, false) > 0);
  pool = pool.filter(eligibilityOf(ctx, live.size ? [{ size: live.size }] : []).eligible);
  // "This one", with one candidate on screen.
  if (pool.length > 1 && /\b(this|that|it)\b/i.test(said)) {
    const shown = new Set((ctx.session.lastShown?.items ?? []).map((item) => item.id));
    const onScreen = pool.filter((product) => shown.has(product.id));
    if (onScreen.length === 1) pool = onScreen;
  }
  const currency = ctx.session.preferences.currency ?? storeCurrency();
  if (pool.length === 1) {
    const chosen = pool[0]!;
    log.info('pack.replacement_chosen', { sessionId: ctx.session.id, pack: deal.handle, step: step.title, chosen: chosen.title, size: live.size ?? null });
    const result = await dealAnswer({ query: deal.title, swapWith: chosen.id }, ctx, undefined, currency);
    await setReplacement(ctx.session.id, undefined);
    return result;
  }
  const designs = [...new Set(pool.map((product) => designOf(product.title)))];
  if (pool.length > 1 && designs.length === 1) {
    // One design, several colours: ask the colour, and keep only that design as the candidates.
    await setReplacement(ctx.session.id, { step: index, candidates: pool.map((product) => product.id), ...(live.size ? { size: live.size } : {}) });
    const offered = pool.map((product) => colourwayName(product.title).toLowerCase());
    return {
      speech: `Which colour of the ${titleCaseWords(designs[0]!)} would you like in the pack${live.size ? ` in ${live.size}` : ''} - ${offered.slice(0, -1).join(', ')} or ${offered[offered.length - 1]}?`,
      facts: `Replacing the ${step.title.toLowerCase()} in ${deal.title}${outgoing ? ` (the ${outgoing.title})` : ''}. The ${designs[0]} can go in, in ${offered.join(', ')}${live.size ? `, all in stock in ${live.size}` : ''}. Ask which colour - nothing has changed yet, and nothing goes in the basket on its own.`,
    };
  }
  if (!pool.length && (named.length || colours.length)) {
    return {
      speech: `That isn't one of the pack's ${step.title.toLowerCase()} choices${live.size ? ` in ${live.size}` : ''} - shall I show you the ones that are?`,
      facts: `Nothing named fits the ${step.title} step of ${deal.title}${live.size ? ` in stock in ${live.size}` : ''}. Nothing was changed or added.`,
    };
  }
  return null;
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
  const coloured = colour ? ofKind.filter((p) => matchesColourText(p, colour) > 0) : ofKind;
  /*
   * In the size they asked for: "another jacket available in small" showed
   * jackets whose S was sold out. The size said now, else the one already
   * held for replacing this piece.
   */
  const heldSize = ctx.session.activeShoppingContext?.replacing?.step === index ? ctx.session.activeShoppingContext.replacing.size : undefined;
  /*
   * Else the size the pack has for this piece: "OK" to "the Warrior is sold
   * out in S - shall I swap it?" showed the sold-out Warrior among jackets in
   * every size. The piece's own chosen size, from the pack's status.
   */
  // A size said now counts only if it applies to this step's garments: "top size S, waist 32" is S for the jackets, never 32.
  const saidSize = sizeInRequest(said);
  const size = (saidSize && inStock.some((p) => sizeApplies(p, saidSize)) ? saidSize : undefined) ?? heldSize ?? pieceSize(ctx.session, deal.handle, index);
  const matching = coloured.filter(eligibilityOf(ctx, size ? [{ size }] : []).eligible);
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
  });
  // Still that pack's piece being chosen: the pack stays in hand, and what "this one" or "the black one" is about is kept with it.
  await setActivePack(ctx.session.id, deal.handle);
  await setReplacement(ctx.session.id, { step: index, candidates: matching.map((p) => p.id), ...(size ? { size } : {}) });
  return {
    speech: `${refusal}Here are the ${piece} choices in the ${packName}${colour ? ` in ${colour}` : ''}${size ? ` in stock in ${size}` : ''} - any of these can go in the pack. Which would you like?`,
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
    // Checked with variants that can be bought - a sold-out one is no evidence of what checkout charges (catalog/commerce.ts).
    const buyable = pieces.map((piece) => firstBuyableVariant(piece!)?.id);
    if (buyable.some((variantId) => !variantId)) return 'one of its pieces is sold out';
    if ((await packPriceHolds(deal, buyable as string[])) === 'wrong') return 'the checkout does not apply its pack price yet';
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
      const standPieces = fillDeal(stand, { ...(fill.size ? { size: fill.size } : {}), ...(fill.colour ? { colour: fill.colour } : {}), weather, eligible: eligibilityOf(ctx).packPiece });
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
    const read = readPackChoices(ctx.utterance, lastReply, shownPieces, now.packChoices?.[deal.handle] ?? earlierPackChoices({ ...ctx, session: now }, deal) ?? {});
    await sessions.patch(ctx.session.id, { packChoices: { ...(now.packChoices ?? {}), [deal.handle]: read } });
  }
  const status = blocked ? null : packStatus(await sessions.getOrCreate(ctx.session.id), deal.handle, shownPieces);

  let cheaperNote = '';
  // What the pieces cost on their own - in the sizes they chose where they have, so the card, the reply and the basket agree.
  const chosenVariant = (piece: Product) => status?.pieces.find((plan) => plan.product.id === piece.id)?.variant?.id;
  // Priced at variants that can be bought: a sold-out one's price is not what they would pay.
  const pricedAt = pieces.map((piece) => (piece ? (chosenVariant(piece) ?? firstBuyableVariant(piece)?.id) : undefined));
  const own = pricedAt.every(Boolean) ? piecesTotal(pricedAt as string[]) : 0;
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
    packsShown: {
      ...((await sessions.getOrCreate(ctx.session.id)).packsShown ?? {}),
      [deal.handle]: {
        items: pieces.map((piece) => ({ id: piece?.id ?? '', title: piece?.title ?? '' })),
        ...(fill.colour ? { colour: fill.colour } : {}),
        total: recommendation.total.amount,
      },
    },
  });
  // The pack they are building now: a bare "34" is its waist (session/focus.ts).
  await setActivePack(ctx.session.id, deal.handle);
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
    const toSee = await showPieceChoices(ctx);
    if (toSee) return toSee;
    /*
     * A pack only when they asked for one: a pack or deal by name, a kit, a
     * few things, a total budget - or a change to the pack in hand. "Is it
     * waterproof?" about a polo once brought up the Cool & Wet pack, because
     * the model heard rain (certification). Their question is answered
     * instead.
     */
    const asked = ctx.utterance ?? '';
    const lastSaid = [...ctx.session.messages].reverse().find((message) => message.role === 'assistant')?.text ?? '';
    const wantsPack =
      ctx.direct ||
      !asked.trim() ||
      // "The mixed one", answering "which Ambassador Pack?".
      namesADeal(lastSaid) ||
      /\bpacks?\b/i.test(lastSaid) ||
      !!args.swap ||
      !!currentPack(ctx.session) ||
      // "Waterproof" alone names the Rainsuit deal to the deal picker - as a question about a polo it asks for no pack.
      namesADeal(asked.replace(/\bwater ?proof\b/gi, ' ')) ||
      asksForDeals(asked) ||
      PACK_REQUEST.test(asked) ||
      readIntent(asked).budget?.per === 'total';
    if (!wantsPack) {
      log.warn('pack.not_asked', { sessionId: ctx.session.id, said: asked.slice(0, 120) });
      return { speech: '', facts: 'The customer did not ask for a pack - nothing was built or shown. Answer what they did ask, about what they are looking at.' };
    }
    const currency = args.currency ?? ctx.session.preferences.currency ?? storeCurrency();
    const statedBudget = shopperView(ctx.session).budget;
    const budgetAmount = groundedBudget(args.budgetAmount, ctx) ?? (statedBudget?.per === 'total' ? statedBudget.amount : undefined);
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
      !!shopperView(ctx.session).colours ||
      /[^\x00-\x7F]/.test(ctx.utterance ?? '');
    const askedColour = colourGiven ? colourAsked(args.colour, args.query) : undefined;
    if (!colourGiven && (args.colour || parseColours(args.query).colours.length)) {
      log.warn('pack.colour_not_given', { sessionId: ctx.session.id, colour: args.colour ?? args.query });
    }
    const colour = askedColour;

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
        size: trustedSize(args.size, ctx),
        eligible: eligibilityOf(ctx).eligible,
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
          preferences: { currency },
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

    /*
     * A "pack" put together to a budget is not in V1: it has no pack price and
     * is not a Druids deal, and it is where "an Ambassador Pack for rainy
     * season" went when the deal was not recognised - "what is your budget?"
     * (V1 task 2). The real packs are offered instead.
     */
    const range = knownRange(ctx) ?? 'men';
    const real = allDeals().filter((deal) => deal.range === range);
    const names = [...new Set(real.map((deal) => titleCaseWords(deal.title.replace(/\s*-\s*.*$/, ''))))];
    log.info('pack.budget_route_disabled', { sessionId: ctx.session.id, query: args.query.slice(0, 80), budget: budgetAmount ?? null });
    void recommendPack;
    return {
      speech: names.length
        ? `I can show you our ${names.slice(0, -1).join(', ')}${names.length > 1 ? ' or ' : ''}${names[names.length - 1]} - which would you like?`
        : "I can't put a pack together to a budget, but I can help you find the pieces you need.",
      facts: `No budget packs: only Druids' own deals. The ${range === 'women' ? 'ladies' : range} deals: ${real.map((deal) => `${deal.title}${deal.prices.GBP ? ` (£${deal.prices.GBP})` : ''}`).join('; ') || 'none'}. Ask which; for the weather, call recommend_pack with its name.`,
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
    const heldBudget = shopperView(ctx.session).budget;
    const budgetAmount = groundedBudget(args.budgetAmount, ctx) ?? (heldBudget?.per === 'total' ? heldBudget.amount : undefined);
    const askedColour = colourAsked(args.colour, args.seed, args.swap ? outfitShown(ctx)?.query : undefined);
    const colour = askedColour;
    const input = {
      seed: args.seed,
      colour,
      size: trustedSize(args.size, ctx),
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

    const shopper = shopperView(ctx.session);
    const weather = readIntent(ctx.utterance ?? '').weather ?? shopper.weather;
    const turnedDown = shopper?.rejected ?? [];
    const aim = shopper?.budget?.per === 'total' && shopper.budget.kind === 'around' && budgetAmount === shopper.budget.amount;
    const recommendation = outgoing
      ? await recommendOutfit(
          { ...input, seed: outfitShown(ctx)?.query ?? args.seed },
          // The same slots as before, in the same order, narrowed as before.
          slotsFor(outfitShown(ctx)?.query ?? args.seed, onScreen.map((piece) => piece.slot), ctx.utterance),
          { keep, exclude: [...swappedOut, ...turnedDown], aim, eligible: eligibilityOf(ctx).eligible, ...(weather ? { weather } : {}), ...(knownRange(ctx) ? { known: knownRange(ctx) } : {}) },
        )
      : await recommendOutfit(input, slots, {
          keep,
          exclude: turnedDown,
          aim,
          eligible: eligibilityOf(ctx).eligible,
          ...(weather ? { weather } : {}),
          ...(knownRange(ctx) ? { known: knownRange(ctx) } : {}),
        });
    // Swapped out is turned down: it is never offered again this session.
    // A swap they asked for: for this shopping session, not for good.
    if (outgoing && outgoing.product.id !== chosen?.id) await noteShoppingConstraints(ctx.session.id, { rejected: [outgoing.product.id] }, 'customer-confirmation');
    if (chosen) await noteShoppingConstraints(ctx.session.id, { liked: [chosen.id] }, 'customer-confirmation');

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
      // The range of what they were shown is not theirs; find_my_size reads the outfit on screen itself.
      preferences: { currency },
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
    let basketActions: CartAction[] = [];
    let basketOutcome: ToolResult['outcome'];
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
        // Through the gateway like any other basket change - and its actions handed to the widget, which once said "swapping" and did nothing.
        const swapped = await executeCommerceAction(ctx, { type: 'add-product', productId: theirPick.id, options: fits[0].options, replaces: outgoing.product.id });
        basketSpeech = swapped.ok ? ` In your basket too: ${swapped.speech}` : ` Your basket is unchanged - ${swapped.speech}`;
        basketNote = swapped.facts ? `\n${swapped.facts}` : '';
        basketActions = swapped.actions ?? [];
        basketOutcome = { ok: swapped.ok, action: swapped.action, ...(swapped.reason ? { reason: swapped.reason } : {}) };
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
      ...(basketActions.length ? { actions: basketActions } : {}),
      ...(basketOutcome ? { outcome: basketOutcome } : {}),
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
    // Choosing a piece for a pack on screen is a change to the pack, not the basket.
    const picked = await pickFromPackChoices(ctx);
    if (picked) return picked;
    /*
     * "Make it two" is a change to a line already in the basket, not an add.
     * The model sent it here every time (certification: 5 of 5), the add was
     * rightly refused - nobody asked to add - and the customer's request was
     * lost. Their words ask for a quantity and not an add: it goes to the
     * gateway as the line change it is, which reads the line and the number
     * from their words (planUpdateLine), never from this call.
     */
    const said = ctx.utterance ?? '';
    /*
     * A piece of the pack is being replaced and nothing above settled which:
     * "instead", "replace" or "in the pack" is not a standalone add. One
     * short question, never a separate line at full price.
     */
    /*
     * A piece of the pack in hand, added: the pack, not that piece on its own.
     * "Yes, add this to the bag, size small" right after the Hexa went into
     * the pack put a £40 jacket in the basket beside a pack still unbought.
     */
    const inHand = ctx.direct ? undefined : currentPack(ctx.session);
    if (inHand && !SEPARATELY.test(said) && packPieces(ctx.session, inHand).some((piece) => piece.id === productById(args.productId)?.id)) {
      log.info('cart.piece_is_pack', { sessionId: ctx.session.id, pack: inHand, productId: args.productId });
      return addPackTool.run({}, ctx);
    }
    const replacing = liveReplacement(ctx);
    if (!ctx.direct && replacing && !SEPARATELY.test(said)) {
      const piece = replacing.deal.steps[replacing.step]!.title.toLowerCase();
      return {
        speech: `Is that to go in the pack in place of the ${piece}, or to buy on its own?`,
        facts: `A ${piece} replacement in ${replacing.deal.title} is open. Nothing was added. Ask this one question; for the pack, the choice goes in with recommend_pack swapWith.`,
        // Nothing changed - and the question is what they hear, whatever the model writes (it said "Added it").
        outcome: { ok: false, action: 'add-product', reason: 'ambiguous-target' },
        lead: { text: `Is that to go in the pack in place of the ${piece}, or to buy on its own?`, unless: /\b(in the pack|on its own|separately)\b/i },
      };
    }
    if (!ctx.direct && (ctx.session.basket ?? []).length && !asksToAdd(said) && lineChangeAuthorization(ctx) === 'customer-utterance' && !asksToRemove(said)) {
      log.info('cart.add_as_quantity_change', { sessionId: ctx.session.id, said: said.slice(0, 80) });
      return fromOutcome(await executeCommerceAction(ctx, { type: 'update-line', lineId: '', quantity: args.quantity ?? 1 }));
    }
    return fromOutcome(await executeCommerceAction(ctx, { type: 'add-product', ...args }));
  },
});

/** A gateway outcome as the model reads it: what happened, and - when nothing did - exactly that. */
function fromOutcome(outcome: ActionOutcome, extraFacts = ''): ToolResult {
  // What it charged, from the variant the gateway added - so the reply quotes the basket's own figure (catalog/commerce.ts).
  const charged = outcome.ok && outcome.charge !== undefined ? `Charged: ${formatMoney(outcome.charge, storeCurrency())}${outcome.quantity && outcome.quantity > 1 ? ` for ${outcome.quantity}` : ''}.` : '';
  const facts = [outcome.facts, charged, outcome.cart ? cartFacts(outcome.cart) : '', extraFacts].filter(Boolean).join('\n');
  return {
    speech: outcome.speech,
    ...(facts ? { facts } : {}),
    ...(outcome.actions?.length ? { actions: outcome.actions } : {}),
    ...(outcome.cart ? { attachment: { kind: 'cart' as const, cart: outcome.cart } } : {}),
    outcome: { ok: outcome.ok, action: outcome.action, ...(outcome.reason ? { reason: outcome.reason } : {}) },
  };
}

/* ---------------- planners: the validation behind each basket action ---------------- */

const optionAwaiting = (name: string): 'size' | 'colour' | 'option' => (/colou?r/i.test(name) ? 'colour' : /size|waist|leg|length/i.test(name) ? 'size' : 'option');

/** Choices under the product's own option names, and a size said this turn where a size is still open. */
function alignOptions(product: Product, options: Record<string, string> | undefined, saidSize: string | undefined): Record<string, string> | undefined {
  const aligned: Record<string, string> = {};
  const byKind = (name: string) =>
    /waist/i.test(name)
      ? product.options.find((option) => /waist/i.test(option.name))
      : /leg|length|inseam/i.test(name)
        ? product.options.find((option) => /leg|length|inseam/i.test(option.name))
        : /size/i.test(name)
          ? product.options.find((option) => option.name === sizeOptionOf(product))
          : /colou?r/i.test(name)
            ? product.options.find((option) => /colou?r/i.test(option.name))
            : undefined;
  for (const [name, value] of Object.entries(options ?? {})) {
    if (!value?.trim()) continue;
    const exact = product.options.find((option) => option.name.toLowerCase() === name.toLowerCase());
    const target = exact ?? byKind(name);
    // An option the product does not have is dropped - it names nothing to choose.
    if (target && !aligned[target.name] && (exact || target.values.some((own) => optionValueMatches(own, value)))) aligned[target.name] = value;
  }
  const sizeOption = sizeOptionOf(product);
  if (saidSize && sizeOption && !aligned[sizeOption] && sizeApplies(product, saidSize)) aligned[sizeOption] = saidSize;
  return Object.keys(aligned).length ? aligned : options ? {} : undefined;
}

/** The size said with this add, as an option of these products - when it is one they are sized in. */
function sizeSaidWith(ctx: ToolContext, products: Product[]): { options?: Record<string, string> } {
  const size = sizeInRequest(ctx.utterance ?? '');
  const first = products[0];
  if (!size || !first || !sizeApplies(first, size)) return {};
  const option = sizeOptionOf(first);
  return option ? { options: { [option]: size } } : {};
}

/**
 * A product added to the basket. Which product (the customer's, never the
 * model's alone), the variant their choices make, in stock, how many they
 * asked for - all decided before anything is handed to the cart.
 */
async function planAddProduct(ctx: ToolContext, action: CommerceAction, source: ActionSource): Promise<ActionPlan> {
  if (action.type !== 'add-product') throw new Error('planAddProduct: wrong action');
  let productId = action.productId;
  const ui = source === 'ui-add';
  const proposed = productById(productId) ?? (/^(gid:\/\/|\d+$)/.test(productId.trim()) ? null : resolveProduct(ctx.session, productId)?.product ?? null);

  /*
   * Which product. A click is its own product. Otherwise the customer's
   * target (actionTarget); a model pick outside it is corrected when their
   * target is one product and asked about when it is several. And with no
   * target from the customer at all, nothing is added: a model's pick alone
   * never decides what goes in the basket.
   */
  const target: ActionTarget = ui ? (proposed ? { kind: 'bound', products: [proposed], label: proposed.title, source: 'card-action' } : { kind: 'unbound' }) : actionTarget(ctx);
  const diagnostics = {
    sessionId: ctx.session.id,
    source,
    customer: ui ? 'ui' : describeIdentity(resolveCustomerProductIdentity(ctx.utterance ?? '')),
    focus: ctx.session.activeShoppingContext?.design ?? ctx.session.activeShoppingContext?.productId ?? null,
    pending: livePending(ctx.session)?.productIds ?? null,
    proposed: proposed?.title ?? productId,
    target: target.kind === 'bound' ? `${target.source}: ${target.label}` : target.kind,
  };
  if (target.kind === 'ambiguous') {
    log.warn('cart.add_target', { ...diagnostics, decision: 'ambiguous' });
    const names = target.designs.map((design) => titleCaseWords(design.design));
    return {
      ok: false,
      reason: 'ambiguous-target',
      speech: `Which do you mean - ${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}?`,
      facts: `What they named fits more than one product: ${target.designs.map((design) => `${design.design} (${design.range}) [${design.products.map((p) => p.id).join(', ')}]`).join('; ')}. Ask which one - never pick for them.`,
    };
  }
  if (target.kind === 'unbound') {
    log.warn('cart.add_target', { ...diagnostics, decision: 'no trusted target' });
    const screen = (ctx.session.lastShown?.items ?? []).filter((item) => item.id);
    return {
      ok: false,
      reason: 'no-target',
      speech: ui ? 'I could not find that product.' : 'Which one would you like me to add?',
      facts: ui
        ? `The product on that card [${productId}] is not in the catalogue.`
        : `Nothing they said, tapped, were offered or were waiting on says which product. ${screen.length ? `On screen: ${screen.map((item, i) => `${i + 1}. ${item.title}`).join('; ')}.` : ''} Ask which one - never pick for them.`,
    };
  }
  /*
   * A design in several colours is not one product. "Add it in M" after "the
   * Elite Polo in white or black" took white - the model's pick - every time
   * (certification). Within a family the customer's words pin the colour, or
   * only one of its colours is on screen; otherwise the colour is asked.
   */
  const inTarget = !!proposed && target.products.some((product) => product.id === proposed.id);
  const saidColours = parseColours(ctx.utterance ?? '').colours;
  const byColour = saidColours.length ? target.products.filter((product) => colourMatch(product, saidColours, false) > 0) : [];
  const familyGuess = inTarget && target.products.length > 1 && !(byColour.length === 1 && byColour[0]!.id === proposed!.id);
  if (!inTarget || familyGuess) {
    const shown = new Set((ctx.session.lastShown?.items ?? []).map((item) => item.id));
    const onScreen = target.products.filter((product) => shown.has(product.id));
    const pick = target.products.length === 1 ? target.products[0]! : byColour.length === 1 ? byColour[0]! : onScreen.length === 1 ? onScreen[0]! : null;
    log.warn('identity.rejected_model_target', { ...diagnostics, corrected: pick?.title ?? null });
    if (!pick) {
      const made = target.products.length ? target.products : proposed ? designMembers(proposed) : [];
      return {
        ok: false,
        reason: target.products.length ? 'missing-option' : 'unavailable',
        speech: `Which colour of the ${titleCaseWords(target.label)} would you like?`,
        facts: target.products.length
          ? `They mean the ${target.label} - one of: ${target.products.map((product) => `${product.title} [${product.id}]`).join(', ')}. ${proposed ? `${proposed.title} is not one of them. ` : ''}Ask which colour; never add another product.`
          : `The ${target.label} is not made in the colour they asked for.${made.length ? ` It comes in: ${made.map((product) => colourwayName(product.title)).join(', ')}.` : ''} Say so, and ask which colour.`,
        // The size they gave with the add stays with it: "add it in small" - "which colour?" - "red" was asked the size again (live replay).
        ...(target.products.length
          ? { pending: { type: 'add-product' as const, productIds: target.products.map((product) => product.id), awaiting: 'colour' as const, ...sizeSaidWith(ctx, target.products) } }
          : {}),
      };
    }
    productId = pick.id;
  }
  const chosenProduct = productById(productId) ?? proposed;
  log.info('cart.add_target', { ...diagnostics, resolved: chosenProduct?.title ?? productId, decision: 'bound' });
  /*
   * Added this very turn already - by the waiting action's resolver before
   * the model ran (tools/pending.ts) - and the model now calls add_to_cart
   * for it too. Once: it is in the basket, and that is what is said.
   */
  const justAdded = ctx.session.lastAdded;
  if (!ui && !ctx.pendingResolved && chosenProduct && justAdded?.byPending && justAdded.productId === chosenProduct.id && justAdded.turn === turnNow(ctx)) {
    log.info('cart.add_repeated_this_turn', { sessionId: ctx.session.id, productId: chosenProduct.id });
    return { ok: false, reason: 'wrong-action', speech: `The ${titleCaseWords(chosenProduct.title)} is in your basket.`, facts: `${chosenProduct.title} was added this turn already - it is in the basket. Do not add it again; say it is in.` };
  }

  /*
   * Which options. A click sends the pickers as they were when clicked.
   * Otherwise: a size they say now; what they tapped on this card; the size
   * the Caddie offered, when they said yes to it; the options a waiting add
   * already had. A size nobody said is a guess, and a guessed size in the
   * basket is the one rule that does not bend.
   */
  const offered = source === 'customer-confirmation' ? offeredAction(ctx) : null;
  const saysSize = !!sizeInRequest(ctx.utterance ?? '');
  const card = !ui && chosenProduct ? ctx.session.cardChoices?.[chosenProduct.id] : undefined;
  let options: Record<string, string> | undefined = action.options;
  if (!ui) {
    if (card && !saysSize) {
      options = {
        ...Object.fromEntries(Object.entries(options ?? {}).filter(([name]) => !Object.keys(card.options).some((own) => own.toLowerCase() === name.toLowerCase()))),
        ...card.options,
      };
      log.info('cart.card_choice_used', { sessionId: ctx.session.id, productId: chosenProduct!.id, options: card.options });
    }
    // The record's settled options: on the answer it waited for, and on the yes to the add it offered.
    const waiting = source === 'pending-action-continuation' || source === 'customer-confirmation' ? livePending(ctx.session)?.options : undefined;
    if (waiting) options = { ...waiting, ...(options ?? {}) };
    if (offered?.type === 'add-product' && offered.size && chosenProduct) {
      const sizeOption = sizeOptionOf(chosenProduct);
      if (sizeOption) options = { ...(options ?? {}), [sizeOption]: offered.size };
    }
    // A yes to "shall I add it in M?" is the customer choosing M.
    const acceptedSize = offered?.type === 'add-product' ? offered.size : undefined;
    const invented = sizesNeverGiven(sizeValues(options).filter((value) => !(acceptedSize && sameSize(value, acceptedSize))), ctx, chosenProduct?.id ?? productId);
    if (invented.length) {
      log.warn('cart.size_not_given', { sessionId: ctx.session.id, sizes: invented });
      return {
        ok: false,
        reason: 'missing-option',
        speech: 'What size would you like?',
        facts: `The customer never gave ${invented.join(', ')} - never choose a size for them. Ask, then add with the size they say.`,
        pending: { type: 'add-product', productIds: target.products.map((product) => product.id), awaiting: 'size' },
      };
    }
  }

  const product = await getProductDetails(productId);
  if (!product) return { ok: false, reason: 'not-found', speech: 'I could not find that product.', facts: `No product ${productId} in the catalogue.` };
  /*
   * The model's option names are not the catalogue's: "Size": "S" for a
   * jacket sold under "JACKET SIZE" named no variant, and the customer - who
   * had said "small" - was asked the size again (live replay, V1 task 3).
   * Each choice goes under the product's own option, and a size they said
   * this turn fills a size still open.
   */
  options = alignOptions(product, options, ui ? undefined : sizeInRequest(ctx.utterance ?? ''));

  /*
   * The one variant their choices name (catalog/commerce.ts) - the same
   * resolution the card, the pack and product details use. Every option with
   * a choice must be one they made; choices that name no variant, or several,
   * are asked about. Never the first variant.
   */
  const resolution = resolveVariant(product, options ?? {});
  if (resolution.status === 'incomplete') {
    const stillOpen = resolution.missing;
    return {
      ok: false,
      reason: 'missing-option',
      speech: `Which ${stillOpen.map((option) => option.name.toLowerCase()).join(' and ')} would you like for the ${product.title}?`,
      facts: `${product.title} needs a choice:\n${stillOpen.map((option) => `- ${option.name}: ${option.values.join(', ')}`).join('\n')}`,
      pending: { type: 'add-product', productIds: [product.id], ...(options ? { options } : {}), awaiting: optionAwaiting(stillOpen[0]!.name) },
    };
  }
  // Every option named and still no single variant: the choices did not identify one. Never the first of them.
  if (resolution.status !== 'exact') {
    return {
      ok: false,
      reason: 'missing-option',
      speech: `Which ${product.options.map((option) => option.name.toLowerCase()).join(' and ')} would you like for the ${product.title}?`,
      facts:
        resolution.status === 'ambiguous'
          ? `${resolution.variants.length} variants match for ${product.title}. Do not choose one for them.`
          : `${product.title} is not made in ${Object.values(options ?? {}).join(' / ')}. Do not choose another for them.`,
    };
  }
  const variant = resolution.variant;
  if (!variant.available) {
    const choice = Object.values(variant.options).filter((value) => value !== 'Default Title').join(', ');
    return {
      ok: false,
      reason: 'sold-out',
      speech: `The ${product.title}${choice ? ` in ${choice}` : ''} is out of stock. Shall I check another size?`,
      facts: `Sold out: ${product.title} ${choice}. Other options: ${product.options.map((option) => `${option.name}: ${option.values.join(', ')}`).join('; ')}`,
    };
  }

  /*
   * How many. A click says its own quantity; a yes is to what was offered;
   * otherwise more than one only when their words say how many - never a
   * number in the product's name, never the model's alone.
   */
  const quantity = ui
    ? Math.max(1, Math.min(10, action.quantity ?? 1))
    : offered?.type === 'add-product'
      ? (quantityInWords(ctx.utterance ?? '')?.set ?? offered.quantity)
      : quantityAsked(ctx, action.quantity);
  if (action.quantity !== undefined && quantity !== action.quantity) log.warn('cart.quantity_not_asked', { sessionId: ctx.session.id, proposed: action.quantity, used: quantity });

  const replacedIds = action.replaces
    ? (ctx.session.basket ?? [])
        .filter((line) => line.lineId === action.replaces || sameProduct(line.productId, action.replaces ?? ''))
        .map((line) => line.productId)
        .filter((id) => !sameProduct(id, product.id))
    : [];
  const next = await nextStep([product], { profile: shopperView(ctx.session, ctx.utterance), basketProductIds: (ctx.session.basket ?? []).map((line) => line.productId), eligible: eligibilityOf(ctx).eligible });
  const nextLine = next ? next.line : '';
  // Chosen is liked; what it replaces is turned down - once it is in, never before.
  const afterSuccess = async () => {
    // In their basket through the gateway: their choice, for this shopping session.
    await noteShoppingConstraints(ctx.session.id, { liked: [product.id], ...(replacedIds.length ? { rejected: replacedIds } : {}) }, 'customer-confirmation');
  };
  const choice = Object.values(variant.options).filter((value) => value !== 'Default Title').join(', ');
  const charge = Number((variant.price.amount * quantity).toFixed(2));

  // On the storefront the basket is the theme's cart: the widget makes the change.
  if (ctx.session.cartMode === 'theme') {
    const outgoingLines = action.replaces
      ? (ctx.session.basket ?? []).filter(
          (line) => line.lineId === action.replaces || (sameProduct(line.productId, action.replaces ?? '') && !sameProduct(line.productId, product.id)),
        )
      : [];
    return {
      ok: true,
      speech: outgoingLines.length
        ? `Swapping the ${outgoingLines.map((line) => line.title).join(' and ')} for the ${product.title}${choice ? ` in ${choice}` : ''}.`
        : `Adding ${quantity > 1 ? `${quantity} x ` : ''}the ${product.title}${choice ? ` in ${choice}` : ''} to your basket.`,
      facts: `The widget makes this change in the store cart and shows the basket once it has. Say it is going in, not that the basket now holds it.${nextLine ? `\n${nextLine}` : ''}`,
      actions: [
        {
          type: 'add',
          lines: [{ variantId: numericId(variant.id), quantity }],
          ...(outgoingLines.length ? { removeKeys: outgoingLines.map((line) => line.lineId) } : {}),
        },
      ],
      afterSuccess,
      productId: product.id,
      variantId: variant.id,
      quantity,
      charge,
    };
  }

  return {
    ok: true,
    speech: action.replaces ? `Swapped in the ${product.title}${choice ? ` in ${choice}` : ''}.` : `Added the ${product.title}${choice ? ` in ${choice}` : ''}.`,
    ...(nextLine ? { facts: nextLine } : {}),
    // A swap: the old piece removed only once the new one is safely in.
    storefront: async () => {
      let cart = await addToCart(ctx.session.cartId, variant.id, quantity);
      const outgoing = action.replaces
        ? cart.lines.filter((line) => line.variantId !== variant.id && (line.lineId === action.replaces || sameProduct(line.productId, action.replaces ?? '')))
        : [];
      for (const line of outgoing) cart = await setLineQuantity(cart.id, line.lineId, 0);
      return cart;
    },
    afterSuccess,
    productId: product.id,
    variantId: variant.id,
    quantity,
    charge,
  };
}

/**
 * A basket line changed or removed. The line the customer means - named,
 * "it" for what they just added, or the only one - never the model's pick
 * alone; the quantity their words give; a pack's pieces only ever as a whole.
 */
/** A size ("the M one", "in L", "the 34") or colours ("the navy one") that pick a basket line. */
function lineDescriptors(said: string): { size?: string; colours: ColourRequest[] } {
  const sized = /\b(?:the|in|size)\s+(xxs|xs|xxxl|xxl|[2-5]xl|xl|x-?large|small|medium|large|s|m|l|\d{2})\b(?!\s*(?:pack|of|pairs?|more))/i.exec(said);
  const size = sized ? (normaliseSize(sized[1]!.replace(/-/g, ' ')) ?? undefined) : undefined;
  return { ...(size ? { size } : {}), colours: parseColours(said).colours };
}

/** Whether a basket line is that size and colour - its own variant title, its own product's colourway. */
function lineMatches(line: { productId: string; variantTitle: string }, wanted: { size?: string; colours: ColourRequest[] }): boolean {
  if (wanted.size && !line.variantTitle.split(/\s*\/\s*/).some((part) => optionValueMatches(part, wanted.size!))) return false;
  if (wanted.colours.length) {
    const product = productById(line.productId);
    if (!product || colourMatch(product, wanted.colours, false) === 0) return false;
  }
  return true;
}

async function planUpdateLine(ctx: ToolContext, action: CommerceAction, source: ActionSource): Promise<ActionPlan> {
  if (action.type !== 'update-line') throw new Error('planUpdateLine: wrong action');
  const theme = ctx.session.cartMode === 'theme';
  const cart = !theme && ctx.session.cartId ? await getCart(ctx.session.cartId) : null;
  const lines = theme
    ? (ctx.session.basket ?? [])
    : (cart?.lines ?? []).map((line) => ({ lineId: line.lineId, productId: line.productId, title: line.title, variantTitle: line.variantTitle, quantity: line.quantity, bundle: undefined as string | undefined }));
  if (lines.length === 0) return { ok: false, reason: 'not-found', speech: 'Your basket is empty at the moment.', facts: 'There is nothing in the basket to change.' };

  const said = ctx.utterance ?? '';
  let line: (typeof lines)[number] | undefined;
  const waiting = livePending(ctx.session);
  if (source === 'ui-cart-change') {
    line = lines.find((entry) => entry.lineId === action.lineId);
  } else if (waiting?.type === 'update-line' && waiting.lineId && (source === 'customer-confirmation' || ctx.pendingResolved)) {
    // Their yes to the change the record holds (tools/pending.ts): that line, and no other reading of "it".
    line = lines.find((entry) => entry.lineId === waiting.lineId);
  } else {
    const identity = resolveCustomerProductIdentity(said);
    const offered = source === 'customer-confirmation' ? offeredAction(ctx) : null;
    const byIds = (ids: string[]) => lines.filter((entry) => ids.some((id) => sameProduct(entry.productId, id)));
    let candidates = byIds(identityProducts(identity).map((product) => product.id));
    if (!candidates.length && offered?.type === 'update-line' && offered.productIds) candidates = byIds(offered.productIds);
    if (!candidates.length && identity.status === 'none') {
      // "The polo": the lines of that kind.
      const kinds = categoriesAsked(said);
      if (kinds.length) candidates = lines.filter((entry) => { const own = productById(entry.productId); return !!own && isCategory(own, kinds); });
    }
    /*
     * A size or colour they name picks among the lines - "the M one", "the
     * navy one" - and is never set aside for a guess. "Remove the M one"
     * once took out the jacket just added, in L, beside the M polo they
     * meant (certification). No single line fits: ask.
     */
    const descriptors = lineDescriptors(said);
    if (descriptors.size || descriptors.colours.length) {
      candidates = (candidates.length ? candidates : lines).filter((entry) => lineMatches(entry, descriptors));
    } else if (!candidates.length && identity.status === 'none' && !categoriesAsked(said).length) {
      /*
       * "It", "that": whichever came last - the one they just added, or a
       * product they have talked about since (the focus moved after the add)
       * - or the only line there is.
       */
      const recent = ctx.session.lastAdded;
      const focus = ctx.session.activeShoppingContext;
      const heldSince = focus?.productId && (!recent || focus.turn > recent.turn) ? focus.productId : undefined;
      if (heldSince) candidates = byIds(designMembers(productById(heldSince) ?? ({ id: heldSince } as Product)).map((p) => p.id));
      if (!candidates.length && recent) candidates = byIds([recent.productId]);
      if (!candidates.length && focus?.productId) candidates = byIds(designMembers(productById(focus.productId) ?? ({ id: focus.productId } as Product)).map((p) => p.id));
      if (!candidates.length && lines.length === 1) candidates = lines;
    }
    // Two lines it could be (two sizes of one polo): ask - the model's pick between them is still a guess.
    line = candidates.length === 1 ? candidates[0] : undefined;
    if (!line) {
      const listed = (candidates.length ? candidates : lines).map((entry) => `${entry.title} (${entry.variantTitle}) [line ${entry.lineId}]`).join('; ');
      return {
        ok: false,
        reason: candidates.length > 1 ? 'ambiguous-target' : 'no-target',
        speech: 'Which item in your basket do you mean?',
        facts: `Which line they mean is not certain. In the basket: ${listed}. Ask which - never change one for them.`,
      };
    }
    if (line.lineId !== action.lineId) log.warn('identity.rejected_model_target', { sessionId: ctx.session.id, tool: 'update_cart_item', proposed: action.lineId, corrected: line.lineId });
  }
  if (!line) return { ok: false, reason: 'not-found', speech: 'I cannot find that in your basket.', facts: cartSummary(ctx.session.basket ?? []) };

  // How many: a click's own number; "remove" is none; otherwise the number their words give.
  let quantity: number;
  if (source === 'ui-cart-change') quantity = action.quantity;
  else if (asksToRemove(said)) {
    /*
     * "Remove one" of two is one fewer, not none: it once emptied a line of
     * two jackets, and the reply said one remained (certification). A count
     * they give comes off; no count takes the line out.
     */
    const count = quantityInWords(said)?.set;
    quantity = count !== undefined && count < line.quantity ? line.quantity - count : 0;
  }
  else if (waiting?.type === 'update-line' && waiting.lineId === line.lineId && waiting.quantity !== undefined && (source === 'customer-confirmation' || ctx.pendingResolved)) {
    quantity = waiting.quantity;
  } else {
    const offered = source === 'customer-confirmation' ? offeredAction(ctx) : null;
    const amount = quantityInWords(said);
    if (amount?.more) quantity = line.quantity + amount.more;
    else if (amount?.set !== undefined) quantity = amount.set;
    else if (offered?.type === 'update-line' && offered.quantity !== undefined) quantity = offered.quantity;
    else return { ok: false, reason: 'missing-option', speech: `How many of the ${line.title} would you like?`, facts: 'They did not say how many. Ask.', pending: { type: 'update-line', productIds: [line.productId], lineId: line.lineId, awaiting: 'quantity', missing: ['quantity'] } };
  }
  if (quantity !== action.quantity) log.warn('cart.quantity_not_asked', { sessionId: ctx.session.id, proposed: action.quantity, used: quantity });
  quantity = Math.max(0, Math.min(10, quantity));

  // A pack is priced as a whole: a piece comes out with its pack, and never changes quantity on its own.
  if (line.bundle) {
    const pack = lines.filter((entry) => entry.bundle === line!.bundle);
    if (quantity !== 0) return { ok: false, reason: 'unavailable', speech: 'Pieces in a pack come one of each - to change one, rebuild the pack instead.', facts: 'A pack piece cannot change quantity on its own.' };
    /*
     * One piece out takes the whole pack out (its price is the pack's): said
     * first, and done on their yes - never on "remove the belt" alone.
     */
    if (source === 'customer-utterance' && !ctx.pendingResolved) {
      return {
        ok: false,
        reason: 'missing-option',
        speech: `The ${titleCaseWords(line.title)} is part of a pack, so taking it out takes the whole pack out - all ${pack.length} pieces. Shall I?`,
        facts: `${line.title} is a pack piece; removing it removes the pack (${pack.length} lines). Nothing was changed. Ask, and remove the pack only on their yes.`,
        pending: { type: 'update-line', productIds: [line.productId], lineId: line.lineId, quantity: 0, awaiting: 'confirmation', missing: ['confirmation'] },
      };
    }
    return {
      ok: true,
      speech: `That piece is part of a pack, so I am taking the whole pack out - ${pack.length} pieces.`,
      actions: pack.map((entry) => ({ type: 'change' as const, lineKey: entry.lineId, quantity: 0 })),
      productId: line.productId,
      quantity: 0,
    };
  }
  // More of it only when more is in stock.
  if (quantity > line.quantity) {
    const own = productById(line.productId);
    const variant = own?.variants.find((entry) => entry.title === line!.variantTitle || Object.values(entry.options).join(' / ') === line!.variantTitle);
    if (variant && !variant.available) return { ok: false, reason: 'sold-out', speech: `The ${line.title} is sold out, so I can't add more.`, facts: `${line.title} ${line.variantTitle} is sold out.` };
  }
  const speech = quantity === 0 ? `Taking the ${line.title} out of your basket.` : `Changing the ${line.title} to ${quantity}.`;
  if (theme) return { ok: true, speech, actions: [{ type: 'change', lineKey: line.lineId, quantity }], productId: line.productId, quantity };
  return { ok: true, speech, storefront: () => setLineQuantity(ctx.session.cartId!, line!.lineId, quantity), productId: line.productId, quantity };
}

registerPlanner('add-product', planAddProduct);
registerPlanner('update-line', planUpdateLine);

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
    return fromOutcome(await executeCommerceAction(ctx, { type: 'update-line', lineId: args.lineId, quantity: args.quantity }));
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
    const proposed = args.productId ? await getProductDetails(args.productId) : null;
    /*
     * Whose colours: the product the customer means - named, pointed at, in
     * hand, or the page for "this" (session/shoppingSession.ts). The model's
     * product is a proposal: kept when it is that design (it may carry the
     * exact colourway), set aside when it is not, and never the answer on its
     * own. The widget's own call names its card and is taken as it is.
     */
    const said = ctx.utterance ?? '';
    const target: TrustedTarget = ctx.direct ? { status: 'none' } : trustedProductTarget(ctx.session, said);
    if (target.status === 'ambiguous') {
      const names = target.designs.map((design) => titleCaseWords(design));
      return { speech: `Which do you mean - ${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}?`, facts: `What they named fits more than one product: ${target.designs.join('; ')}. Ask which.` };
    }
    let named: Product | null = ctx.direct ? proposed : null;
    if (target.status === 'product') named = agreesWithTarget(target, proposed) ? proposed : target.products[0]!;
    if (!ctx.direct && proposed && named?.id !== proposed.id && !agreesWithTarget(target, proposed)) {
      log.warn('focus.model_pick_off_focus', { sessionId: ctx.session.id, tool: 'other_colours', proposed: proposed.title, target: named?.title ?? null });
    }
    // The page counts for "this" - through the target above - or, as before, when they ask with nothing else in view.
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
    const colourRule = eligibilityOf(ctx);
    const buyable = (product: Product) => colourRule.eligible(product);
    const all = garments.flatMap((product) => [product, ...otherColourways(product)]);
    const every = all.filter(buyable);
    if (every.length === 0) {
      const subject = garmentName(garments[0]!.title).toUpperCase();
      // Only the sizes that apply to it - never "M / 32" for a cap in one size.
      const inSize = Object.values(colourRule.decide(garments[0]!).sizes).join(' / ');
      return {
        speech: `The ${subject} isn't in stock${inSize ? ` in ${inSize}` : ''} in any colour right now. Shall I find something similar that is?`,
        facts: `No colourway of ${subject} can be bought${inSize ? ` in ${inSize}` : ''} - none were shown. Never offer or show a sold-out colour.`,
      };
    }
    if (every.length < all.length) log.info('colours.sold_out_hidden', { sessionId: ctx.session.id, hidden: all.filter((product) => !buyable(product)).map((product) => product.title) });

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
  return sizeOptionOf(product);
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
    const outcome = await executeCommerceAction(ctx, { type: 'add-pack', ...(args.pack ? { pack: args.pack } : {}) });
    // Refused for want of a request: where the pack stands, so the model cannot claim sizes as chosen.
    if (!outcome.ok && outcome.reason === 'not-authorized') {
      const handle = currentPack(ctx.session) ?? (ctx.session.lastShown?.kind === 'pack' ? ctx.session.lastShown.bundle : undefined);
      const standing = handle ? packStatusFacts(packStatus(ctx.session, handle)) : '';
      return fromOutcome(outcome, `And never say a size was selected that the status below does not confirm.${standing ? `\n${standing}` : ''}`);
    }
    return fromOutcome(outcome);
  },
});

/**
 * A pack added to the basket - from chat, or its card's Add button. The pack
 * the customer sees, every piece a real variant in stock, the price checkout
 * will charge, and one pack in the basket, not two. The only difference
 * between chat and the button is who authorised it.
 */
async function planAddPack(ctx: ToolContext, action: CommerceAction, source: ActionSource): Promise<ActionPlan> {
  if (action.type !== 'add-pack') throw new Error('planAddPack: wrong action');
  const ui = source === 'ui-add';
  let deal: DealRecipe | undefined;
  let products: Array<Product | null>;
  let session = ctx.session;

  if (ui) {
    deal = allDeals().find((entry) => entry.handle === action.handle);
    if (!deal) return { ok: false, reason: 'not-found', speech: "That pack isn't available right now.", facts: `No deal ${action.handle}.` };
    /*
     * The pack the customer sees - the pieces on its card, as the server last
     * showed them. A card older than the pack now on the session is not added
     * as if it were current.
     */
    const shownIds = ctx.session.packsShown?.[deal.handle]?.items.map((item) => item.id) ?? [];
    const clicked = (action.pieces ?? []).map((piece) => piece.productId);
    if (!shownIds.length || shownIds.length !== clicked.length || shownIds.some((id, i) => !sameProduct(id, clicked[i]!))) {
      return { ok: false, reason: 'not-ready', speech: 'This pack has changed since it was shown - take another look before adding it.', facts: `The pieces sent do not match the ${deal.title} last shown.` };
    }
    products = shownIds.map((id) => productById(id));
    // The pickers at the click are the customer's choices for this add - real options only.
    const taps: NonNullable<typeof session.cardChoices> = {};
    for (const piece of action.pieces ?? []) {
      const product = productById(piece.productId);
      if (!product) continue;
      const options: Record<string, string> = {};
      for (const [name, value] of Object.entries(piece.options)) {
        const option = product.options.find((own) => own.name.toLowerCase() === name.toLowerCase());
        const real = option?.values.find((own) => own.toLowerCase() === String(value).toLowerCase());
        if (option && real) options[option.name] = real;
      }
      taps[product.id] = { options, at: Date.now() };
    }
    session = { ...ctx.session, cardChoices: { ...(ctx.session.cardChoices ?? {}), ...taps } };
  } else {
    const shown = ctx.session.lastShown;
    const onScreen = shown?.kind === 'pack' && shown.bundle ? allDeals().find((entry) => entry.handle === shown.bundle) : undefined;
    /*
     * Which pack is being bought: the one the customer names now, the one the
     * offer they are saying yes to named, or the pack in hand. Never the
     * model's pack name on its own, and never a pack merely still on screen
     * after they left it - a yes to something else once bought the pack
     * still showing (Phase 3B).
     */
    const said = ctx.utterance ?? '';
    const weather = readIntent(said).weather ?? shopperView(ctx.session).weather;
    const byHandle = (handle: string | undefined) => (handle ? allDeals().find((entry) => entry.handle === handle) : undefined);
    const inHand = byHandle(currentPack(ctx.session));
    const choice = namesADeal(said) ? chooseDeal(said, dealRange(ctx), weather) : null;
    const offered = source === 'customer-confirmation' ? offeredAction(ctx) : null;
    const named = choice && 'deal' in choice ? choice.deal : choice && 'ask' in choice && inHand && choice.ask.includes(inHand) ? inHand : null;
    deal = named ?? (offered ? byHandle(offered.type === 'add-pack' ? offered.handle : undefined) : inHand);
    if (action.pack && deal && !chooseDealMatches(action.pack, deal)) log.warn('gateway.model_pack_ignored', { sessionId: ctx.session.id, proposed: action.pack, bound: deal.handle });
    if (!deal && choice && 'ask' in choice) {
      return {
        ok: false,
        reason: 'missing-option',
        speech: `Which conditions is the Ambassador Pack for - ${choice.ask.map((d) => titleCaseWords(d.conditionTitle ?? d.title)).join(', ')}?`,
        facts: 'Ask which, then call recommend_pack with the condition to build it before adding.',
      };
    }
    if (!deal) return { ok: false, reason: 'no-target', speech: 'Which pack would you like to add?', facts: 'No pack is in hand, named by the customer, or named in what they said yes to - nothing was added. A pack still on screen is not one they chose; ask which.' };
    /*
     * The pack as they last saw it, even after a search has taken the screen.
     * One they have never seen is shown, not added: adding a pack in the same
     * breath as building it put pieces in the basket nobody had looked at.
     */
    const seen = deal === onScreen && shown ? null : ctx.session.packsShown?.[deal.handle]?.items.map((item) => (item.id ? productById(item.id) : null));
    if (!(deal === onScreen && shown) && !(seen?.length && seen.every(Boolean))) {
      const built = fillDeal(deal, { size: trustedShopperFacts(ctx.session).usualSize, eligible: eligibilityOf(ctx).packPiece });
      const shownDeal = await showDeal(deal, built, ctx, storeCurrency(), action.pack ?? deal.title);
      return { ok: false, reason: 'not-ready', speech: `${shownDeal.speech} Take a look first.`.trim(), facts: `The ${deal.title} had not been shown - it is on screen now. Nothing was added; ask if they want it.\n${shownDeal.facts ?? ''}` };
    }
    products = seen ?? (shown?.items ?? []).map((item) => (item.id ? productById(item.id) : null));
    if (products.some((product) => !product)) {
      return { ok: false, reason: 'unavailable', speech: `One of the ${deal.title} steps has nothing in stock that fits, so it is best finished on the pack page.`, facts: deal.url };
    }
    /*
     * Only what the customer chose - their words this turn read into the
     * pack's choices, then every piece resolved from what is confirmed. The
     * model's size and options are never read. See packState.ts.
     */
    const fresh = await sessions.getOrCreate(ctx.session.id);
    const lastReply = [...fresh.messages].reverse().find((message) => message.role === 'assistant')?.text ?? '';
    const choices = readPackChoices(ctx.utterance ?? '', lastReply, products as Product[], fresh.packChoices?.[deal.handle] ?? {});
    session = await sessions.patch(ctx.session.id, { packChoices: { ...(fresh.packChoices ?? {}), [deal.handle]: choices } });
  }

  /*
   * Every piece once more, with the one rule, immediately before it goes in
   * (tools/eligibility.ts): a piece that can no longer be had in their size
   * stops the add, and that step waits for their choice - never a piece put
   * in for them, never the pack added holding one they cannot have.
   */
  const addRule = eligibilityFor(session, ctx.utterance ?? '');
  const unfit = (products as Product[]).findIndex((product) => !addRule.packPiece(product));
  if (unfit >= 0 && !ctx.direct) {
    const piece = (products as Product[])[unfit]!;
    const why = addRule.decide(piece, { named: true }).reason ?? 'not available';
    const size = Object.values(addRule.decide(piece).sizes)[0];
    await setReplacement(ctx.session.id, { step: unfit, candidates: [], ...(size ? { size } : {}) });
    return {
      ok: false,
      reason: 'not-ready',
      speech: `The ${titleCaseWords(garmentName(piece.title))} is ${why}, so the pack can't go in as it is. Shall I show you the ${deal.steps[unfit]!.title.toLowerCase().replace(/\s*\/\s*/g, ' or ')} choices you can have${size ? ` in ${size}` : ''}?`,
      facts: `${piece.title} is ${why} - the ${deal.steps[unfit]!.title} step needs their choice before the pack can be added. Show that step's choices (search for it) - never put one in for them.`,
    };
  }
  const status = packStatus(session, deal.handle, products as Product[]);
  if (!status.ready) {
    // The pack they asked for, waiting on one of its fields: their "34" finishes it, with their yes kept (tools/pending.ts).
    const need: PendingNeed = /\bleg\b/i.test(status.next) ? 'leg' : /\bwaist\b/i.test(status.next) ? 'waist' : /\btop size\b|\bsize\b/i.test(status.next) ? 'size' : 'option';
    return { ok: false, reason: 'not-ready', speech: status.next, facts: packStatusFacts(status), pending: { type: 'add-pack', productIds: [], pack: deal.handle, awaiting: need, missing: [need] } };
  }
  const pieces = status.pieces.map((plan) => ({ product: plan.product, variant: plan.variant! }));

  if (ctx.session.cartMode !== 'theme') {
    return { ok: false, reason: 'unavailable', speech: `The ${deal.title} price is applied in the store's own basket, so it is added from the pack page on the website.`, facts: `Pack page: ${deal.url}` };
  }

  const bundle = toBundleDeal(deal, pieces.map((piece) => piece.product));
  /*
   * What checkout will charge, known before anything is added: the pack
   * price, or the pieces' own total when that is lower. A condition pack
   * whose price checkout does not apply is not added at all.
   */
  let charge = deal.prices.GBP ?? 0;
  if (deal.format === 'plus') {
    const verdict = await packPriceHolds(deal, pieces.map((piece) => piece.variant.id));
    if (verdict === 'cheaper') charge = piecesTotal(pieces.map((piece) => piece.variant.id));
    if (verdict !== 'ok' && verdict !== 'cheaper') {
      const warm = allDeals().find((d) => d.range === deal!.range && d.condition === 'warm' && d.handle !== deal!.handle);
      return {
        ok: false,
        reason: 'price-check',
        speech:
          verdict === 'wrong'
            ? `I can't add the ${deal.title} at its £${deal.prices.GBP} pack price yet - the checkout isn't applying it.${warm ? ` I can add the ${warm.conditionTitle ? titleCaseWords(warm.conditionTitle) : warm.title} pack instead, or you can build it on the pack page.` : ' You can build it on the pack page.'}`
            : `I can't confirm the ${deal.title} price at checkout right now, so I would rather not add it. You can build it on the pack page.`,
        facts: `Checkout ${verdict === 'wrong' ? 'did not apply the pack price' : 'could not be checked'} for ${deal.title}. Pack page: ${deal.url}`,
      };
    }
  }

  /*
   * The same pack again is a change to it, not a second one (the rule the
   * Caddie has always followed): an earlier pack of this deal - in the basket
   * as the widget reports it, or sent moments ago - is replaced once the new
   * one is in. The same for chat and the button.
   */
  const earlier = new Set<string>([
    ...(ctx.session.basket ?? []).filter((line) => line.bundleName === deal!.handle && line.bundle).map((line) => line.bundle!),
    ...(ctx.session.packsAdded ?? []).filter((pack) => pack.handle === deal!.handle).map((pack) => pack.bundleId),
  ]);
  const bundleId = newBundleId(Date.now());
  const handle = deal.handle;
  return {
    ok: true,
    speech: earlier.size
      ? `Updating your ${deal.title} with those choices - still ${pieces.length} pieces for ${pounds(charge)}.`
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
    // Recorded once it is on its way - the replacement rule reads it on the next add.
    afterSuccess: async () => {
      const now = await sessions.getOrCreate(ctx.session.id);
      await sessions.patch(ctx.session.id, { packsAdded: [...(now.packsAdded ?? []).filter((pack) => pack.handle !== handle), { handle, bundleId }] });
    },
    charge,
  };
}

registerPlanner('add-pack', planAddPack);

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
    /*
     * A product they named is the one asked about - "Is the One Pair Tour
     * Ankle Socks one size?" is never answered about the Ladies pair the
     * model looked up. Several it could be: ask.
     */
    const named = resolveCustomerProductIdentity(said);
    if (named.status === 'ambiguous') {
      const names = named.designs.map((design) => titleCaseWords(design.design));
      return { speech: `Which do you mean - ${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}?`, facts: `What they named fits more than one product: ${named.designs.map((design) => design.design).join('; ')}. Ask which.` };
    }
    let member: Product | null = null;
    if (named.status === 'exact' && resolved?.product.id !== named.product.id) resolved = { product: named.product, how: 'named by the customer' };
    if (named.status === 'family') {
      const own = named.products;
      const shown = new Set((ctx.session.lastShown?.items ?? []).map((item) => item.id));
      member = own.find((product) => shown.has(product.id)) ?? own[0]!;
      // The design, answered as the design below - never a sibling the model looked up.
      if (resolved && !own.some((product) => product.id === resolved!.product.id)) resolved = null;
    }
    const focus = ctx.session.activeShoppingContext;
    const theirs = resolveProduct(ctx.session, said);
    const pointedAt = !!theirs && /^(number \d|last on screen|on screen, from what they described)/.test(theirs.how);
    if (focus && named.status === 'none' && !pointedAt && isFollowUp(said)) {
      const held = focusProduct(focus);
      const picked = resolved?.product;
      if (held && (!picked || designOf(picked.title) !== designOf(held.title))) {
        if (picked) log.warn('focus.model_pick_off_focus', { sessionId: ctx.session.id, tool: 'product_info', proposed: picked.title, focus: describeFocus(focus) });
        resolved = { product: held, how: 'the product they are shopping for' };
      } else if (!held && picked && !inFocus(picked, focus)) {
        log.warn('focus.model_pick_off_focus', { sessionId: ctx.session.id, tool: 'product_info', proposed: picked.title, focus: describeFocus(focus) });
        const onScreen = (ctx.session.lastShown?.items ?? []).map((item) => productById(item.id)).filter((found): found is Product => !!found && inFocus(found, focus));
        const talked = currentProduct(ctx.session);
        const instead = talked && inFocus(talked, focus) ? talked : onScreen.length === 1 ? onScreen[0] : null;
        resolved = instead ? { product: instead, how: 'the one they are shopping for' } : null;
      }
    }
    const product = resolved?.product ?? (args.which && !byId && named.status === 'none' && !(focus && isFollowUp(said)) ? await getProductDetails(args.which) : null);

    if (!product) {
      /*
       * A design, not one colourway: "is the Arvid Gilet waterproof?" with its
       * four colours on screen. Colour changes nothing its description says,
       * so asking "which colour?" answered nothing. When every colourway
       * answers the same, the design is answered; only when they differ, or
       * no design is named, is the customer asked which.
       */
      // The design they named; else the model's name for it; else one design on screen.
      const byName: Existence | null = named.status === 'family' ? existenceFrom(named) : lookupProductName(args.which ?? said);
      // Or "is this relaxed fit?" with one design on screen in several colours: that design.
      const onScreen = (ctx.session.lastShown?.items ?? []).map((item) => productById(item.id)).filter((found): found is Product => !!found);
      const oneDesign = onScreen.length > 0 && new Set(onScreen.map((found) => garmentName(found.title))).size === 1 ? onScreen : [];
      const family = byName?.kind === 'exact-family' ? byName.products : byName?.kind === 'exact-product' ? [byName.product] : oneDesign;
      const answers = family.map((member) => attributesAsked(member, question));
      if (family.length && answers[0]!.length && answers.every((answer) => JSON.stringify(answer) === JSON.stringify(answers[0]))) {
        const design =
          byName?.kind === 'exact-family' ? titleCaseWords(byName.familyName) : byName?.kind === 'exact-product' ? titleCaseWords(family[0]!.title) : titleCaseWords(garmentName(family[0]!.title));
        return {
          speech: sayAttributes(design, answers[0]!),
          facts: `About: the ${design} design - every colourway shares this description (${family.map((member) => `${member.title} [${member.id}]`).join(', ')}).\n${verifiedFacts(family[0]!)}\nAsked about: ${answers[0]!
            .map((answer) => `${answer.asked} - ${answer.state === 'yes' ? 'yes, its description states it' : answer.state === 'no' ? 'no - its description says it is not' : answer.state === 'other' ? `its description says ${answer.instead}${answer.unsaid ? ` - ${answer.asked} itself is not stated (never say no)` : ' instead'}` : 'not stated (never say no)'}`)
            .join('; ')}. Answer this first; colour does not change it, so do not ask which colour.`,
        };
      }
      if (member) {
        const answer = answerAbout(member, question);
        return {
          speech: answer.speech,
          facts: `About: ${member.title} [${member.id}] (the ${named.status === 'family' ? named.design : 'design'} they named).\n${answer.facts}\nAnswer only from these facts. Sizes, stock and prices are exact; do not add any.`,
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
    const range: Range = currentRange(ctx.session, ctx.utterance) ?? 'men';
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
      eligible: eligibilityOf(ctx).eligible,
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
 * The model's reading of what the customer needs - kept as nothing.
 *
 * Everything the profile and the shopping session hold is read from the
 * customer's words by code (shopper/remember.ts noteCustomerWords), or comes
 * from their own actions. This tool used to write whatever the model thought
 * they meant straight into the profile as hard rules: a colour, a budget, a
 * required feature, products turned down - none of which they had to have
 * said (Phase 3A). Now each value is checked against their words this turn:
 * one they said is already recorded; one they did not is a hint for this
 * reply only, logged and never kept - never a filter, never a fact.
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
    'Check what you understood the customer to need against what they actually said: the occasion, the weather a place or season means ("Portugal in July" is hot), products they liked or turned down, "just the jacket", a budget\'s kind. What they said in their own words is already recorded; anything else comes back as a guess, which is never kept and never treated as their requirement. Returns what is known about them. Call it alongside your other tools; say nothing about it to the customer.',
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
    const said = ctx.utterance ?? '';
    const words = readIntent(said);
    const asked = new Set<Feature>([...featuresAsked(said), ...(words.features?.required ?? []), ...(words.features?.preferred ?? [])]);
    const within = (values: string[] | undefined, pool: string[] | undefined) => !!values?.length && values.every((value) => (pool ?? []).includes(value.toLowerCase()));
    // Each proposal, and whether their own words this turn carry it.
    const proposals: Array<[string, unknown, boolean]> = [
      ['weather', args.weather, within(args.weather, words.weather)],
      ['fit', args.fit, !!args.fit && args.fit === words.fit],
      ['layering', args.layering, args.layering !== undefined && args.layering === !!words.layering],
      ['colours', args.colours, within(args.colours?.words, words.colours?.words)],
      ['avoidColours', args.avoidColours, within(args.avoidColours, words.avoidColours)],
      ['requiredFeatures', args.requiredFeatures, !!args.requiredFeatures?.length && args.requiredFeatures.every((feature) => asked.has(feature))],
      ['preferredFeatures', args.preferredFeatures, !!args.preferredFeatures?.length && args.preferredFeatures.every((feature) => asked.has(feature))],
      ['budget', args.budget, !!args.budget && words.budget?.amount === args.budget.amount],
      ['justThis', args.justThis ?? (args.clearJustThis ? '' : undefined), (args.justThis !== undefined || !!args.clearJustThis) && words.justThis !== undefined],
      // Which product "that one" was is the model's reading: a turned-down product needs their action (a swap, a basket change).
      ['occasion', args.occasion, false],
      ['liked', args.liked?.length ? args.liked : undefined, false],
      ['rejected', args.rejected?.length ? args.rejected : undefined, false],
    ];
    const hints: string[] = [];
    for (const [field, value, theirs] of proposals) {
      if (value === undefined || (Array.isArray(value) && !value.length)) continue;
      // Said by them: code has already recorded it this turn. Not said: a guess, and guesses are not kept.
      if (!theirs) {
        logFact(ctx.session.id, field, 'model-hint', 'turn', false, value, 'not in the customer’s words');
        hints.push(field);
      }
    }
    const known = describeShopper(await sessions.getOrCreate(ctx.session.id), ctx.session.preferences.currency ?? storeCurrency());
    return {
      speech: '',
      facts: [
        known ?? 'Nothing recorded about them yet.',
        hints.length
          ? `Not kept, because the customer did not say it: ${hints.join(', ')}. At most a guess for this reply - never a requirement, never a reason to leave something out, and never repeated to them as something they said.`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
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

/**
 * Carrying out a goal that is ready - nothing missing - once the customer
 * has authorised it, whatever the model did with the turn. "Yes, add this to
 * the bag, the size is small" with product, colour and size all settled came
 * back as "shall I add it?", turn after turn, because the model asked instead
 * of calling the tool. The goal says what to do (tools/journey.ts); the same
 * paths the tools use do it, and the Action Gateway still authorises and
 * validates every basket change. Null when the customer did not authorise
 * it, or their words name another product.
 */
export async function completeGoal(goal: CustomerGoal, ctx: ToolContext): Promise<ToolResult | null> {
  if (ctx.direct || goal.status !== 'ready' || !goal.action) return null;
  const said = ctx.utterance ?? '';
  if (!said.trim() || /\?\s*$/.test(said) || namesOtherProduct(goal, said)) return null;
  const action = goal.action;
  if (action.type === 'swap-pack-piece') {
    // Choosing inside the pack changes no basket: their choosing words, or a yes, are the authority.
    if (SEPARATELY.test(said) || !(REPLACEMENT_CHOICE.test(said) || cartAuthorization(ctx).authorized)) return null;
    const deal = allDeals().find((entry) => entry.handle === action.pack);
    if (!deal) return null;
    const result = await dealAnswer({ query: deal.title, swapWith: action.productId }, ctx, undefined, ctx.session.preferences.currency ?? storeCurrency()).then((answer) => (answer ? guardCards(answer, ctx, 'goal:swap-pack-piece') : answer));
    if (result?.attachment?.kind === 'pack') await setReplacement(ctx.session.id, undefined);
    return result;
  }
  // A basket line changed: their words asking for it, as update_cart_item requires.
  if (action.type === 'update-line') return lineChangeAuthorization(ctx) ? runTool('update_cart_item', { lineId: action.lineId, quantity: action.quantity }, ctx) : null;
  if (!cartAuthorization(ctx).authorized) return null;
  if (action.type === 'add-pack') return runTool('add_pack_to_cart', {}, ctx);
  return runTool('add_to_cart', { productId: action.productId, options: action.options }, ctx);
}

/**
 * Sizes they gave in their last few messages, read as this pack's choices -
 * only while it has none of its own. "What size do you wear?" came before the
 * pack was shown; "my top size would be medium, waist 32, leg 34" had no pack
 * to go to, only the waist was kept, and when the pack came up it asked for
 * the top size and the leg again (live replay). Their own words, checked
 * against the pieces the pack can hold, as any size for it is.
 */
function earlierPackChoices(ctx: ToolContext, deal: DealRecipe): PackChoices | undefined {
  if (Object.keys(ctx.session.packChoices?.[deal.handle] ?? {}).length) return undefined;
  const products = deal.steps.flatMap((step) => [...step.productIds].map((id) => productById(id)).filter((product): product is Product => !!product));
  const messages = ctx.session.messages;
  const theirs = messages.map((message, index) => (message.role === 'user' ? index : -1)).filter((index) => index >= 0).slice(-4);
  let choices: PackChoices = {};
  for (const index of theirs) {
    const before = [...messages.slice(0, index)].reverse().find((message) => message.role === 'assistant')?.text ?? '';
    choices = readPackChoices(messages[index]!.text, before, products, choices);
  }
  const { requested: _requested, ...confirmed } = choices;
  return Object.keys(confirmed).length ? confirmed : undefined;
}

/** A pack's piece rule, judged in the sizes it has - its own, or those given just before it was shown. */
function packRuleFor(ctx: ToolContext, deal: DealRecipe): (product: Product) => boolean {
  const earlier = earlierPackChoices(ctx, deal);
  const first = earlier
    ? [
        ...(earlier.top ? [{ size: earlier.top, as: 'top' as const }] : []),
        ...(earlier.waist ? [{ size: earlier.waist, as: 'waist' as const }] : []),
        ...(earlier.leg ? [{ size: earlier.leg, as: 'leg' as const }] : []),
      ]
    : [];
  return eligibilityOf(ctx, first).packPiece;
}

/** Asking for the whole pack to change, not one piece of it. */
const WHOLE_PACK = /\b(start (?:(?:this|the) )?(?:pack )?(?:again|over)|from scratch|rebuild (?:it|the pack)|(?:the )?(?:whole|entire) pack|every (?:piece|product|item)|all (?:the )?(?:pieces|products|items)|all new pieces)\b/i;

/**
 * A step of the pack that must be chosen again: its piece can no longer be
 * had in their size. Said plainly, with only what can be had in its place,
 * and the choice left to them - never a piece put in for them after they have
 * seen the pack (V1 task 2). With nothing to be had, said so.
 */
export async function replacementRequired(ctx: ToolContext, deal: DealRecipe, index: number): Promise<ToolResult> {
  const pieces = packPieces(ctx.session, deal.handle);
  const outgoing = pieces[index];
  const rule = eligibilityOf(ctx);
  const decision = outgoing ? rule.decide(outgoing, { named: true }) : undefined;
  const size = Object.values(decision?.sizes ?? {})[0] ?? pieceSize(ctx.session, deal.handle, index);
  const why = decision?.reason ?? 'no longer available';
  const step = deal.steps[index]!;
  await setReplacement(ctx.session.id, { step: index, candidates: [], ...(size ? { size } : {}) });
  log.info('pack.replacement_required', { sessionId: ctx.session.id, pack: deal.handle, step: step.title, piece: outgoing?.title ?? null, why });
  const fresh: ToolContext = { ...ctx, session: await sessions.getOrCreate(ctx.session.id) };
  const choices = await packStepChoices(deal, index, fresh, undefined);
  const name = outgoing ? titleCaseWords(garmentName(outgoing.title)) : step.title.toLowerCase();
  const none = choices.attachment?.kind !== 'products' || !choices.attachment.products.length;
  return {
    ...choices,
    speech: none
      ? `The ${name} is ${why}, and nothing else in that part of the ${titleCaseWords(deal.title)} can be had${size ? ` in ${size}` : ''} right now. Would you like a different size, or another pack?`
      : `The ${name} is ${why}, so it can't stay in the ${titleCaseWords(deal.title)}. Here are the ${step.title.toLowerCase().replace(/\s*\/\s*/g, ' or ')} choices you can have${size ? ` in ${size}` : ''} - which would you like?`,
    facts: `${outgoing?.title ?? step.title} is ${why} - informational only: never offer it. The ${step.title} step of ${deal.title} needs their choice; nothing was put in its place. ${choices.facts ?? ''}`.trim(),
  };
}

/** A pack's piece that can no longer be had, found on this turn - its step waits for their choice. */
export interface PackRevalidation {
  handle: string;
  title: string;
  step: number;
  piece: string;
  why: string;
}

/**
 * Every piece of the pack in hand, checked again with the one eligibility
 * rule (tools/eligibility.ts) - run on each turn, before anything is said.
 * The Cool & Wet pack was shown with the Warrior Jacket before their size was
 * known; "my top size is medium" made it M, the Warrior is sold out in M, and
 * the Caddie went on asking about sizes for a pack it could not sell them
 * (preview store). A piece no longer to be had in their size is replaced in
 * the pack - the rest kept - before the next reply. Where nothing in its step
 * can be had, it stays, and the pack's own "sold out - shall I swap it?"
 * takes over; a sold-out piece is never chosen in its place.
 */
export async function revalidatePack(sessionId: string, said = ''): Promise<PackRevalidation | null> {
  const session = await sessions.getOrCreate(sessionId);
  const handle = currentPack(session);
  const deal = handle ? allDeals().find((entry) => entry.handle === handle) : undefined;
  const record = handle ? session.packsShown?.[handle] : undefined;
  if (!deal || !record?.items.length) return null;
  /*
   * Not while they are choosing the replacement themselves - "the Warrior is
   * sold out in small, show me other jackets" - or have one offered: that
   * choice is already theirs to make.
   */
  if (session.activeShoppingContext?.replacing || aboutPackPiece(session, said)) return null;
  const pieces = record.items.map((item) => (item.id ? productById(item.id) : null));
  if (pieces.length !== deal.steps.length || pieces.some((piece) => !piece)) return null;
  const rule = eligibilityFor(session, said);
  const index = pieces.findIndex((piece) => !rule.packPiece(piece!));
  if (index < 0) return null;
  const piece = pieces[index]!;
  log.info('pack.revalidated', { sessionId, pack: deal.handle, step: deal.steps[index]!.title, piece: piece.title, why: rule.decide(piece).reason ?? null });
  return { handle: deal.handle, title: deal.title, step: index, piece: piece.title, why: rule.decide(piece).reason ?? 'not available' };
}

/**
 * The model's empty placeholders taken out: "colour": "", "size": "",
 * "budgetAmount": 0. "Show me an Ambassador Pack for rainy season" reached
 * recommend_pack with all three; the zero budget failed the schema, nothing
 * ran, and the model asked the customer for a budget instead of showing the
 * pack (live replay, V1 task 2). A zero price or budget is never a real one;
 * a zero quantity is, and is kept.
 */
function withoutPlaceholders(args: unknown): unknown {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  return Object.fromEntries(
    Object.entries(args as Record<string, unknown>).filter(
      ([name, value]) => value !== '' && value !== null && !(typeof value === 'number' && value <= 0 && /amount|price|budget/i.test(name)),
    ),
  );
}

/** Tools a choice during a pack-piece replacement may arrive through. */
const REPLACEMENT_TOOLS = new Set(['add_to_cart', 'recommend_pack', 'update_cart_item', 'get_product_details', 'other_colours', 'search_products', 'add_pack_to_cart']);

export async function runTool(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
  const tool = getTool(name);
  if (!tool) return { speech: `Unknown tool ${name}.` };

  const parsed = tool.schema.safeParse(withoutPlaceholders(rawArgs ?? {}));
  if (!parsed.success) {
    return {
      speech: `I could not use ${name} with those details: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')} ${issue.message}`)
        .join('; ')}`,
    };
  }

  /*
   * Basket changes are authorised and validated by the Action Gateway
   * (actionGateway.ts), inside the tools that request them - every way in,
   * the model, an outfit swap, the widget's buttons, goes through it.
   */
  const data = parsed.data;
  // A pack piece being replaced: what the customer chose goes into the pack, whichever tool was reached for.
  if (REPLACEMENT_TOOLS.has(name)) {
    const replaced = await completeReplacement(ctx);
    if (replaced) return guardCards(replaced, ctx, `${name}:replacement`);
    /*
     * "Can I see the other jackets that can go in the pack?" - that piece's
     * choices, whichever tool the model reached for: it once answered with
     * other_colours of the gilet already in the pack (live replay, V1 task 2).
     */
    const toSee = await showPieceChoices(ctx);
    if (toSee) return guardCards(toSee, ctx, `${name}:piece-choices`);
  }
  // The last check before any card reaches the customer (tools/eligibility.ts): the same rule as every path above.
  const result = await guardCards(await tool.run(data, ctx), ctx, name);
  /*
   * A piece being replaced, and the model looks one candidate up: that is
   * its selection, made by id - the swap an offer this turn is bound to
   * before a word of it is written (V1 task 3). Never a piece the step does
   * not take, never one they cannot have in the size.
   */
  if (name === 'get_product_details' && !ctx.direct) {
    const live = liveReplacement(ctx);
    const looked = productById(String((rawArgs as { productId?: unknown })?.productId ?? ''));
    if (live && looked && live.deal.steps[live.step]!.productIds.has(looked.id) && eligibilityOf(ctx, live.size ? [{ size: live.size }] : []).eligible(looked)) {
      const latest = await sessions.getOrCreate(ctx.session.id);
      const fresh = latest.activeShoppingContext?.replacing;
      const turn = customerTurn(latest, false);
      const before = fresh?.proposed?.turn === turn ? fresh.proposed.ids : [];
      if (fresh) await setReplacement(ctx.session.id, { ...fresh, proposed: { ids: [...new Set([...before, looked.id])], turn } });
      log.info('pack.replacement_proposed', { sessionId: ctx.session.id, product: looked.title });
    }
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
