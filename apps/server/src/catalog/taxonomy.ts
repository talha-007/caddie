import type { Feature } from './attributes.js';

/**
 * Customer words -> catalogue words.
 *
 * Search matches the words products are listed under, and customers do not
 * talk like a product feed. "A rain top" found nothing called a rain top;
 * "a jumper" found nothing at all, because Druids calls them midlayers. So
 * the phrase is rewritten into the catalogue's own terms, and what it implied
 * - a rain top has to keep the rain out - comes back as a feature the results
 * are then checked against. The search finds candidates; the verified feature
 * decides whether they are what was asked for.
 *
 * Only the phrase itself is replaced. Every other word the customer used
 * stays, so "a plain white rain top" is still plain and still white.
 */

interface Mapping {
  match: RegExp;
  terms: string;
  /** What the phrase requires of the product, checked against its description. */
  features?: Feature[];
}

const MAPPINGS: Mapping[] = [
  { match: /\brain ?(trousers|pants|bottoms|leggings)\b|\bwaterproof (bottoms|pants)\b|\bover ?trousers\b/g, terms: 'trousers', features: ['waterproof'] },
  { match: /\brain ?(top|coat|jacket|shell|gear|wear)\b|\bwaterproofs\b|\bwaterproof (top|coat|shell)\b/g, terms: 'jacket', features: ['waterproof'] },
  { match: /\bwind ?(breaker|cheater|jacket|top|shell)\b/g, terms: 'jacket', features: ['windproof'] },
  { match: /\bwarm (top|layer|jumper|jacket)\b/g, terms: 'midlayer hoodie jacket', features: ['warm'] },
  { match: /\b(jumpers?|sweaters?|pullovers?|sweatshirts?|fleeces?|knitwear|cardigans?)\b/g, terms: 'midlayer hoodie' },
  { match: /\b(quarter|half)[- ]zips?\b|\b1\/4[- ]?zips?\b/g, terms: 'midlayer quarter zip' },
  { match: /\b(body ?warmers?|sleeveless jackets?)\b/g, terms: 'gilet' },
  { match: /\b(golf )?bottoms\b|\bslacks\b/g, terms: 'trousers' },
  // Not t-shirts: those are tees, which the catalogue has under their own name.
  { match: /\bgolf shirts?\b|\bgolf tops?\b/g, terms: 'polo' },
  { match: /\b(hats?|headwear)\b/g, terms: 'cap beanie' },
  { match: /\bskirts?\b/g, terms: 'skort' },
];

export interface NormalisedQuery {
  /** The query in catalogue terms, every other word kept. */
  query: string;
  /** Features the customer's phrasing requires. */
  features: Feature[];
  /** "rain top -> jacket", for the facts, so the model knows what was searched. */
  mapped: string[];
}

export function normaliseQuery(raw: string): NormalisedQuery {
  let query = ` ${raw.toLowerCase()} `;
  const features = new Set<Feature>();
  const mapped: string[] = [];

  for (const mapping of MAPPINGS) {
    query = query.replace(mapping.match, (phrase) => {
      mapped.push(`${phrase.trim()} -> ${mapping.terms}`);
      for (const feature of mapping.features ?? []) features.add(feature);
      return ` ${mapping.terms} `;
    });
  }

  return { query: query.replace(/\s+/g, ' ').trim(), features: [...features], mapped };
}

/** Garment words, for telling a product's name apart from a description of a kind. */
export const GARMENT_WORDS = new Set([
  'polo', 'polos', 'shirt', 'shirts', 'tee', 'tees', 'top', 'tops', 'jacket', 'jackets', 'coat', 'gilet', 'gilets',
  'vest', 'midlayer', 'midlayers', 'mid', 'layer', 'hoodie', 'hoodies', 'jumper', 'sweater', 'trousers', 'trouser',
  'pants', 'joggers', 'jogger', 'chinos', 'shorts', 'short', 'skort', 'skirt', 'socks', 'sock', 'cap', 'caps', 'beanie',
  'hat', 'belt', 'belts', 'bag', 'gloves', 'glove', 'pack', 'bundle', 'rainsuit', 'suit', 'zip', 'quarter', 'half',
  'waterproof', 'waterproofs', 'windproof', 'thermal', 'lightweight', 'golf', 'druids', 'kit', 'outfit', 'clothing',
]);
