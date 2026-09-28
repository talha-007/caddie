import type { ShopperSizes } from '@caddie/shared';
import type { Feature } from '../catalog/attributes.js';
import type { RankRequest } from '../recommend/rank.js';
import { constraintsIn, dropShoppingConstraints, noteShoppingConstraints } from '../session/focus.js';
import { BROADENS } from '../catalog/suitability.js';
import { sessions, type CaddieSession } from '../session/store.js';
import { isTrustedSource, logFact, MEASUREMENT_FIELDS, shopperView, trustedShopperFacts, type Measurements } from './facts.js';
import { DURABLE_FIELDS, durablePart, mergeProfile, readIntent, type DurableField, type FactSource, type Intent, type ShopperProfile } from './profile.js';

/**
 * The one way a durable fact about the customer is written.
 *
 * Only durable fields (profile.ts DURABLE_FIELDS), and only from the
 * customer's own evidence: their words, the size form, their own actions. A
 * model's argument and a size we worked out are refused here, whoever calls -
 * find_my_size once wrote its answer as their usual size, and note_shopper
 * wrote whatever the model thought they meant.
 *
 * Re-read rather than merged into the copy a tool was handed: two tools in one
 * turn can each learn something, and over Redis each holds its own copy - the
 * second write would otherwise undo the first.
 *
 * The older copies some code once read (sizeProfile.usualSize, .audience,
 * .fitPreference, preferences.audience) are no longer written (Phase 3B).
 */
export async function rememberShopper(sessionId: string, update: Partial<ShopperProfile>, source: FactSource): Promise<ShopperProfile> {
  const fresh = await sessions.getOrCreate(sessionId);
  const accepted: Partial<ShopperProfile> = {};
  for (const [key, value] of Object.entries(update) as Array<[keyof ShopperProfile, unknown]>) {
    if (value === undefined || key === 'provenance') continue;
    if (!(DURABLE_FIELDS as readonly string[]).includes(key)) {
      logFact(sessionId, key, source, 'profile', false, value, 'not a durable fact - it belongs to the shopping session');
      continue;
    }
    if (!isTrustedSource(source)) {
      logFact(sessionId, key, source, 'profile', false, value, 'not the customer’s evidence');
      continue;
    }
    (accepted as Record<string, unknown>)[key] = value;
    logFact(sessionId, key, source, 'profile', true, value);
  }
  if (!Object.keys(accepted).length) return fresh.shopper ?? {};

  const at = Date.now();
  const shopper = mergeProfile(fresh.shopper, accepted);
  shopper.provenance = {
    ...(fresh.shopper?.provenance ?? {}),
    ...Object.fromEntries((Object.keys(accepted) as DurableField[]).map((field) => [field, { source, at }])),
  };
  const saved = await sessions.patch(sessionId, { shopper });
  return saved.shopper ?? shopper;
}

/**
 * Measurements the customer gave - said in their words or typed into the
 * size form - kept for the next size asked. A measurement only the model
 * proposed never reaches here (find_my_size checks it against their words),
 * and one we estimated is part of the recommendation, not them.
 */
export async function rememberMeasurements(sessionId: string, measurements: Measurements, source: FactSource): Promise<void> {
  const given = MEASUREMENT_FIELDS.filter((field) => measurements[field] !== undefined);
  if (!given.length) return;
  if (!isTrustedSource(source)) {
    for (const field of given) logFact(sessionId, field, source, 'profile', false, undefined, 'not the customer’s evidence');
    return;
  }
  const fresh = await sessions.getOrCreate(sessionId);
  const at = Date.now();
  const sizeProfile: CaddieSession['sizeProfile'] = {};
  for (const field of given) sizeProfile[field] = measurements[field];
  if (measurements.heightValue !== undefined && measurements.heightUnit) sizeProfile.heightUnit = measurements.heightUnit;
  if (measurements.weightValue !== undefined && measurements.weightUnit) sizeProfile.weightUnit = measurements.weightUnit;
  const shopper: ShopperProfile = {
    ...(fresh.shopper ?? {}),
    provenance: { ...(fresh.shopper?.provenance ?? {}), ...Object.fromEntries(given.map((field) => [field, { source, at }])) },
  };
  await sessions.patch(sessionId, { sizeProfile, shopper });
  for (const field of given) logFact(sessionId, field, source, 'profile', true);
}

