import type { CaddieAttachment, Product } from '@caddie/shared';
import { offerability, type BuyingSize, type OfferDecision } from '../catalog/commerce.js';
import { sizeInRequest } from '../catalog/constraints.js';
import { log } from '../lib/logger.js';
import { currentMission, currentPack } from '../session/shoppingSession.js';
import { sessions, type CaddieSession } from '../session/store.js';
import { trustedShopperFacts } from '../shopper/facts.js';
import type { ToolContext, ToolResult } from './types.js';

/**
 * Which of the customer's sizes a product is judged in, and whether it may
 * be offered (V1 hardening task 1). Commerce Truth decides eligibility
 * (catalog/commerce.ts offerability); this supplies the sizes, from the
 * session, in one order for every card:
 *
 *   1. a size they said this turn     "polos in M", "waist 32, leg 34"
 *   2. the pack in hand's choices     top, waist and leg they gave for it
 *   3. their own pick on its card     for that product only
 *   4. a recommendation they accepted in this mission
 *   5. their usual size and waist
 *
 * A size only ever applies on the product's own scale - Commerce Truth
 * decides that - so the order says which of two applicable sizes wins, never
 * that an M reaches a cap in one size.
 */

const WAIST_SAID = /\b(\d{2})\s?(?:"|in|inch|inches)?\s?waist\b|\bwaist\s?(?:size\s?)?(?:of\s|is\s)?(\d{2})\b/i;
const LEG_SAID = /\b(?:inside\s+)?leg(?:\s*length)?\s*(?:is\s*|of\s*|:\s*)?(\d{2})\b|\b(\d{2})\s*(?:"|in|inch(?:es)?)?\s*(?:inside\s+)?leg\b/i;

/** Their sizes that do not depend on the product, in priority order - the card's own pick is added per product. */
export function buyingSizes(session: CaddieSession, said = ''): { before: BuyingSize[]; after: BuyingSize[] } {
  const now: BuyingSize[] = [];
  const waist = WAIST_SAID.exec(said);
  if (waist) now.push({ size: (waist[1] ?? waist[2])!, as: 'waist' });
  const leg = LEG_SAID.exec(said);
  if (leg) now.push({ size: (leg[1] ?? leg[2])!, as: 'leg' });
  const other = sizeInRequest(said.replace(WAIST_SAID, ' ').replace(LEG_SAID, ' '));
  if (other) now.push({ size: other });

  const handle = currentPack(session);
  const chosen = handle ? session.packChoices?.[handle] : undefined;
  const pack: BuyingSize[] = [
    ...(chosen?.top ? [{ size: chosen.top, as: 'top' as const }] : []),
    ...(chosen?.waist ? [{ size: chosen.waist, as: 'waist' as const }] : []),
    ...(chosen?.leg ? [{ size: chosen.leg, as: 'leg' as const }] : []),
  ];

  const rec = session.sizeRecommendation;
  const accepted: BuyingSize[] = rec && rec.acceptedMission !== undefined && rec.acceptedMission === currentMission(session) ? [{ size: rec.size, as: rec.scale === 'waist' ? 'waist' : 'top' }] : [];
  const facts = trustedShopperFacts(session);
  const usual: BuyingSize[] = [...(facts.usualSize ? [{ size: facts.usualSize, as: 'top' as const }] : []), ...(facts.waist ? [{ size: facts.waist, as: 'waist' as const }] : [])];
  return { before: [...now, ...pack], after: [...accepted, ...usual] };
}

export interface Eligibility {
  /** The decision for one product - `named` when the customer named it themselves. */
  decide(product: Product, opts?: { named?: boolean }): OfferDecision;
  /** Whether it may be offered as something to buy. */
  eligible(product: Product): boolean;
  /**
   * Whether it may be a pack piece: never sold out in their size, but a size
   * it is not made in is the pack's own question to ask ("the trousers don't
   * come in a 36 leg"), not a reason to drop the piece.
   */
  packPiece(product: Product): boolean;
}

/**
 * The eligibility rule for this turn. `first` are sizes that outrank all of
 * theirs - the size a pack piece is being replaced in.
 */
export function eligibilityFor(session: CaddieSession, said = '', first: BuyingSize[] = []): Eligibility {
  const { before, after } = buyingSizes(session, said);
  const decide = (product: Product, opts: { named?: boolean } = {}) => {
    const card = Object.entries(session.cardChoices?.[product.id]?.options ?? {}).map(([name, value]) => ({
      size: value,
      ...(/leg|length|inseam/i.test(name) ? { as: 'leg' as const } : /waist/i.test(name) ? { as: 'waist' as const } : {}),
    }));
    return offerability(product, [...first, ...before, ...card, ...after], opts);
  };
  return {
    decide,
    eligible: (product) => decide(product).offer === 'eligible',
    packPiece: (product) => {
      const decision = decide(product);
      return decision.offer === 'eligible' || decision.why === 'not-made';
    },
  };
}

/** The rule for a tool call. */
export function eligibilityOf(ctx: ToolContext, first: BuyingSize[] = []): Eligibility {
  return eligibilityFor(ctx.session, ctx.utterance ?? '', first);
}

/**
 * The last check before a card reaches the customer - the same rule, run on
 * every card a tool hands back, whatever path built it. A product card that
 * is not eligible is taken off (and off `lastShown`, which "the second one"
 * reads); a pack or outfit holding one is not shown at all - a pack with a
 * piece missing would be priced wrong. Either way it is logged with the path
 * that produced it: a card reaching here means a path upstream missed the
 * rule.
 */
export async function guardCards(result: ToolResult, ctx: ToolContext, source: string): Promise<ToolResult> {
  const attachment = result.attachment;
  if (!attachment || ctx.direct) return result;
  const rule = eligibilityOf(ctx);
  const bad = (products: Product[]) => products.filter((product) => !rule.eligible(product));
  const report = (products: Product[]) =>
    log.error('card.ineligible_blocked', {
      sessionId: ctx.session.id,
      source,
      kind: attachment.kind,
      products: products.map((product) => `${product.title}: ${rule.decide(product).reason ?? 'not eligible'}`),
    });
  if (attachment.kind === 'products') {
    const blocked = bad(attachment.products);
    if (!blocked.length) return result;
    report(blocked);
    const kept = attachment.products.filter((product) => !blocked.includes(product));
    const fresh = await sessions.getOrCreate(ctx.session.id);
    if (fresh.lastShown?.kind === 'products') {
      await sessions.patch(ctx.session.id, { lastShown: { ...fresh.lastShown, items: fresh.lastShown.items.filter((item) => !blocked.some((product) => product.id === item.id)) } });
    }
    const next: CaddieAttachment | undefined = kept.length ? { kind: 'products', products: kept } : undefined;
    const { attachment: _dropped, ...rest } = result;
    return { ...rest, ...(next ? { attachment: next } : {}), facts: `${result.facts ?? ''}\nNot shown - no longer available in their size: ${blocked.map((product) => product.title).join(', ')}. Never offer them.`.trim() };
  }
  const pieces = attachment.kind === 'pack' ? attachment.recommendation.items : attachment.kind === 'outfit' ? attachment.recommendation.pieces.map((piece) => piece.product) : [];
  // A pack's pieces by the pack's rule - a size it is not made in is the pack's question, a sold-out piece never shown.
  const blocked = attachment.kind === 'pack' ? pieces.filter((product) => !rule.packPiece(product)) : bad(pieces);
  if (!blocked.length) return result;
  report(blocked);
  const { attachment: _dropped, ...rest } = result;
  return {
    ...rest,
    speech: `Sorry - ${blocked.map((product) => product.title).join(' and ')} ${blocked.length > 1 ? 'are' : 'is'} no longer available in your size, so I can't show that ${attachment.kind} as it is. Shall I find a replacement?`,
    facts: `The ${attachment.kind} was not shown: ${blocked.map((product) => `${product.title} (${rule.decide(product).reason ?? 'not eligible'})`).join('; ')}. Nothing was added. Offer to find an available replacement.`,
  };
}
