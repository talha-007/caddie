import type { CaddieAttachment, Product } from '@caddie/shared';
import { FEATURE_LABEL, attributesOf, featuresAsked, featuresStatedIn, fitStatedIn, hasFeature } from '../catalog/attributes.js';
import { colourMatch, isColourWord, parseColours } from '../catalog/colour.js';
import { garmentName } from '../catalog/colourways.js';
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
  kind: 'price' | 'product' | 'count' | 'colour' | 'attribute' | 'wording' | 'offer';
  claim: string;
}

const PRICE = /£\s?(\d{1,5}(?:[.,]\d{1,2})?)/g;
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
/** A count of garments a card could hold: "six polos", "4 jackets". */
const COUNT = /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:[a-z-]+\s+){0,2}?(polos|jackets|gilets|midlayers|hoodies|trousers|shorts|joggers|caps|belts|socks)\b/gi;
const KIND_OF: Record<string, RegExp> = {
  polos: /polo/i, jackets: /jacket/i, gilets: /gilet/i, midlayers: /midlayer/i, hoodies: /hoodie/i,
  trousers: /trouser/i, shorts: /short/i, joggers: /jogger/i, caps: /cap\b/i, belts: /belt/i, socks: /sock/i,
};

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

export function verifyReply(reply: string, evidence: string, attachment?: CaddieAttachment): Violation[] {
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
      const n = NUMBER_WORDS[match[1]!.toLowerCase()] ?? Number(match[1]);
      const kind = KIND_OF[match[2]!.toLowerCase()];
      const onCard = kind ? products.filter((product) => kind.test(product.title)).length : products.length;
      if (onCard && n > onCard) violations.push({ kind: 'count', claim: match[0] });
    }
    violations.push(...wrongColours(reply, products, told));
  }
  // What each product is said to be - features, fit - held to its own data, never to what was asked.
  violations.push(...unsupportedAttributes(reply, productsInEvidence(products, evidence), products[0]));
  violations.push(...salesWording(reply, products));
  return violations;
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
  for (const match of reply.matchAll(WEATHER_VERDICT)) if (!/\b(?:perfect|ideal)\b/i.test(match[0])) found.push({ kind: 'wording', claim: match[0].replace(/^,?\s*/, '') });
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

/**
 * Words that say more than "warm": each needs to appear in the product's own
 * text. "Warmly insulated" was said of a gilet whose data states warm and
 * windproof - warm is not insulated, and a salesperson who says so is wrong.
 */
const STRONGER: Array<[string, RegExp]> = [
  ['insulated', /\binsulat(ed|ion|ing)\b/],
  ['thermal', /\bthermal\b/],
  ['padded', /\bpadd(ed|ing)\b/],
  ['fleece', /\bfleece(d| lined)?\b/],
  ['quilted', /\bquilt(ed|ing)\b/],
  ['packable', /\bpack(able|s away| away)\b/],
];

