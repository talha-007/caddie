import type { SizeBasis } from '@caddie/shared';
import type { Range } from '../catalog/audience.js';
import { log } from '../lib/logger.js';
import { normaliseSize } from '../recommend/sizeWords.js';
import { customerTurn, type ShoppingConstraints } from '../session/focus.js';
import type { CaddieSession } from '../session/store.js';
import { DURABLE_FIELDS, profileBits, readIntent, type DurableField, type FactScope, type FactSource, type ShopperProfile } from './profile.js';

/**
 * The one reader of what is true about the customer, and in what order.
 *
 * Every tool used to choose its own: search asked sizeProfile.audience before
 * the range the customer stated, the size tool believed the model's audience
 * over their words, packs read a usual size find_my_size had written for
 * them. Three categories, kept apart (shopper/profile.ts):
 *
 *   trustedShopperFacts   durable, and only what the customer gave us - their
 *                         words, the size form, their own actions
 *   currentShoppingIntent what they want now: this turn's words, then the
 *                         shopping focus and its constraints
 *   sizeRecommendation    what we worked out - advice, never their size
 *
 * shopperView puts the first two together for readers that rank or describe:
 * this turn, then this shopping session, then the durable facts. A durable
 * mens profile never overrides a ladies search being followed up.
 */

/** Sources that are the customer's own evidence. A recommendation is ours; a model hint is a guess. */
const TRUSTED: ReadonlySet<FactSource> = new Set<FactSource>(['customer-words', 'ui-form', 'ui-selection', 'customer-confirmation']);

export function isTrustedSource(source: FactSource): boolean {
  return TRUSTED.has(source);
}

export const MEASUREMENT_FIELDS = ['heightValue', 'weightValue', 'chestCm', 'waistCm'] as const;
export type MeasurementField = (typeof MEASUREMENT_FIELDS)[number];

export interface Measurements {
  heightValue?: number;
  heightUnit?: 'cm' | 'in';
  weightValue?: number;
  weightUnit?: 'kg' | 'lb';
  chestCm?: number;
  waistCm?: number;
}

export type TrustedShopperFacts = Pick<ShopperProfile, DurableField> & {
  measurements: Measurements;
  /** Where each fact came from, for the model's context and the logs. */
  sources: Partial<Record<DurableField | MeasurementField, FactSource>>;
};

/**
 * Durable facts the customer gave us, and nothing else. A value in the
 * profile with no trusted provenance - written before provenance existed, or
 * by anything that is not the customer - is not a fact about them.
 */
export function trustedShopperFacts(session: CaddieSession): TrustedShopperFacts {
  const shopper = session.shopper ?? {};
  const provenance = shopper.provenance ?? {};
  const out: TrustedShopperFacts = { measurements: {}, sources: {} };
  for (const field of DURABLE_FIELDS) {
    const value = shopper[field];
    const record = provenance[field];
    if (value === undefined || !record || !isTrustedSource(record.source)) continue;
    (out as Record<string, unknown>)[field] = value;
    out.sources[field] = record.source;
  }
  const sizes = session.sizeProfile ?? {};
  for (const field of MEASUREMENT_FIELDS) {
    const value = sizes[field];
    const record = provenance[field];
    if (value === undefined || !record || !isTrustedSource(record.source)) continue;
    out.measurements[field] = value;
    out.sources[field] = record.source;
    if (field === 'heightValue' && sizes.heightUnit) out.measurements.heightUnit = sizes.heightUnit;
    if (field === 'weightValue' && sizes.weightUnit) out.measurements.weightUnit = sizes.weightUnit;
  }
  return out;
}

export type CurrentShoppingIntent = ShoppingConstraints & {
  range?: Range;
  /** Whether each value is this turn's words or held for the shopping session. */
  scopes: Partial<Record<keyof ShoppingConstraints | 'range', Extract<FactScope, 'turn' | 'shopping-session'>>>;
};

/**
 * What they want now: this message's words first, then what this shopping
 * session holds - the focus's range and the constraints said along the way.
 * Never the durable profile: that is trustedShopperFacts.
 */
export function currentShoppingIntent(session: CaddieSession, said?: string): CurrentShoppingIntent {
  const turn = said ? readIntent(said) : {};
  const focus = session.activeShoppingContext;
  const held: ShoppingConstraints = focus?.constraints ?? {};
  const out: CurrentShoppingIntent = { scopes: {} };
  const take = <K extends keyof CurrentShoppingIntent & keyof CurrentShoppingIntent['scopes']>(key: K, now: CurrentShoppingIntent[K] | undefined, kept: CurrentShoppingIntent[K] | undefined) => {
    if (now !== undefined) {
      out[key] = now;
      out.scopes[key] = 'turn';
    } else if (kept !== undefined) {
      out[key] = kept;
      out.scopes[key] = 'shopping-session';
    }
  };
  take('range', turn.range, focus?.range);
  // A colour named for this one request is the focus's; only a rule or a taste ("only navy", "I'd prefer navy") is held.
  take('colours', turn.coloursStanding ? turn.colours : undefined, held.colours);
  take('avoidColours', turn.avoidColours, held.avoidColours);
  take('budget', turn.budget, held.budget);
  take('fit', turn.fit, held.fit);
  take('layering', turn.layering, held.layering);
  take('features', turn.featuresStanding ? turn.features : undefined, held.features);
  take('weather', turn.weather, held.weather);
  if (turn.justThis === '') out.scopes.justThis = 'turn';
  else take('justThis', turn.justThis, held.justThis);
  take('liked', undefined, held.liked);
  take('rejected', undefined, held.rejected);
  return out;
}

