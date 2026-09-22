import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Audience, SizeInput, SizeRecommendation } from '@caddie/shared';

/**
 * Day 4 - Find My Size.
 *
 * Deterministic and testable on purpose: the AI collects the answers, this
 * function decides the size. Never let the model guess a size itself.
 *
 * The chart is ported from the Druids try-on size guide - see the notes at the
 * top of data/size-chart.json. Two things it enforces:
 *
 *  - Mens and womens are different systems (S-4XL by chest vs UK 8-18), so the
 *    audience is asked for rather than assumed.
 *  - Chest and waist figures are Druids'. Height and weight are ours, so they
 *    score lower and cap the confidence.
 */

interface SizeRow {
  size: string;
  chestCm?: number[];
  waistCm?: number[];
  hipCm?: number[];
  heightCm?: number[];
  weightKg?: number[];
}

interface Category {
  label: string;
  aliases?: string[];
  measure?: string;
  /** Points at another category that shares this chart, e.g. midlayer -> polo. */
  sameAs?: string;
  /** Set when Druids publishes no table for this, e.g. socks. */
  noChart?: string;
  alsoOffered?: string[];
  sizes?: SizeRow[];
}

interface AudienceChart {
  label: string;
  defaultCategory: string;
  categories: Record<string, Category>;
}

interface SizeChart {
  defaultAudience: Audience;
  audiences: Record<string, AudienceChart>;
}

// Read rather than imported, so updating the chart is a file edit and a
// restart - no rebuild.
const chartPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../data/size-chart.json');
const chart = JSON.parse(readFileSync(chartPath, 'utf8')) as SizeChart;

export function listAudiences(): string[] {
  return Object.keys(chart.audiences);
}

export function listCategories(audience: Audience = chart.defaultAudience): string[] {
  return Object.keys(chart.audiences[audience]?.categories ?? {});
}

export function toCm(value: number, unit: 'cm' | 'in' = 'cm'): number {
  return unit === 'in' ? value * 2.54 : value;
}

export function toKg(value: number, unit: 'kg' | 'lb' = 'kg'): number {
  return unit === 'lb' ? value * 0.453_592 : value;
}

/** Resolves a spoken category ("hoodie", "joggers") to a chart. */
export function resolveCategory(audience: Audience, wanted?: string): { key: string; category: Category } | null {
  const charts = chart.audiences[audience];
  if (!charts) return null;

  const key = wanted?.trim().toLowerCase() ?? charts.defaultCategory;
  const direct = charts.categories[key];
  const byAlias =
    direct ??
    Object.values(charts.categories).find((entry) => entry.aliases?.some((alias) => alias === key));

  if (!byAlias) return null;

  const resolvedKey = direct ? key : Object.keys(charts.categories).find((k) => charts.categories[k] === byAlias)!;

  // midlayer and jacket share the polo chart rather than repeating it.
  if (byAlias.sameAs) {
    const shared = charts.categories[byAlias.sameAs];
    if (shared) {
      return { key: resolvedKey, category: { ...shared, label: byAlias.label, aliases: byAlias.aliases } };
    }
  }
  return { key: resolvedKey, category: byAlias };
}

/** 1 inside the range, decaying to 0 as we move a full range-width outside it. */
function rangeScore(value: number, range: number[] | undefined): number | null {
  if (!range || range.length < 2) return null;
  const [min, max] = [range[0] as number, range[1] as number];
  if (value >= min && value <= max) return 1;
  const width = Math.max(max - min, 1);
  const distance = value < min ? min - value : value - max;
  return Math.max(0, 1 - distance / width);
}

const WEIGHTS = { chest: 6, waist: 6, hip: 3, weight: 2, height: 1 } as const;

/**
 * Height and weight are ours, not Druids'. A size worked out from them alone
 * is an educated guess, so it never claims more than this.
 */
const ESTIMATE_CONFIDENCE_CAP = 0.55;

