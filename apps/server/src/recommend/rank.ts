import type { Product } from '@caddie/shared';
import { FEATURE_LABEL, WEATHER_NEEDS, attributesOf, hasFeature, type Feature, type Weather } from '../catalog/attributes.js';
import { rangeOf, type Range } from '../catalog/audience.js';
import { colourwayName } from '../catalog/colourways.js';
import { matchesColourText } from '../catalog/colour.js';
import type { Budget } from '../shopper/profile.js';
import { priceFor } from './pricing.js';
import { normaliseSize, stockedInSize } from './sizeWords.js';

/**
 * Choosing among what search found.
 *
 * Search finds candidates by the words used. Which of them to put first is a
 * different question - the one a good salesperson answers - and it was being
 * left to the model, which ranked on nothing it could check: "this one is
 * perfect for the rain" about a polo whose description never mentions rain.
 *
 * So the order is decided here, from verified data only: the product's own
 * range, colour, stock in the customer's size, price at that size, and the
 * features its description states (catalog/attributes.ts). Every reason a
 * product is ranked up is one the customer could check on the product page.
 *
 * The match level is what may be claimed about it:
 *   exact    every requirement met, and every stated preference too
 *   strong   every requirement met, a preference missed - say which
 *   partial  a requirement cannot be met - never presented as what they asked for
 */

export type MatchLevel = 'exact' | 'strong' | 'partial';

export interface RankRequest {
  range?: Range;
  colours?: { words: string[]; strength: 'required' | 'preferred' };
  avoidColours?: string[];
  features?: { required: Feature[]; preferred: Feature[] };
  weather?: Weather[];
  budget?: Budget;
  /** The size they are buying in, when known. */
  size?: string;
  /** Their waist size, for anything sized by the waist. */
  waist?: string;
  fit?: 'tight' | 'regular' | 'relaxed';
  rejected?: string[];
  currency?: string;
}

export interface Ranked {
  product: Product;
  matchLevel: MatchLevel;
  matchedRequirements: string[];
  missedPreferences: string[];
  /** Requirements this product fails. Empty unless the level is partial. */
  missedRequirements: string[];
  /** One short clause, from verified facts: "navy, within your £50 budget and in stock in XL". */
  reason: string;
  /** Internal only - never shown or spoken. */
  score: number;
}

const SYMBOL: Record<string, string> = { GBP: '£', USD: '$', EUR: '€' };

function money(amount: number, currency: string): string {
  const symbol = SYMBOL[currency];
  const shown = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  return symbol ? `${symbol}${shown}` : `${currency} ${shown}`;
}

/** Whether a size means anything for this product - a waist is no help on a polo. */
function sizedOnSameScale(product: Product, size: string): boolean {
  const wanted = normaliseSize(size) ?? size;
  const numeric = /^\d+$/.test(wanted);
  const sizes = product.options.find((option) => /size/i.test(option.name))?.values ?? [];
  if (sizes.length === 0) return false;
  return sizes.some((value) => /^\d+$/.test(normaliseSize(value) ?? value) === numeric);
}

