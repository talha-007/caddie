import { featureState, formatMoney, sizeScale } from '../catalog/commerce.js';
import { priceRange } from './pricing.js';
import type { Product, ProductVariant } from '@caddie/shared';
import { colourwayName, otherColourways } from '../catalog/colourways.js';
import { matchesColourText, parseColours } from '../catalog/colour.js';
import { normaliseSize, optionValueMatches } from './sizeWords.js';
import { FEATURE_LABEL, attributesOf, featuresAsked, featuresStatedIn, fitStatedIn, hasFeature, type Feature, type ProductFit } from '../catalog/attributes.js';
import { WEATHER_NEEDS, shapesOf, shapesSaid, strongerOf, strongerSaid } from '../catalog/attributes.js';
import { NEED_EVIDENCE_WORDS, NEED_LABEL, needsSaid, suitsNeed } from '../catalog/suitability.js';

/**
 * Everything a customer can ask about one product - which sizes, which
 * colours, what is in stock, what it costs in their size - answered from its
 * variants, not by the model reading raw options.
 *
 * "Does it come in XL?", "is the medium in stock?", "how much is it in 2XL?",
 * "what colours does it come in?" are the most ordinary questions on a shop
 * floor, and the ones a model gets wrong: it reads a size list as stock, a
 * colour option as the only colours (Druids lists most colourways as separate
 * products), a starting price as the price. Here they are facts.
 */

const COLOUR_OPTION = /colou?r/i;

const money = formatMoney;

export interface SizeLine {
  size: string;
  inStock: boolean;
  /** Its price, when prices differ by size. */
  price?: number;
}

export interface StockPicture {
  /** The option the sizes are read from - "Size", "WAIST SIZE". */
  sizeOption?: string;
  /** Per colour when the product has a colour option; one group otherwise. */
  groups: Array<{ colour?: string; sizes: SizeLine[] }>;
  /** Other options that also have to be chosen - leg length on trousers. */
  otherOptions: Array<{ name: string; values: string[] }>;
  priceMin: number;
  priceMax: number;
  currency: string;
  /** The same garment in other colours, listed by Druids as separate products. */
  otherColourways: Product[];
}

function sizeOf(variant: ProductVariant, option?: string): string | undefined {
  return option ? variant.options[option] : undefined;
}

export function stockPicture(product: Product): StockPicture {
  const names = product.options.map((option) => option.name);
  /*
   * The size choice is the product's own size scale (catalog/commerce.ts): a
   * sock whose only size is ONE SIZE has none, so it reads "one size" here,
   * on its card and at the basket alike. The leg is a further choice.
   */
  const sizeOption = sizeScale(product).dimensions.find((dimension) => dimension.scale !== 'leg')?.option;
  const colourOption = names.find((name) => COLOUR_OPTION.test(name));
  const otherOptions = product.options
    .filter((option) => option.name !== sizeOption && option.name !== colourOption && option.values.length > 1)
    .map((option) => ({ name: option.name, values: option.values }));

  const variants = product.variants;
  // The prices they could pay: variants that can be bought (recommend/pricing.ts priceRange).
  const span = priceRange(product);
  const currency = span.currency;
  const differ = span.min !== span.max;

  const colours = colourOption ? (product.options.find((option) => option.name === colourOption)?.values ?? []) : [undefined];
  const sizeValues = sizeOption ? (product.options.find((option) => option.name === sizeOption)?.values ?? []) : [];

  const groups = colours.map((colour) => {
    const mine = variants.filter((variant) => !colour || !colourOption || variant.options[colourOption] === colour);
    const sizes: SizeLine[] = sizeValues.map((size) => {
      const matching = mine.filter((variant) => sizeOf(variant, sizeOption) === size);
      const inStock = matching.some((variant) => variant.available);
      const price = matching.find((variant) => variant.available)?.price.amount ?? matching[0]?.price.amount;
      return { size, inStock, ...(differ && price !== undefined ? { price } : {}) };
    });
    return { ...(colour ? { colour } : {}), sizes };
  });

  return {
    ...(sizeOption ? { sizeOption } : {}),
    groups,
    otherOptions,
    priceMin: span.min,
    priceMax: span.max,
    currency,
    otherColourways: otherColourways(product),
  };
}

