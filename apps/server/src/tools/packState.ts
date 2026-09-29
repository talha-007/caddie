import type { Product, ProductVariant } from '@caddie/shared';
import { sizeInRequest } from '../catalog/constraints.js';
import { productById } from '../catalog/sync.js';
import { foldNonAscii, normaliseSize, optionValueMatches } from '../recommend/sizeWords.js';
import type { CaddieSession } from '../session/store.js';
import { optionScale, resolveVariant } from '../catalog/commerce.js';
import { trustedShopperFacts } from '../shopper/facts.js';
import { readIntent } from '../shopper/profile.js';
import { modelReadingFor } from '../ai/readTurn.js';
import { PACK_SIZES_ON_CARD } from './sizeHandoff.js';

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
  /**
   * A belt's combined size ("M/L"), its own choice - never the top size. A top
   * size says nothing about which belt fits (catalog/commerce.ts), and "M/L"
   * said for the belt once became every top's size. Tapped on the card, or
   * said as the belt's own value.
   */
  belt?: string;
  /** Said, but not a value the piece comes in: "leg 36" for trousers made in 30, 32 and 34. */
  requested?: { top?: string; waist?: string; leg?: string };
}

type Kind = 'top' | 'waist' | 'leg' | 'belt' | 'other';

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
  /** Sizes standing in from the usual size they told us, not chosen for this pack. */
  fromProfile?: { top?: string; waist?: string };
}

