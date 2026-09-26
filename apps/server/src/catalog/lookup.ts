import type { Product } from '@caddie/shared';
import { env } from '../env.js';
import { parseRange } from './audience.js';
import { colourMatch, parseColours } from './colour.js';
import { SPELLING_VARIANTS, editDistance, garmentWords, identityOf, nameWords, normaliseName, wordSimilarity } from './identity.js';
import { allProducts, catalogueReady, catalogueVersion } from './sync.js';
import { GARMENT_WORDS } from './taxonomy.js';
import { featuresAsked } from './attributes.js';
import { CATEGORY_CONCEPTS, RAIN_JACKET_CONCEPT, conceptsInQuery } from './concepts.js';
import { readIntent } from '../shopper/profile.js';

/**
 * Does Druids sell a product by that name?
 *
 * Search cannot answer this. It returns its nearest guesses, so asking for the
 * "Tour Championship Jacket" comes back with six jackets, and the Caddie
 * either presented one of them as it or - told never to do that - said "we do
 * not stock that" about things search simply ranked badly. Neither was
 * checked.
 *
 * The mirror is the whole catalogue, so a name can be checked against every
 * title in it: that is authoritative in a way a search result never is. When
 * the mirror is not loaded (the throttled fallback is answering), nothing is
 * claimed either way.
 */

/**
 * How the name was read. "exact" when every word they used is a catalogue
 * word; "corrected" when a misspelling or a spelling variant was read as the
 * catalogue's word ("galatic" -> "galactic", "vapour" -> "vapor"). Never
 * spoken as if the customer had spelled it right.
 */
export interface NameResolution {
  type: 'exact' | 'corrected';
  input: string;
  corrections: Array<{ from: string; to: string }>;
}

/**
 * What a name check can honestly say.
 *
 *   exact-product   the name, colour and range pin down one product
 *   exact-family    the design is certainly stocked; no single colourway was named
 *   possible-match  related products exist, but nothing confirms this is what
 *                   they named - a colour or range that differs, part of a
 *                   longer name, or a word that may be misspelt. Never "not
 *                   stocked", never presented as the product.
 *   not-found       a word of the name appears in no product title, nor
 *                   anything close to one: Druids do not sell it
 *   unknown         the catalogue is not loaded; nothing is claimed
 *
 * "Exact" used to mean every distinctive word was somewhere in a title, so
 * "Elite Polo - Navy" was forty-four products and "black Apex polo" was the
 * ladies Apex polo in blush. A misspelt "Vapour jacket" was "not stocked".
 */
export type Existence =
  | { kind: 'exact-product'; name: string; product: Product; resolution: NameResolution }
  | { kind: 'exact-family'; name: string; familyName: string; products: Product[]; resolution: NameResolution }
  | { kind: 'possible-match'; name: string; products: Product[]; reason: string; resolution?: NameResolution }
  | { kind: 'not-found'; name: string; closest: Product[] }
  | { kind: 'unknown'; name: string };

const FILLER = new Set([
  'the', 'a', 'an', 'my', 'your', 'this', 'that', 'of', 'in', 'and', 'or', 'for', 'with', 'druid', 'druids', 'golf', 'new',
  'mens', 'men', 'ladies', 'womens', 'women', 'kids', 'junior', 'plain', 'size', 'colour', 'color',
]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((word) => word.length > 1 && !FILLER.has(word));
}

function singular(word: string): string {
  return word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word;
}

/** Sizes are never part of a name: "player polo XL" is the Player polo, in XL. */
const SIZE_WORD = /^(xxs|xs|s|m|l|xl|xxl|xxxl|[2-5]xl|small|medium|large|\d{1,3}(\/\d{1,2})?)$/;

/** The words that make a name a name: not the garment, colour, range or size. */
export function distinctiveWords(name: string): string[] {
  const { rest } = parseColours(parseRange(name).rest);
  return words(rest).filter((word) => !GARMENT_WORDS.has(word) && !GARMENT_WORDS.has(singular(word)) && !SIZE_WORD.test(word));
}

