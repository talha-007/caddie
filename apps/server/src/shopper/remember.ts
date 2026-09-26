import type { ShopperSizes } from '@caddie/shared';
import type { Feature } from '../catalog/attributes.js';
import type { RankRequest } from '../recommend/rank.js';
import { sessions, type CaddieSession } from '../session/store.js';
import { mergeProfile, type Intent, type ShopperProfile } from './profile.js';

/**
 * Folds something new into the shopper profile, re-read fresh.
 *
 * Re-read rather than merged into the copy a tool was handed: two tools in one
 * turn can each learn something, and over Redis each holds its own copy - the
 * second write would otherwise undo the first.
 *
 * The older fields that other code still reads are kept in step: the size
 * tool reads sizeProfile, and the range decides every search.
 */
export async function rememberShopper(sessionId: string, update: Partial<ShopperProfile>): Promise<ShopperProfile> {
  const fresh = await sessions.getOrCreate(sessionId);
  const shopper = mergeProfile(fresh.shopper, update);
  const patch: Partial<CaddieSession> = { shopper };

  const sizeProfile: CaddieSession['sizeProfile'] = {};
  if (update.usualSize) sizeProfile.usualSize = update.usualSize;
  if (update.fit) sizeProfile.fitPreference = update.fit;
  if (update.range === 'men' || update.range === 'women') sizeProfile.audience = update.range;
  if (Object.keys(sizeProfile).length) patch.sizeProfile = sizeProfile;
  if (update.range === 'men' || update.range === 'women') patch.preferences = { audience: update.range };
  if (update.budget?.per === 'total') patch.preferences = { ...(patch.preferences ?? {}), budgetAmount: update.budget.amount };

  const saved = await sessions.patch(sessionId, patch);
  return saved.shopper ?? shopper;
}

/**
 * What to rank this request's results against: the words of this turn first,
 * then what the customer has told us before.
 */
export function rankRequestFor(
  session: CaddieSession,
  turn: Intent,
  extra: { features?: Feature[]; colour?: { words: string[]; strength: 'required' | 'preferred' } | null; currency?: string },
): RankRequest {
  const profile = session.shopper ?? {};
  const required = new Set<Feature>([...(extra.features ?? []), ...(turn.features?.required ?? []), ...(profile.features?.required ?? [])]);
  const preferred = new Set<Feature>(
    [...(turn.features?.preferred ?? []), ...(profile.features?.preferred ?? [])].filter((feature) => !required.has(feature)),
  );
  const colours = extra.colour === null ? undefined : (extra.colour ?? turn.colours ?? profile.colours);
  const size = profile.usualSize ?? session.sizeProfile.usualSize;
  const fit = profile.fit ?? session.sizeProfile.fitPreference;
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
    ...(profile.waist ? { waist: profile.waist } : {}),
    ...(fit ? { fit } : {}),
    ...(profile.rejected?.length ? { rejected: profile.rejected } : {}),
    ...(extra.currency ? { currency: extra.currency } : {}),
  };
}

/**
 * Their range and sizes, for the widget: every size picker opens on them.
 *
 * find_my_size writes its answer here too, so a size worked out from their
 * chest replaces the one they guessed. The range they browse counts when they
 * never named one.
 */
export function shopperSizes(session: CaddieSession): ShopperSizes | undefined {
  const profile = session.shopper ?? {};
  const range = profile.range ?? session.sizeProfile.audience ?? session.preferences.audience;
  const size = profile.usualSize ?? session.sizeProfile.usualSize;
  const out: ShopperSizes = {
    ...(range ? { range } : {}),
    ...(size ? { size } : {}),
    ...(profile.waist ? { waist: profile.waist } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}
