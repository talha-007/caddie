import type { Product, ProductVariant } from '@caddie/shared';
import { sizeInRequest } from '../catalog/constraints.js';
import { productById } from '../catalog/sync.js';
import { normaliseSize, optionValueMatches } from '../recommend/sizeWords.js';
import type { CaddieSession } from '../session/store.js';
import { readIntent } from '../shopper/profile.js';

/**
 * What the customer has actually chosen for a pack - and what is still open.
 *
 * A Cool & Wet Ambassador Pack showed a red Warrior Jacket that was sold out
 * in the customer's size, and the trousers read "34 / 34" before they had
 * chosen a leg at all - they had asked for a 36, which the trousers do not
 * come in. A size the card opened on, or one the model passed, is not the
 * customer's choice. Here only three things count:
 *
 *   confirmed   said by the customer (or tapped on the card), and one the
 *               piece really comes in
 *   requested   said by the customer, but not one the piece comes in - kept,
 *               so it is never quietly swapped for another
 *   (top size)  their usual size, when they have one: said as theirs, or
 *               worked out from their measurements by find_my_size, which
 *               stores it - the existing sizing behaviour, kept as it is
 *
 * From those, each piece is resolved to a real variant, in stock, or it is
 * not - and the pack is ready only when every piece is.
 */

export interface PackChoices {
  top?: string;
  waist?: string;
  leg?: string;
  /** Said, but not a value the piece comes in: "leg 36" for trousers made in 30, 32 and 34. */
  requested?: { top?: string; waist?: string; leg?: string };
}

type Kind = 'top' | 'waist' | 'leg' | 'other';

export interface PiecePlan {
  step: string;
  product: Product;
  /** The option value for each option that needs a choice, when it has one. */
  chosen: Record<string, string>;
  /** Options with no confirmed value, by kind. */
  missing: Array<{ kind: Kind; option: string; values: string[] }>;
  /** The variant those choices make, when every choice is made. */
  variant?: ProductVariant;
  /** Every choice made, but that variant is sold out. */
  soldOut?: boolean;
}

export interface PackStatus {
  ready: boolean;
  pieces: PiecePlan[];
  choices: PackChoices;
  /** The one thing to ask next, in a short sentence - empty when ready. */
  next: string;
}