function brandProducts(): Product[] {
  const tag = env.shopify.brandTag?.toLowerCase();
  const all = allProducts();
  return tag ? all.filter((product) => product.tags.some((value) => value.toLowerCase() === tag)) : all;
}

/**
 * The catalogue's name words, built once per catalogue change: every design
 * word ("galactic", "vapor", "elite") and every word in any title. Fuzzy
 * matching only ever compares against these - never descriptions or tags,
 * whose marketing words are not names.
 */
let vocabularyVersion = -1;
let vocabularySize = -1;
let designVocabulary = new Set<string>();
let titleVocabulary = new Set<string>();
const GARMENT_VOCABULARY = [...new Set([...GARMENT_WORDS].map(singular))].filter((word) => !['golf', 'druid', 'kit', 'pack', 'bundle'].includes(word));

function vocabulary(products: Product[]): { design: Set<string>; title: Set<string> } {
  if (vocabularyVersion !== catalogueVersion() || vocabularySize !== products.length) {
    designVocabulary = new Set(products.flatMap((product) => identityOf(product).designWords));
    titleVocabulary = new Set(products.flatMap((product) => [...identityOf(product).designWords, ...identityOf(product).title.split(' ').map(singular)]));
    vocabularyVersion = catalogueVersion();
    vocabularySize = products.length;
  }
  return { design: designVocabulary, title: titleVocabulary };
}

/**
 * The closest catalogue words to one they typed, and how sure that is. Only
 * the nearest strong candidates are kept: "hexi" is one edit from both HEXA
 * and HEXIE, and picking one would be a guess.
 */
function closestWord(word: string, known: Iterable<string>): { strong: string[]; weak: string[] } {
  const strong: string[] = [];
  const weak: string[] = [];
  for (const candidate of known) {
    const similarity = wordSimilarity(word, candidate);
    if (similarity === 'strong') strong.push(candidate);
    else if (similarity === 'weak') weak.push(candidate);
  }
  if (strong.length > 1) {
    const best = Math.min(...strong.map((candidate) => editDistance(word, candidate)));
    return { strong: strong.filter((candidate) => editDistance(word, candidate) === best), weak };
  }
  return { strong, weak };
}

/**
 * Words that ask for something without naming it: how it is asked, and what
 * it should cost. Kept to shopping talk; the words for weather, features,
 * fit and kinds of garment come from the readers that already know them.
 */
const SHOPPING_TALK = new Set([
  'something', 'anything', 'want', 'wants', 'need', 'needs', 'looking', 'show', 'please', 'some', 'any', 'one', 'ones',
  'under', 'below', 'less', 'than', 'max', 'maximum', 'budget', 'around', 'about', 'cheap', 'cheaper', 'pounds', 'quid',
  'good', 'nice', 'best', 'but', 'not', 'too', 'very', 'bit', 'more', 'playing', 'wear', 'wearing', 'round', 'rounds',
  'morning', 'mornings', 'evening', 'evenings', 'day', 'days', 'somewhere', 'prefer', 'usually', 'mostly',
  'do', 'does', 'you', 'have', 'has', 'got', 'can', 'could', 'would', 'is', 'are', 'im', 'me', 'get', 'find', 'sell', 'stock',
]);

/** Every word the garment concepts use ("sleeveless", "outer", "layer", "body", "warmer"...). */
const CONCEPT_WORDS = new Set(
  [...Object.values(CATEGORY_CONCEPTS), RAIN_JACKET_CONCEPT].flatMap((concept) => words(concept.replace(/[;,]/g, ' ')).map(singular)),
);

