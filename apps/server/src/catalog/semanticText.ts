import { createHash } from 'node:crypto';
import type { Product } from '@caddie/shared';
import { readIntent } from '../shopper/profile.js';
import { FEATURE_LABEL, WEATHER_NEEDS, attributesOf, type Feature } from './attributes.js';
import { CATEGORY_CONCEPTS, conceptsInQuery, conceptsOf } from './concepts.js';
import { categoriesAsked, categoriesOf } from './constraints.js';
import { identityOf } from './identity.js';
import { normaliseQuery } from './taxonomy.js';

/**
 * The words a product is embedded from: what it is, as the catalogue states
 * it, and nothing else.
 *
 * In order: the design, what kind of garment it is and what that kind is
 * called, its range, then only what its description verifiably states
 * (features, fit), then the opening of the description itself.
 *
 * Left out, and why:
 * - Colour. It is a hard rule elsewhere (catalog/colour.ts), and "exotic
 *   lime" pulled a dress and a midlayer to the top of "hot weather golf".
 *   The design name is used rather than the full title, which ends in it.
 * - Tags. Campaign and operations labels - "40 off", "sendlane-all",
 *   "size-xl", a "blue" on a navy polo.
 * - Care and delivery sentences, and most of the marketing prose. The
 *   descriptions run to 1,300 characters on average, mostly adjectives; at
 *   full length they drowned out what the product is - a gilet's copy about
 *   "the hottest days" made it a hot-weather garment. The first few hundred
 *   characters carry the substance; the verified features carry the rest.
 */

const RANGE_WORD = { men: 'mens', women: 'ladies', kids: 'kids' } as const;
const DESCRIPTION_LIMIT = 400;

/** Sentences about looking after it or getting it delivered, not what it is. */
const NOT_ABOUT_THE_GARMENT =
  /\b(wash|washing|washable|machine wash|tumble|iron(ing)?|bleach|dry clean|care instructions?|delivery|deliver(ed)?|shipping|returns?|refund|size guide|sizing chart)\b/i;

/**
 * The opening of the description, without care and delivery sentences, cut
 * at a sentence end. A description written without full stops is cut at the
 * limit rather than guessed at.
 */
export function usefulDescription(description: string | null, limit = DESCRIPTION_LIMIT): string {
  if (!description) return '';
  const sentences = description
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence && !NOT_ABOUT_THE_GARMENT.test(sentence));
  let out = '';
  for (const sentence of sentences) {
    if (out && out.length + sentence.length + 1 > limit) break;
    out = out ? `${out} ${sentence}` : sentence;
  }
  return out.slice(0, limit).trim();
}

function titleCase(text: string): string {
  return text.toLowerCase().replace(/(^|[\s-])([a-z])/g, (_, gap: string, letter: string) => gap + letter.toUpperCase());
}

export function buildProductSemanticText(product: Product): string {
  const identity = identityOf(product);
  const categories = categoriesOf(product);
  const { features, fit } = attributesOf(product);
  const concepts = conceptsOf(product, categories);
  const lines = [
    `Product: ${titleCase(identity.design)}`,
    `Category: ${[...categories].join(', ') || (product.productType ?? '').toLowerCase()}`,
    concepts.length ? `Also called: ${concepts.join('; ')}` : '',
    `Range: ${RANGE_WORD[identity.range]}`,
    features.length ? `Features: ${features.map((feature) => FEATURE_LABEL[feature]).join(', ')}` : '',
    fit ? `Fit: ${fit}` : '',
  ].filter(Boolean);
  const description = usefulDescription(product.description);
  return description ? `${lines.join('\n')}\n\n${description}` : lines.join('\n');
}

/**
 * The same text, as a short hash. A product whose semantic text has not
 * changed - a price, a stock level, a tag, now a colour - keeps its vector.
 */
export function semanticFingerprint(product: Product): string {
  return createHash('sha1').update(buildProductSemanticText(product)).digest('hex');
}

/**
 * A customer's words, with the catalogue's words for what they mean added -
 * never replaced. Everything added comes from logic the rest of the Caddie
 * already uses: the shop-floor taxonomy ("body warmer" is a gilet), the
 * garment concepts above ("sleeveless" is a gilet), and the weather the
 * profile reader hears ("hot weather" wants the features that suit heat).
 * No model writes any of it.
 */
export function semanticQueryText(query: string): string {
  const said = query.replace(/\s+/g, ' ').trim();
  const { features: implied } = normaliseQuery(said);
  const concepts = new Set<string>([
    ...categoriesAsked(said).map((category) => CATEGORY_CONCEPTS[category]),
    ...conceptsInQuery(said),
  ]);
  const weather = readIntent(said).weather ?? [];
  const suited = new Set<Feature>([...implied, ...weather.flatMap((kind) => WEATHER_NEEDS[kind])]);
  const parts = [said];
  if (concepts.size) parts.push(`Catalogue concepts: ${[...concepts].join('; ')}`);
  if (suited.size) parts.push(`Suited features: ${[...suited].map((feature) => FEATURE_LABEL[feature]).join(', ')}`);
  return parts.join('. ');
}

/** The cache key for a query: its semantic text, case and spacing aside. */
export function semanticQueryKey(query: string): string {
  return semanticQueryText(query).toLowerCase();
}
