import type { CaddieAttachment, Product } from '@caddie/shared';
import { FEATURE_LABEL, SHAPES, SHAPE_FEATURES, STRONGER, attributesOf, featuresAsked, featuresStatedIn, fitStatedIn, hasFeature, normalise, sayShape, shapeText, shapesSaid } from '../catalog/attributes.js';
// Shapes and stronger words are read from the product by catalog/attributes.ts; re-exported for older importers.
export { shapesOf, shapesSaid, strongerOf, strongerSaid } from '../catalog/attributes.js';
import { colourMatch, isColourWord, parseColours } from '../catalog/colour.js';
import { garmentName } from '../catalog/colourways.js';
import { isBuyable, sizeScale, supportsSize } from '../catalog/commerce.js';
import { NEED_LABEL, suitsNeed, type Need } from '../catalog/suitability.js';
import { parseRange, rangeOf } from '../catalog/audience.js';
import { categoriesAsked, isCategory } from '../catalog/constraints.js';
import { normaliseSize } from '../recommend/sizeWords.js';
import { distinctiveWords } from '../catalog/lookup.js';
import { allProducts, catalogueVersion } from '../catalog/sync.js';

/**
 * What the Caddie says, checked against what it was told - before the
 * customer hears it.
 *
 * The prompt says never to state a price or a product a tool did not give,
 * and the model mostly does not. "Mostly" is where the trust goes: "six
 * polos" for a pack with one polo, "£159.99 fixed pack price" for pieces that
 * cost £130, a price remembered from three turns ago. None of those needs
 * judgement to catch - a price is in the tool results or it is not - so this
 * is code, with no model call, on every reply.
 */

export interface Violation {
  /** `wording`: ranking talk or overclaiming, reworded. `offer`: offering to show what is already on screen, dropped. */
  kind: 'price' | 'product' | 'count' | 'colour' | 'attribute' | 'wording' | 'offer' | 'comparison' | 'length' | 'status' | 'pricing' | 'stock' | 'size' | 'basket';
  claim: string;
}

const PRICE = /£\s?(\d{1,5}(?:[.,]\d{1,2})?)/g;
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
/** A count of garments a card could hold: "six polos", "4 jackets". */
const COUNT = /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:[a-z-]+\s+){0,2}?(polos|jackets|gilets|midlayers|hoodies|trousers|shorts|joggers|caps|belts|socks)\b/gi;

function amounts(text: string): number[] {
  return [...text.matchAll(PRICE)].map((match) => Number(match[1]!.replace(',', '.')));
}

/** The store's garment names worth checking - "vento polo", not "golf polo". Rebuilt when the catalogue changes. */
let names: string[] = [];
let namesVersion = -1;
function garmentNames(): string[] {
  if (namesVersion === catalogueVersion()) return names;
  const set = new Set<string>();
  for (const product of allProducts()) {
    const name = garmentName(product.title);
    if (name.split(' ').length >= 2 && distinctiveWords(name).length) set.add(name);
  }
  names = [...set].sort((a, b) => b.length - a.length);
  namesVersion = catalogueVersion();
  return names;
}

function cardProducts(attachment?: CaddieAttachment): Product[] {
  if (!attachment) return [];
  if (attachment.kind === 'products') return attachment.products;
  if (attachment.kind === 'pack') return attachment.recommendation.items;
  if (attachment.kind === 'outfit') return attachment.recommendation.pieces.map((piece) => piece.product);
  return [];
}

/**
 * What the checker may know of the session, beyond this turn's card: the
 * products on screen, and those whose size is already settled - tapped on
 * their card, resolved in the pack in hand, just added. Only used to judge
 * size questions.
 */
export interface VerifyContext {
  screen?: Product[];
  sizeSettled?: Set<string>;
  /** The store cart as the widget last reported it (session.basket), when the basket is the theme's. */
  basket?: Array<{ productId: string; title: string; variantTitle: string; quantity: number }>;
  /** A change handed to the widget and not yet settled: its target, which "being updated" sentences may name. */
  unsettled?: Array<{ productId?: string; title: string; choice: string; quantity: number; outgoingChoice?: string }>;
}