/** "S, M, L in stock; XL sold out" - for the model's facts. */
export function describeStock(product: Product, picture = stockPicture(product)): string {
  const lines: string[] = [];
  for (const group of picture.groups) {
    const inStock = group.sizes.filter((line) => line.inStock).map((line) => (line.price !== undefined ? `${line.size} (${money(line.price, picture.currency)})` : line.size));
    const out = group.sizes.filter((line) => !line.inStock).map((line) => line.size);
    const label = group.colour ? `${group.colour}: ` : '';
    if (!group.sizes.length) lines.push(`${label}one size`);
    else lines.push(`${label}in stock ${inStock.join(', ') || 'none'}${out.length ? `; sold out ${out.join(', ')}` : ''}`);
  }
  const price =
    picture.priceMin === picture.priceMax
      ? money(picture.priceMin, picture.currency)
      : `${money(picture.priceMin, picture.currency)} to ${money(picture.priceMax, picture.currency)} depending on size`;
  const colours = picture.otherColourways.length
    ? `Also comes in (separate products): ${picture.otherColourways.map((other) => `${colourwayName(other.title)} [${other.id}]`).join(', ')}.`
    : 'No other colourways in stock.';
  const extra = picture.otherOptions.map((option) => `${option.name}: ${option.values.join(', ')}`).join('; ');
  return `${product.title} [${product.id}] - ${price}. ${picture.sizeOption ?? 'Sizes'}: ${lines.join(' | ')}.${extra ? ` Also choose ${extra}.` : ''} ${colours}`;
}

/** The sizes a question names: "XL", "a medium", "34 waist", "size 12". */
export function sizesAsked(text: string, product: Product): string[] {
  const values = stockPicture(product).groups.flatMap((group) => group.sizes.map((line) => line.size));
  const words = text.toLowerCase().replace(/[^a-z0-9/ -]/g, ' ');
  const candidates = [
    ...words.matchAll(/\b(xxs|xs|s|m|l|xl|xxl|xxxl|2xl|3xl|4xl|5xl|small|medium|large|x-?large|extra large|extra small)\b/g),
    ...words.matchAll(/\b(\d{1,2}(?:\/\d{1,2})?)\b/g),
  ].map((match) => match[1]!);
  // A lone s, m or l is a size only when said as one: "in L", "size M", "an S". "It's in stock" is not size S.
  const loneLetters = new Set([...words.matchAll(/\b(?:size|in|an?|the|my|get|want|need|take|wear|for)\s+([sml])\b/g)].map((m) => m[1]!));
  const found = new Set<string>();
  for (const candidate of candidates) {
    if (/^[sml]$/.test(candidate) && !loneLetters.has(candidate)) continue;
    // "s" and "m" alone are words as often as sizes: only counted when the product has that size.
    const value = values.find((size) => optionValueMatches(size, candidate) || (normaliseSize(candidate) && normaliseSize(size) === normaliseSize(candidate)));
    if (value) found.add(value);
  }
  return [...found];
}

export interface Answer {
  /** What to say - exact, from the variants. */
  speech: string;
  /** The whole picture, for the model. */
  facts: string;
}

/*
 * What the product is like, from its own data - read by the same code that
 * decides what search may call it and what a reply may say about it
 * (catalog/attributes.ts, the verifier's shape and "stronger than warm"
 * rules). "Is it waterproof?" about the Tex Rain Jacket - waterproof in
 * search, waterproof in its description - was answered "its description does
 * not state that it is waterproof": the facts here held sizes, stock and
 * price, and nothing about the product at all.
 */

/** Everything its own data states: features, cut, shape, and the stronger-than-warm words. */
export function verifiedFacts(product: Product): string {
  const { features, fit, denied } = attributesOf(product);
  const labels = features.map((feature) => FEATURE_LABEL[feature]);
  // Waterproof covers water-resistant: say so, so neither reads as missing.
  if (features.includes('waterproof')) labels.splice(labels.indexOf(FEATURE_LABEL.waterproof) + 1, 0, 'water-resistant (it is waterproof)');
  const shapes = shapesOf(product);
  const stronger = strongerOf(product);
  return [
    `Verified from its own description: ${labels.length ? labels.join(', ') : 'no features stated'}.`,
    denied.length ? `Its description says it is NOT: ${denied.map((feature) => FEATURE_LABEL[feature]).join(', ')}.` : '',
    `Cut: ${fit ?? 'not stated'}.`,
    shapes.length ? `Shape: ${shapes.join(', ')}.` : '',
    stronger.length ? `Also stated, in these words: ${stronger.join(', ')} - not any other (insulated, fleece, quilted...) that is not listed.` : '',
    'Anything not listed here is not stated - say "its description doesn\'t say", never "no".',
  ]
    .filter(Boolean)
    .join(' ');
}

