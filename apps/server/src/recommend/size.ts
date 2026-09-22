import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SizeInput, SizeRecommendation } from '@caddie/shared';

/**
 * Day 4 - Find My Size.
 *
 * Deterministic and testable on purpose: the AI collects the answers, this
 * function decides the size. Never let the model guess a size itself.
 */

interface SizeRow {
  size: string;
  chestCm?: number[];
  waistCm?: number[];
  heightCm?: number[];
  weightKg?: number[];
}

interface Category {
  label: string;
  sizes: SizeRow[];
}

interface SizeChart {
  defaultCategory: string;
  categories: Record<string, Category>;
}

// Read rather than imported, so swapping in the real Druids chart on Day 4 is
// a file edit and a restart - no rebuild, no code change.
const chartPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../data/size-chart.json');
const chart = JSON.parse(readFileSync(chartPath, 'utf8')) as SizeChart;

const categories = chart.categories;

export function listCategories(): string[] {
  return Object.keys(categories);
}

export function toCm(value: number, unit: 'cm' | 'in' = 'cm'): number {
  return unit === 'in' ? value * 2.54 : value;
}

export function toKg(value: number, unit: 'kg' | 'lb' = 'kg'): number {
  return unit === 'lb' ? value * 0.453_592 : value;
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

const WEIGHTS = { chest: 3, waist: 3, weight: 2, height: 1 } as const;

export function recommendSize(input: SizeInput): SizeRecommendation {
  const categoryKey = input.category ?? chart.defaultCategory;
  const category = categories[categoryKey];

  if (!category) {
    return {
      size: null,
      confidence: 0,
      alternativeSize: null,
      reason: `I do not have a size guide for "${categoryKey}".`,
      missing: ['category'],
    };
  }

  const heightCm =
    input.heightValue !== undefined ? toCm(input.heightValue, input.heightUnit ?? 'cm') : undefined;
  const weightKg =
    input.weightValue !== undefined ? toKg(input.weightValue, input.weightUnit ?? 'kg') : undefined;

  const missing: string[] = [];
  if (input.chestCm === undefined && input.waistCm === undefined) {
    if (heightCm === undefined) missing.push('height');
    if (weightKg === undefined) missing.push('weight');
  }

  // Nothing measurable at all - fall back to what they usually wear, and say so.
  const haveAnyMeasurement =
    input.chestCm !== undefined ||
    input.waistCm !== undefined ||
    heightCm !== undefined ||
    weightKg !== undefined;

  if (!haveAnyMeasurement) {
    if (input.usualSize) {
      const match = category.sizes.find(
        (row) => row.size.toLowerCase() === input.usualSize?.trim().toLowerCase(),
      );
      if (match) {
        return {
          size: match.size,
          confidence: 0.45,
          alternativeSize: neighbour(category.sizes, match.size, input.fitPreference),
          reason: `Going off the ${match.size} you normally wear. Height and weight would let me be surer.`,
          missing: ['height', 'weight'],
        };
      }
    }
    return {
      size: null,
      confidence: 0,
      alternativeSize: null,
      reason: 'I need a little more to go on before I call a size.',
      missing: ['height', 'weight'],
    };
  }

  const scored = category.sizes.map((row) => {
    const parts: Array<{ score: number; weight: number }> = [];

    const push = (score: number | null, weight: number) => {
      if (score !== null) parts.push({ score, weight });
    };

    if (input.chestCm !== undefined) push(rangeScore(input.chestCm, row.chestCm), WEIGHTS.chest);
    if (input.waistCm !== undefined) push(rangeScore(input.waistCm, row.waistCm), WEIGHTS.waist);
    if (weightKg !== undefined) push(rangeScore(weightKg, row.weightKg), WEIGHTS.weight);
    if (heightCm !== undefined) push(rangeScore(heightCm, row.heightCm), WEIGHTS.height);

    const totalWeight = parts.reduce((sum, p) => sum + p.weight, 0);
    const score = totalWeight === 0 ? 0 : parts.reduce((sum, p) => sum + p.score * p.weight, 0) / totalWeight;
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
      reason: 'Those measurements sit outside our size guide. Let me get a human to help.',
      missing,
    };
  }

  const adjusted = applyFit(category.sizes, best.size, input.fitPreference);

  // Confidence drops when the top two sizes are close - that is a genuine borderline.
  const gap = runnerUp ? best.score - runnerUp.score : 0.3;
  const confidence = Math.min(1, Math.max(0.2, best.score * 0.7 + Math.min(gap, 0.3)));

  return {
    size: adjusted,
    confidence: Number(confidence.toFixed(2)),
    alternativeSize: runnerUp && gap < 0.15 ? runnerUp.size : neighbour(category.sizes, adjusted, input.fitPreference),
    reason: buildReason(adjusted, input, heightCm, weightKg, gap),
    missing,
  };
}

function indexOfSize(sizes: SizeRow[], size: string): number {
  return sizes.findIndex((row) => row.size === size);
}

/** Relaxed fit nudges up a size, tight nudges down - within the chart's bounds. */
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
): string {
  const bits: string[] = [];
  if (heightCm !== undefined) bits.push(`${Math.round(heightCm)}cm`);
  if (weightKg !== undefined) bits.push(`${Math.round(weightKg)}kg`);
  if (input.chestCm !== undefined) bits.push(`${Math.round(input.chestCm)}cm chest`);
  if (input.waistCm !== undefined) bits.push(`${Math.round(input.waistCm)}cm waist`);

  const base = bits.length ? `At ${bits.join(', ')}, a ${size} should fit you well.` : `A ${size} should fit you well.`;
  if (input.fitPreference === 'relaxed') return `${base} I have sized up since you like a relaxed fit.`;
  if (input.fitPreference === 'tight') return `${base} I have sized down since you like it closer fitting.`;
  if (gap > 0 && gap < 0.15) return `${base} You are between sizes, so it is worth checking the alternative too.`;
  return base;
}