const WAIST = /\bwaist(?:\s*size)?\s*(?:is\s*|of\s*|:\s*)?(\d{2})\b|\b(\d{2})\s*(?:"|in|inch(?:es)?)?\s*waist\b/i;
const LEG = /\b(?:inside\s+)?leg(?:\s*length)?\s*(?:is\s*|of\s*|:\s*)?(\d{2})\b|\b(\d{2})\s*(?:"|in|inch(?:es)?)?\s*(?:inside\s+)?leg\b/i;
const PAIR = /\b(\d{2})\s*(?:\/|x|by)\s*(\d{2})\b/i;

/**
 * Which of the pack's questions an option answers - read from the product's
 * own size scale (catalog/commerce.ts), so the pack, the basket and product
 * details agree on what a 34 or an M is. Ladies' 10-18 are sizes, not waists.
 */
function kindOf(option: { name: string; values: string[] }): Kind {
  const scale = optionScale(option);
  if (scale === 'leg') return 'leg';
  if (scale === 'waist') return 'waist';
  if (scale === 'combined') return 'belt';
  return scale ? 'top' : 'other';
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
export function readPackChoices(
  said: string,
  lastReply: string,
  pieces: Product[],
  before: PackChoices = {},
  /** A recommended size the customer has just accepted ("use that size") - theirs now, for this pack. */
  accepted?: { top?: string; waist?: string },
  /** What the waiting record says the pack still lacks (tools/pending.ts): a bare "34" is that, now that the question no longer names it. */
  asked?: 'top' | 'waist' | 'leg',
): PackChoices {
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
    if (asked === 'leg' || asked === 'waist') set(asked, bare[1]!);
    else if (/\bleg\b/i.test(lastReply)) set('leg', bare[1]!);
    else if (/\bwaist\b/i.test(lastReply)) set('waist', bare[1]!);
    // The last reply was about something else, but only one measurement is still open.
    else if (before.waist && !before.leg && valuesFor(pieces, 'leg').length) set('leg', bare[1]!);
    else if (before.leg && !before.waist && valuesFor(pieces, 'waist').length) set('waist', bare[1]!);
  }

  // A letter size for the tops: "S", "a medium", "in L", "size S", "I'm a large".
  /*
   * The top size read with the waist and leg taken out: "top size M, waist
   * 34, leg 32" gave the reader the 34 first, and the M was never confirmed.
   */
  // The belt's own value, exactly as the belt comes: "M/L". Taken out before the top size is read - it is never an M.
  const beltValues = valuesFor(pieces, 'belt');
  const beltSaid = beltValues.find((value) => new RegExp(`(^|[^a-z])${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s*\/\s*/g, '\\s*\\/\\s*')}($|[^a-z])`, 'i').test(said));
  if (beltSaid) next.belt = beltSaid;
  const lettered = said.replace(WAIST, ' ').replace(LEG, ' ').replace(PAIR, ' ').replace(/\b[a-z0-9]+\s*\/\s*[a-z0-9]+\b/gi, ' ');
  const top = [sizeInRequest(lettered), readIntent(lettered).usualSize].find((value) => !!value && !/^\d/.test(value));
  if (top && !/^\d/.test(top)) set('top', top);
  else {
    const alone = normaliseSize(foldNonAscii(text).replace(/\b(please|thanks|in|size|a|an|the|for the tops?|tops?)\b/g, ' ').replace(/[^a-z0-9\s]/g, ' ').trim());
    if (alone && !/^\d/.test(alone)) set('top', alone);
    /*
     * A top size said in a sentence, or a yes to one named back to them.
     * "My top size would be medium", "that is also medium", "yes it is
     * confirmed" to "is medium your top size?" - each went unread, the pack's
     * top size stayed open, and the Caddie asked for it again and again
     * (preview store). Only one letter size in the words, and only with a
     * top-size cue or a top-size question just asked - "a large range" is no size.
     */
    else {
      const phrased = topSizeSaid(lettered, lastReply);
      const confirmed = phrased ? undefined : topSizeConfirmed(said, lastReply);
      if (phrased ?? confirmed) set('top', (phrased ?? confirmed)!);
    }
  }
  /*
   * What the patterns above could not read, the model's reading of the same
   * words can (ai/readTurn.ts): "waist thirty two and leg thirty four" is no
   * digits, "talla mediana" no English. Only for what is still unread.
   */
  const read = modelReadingFor(said);
  if (read) {
    if (read.waist && !next.waist && !next.requested?.waist && !waist && !pair) set('waist', read.waist);
    if (read.leg && !next.leg && !next.requested?.leg && !leg && !pair) set('leg', read.leg);
    if (read.size && !/^\d/.test(read.size) && !next.top && !next.requested?.top) set('top', read.size);
  }
  if (accepted?.top && !next.top && !next.requested?.top) set('top', accepted.top);
  if (accepted?.waist && !next.waist && !next.requested?.waist) set('waist', accepted.waist);
  if (!Object.keys(next.requested!).length) delete next.requested;
  return next;
}

/** Words that say a size is for the top half: "top size", "I'm a", "that is also". */
const TOP_CUE = /\b(top|tops|jacket|polo|midlayer|shirt|chest|i'?m|i am|that'?s|that is|it'?s|it is|also|size (?:is|would be|will be|of))\b/i;
/** The Caddie's last question asked for a top size. */
const ASKED_TOP = /\b(top size|what size do you wear|size (?:for|do you wear for) (?:the )?(?:jacket|tops?|polo|midlayer)|jacket, midlayer|for the tops?)\b[^?]*\?/i;

/** The letter sizes in some words - "medium", "M", "extra large", "2XL" - read as sizesNeverGiven reads them. */
function letterSizesIn(words: string): string[] {
  const tokens = foldNonAscii(words.toLowerCase().replace(/['’]/g, '')).replace(/[^a-z0-9\s/-]/g, ' ').split(/\s+/).filter(Boolean);
  const found = new Set<string>();
  for (let i = 0; i < tokens.length; i += 1) {
    const pair = normaliseSize(`${tokens[i]} ${tokens[i + 1] ?? ''}`.trim());
    const one = normaliseSize(tokens[i]!);
    const size = pair && pair !== one ? pair : one;
    if (size && !/^\d+$/.test(size) && !['a', 'i', 'in'].includes(tokens[i]!)) {
      found.add(size.toUpperCase());
      if (pair && pair !== one) i += 1;
    }
  }
  return [...found];
}

/** One top size said in a sentence with a cue that it is the top size, or answering the question for it. */
function topSizeSaid(words: string, lastReply: string): string | undefined {
  const sizes = letterSizesIn(words);
  if (sizes.length !== 1) return undefined;
  return TOP_CUE.test(words) || ASKED_TOP.test(lastReply) ? sizes[0] : undefined;
}

/** A yes to a question naming one top size: "Is medium your top size?" - "Yes it is confirmed". */
function topSizeConfirmed(said: string, lastReply: string): string | undefined {
  if (!/^\s*(yes|yeah|yep|yup|correct|confirmed|that'?s right|right|exactly|it is|sure)\b/i.test(said) || /\b(no|not|isn'?t|wrong)\b/i.test(said)) return undefined;
  const question = lastReply.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.includes('?')).pop() ?? '';
  if (!/\b(size|top|jacket|polo|midlayer|tops)\b/i.test(question)) return undefined;
  const sizes = letterSizesIn(question.replace(/\b(?:waist|leg(?: length)?)\s*\d{2}\b/gi, ' '));
  return sizes.length === 1 ? sizes[0] : undefined;
}

/** Each piece resolved against the confirmed choices - and whether the pack is ready. */
export function packStatus(session: CaddieSession, handle: string, pieces: Product[] = packPieces(session, handle)): PackStatus {
  const choices = session.packChoices?.[handle] ?? {};
  /*
   * The usual size they told us stands for the tops until they say otherwise
   * (Task 28). A size find_my_size recommended does not: it is our advice,
   * and becomes the pack's only when they accept it (readPackChoices).
   */
  const facts = trustedShopperFacts(session);
  const top = choices.top ?? facts.usualSize;
  const waist = choices.waist ?? facts.waist;

  const plans: PiecePlan[] = pieces.map((product, index) => {
    const tapped = session.cardChoices?.[product.id]?.options ?? {};
    const chosen: Record<string, string> = {};
    const missing: PiecePlan['missing'] = [];
    for (const option of product.options.filter((own) => own.values.length > 1)) {
      const kind = kindOf(option);
      const byTap = Object.entries(tapped).find(([name]) => name.toLowerCase() === option.name.toLowerCase())?.[1];
      const wanted = byTap ?? (kind === 'top' ? top : kind === 'waist' ? waist : kind === 'leg' ? choices.leg : kind === 'belt' ? choices.belt : undefined);
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
      // The one variant these choices name - the basket's own resolver, never a first variant.
      const resolution = resolveVariant(product, chosen);
      const variant = resolution.status === 'exact' ? resolution.variant : undefined;
      if (!variant) plan.missing.push({ kind: 'other', option: 'combination', values: [] });
      else {
        plan.variant = variant;
        if (!variant.available) plan.soldOut = true;
      }
    }
    return plan;
  });

  const ready = plans.length > 0 && plans.every((plan) => plan.variant && !plan.soldOut);
  const fromProfile = { ...(!choices.top && top ? { top } : {}), ...(!choices.waist && waist ? { waist } : {}) };
  return {
    ready,
    pieces: plans,
    ...(Object.keys(fromProfile).length ? { fromProfile } : {}),
    choices: { ...choices, ...(top ? { top } : {}), ...(waist ? { waist } : {}) },
    next: ready ? '' : nextQuestion(plans, { ...choices, ...(top ? { top } : {}), ...(waist ? { waist } : {}) }),
  };
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
  if (top && choices.requested?.top) return `The pack doesn't come in ${choices.requested.top} for the tops. Which size would you like: ${list(top.entry.values)}?`;
  /*
   * The top size is known and this piece is not made in it: the men's belt
   * comes in M/L and L/XL only. "What top size do you wear?" to a customer
   * who had said S twice (live replay) - ask about the piece instead.
   */
  if (top && choices.top) return `The ${title(top.plan.product.title)} doesn't come in ${choices.top} - which size would you like: ${list(top.entry.values)}?`;
  // The pack's sizes are chosen on the pack card, never asked for (tools/sizeHandoff.ts).
  if (top) return PACK_SIZES_ON_CARD;
  const waist = firstMissing('waist');
  if (waist) return choices.requested?.waist ? `The trousers don't come in a ${choices.requested.waist} waist. Would you like ${list(waist.entry.values)}?` : PACK_SIZES_ON_CARD;
  const leg = firstMissing('leg');
  if (leg) {
    const known = choices.waist ? `Waist ${choices.waist} is fine, but ` : '';
    return choices.requested?.leg
      ? `${known}the trousers don't come in a ${choices.requested.leg} leg. Would you like ${list(leg.entry.values)}?`
      : PACK_SIZES_ON_CARD;
  }
  const other = plans.flatMap((plan) => plan.missing.map((entry) => ({ plan, entry })))[0];
  if (other) return other.entry.values.length ? `Which ${other.entry.option.toLowerCase()} for the ${title(other.plan.product.title)}: ${list(other.entry.values)}?` : `That combination isn't available for the ${title(other.plan.product.title)} - which would you like instead?`;
  return '';
}

/** The pack's state for the model: what is confirmed, what is not, and the one thing to ask. */
export function packStatusFacts(status: PackStatus): string {
  const profiled = status.fromProfile ?? {};
  const confirmed = [
    status.choices.top && !profiled.top ? `top ${status.choices.top}` : '',
    status.choices.waist && !profiled.waist ? `waist ${status.choices.waist}` : '',
    status.choices.leg ? `leg ${status.choices.leg}` : '',
    status.choices.belt ? `belt ${status.choices.belt}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  // Their usual size stands in for the pack (Task 28) - said as theirs, never as a choice they made for it.
  const usual = [profiled.top ? `top ${profiled.top}` : '', profiled.waist ? `waist ${profiled.waist}` : ''].filter(Boolean).join(', ');
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
    usual ? `From the usual size they told us (do not ask again; they may change it): ${usual}.` : '',
    requested.length ? `Requested but unavailable: ${requested.join('; ')}.` : '',
    open.length ? `Open: ${open.join('; ')}.` : '',
    `Ask only this: "${status.next}"`,
  ]
    .filter(Boolean)
    .join(' ');
}