/** One asked-about attribute, answered in one of three ways. */
interface AttributeAnswer {
  asked: string;
  /**
   * yes - its data states it; no - its data says it is not ("not
   * waterproof"); other - it states something else in its place; unstated -
   * nothing either way (catalog/commerce.ts featureState).
   */
  state: 'yes' | 'no' | 'other' | 'unstated';
  /** What it states instead, for `other`. */
  instead?: string;
  /**
   * Set when what it states neither confirms nor rules out what was asked:
   * thermal is not a no to insulated. Unset for a real difference - water-
   * resistant is not waterproof, a slim cut is not a relaxed one.
   */
  unsaid?: boolean;
  /** A weather need ("good for winter?") rather than a feature: answered from what its description states for it (catalog/suitability.ts). */
  need?: boolean;
}

/** One asked-about attribute as a line of facts, the same words wherever it is written. */
export function attributeFactLine(answer: AttributeAnswer): string {
  if (answer.need) {
    if (answer.state === 'yes') return `${answer.asked} - supported: its description states ${answer.instead}`;
    if (answer.state === 'no') return `${answer.asked} - its description says it is not ${answer.instead}`;
    return `${answer.asked} - not supported: its description states nothing for it (never say it is, never say no - say the description doesn't state it)`;
  }
  if (answer.state === 'yes') return `${answer.asked} - yes, its description states it`;
  if (answer.state === 'no') return `${answer.asked} - no, its description says it is not`;
  if (answer.state === 'other') return `${answer.asked} - its description says ${answer.instead}${answer.unsaid ? ` - ${answer.asked} itself is not stated (never say no)` : ' instead'}`;
  return `${answer.asked} - not stated (never say no)`;
}

const FIT_WORDS: Record<ProductFit, string> = { athletic: 'an athletic cut', slim: 'a slim cut', tailored: 'a tailored cut', regular: 'a regular cut', relaxed: 'a relaxed cut' };

/** The attributes a question asks about, each answered from the product's own data. */
export function attributesAsked(product: Product, question: string): AttributeAnswer[] {
  const answers: AttributeAnswer[] = [];
  const { fit } = attributesOf(product);

  const stronger = strongerSaid(question);
  const statedStronger = strongerOf(product);
  for (const word of stronger) {
    const alongside = statedStronger.filter((other) => other !== word);
    if (statedStronger.includes(word)) answers.push({ asked: word, state: 'yes' });
    // "Insulated?" of a gilet described as thermal with a padded front: those are its words; insulated is not.
    else if (alongside.length) answers.push({ asked: word, state: 'other', instead: alongside.join(' and '), unsaid: true });
    // Or only warm: warm is what it says.
    else if (hasFeature(product, 'warm')) answers.push({ asked: word, state: 'other', instead: 'warm', unsaid: true });
    else answers.push({ asked: word, state: 'unstated' });
  }

  const features = new Set<Feature>([...featuresStatedIn(question), ...featuresAsked(question)]);
  // "Warm" inside "insulated" is answered above; "hooded" and the zips are shapes, below.
  if (stronger.length) features.delete('warm');
  for (const feature of ['hooded', 'quarter-zip', 'full-zip'] as Feature[]) features.delete(feature);
  for (const feature of features) {
    const label = FEATURE_LABEL[feature];
    const state = featureState(product, feature);
    if (state === 'yes') answers.push({ asked: label, state: 'yes' });
    else if (feature === 'waterproof' && hasFeature(product, 'water-resistant')) answers.push({ asked: label, state: 'other', instead: 'water-resistant' });
    else answers.push({ asked: label, state: state === 'no' ? 'no' : 'unstated' });
  }

  /*
   * "Is this good for winter?", "will it do in the rain?": the weather named,
   * answered from what its description states for it - and never as a no
   * when it states nothing. A feature of that weather asked by name ("is it
   * waterproof?", "will it keep me warm?") is answered above, once.
   */
  for (const need of needsSaid(question).needs) {
    if (WEATHER_NEEDS[need].some((feature) => features.has(feature)) || (need === 'cold' && stronger.length)) continue;
    const suits = suitsNeed(product, need);
    const label = NEED_LABEL[need];
    if (suits.verdict === 'yes') answers.push({ asked: label, state: 'yes', instead: suits.evidence.map((feature) => FEATURE_LABEL[feature]).join(' and '), need: true });
    else if (suits.verdict === 'no') answers.push({ asked: label, state: 'no', instead: suits.against.map((feature) => FEATURE_LABEL[feature]).join(' or '), need: true });
    else answers.push({ asked: label, state: 'unstated', need: true });
  }

  const fitAsked = fitStatedIn(question) ?? (/\b(relaxed|loose|roomy)\b/i.test(question) ? 'relaxed' : /\bslim\b/i.test(question) ? 'slim' : undefined);
  if (fitAsked) {
    if (fit === fitAsked) answers.push({ asked: `${fitAsked} fit`, state: 'yes' });
    else if (fit) answers.push({ asked: `${fitAsked} fit`, state: 'other', instead: FIT_WORDS[fit] });
    else answers.push({ asked: `${fitAsked} fit`, state: 'unstated' });
  }

  const shapes = shapesOf(product);
  for (const shape of shapesSaid(question)) answers.push({ asked: shape, state: shapes.includes(shape) ? 'yes' : 'unstated' });
  return answers;
}