/**
 * The words in a query that could name a design.
 *
 * "Sleeveless outer layer" and "relaxed fit" were each checked as a product
 * name, found nowhere, and the Caddie told a customer "we do not stock a
 * sleeveless outer layer" - beside six gilets - and "we do not stock a polo
 * called relaxed fit". Those are descriptions: weather and use ("cold",
 * "summer"), what it must do ("warm", "breathable", "moisture wicking"), fit
 * ("relaxed", "slim", "fit"), what kind of thing it is ("sleeveless",
 * "outer", "layer"), and how it is asked for. Each is read by the code that
 * already reads it elsewhere; what is left, if anything, may be a name.
 */
export function namingWords(query: string): string[] {
  const all = distinctiveWords(query);
  // A feature or weather written as two words ("moisture wicking", "water resistant") marks both.
  const paired = new Set<number>();
  all.forEach((word, i) => {
    const next = all[i + 1];
    if (!next) return;
    const pair = `${word} ${next}`;
    const alone = featuresAsked(word).length || featuresAsked(next).length || readIntent(word).weather || readIntent(next).weather;
    if (!alone && (featuresAsked(pair).length || readIntent(pair).weather)) {
      paired.add(i);
      paired.add(i + 1);
    }
  });
  return all.filter((word, i) => {
    if (paired.has(i)) return false;
    if (SHOPPING_TALK.has(word)) return false;
    if (featuresAsked(word).length || readIntent(word).weather?.length) return false;
    if (word === 'fit' || word === 'fitting' || word === 'cut' || readIntent(`${word} fit`).fit) return false;
    if (conceptsInQuery(word).length || CONCEPT_WORDS.has(singular(word))) return false;
    return true;
  });
}

/**
 * A name in the search words the model did not flag as one.
 *
 * Asked for the "Tour Championship Jacket", the model sometimes searched
 * "Tour Championship Jacket" without saying it was a name - and then asked
 * the customer to confirm what it was called. A word that appears nowhere in
 * the catalogue, in no title and no description, cannot be a description of
 * a kind of garment we sell: it is a name we do not have. Ordinary words
 * ("comfortable", "smart") appear in descriptions, so they never trigger it.
 */
export function unknownNameIn(query: string): Existence | null {
  // Only the words that could name a design: never weather, a feature, a fit or a kind of garment described.
  const wanted = namingWords(query);
  if (!catalogueReady()) return null;
  /*
   * Only something shaped like a product name is checked: two or more
   * distinctive words, at least one of which Druids use in their product
   * names ("Tour", "Vento"). "Tour Championship jacket" searched without
   * productName was never checked, and the Caddie asked the customer to
   * confirm the name.
   *
   * The rule this replaces - any word found nowhere in the catalogue makes it
   * a name - called "a lightweight polo for Spain" and "something for a
   * wedding" products we do not stock. A description has no name words, so
   * it is never mistaken for one.
   *
   * One word is checked too when it is a misspelt Druids name ("galatic
   * midlayer"): that can only ever find a product, never deny one.
   */
  const products = brandProducts();
  if (wanted.length === 1) {
    const [word] = nameWords(wanted.join(' '));
    if (!word) return null;
    const { design } = vocabulary(products);
    if (design.has(word) || closestWord(word, design).strong.length !== 1) return null;
    const found = lookupProductName(query);
    return found && (found.kind === 'exact-family' || found.kind === 'exact-product') ? found : null;
  }
  if (wanted.length < 2) return null;
  const titleWords = new Set(products.flatMap((product) => words(product.title).map(singular)));
  if (!wanted.some((word) => titleWords.has(singular(word)))) return null;
  return lookupProductName(query);
}