const WAIST = /\bwaist(?:\s*size)?\s*(?:is\s*|of\s*|:\s*)?(\d{2})\b|\b(\d{2})\s*(?:"|in|inch(?:es)?)?\s*waist\b/i;
const LEG = /\b(?:inside\s+)?leg(?:\s*length)?\s*(?:is\s*|of\s*|:\s*)?(\d{2})\b|\b(\d{2})\s*(?:"|in|inch(?:es)?)?\s*(?:inside\s+)?leg\b/i;
const PAIR = /\b(\d{2})\s*(?:\/|x|by)\s*(\d{2})\b/i;

function kindOf(option: { name: string; values: string[] }): Kind {
  if (/leg|length|inseam/i.test(option.name)) return 'leg';
  if (/waist/i.test(option.name)) return 'waist';
  if (/size/i.test(option.name)) return option.values.every((value) => /^\d{2}$/.test(value.trim())) ? 'waist' : 'top';
  return 'other';
}

/** The pieces of the pack on screen, or remembered by handle. */
export function packPieces(session: CaddieSession, handle: string): Product[] {
  const shown = session.lastShown?.kind === 'pack' && session.lastShown.bundle === handle ? session.lastShown.items : session.packsShown?.[handle]?.items;
  return (shown ?? []).map((item) => (item.id ? productById(item.id) : null)).filter((product): product is Product => !!product);
}

/** The values a kind of option can take across the pack's pieces. */
function valuesFor(pieces: Product[], kind: Kind): string[] {
  return [...new Set(pieces.flatMap((piece) => piece.options.filter((option) => option.values.length > 1 && kindOf(option) === kind).flatMap((option) => option.values)))];
}

/**
 * What this message chooses for the pack: "waist 34, leg 36", "34/32", "S",
 * or a bare "34" when the Caddie had just asked for the leg. Each is checked
 * against the pieces: one they come in is confirmed; one they do not is kept
 * as requested and left open.
 */
export function readPackChoices(said: string, lastReply: string, pieces: Product[], before: PackChoices = {}): PackChoices {
  const text = said.toLowerCase();
  const next: PackChoices = { ...before, requested: { ...(before.requested ?? {}) } };
  const set = (kind: 'top' | 'waist' | 'leg', value: string) => {
    const values = valuesFor(pieces, kind);
    const match = values.find((own) => own.toLowerCase() === value.toLowerCase() || optionValueMatches(own, value));
    if (values.length === 0) return;
    if (match) {
      next[kind] = match;
      delete next.requested![kind];
    } else {
      delete next[kind];
      next.requested![kind] = value;
    }
  };

  const pair = PAIR.exec(text);
  const waist = WAIST.exec(text);
  const leg = LEG.exec(text);
  if (pair && !waist && !leg) {
    set('waist', pair[1]!);
    set('leg', pair[2]!);
  }
  if (waist) set('waist', (waist[1] ?? waist[2])!);
  if (leg) set('leg', (leg[1] ?? leg[2])!);

  // A bare number is whichever measurement the Caddie had just asked for.
  const bare = /^\s*(?:a\s+|the\s+)?(\d{2})\s*(?:please|thanks|then|one)?[\s.!]*$/i.exec(text);
  if (bare && !pair && !waist && !leg) {
    if (/\bleg\b/i.test(lastReply)) set('leg', bare[1]!);
    else if (/\bwaist\b/i.test(lastReply)) set('waist', bare[1]!);
    // The last reply was about something else, but only one measurement is still open.
    else if (before.waist && !before.leg && valuesFor(pieces, 'leg').length) set('leg', bare[1]!);
    else if (before.leg && !before.waist && valuesFor(pieces, 'waist').length) set('waist', bare[1]!);
  }

  // A letter size for the tops: "S", "a medium", "in L", "size S", "I'm a large".
  const top = [sizeInRequest(said), readIntent(said).usualSize].find((value) => !!value && !/^\d/.test(value));
  if (top && !/^\d/.test(top)) set('top', top);
  else {
    const alone = normaliseSize(text.replace(/\b(please|thanks|in|size|a|an|the|for the tops?|tops?)\b/g, ' ').replace(/[^a-z0-9\s]/g, ' ').trim());
    if (alone && !/^\d/.test(alone)) set('top', alone);
  }
  if (!Object.keys(next.requested!).length) delete next.requested;
  return next;
}

/** Each piece resolved against the confirmed choices - and whether the pack is ready. */
export function packStatus(session: CaddieSession, handle: string, pieces: Product[] = packPieces(session, handle)): PackStatus {
  const choices = session.packChoices?.[handle] ?? {};
  // Their usual size stands for the tops until they say otherwise: stated, or measured by find_my_size.
  const top = choices.top ?? session.shopper?.usualSize ?? session.sizeProfile.usualSize;
  const waist = choices.waist ?? session.shopper?.waist;

  const plans: PiecePlan[] = pieces.map((product, index) => {
    const tapped = session.cardChoices?.[product.id]?.options ?? {};
    const chosen: Record<string, string> = {};
    const missing: PiecePlan['missing'] = [];
    for (const option of product.options.filter((own) => own.values.length > 1)) {
      const kind = kindOf(option);
      const byTap = Object.entries(tapped).find(([name]) => name.toLowerCase() === option.name.toLowerCase())?.[1];
      const wanted = byTap ?? (kind === 'top' ? top : kind === 'waist' ? waist : kind === 'leg' ? choices.leg : undefined);
      // A combined size - the belt's "S/M" - holds their size when one half is it.
      const value = wanted
        ? option.values.find((own) => own.toLowerCase() === wanted.toLowerCase() || optionValueMatches(own, wanted)) ??
          option.values.find((own) => own.includes('/') && own.split('/').some((half) => optionValueMatches(half.trim(), wanted)))
        : undefined;
      if (value) chosen[option.name] = value;
      else missing.push({ kind, option: option.name, values: option.values });
    }
    const plan: PiecePlan = { step: session.lastShown?.items[index]?.slot ?? product.title, product, chosen, missing };
    if (!missing.length) {
      const variant = product.variants.find((own) => Object.entries(chosen).every(([name, value]) => own.options[name] === value)) ?? (product.options.every((own) => own.values.length <= 1) ? product.variants[0] : undefined);
      if (!variant) plan.missing.push({ kind: 'other', option: 'combination', values: [] });
      else {
        plan.variant = variant;
        if (!variant.available) plan.soldOut = true;
      }
    }
    return plan;
  });

  const ready = plans.length > 0 && plans.every((plan) => plan.variant && !plan.soldOut);
  return { ready, pieces: plans, choices: { ...choices, ...(top ? { top } : {}), ...(waist ? { waist } : {}) }, next: ready ? '' : nextQuestion(plans, { ...choices, ...(top ? { top } : {}), ...(waist ? { waist } : {}) }) };
}

const title = (text: string) => text.toLowerCase().replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());

/** "WARRIOR JACKET - RED" is "red Warrior Jacket" when spoken. */
function spokenName(productTitle: string): string {
  const [design, colour] = productTitle.split(/\s+-\s+/);
  return colour && !/[()]/.test(colour) ? `${colour.toLowerCase()} ${title(design!)}` : title(productTitle);
}

const NOUNS = ['jacket', 'gilet', 'midlayer', 'hoodie', 'jumper', 'polo', 'shirt', 'trousers', 'shorts', 'belt', 'socks', 'cap', 'top'];
/** The kind of garment, for "another jacket in S". */
function garmentNoun(productTitle: string): string {
  const words = productTitle.split(/\s+-\s+/)[0]!.toLowerCase().split(/\s+/);
  return [...words].reverse().find((word) => NOUNS.includes(word)) ?? 'one';
}
const list = (values: string[]) => (values.length > 1 ? `${values.slice(0, -1).join(', ')} or ${values[values.length - 1]}` : (values[0] ?? ''));

/**
 * The single thing to ask - never what is already known, never two at once.
 * The top size first (it decides most of the pack), then the waist, then the
 * leg, then a piece sold out in their size, then anything else.
 */
/*
 * A piece they cannot have comes first. With the tops confirmed in S and the
 * red Warrior sold out in S, the Caddie asked for the trouser leg - a question
 * about a pack that could not be bought as it stood.
 */
function nextQuestion(plans: PiecePlan[], choices: PackChoices): string {
  const soldOut = plans.find((plan) => plan.soldOut);
  if (soldOut) {
    const size = Object.values(soldOut.chosen).join(' / ');
    return `The ${spokenName(soldOut.product.title)} is sold out in ${size}. I can swap it for another ${garmentNoun(soldOut.product.title)} in ${size} - shall I?`;
  }
  const firstMissing = (kind: Kind) => plans.flatMap((plan) => plan.missing.filter((entry) => entry.kind === kind).map((entry) => ({ plan, entry })))[0];
  const top = firstMissing('top');
  if (top) return choices.requested?.top ? `The pack doesn't come in ${choices.requested.top} for the tops. Which size would you like: ${list(top.entry.values)}?` : 'What top size do you wear?';
  const waist = firstMissing('waist');
  if (waist) return choices.requested?.waist ? `The trousers don't come in a ${choices.requested.waist} waist. Would you like ${list(waist.entry.values)}?` : 'What waist size do you need for the trousers?';
  const leg = firstMissing('leg');
  if (leg) {
    const known = choices.waist ? `Waist ${choices.waist} is fine, but ` : '';
    return choices.requested?.leg
      ? `${known}the trousers don't come in a ${choices.requested.leg} leg. Would you like ${list(leg.entry.values)}?`
      : `Which leg length for the trousers: ${list(leg.entry.values)}?`;
  }
  const other = plans.flatMap((plan) => plan.missing.map((entry) => ({ plan, entry })))[0];
  if (other) return other.entry.values.length ? `Which ${other.entry.option.toLowerCase()} for the ${title(other.plan.product.title)}: ${list(other.entry.values)}?` : `That combination isn't available for the ${title(other.plan.product.title)} - which would you like instead?`;
  return '';
}

/** The pack's state for the model: what is confirmed, what is not, and the one thing to ask. */
export function packStatusFacts(status: PackStatus): string {
  const confirmed = [status.choices.top ? `top ${status.choices.top}` : '', status.choices.waist ? `waist ${status.choices.waist}` : '', status.choices.leg ? `leg ${status.choices.leg}` : '']
    .filter(Boolean)
    .join(', ');
  if (status.ready) {
    return `Pack status: READY - every piece chosen and in stock (${status.pieces.map((plan) => `${plan.product.title}${Object.values(plan.chosen).length ? ` ${Object.values(plan.chosen).join('/')}` : ''}`).join('; ')}). Offer to add it in one short question.`;
  }
  const open = status.pieces
    .map((plan) =>
      plan.soldOut
        ? `${plan.product.title}: sold out in ${Object.values(plan.chosen).join(' / ')}`
        : plan.missing.length
          ? `${plan.product.title}: needs ${plan.missing.map((entry) => entry.option.toLowerCase()).join(' and ')}`
          : '',
    )
    .filter(Boolean);
  const requested = Object.entries(status.choices.requested ?? {}).map(([kind, value]) => `${kind} ${value} (asked for, not available - never swap it for another value silently)`);
  return [
    `Pack status: NOT READY - never say it is ready or complete, and never add it.`,
    confirmed ? `Confirmed, do not ask again: ${confirmed}.` : '',
    requested.length ? `Requested but unavailable: ${requested.join('; ')}.` : '',
    open.length ? `Open: ${open.join('; ')}.` : '',
    `Ask only this: "${status.next}"`,
  ]
    .filter(Boolean)
    .join(' ');
}