/** The answer to a direct "is it...?" - said first, from the data, never a sales question in its place. */
export function sayAttributes(name: string, answers: AttributeAnswer[]): string {
  return answers
    .map((answer, index) => {
      const subject = index === 0 ? `the ${name}` : 'it';
      // The weather: what its description states for it, or that it states nothing - never "good for" on our say-so.
      if (answer.need) {
        if (answer.state === 'yes') return `${subject} is described as ${answer.instead}, which is what ${answer.asked} calls for`;
        if (answer.state === 'no') return `${subject}'s description says it isn't ${answer.instead}`;
        return `${subject}'s description doesn't state anything for ${answer.asked} - nothing about ${NEED_EVIDENCE_WORDS[answer.asked === NEED_LABEL.wet ? 'wet' : answer.asked === NEED_LABEL.cold ? 'cold' : answer.asked === NEED_LABEL.hot ? 'hot' : 'windy']}`;
      }
      if (answer.state === 'yes') return `${index === 0 ? 'Yes - ' : ''}${subject} is described as ${answer.asked}`;
      // Warm, or thermal, is not evidence either way for insulated: what it does state, and that the rest is not stated.
      if (answer.state === 'other' && answer.unsaid) return `${subject}'s description says ${answer.instead}, but doesn't state that it's ${answer.asked}`;
      if (answer.state === 'other') return `${subject}'s description says ${answer.instead}, not ${answer.asked}`;
      if (answer.state === 'no') return `${index === 0 ? 'No - ' : ''}${subject}'s description says it isn't ${answer.asked}`;
      return `${subject}'s product data doesn't state that it's ${answer.asked}`;
    })
    .map((sentence) => sentence.charAt(0).toUpperCase() + sentence.slice(1))
    .join('. ')
    .concat('.');
}

/**
 * The question, answered. Unrecognised questions still get the whole
 * picture in the facts, so the model answers from data either way.
 */