export function lookupProductName(name: string): Existence | null {
  const said = [...new Set(nameWords(name))];
  // "A navy polo" names a kind of thing, not a product. Nothing to check.
  if (said.length === 0) return null;
  if (!catalogueReady()) return { kind: 'unknown', name };

  const products = brandProducts();

  // Shopify's own handle, word for word: "elite-polo-navy".
  const slug = normaliseName(name).replace(/ /g, '-');
  const byHandle = products.find((product) => identityOf(product).handle === slug);
  if (byHandle) return { kind: 'exact-product', name, product: byHandle, resolution: { type: 'exact', input: name, corrections: [] } };

  /*
   * Read each word as the catalogue spells it. A word already in a product
   * name stays; one that is not may be a misspelt name ("galatic") or a
   * misspelt garment ("pollo"). Spelling variants ("vapour", "hoody") were
   * already read as the catalogue's by nameWords.
   */
  const { design } = vocabulary(products);
  const garments = new Set(garmentWords(name));
  const wanted: string[] = [];
  const corrections: Array<{ from: string; to: string }> = [];
  const ambiguous: Array<{ word: string; options: string[] }> = [];
  for (const word of said) {
    if (design.has(word)) {
      wanted.push(word);
      continue;
    }
    const asName = closestWord(word, design).strong;
    const asGarment = closestWord(word, GARMENT_VOCABULARY).strong;
    if (asName.length === 1 && asGarment.length === 0) {
      wanted.push(asName[0]!);
      corrections.push({ from: word, to: asName[0]! });
    } else if (asGarment.length === 1 && asName.length === 0) {
      garments.add(asGarment[0]!);
      corrections.push({ from: word, to: asGarment[0]! });
    } else if (asName.length + asGarment.length > 1) {
      ambiguous.push({ word, options: [...asName, ...asGarment] });
    } else {
      wanted.push(word);
    }
  }
  const variantUsed = normaliseName(name)
    .split(' ')
    .some((word) => SPELLING_VARIANTS[word]);
  for (const word of normaliseName(name).split(' ')) {
    const variant = SPELLING_VARIANTS[word];
    if (variant) corrections.push({ from: word, to: variant });
  }
  const resolution: NameResolution = {
    type: corrections.length || variantUsed ? 'corrected' : 'exact',
    input: name,
    corrections,
  };

  if (ambiguous.length) {
    // Close to more than one name: show them all, choose none.
    const options = ambiguous.flatMap((entry) => entry.options);
    const candidates = products.filter((product) => options.some((option) => identityOf(product).designWords.includes(option)));
    return {
      kind: 'possible-match',
      name,
      products: pickAcrossDesigns(candidates, 6),
      reason: `"${ambiguous[0]!.word}" is close to more than one product name`,
      resolution,
    };
  }
  // Nothing left but garment words: "pollo" alone was a polo, not a name.
  if (wanted.length === 0) return null;

  const found = resolve(name, wanted, [...garments], products, resolution);
  if (found) return found;
  return absent(name, wanted, products, [...garments]);
}

/**
 * The name, read in catalogue words, checked against every product - with
 * the colour and range they named deciding which product it is.
 */
