import { sizeInRequest } from '../catalog/constraints.js';
import { normaliseSize } from '../recommend/sizeWords.js';
import type { ToolContext } from './types.js';

/**
 * Whether the customer asked for this basket change.
 *
 * "I'm usually M now" - an update to their size - and the model called
 * add_to_cart for the jacket on screen in M. Nothing went in only because M
 * was sold out. A model's tool call is not a customer asking: an add needs
 * their own words ("add it", "I'll take the XL", "put it in my basket"), a
 * yes to an add the Caddie had just offered, the size an add they asked for
 * was waiting on, or the Add button itself.
 *
 * This decides only whether to add. Which product, which size, whether it is
 * in stock - everything add_to_cart already checks - is unchanged.
 */

export type CartAuthorization =
  | { authorized: true; source: 'utterance' | 'confirmation' | 'continuation' | 'ui-add' }
  | { authorized: false; source: 'none' };

/** Asking for the add in their own words. */
const ASKS_TO_ADD =
  /\badd\b(?!\s+(?:up|on|colou?r|layers?|warmth)\b)|\b(put|pop|stick|chuck|throw)\b[^.?!]*\b(in|into)\b|\bi'?ll (take|have|get|buy) (it|this|that|them|one|both|two|the|a|an)\b|\bi (will|would like to|want to|wanna) (take|buy|order|get|have) (it|this|that|them|one|both|two|the)\b|\b(buy|order|purchase) (it|this|that|them|one|both|two|the)\b|\binto (my|the) (basket|cart|bag)\b/i;
/** Swapping something already in the basket for another - an add with `replaces`. */
const ASKS_TO_SWAP = /\b(swap|replace|change|switch|exchange|instead)\b/i;
/** "Don't add it", "no need to add it", "what would you add?". */
const REFUSES = /\b(don'?t|do not|never|no need to|not yet|not now|without)\s+(add|put|buy|order)\b|\bwhat (would|should|could) (you|i) add\b/i;
/** A short yes. */
const YES = /^\s*(yes|yeah|yep|yup|yes please|sure|ok|okay|please|please do|go ahead|go for it|do it|sounds good|perfect|great|lovely|that'?s fine|fine|why not|absolutely|definitely|of course)\b[\s,.!]*(please|thanks|thank you|do it|go ahead)?[\s.!]*$/i;
/** The Caddie's last turn offered to add something. */
const OFFERED_ADD = /\b(add|put|pop)\b[^.?!]*\?|\b(want me to|shall i|should i|would you like me to|like me to|do you want me to) (add|put|pop)\b/i;

/** "M", "medium please", "in XL", "size 10", "34 waist" - a size and nothing else. */
function sizeAnswer(text: string): boolean {
  if (sizeInRequest(text)) return true;
  const rest = text
    .toLowerCase()
    .replace(/[^a-z0-9\s/-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word && !['please', 'in', 'a', 'an', 'the', 'size', 'one', 'thanks', 'thank', 'you', 'that', 'go', 'with', 'for', 'me', 'it'].includes(word))
    .join(' ');
  return !!rest && !!normaliseSize(rest);
}

function customerTurns(ctx: ToolContext): number {
  return ctx.session.messages.filter((message) => message.role === 'user').length;
}

/** Their words ask for something to go in the basket - and do not refuse it. */
export function asksToAdd(said: string): boolean {
  return ASKS_TO_ADD.test(said) && !REFUSES.test(said);
}

export function cartAuthorization(ctx: ToolContext, opts: { replaces?: string } = {}): CartAuthorization {
  // The Add button (or a developer calling the tool directly): no model in between.
  if (ctx.direct) return { authorized: true, source: 'ui-add' };
  const said = (ctx.utterance ?? '').trim();
  if (!said || REFUSES.test(said)) return { authorized: false, source: 'none' };
  if (ASKS_TO_ADD.test(said) || (opts.replaces && ASKS_TO_SWAP.test(said))) return { authorized: true, source: 'utterance' };

  const lastReply = [...ctx.session.messages].reverse().find((message) => message.role === 'assistant')?.text ?? '';
  const offered = OFFERED_ADD.test(lastReply);
  // "Yes" - only to an add the Caddie had just offered. A size, to that offer, is a yes in that size.
  if (offered && (YES.test(said) || sizeAnswer(said))) return { authorized: true, source: 'confirmation' };

  // The size an add they asked for last turn was waiting on.
  const pending = ctx.session.pendingAdd;
  if (pending && pending.turn + 1 === customerTurns(ctx) && sizeAnswer(said)) return { authorized: true, source: 'continuation' };

  return { authorized: false, source: 'none' };
}

/** How many they asked for: more than one only when their own words say so. */
export function quantityAsked(ctx: ToolContext, proposed: number | undefined): number {
  if (!proposed || proposed <= 1 || ctx.direct) return proposed ?? 1;
  const said = (ctx.utterance ?? '').toLowerCase();
  const words: Record<string, number> = { two: 2, both: 2, pair: 2, couple: 2, three: 3, four: 4, five: 5, six: 6 };
  const digits = [...said.matchAll(/\b(\d{1,2})\b(?!\s?(?:waist|cm|in|inch|kg|%))/g)].map((match) => Number(match[1]));
  const named = Object.entries(words).filter(([word]) => new RegExp(`\\b${word}\\b`).test(said)).map(([, n]) => n);
  return [...digits, ...named].includes(proposed) ? proposed : 1;
}

/** Their message count now - kept with a pending add, so only their next message can finish it. */
export function turnNow(ctx: ToolContext): number {
  return customerTurns(ctx);
}
