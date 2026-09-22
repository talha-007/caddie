import type { Money, Product } from './product.js';

export type Journey = 'size' | 'pack' | 'outfit';

/* ---------------- Size ---------------- */

export type HeightUnit = 'cm' | 'in';
export type WeightUnit = 'kg' | 'lb';
export type Fit = 'tight' | 'regular' | 'relaxed';

export interface SizeInput {
  heightValue?: number;
  heightUnit?: HeightUnit;
  weightValue?: number;
  weightUnit?: WeightUnit;
  /** What the customer normally wears, e.g. "M" or "L". */
  usualSize?: string;
  chestCm?: number;
  waistCm?: number;
  fitPreference?: Fit;
  /** Which Druids size chart to use, e.g. 'mens-top'. */
  category?: string;
}

/**
 * What the recommendation was actually worked out from.
 *
 * `measurement` uses Druids' own published chart. `estimate` infers a chest or
 * waist from height and weight, which Druids publishes no mapping for - it is
 * our inference and the UI should say so rather than imply the brand said it.
 */
export type SizeBasis = 'measurement' | 'estimate' | 'usual-size' | 'none';

export interface SizeRecommendation {
  /** null when we do not have enough information to be honest about a size. */
  size: string | null;
  /** 0-1. Below 0.5 the Caddie should ask one more question instead of committing. */
  confidence: number;
  alternativeSize: string | null;
  reason: string;
  basis: SizeBasis;
  /** Questions the Caddie still needs answered. Empty when we are confident. */
  missing: string[];
  /** Druids' own instructions for taking the measurement that would settle it. */
  measureAdvice?: string;
}

/* ---------------- Pack ---------------- */

export interface PackInput {
  query: string;
  budget?: Money;
  colour?: string;
  size?: string;
  itemCount?: number;
}

export interface PackRecommendation {
  items: Product[];
  total: Money;
  /** True when we could not fill the pack inside budget. */
  overBudget: boolean;
  reason: string;
}

/* ---------------- Outfit ---------------- */

export interface OutfitInput {
  /** A seed item ("the navy jersey") or an occasion ("a wedding"). */
  seed: string;
  budget?: Money;
  colour?: string;
  size?: string;
}

export interface OutfitPiece {
  /** top | bottom | layer | accessory */
  slot: string;
  product: Product;
}

export interface OutfitRecommendation {
  pieces: OutfitPiece[];
  total: Money;
  reason: string;
}
