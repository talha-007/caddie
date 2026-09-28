import type { Product } from '@caddie/shared';
import { FEATURE_LABEL, WEATHER_NEEDS, type Feature, type Weather } from './attributes.js';
import { featureState } from './commerce.js';

/**
 * Whether a product suits a need - rain, cold, heat, wind - decided from its
 * own stated features and nothing else (V1 hardening task 4).
 *
 * A cap described as lightweight and breathable was called "good for cooler
 * weather". Lightweight is not warmth, water-resistant is not waterproof,
 * and a description that says nothing is not a no. So one decision here,
 * built on the same readers as every other product fact (attributes.ts,
 * commerce.ts featureState), is what search gates on, what product questions
 * answer from, and what the reply checker holds the model's words to.
 *
 * It is small on purpose: the needs are the four the catalogue's own words
 * can answer, and a need is met only by a feature its description states.
 */

export type Need = Weather;

export const NEED_LABEL: Record<Need, string> = {
  wet: 'wet weather',
  cold: 'cold weather',
  hot: 'hot weather',
  windy: 'wind',
};

/** What a "yes" would have had to say, for the words "nothing about ..." when it does not. */
export const NEED_EVIDENCE_WORDS: Record<Need, string> = {
  wet: 'waterproofing or water resistance',
  cold: 'warmth, insulation or windproofing',
  hot: 'being lightweight, breathable, wicking or sun-protective',
  windy: 'windproofing',
};

export interface Suitability {
  need: Need;
  /** yes - a feature the need calls for is stated; no - every such feature is explicitly denied; unknown - nothing either way. */
  verdict: 'yes' | 'no' | 'unknown';
  /** The stated features that support it. */
  evidence: Feature[];
  /** The features its description explicitly rules out. */
  against: Feature[];
}

export function suitsNeed(product: Product, need: Need): Suitability {
  const wanted = WEATHER_NEEDS[need];
  const evidence = wanted.filter((feature) => featureState(product, feature) === 'yes');
  const against = wanted.filter((feature) => featureState(product, feature) === 'no');
  // Waterproof counts for water-resistant (featureState); said once, as the stronger word.
  const stated = evidence.includes('waterproof') ? evidence.filter((feature) => feature !== 'water-resistant') : evidence;
  if (stated.length) return { need, verdict: 'yes', evidence: stated, against: [] };
  if (against.length === wanted.length) return { need, verdict: 'no', evidence: [], against };
  return { need, verdict: 'unknown', evidence: [], against };
}

/** The verdict in words, for the facts a tool hands the model. */
export function describeSuitability(product: Product, need: Need): string {
  const result = suitsNeed(product, need);
  const label = NEED_LABEL[need];
  if (result.verdict === 'yes') return `${label}: supported - its description states ${result.evidence.map((feature) => FEATURE_LABEL[feature]).join(' and ')}`;
  if (result.verdict === 'no') return `${label}: its description says it is not ${result.against.map((feature) => FEATURE_LABEL[feature]).join(' or ')}`;
  return `${label}: not supported - its description states nothing about ${NEED_EVIDENCE_WORDS[need]}`;
}

/*
 * The customer's own words for a need. Cold is cold, and it is also "warmer"
 * and "cooler weather"; heat is heat, summer and "keep me cool". "Cool" on
 * its own is not weather - "that looks cool" - so it counts only with a
 * weather word beside it. Feature words (warm, thermal, waterproof,
 * breathable, lightweight) are read by attributes.ts featuresAsked as the
 * features they are; here only the weather they name.
 */
const NEED_WORDS_SAID: Array<[Need, RegExp]> = [
  ['wet', /\b(rain|rainy|raining|wet|showers?|drizzle|downpour|damp|soggy|waterproof|water[- ]?resistant)\b/i],
  [
    'cold',
    /\b(cold|colder|chilly|freezing|winter|wintry|frosty?|icy|(?<!body |hand )warmer|warmest|cool(?:er)? (?:weather|days?|rounds?|mornings?|evenings?|conditions|months|climate)|early (?:mornings?|starts?))\b/i,
  ],
  ['hot', /\b(hot|hotter|heat|heatwave|warm (?:weather|days?|climate|rounds?|conditions|months)|sunny|sunshine|summer|humid|scorching|tropical|keeps? (?:me|you) cool|stay cool|cooling)\b/i],
  ['windy', /\b(wind|windy|breezy|gusty|links golf|coastal)\b/i],
];

/** A softened need ("ideally something warm") is a preference; a stated one is a requirement. */
const SOFTENED = /\b(prefer|preferably|ideally|maybe|perhaps|possibly|if possible|if you have|would be nice|not essential|not necessarily|(?:doesn'?t|does not|don'?t|need not|needn'?t) (?:have|need) to be)\b/i;

/** The needs one message names, and whether they are asked for outright. */
export function needsSaid(text: string): { needs: Need[]; hard: boolean } {
  const needs = NEED_WORDS_SAID.filter(([, pattern]) => pattern.test(text)).map(([need]) => need);
  // "It doesn't have to be waterproof" names the need only to let it go.
  return { needs, hard: needs.length > 0 && !SOFTENED.test(text) && !BROADENS.test(text) };
}

/**
 * "Show them anyway", "any cap will do", "it doesn't have to be waterproof":
 * the requirement is lifted - for this request, and for the rest of the
 * mission (shopper/remember.ts drops it from the session's constraints).
 */
export const BROADENS =
  /\b(anyway|regardless|any(?:thing)? (?:you have|you'?ve got|will do|is fine|at all)|show me anything|all (?:of )?(?:the |your )?(?:caps|hats|jackets|polos|midlayers|gilets|trousers|shorts|options|products|ones)|all of them|whatever you have|doesn'?t matter|never mind (?:the )?(?:weather|that|it)|drop that|without that|not fussed|(?:doesn'?t|does not|don'?t|need not|needn'?t) (?:have|need) to be)\b/i;
