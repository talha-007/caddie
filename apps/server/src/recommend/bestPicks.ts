import type { Product } from '@caddie/shared';
import { rangeOf, type Range } from '../catalog/audience.js';
import { bestSellerRank } from '../catalog/bestSellers.js';
import { garmentName } from '../catalog/colourways.js';
import { env } from '../env.js';
import { isPack } from './packs.js';
import { rankProducts, type RankRequest } from './rank.js';
import { normaliseSize, stockedInSize } from './sizeWords.js';

/**
 * The shop's best picks for one customer: its real best sellers, in their
 * range, in stock in their size, across the kinds of thing a golfer wears.
 *
 * Asked "show me your best picks" after telling us they shop mens in an L,
 * the customer should see what actually sells, not six colourways of one
 * polo or a pair of trousers with no L left. So: one garment per name (the
 * colour that sells best), spread across kinds, top sellers first, and
 * nothing out of stock in the size they gave.
 */

export type PickKind = 'polo' | 'bottoms' | 'midlayer' | 'jacket' | 'headwear' | 'belt' | 'socks';

const KINDS: Array<[PickKind, RegExp]> = [
  ['polo', /\bpolos?\b|\btee\b|\bt-?shirt/],
  ['bottoms', /\b(trousers?|joggers?|shorts|skorts?|chinos?|pants)\b/],
  ['midlayer', /\b(midlayers?|mid-layer|hoodies?|quarter zip|1\/4 zip|sweaters?|sweatshirt|pullover|fleece)\b/],
  ['jacket', /\b(jackets?|gilets?|vests?|rain ?suit|waterproof)\b/],
  ['headwear', /\b(caps?|beanies?|hats?|visor|bucket)\b/],
  ['belt', /\bbelts?\b/],
  ['socks', /\bsocks?\b/],
];

/** The kinds best picks cover when nothing is named, in the order they alternate. */
const DEFAULT_ORDER: PickKind[] = ['polo', 'bottoms', 'midlayer', 'jacket'];

export function kindOf(product: Product): PickKind | undefined {
  const text = `${product.productType ?? ''} ${product.title}`.toLowerCase();
  return KINDS.find(([, pattern]) => pattern.test(text))?.[0];
}

/** "trousers and polos" -> ['bottoms', 'polo']. */
export function kindsNamed(text: string): PickKind[] {
  const lower = text.toLowerCase();
  return KINDS.filter(([, pattern]) => pattern.test(lower)).map(([kind]) => kind);
}

function sizedOnScale(product: Product, size: string): boolean {
  const numeric = /^\d+$/.test(normaliseSize(size) ?? size);
  const values = product.options.find((option) => /size/i.test(option.name))?.values ?? [];
  return values.some((value) => /^\d+$/.test(normaliseSize(value) ?? value) === numeric);
}

export interface PickOptions {
  range: Range;
  size?: string;
  waist?: string;
  kinds?: PickKind[];
  limit?: number;
  /** Everything else we know, for ordering within a kind (colour, weather, budget). */
  rank?: RankRequest;
}

export function bestPicks(catalogue: Product[], options: PickOptions): Product[] {
  const limit = options.limit ?? 6;
  const brandTag = env.shopify.brandTag?.toLowerCase();
  const kinds = options.kinds?.length ? options.kinds : DEFAULT_ORDER;
  const unranked = Number.MAX_SAFE_INTEGER;

  const byKind = new Map<PickKind, Product[]>();
  for (const product of catalogue) {
    if (brandTag && !product.tags.some((tag) => tag.toLowerCase() === brandTag)) continue;
    if (isPack(product) || rangeOf(product) !== options.range) continue;
    if (!product.variants.some((variant) => variant.available)) continue;
    const kind = kindOf(product);
    if (!kind || !kinds.includes(kind)) continue;
    // In stock in their size - whichever of their sizes this product is sized in.
    const size = [options.size, options.waist].find((candidate) => candidate && sizedOnScale(product, candidate));
    if (size && !stockedInSize(product.variants, size)) continue;
    const list = byKind.get(kind) ?? [];
    list.push(product);
    byKind.set(kind, list);
  }

  // Within a kind: what fits everything they told us first, then what sells.
  const ordered = new Map<PickKind, Product[]>();
  for (const [kind, products] of byKind) {
    const sellers = [...products].sort((a, b) => (bestSellerRank(a.id) ?? unranked) - (bestSellerRank(b.id) ?? unranked));
    const ranked = options.rank ? rankProducts(sellers, options.rank).filter((entry) => entry.matchLevel !== 'partial').map((entry) => entry.product) : sellers;
    // One colourway per garment: the best-selling one.
    const seen = new Set<string>();
    ordered.set(
      kind,
      ranked.filter((product) => {
        const name = garmentName(product.title);
        if (seen.has(name)) return false;
        seen.add(name);
        return true;
      }),
    );
  }

  // Take turns across kinds, so a screen of six is not six polos.
  const out: Product[] = [];
  const queues = kinds.map((kind) => [...(ordered.get(kind) ?? [])]);
  while (out.length < limit && queues.some((queue) => queue.length)) {
    for (const queue of queues) {
      const next = queue.shift();
      if (next && out.length < limit) out.push(next);
    }
  }
  return out;
}
