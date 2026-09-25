import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Audience, SizeInput, SizeRecommendation } from '@caddie/shared';
import type { ProductFit } from '../catalog/attributes.js';
import { sameSize } from './sizeWords.js';

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

/**
 * Which chart a product is sized on, from its own type and name.
 *
 * "What size am I in this" asked about a pair of trousers used to be answered
 * off the polo chart, because nobody passed a category. The product says what
 * it is. Checked most specific first: a "SKORT" is not shorts, a "GILET" is
 * sized as a jacket.
 */
export function categoryForProduct(audience: Audience, text: string): string | undefined {
  const charts = chart.audiences[audience];
  if (!charts) return undefined;
  const words = text.toLowerCase().replace(/[^a-z\s-]/g, ' ');
  const order = ['skort', 'socks', 'belt', 'shorts', 'trousers', 'jacket', 'midlayer', 'polo'];
  for (const key of order) {
    const category = charts.categories[key];
    if (!category) continue;
    const names = [key, ...(category.aliases ?? [])];
    if (names.some((name) => new RegExp(`\\b${name}s?\\b`).test(words))) return key;
  }
  // Druids' own names for layers and bottoms that carry no chart word.
  if (/\b(gilet|hoodie|quarter zip|sweater|jumper|fleece)\b/.test(words)) return charts.categories.midlayer ? 'midlayer' : undefined;
  if (/\b(jogger|chino|pant)s?\b/.test(words)) return 'trousers';
  return undefined;
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

/**
 * What a human actually measures, in centimetres and kilos.
 *
 * Anything outside this is a mistake rather than a measurement, and the
 * mistake is nearly always inches typed as centimetres - a customer who says
 * "36 centimetres" means 36 inches. Taken literally, a 36cm chest scores zero
 * against a chart that starts at 88, so it is quietly ignored and the answer
 * comes from height alone - while still claiming the size guide backs it.
 */
const PLAUSIBLE: Record<string, [number, number]> = {
  chestCm: [60, 200],
  waistCm: [50, 200],
  heightCm: [120, 220],
  weightKg: [30, 250],
};

/** An inches figure, read as centimetres, lands in this range. */
function looksLikeInches(value: number, field: 'chestCm' | 'waistCm'): boolean {
  const asCm = value * 2.54;
  const [min, max] = PLAUSIBLE[field]!;
  return asCm >= min && asCm <= max;
}

function implausible(input: SizeInput, heightCm?: number, weightKg?: number): SizeRecommendation | null {
  const checks: Array<[string, number | undefined, string]> = [
    ['chestCm', input.chestCm, 'chest'],
    ['waistCm', input.waistCm, 'waist'],
    ['heightCm', heightCm, 'height'],
    ['weightKg', weightKg, 'weight'],
  ];

  for (const [key, value, label] of checks) {
    if (value === undefined) continue;
    const [min, max] = PLAUSIBLE[key]!;
    if (value >= min && value <= max) continue;

    // Offer the likely reading rather than just refusing.
    const unit = key === 'weightKg' ? 'kg' : 'cm';
    const inches =
      (key === 'chestCm' || key === 'waistCm') && looksLikeInches(value, key)
        ? ` Did you mean ${Math.round(value)} inches? That is about ${Math.round(value * 2.54)}cm.`
        : '';

    return {
      size: null,
      confidence: 0,
      alternativeSize: null,
      reason: `${Math.round(value)}${unit} is not a ${label} I can work from.${inches}`,
      basis: 'none',
      missing: [label],
    };
  }

  return null;
}

/**
 * What the size is for, beyond the body.
 *
 * The chart says which size a chest falls in. Whether that is the one to buy
 * also depends on the garment - an athletic cut sits closer than a relaxed
 * one - and on the customer: room to layer, or a loose fit. Those only move
 * the answer when the measurement is near the top of its band, where the next
 * size up is a genuine alternative rather than a guess; otherwise they become
 * the alternative, said with its reason.
 */
export interface FitContext {
  /** Wants to wear something underneath. */
  layering?: boolean;
  /** The garment's cut, as its own description states it. */
  productFit?: ProductFit;
  /** For the reason: "the Orient Polo is an athletic cut". */
  productTitle?: string;
}

export function recommendSize(input: SizeInput, context: FitContext = {}): SizeRecommendation {
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

  // A number that cannot be a measurement is a mistake worth naming, not
  // something to quietly drop and answer around.
  const nonsense = implausible(input, heightCm, weightKg);
  if (nonsense) return nonsense;

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
    const match = sizes.find((row) => input.usualSize && sameSize(row.size, input.usualSize));
    if (match) {
      return {
        size: match.size,
        confidence: 0.45,
        confidenceLevel: 'estimate',
        alternativeSize: neighbour(sizes, match.size, input.fitPreference),
        alternativeReason: `A ${wantsWaist ? 'waist' : 'chest'} measurement would settle which of the two.`,
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

  // Confidence drops when the top two sizes are close - a genuine borderline.
  const gap = runnerUp ? best.score - runnerUp.score : 0.3;
  let confidence = Math.min(1, Math.max(0.2, best.score * 0.7 + Math.min(gap, 0.3)));
  if (!measured) confidence = Math.min(confidence, ESTIMATE_CONFIDENCE_CAP);

  /*
   * Where in its band the measurement sits: 0 at the bottom, 1 at the top.
   * Only a real measurement has a position - height and weight are too loose
   * to say whether someone is at the top of an M.
   */
  const bandRow = sizes.find((row) => row.size === best.size);
  const measure = wantsWaist ? input.waistCm : input.chestCm;
  const band = wantsWaist ? bandRow?.waistCm : bandRow?.chestCm;
  const position =
    measured && measure !== undefined && band && band.length >= 2
      ? Math.min(1, Math.max(0, (measure - band[0]!) / Math.max(band[1]! - band[0]!, 1)))
      : undefined;
  const between = (runnerUp && gap < 0.15) || (position !== undefined && (position <= 0.1 || position >= 0.9));

  const call = fitCall(sizes, best.size, input.fitPreference, context, position, wantsWaist);
  const alternative =
    call.alternative ?? (runnerUp && gap < 0.15 ? runnerUp.size : neighbour(sizes, call.size, input.fitPreference));
  const confidenceLevel: SizeRecommendation['confidenceLevel'] = !measured ? 'estimate' : between ? 'medium' : 'high';

  return {
    size: call.size,
    confidence: Number(confidence.toFixed(2)),
    confidenceLevel,
    alternativeSize: alternative,
    ...(alternative
      ? {
          alternativeReason:
            call.alternativeReason ??
            (between
              ? `You are on the line between the two, so the ${alternative} is a real option - ${
                  sizes.findIndex((row) => row.size === alternative) > sizes.findIndex((row) => row.size === call.size)
                    ? 'choose it if you like a little more room'
                    : 'choose it if you like a closer fit'
                }.`
              : `Only if you want it ${
                  sizes.findIndex((row) => row.size === alternative) > sizes.findIndex((row) => row.size === call.size)
                    ? 'looser, or to layer underneath'
                    : 'closer fitting'
                }.`),
        }
      : {}),
    reason: buildReason(best.size, input, heightCm, weightKg, gap, measured, call.note),
    basis: measured ? 'measurement' : 'estimate',
    missing,
    ...(category.measure && !measured ? { measureAdvice: category.measure } : {}),
  };
}

interface FitCall {
  size: string;
  alternative?: string;
  alternativeReason?: string;
  /** Said after the chart reading, when the call moved or qualified it. */
  note?: string;
}

/**
 * The chart's size, adjusted for how it should fit.
 *
 * A loose fit, room to layer, or a close-cut garment pushes towards the next
 * size up - but only when the measurement is in the top half of its band, so
 * the bigger size still fits them. Lower in the band the chart's size already
 * has that room, and the bigger one is offered as the alternative with its
 * reason. Druids publishes no rule for sizing up or down, so every one of
 * these is said as advice, never as the brand's guidance.
 */
function fitCall(
  sizes: SizeRow[],
  size: string,
  fit: SizeInput['fitPreference'],
  context: FitContext,
  position: number | undefined,
  wantsWaist: boolean,
): FitCall {
  const index = indexOfSize(sizes, size);
  const up = sizes[index + 1]?.size;
  const down = sizes[index - 1]?.size;
  const cut = context.productFit;
  const closeCut = cut === 'athletic' || cut === 'slim' || cut === 'tailored';
  const named = context.productTitle ? `the ${titleCase(context.productTitle)}` : 'this one';
  // Unknown position (an estimate): honour a stated preference outright, as before.
  const upperHalf = position === undefined || position >= 0.5;
  const lowerHalf = position === undefined || position <= 0.5;

  if (fit === 'tight') {
    if (!down) return { size };
    return lowerHalf
      ? { size: down, alternative: size, alternativeReason: `The ${size} if you would rather not have it quite so close.`, note: `I would go down to the ${down}, since you like it closer fitting.` }
      : { size, alternative: down, alternativeReason: `The ${down} if you want it properly close - you are near the top of the ${size}, so it will be snug.` };
  }

  const wantsRoom = fit === 'relaxed' || (context.layering && !wantsWaist);
  const why = fit === 'relaxed' ? 'you like a relaxed fit' : 'you want room to layer underneath';

  if (wantsRoom) {
    // A relaxed garment already gives the room; sizing it up as well overshoots.
    if (cut === 'relaxed') {
      return { size, alternative: up, alternativeReason: up ? `The ${up} only if you want it really roomy - ${named} is already a relaxed cut.` : undefined, note: `${capitalise(named)} is already a relaxed cut, so that size gives you the room.` };
    }
    if (!up) return { size };
    return upperHalf
      ? { size: up, alternative: size, alternativeReason: `The ${size} if you would rather it sat closer.`, note: `I would go up to the ${up}, since ${why}${closeCut ? ` and ${named} is ${articled(cut!)} cut` : ''}.` }
      : { size, alternative: up, alternativeReason: `The ${up} if you want it properly loose or plan to layer underneath - the ${size} already has some room at your measurement.` };
  }

  // No preference stated, but the garment itself runs close.
  if (closeCut && !wantsWaist && up && position !== undefined && position >= 0.75) {
    return {
      size,
      alternative: up,
      alternativeReason: `${capitalise(named)} is ${articled(cut!)} cut and you are near the top of the ${size}, so the ${up} if you like any room at all.`,
    };
  }
  return { size };
}

function titleCase(title: string): string {
  return title
    .split(' - ')[0]!
    .toLowerCase()
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function articled(cut: string): string {
  return /^[aeiou]/.test(cut) ? `an ${cut}` : `a ${cut}`;
}

function indexOfSize(sizes: SizeRow[], size: string): number {
  return sizes.findIndex((row) => row.size === size);
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
  note?: string,
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

  if (note) return `${base} ${note}`;
  if (gap > 0 && gap < 0.15) return `${base} You are between sizes, so it is worth checking the alternative too.`;
  return base;
}