export function rankProducts(products: Product[], request: RankRequest): Ranked[] {
  const currency = request.currency ?? products[0]?.price.currency ?? 'GBP';
  const weatherNeeds = new Set((request.weather ?? []).flatMap((kind) => WEATHER_NEEDS[kind]));

  const ranked = products.map((product, position): Ranked => {
    const matched: string[] = [];
    const missedPrefs: string[] = [];
    const missedReqs: string[] = [];
    const reasons: string[] = [];
    // Search order carries relevance; everything below adjusts it.
    let score = -position * 0.5;

    if (request.rejected?.some((id) => id === product.id)) {
      missedReqs.push('turned down earlier');
      score -= 100;
    }

    if (request.range && rangeOf(product) !== request.range) {
      missedReqs.push(`${request.range === 'women' ? 'ladies' : request.range === 'men' ? 'mens' : 'kids'} range`);
      score -= 50;
    }

    const colourName = colourwayName(product.title).toLowerCase();
    if (request.colours?.words.length) {
      const wanted = request.colours.words.join(' or ');
      const hit = matchesColourText(product, wanted) > 0;
      if (hit) {
        matched.push(wanted);
        reasons.push(colourName || wanted);
        score += request.colours.strength === 'required' ? 10 : 6;
      } else if (request.colours.strength === 'required') {
        missedReqs.push(`in ${wanted}`);
        score -= 40;
      } else {
        missedPrefs.push(`not ${wanted}${colourName ? ` (it is ${colourName})` : ''}`);
      }
    }
    for (const avoid of request.avoidColours ?? []) {
      if (matchesColourText(product, avoid) > 0) {
        missedReqs.push(`not ${avoid}`);
        score -= 40;
      }
    }

    for (const feature of request.features?.required ?? []) {
      if (hasFeature(product, feature)) {
        matched.push(FEATURE_LABEL[feature]);
        reasons.push(FEATURE_LABEL[feature]);
        score += 8;
      } else {
        // Not "not waterproof" - the description just does not say it is.
        missedReqs.push(`${FEATURE_LABEL[feature]} is not confirmed in its description`);
        score -= 30;
      }
    }
    for (const feature of request.features?.preferred ?? []) {
      if (hasFeature(product, feature)) {
        matched.push(FEATURE_LABEL[feature]);
        reasons.push(FEATURE_LABEL[feature]);
        score += 4;
      } else {
        missedPrefs.push(`${FEATURE_LABEL[feature]} not confirmed`);
      }
    }
    // Weather is a need, not a spec: any one suitable feature will do.
    if (weatherNeeds.size) {
      const suits = [...weatherNeeds].filter((feature) => hasFeature(product, feature));
      if (suits.length) {
        const label = suits.slice(0, 2).map((feature) => FEATURE_LABEL[feature]);
        for (const word of label) if (!reasons.includes(word)) reasons.push(word);
        score += 3 + suits.length;
      }
    }

    // Their top size for tops, their waist for trousers - whichever this product is sized in.
    const size = [request.size, request.waist].find((candidate) => candidate && sizedOnSameScale(product, candidate));
    if (size) {
      if (stockedInSize(product.variants, size)) {
        matched.push(`${normaliseSize(size) ?? size} in stock`);
        reasons.push(`${normaliseSize(size) ?? size} is in stock`);
        score += 5;
      } else {
        missedReqs.push(`not in stock in ${normaliseSize(size) ?? size}`);
        score -= 25;
      }
    }

    if (request.budget) {
      const price = priceFor(product, size).amount;
      const { amount, kind, per } = request.budget;
      // A total budget is not a ceiling on one garment, only a guide.
      if (per === 'item' || kind === 'max') {
        const shown = money(amount, currency);
        if (kind === 'max') {
          if (price <= amount) {
            matched.push(`within ${shown}`);
            if (per === 'item') reasons.push(`within your ${shown} budget`);
            score += 3;
          } else {
            missedReqs.push(`over your ${shown} limit`);
            score -= 60;
          }
        } else if (kind === 'around') {
          const off = Math.abs(price - amount) / amount;
          if (off <= 0.2) {
            matched.push(`around ${shown}`);
            reasons.push(`close to your ${shown} budget`);
            score += 3 - off * 5;
          } else {
            missedPrefs.push(`${price > amount ? 'above' : 'well below'} ${shown}`);
            score -= off * 5;
          }
        } else if (price <= amount) {
          matched.push(`under ${shown}`);
          reasons.push(`under ${shown}`);
          score += 3;
        } else {
          missedPrefs.push(`over the ${shown} you hoped for`);
          score -= 2;
        }
      }
    }

    const fit = attributesOf(product).fit;
    if (request.fit === 'relaxed' && fit && ['athletic', 'slim', 'tailored'].includes(fit)) {
      missedPrefs.push(`${fit} cut rather than relaxed`);
      score -= 1;
    } else if (request.fit === 'tight' && fit === 'relaxed') {
      missedPrefs.push('relaxed cut rather than close-fitting');
      score -= 1;
    } else if (request.fit && fit && (request.fit === 'relaxed' ? fit === 'relaxed' : request.fit === 'tight' ? fit !== 'relaxed' : fit === 'regular')) {
      reasons.push(`${fit} cut`);
      score += 1;
    }

    const matchLevel: MatchLevel = missedReqs.length ? 'partial' : missedPrefs.length ? 'strong' : 'exact';
    return {
      product,
      matchLevel,
      matchedRequirements: matched,
      missedPreferences: missedPrefs,
      missedRequirements: missedReqs,
      reason: joinReasons(reasons.slice(0, 3)),
      score,
    };
  });

  const tier: Record<MatchLevel, number> = { exact: 0, strong: 1, partial: 2 };
  return ranked.sort((a, b) => tier[a.matchLevel] - tier[b.matchLevel] || b.score - a.score);
}

function joinReasons(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** True when the request asks anything of the ranking at all. */
export function hasSignals(request: RankRequest): boolean {
  return Boolean(
    request.colours?.words.length ||
      request.avoidColours?.length ||
      request.features?.required.length ||
      request.features?.preferred.length ||
      request.weather?.length ||
      request.budget ||
      request.size ||
      request.waist ||
      request.fit ||
      request.rejected?.length ||
      request.range,
  );
}

/** One line per product for the model: what matched, what did not. Never read aloud. */
export function rankFacts(ranked: Ranked[]): string {
  return ranked
    .map((entry) => {
      const bits: string[] = [entry.matchLevel];
      if (entry.reason) bits.push(`why: ${entry.reason}`);
      if (entry.missedRequirements.length) bits.push(`fails: ${entry.missedRequirements.join('; ')}`);
      if (entry.missedPreferences.length) bits.push(`differs: ${entry.missedPreferences.join('; ')}`);
      return `- ${entry.product.title} [${entry.product.id}]: ${bits.join(' | ')}`;
    })
    .join('\n');
}
