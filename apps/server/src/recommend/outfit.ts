import type { Money, OutfitInput, OutfitPiece, OutfitRecommendation, Product } from '@caddie/shared';
import { searchProducts } from '../shopify/catalog.js';
import { storeCurrency } from '../shopify/money.js';
import { isPack } from './packs.js';
import { priceFor } from './pricing.js';
import { stockedInSize } from './sizeWords.js';

/**
 * Day 6 - Outfit builder.
 *
 * An outfit is one product per slot. We search each slot separately so the
 * customer never ends up with three tops, and so "change the colour" only has
 * to re-run one slot.
 */

export interface OutfitSlot {
  slot: string;
  /** Search terms that tend to surface this slot in the Druids catalogue. */
  terms: string;
  /**
   * Words that prove a product really belongs in this slot.
   *
   * The catalogue search is semantic, so a search for "shorts trousers navy"
   * happily returns a navy polo as its top hit. Without this check the outfit
   * ends up wearing the same polo as both its top and its bottom.
   */
  keywords: string[];
  required: boolean;
}

/**
 * Terms are matched against the Druids range as it is actually stocked:
 * POLOS, MIDLAYERS, GOLF HOODIES, GILETS, JACKETS, SHORTS, TROUSERS,
 * HEADWEAR, SOCKS. Re-check these when the real store replaces the test one.
 */
export const DEFAULT_SLOTS: OutfitSlot[] = [
  { slot: 'top', terms: 'polo shirt tee', keywords: ['polo', 'shirt', 'tee', 't-shirt'], required: true },
  {
    slot: 'bottom',
    terms: 'shorts trousers',
    keywords: ['short', 'trouser', 'pant', 'jogger', 'chino'],
    required: true,
  },
  {
    slot: 'layer',
    terms: 'midlayer hoodie gilet jacket',
    keywords: ['midlayer', 'mid layer', 'hoodie', 'gilet', 'jacket', 'vest', 'sweat'],
    required: false,
  },
  {
    slot: 'accessory',
    terms: 'socks beanie cap',
    keywords: ['sock', 'beanie', 'cap', 'hat', 'glove', 'bag', 'belt'],
    required: false,
  },
];

/** True when the product's name or tags say it belongs in this slot. */
export function fitsSlot(product: Product, slot: OutfitSlot): boolean {
  const haystack = [product.title, ...product.tags].join(' ').toLowerCase();
  return slot.keywords.some((keyword) => haystack.includes(keyword));
}

/**
 * What is still affordable, at the size the customer is buying.
 *
 * `product.price` is Shopify's cheapest variant. Filtering on it let a
 * garment into the outfit that the customer could not afford once their
 * actual size was priced, and the total under-read to match.
 */
function withinBudget(products: Product[], remaining: number | null, size?: string): Product[] {
  if (remaining === null) return products;
  return products.filter((p) => priceFor(p, size).amount <= remaining);
}

function hasSize(product: Product, size?: string): boolean {
  return stockedInSize(product.variants, size);
}

function scoreForColour(product: Product, colour?: string): number {
  if (!colour) return 0;
  const needle = colour.toLowerCase();
  const text = [product.title, ...product.tags].join(' ').toLowerCase();
  return text.includes(needle) ? 1 : 0;
}

export async function recommendOutfit(
  input: OutfitInput,
  slots: OutfitSlot[] = DEFAULT_SLOTS,
): Promise<OutfitRecommendation> {
  const pieces: OutfitPiece[] = [];
  const used = new Set<string>();
  let remaining = input.budget ? input.budget.amount : null;

  for (const slot of slots) {
    /*
     * Garment first, occasion second.
     *
     * Searching "match day navy shorts trousers" returns a polo, a gilet and a
     * jacket - the occasion words swamp the garment. "navy shorts" returns the
     * shorts. So we lead with colour and garment, and only fall back to the
     * customer's own phrasing if that finds nothing.
     */
    const queries = [
      [input.colour, slot.terms].filter(Boolean).join(' '),
      [input.seed, input.colour, slot.terms].filter(Boolean).join(' '),
    ];

    let pick: Product | undefined;

    for (const query of queries) {
      const results = await searchProducts({
        query,
        limit: 8,
        ...(remaining !== null
          ? { maxPrice: remaining, currency: input.budget?.currency ?? storeCurrency() }
          : {}),
      });

      const usable = withinBudget(
        results.filter(
          (p) =>
            p.price.amount > 0 &&
            // Nobody wears the Ambassador Pack as a top.
            !isPack(p) &&
            hasSize(p, input.size) &&
            // A polo is not a pair of shorts, whatever the search thinks.
            fitsSlot(p, slot) &&
            // And nothing gets worn twice.
            !used.has(p.id),
        ),
        remaining,
        input.size,
      ).sort((a, b) => scoreForColour(b, input.colour) - scoreForColour(a, input.colour));

      pick = usable[0];
      if (pick) break;
    }

    // Nothing genuinely belongs in this slot - leave it empty and say so
    // rather than padding the outfit with something that does not fit.
    if (!pick) continue;

    pieces.push({ slot: slot.slot, product: pick });
    used.add(pick.id);
    if (remaining !== null) remaining -= priceFor(pick, input.size).amount;
  }

  const priced = pieces.map((piece) => priceFor(piece.product, input.size));
  const total: Money = {
    amount: Number(priced.reduce((sum, price) => sum + price.amount, 0).toFixed(2)),
    currency: priced[0]?.currency ?? input.budget?.currency ?? storeCurrency(),
  };
  const exact = priced.every((price) => price.exact);

  const reason = buildReason(pieces, input);
  return {
    pieces,
    total,
    // A total added up from "from" prices is not a total, and saying so costs
    // less than a customer discovering it at checkout.
    reason: exact ? reason : `${reason} That is a starting price - the final one depends on the sizes chosen.`,
  };
}

function buildReason(pieces: OutfitPiece[], input: OutfitInput): string {
  if (pieces.length === 0) {
    return `I could not put an outfit together for "${input.seed}" with what is in stock right now.`;
  }
  const bits = [`Built around ${input.seed}`];
  if (input.colour) bits.push(`leaning ${input.colour}`);
  if (input.budget) bits.push(`kept under ${input.budget.amount} ${input.budget.currency}`);
  const missingRequired = DEFAULT_SLOTS.filter(
    (slot) => slot.required && !pieces.some((piece) => piece.slot === slot.slot),
  );
  let reason = `${bits.join(', ')}.`;
  if (missingRequired.length) {
    reason += ` I could not find a ${missingRequired.map((s) => s.slot).join(' or ')} that fits the brief.`;
  }
  return reason;
}