const NEGATED = /\b(not|no|isn'?t|doesn'?t|don'?t|without|nor|never|not stated|rather than|can'?t|cannot|couldn'?t|whether)\b/;

/*
 * What a garment is shaped like. "The Pure Midlayer in black is warm and
 * sleeveless" - a midlayer with sleeves, offered to someone who asked for
 * something sleeveless. The customer's word is not the product's: each shape
 * needs the product's own title, type or description, read after the same
 * normalising as the reply ("quarter-zip", "1/4 zip" and "quarter zip" are
 * one thing). Nothing is inferred: a zip is not a full zip, a layer is not
 * sleeveless, a collar is not a v-neck, and a polo is not short-sleeved until
 * its data says so.
 */
interface Shape {
  label: string;
  /** How a reply says it, in normalised text. */
  said: RegExp;
  /** What in the product's own normalised text supports it. `named` is title and type only. */
  shown: (text: { all: string; named: string }) => boolean;
}

const SHAPES: Shape[] = [
  {
    label: 'sleeveless',
    said: /\bsleeveless\b/,
    // A gilet, vest or body warmer by its own name; "sleeveless" anywhere it describes itself.
    shown: ({ all, named }) => /\bsleeveless\b/.test(all) || /\b(gilets?|vests?|body ?warmers?)\b/.test(named),
  },
  { label: 'long sleeve', said: /\blong sleeve(s|d)?\b/, shown: ({ all }) => /\blong sleeve(s|d)?\b/.test(all) },
  { label: 'short sleeve', said: /\bshort sleeve(s|d)?\b/, shown: ({ all }) => /\bshort sleeve(s|d)?\b/.test(all) },
  {
    label: 'hooded',
    said: /\bhooded\b|\b(has|have|with|comes with|features?|featuring|and) (a |an )?(\w+ )?hood\b/,
    shown: ({ all }) => /\bhood(s|ed|ie|ies)?\b/.test(all),
  },
  { label: 'quarter zip', said: /\bquarter zip(s|ped)?\b|\b1 4 zip\b/, shown: ({ all }) => /\bquarter zip(s|ped)?\b|\b1 4 zip\b/.test(all) },
  { label: 'half zip', said: /\bhalf zip(s|ped)?\b|\b1 2 zip\b/, shown: ({ all }) => /\bhalf zip(s|ped)?\b|\b1 2 zip\b/.test(all) },
  { label: 'full zip', said: /\bfull zip(s|ped)?\b|\bfull length zip(per)?\b/, shown: ({ all }) => /\bfull (length )?zip(s|ped|per)?\b/.test(all) },
  { label: 'zip neck', said: /\bzip neck(ed)?\b/, shown: ({ all }) => /\bzip neck(ed)?\b/.test(all) },
  { label: 'crew neck', said: /\bcrew neck(ed)?\b/, shown: ({ all }) => /\bcrew( neck(ed)?)?\b/.test(all) },
  { label: 'v-neck', said: /\bv neck(ed)?\b/, shown: ({ all }) => /\bv neck(ed)?\b/.test(all) },
];

/** "No sleeves" and "without sleeves" are sleeveless, said another way - and not a negation. */
const sayShape = (text: string) => text.replace(/\b(no|without) sleeves\b/g, 'sleeveless');

/** The shapes a piece of reply text claims, by label. */
export function shapesSaid(text: string): string[] {
  const said = sayShape(normalise(text));
  return SHAPES.filter((shape) => shape.said.test(said)).map((shape) => shape.label);
}

/** Features whose wording is judged as a shape instead, so a hoodie's title counts. */
const SHAPE_FEATURES = new Set<string>(['hooded', 'quarter-zip', 'full-zip']);

function shapeText(product: Product): { all: string; named: string } {
  const named = normalise(`${product.title} ${product.productType ?? ''}`);
  return { all: normalise(`${named} ${product.description ?? ''}`), named };
}
/** A clause about what the customer wants, not about the product: "you prefer a relaxed fit". */
const THEIR_WANT = /\b(you|you'?ve|you'?d)\s+(prefer|like|want|wanted|asked|said|mentioned|need)\b/;
const RANGE_WORDS = /\b(mens|men s|ladies|womens|kids)\b/g;
/** Talk of other products, not the one in hand. */
const OTHERS = /\b(options?|alternatives?|others|other|instead|another|something else|some)\b/;

const normalise = (text: string) => ` ${text.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()} `;

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
    // "It has no sleeves" is a claim of sleeveless, not a negation.
    const text = sayShape(normalise(clause));
    const named = keys.filter((entry) => text.includes(entry.key)).map((entry) => entry.product);
    if (named.length) subject = named;
    if (subject.length === 0 || NEGATED.test(text)) continue;
    /*
     * Naming no product, a clause about the customer ("you prefer a relaxed
     * fit"), an offer, or other products ("would you like waterproof gilets
     * instead?") says nothing about this one. A clause that names the product
     * is always checked: "would you like the insulated Arvid Gilet?" is a claim.
     */
    if (named.length === 0 && (THEIR_WANT.test(text) || /\?\s*$/.test(clause.trim()) || OTHERS.test(text))) continue;
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
    const claimed = new Set([...featuresStatedIn(clause), ...featuresAsked(clause)].filter((feature) => !SHAPE_FEATURES.has(feature)));
    for (const feature of claimed) {
      // "Warm" said as "insulated" is judged above, by the stronger word.
      if (feature === 'warm' && STRONGER.some(([, pattern]) => pattern.test(text))) continue;
      if (!subject.some((product) => hasFeature(product, feature))) found.push({ kind: 'attribute', claim: FEATURE_LABEL[feature] });
    }
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
      ].map((label) => label.toLowerCase()),
    );
  const bad = (sentence: string) =>
    violations.some((violation) =>
      violation.kind === 'wording'
        ? false
        : violation.kind === 'attribute' ? attributesSaid(sentence).has(violation.claim.toLowerCase()) : sentence.toLowerCase().includes(violation.claim.toLowerCase()),
    );
  return sentences.filter((sentence) => !bad(sentence)).join(' ').trim();
}
