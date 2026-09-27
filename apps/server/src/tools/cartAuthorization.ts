import { parseColours } from '../catalog/colour.js';
import { sizeInRequest } from '../catalog/constraints.js';
import { identityProducts, resolveCustomerProductIdentity, type CustomerIdentity } from '../catalog/productIdentity.js';
import { singular } from '../catalog/identity.js';
import { chooseDeal, namesADeal } from '../recommend/deals.js';
import { normaliseSize } from '../recommend/sizeWords.js';
import { currentPack, livePending } from '../session/shoppingSession.js';
import type { ToolContext } from './types.js';

/**
 * Whether the customer asked for this basket change.
 *
 * "I'm usually M now" - an update to their size - and the model called
 * add_to_cart for the jacket on screen in M. Nothing went in only because M
 * was sold out. A model's tool call is not a customer asking: an add needs
 * their own words ("add it", "I'll take the XL", "put it in my basket"), a
 * yes to an add the Caddie had just offered, the size an add they asked for
 * was waiting on, or the Add button itself. A change to the basket - a
 * quantity, a removal - needs the same: their words, or a yes to that change.
 *
 * This decides only whether. Which product, which size, whether it is in
 * stock - the Action Gateway (actionGateway.ts) decides the rest.
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
/** ...or to take something out, or change how many. */
const OFFERED_CHANGE = /\b(remove|take [^.?!]{0,40}\bout|change [^.?!]{0,40}\bto|make (it|that|them|the [^.?!]{0,30}) \w+)\b[^.?!]*\?/i;

