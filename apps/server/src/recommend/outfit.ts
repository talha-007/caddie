import type { Money, OutfitInput, OutfitPiece, OutfitRecommendation, Product } from '@caddie/shared';
import { searchProducts } from '../shopify/catalog.js';
import { storeCurrency } from '../shopify/money.js';

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
  required: boolean;
}

export const DEFAULT_SLOTS: OutfitSlot[] = [
  { slot: 'top', terms: 'jersey shirt tee', required: true },
  { slot: 'bottom', terms: 'shorts trousers', required: true },
  { slot: 'layer', terms: 'hoodie jacket midlayer', required: false },
  { slot: 'accessory', terms: 'socks cap bag', required: false },
];

function withinBudget(products: Product[], remaining: number | null): Product[] {
  if (remaining === null) return products;
  return products.filter((p) => p.price.amount <= remaining);
}

function hasSize(product: Product, size?: string): boolean {
  if (!size) return true;
  if (product.variants.length === 0) return true;
  const needle = size.trim().toLowerCase();
  return product.variants.some(
    (variant) =>
      variant.available && Object.values(variant.options).some((value) => value.toLowerCase() === needle),
  );
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
  let remaining = input.budget ? input.budget.amount : null;

  for (const slot of slots) {
    const query = [input.seed, input.colour, slot.terms].filter(Boolean).join(' ');
    const results = await searchProducts({
      query,
      limit: 8,
      ...(remaining !== null
        ? { maxPrice: remaining, currency: input.budget?.currency ?? storeCurrency() }
        : {}),
    });

    const usable = withinBudget(
      results.filter((p) => p.price.amount > 0 && hasSize(p, input.size)),
      remaining,
    ).sort((a, b) => scoreForColour(b, input.colour) - scoreForColour(a, input.colour));

    const pick = usable[0];
    if (!pick) {
      if (slot.required) continue; // Nothing fits - say so rather than substitute.
      continue;
    }

    pieces.push({ slot: slot.slot, product: pick });
    if (remaining !== null) remaining -= pick.price.amount;
  }

  const total: Money = {
    amount: Number(pieces.reduce((sum, piece) => sum + piece.product.price.amount, 0).toFixed(2)),
    currency: pieces[0]?.product.price.currency ?? input.budget?.currency ?? storeCurrency(),
  };

  return { pieces, total, reason: buildReason(pieces, input) };
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