export function verifyReply(reply: string, evidence: string, attachment?: CaddieAttachment, customerSaid?: string, context: VerifyContext = {}): Violation[] {
  const violations: Violation[] = [];
  const known = amounts(evidence);
  const close = (a: number, b: number) => Math.abs(a - b) < 0.011;

  // Every price: in the evidence, or the difference of two that are (a saving).
  for (const amount of amounts(reply)) {
    if (known.some((value) => close(value, amount))) continue;
    const saving = known.some((a) => known.some((b) => a > b && close(a - b, amount)));
    if (!saving) violations.push({ kind: 'price', claim: `£${amount}` });
  }

  // Every product name: one the tools or the screen mentioned.
  const said = reply.toLowerCase();
  const told = evidence.toLowerCase();
  for (const name of garmentNames()) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b${escaped}\\b`);
    // The customer's "premium play trouser" is the Premium Play Trousers.
    const loosely = new RegExp(`\\b${escaped.replace(/s$/, '')}s?\\b`);
    if (pattern.test(said) && !loosely.test(told)) violations.push({ kind: 'product', claim: name });
  }

  // "Six polos" when the card holds one.
  const products = cardProducts(attachment);
  if (products.length) {
    for (const match of reply.matchAll(COUNT)) {
      // "Leg 34 for the trousers" is a size, not thirty-four pairs of trousers.
      const between = match[0].slice(match[1]!.length, -match[2]!.length);
      if (/\b(for|the|in|of|with|on)\b/i.test(between) || /\b(leg|waist|size|length|inseam)\s*$/i.test(reply.slice(0, match.index))) continue;
      const n = NUMBER_WORDS[match[1]!.toLowerCase()] ?? Number(match[1]);
      // The reply's garment word read as search reads it, and the card's pieces by their catalogue kind (catalog/commerce.ts).
      const kinds = categoriesAsked(match[2]!);
      const onCard = kinds.length ? products.filter((product) => isCategory(product, kinds)).length : products.length;
      if (onCard && n > onCard) violations.push({ kind: 'count', claim: match[0] });
    }
    violations.push(...wrongColours(reply, products, told));
  }
  // What each product is said to be - features, fit - held to its own data, never to what was asked.
  violations.push(...unsupportedAttributes(reply, productsInEvidence(products, evidence), products[0]));
  violations.push(...stockClaims(reply, productsInEvidence(products, evidence), products));
  violations.push(...absenceClaims(reply));
  const inPlay = [...new Map([...productsInEvidence(products, evidence), ...(context.screen ?? [])].map((product) => [product.id, product])).values()];
  violations.push(...sizeRequests(reply, inPlay, context.sizeSettled));
  violations.push(...sizeClaims(reply, inPlay));
  violations.push(...salesWording(reply, products));
  violations.push(...priceComparisons(reply, evidence));
  violations.push(...packReadiness(reply, evidence));
  violations.push(...packPricing(reply, evidence));
  if (customerSaid !== undefined) violations.push(...replyShape(reply, customerSaid, products));
  if (context.basket) violations.push(...unsupportedBasketClaims(reply, context));
  return violations;
}

/* ---------------- what is in the basket ---------------- */

const BASKET_WORDS = /\b(basket|cart|bag)\b/i;
const IN_PROGRESS = /\b(updat(?:e|ed|ing)|being (?:added|changed|put|removed)|going in|adding|changing|will be|about to|on its way)\b/i;
const SIZE_TOKEN = /\b(?:size |in )(xs|s|m|l|xl|xxl|2xl|3xl|4xl|small|medium|large|x-?large|\d{2})\b/gi;
const QUANTITY_WORD = /\b(two|three|four|five|six|2|3|4|5|6)\b(?=\s*(?:x|of|white|black|navy|red|blue|grey|green|pink|[A-Z]|\w+ polos?|\w+ jackets?))|\bx\s?(\d)\b/g;
const NUMBER: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6 };

/**
 * Sizes and quantities said of what is in the basket, held to the basket as
 * the widget last reported it - and, for a change still being confirmed, to
 * that change's target. "Your basket is still showing the polo in M" with an
 * L line, or "two polos in M" for a change to two in L, is a claim the basket
 * does not support (single-product journey acceptance).
 */
export function unsupportedBasketClaims(reply: string, context: VerifyContext): Violation[] {
  const basket = context.basket ?? [];
  const unsettled = context.unsettled ?? [];
  const found: Violation[] = [];
  for (const sentence of reply.split(/(?<=[.!?])\s+/)) {
    if (!BASKET_WORDS.test(sentence) || NEGATED.test(normalise(sentence)) || /\?\s*$/.test(sentence.trim())) continue;
    const text = normalise(sentence);
    const inProgress = IN_PROGRESS.test(sentence);
    // The products this sentence is about: those in the basket or being changed whose design it names; none named means any of them.
    const candidates = [...basket, ...unsettled.map((op) => ({ productId: op.productId ?? '', title: op.title, variantTitle: inProgress ? op.choice : '', quantity: op.quantity }))];
    const named = candidates.filter((line) => text.includes(normalise(garmentName(line.title)).replace(RANGE_WORDS, ' ').replace(/\s+/g, ' ').trim()));
    const subjects = named.length ? named : candidates;
    if (!subjects.length) continue;
    const supported = inProgress
      ? unsettled.filter((op) => !named.length || named.some((line) => garmentName(line.title) === garmentName(op.title))).map((op) => ({ size: op.choice.toLowerCase(), quantity: op.quantity }))
      : basket.filter((line) => !named.length || named.some((candidate) => candidate.title === line.title)).map((line) => ({ size: line.variantTitle.toLowerCase(), quantity: line.quantity }));
    if (!supported.length && inProgress) continue;
    for (const match of sentence.matchAll(SIZE_TOKEN)) {
      const size = normaliseSize(match[1] ?? '') ?? (match[1] ?? '');
      if (!supported.some((line) => line.size.toUpperCase() === size.toUpperCase() || line.size.toUpperCase().split(' / ').includes(size.toUpperCase()))) found.push({ kind: 'basket', claim: match[0] });
    }
    for (const match of sentence.matchAll(QUANTITY_WORD)) {
      const quantity = NUMBER[(match[1] ?? match[2] ?? '').toLowerCase()];
      if (quantity !== undefined && !supported.some((line) => line.quantity === quantity)) found.push({ kind: 'basket', claim: match[0] });
    }
  }
  return [...new Map(found.map((violation) => [violation.claim, violation])).values()];
}

/* ---------------- Short, for chat and for voice ---------------- */

/*
 * A demo reply read out the six pieces of a pack, their colours and prices,
 * and asked for the top size and the leg in one breath - all of it already on
 * the card. Spoken, that is thirty seconds of listening. The default is two
 * short sentences and one question; more only when the customer asks for it.
 */
const DETAIL_ASKED = /\b(tell me more|more about|more detail|what'?s (included|in it|in the)|what is (included|in)|what does it (include|come with)|compare|explain|details?|describe|everything about|list)\b/i;
/*
 * Three and fifty-five, not two and forty-five: a three-sentence, 26-word
 * answer to "show me the cheapest jackets" was sent back for length, and
 * the rewrite that followed was cut mid-sentence ("lightweight-.") - a
 * second model call and a worse reply, for a sentence nobody would mind
 * hearing (harness replay of the 28 Sep rain-jacket conversation).
 */
const MAX_SENTENCES = 3;
const MAX_WORDS = 55;

export function replyShape(reply: string, said: string, cards: Product[] = []): Violation[] {
  if (DETAIL_ASKED.test(said)) return [];
  const found: Violation[] = [];
  const sentences = reply.split(/(?<=[.!?])\s+/).filter((sentence) => /[a-z]/i.test(sentence));
  const words = reply.split(/\s+/).filter(Boolean).length;
  if (sentences.length > MAX_SENTENCES || words > MAX_WORDS) found.push({ kind: 'length', claim: `${sentences.length} sentences, ${words} words` });
  if ((reply.match(/\?/g) ?? []).length > 1) found.push({ kind: 'length', claim: 'more than one question' });
  // "In black, navy, red, white, blue, grey, sage, pink, coral, lavender, green and jade": the colourways are on the cards.
  if (new Set(parseColours(reply).colours.map((colour) => colour.word)).size >= 5) found.push({ kind: 'length', claim: 'lists the colours' });
  // Three or more of the cards named: reading the screen aloud.
  const text = normalise(reply);
  const named = new Set(cards.map((product) => designKey(product)).filter((key) => key.trim().length > 2 && text.includes(key)));
  if (named.size >= 3) found.push({ kind: 'length', claim: 'lists the cards' });
  return found;
}

/* ---------------- What a pack costs ---------------- */

/*
 * The Caddie said the Cool & Wet pack was £159.99, then the card showed £156:
 * these pieces cost less on their own, and checkout charges that. The listed
 * price is only ever said as listed, and a saving only when there is one.
 */
const SAVING_WORDS = /\b(?:you(?:'d| would)? save|saves? you|saving|savings|saved|discount(?:ed)?|(?:good|great|special|better) deal|deal price|bargain)\b/i;

export function packPricing(reply: string, evidence: string): Violation[] {
  const lines = [...evidence.matchAll(/Pack price: pays £([\d.]+); listed £([\d.]+); saving (£[\d.]+|none)\./g)];
  const last = lines[lines.length - 1];
  if (!last) return [];
  const pays = Number(last[1]);
  const listed = Number(last[2]);
  const found: Violation[] = [];
  if (Math.abs(listed - pays) > 0.005) {
    for (const match of reply.matchAll(/£\s?(\d+(?:\.\d{1,2})?)/g)) {
      if (Math.abs(Number(match[1]) - listed) > 0.005) continue;
      // Said as listed, next to what they pay, is the one allowed explanation.
      if (!/\blisted\b/i.test(reply) || !reply.includes(`£${pays}`)) found.push({ kind: 'pricing', claim: match[0] });
    }
  }
  const saving = last[3] === 'none' ? SAVING_WORDS.exec(reply) : null;
  if (saving) found.push({ kind: 'pricing', claim: saving[0] });
  return found;
}

/* ---------------- "The pack is ready" ---------------- */

/** Ready, complete, all set - said only when the pack's state says so (tools/packState.ts). */
const READY_CLAIM = /\b(pack|it|everything)\s*(?:'s|is)\s+(?:now\s+)?(ready|complete|all set|good to go)\b|\byour pack is (ready|complete|set)\b/i;

export function packReadiness(reply: string, evidence: string): Violation[] {
  if (!/Pack status: NOT READY/.test(evidence) || /Pack status: READY/.test(evidence.split('Pack status: NOT READY').pop() ?? '')) return [];
  const claim = READY_CLAIM.exec(reply);
  return claim ? [{ kind: 'status', claim: claim[0] }] : [];
}

/* ---------------- Cheapest and cheaper ---------------- */

/*
 * "The Thunder Rain Jacket at £80 is the cheapest waterproof jacket we have"
 * - with a £16 one in the catalogue - and "the Blake Gilet at £36 is a more
 * affordable option" beside a £36 gilet. Which is cheapest, and what is
 * cheaper, is computed by the search and stated in the facts ("Price
 * ordering", "Price comparison"). Without that line, the claim is the
 * model's guess.
 */
const SUPERLATIVE = /\b(cheapest|lowest[- ]?priced?|lowest[- ]cost|least expensive|most affordable|best price)\b/i;
const COMPARATIVE = /\b(cheaper|less expensive|more affordable|lower[- ]?priced|less pricey|better value)\b/i;
/** About what they asked for, not a claim: "you wanted something cheaper". */
const ABOUT_THEM = /\b(you|you'?re|you'?ve)\s+(asked|want|wanted|are looking|were looking|looking|after|said|need)\b/i;
/** "Nothing cheaper fits", "I couldn't find anything cheaper": the honest answer, not a claim. */
const NONE_OF_IT = /\b(no|nothing|not|none|couldn'?t|can'?t|cannot|isn'?t|aren'?t|unable)\b/i;

export function priceComparisons(reply: string, evidence: string): Violation[] {
  const ordered = evidence.includes('Price ordering:');
  const compared = ordered || evidence.includes('Price comparison:');
  const found: Violation[] = [];
  for (const sentence of reply.split(/(?<=[.!?])\s+/)) {
    if (ABOUT_THEM.test(sentence) || NONE_OF_IT.test(sentence)) continue;
    const superlative = SUPERLATIVE.exec(sentence);
    if (superlative && !ordered) found.push({ kind: 'comparison', claim: superlative[0] });
    const comparative = COMPARATIVE.exec(sentence);
    if (comparative && !compared) found.push({ kind: 'comparison', claim: comparative[0] });
  }
  return found;
}

/* ---------------- How it is said ---------------- */

/*
 * The ranking's own labels, read out to customers: "an exact match for your
 * request", "a strong match". And suitability no fact states: "perfect for
 * warm weather" about a polo whose description says lightweight and
 * breathable - which is what should have been said.
 */
const JARGON = /\b(?:exact|strong|partial|perfect|best|semantic|top)\s+match(?:es)?\b|\bmatch(?:ing)?\s+levels?\b|\b(?:evidence|ranking)\s+(?:bands?|scores?|labels?)\b|\bmatch(?:es)?\s+(?:the|our)\s+ranking\b/gi;
const OVERCLAIM = /\b(?:perfect|ideal)(?:ly suited)?\s+for\b|\bperfect\s+(?:choice|option|pick|fit)\b/gi;
/*
 * "Lightweight and breathable, making it suitable for warm weather": the
 * features are facts, the weather verdict is ours. Say the features and that
 * they line up with what was asked; a description never says "for summer".
 */
const WEATHER_VERDICT =
  /,?\s*(?:making it |which makes it |so it'?s |so it is |it'?s |it is |and )?(?:suitable|great|made|ideal|perfect|designed|built|good)\s+for\s+(?:the\s+)?(?:warm|hot|cold|wet|rainy|windy|chilly|sunny|summer|winter)\b[^.,;!?]*/gi;
/*
 * "Would you like to see this HEXIE POLO?" with its card already on screen.
 * An offer of more, other or different things is a real offer and stays.
 */
const SHOW_OFFER = /\b(?:would you like|do you want|want|shall i|should i|can i|may i)(?:\s+me)?(?:\s+to)?\s+(?:see|show you|show|view|look at|take a look at|have a look at)\b([^.?!,;]{0,60})/gi;
const BEYOND = /^(?:more|other|others|another|different|similar|some other|anything|what else|alternatives?|options?)\b/;
const PRONOUN_ONLY = /^(?:it|this|that|these|those|them|this one|that one)(?: (?:too|first|now|here|again|as well))?$/;
const KIND_WORDS = new Set(['the', 'and', 'with', 'polo', 'polos', 'jacket', 'jackets', 'midlayer', 'midlayers', 'gilet', 'gilets', 'hoodie', 'hoodies', 'trousers', 'shorts', 'dress', 'dresses', 'cap', 'caps', 'mens', 'ladies', 'kids', 'version', 'one', 'ones', 'colour', 'colours']);

export function salesWording(reply: string, cards: Product[]): Violation[] {
  const found: Violation[] = [];
  for (const match of reply.matchAll(JARGON)) found.push({ kind: 'wording', claim: match[0] });
  for (const match of reply.matchAll(OVERCLAIM)) found.push({ kind: 'wording', claim: match[0] });
  // "Perfect for warm weather" is already caught above.
  for (const sentence of reply.split(/(?<=[.!?])\s+/)) {
    const plain = normalise(sentence.replace(DEAL_NAMES, ' '));
    // "I can't confirm any of these are designed for cold weather" is the truth, not a verdict.
    if (NEGATED.test(plain)) continue;
    for (const match of sentence.matchAll(WEATHER_VERDICT)) {
      if (/\b(?:perfect|ideal)\b/i.test(match[0])) continue;
      // A verdict a card's own description backs - "good for cold weather" of a thermal cap - is a fact said plainly (V1 task 4).
      const needs = needsClaimed(normalise(match[0]));
      if (needs.length && needs.every((need) => cards.some((product) => suitsNeed(product, need).verdict === 'yes'))) continue;
      found.push({ kind: 'wording', claim: match[0].replace(/^,?\s*/, '') });
    }
  }
  if (cards.length) {
    const onCards = new Set(cards.flatMap((product) => normalise(product.title).trim().split(' ')).filter((word) => word.length > 2 && !KIND_WORDS.has(word)));
    for (const match of reply.matchAll(SHOW_OFFER)) {
      const object = normalise(match[1] ?? '').trim();
      if (!object || BEYOND.test(object)) continue;
      const named = object.split(' ').filter((word) => !/^(it|this|that|these|those|them|in|a|an)$/.test(word));
      if (PRONOUN_ONLY.test(object) || named.some((word) => onCards.has(word))) found.push({ kind: 'offer', claim: match[0].trim() });
    }
  }
  return found;
}

/** The last-resort fix for `wording`: the ranking label becomes plain words, the overclaim goes. */
function plainWording(reply: string): string {
  return reply
    .replace(/\b(?:an?|the)\s+(?:exact|strong|partial|perfect|best|semantic|top)\s+match(?:es)?\b/gi, 'a good fit')
    .replace(/\b(?:exact|strong|partial|perfect|best|semantic|top)\s+match(?:es)?\b/gi, 'good fit')
    .replace(/,?\s*(?:which is |which makes it |and is |that is |it'?s |is )?(?:perfect|ideal)(?:ly suited)?\s+for\s+[^.,;!?]*/gi, '')
    .replace(WEATHER_VERDICT, '')
    .replace(/\bperfect\s+(choice|option|pick|fit)\b/gi, 'good $1')
    .replace(/\s+([.,!?])/g, '$1');
}

const NEGATED = /\b(not|no|none|neither|nothing|isn'?t|doesn'?t|don'?t|won'?t|wouldn'?t|shouldn'?t|without|nor|never|not stated|rather than|can'?t|cannot|couldn'?t|whether|unable|unlikely)\b/;
/*
 * A product associated with weather is a claim that it suits it - however it
 * is put. "Good for cooler weather", "a solid choice when the temperature
 * drops", "a sensible winter option", "should keep you dry", "built for
 * rainy days": the verbs vary without end, the weather does not. So a
 * positive clause about a product that names a kind of weather is held to
 * what that product's description states for it (catalog/suitability.ts).
 * A negated clause ("I can't confirm this is suitable for winter"), a
 * question, or a clause about what the customer wants claims nothing - the
 * caller has already set those aside. Read on normalised text.
 */
const NEED_CONCEPTS: Array<[Need, RegExp]> = [
  [
    'cold',
    /\b(?:cold|colder|coldest|chilly|chill|winter|wintry|frost|frosty|freezing|icy|cooler (?:days?|mornings?|evenings?|weather|rounds?|conditions|months|temperatures?)|cool (?:days?|mornings?|evenings?|weather|rounds?|conditions|months)|temperatures? (?:drops?|dropping|falls?|falling|dips?)|when it (?:gets|turns) (?:cold|colder|chilly)|keeps? (?:you|me|them) (?:nice and |extra |really )?warm|stay(?:s|ing)? warm|warm enough|warmth|early (?:mornings?|starts?))\b/,
  ],
  ['wet', /\b(?:rain|rainy|raining|rains|wet|showers?|showery|drizzle|drizzly|downpours?|damp|soggy|keeps? (?:you|me|them) dry|stay(?:s|ing)? dry|dry in the)\b/],
  [
    'hot',
    /\b(?:hot(?! pink)|hotter|heat|heatwave|summer|summery|sunny|sunshine|humid|scorching|tropical|warm (?:weather|days?|rounds?|conditions|months|climate|afternoons?)|warmer (?:weather|days?|rounds?|conditions|months|climate)|temperatures? (?:rises?|rising|climbs?|climbing)|when it (?:gets|turns) (?:hot|warm|warmer)|keeps? (?:you|me|them) cool|stay(?:s|ing)? cool|cooling)\b/,
  ],
  ['windy', /\b(?:wind|winds|windy|breezy|breeze|gusty|gusts|blustery|blocks? (?:the |out the )?wind|keeps? (?:the )?wind (?:out|off))\b/],
];
/** The Ambassador Pack conditions are names, not claims: "the Warm Rounds pack" says nothing about warmth. */
const DEAL_NAMES = /\b(?:warm rounds|mixed conditions|cool (?:& |and |&amp; )?wet)\b/gi;
/** The weather a clause associates the product with, if any. */
export function needsClaimed(text: string): Need[] {
  return NEED_CONCEPTS.filter(([, pattern]) => pattern.test(text)).map(([need]) => need);
}
/** A clause about what the customer wants, not about the product: "you prefer a relaxed fit". */
const THEIR_WANT = /\b(you|you'?ve|you'?d)\s+(prefer|like|want|wanted|asked|said|mentioned|need)\b/;
const RANGE_WORDS = /\b(mens|men s|ladies|womens|kids)\b/g;
/** Talk of other products, not the one in hand. */
const OTHERS = /\b(other|others|another|alternatives?|instead|something else|some (?:other|more)|(?:other|more) options?)\b/;


/** The products on the card, and any whose full title the tools named this turn. */
function productsInEvidence(card: Product[], evidence: string): Product[] {
  const upper = evidence.toUpperCase();
  const named = allProducts().filter((product) => upper.includes(product.title.toUpperCase()));
  return [...new Map([...card, ...named].map((product) => [product.id, product])).values()];
}

/** How a reply names a product: its design, without "mens" or "ladies", which the model drops. */
function designKey(product: Product): string {
  return normalise(garmentName(product.title)).replace(RANGE_WORDS, ' ').replace(/\s+/g, ' ');
}

/**
 * Features and fit claimed of a product its data does not state. Each clause
 * is about the product it names, or, naming none, the one the reply was last
 * talking about - so "the Vento is waterproof and the Aqua is lightweight"
 * checks each against its own product, never a shared bag of words. A clause
 * that negates ("it doesn't state that it's insulated") or talks about the
 * customer ("you prefer a relaxed fit") claims nothing.
 */
export function unsupportedAttributes(reply: string, products: Product[], lead?: Product): Violation[] {
  if (products.length === 0) return [];
  const keys = products.map((product) => ({ product, key: designKey(product) })).filter((entry) => entry.key.trim().length > 2);
  const clauses = reply
    .split(/(?<=[.!?])\s+/)
    .flatMap((sentence) => sentence.split(/[;:]|,\s+(?:while|whereas|but|and)\s+|\s+(?:while|whereas)\s+|\s+and\s+(?=(?:the\s+)?[A-Z])/));
  const found: Violation[] = [];
  let subject: Product[] = lead ? [lead] : [];
  for (const clause of clauses) {
    // "It has no sleeves" is a claim of sleeveless, not a negation. A pack's condition name is a name.
    const plain = clause.replace(DEAL_NAMES, ' ');
    const text = sayShape(normalise(plain));
    const named = keys.filter((entry) => text.includes(entry.key)).map((entry) => entry.product);
    // A product's own name is not a claim about it: "the Tex Rain Jacket is £60" says nothing of rain. The names in hand come out before the words are read.
    const unnamed = keys.reduce((rest, entry) => rest.replace(new RegExp(entry.key.trim().replace(/\s+/g, '\\s+'), 'gi'), ' '), plain);
    if (named.length) subject = named;
    if (subject.length === 0) continue;
    /*
     * Naming no product, a clause about the customer ("you prefer a relaxed
     * fit"), an offer, or other products ("would you like waterproof gilets
     * instead?") says nothing about this one. A clause that names the product
     * is always checked: "would you like the insulated Arvid Gilet?" is a claim.
     */
    if (named.length === 0 && (THEIR_WANT.test(text) || /\?\s*$/.test(clause.trim()) || OTHERS.test(text))) continue;
    /*
     * A weather named beside the product is a claim it suits it, however it
     * is put: only of one whose description states what that weather calls
     * for. Judged by the segment, not the clause: "without warmth features,
     * suitable for sun on a summer day" hides a conclusion about heat behind
     * a negation about warmth (live replay, V1 task 4). A segment that
     * negates claims nothing.
     */
    // Split before normalising: normalising takes the commas out.
    const segments = unnamed
      .split(/\s*(?:,|;|\bso\b|\bbut\b|\bthough\b|\balthough\b|\bwhile\b|\bwhereas\b)\s*/i)
      .map((segment) => normalise(segment))
      .filter((segment) => segment.trim() && !NEGATED.test(segment) && !THEIR_WANT.test(segment));
    for (const need of new Set(segments.flatMap((segment) => needsClaimed(` ${segment} `)))) {
      if (!subject.some((product) => suitsNeed(product, need).verdict === 'yes')) found.push({ kind: 'attribute', claim: `suited to ${NEED_LABEL[need]}` });
    }
    if (NEGATED.test(text)) continue;
    const own = (product: Product) => `${product.title} ${product.productType ?? ''} ${product.description ?? ''}`.toLowerCase();

    for (const [word, pattern] of STRONGER) {
      if (pattern.test(text) && !subject.some((product) => pattern.test(own(product)))) found.push({ kind: 'attribute', claim: word });
    }
    /*
     * A shape is held to every product the clause is about, not any one of
     * them: "the Arvid Gilet and the Pure Midlayer are both sleeveless" is
     * true of the gilet only.
     */
    for (const shape of SHAPES) {
      if (shape.said.test(text) && !subject.every((product) => shape.shown(shapeText(product)))) found.push({ kind: 'attribute', claim: shape.label });
    }
    const claimed = new Set([...featuresStatedIn(unnamed), ...featuresAsked(unnamed)].filter((feature) => !SHAPE_FEATURES.has(feature)));
    for (const feature of claimed) {
      // "Warm" said as "insulated" is judged above, by the stronger word.
      if (feature === 'warm' && STRONGER.some(([, pattern]) => pattern.test(text))) continue;
      if (!subject.some((product) => hasFeature(product, feature))) found.push({ kind: 'attribute', claim: FEATURE_LABEL[feature] });
    }
    // A weather named beside a product is a claim it suits it: only of one whose description states what that weather calls for.
    const fit = fitStatedIn(clause);
    if (fit && !subject.some((product) => attributesOf(product).fit === fit)) found.push({ kind: 'attribute', claim: `${fit} fit` });
  }
  return [...new Map(found.map((violation) => [violation.claim, violation])).values()];
}

const GARMENT = /^(polos?|jackets?|gilets?|midlayers?|hoodies?|trousers?|shorts|joggers?|caps?|belts?|socks?|beanies?|visors?|skorts?)$/;

/**
 * "The white golf joggers" when the card shows them in black. Swapping a pack's
 * trousers for white, the Caddie was handed black joggers and told the customer
 * they were white. A colour word, then words from the name of a piece on the
 * card, then what it is: that piece must come in that colour. Questions are
 * left alone - "would a white polo do?" is an offer, not a claim.
 */
function wrongColours(reply: string, products: Product[], told: string): Violation[] {
  const found: Violation[] = [];
  // Within a clause: "the Warrior Jacket in red, Hectar Midlayer in grey" never makes a red midlayer.
  const clauses = reply
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !sentence.trim().endsWith('?'))
    .flatMap((sentence) => sentence.split(/[,;:()]|\s-\s|\s+(?:and|with|for|to|from|instead of)\s+/i));
  for (const clause of clauses) {
    const words = clause.toLowerCase().match(/[a-z0-9'.-]+/g) ?? [];
    words.forEach((word, start) => {
      if (!isColourWord(word)) return;
      const end = words.findIndex((w, i) => i > start && i <= start + 5 && GARMENT.test(w));
      if (end < 0) return;
      const between = words.slice(start + 1, end);
      const noun = words[end]!.replace(/s$/, '').slice(0, 5);
      // The design named, or the only one of its kind on the card.
      const pieces = products.filter((product) => {
        const name = garmentName(product.title);
        return name.includes(noun) && between.every((w) => name.split(/\s+/).includes(w));
      });
      if (pieces.length === 0 || (between.length === 0 && pieces.length > 1)) return;
      const { colours } = parseColours(word);
      if (!colours.length) return;
      // The piece just swapped out is named in this turn's evidence in its own colour: "from the navy trousers" is true.
      const inEvidence = pieces.some((product) => {
        const name = garmentName(product.title).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`${name}\\s*-\\s*[^\\n\\[\\];,]*\\b${word}\\b`).test(told);
      });
      if (!inEvidence && !pieces.some((product) => colourMatch(product, colours, false) > 0)) {
        found.push({ kind: 'colour', claim: [word, ...between, words[end]].join(' ') });
      }
    });
  }
  return found;
}

/* ---------------- Stock and sizes ---------------- */

const SIZE_WORD = String.raw`(?:xxs|xs|xxxl|xxl|[2-5]xl|xl|x-?large|extra large|small|medium|large|s|m|l|\d{2})`;
const SIZE_LIST = String.raw`(${SIZE_WORD}(?:\s*(?:,|and|or|&)\s*${SIZE_WORD})*)`;
const CLAIMS: Array<{ says: 'in-stock' | 'sold-out'; pattern: RegExp }> = [
  { says: 'sold-out', pattern: new RegExp(String.raw`\b(?:sizes?\s+)?${SIZE_LIST}\s+(?:is|are|'s)\s+(?:currently\s+|now\s+)?(?:sold out|out of stock|not (?:in stock|available))\b`, 'gi') },
  { says: 'sold-out', pattern: new RegExp(String.raw`\b(?:sold out|out of stock|(?:not|isn['’]?t|aren['’]?t)\s+(?:in stock|available)|unavailable)\s+in\s+(?:sizes?\s+)?${SIZE_LIST}\b`, 'gi') },
  { says: 'in-stock', pattern: new RegExp(String.raw`\b(?:sizes?\s+)?${SIZE_LIST}\s+(?:is|are|'s)\s+(?:currently\s+|now\s+|still\s+)?(?:in stock|available)\b`, 'gi') },
  // Not after a "not": "isn't available in size S" is the opposite claim - it was read as "available in S", and the true sentence was cut.
  { says: 'in-stock', pattern: new RegExp(String.raw`(?<!\b(?:not|isn['’]?t|aren['’]?t|never)\s+)\b(?:in stock|available)\s+in\s+(?:sizes?\s+)?${SIZE_LIST}\b`, 'gi') },
];

/**
 * "XL is in stock", "sold out in M", "available in S, M and L" - held to
 * the product's own variants, through the same reader product details and
 * search use (catalog/commerce.ts supportsSize). A claim is checked only when
 * it is about one design: the one its sentence names, or the only one on the
 * card. Several products and no name - it cannot be told which, and nothing
 * is said to be wrong.
 */
export function stockClaims(reply: string, products: Product[], card: Product[]): Violation[] {
  if (!products.length) return [];
  const keys = products.map((product) => ({ product, key: designKey(product) })).filter((entry) => entry.key.trim().length > 2);
  const cardDesigns = new Set(card.map((product) => designKey(product)));
  const found: Violation[] = [];
  for (const sentence of reply.split(/(?<=[.!?])\s+/)) {
    if (/\?\s*$/.test(sentence.trim())) continue;
    const text = normalise(sentence);
    const named = keys.filter((entry) => text.includes(entry.key)).map((entry) => entry.product);
    const subject = named.length ? named : cardDesigns.size === 1 ? card : [];
    if (!subject.length || new Set(subject.map((product) => designKey(product))).size > 1) continue;
    for (const { says, pattern } of CLAIMS) {
      for (const match of sentence.matchAll(new RegExp(pattern.source, pattern.flags))) {
        const sizes = match[1]!.split(/\s*(?:,|and|or|&)\s*/i).map((word) => word.trim()).filter(Boolean);
        for (const size of sizes) {
          const wanted = normaliseSize(size) ?? size.toUpperCase();
          // A lone s, m or l is a size only when the sentence talks of sizes or stock around it - "it's" is not S.
          const statuses = subject.map((product) => supportsSize(product, wanted));
          if (statuses.every((status) => status === 'other-scale')) continue;
          // A size that says nothing about it - "not available in M" of a cap in one size - is wrong whichever way it is said.
          if (statuses.every((status) => status === 'not-applicable')) {
            found.push({ kind: 'stock', claim: match[0] });
            continue;
          }
          const right = says === 'in-stock' ? statuses.some((status) => status === 'in-stock') : statuses.every((status) => status !== 'in-stock');
          if (!right) found.push({ kind: 'stock', claim: match[0] });
        }
      }
    }
  }
  return [...new Map(found.map((violation) => [violation.claim, violation])).values()];
}

/* ---------------- "We don't have ..." ---------------- */

const ABSENCE = /\b(?:we\s+)?(?:don'?t|do not|doesn'?t|does not)\s+(?:currently\s+)?(?:have|stock|carry|sell|do)\s+(?:any\s+)?((?:[a-z']+\s+){0,3}?)(polos?|jackets?|gilets?|midlayers?|hoodies?|trousers|joggers|shorts|skorts?|caps?|belts?|socks)\b|\bthere (?:are|is) no\s+((?:[a-z']+\s+){0,3}?)(polos?|jackets?|gilets?|midlayers?|hoodies?|trousers|joggers|shorts|skorts?|caps?|belts?|socks)\b/gi;

/**
 * "We don't have red jackets" - said while the red Warrior Jacket was on the
 * shelf (certification). A claim that the store has none of a colour of a
 * kind is checked against the whole catalogue, through the same readers
 * search uses (kind, range, colour, in stock); one product that fits makes
 * it false.
 */
export function absenceClaims(reply: string): Violation[] {
  const found: Violation[] = [];
  for (const match of reply.matchAll(new RegExp(ABSENCE.source, ABSENCE.flags))) {
    const words = (match[1] ?? match[3] ?? '').trim();
    const kinds = categoriesAsked(match[2] ?? match[4] ?? '');
    const { colours } = parseColours(words);
    if (!colours.length || !kinds.length) continue;
    const range = parseRange(words).range;
    const exists = allProducts().some(
      (product) => isBuyable(product) && isCategory(product, kinds) && (range ? rangeOf(product) === range : rangeOf(product) !== 'kids') && colourMatch(product, colours, true) > 0,
    );
    if (exists) found.push({ kind: 'stock', claim: match[0] });
  }
  return found;
}

/* ---------------- Size questions ---------------- */

/** A sentence that asks for, or says it needs, a size. */
const ASKS_SIZE = /\b(what|which)\s+(?:[a-z]+\s+){0,2}sizes?\b|\b(?:need|needs|needed|choose|pick|select|confirm|tell me|let me know|still need|require|requires)\b[^.?!]{0,50}\bsizes?\b|\bsizes?\b[^.?!]{0,30}\b(?:needed|required|to choose|to pick)\b/i;

/**
 * "What size would you like?" about socks, "I still need the belt size" -
 * a size asked for when the product has no size to choose, or its size is
 * already settled. Judged by commerce truth (catalog/commerce.ts sizeScale),
 * never by a word list of one-size things: a sentence is about the products
 * it names, the kinds it names ("the belt and socks"), or else everything
 * in view; it is wrong only when none of those still needs a size. A size
 * question about a polo with no size chosen stays a good question.
 */
export function sizeRequests(reply: string, pool: Product[], settled: Set<string> = new Set()): Violation[] {
  if (!pool.length) return [];
  const keys = pool.map((product) => ({ product, key: designKey(product) })).filter((entry) => entry.key.trim().length > 2);
  const found: Violation[] = [];
  for (const sentence of reply.split(/(?<=[.!?])\s+/)) {
    if (!ASKS_SIZE.test(sentence) || /\bone[- ]size\b/i.test(sentence)) continue;
    const text = normalise(sentence);
    const named = keys.filter((entry) => text.includes(entry.key)).map((entry) => entry.product);
    const kinds = categoriesAsked(sentence);
    const ofKind = kinds.length ? pool.filter((product) => isCategory(product, kinds)) : [];
    const subject = named.length ? named : ofKind.length ? ofKind : kinds.length ? [] : pool;
    if (!subject.length) continue;
    const stillOpen = subject.filter((product) => !sizeScale(product).oneSize && !settled.has(product.id));
    if (!stillOpen.length) found.push({ kind: 'size', claim: sentence.trim() });
  }
  return found;
}

/** A size put on a product: "in your size", "in your size M", "fitting your medium size", "size 32". */
const SIZE_ON = /\b(?:in|fits?|fitting|for)\s+your\s+size\b|\b(?:in|fits?|fitting|for)\s+your\s+(?:size\s+)?(?:xxs|xs|s|m|l|xl|[2-5]xl|small|medium|large|\d{2})\b|\byour\s+(?:xs|s|m|l|xl|[2-5]xl|small|medium|large|\d{2})\s+(?:size|waist)\b|\b(?:in\s+)?size\s+(?:xxs|xs|s|m|l|xl|[2-5]xl|small|medium|large|\d{2})\b/i;

/**
 * Their size put on something that has none - "the cap is £4 in your size M",
 * "one size socks in your size M" (live replay, V1 task 1). The cards were
 * right; the words told them a size mattered where none does. Held like a
 * size question (sizeRequests): the products it names, else the kind it
 * names, else everything in play - and only when every one is one size.
 */
export function sizeClaims(reply: string, pool: Product[]): Violation[] {
  if (!pool.length) return [];
  const keys = pool.map((product) => ({ product, key: designKey(product) })).filter((entry) => entry.key.trim().length > 2);
  const found: Violation[] = [];
  for (const sentence of reply.split(/(?<=[.!?])\s+/)) {
    if (!SIZE_ON.test(sentence)) continue;
    const text = normalise(sentence);
    const named = keys.filter((entry) => text.includes(entry.key)).map((entry) => entry.product);
    const kinds = categoriesAsked(sentence);
    const ofKind = kinds.length ? pool.filter((product) => isCategory(product, kinds)) : [];
    const subject = named.length ? named : ofKind.length ? ofKind : kinds.length ? [] : pool;
    if (subject.length && subject.every((product) => sizeScale(product).oneSize)) found.push({ kind: 'size', claim: sentence.trim() });
  }
  return found;
}

/** The reply without the sentences that make an unbacked claim - the last resort. */
export function withoutClaims(reply: string, violations: Violation[]): string {
  // Ranking talk is reworded in place: the sentence around it is usually the recommendation itself.
  const reworded = violations.some((violation) => violation.kind === 'wording') ? plainWording(reply) : reply;
  // Split at a stop followed by a space - "£159.99" is not two sentences.
  const sentences = reworded.split(/(?<=[.!?])\s+/);
  // A feature or fit can be worded several ways ("relaxed-fit", "moisture wicking", "light"): read it as the check did.
  const attributesSaid = (sentence: string) =>
    new Set(
      [
        ...[...featuresStatedIn(sentence), ...featuresAsked(sentence)].map((feature) => FEATURE_LABEL[feature]),
        ...(fitStatedIn(sentence) ? [`${fitStatedIn(sentence)} fit`] : []),
        ...shapesSaid(sentence),
        ...STRONGER.filter(([, pattern]) => pattern.test(normalise(sentence))).map(([word]) => word),
        ...needsClaimed(normalise(sentence.replace(DEAL_NAMES, ' '))).map((need) => `suited to ${NEED_LABEL[need]}`),
      ].map((label) => label.toLowerCase()),
    );
  const bad = (sentence: string) =>
    violations.some((violation) =>
      // Too long is rewritten once, never cut: a factual answer is not truncated mid-thought.
      violation.kind === 'length'
        ? false
        : violation.kind === 'wording'
        ? false
        : violation.kind === 'attribute' ? attributesSaid(sentence).has(violation.claim.toLowerCase()) : sentence.toLowerCase().includes(violation.claim.toLowerCase()),
    );
  // A clause cut after a dash leaves "breathable—." behind: tidied to a full stop.
  return sentences.filter((sentence) => !bad(sentence)).join(' ').replace(/\s*[—–-]+\s*\./g, '.').trim();
}