/**
 * The customer as a ranking or a reply should see them: this turn, then this
 * shopping session, then what they told us about themselves - one order,
 * for every reader.
 */
export function shopperView(session: CaddieSession, said?: string): ShopperProfile {
  const { measurements: _measurements, sources: _sources, ...facts } = trustedShopperFacts(session);
  const { scopes: _scopes, ...current } = currentShoppingIntent(session, said);
  const view: ShopperProfile = { ...facts };
  for (const [key, value] of Object.entries(current)) if (value !== undefined) (view as Record<string, unknown>)[key] = value;
  if (view.justThis === '') delete view.justThis;
  return view;
}

/** The range they are shopping now: their words, then the focus, then the range they told us is theirs. */
export function currentRange(session: CaddieSession, said?: string): Range | undefined {
  return currentShoppingIntent(session, said).range ?? trustedShopperFacts(session).range;
}

/**
 * A size the Caddie worked out - from their chest, their height, their usual
 * size and the garment's cut. Advice: shown, offered, and used once they
 * accept it, but never their usual size, never a standing filter, never a
 * pack's confirmed size.
 */
export interface SizeRecommendationRecord {
  size: string;
  /** Tops are lettered; bottoms carry a waist. Separate scales. */
  scale: 'top' | 'waist';
  category?: string;
  productId?: string;
  basis: SizeBasis;
  /** The customer turn it was given in. */
  turn: number;
  at: number;
  /** The mission in which they accepted it ("use that size") - theirs for that mission's purchases, and no other. */
  acceptedMission?: number;
}

/**
 * "Use that", "go with that size", "yes" - accepting the size just
 * recommended. Only the reply straight after it: a "yes" three messages on is
 * about something else.
 */
const ACCEPT =
  /^\s*(?:yes|yeah|yep|yup|ok(?:ay)?|sure|perfect|great|lovely|sounds good|go on|do it|please)\b|\b(?:use|go with|take|select|pick|choose|have|get|i'?ll (?:take|have|go with))\s+(?:that|it|this|that one|the (?:recommended|suggested) (?:size|one)|your (?:suggestion|recommendation)|that size|the size you (?:said|suggested|recommended|gave))\b|\b(?:that size is fine|recommended size|your suggestion)\b/i;

export function acceptedRecommendation(session: CaddieSession, said: string | undefined): SizeRecommendationRecord | undefined {
  const rec = session.sizeRecommendation;
  if (!rec || !said?.trim()) return undefined;
  if (rec.turn < customerTurn(session) - 1) return undefined;
  // "Use L instead" names its own size: that is theirs, not an acceptance.
  const named = readIntent(said).usualSize ?? normaliseSize(said.trim());
  if (named && named.toUpperCase() !== rec.size.toUpperCase()) return undefined;
  return ACCEPT.test(said) ? rec : undefined;
}

/**
 * One shopper-fact decision, for the log. Field, source, scope and whether
 * it was kept - the value only where it is a size or a range, never a body
 * measurement.
 */
export function logFact(sessionId: string, fact: string, source: FactSource, scope: FactScope, accepted: boolean, value?: unknown, reason?: string): void {
  const safe = MEASUREMENT_FIELDS.includes(fact as MeasurementField) ? undefined : value;
  log.info('shopper.fact', {
    sessionId,
    fact,
    source,
    scope,
    decision: accepted ? 'accepted' : 'rejected',
    ...(safe !== undefined ? { value: typeof safe === 'object' ? JSON.stringify(safe).slice(0, 120) : safe } : {}),
    ...(reason ? { reason } : {}),
  });
}

const BASIS_WORDS: Record<SizeBasis, string> = {
  measurement: 'their measurements on the Druids chart',
  estimate: 'an estimate from their height and weight',
  'usual-size': 'their usual size and the garment’s cut',
  none: 'too little to go on',
};

/**
 * The customer as the model reads them each turn, with each thing labelled
 * for what it is. "Size: M" once meant their usual size and a size we
 * recommended alike, and the model treated both as theirs.
 */
export function describeShopper(session: CaddieSession, currency = 'GBP'): string | null {
  const { measurements, sources: _sources, ...facts } = trustedShopperFacts(session);
  const { scopes: _scopes, range: _range, ...current } = currentShoppingIntent(session);
  const lines: string[] = [];
  const stated = profileBits(facts, currency);
  const measured = MEASUREMENT_FIELDS.filter((field) => measurements[field] !== undefined);
  if (measured.length) stated.push(`gave their ${measured.map((field) => MEASUREMENT_WORDS[field]).join(', ')}`);
  if (stated.length) lines.push(`What the customer has told us about themselves (use it, never ask again): ${stated.join('; ')}.`);
  const now = profileBits(current, currency);
  if (now.length) lines.push(`What they have asked for while shopping now (this session's search, not a fact about them): ${now.join('; ')}.`);
  const rec = session.sizeRecommendation;
  if (rec) {
    const what = rec.scale === 'waist' ? `a ${rec.size} waist` : rec.size;
    lines.push(
      `Our sizing recommendation${rec.category ? ` for ${rec.category}s` : ''}: ${what}, from ${BASIS_WORDS[rec.basis]} - our advice, not a size they told us${facts.usualSize && rec.scale === 'top' ? ` (they said they usually wear ${facts.usualSize})` : ''}. Use it for a purchase only once they accept it.`,
    );
  }
  return lines.length ? lines.join('\n') : null;
}

const MEASUREMENT_WORDS: Record<MeasurementField, string> = { heightValue: 'height', weightValue: 'weight', chestCm: 'chest', waistCm: 'waist measurement' };