function resolve(name: string, wanted: string[], garments: string[], products: Product[], resolution: NameResolution): Existence | null {
  const { colours } = parseColours(name);
  const range = parseRange(name.replace(/[’]/g, "'")).range;

  // Designs carrying every name word they used.
  let family = products.filter((product) => wanted.every((word) => identityOf(product).designWords.includes(word)));
  if (family.length === 0) return null;

  // The garment they said: "Apex polo" is not an Apex jacket.
  if (garments.length) {
    const ofKind = family.filter((product) => garments.some((garment) => identityOf(product).garments.includes(garment)));
    if (ofKind.length === 0) return { kind: 'possible-match', name, products: family.slice(0, 6), reason: 'that name is only on a different kind of garment', resolution };
    family = ofKind;
  }

  // Exactly that design: "Elite Polo" is not the Elite Sleeveless Polo.
  const exactDesign = family.filter((product) => identityOf(product).designWords.length === wanted.length);
  if (exactDesign.length === 0) {
    return { kind: 'possible-match', name, products: family.slice(0, 6), reason: 'the name is part of a longer product name', resolution };
  }
  family = exactDesign;

  // The range they named decides; with none named, the main range is the product people mean.
  if (range) {
    const inRange = family.filter((product) => identityOf(product).range === range);
    if (inRange.length === 0) {
      return { kind: 'possible-match', name, products: family.slice(0, 6), reason: `that design is not in the ${range === 'women' ? 'ladies' : range} range`, resolution };
    }
    family = inRange;
  } else {
    const main = family.filter((product) => identityOf(product).range === 'men');
    if (main.length) family = main;
  }

  // A colour they named is part of the name: "black Apex polo" is never the blush one.
  if (colours.length) {
    const scored = family.map((product) => ({ product, score: colourMatch(product, colours, false) }));
    const best = Math.max(0, ...scored.map((entry) => entry.score));
    if (best < 2) {
      const asked = colours.map((colour) => colour.word).join(' or ');
      const shades = scored.filter((entry) => entry.score === 1).map((entry) => entry.product);
      return {
        kind: 'possible-match',
        name,
        products: (shades.length ? shades : family).slice(0, 6),
        reason: shades.length ? `no colourway is called ${asked} - these are shades of it` : `that design does not come in ${asked}`,
        resolution,
      };
    }
    family = scored.filter((entry) => entry.score === best).map((entry) => entry.product);
  }

  if (family.length === 1) return { kind: 'exact-product', name, product: family[0]!, resolution };
  const designs = new Set(family.map((product) => `${identityOf(product).range}|${identityOf(product).design}`));
  if (designs.size === 1) return { kind: 'exact-family', name, familyName: family[0]!.title.split(' - ')[0]!, products: family, resolution };
  return { kind: 'possible-match', name, products: family.slice(0, 6), reason: 'more than one product has that name', resolution };
}

/** A few of each design, so every close name is represented. */
function pickAcrossDesigns(products: Product[], limit: number): Product[] {
  const byDesign = new Map<string, Product[]>();
  for (const product of products) {
    const key = identityOf(product).design;
    byDesign.set(key, [...(byDesign.get(key) ?? []), product]);
  }
  const queues = [...byDesign.values()];
  const out: Product[] = [];
  while (out.length < limit && queues.some((queue) => queue.length)) {
    for (const queue of queues) {
      const next = queue.shift();
      if (next && out.length < limit) out.push(next);
    }
  }
  return out;
}

/**
 * No design carries every word they used. That is only proof of absence when
 * a word is in no product title and is not close to one - a misspelt "Vapour
 * jacket" or "Galatic midlayer" is a product we do sell. Every word in some
 * title, just never together ("Apex Performance Polo"), is not proof either.
 */
function absent(name: string, wanted: string[], products: Product[], garments: string[]): Existence {
  const { title } = vocabulary(products);
  const unknown = wanted.filter((word) => !title.has(word));
  const nearly = unknown.flatMap((word) => {
    const { strong, weak } = closestWord(word, title);
    return [...strong, ...weak];
  });
  const related = products
    .map((product) => {
      const design = identityOf(product).designWords;
      const hits = wanted.filter((word) => design.includes(word)).length + (nearly.some((word) => design.includes(word)) ? 1 : 0);
      const sameKind = garments.some((garment) => identityOf(product).garments.includes(garment)) ? 1 : 0;
      return { product, hits, sameKind };
    })
    .filter((entry) => entry.hits > 0)
    .sort((a, b) => b.hits - a.hits || b.sameKind - a.sameKind);

  if (unknown.length && nearly.length === 0) {
    // The nearest names, so the Caddie can offer them - never as the thing asked for.
    return { kind: 'not-found', name, closest: related.slice(0, 3).map((entry) => entry.product) };
  }
  return {
    kind: 'possible-match',
    name,
    products: related.slice(0, 6).map((entry) => entry.product),
    reason: nearly.length ? 'a word may be misspelt' : 'no product has all of those words',
  };
}