/** Their words take something out of the basket. */
const ASKS_TO_REMOVE =
  /\b(remove|delete|take (it|them|that|those|this|these|the\b[^.?!]{0,40}) out|take out|get rid of|(don'?t|do not|no longer) want (it|them|that|those|this|the\b)|drop (it|them|that|those|the\b))/i;
/** Their words change how many of something is in the basket. */
const ASKS_FOR_QUANTITY =
  /\b(make (it|that|them|those|this|these|the\b[^.?!]{0,40}) (\d{1,2}|one|two|three|four|five|six)|change (it|that|them|those|this|the\b[^.?!]{0,40}) to (\d{1,2}|one|two|three|four|five|six)|quantity|(\d{1,2}|two|three|four|five|six) of (them|those|these|it)|one more|another one|add another|just one|only one)\b/i;

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

/** "Navy", "the black one please" - a colour and little else, for an add waiting on its colour. */
function colourAnswer(text: string): boolean {
  return parseColours(text).colours.length > 0 && text.trim().split(/\s+/).length <= 5;
}

function customerTurns(ctx: ToolContext): number {
  return ctx.session.messages.filter((message) => message.role === 'user').length;
}

function lastReply(ctx: ToolContext): string {
  return [...ctx.session.messages].reverse().find((message) => message.role === 'assistant')?.text ?? '';
}

/** The sentence of the Caddie's last reply that offered an add ("Shall I add the Elite Polo in navy?"), if one did. */
export function offerSentence(reply: string): string | null {
  const sentences = reply.split(/(?<=[.!?])\s+/);
  return [...sentences].reverse().find((sentence) => OFFERED_ADD.test(sentence)) ?? null;
}

/**
 * What the Caddie's last reply offered to do, read from its own words - so a
 * "yes" answers that and nothing else. "Shall I add the Elite Polo in navy in
 * M?" is an add of that product, in M, once; a "yes" to it is not a pack, a
 * removal, or two of them.
 */
export type OfferedAction =
  | { type: 'add-product'; productIds?: string[]; size?: string; quantity: number }
  | { type: 'add-pack'; handle?: string }
  | { type: 'update-line'; productIds?: string[]; quantity?: number };

export function offeredAction(ctx: ToolContext): OfferedAction | null {
  const reply = lastReply(ctx);
  const sentences = reply.split(/(?<=[.!?])\s+/);
  const change = [...sentences].reverse().find((sentence) => OFFERED_CHANGE.test(sentence));
  const add = offerSentence(reply);
  if (change && (!add || sentences.lastIndexOf(change) > sentences.lastIndexOf(add))) {
    const identity = resolveCustomerProductIdentity(change, 'offer');
    const removal = /\b(remove|take [^.?!]{0,40}\bout)\b/i.test(change);
    const amount = quantityInWords(change, identity);
    return {
      type: 'update-line',
      ...(identityProducts(identity).length ? { productIds: identityProducts(identity).map((product) => product.id) } : {}),
      ...(removal ? { quantity: 0 } : amount?.set !== undefined ? { quantity: amount.set } : {}),
    };
  }
  if (!add) return null;
  const identity = resolveCustomerProductIdentity(add, 'offer');
  /*
   * The pack a yes buys is the one the offer named, else the pack in hand -
   * never one merely still on screen after they left it (Phase 3B).
   */
  const inHand = currentPack(ctx.session);
  const namedInOffer = namesADeal(add) ? chooseDeal(add) : null;
  const handle = namedInOffer && 'deal' in namedInOffer ? namedInOffer.deal.handle : inHand;
  if (/\bpack\b/i.test(add) || namesADeal(add) || (!!inHand && identity.status === 'none')) {
    return { type: 'add-pack', ...(handle ? { handle } : {}) };
  }
  const size = sizeInRequest(add);
  return {
    type: 'add-product',
    ...(identityProducts(identity).length ? { productIds: identityProducts(identity).map((product) => product.id) } : {}),
    ...(size ? { size } : {}),
    quantity: quantityInWords(add, identity)?.set ?? 1,
  };
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

  // "Yes" - only to an add the Caddie had just offered. A size, to that offer, is a yes in that size.
  if (OFFERED_ADD.test(lastReply(ctx)) && (YES.test(said) || sizeAnswer(said))) return { authorized: true, source: 'confirmation' };

  /*
   * The answer an add they asked for last turn was waiting on - for that
   * product. "Actually the Elite Polo in M", after "what size?" for a jacket,
   * names another product: it does not finish the jacket's add, and it is not
   * an add of the polo either until they ask for one.
   */
  // Only one from this mission: after "show me jackets", "M" is not the polo's size (session/shoppingSession.ts).
  const pending = livePending(ctx.session);
  if (
    pending?.type === 'add-product' &&
    pending.turn + 1 === customerTurns(ctx) &&
    (sizeAnswer(said) || (pending.awaiting === 'colour' && colourAnswer(said))) &&
    !namesAnotherProduct(said, pending.productIds)
  ) {
    return { authorized: true, source: 'continuation' };
  }

  return { authorized: false, source: 'none' };
}

/**
 * Whether the customer asked to change what is already in the basket - take
 * something out, or change how many. "What's in my basket?" is not; nor is a
 * model deciding to tidy up.
 */
export function lineChangeAuthorization(ctx: ToolContext): 'customer-utterance' | 'customer-confirmation' | 'ui-cart-change' | null {
  if (ctx.direct) return 'ui-cart-change';
  const said = (ctx.utterance ?? '').trim();
  if (!said) return null;
  if (ASKS_TO_REMOVE.test(said) || ASKS_FOR_QUANTITY.test(said)) return 'customer-utterance';
  if (YES.test(said) && offeredAction(ctx)?.type === 'update-line') return 'customer-confirmation';
  return null;
}

/** Their words take the item out, rather than change how many. */
export function asksToRemove(said: string): boolean {
  return ASKS_TO_REMOVE.test(said);
}

/** Their words name a product, and it is none of these. */
function namesAnotherProduct(said: string, productIds: string[]): boolean {
  const named = identityProducts(resolveCustomerProductIdentity(said));
  return named.length > 0 && !named.some((product) => productIds.includes(product.id));
}

/**
 * Their words with the product's own name taken out. "One Pair Tour Ankle
 * Socks" is one product, not two; "Clima Jacket 3.0" is not three jackets.
 * A quantity is read from how they buy, never from what the thing is called.
 */
function withoutProductName(said: string, identity: CustomerIdentity): string {
  const names = identityProducts(identity).map((product) => product.title.split(/\s+-\s+/)[0]!.toLowerCase());
  const own = new Set(names.flatMap((name) => name.replace(/[’']/g, '').split(/[^a-z0-9.]+/).filter(Boolean).map(singular)));
  return said
    .replace(/[’']/g, '')
    .split(/\s+/)
    .filter((word) => {
      const bare = word.replace(/[^a-z0-9.]/g, '');
      return bare && !own.has(singular(bare)) && !/^\d+\.\d+$/.test(bare);
    })
    .join(' ');
}

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, both: 2, couple: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

/**
 * A quantity in their words, from how they buy: "two pairs of", "make it
 * three", "one more". Never the product's own name ("One Pair", "3.0"), and
 * never a size ("size 10", "34 waist"). The last number said is the one
 * meant: "change the second one to 3" is 3. Null when no quantity is said.
 */
export function quantityInWords(text: string, identity?: CustomerIdentity): { set?: number; more?: number } | null {
  const said = withoutProductName(text.toLowerCase(), identity ?? resolveCustomerProductIdentity(text))
    .replace(/\b(size|uk|waist|leg|chest|inside leg)\s*\d{1,3}\b/g, ' ')
    .replace(/\b\d{1,3}\s*(waist|leg|cm|in|inch|inches|kg|lb|%|")/g, ' ');
  if (/\b(one more|another one|add another|one extra)\b/.test(said)) return { more: 1 };
  const found = [...said.matchAll(/\b(\d{1,2}|one|two|both|couple|three|four|five|six|seven|eight|nine|ten)\b/g)].map((match) => NUMBER_WORDS[match[1]!] ?? Number(match[1]));
  const last = found[found.length - 1];
  return last === undefined || !Number.isFinite(last) ? null : { set: last };
}

/** How many they asked for: more than one only when their own words say so. */
export function quantityAsked(ctx: ToolContext, proposed: number | undefined): number {
  if (!proposed || proposed <= 1 || ctx.direct) return proposed ?? 1;
  const amount = quantityInWords(ctx.utterance ?? '');
  return amount?.set === proposed ? proposed : 1;
}

/** Their message count now - kept with a pending action, so only their next message can finish it. */
export function turnNow(ctx: ToolContext): number {
  return customerTurns(ctx);
}
