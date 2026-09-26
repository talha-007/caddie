import type { Product, ProductVariant } from '@caddie/shared';
import { colourwayName, otherColourways } from '../catalog/colourways.js';
import { matchesColourText, parseColours } from '../catalog/colour.js';
import { normaliseSize, optionValueMatches } from './sizeWords.js';

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

const SIZE_OPTION = /size|waist/i;
const COLOUR_OPTION = /colou?r/i;
const LEG_OPTION = /leg|length/i;

const SYMBOL: Record<string, string> = { GBP: '£', USD: '$', EUR: '€' };
const money = (amount: number, currency: string) => `${SYMBOL[currency] ?? `${currency} `}${amount.toFixed(2)}`;

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
  const sizeOption = names.find((name) => SIZE_OPTION.test(name));
  const colourOption = names.find((name) => COLOUR_OPTION.test(name));
  const otherOptions = product.options
    .filter((option) => option.name !== sizeOption && option.name !== colourOption && option.values.length > 1)
    .map((option) => ({ name: option.name, values: option.values }));

  const variants = product.variants;
  const prices = variants.map((variant) => variant.price.amount);
  const currency = variants[0]?.price.currency ?? product.price.currency;
  const differ = new Set(prices).size > 1;

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
    priceMin: prices.length ? Math.min(...prices) : product.price.amount,
    priceMax: prices.length ? Math.max(...prices) : product.price.amount,
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

/**
 * The question, answered. Unrecognised questions still get the whole
 * picture in the facts, so the model answers from data either way.
 */
export function answerAbout(product: Product, question: string): Answer {
  const picture = stockPicture(product);
  const facts = describeStock(product, picture);
  const q = question.toLowerCase();
  const name = product.title;

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