/**
 * One message of theirs, read by code: what it says about them for good
 * (their usual size, "I usually wear navy") into the profile, and what it
 * asks of this shopping session ("under £30", "only navy") into the focus's
 * constraints. A colour for this one search is the focus's own - see
 * session/focus.ts.
 */
export async function noteCustomerWords(sessionId: string, text: string): Promise<{ intent: Intent; durable: Partial<ShopperProfile> }> {
  const intent = readIntent(text);
  const durable = durablePart(intent, text);
  if (Object.keys(durable).length) await rememberShopper(sessionId, durable, 'customer-words');
  // "Show them anyway", "it doesn't have to be waterproof": the requirement goes, before anything this message asks for is noted.
  if (BROADENS.test(text)) await dropShoppingConstraints(sessionId, ['weather', 'features']);
  const constraints = constraintsIn(text);
  if (Object.keys(constraints).length) await noteShoppingConstraints(sessionId, constraints, 'customer-words');
  return { intent, durable };
}

/**
 * What to rank this request's results against: the words of this turn first,
 * then this shopping session, then what they have told us about themselves.
 * Sizes are their own - a size we recommended is not ranked on as theirs.
 */
export function rankRequestFor(
  session: CaddieSession,
  turn: Intent,
  extra: { features?: Feature[]; colour?: { words: string[]; strength: 'required' | 'preferred' } | null; currency?: string },
): RankRequest {
  const profile = shopperView(session);
  const facts = trustedShopperFacts(session);
  const required = new Set<Feature>([...(extra.features ?? []), ...(turn.features?.required ?? []), ...(profile.features?.required ?? [])]);
  const preferred = new Set<Feature>(
    [...(turn.features?.preferred ?? []), ...(profile.features?.preferred ?? [])].filter((feature) => !required.has(feature)),
  );
  const colours = extra.colour === null ? undefined : (extra.colour ?? turn.colours ?? profile.colours);
  const size = facts.usualSize;
  const fit = turn.fit ?? profile.fit;
  const avoid = turn.avoidColours ?? profile.avoidColours;

  return {
    ...(colours?.words.length ? { colours } : {}),
    ...(avoid?.length ? { avoidColours: avoid } : {}),
    ...(required.size || preferred.size ? { features: { required: [...required], preferred: [...preferred] } } : {}),
    ...((turn.weather ?? profile.weather)?.length ? { weather: turn.weather ?? profile.weather } : {}),
    // Only weather named now can mark a product as not suiting it; remembered weather only ranks.
    ...(turn.weather?.length ? { weatherAsked: true } : {}),
    ...((turn.budget ?? profile.budget) ? { budget: turn.budget ?? profile.budget } : {}),
    ...(size ? { size } : {}),
    ...(facts.waist ? { waist: facts.waist } : {}),
    ...(fit ? { fit } : {}),
    ...(profile.rejected?.length ? { rejected: profile.rejected } : {}),
    ...(extra.currency ? { currency: extra.currency } : {}),
  };
}

/**
 * Their range and sizes, for the widget - "Shopping for Mens · L", and where
 * every size picker opens. What they told us only: a size we recommended
 * reaches the cards as the size card's own preselection, labelled as ours,
 * never as theirs.
 */
export function shopperSizes(session: CaddieSession): ShopperSizes | undefined {
  const facts = trustedShopperFacts(session);
  const out: ShopperSizes = {
    ...(facts.range ? { range: facts.range } : {}),
    ...(facts.usualSize ? { size: facts.usualSize } : {}),
    ...(facts.waist ? { waist: facts.waist } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}
