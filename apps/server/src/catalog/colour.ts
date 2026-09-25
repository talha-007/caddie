import type { Product } from '@caddie/shared';

/**
 * What colour a product is, and whether it is the colour the customer asked
 * for.
 *
 * Colour used to be just another search word, which went wrong two ways at
 * once. "Blue" knew nothing about navy, teal or royal, so the blue garments we
 * do stock did not count. And a product that failed the colour still came
 * back on the other words: "blue polo" matched "polo" on every polo, sorted by
 * price, and the customer was shown an orange one first.
 *
 * So colour is now its own test, and a hard one. A product that is not in the
 * colour asked for is never returned as if it were; when nothing is, the
 * honest answer is that we do not have it in that colour.
 *
 * Where the colour is read from matters as much. **Never from tags.** The
 * store's tags carry campaign and collection labels, and "blue" is on the
 * orange, purple, teal and white-and-orange polos - which is exactly how the
 * orange polo won that search. Never from descriptions either, which mention
 * other garments' colours ("pairs well with navy trousers"). Only the title,
 * where Druids names the colourway ("VENTO POLO - NAVY/ WHITE"), and a
 * variant's own Colour option.
 */

/**
 * Families a customer asks for by name, and the shades that belong to each.
 * A shade can sit in two families: teal is fairly asked for as blue or green.
 */
const FAMILIES: Record<string, string[]> = {
  blue: ['blue', 'navy', 'royal', 'cobalt', 'sky', 'azure', 'denim', 'indigo', 'cyan', 'teal', 'petrol', 'marine', 'ocean', 'turquoise', 'aqua', 'tiffany'],
  green: ['green', 'sage', 'olive', 'forest', 'mint', 'emerald', 'lime', 'teal', 'bottle', 'khaki', 'moss', 'pine', 'jade', 'tiffany'],
  red: ['red', 'burgundy', 'maroon', 'wine', 'claret', 'crimson', 'scarlet', 'cherry', 'oxblood', 'brick'],
  pink: ['pink', 'rose', 'blush', 'fuchsia', 'magenta', 'raspberry', 'salmon', 'coral', 'petal', 'mulberry'],
  purple: ['purple', 'lilac', 'lavender', 'violet', 'plum', 'mauve', 'aubergine', 'grape', 'amethyst', 'mulberry'],
  orange: ['orange', 'rust', 'amber', 'tangerine', 'peach', 'apricot', 'copper', 'coral'],
  yellow: ['yellow', 'mustard', 'lemon', 'gold', 'ochre', 'saffron'],
  brown: ['brown', 'tan', 'camel', 'chocolate', 'mocha', 'coffee', 'taupe', 'chestnut', 'cognac'],
  beige: ['beige', 'cream', 'stone', 'sand', 'oatmeal', 'ecru', 'ivory', 'natural', 'biscuit'],
  white: ['white', 'ivory', 'snow', 'optic', 'chalk'],
  black: ['black', 'jet', 'onyx', 'ebony'],
  grey: ['grey', 'gray', 'charcoal', 'slate', 'silver', 'ash', 'graphite', 'gunmetal', 'marl', 'heather', 'pewter', 'smoke'],
};

/** Spellings of the same shade. */
/*
 * Spellings of the same shade, including the store's own shorthand. The
 * vocabulary was checked against every colourway word in the live catalogue;
 * mulberry (20 products), petal, tiffany and blk were the colours missing.
 */
const SAME: Record<string, string> = { gray: 'grey', colour: 'color', blk: 'black' };

const norm = (word: string) => SAME[word] ?? word;

/** Every word we treat as a colour: family names and shades. */
const VOCABULARY = new Set<string>(Object.values(FAMILIES).flat().map(norm));
for (const family of Object.keys(FAMILIES)) VOCABULARY.add(norm(family));

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean)
    .map(norm);
}

export function isColourWord(word: string): boolean {
  return VOCABULARY.has(norm(word.toLowerCase()));
}

/** One colour the customer asked for. */
export interface ColourRequest {
  /** The word they used, e.g. "blue" or "navy". */
  word: string;
  /** Shades that satisfy it. A family name accepts its whole family; a shade only itself. */
  accepts: Set<string>;
}

/**
 * The colours in a query, and the words left over.
 *
 * "navy blue polo" asks for navy, not for anything blue: when a shade and its
 * own family are both named, the shade is the request. Several colours ("navy
 * or white") are alternatives - any one of them will do.
 */
export function parseColours(query: string): { colours: ColourRequest[]; rest: string; plain: boolean } {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const named = new Set<string>();
  const rest: string[] = [];
  let plain = false;

  for (const token of tokens) {
    const parts = words(token);
    const colourParts = parts.filter((part) => VOCABULARY.has(part));
    if (PLAIN.has(token.replace(/[^a-z-]/g, ''))) {
      plain = true;
    } else if (colourParts.length && colourParts.length === parts.length) {
      for (const part of colourParts) named.add(part);
    } else {
      rest.push(token);
    }
  }

  const families = [...named].filter((word) => FAMILIES[word]);
  const shades = [...named].filter((word) => !FAMILIES[word]);
  const colours: ColourRequest[] = [];

  for (const shade of shades) colours.push({ word: shade, accepts: new Set([shade]) });
  for (const family of families) {
    // A shade of this family was named as well: that is the request, not the family.
    const members = (FAMILIES[family] ?? []).map(norm);
    if (shades.some((shade) => members.includes(shade))) continue;
    colours.push({ word: family, accepts: new Set([family, ...members]) });
  }

  // "light blue", "dark green": the colour is the request; the shade of it is
  // not a word to find in a product name.
  const kept = colours.length ? rest.filter((token) => !MODIFIERS.has(token)) : rest;
  return { colours, rest: kept.join(' '), plain };
}