export function answerAbout(product: Product, question: string): Answer {
  const picture = stockPicture(product);
  const facts = `${describeStock(product, picture)}\n${verifiedFacts(product)}`;
  const q = question.toLowerCase();
  const name = product.title;

  // "Is it waterproof?", "is this relaxed fit?", "does it have a hood?" - answered before anything about sizes or colours.
  const attributes = attributesAsked(product, question);
  if (attributes.length) {
    return {
      speech: sayAttributes(titleCase(name), attributes),
      facts: `${facts}\nAsked about: ${attributes.map(attributeFactLine).join('; ')}. Answer this first, before any other question.`,
    };
  }

  // "Does it come in green?" - its own colour option, then its other colourways.
  const colours = parseColours(q).colours.map((colour) => colour.word);
  if (colours.length) {
    const wanted = colours.join(' or ');
    const option = picture.groups.filter((group) => group.colour && matchesColourText({ ...product, title: group.colour }, wanted) > 0);
    const others = picture.otherColourways.filter((other) => matchesColourText(other, wanted) > 0);
    const self = matchesColourText(product, wanted) > 0 && !option.length;
    if (self) return { speech: `Yes - the ${name} is ${colourwayName(name).toLowerCase() || wanted}.`, facts };
    if (option.length) return { speech: `Yes - it comes in ${option.map((group) => group.colour).join(' and ')}.`, facts };
    if (others.length) {
      return {
        speech: `Yes - it also comes in ${others.map((other) => colourwayName(other.title).toLowerCase()).join(' and ')}. Shall I show you?`,
        facts: `${facts}\nThat colour is a separate product: ${others.map((other) => `${other.title} [${other.id}]`).join(', ')}.`,
      };
    }
    // Its own colour first - from its colour option, or its name when it has none - then its other colourways.
    const own = picture.groups.map((group) => group.colour).filter(Boolean) as string[];
    const all = [...(own.length ? own : [colourwayName(name)]), ...picture.otherColourways.map((other) => colourwayName(other.title))].filter(Boolean);
    return {
      speech: `Not in ${wanted}, I'm afraid.${all.length ? ` It comes in ${all.slice(0, 6).join(', ').toLowerCase()}.` : ''}`,
      facts,
    };
  }

  // "What colours does it come in?"
  if (/\b(colou?rs?|colourways?|shades?)\b/.test(q)) {
    const own = picture.groups.map((group) => group.colour).filter(Boolean) as string[];
    const others = picture.otherColourways.map((other) => colourwayName(other.title));
    const all = [...new Set([...(own.length ? own : [colourwayName(name)]), ...others])].filter(Boolean);
    return {
      speech: all.length > 1 ? `It comes in ${all.join(', ').toLowerCase()}.` : `This one comes in ${all[0]?.toLowerCase() ?? 'one colour'} only.`,
      facts,
    };
  }

  // "Is XL in stock?", "do you have a medium?", "how much in 2XL?"
  const sizes = sizesAsked(q, product);
  if (sizes.length) {
    const replies = sizes.map((size) => {
      const lines = picture.groups.map((group) => ({ colour: group.colour, line: group.sizes.find((entry) => entry.size === size) }));
      const inStock = lines.filter((entry) => entry.line?.inStock);
      const price = inStock[0]?.line?.price ?? (picture.priceMin === picture.priceMax ? picture.priceMin : undefined);
      if (!inStock.length) return `${size} is sold out`;
      const colourNote = picture.groups.length > 1 && inStock.length < picture.groups.length ? ` in ${inStock.map((entry) => entry.colour).join(' and ')}` : '';
      return `${size} is in stock${colourNote}${price !== undefined ? ` at ${money(price, picture.currency)}` : ''}`;
    });
    const soldOut = replies.every((reply) => reply.endsWith('sold out'));
    const alternatives = picture.groups[0]?.sizes.filter((line) => line.inStock).map((line) => line.size) ?? [];
    return {
      speech: `${replies.join('; ').replace(/^./, (c) => c.toUpperCase())}.${soldOut && alternatives.length ? ` It's in stock in ${alternatives.join(', ')}.` : ''}`,
      facts,
    };
  }

  // "What sizes?", "is it in stock?"
  if (/\b(sizes?|stock|available|availability|fit)\b/.test(q)) {
    const group = picture.groups[0];
    const inStock = group?.sizes.filter((line) => line.inStock).map((line) => line.size) ?? [];
    const out = group?.sizes.filter((line) => !line.inStock).map((line) => line.size) ?? [];
    if (!group?.sizes.length) return { speech: `It's one size${product.variants.some((v) => v.available) ? ' and in stock' : ', and sold out right now'}.`, facts };
    return {
      speech: inStock.length
        ? `It's in stock in ${inStock.join(', ')}${out.length ? ` - ${out.join(', ')} ${out.length === 1 ? 'is' : 'are'} sold out` : ''}.`
        : "It's sold out in every size right now.",
      facts,
    };
  }

  // "How much is it?"
  if (/\b(price|cost|how much|expensive|cheap)\b/.test(q)) {
    return {
      speech:
        picture.priceMin === picture.priceMax
          ? `It's ${money(picture.priceMin, picture.currency)}.`
          : `It's ${money(picture.priceMin, picture.currency)} to ${money(picture.priceMax, picture.currency)}, depending on the size.`,
      facts,
    };
  }

  return { speech: `Here's what I have on the ${name}.`, facts };
}

/** "TEX RAIN JACKET - BLACK" -> "Tex Rain Jacket - Black", for saying aloud. */
function titleCase(title: string): string {
  return title.toLowerCase().replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}