export function recommendSize(input: SizeInput): SizeRecommendation {
  /*
   * Without knowing mens or womens we cannot answer at all: the two systems do
   * not even share a vocabulary, so a womens 12 answered off the mens chart
   * comes back as an L. Ask rather than assume.
   */
  if (!input.audience) {
    return {
      size: null,
      confidence: 0,
      alternativeSize: null,
      reason: 'Is that for the mens or the womens range? They are sized differently.',
      basis: 'none',
      missing: ['audience'],
    };
  }

  const resolved = resolveCategory(input.audience, input.category);
  if (!resolved) {
    return {
      size: null,
      confidence: 0,
      alternativeSize: null,
      reason: `I do not have a ${input.audience} size guide for "${input.category}".`,
      basis: 'none',
      missing: ['category'],
    };
  }

  const { category } = resolved;

  // Socks have no table - Druids says it varies by style.
  if (category.noChart) {
    return {
      size: null,
      confidence: 0,
      alternativeSize: null,
      reason: category.noChart,
      basis: 'none',
      missing: [],
    };
  }

  const sizes = category.sizes ?? [];
  const heightCm =
    input.heightValue !== undefined ? toCm(input.heightValue, input.heightUnit ?? 'cm') : undefined;
  const weightKg =
    input.weightValue !== undefined ? toKg(input.weightValue, input.weightUnit ?? 'kg') : undefined;

  const wantsWaist = sizes.some((row) => row.waistCm);
  const measured = wantsWaist ? input.waistCm !== undefined : input.chestCm !== undefined;

  const missing: string[] = [];
  if (!measured) {
    if (heightCm === undefined) missing.push('height');
    if (weightKg === undefined) missing.push('weight');
  }

  const haveAnything =
    input.chestCm !== undefined ||
    input.waistCm !== undefined ||
    heightCm !== undefined ||
    weightKg !== undefined;

  // Nothing measurable at all - fall back to what they usually wear, and say so.
  if (!haveAnything) {
    const match = sizes.find((row) => row.size.toLowerCase() === input.usualSize?.trim().toLowerCase());
    if (match) {
      return {
        size: match.size,
        confidence: 0.45,
        alternativeSize: neighbour(sizes, match.size, input.fitPreference),
        reason: `Going off the ${match.size} you normally wear. A ${wantsWaist ? 'waist' : 'chest'} measurement would let me be sure.`,
        basis: 'usual-size',
        missing: [wantsWaist ? 'waist' : 'chest'],
        ...(category.measure ? { measureAdvice: category.measure } : {}),
      };
    }
    return {
      size: null,
      confidence: 0,
      alternativeSize: null,
      reason: 'I need a little more to go on before I call a size.',
      basis: 'none',
      missing: [wantsWaist ? 'waist' : 'chest', 'height', 'weight'],
      ...(category.measure ? { measureAdvice: category.measure } : {}),
    };
  }

  const scored = sizes.map((row) => {
    const parts: Array<{ score: number; weight: number }> = [];
    const push = (score: number | null, weight: number) => {
      if (score !== null) parts.push({ score, weight });
    };

    if (input.chestCm !== undefined) push(rangeScore(input.chestCm, row.chestCm), WEIGHTS.chest);
    if (input.waistCm !== undefined) push(rangeScore(input.waistCm, row.waistCm), WEIGHTS.waist);
    if (weightKg !== undefined) push(rangeScore(weightKg, row.weightKg), WEIGHTS.weight);
    if (heightCm !== undefined) push(rangeScore(heightCm, row.heightCm), WEIGHTS.height);

    const totalWeight = parts.reduce((sum, part) => sum + part.weight, 0);
    const score =
      totalWeight === 0 ? 0 : parts.reduce((sum, part) => sum + part.score * part.weight, 0) / totalWeight;
    return { size: row.size, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const runnerUp = scored[1];

  if (!best || best.score === 0) {
    return {
      size: null,
      confidence: 0,
      alternativeSize: null,
      reason: 'Those measurements sit outside the Druids size guide. Let me get a person to help.',
      basis: 'none',
      missing,
      ...(category.measure ? { measureAdvice: category.measure } : {}),
    };
  }

  const adjusted = applyFit(sizes, best.size, input.fitPreference);

  // Confidence drops when the top two sizes are close - a genuine borderline.
  const gap = runnerUp ? best.score - runnerUp.score : 0.3;
  let confidence = Math.min(1, Math.max(0.2, best.score * 0.7 + Math.min(gap, 0.3)));
  if (!measured) confidence = Math.min(confidence, ESTIMATE_CONFIDENCE_CAP);

  return {
    size: adjusted,
    confidence: Number(confidence.toFixed(2)),
    alternativeSize: runnerUp && gap < 0.15 ? runnerUp.size : neighbour(sizes, adjusted, input.fitPreference),
    reason: buildReason(adjusted, input, heightCm, weightKg, gap, measured),
    basis: measured ? 'measurement' : 'estimate',
    missing,
    ...(category.measure && !measured ? { measureAdvice: category.measure } : {}),
  };
}

function indexOfSize(sizes: SizeRow[], size: string): number {
  return sizes.findIndex((row) => row.size === size);
}

/**
 * Relaxed nudges up a size, tight nudges down.
 *
 * This is the customer's stated preference, not Druids guidance - they publish
 * no rule for sizing up or down, so we do not pretend they do.
 */
function applyFit(sizes: SizeRow[], size: string, fit?: SizeInput['fitPreference']): string {
  if (!fit || fit === 'regular') return size;
  const index = indexOfSize(sizes, size);
  if (index === -1) return size;
  const next = fit === 'relaxed' ? index + 1 : index - 1;
  return sizes[next]?.size ?? size;
}

function neighbour(sizes: SizeRow[], size: string, fit?: SizeInput['fitPreference']): string | null {
  const index = indexOfSize(sizes, size);
  if (index === -1) return null;
  const preferUp = fit !== 'tight';
  return (preferUp ? sizes[index + 1]?.size : sizes[index - 1]?.size) ?? sizes[index - 1]?.size ?? null;
}

function buildReason(
  size: string,
  input: SizeInput,
  heightCm?: number,
  weightKg?: number,
  gap = 0,
  measured = false,
): string {
  const bits: string[] = [];
  if (heightCm !== undefined) bits.push(`${Math.round(heightCm)}cm`);
  if (weightKg !== undefined) bits.push(`${Math.round(weightKg)}kg`);
  if (input.chestCm !== undefined) bits.push(`${Math.round(input.chestCm)}cm chest`);
  if (input.waistCm !== undefined) bits.push(`${Math.round(input.waistCm)}cm waist`);

  // On a real measurement we are reading Druids' chart. Without one we are
  // estimating, and the customer should hear the difference.
  const base = measured
    ? `At ${bits.join(', ')}, the Druids size guide puts you in a ${size}.`
    : bits.length
      ? `At ${bits.join(', ')}, I would put you in a ${size}, though that is my estimate rather than a measurement.`
      : `A ${size} should fit you well.`;

  if (input.fitPreference === 'relaxed') return `${base} I have sized up since you like a relaxed fit.`;
  if (input.fitPreference === 'tight') return `${base} I have sized down since you like it closer fitting.`;
  if (gap > 0 && gap < 0.15) return `${base} You are between sizes, so it is worth checking the alternative too.`;
  return base;
}