const MODIFIERS = new Set(['light', 'dark', 'pale', 'deep', 'bright', 'dusty', 'muted', 'soft']);

/**
 * "Plain white" is white and nothing else. Without this, "WHITE/ ORANGE" was
 * a white polo, and a customer who asked for a plain white one was swapped
 * into the orange-and-white.
 */
/**
 * Patterns Druids names in the title. Read from the title only - the tags
 * ("printed-polos") are campaign labels and sit on plain polos too.
 */
const PATTERNED =
  /\b(stripes?|striped|print|printed|camo|camouflage|check|checked|checks|plaid|tartan|floral|leopard|tiger|zebra|paisley|tropic|tropical|tiki|pineapple|skull|skullz|geo|geometric|grid|dots?|spots?|polka|argyle|houndstooth|abstract|jacquard|pattern|patterned|graphic|palm|palms|hex|emotive)\b/i;

const PLAIN = new Set(['plain', 'solid', 'single-colour', 'single-color', 'block', 'all-white', 'all-black']);

/** The colourway words in a title - after the last " - " when Druids uses one. */
function titleColours(title: string): string[] {
  const dash = title.lastIndexOf(' - ');
  const part = dash >= 0 ? title.slice(dash + 3) : title;
  return words(part).filter((word) => VOCABULARY.has(word));
}

const COLOUR_OPTION = /^(colou?r|colourway|colorway|shade)$/i;

/**
 * The colourways a product comes in, each as its colour words: the one in
 * the title ("NAVY/ WHITE" -> navy, white), and each in-stock Colour variant.
 */
/** Cached per product object, like rangeOf: a changed product is a new object. */
const waysCache = new WeakMap<Product, { all: string[][]; inStock: string[][] }>();

function colourways(product: Product, inStockOnly: boolean): string[][] {
  let cached = waysCache.get(product);
  if (!cached) {
    cached = { all: computeWays(product, false), inStock: computeWays(product, true) };
    waysCache.set(product, cached);
  }
  return inStockOnly ? cached.inStock : cached.all;
}

function computeWays(product: Product, inStockOnly: boolean): string[][] {
  const ways: string[][] = [];
  const fromTitle = titleColours(product.title);
  if (fromTitle.length) ways.push(fromTitle);
  for (const variant of product.variants) {
    if (inStockOnly && !variant.available) continue;
    for (const [name, value] of Object.entries(variant.options)) {
      if (!COLOUR_OPTION.test(name)) continue;
      const shades = words(value).filter((word) => VOCABULARY.has(word));
      if (shades.length) ways.push(shades);
    }
  }
  return ways;
}

/**
 * How well a product answers the colours asked for:
 *
 *   3  exactly that colour and nothing else     ORIENT POLO - WHITE, for white
 *   2  that colour, alongside others            VENTO POLO - WHITE/ ORANGE
 *   1  a shade of the family asked for          navy or teal, for blue
 *   0  not that colour
 *
 * With `plain`, only a colourway made of the colour asked for counts - "plain
 * white" is 3 or nothing. With `plain` and no colour, any single-colour
 * colourway does.
 *
 * A colour held on a variant only counts while that variant can be bought,
 * unless `inStockOnly` is false: offering "the navy one" when only the sage
 * is left is the same mistake as offering orange.
 */
export function colourMatch(product: Product, colours: ColourRequest[], inStockOnly = true, plain = false): number {
  // Plain is one colour and no pattern: "STRIPE PERFORMANCE POLO - WHITE" is
  // white, and it is not plain.
  if (plain && PATTERNED.test(product.title)) return 0;
  const ways = colourways(product, inStockOnly);

  if (colours.length === 0) {
    if (!plain) return 2;
    return ways.some((way) => new Set(way).size === 1) ? 3 : 0;
  }
  if (ways.length === 0) return 0;

  let best = 0;
  for (const colour of colours) {
    for (const way of ways) {
      const onlyThis = way.every((shade) => colour.accepts.has(shade));
      const exact = way.includes(colour.word);
      const score = exact && onlyThis ? 3 : exact ? 2 : way.some((shade) => colour.accepts.has(shade)) ? 1 : 0;
      // Plain means this colour alone; a mix or a neighbouring shade does not do.
      if (plain && !(onlyThis && score > 0)) continue;
      best = Math.max(best, score);
    }
  }
  return best;
}

/** Convenience for callers holding the customer's colour as free text ("navy", "light blue"). */
export function matchesColourText(product: Product, colour: string | undefined): number {
  if (!colour) return 2;
  const { colours, plain } = parseColours(colour);
  // Free text that names no colour we know ("team colours") cannot rule anything out.
  if (colours.length === 0 && !plain) return 2;
  return colourMatch(product, colours, true, plain);
}

/**
 * The colourways a set of products actually comes in, as Druids names them,
 * for "we do not have it in blue - it comes in black, orange and white".
 */
export function coloursOffered(products: Product[]): string[] {
  const seen = new Map<string, string>();
  for (const product of products) {
    const dash = product.title.lastIndexOf(' - ');
    if (dash >= 0) {
      const label = product.title.slice(dash + 3).trim();
      if (label && titleColours(product.title).length) seen.set(label.toLowerCase(), label);
    }
    for (const variant of product.variants) {
      if (!variant.available) continue;
      for (const [name, value] of Object.entries(variant.options)) {
        if (COLOUR_OPTION.test(name)) seen.set(value.toLowerCase(), value);
      }
    }
  }
  return [...seen.values()];
}
